const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

// Configurações e Variáveis de Ambiente
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ctrl_girl_super_secret_key_2026';
const MASTER_EMAIL = (process.env.MASTER_EMAIL || 'seu-email@exemplo.com').toLowerCase().trim();

app.use(cors());
app.use(express.json());

// ==========================================
// FUNÇÃO DE CÁLCULO DE IDADE (Regra 16+)
// ==========================================
function calculateAge(birthDate) {
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// ==========================================
// MIDDLEWARES DE AUTENTICAÇÃO E SEGURANÇA
// ==========================================
const verifyAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso não autorizado. Token ausente ou malformado.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
};

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradoras podem realizar esta ação.' });
  }
  next();
};

const verifySuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Acesso restrito. Apenas a SUPER_ADMIN possui privilégios para esta ação.' });
  }
  next();
};

// ==========================================
// 1. ROTAS DE AUTENTICAÇÃO (Com Restrição 16+)
// ==========================================

// Registo de Nova Usuária
app.post('/api/auth/register', async (req, res) => {
  console.log("🔍 DADOS RECEBIDOS DO FRONTEND:", req.body); 

  try {
    const { name, nickname, email, password, birthDate, gender, race, city } = req.body;

    if (!email || !nickname || !password || !birthDate) {
      return res.status(400).json({ 
        error: 'Preencha todos os campos obrigatórios: e-mail, nickname, senha e data de nascimento.' 
      });
    }

    // Validação da data de nascimento
    const parsedBirthDate = new Date(birthDate);
    if (isNaN(parsedBirthDate.getTime())) {
      return res.status(400).json({ error: 'Data de nascimento em formato inválido.' });
    }

    // APLICAR RESTRIÇÃO DE IDADE (Mínimo 16 anos)
    const userAge = calculateAge(parsedBirthDate);
    if (userAge < 16) {
      return res.status(400).json({ 
        error: 'Cadastro não permitido. O uso da plataforma CTRL GIRL exige idade mínima de 16 anos.' 
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanNickname = nickname.trim();

    // Verificar se e-mail ou nickname já existem
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { nickname: cleanNickname }]
      }
    });

    if (existingUser) {
      if (existingUser.email === cleanEmail) {
        return res.status(409).json({ error: 'O e-mail informado já está em uso por outra conta.' });
      }
      return res.status(409).json({ error: 'O nickname escolhido já está em uso.' });
    }

    // Regra do E-mail Mestre para SUPER_ADMIN
    const assignedRole = (cleanEmail === MASTER_EMAIL) ? 'SUPER_ADMIN' : 'USER';

    // Criptografia segura com bcrypt
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name: name ? name.trim() : cleanNickname,
        nickname: cleanNickname,
        email: cleanEmail,
        password: hashedPassword,
        birthDate: parsedBirthDate,
        role: assignedRole,
        gender: gender || null,
        race: race || null,
        city: city || null
      }
    });

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role, nickname: newUser.nickname, birthDate: newUser.birthDate },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: assignedRole === 'SUPER_ADMIN' 
        ? 'Conta Mestre criada com sucesso! Cargo: SUPER_ADMIN.' 
        : 'Usuária cadastrada com sucesso!',
      user: {
        id: newUser.id,
        name: newUser.name,
        nickname: newUser.nickname,
        email: newUser.email,
        role: newUser.role,
        age: newUser.age,
        gender: newUser.gender,
        city: newUser.city,
        race: newUser.race
      },
      token
    });
  } catch (error) {
    console.error('Erro no cadastro:', error);
    return res.status(500).json({ error: 'Erro interno ao processar o cadastro.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { loginUser, password } = req.body;

    if (!loginUser || !password) {
      return res.status(400).json({ error: 'Informe o login (e-mail ou nickname) e a senha.' });
    }

    const cleanLogin = loginUser.toLowerCase().trim();

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanLogin },
          { nickname: loginUser.trim() }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Credenciais de acesso inválidas.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciais de acesso inválidas.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, nickname: user.nickname, birthDate: user.birthDate },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'Login realizado com sucesso!',
      user: {
        id: user.id,
        name: user.name,
        nickname: user.nickname,
        email: user.email,
        role: user.role,
        age: user.age,
        gender: user.gender,
        city: user.city,
        race: user.race,
        avatarUrl: user.avatarUrl
      },
      token
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

// Dados da usuária logada (/me)
app.get('/api/auth/me', verifyAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        nickname: true,
        email: true,
        role: true,
        gender: true,
        race: true,
        age: true,
        city: true,
        avatarUrl: true,
        birthDate: true,
        createdAt: true
      }
    });

    if (!user) return res.status(404).json({ error: 'Usuária não encontrada.' });
    return res.json(user);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});


