const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  GENDERS,
  RACES,
  FORUM_CATEGORIES,
  TERMS_VERSION,
  ValidationError,
  calculateAge,
  requireText,
  optionalText,
  validateEmail,
  validateNickname,
  validatePassword,
  validateChoice,
  validateBirthDate,
  validateAvatar,
  validateArticleId,
} = require('./validation');
const { articlePageHtml, SITE_HEAD } = require('./articlePage');

const CONFLICT_MESSAGE = 'E-mail ou nickname indisponível. Se você já tem conta, faça login.';
const INVALID_LOGIN_MESSAGE = 'E-mail, nickname ou senha incorretos.';
const WRONG_PASSWORD_MESSAGE = 'A senha atual não confere.';
const PUBLIC_AUTHOR = { select: { nickname: true } };
// No fórum, a foto aparece ao lado do apelido. Vai só o endereço dela, nunca a imagem:
// a lista fica leve, e o navegador baixa cada foto uma vez só.
const FORUM_AUTHOR = { select: { id: true, nickname: true, avatarUpdatedAt: true } };
const MAX_LIST_ITEMS = 200;
// Passado disso sem a fonte confirmar, o jogo deixa de aparecer como ao vivo: é melhor sumir do que afirmar errado.
const LIVE_CONFIRMATION_MS = 30 * 60 * 1000;
// Comparar com este hash quando a conta não existe evita revelar, pelo tempo de resposta, quais contas existem.
const DUMMY_HASH = bcrypt.hashSync('conta-inexistente', 10);

function forumAuthor({ id, nickname, avatarUpdatedAt }) {
  return { nickname, avatarUrl: avatarUpdatedAt ? `/api/usuarios/${id}/foto?v=${avatarUpdatedAt.getTime()}` : null };
}

const withForumAuthor = (item) => ({ ...item, author: forumAuthor(item.author) });

function createApp({ prisma, jwtSecret, jwtExpiresIn = '1d', corsOrigins = [], rateLimits = {}, trustProxyHops = 1, matchSync = null }) {
  const limits = { login: 10, register: 30, write: 30, password: 5, ...rateLimits };
  const app = express();

  // Quantos proxies da hospedagem ficam à frente do app. A menos, pessoas diferentes
  // dividem o mesmo limite por IP; a mais, dá para falsificar o IP no cabeçalho.
  app.set('trust proxy', trustProxyHops);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  if (corsOrigins.length > 0) app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '300kb' }));

  // Só a pasta public é servida: o banco, o código do servidor e as configurações ficam fora dela.
  app.use(express.static(path.join(__dirname, 'public')));

  // Link compartilhado de matéria: a página do app, com a prévia daquela matéria.
  // Ao abrir, o próprio app troca o endereço por #/materia/N.
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  if (!SITE_HEAD.test(indexHtml)) throw new Error('O index.html precisa do <title> seguido da descrição: a prévia das matérias troca os dois.');
  const loadArticles = () => import(pathToFileURL(path.join(__dirname, 'public', 'js', 'data.mjs')).href);

  app.get('/materia/:id', async (req, res) => {
    const { articles } = await loadArticles();
    const article = /^\d{1,4}$/.test(req.params.id) ? articles.find((item) => item.id === Number(req.params.id)) : undefined;
    res.set('Cache-Control', 'no-cache');
    if (!article) return res.status(404).type('html').send(indexHtml);
    return res.type('html').send(articlePageHtml(indexHtml, article, `${req.protocol}://${req.get('host')}`));
  });

  // Respostas da API podem trazer dados pessoais e não devem sobrar no cache do aparelho.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const limiter = (limit, windowMs, message, options = {}) => rateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
    ...options,
  });
  const FIFTEEN_MINUTES = 15 * 60 * 1000;
  const TOO_MANY_LOGINS = 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.';
  const loginAccount = (req) => String(req.body?.loginUser ?? '').trim().toLowerCase().slice(0, 254);
  // Conta também os logins corretos: cada tentativa custa um hash de senha ao servidor.
  const loginByIp = limiter(limits.login * 10, FIFTEEN_MINUTES, TOO_MANY_LOGINS);
  // Erros de um endereço não bloqueiam a dona da conta, que costuma entrar de outro.
  const loginByAccountAndIp = limiter(limits.login, FIFTEEN_MINUTES, TOO_MANY_LOGINS, {
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `login:${loginAccount(req)}:${ipKeyGenerator(req.ip)}`,
  });
  // Teto da conta somando todos os endereços, contra ataque distribuído.
  const loginByAccount = limiter(limits.login * 5, FIFTEEN_MINUTES, TOO_MANY_LOGINS, {
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `login:${loginAccount(req)}`,
  });
  const registerLimiter = limiter(limits.register, 60 * 60 * 1000, 'Muitos cadastros em sequência. Tente de novo mais tarde.');
  // Os dois limites a seguir rodam depois do verifyAuth, então contam por conta.
  const writeLimiter = limiter(limits.write, 60 * 1000, 'Muitas ações em sequência. Aguarde um minuto e tente de novo.', {
    keyGenerator: (req) => `escrita:${req.user.id}`,
  });
  const passwordLimiter = limiter(limits.password, FIFTEEN_MINUTES, 'Muitas tentativas com a senha. Aguarde alguns minutos e tente de novo.', {
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `senha:${req.user.id}`,
  });

  // ==========================================
  // AUTENTICAÇÃO E SESSÃO
  // ==========================================
  const signToken = (user) => jwt.sign({ sub: user.id, v: user.tokenVersion }, jwtSecret, { expiresIn: jwtExpiresIn, algorithm: 'HS256' });

  // O papel vem sempre do banco: rebaixar uma conta ou trocar a senha vale na hora.
  async function userFromRequest(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    let payload;
    try {
      payload = jwt.verify(header.slice('Bearer '.length), jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
    if (typeof payload.sub !== 'string') return null;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, nickname: true, tokenVersion: true },
    });
    return user && user.tokenVersion === payload.v ? user : null;
  }

  const verifyAuth = async (req, res, next) => {
    req.user = await userFromRequest(req);
    if (!req.user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
    next();
  };

  const optionalAuth = async (req, res, next) => {
    req.user = await userFromRequest(req);
    next();
  };

  const verifySuperAdmin = (req, res, next) => {
    if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Acesso restrito à SUPER_ADMIN.' });
    next();
  };

  const isAdmin = (user) => ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  function publicUser(user) {
    return {
      id: user.id,
      name: user.name,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
      gender: user.gender,
      race: user.race,
      city: user.city,
      avatarUrl: user.avatarUrl,
      birthDate: user.birthDate,
      age: calculateAge(user.birthDate.toISOString().slice(0, 10)),
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
      createdAt: user.createdAt,
    };
  }

  async function checkPassword(userId, password) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const matches = typeof password === 'string' && await bcrypt.compare(password, user.password);
    return matches ? user : null;
  }

  app.post('/api/auth/register', registerLimiter, async (req, res) => {
    const body = req.body ?? {};
    if (body.acceptTerms !== true) {
      throw new ValidationError('Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.', 'acceptTerms');
    }
    const nickname = validateNickname(body.nickname);
    const data = {
      nickname,
      name: optionalText(body.name, 'name', 'o nome', { max: 80 }) ?? nickname,
      email: validateEmail(body.email),
      birthDate: validateBirthDate(body.birthDate),
      gender: validateChoice(body.gender, GENDERS, 'gender', 'gênero'),
      race: validateChoice(body.race, RACES, 'race', 'raça ou etnia'),
      city: optionalText(body.city, 'city', 'a cidade', { max: 80 }),
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    };
    const password = await bcrypt.hash(validatePassword(body.password), 10);

    const user = await prisma.user.create({ data: { ...data, password } });
    return res.status(201).json({ message: 'Conta criada com sucesso!', user: publicUser(user), token: signToken(user) });
  });

  app.post('/api/auth/login', loginByIp, loginByAccountAndIp, loginByAccount, async (req, res) => {
    const { loginUser, password } = req.body ?? {};
    if (typeof loginUser !== 'string' || typeof password !== 'string' || !loginUser.trim() || !password) {
      throw new ValidationError('Informe o e-mail ou nickname e a senha.', 'loginUser');
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: loginUser.trim().toLowerCase() }, { nickname: loginUser.trim() }] },
    });
    const isValidPassword = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
    if (!user || !isValidPassword) return res.status(401).json({ error: INVALID_LOGIN_MESSAGE });

    return res.json({ message: 'Login realizado com sucesso!', user: publicUser(user), token: signToken(user) });
  });

  app.get('/api/auth/me', verifyAuth, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    return res.json(publicUser(user));
  });

  // Sair invalida o token no servidor: uma cópia dele deixa de valer, inclusive em outro aparelho.
  app.post('/api/auth/logout', verifyAuth, async (req, res) => {
    await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } });
    return res.json({ message: 'Sessão encerrada.' });
  });

  const limitEmailChange = (req, res, next) => ('email' in (req.body ?? {}) ? passwordLimiter(req, res, next) : next());

  app.patch('/api/auth/me', verifyAuth, writeLimiter, limitEmailChange, async (req, res) => {
    const body = req.body ?? {};
    const changes = {};
    if ('name' in body) changes.name = requireText(body.name, 'name', 'o nome', { max: 80 });
    if ('nickname' in body) changes.nickname = validateNickname(body.nickname);
    if ('city' in body) changes.city = optionalText(body.city, 'city', 'a cidade', { max: 80 });
    if ('gender' in body) changes.gender = validateChoice(body.gender, GENDERS, 'gender', 'gênero');
    if ('race' in body) changes.race = validateChoice(body.race, RACES, 'race', 'raça ou etnia');
    if ('avatarUrl' in body) {
      changes.avatarUrl = validateAvatar(body.avatarUrl);
      changes.avatarUpdatedAt = changes.avatarUrl ? new Date() : null;
    }

    if ('email' in body) {
      const email = validateEmail(body.email);
      const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
      if (email !== current.email) {
        if (!await checkPassword(req.user.id, body.currentPassword)) {
          return res.status(403).json({ error: 'Para trocar o e-mail, confirme a senha atual.', field: 'currentPassword' });
        }
        changes.email = email;
      }
    }

    const user = await prisma.user.update({ where: { id: req.user.id }, data: changes });
    return res.json({ message: 'Perfil atualizado!', user: publicUser(user) });
  });

  app.post('/api/auth/senha', verifyAuth, writeLimiter, passwordLimiter, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!await checkPassword(req.user.id, currentPassword)) {
      return res.status(403).json({ error: WRONG_PASSWORD_MESSAGE, field: 'currentPassword' });
    }
    const password = await bcrypt.hash(validatePassword(newPassword, 'newPassword'), 10);
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { password, tokenVersion: { increment: 1 } },
    });
    return res.json({ message: 'Senha alterada!', token: signToken(user) });
  });

  app.delete('/api/auth/me', verifyAuth, writeLimiter, passwordLimiter, async (req, res) => {
    if (!await checkPassword(req.user.id, req.body?.password)) {
      return res.status(403).json({ error: WRONG_PASSWORD_MESSAGE, field: 'password' });
    }
    await prisma.user.delete({ where: { id: req.user.id } });
    return res.json({ message: 'Conta excluída.' });
  });

  // ==========================================
  // JOGOS E ESPORTS
  // ==========================================
  app.get('/api/jogos/proximos', optionalAuth, async (req, res) => {
    const { torneio } = req.query;
    const where = { status: 'UPCOMING', date: { gte: new Date() } };
    if (typeof torneio === 'string' && torneio && torneio !== 'all') where.tournament = { contains: torneio };

    const matches = await prisma.match.findMany({
      where,
      orderBy: { date: 'asc' },
      take: MAX_LIST_ITEMS,
      include: { reminders: req.user ? { where: { userId: req.user.id } } : false },
    });
    return res.json(matches.map(({ reminders, ...match }) => ({ ...match, hasReminder: Boolean(reminders?.length) })));
  });

  app.get('/api/jogos/resultados', async (req, res) => {
    const [live, finished] = await Promise.all([
      prisma.match.findMany({
        where: { status: 'LIVE', syncedAt: { gte: new Date(Date.now() - LIVE_CONFIRMATION_MS) } },
        orderBy: { date: 'desc' },
        take: 15,
      }),
      prisma.match.findMany({ where: { status: 'FINISHED' }, orderBy: { date: 'desc' }, take: 15 }),
    ]);
    return res.json([...live, ...finished]);
  });

  app.get('/api/jogos/atualizacao', (req, res) => res.json(matchSync ? matchSync.status() : { updatedAt: null, games: [] }));

  app.post('/api/jogos/:id/lembrete', verifyAuth, writeLimiter, async (req, res) => {
    const matchId = req.params.id;
    const userId = req.user.id;

    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Partida não encontrada.' });

    const existing = await prisma.matchReminder.findUnique({ where: { userId_matchId: { userId, matchId } } });
    if (existing) {
      await prisma.matchReminder.delete({ where: { id: existing.id } });
      return res.json({ message: 'Lembrete removido.', active: false, matchId });
    }
    await prisma.matchReminder.create({ data: { userId, matchId } });
    return res.status(201).json({ message: 'Lembrete marcado.', active: true, matchId });
  });

  // ==========================================
  // FÓRUM E DISCUSSÕES
  // ==========================================
  app.get('/api/forum/topicos', async (req, res) => {
    const { categoria } = req.query;
    const where = typeof categoria === 'string' && categoria !== 'all' ? { category: categoria } : {};
    const topics = await prisma.forumTopic.findMany({
      where,
      orderBy: [{ isADM: 'desc' }, { createdAt: 'desc' }],
      take: MAX_LIST_ITEMS,
      include: { author: FORUM_AUTHOR, _count: { select: { comments: true } } },
    });
    return res.json(topics.map(withForumAuthor));
  });

  app.get('/api/forum/topicos/:id', async (req, res) => {
    const topic = await prisma.forumTopic.findUnique({
      where: { id: req.params.id },
      include: {
        author: FORUM_AUTHOR,
        comments: { orderBy: { createdAt: 'desc' }, take: MAX_LIST_ITEMS, include: { author: FORUM_AUTHOR } },
      },
    });
    if (!topic) return res.status(404).json({ error: 'Tópico não encontrado.' });
    // As respostas mais recentes, em ordem de leitura.
    topic.comments.reverse();
    return res.json({ ...withForumAuthor(topic), comments: topic.comments.map(withForumAuthor) });
  });

  app.post('/api/forum/topicos', verifyAuth, writeLimiter, async (req, res) => {
    const body = req.body ?? {};
    const title = requireText(body.title, 'title', 'o título', { min: 3, max: 120 });
    const content = requireText(body.content, 'content', 'a mensagem', { max: 5000 });
    const category = validateChoice(body.category, FORUM_CATEGORIES, 'category', 'categoria');
    if (!category) throw new ValidationError('Escolha uma categoria.', 'category');

    const isADM = category === 'Perguntas da ADM';
    if (isADM && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Só a administração pode criar tópicos nesta categoria.' });
    }

    const topic = await prisma.forumTopic.create({
      data: { title, category, content, isADM, authorId: req.user.id },
      include: { author: FORUM_AUTHOR, _count: { select: { comments: true } } },
    });
    return res.status(201).json({ message: 'Tópico publicado!', topic: withForumAuthor(topic) });
  });

  app.post('/api/forum/topicos/:id/comentarios', verifyAuth, writeLimiter, async (req, res) => {
    const content = requireText(req.body?.content, 'content', 'a resposta', { max: 2000 });
    const topic = await prisma.forumTopic.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!topic) return res.status(404).json({ error: 'Tópico não encontrado.' });

    const comment = await prisma.forumComment.create({
      data: { content, topicId: topic.id, authorId: req.user.id },
      include: { author: FORUM_AUTHOR },
    });
    return res.status(201).json({ message: 'Resposta enviada!', comment: withForumAuthor(comment) });
  });

  // ==========================================
  // FOTO DE PERFIL
  // ==========================================
  // A foto sai como imagem. Com a versão atual no endereço, o navegador guarda por uma semana:
  // quando a foto muda, o endereço muda junto.
  app.get('/api/usuarios/:id/foto', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { avatarUrl: true, avatarUpdatedAt: true } });
    const photo = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(user?.avatarUrl ?? '');
    if (!photo) return res.status(404).json({ error: 'Foto não encontrada.' });
    const isCurrent = req.query.v === String(user.avatarUpdatedAt?.getTime());
    res.set('Cache-Control', isCurrent ? 'public, max-age=604800, immutable' : 'no-cache');
    return res.type(photo[1]).send(Buffer.from(photo[2], 'base64'));
  });

  // ==========================================
  // CURTIDAS E COMENTÁRIOS DAS MATÉRIAS
  // ==========================================
  app.get('/api/materias/interacoes', optionalAuth, async (req, res) => {
    const [likes, comments, mine] = await Promise.all([
      prisma.articleLike.groupBy({ by: ['articleId'], _count: { _all: true } }),
      prisma.articleComment.groupBy({ by: ['articleId'], _count: { _all: true } }),
      req.user ? prisma.articleLike.findMany({ where: { userId: req.user.id }, select: { articleId: true } }) : [],
    ]);

    const stats = {};
    const entry = (id) => (stats[id] ??= { likes: 0, comments: 0, liked: false });
    likes.forEach((row) => { entry(row.articleId).likes = row._count._all; });
    comments.forEach((row) => { entry(row.articleId).comments = row._count._all; });
    mine.forEach((row) => { entry(row.articleId).liked = true; });
    return res.json(stats);
  });

  app.post('/api/materias/:id/curtir', verifyAuth, writeLimiter, async (req, res) => {
    const articleId = validateArticleId(req.params.id);
    const key = { articleId_userId: { articleId, userId: req.user.id } };

    const existing = await prisma.articleLike.findUnique({ where: key });
    if (existing) await prisma.articleLike.delete({ where: key });
    else await prisma.articleLike.create({ data: { articleId, userId: req.user.id } });

    const likes = await prisma.articleLike.count({ where: { articleId } });
    return res.json({ liked: !existing, likes });
  });

  app.get('/api/materias/:id/comentarios', async (req, res) => {
    const articleId = validateArticleId(req.params.id);
    const comments = await prisma.articleComment.findMany({
      where: { articleId },
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST_ITEMS,
      include: { author: PUBLIC_AUTHOR },
    });
    return res.json(comments);
  });

  app.post('/api/materias/:id/comentarios', verifyAuth, writeLimiter, async (req, res) => {
    const articleId = validateArticleId(req.params.id);
    const content = requireText(req.body?.content, 'content', 'o comentário', { max: 2000 });
    const comment = await prisma.articleComment.create({
      data: { articleId, content, authorId: req.user.id },
      include: { author: PUBLIC_AUTHOR },
    });
    return res.status(201).json({ message: 'Comentário publicado!', comment });
  });

  // ==========================================
  // ADMINISTRAÇÃO
  // ==========================================
  app.post('/api/admin/promover', verifyAuth, verifySuperAdmin, writeLimiter, async (req, res) => {
    const email = validateEmail(req.body?.email);

    const target = await prisma.user.findUnique({ where: { email } });
    if (!target) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (target.role === 'SUPER_ADMIN') return res.status(400).json({ error: 'Não é possível alterar uma conta SUPER_ADMIN.' });

    const user = await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN' },
      select: { id: true, name: true, nickname: true, email: true, role: true },
    });
    return res.json({ message: `${user.nickname} agora faz parte da administração.`, user });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  // ==========================================
  // TRATAMENTO DE ERROS
  // ==========================================
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, field: err.field });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Corpo da requisição inválido.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Conteúdo grande demais.' });
    if (err.code === 'P2002') return res.status(409).json({ error: CONFLICT_MESSAGE });
    // Só o código do erro vai para o log: a mensagem pode trazer dados de quem usa o app.
    console.error(`Erro em ${req.method} ${req.route?.path ?? req.path}: ${err.code ?? err.name}`);
    return res.status(500).json({ error: 'Erro interno. Tente de novo em instantes.' });
  });

  return app;
}

module.exports = { createApp };