// ==========================================
// 2. ROTAS DE JOGOS E ESPORTS
// ==========================================
app.get('/api/jogos/proximos', optionalAuth, async (req, res) => {
  try {
    const { torneio } = req.query;
    const whereCondition = { status: 'UPCOMING' };

    if (torneio && torneio !== 'all') {
      whereCondition.tournament = { contains: torneio, mode: 'insensitive' };
    }

    const matches = await prisma.match.findMany({
      where: whereCondition,
      orderBy: { date: 'asc' },
      include: {
        reminders: req.user ? { where: { userId: req.user.id } } : false
      }
    });

    const formattedMatches = matches.map(match => {
      const hasReminder = Boolean(match.reminders && match.reminders.length > 0);
      const { reminders, ...matchData } = match;
      return { ...matchData, hasReminder };
    });

    return res.json(formattedMatches);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao listar próximos jogos.' });
  }
});

app.get('/api/jogos/resultados', async (req, res) => {
  try {
    const results = await prisma.match.findMany({
      where: { status: 'FINISHED' },
      orderBy: { date: 'desc' },
      take: 15
    });
    return res.json(results);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao carregar resultados.' });
  }
});

app.post('/api/jogos/:id/lembrete', verifyAuth, async (req, res) => {
  try {
    const matchId = req.params.id;
    const userId = req.user.id;

    const matchExists = await prisma.match.findUnique({ where: { id: matchId } });
    if (!matchExists) return res.status(404).json({ error: 'Partida não encontrada.' });

    const existingReminder = await prisma.matchReminder.findUnique({
      where: { userId_matchId: { userId, matchId } }
    });

    if (existingReminder) {
      await prisma.matchReminder.delete({ where: { id: existingReminder.id } });
      return res.json({ message: 'Lembrete removido.', active: false, matchId });
    } else {
      await prisma.matchReminder.create({ data: { userId, matchId } });
      return res.status(201).json({ message: 'Lembrete ativado!', active: true, matchId });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao processar lembrete.' });
  }
});


// ==========================================
// 3. ROTAS DE FÓRUM E DISCUSSÕES
// ==========================================
app.get('/api/forum/topicos', async (req, res) => {
  try {
    const { categoria } = req.query;
    const whereClause = categoria && categoria !== 'all' ? { category: categoria } : {};

    const topics = await prisma.forumTopic.findMany({
      where: whereClause,
      orderBy: [{ isADM: 'desc' }, { createdAt: 'desc' }],
      include: {
        author: { select: { nickname: true, role: true, avatarUrl: true } },
        _count: { select: { comments: true } }
      }
    });

    return res.json(topics);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao carregar tópicos do fórum.' });
  }
});

app.post('/api/forum/topicos', verifyAuth, async (req, res) => {
  try {
    const { title, category, content } = req.body;
    if (!title || !category || !content) {
      return res.status(400).json({ error: 'Preencha todos os campos do tópico.' });
    }

    const isADMTopic = category === 'Perguntas da ADM';
    if (isADMTopic && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas administradoras podem criar tópicos nesta categoria.' });
    }

    const topic = await prisma.forumTopic.create({
      data: {
        title,
        category,
        content,
        isADM: isADMTopic,
        authorId: req.user.id
      },
      include: { author: { select: { nickname: true, role: true } } }
    });

    return res.status(201).json({ message: 'Tópico publicado com sucesso!', topic });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao publicar tópico.' });
  }
});

app.post('/api/forum/topicos/:id/comentarios', verifyAuth, async (req, res) => {
  try {
    const topicId = req.params.id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'O comentário não pode estar vazio.' });
    }

    const comment = await prisma.forumComment.create({
      data: { content, topicId, authorId: req.user.id },
      include: { author: { select: { nickname: true, role: true, avatarUrl: true } } }
    });

    return res.status(201).json({ message: 'Resposta enviada!', comment });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao enviar resposta.' });
  }
});


// ==========================================
// 4. ROTAS DE ADMINISTRAÇÃO
// ==========================================
app.post('/api/admin/promover', verifyAuth, verifySuperAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Informe o e-mail da usuária.' });

    const targetUser = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!targetUser) return res.status(404).json({ error: 'Usuária não encontrada.' });

    if (targetUser.role === 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'Não é possível alterar uma conta SUPER_ADMIN.' });
    }

    const updatedUser = await prisma.user.update({
      where: { email: targetUser.email },
      data: { role: 'ADMIN' },
      select: { id: true, name: true, nickname: true, email: true, role: true }
    });

    return res.json({ message: `Usuária ${updatedUser.nickname} promovida a ADMIN!`, user: updatedUser });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao processar promoção.' });
  }
});


// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor CTRL GIRL unificado a rodar na porta ${PORT}`);
  console.log(`📧 E-mail Mestre configurado: ${MASTER_EMAIL}`);
});