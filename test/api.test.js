const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DB_FILE = path.join(TMP, `api-${process.pid}.db`);
const JWT_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
const PASSWORD = 'senha-de-teste-123';

fs.mkdirSync(TMP, { recursive: true });
process.env.DATABASE_URL = `file:${DB_FILE.replaceAll('\\', '/')}`;
process.env.MASTER_EMAIL = 'mestre-antigo@example.com';

execSync('npx prisma migrate deploy', { cwd: ROOT, stdio: 'pipe', env: process.env });

const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../app');

const prisma = new PrismaClient();
const servers = [];
let baseUrl;
let counter = 0;

function listen(options = {}) {
  const app = createApp({ prisma, jwtSecret: JWT_SECRET, ...options });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function call(method, url, { body, token, base = baseUrl, raw, headers = {} } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text, headers: response.headers };
}

function newUserData(overrides = {}) {
  counter += 1;
  return {
    name: `Pessoa Teste ${counter}`,
    nickname: `pessoa_${counter}`,
    email: `pessoa${counter}@example.com`,
    password: PASSWORD,
    birthDate: '2000-05-20',
    acceptTerms: true,
    ...overrides,
  };
}

async function register(overrides = {}) {
  const data = newUserData(overrides);
  const response = await call('POST', '/api/auth/register', { body: data });
  assert.equal(response.status, 201, `cadastro falhou: ${response.text}`);
  return { ...response.body, data };
}

before(async () => {
  baseUrl = await listen({ rateLimits: { login: 1000, register: 1000, write: 1000 } });
});

after(async () => {
  servers.forEach((server) => server.close());
  await prisma.$disconnect();
  for (const suffix of ['', '-journal']) fs.rmSync(DB_FILE + suffix, { force: true });
});

describe('arquivos públicos (C2)', () => {
  for (const file of ['/prisma/dev.db', '/prisma/schema.prisma', '/server.js', '/app.js', '/package.json', '/.env']) {
    test(`não publica ${file}`, async () => {
      assert.equal((await call('GET', file)).status, 404);
    });
  }

  test('entrega a interface com CSP que proíbe script inline', async () => {
    const response = await call('GET', '/');
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
  });
});

describe('configuração do servidor (C1)', () => {
  test('não sobe sem JWT_SECRET', () => {
    // Vazio, e não ausente: o cliente do Prisma carregaria o .env local, se ele existir, por cima de uma variável ausente.
    const env = { ...process.env, PORT: '0', JWT_SECRET: '' };
    const result = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { env, cwd: TMP, timeout: 8000, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JWT_SECRET/);
  });

  test('não sobe com JWT_SECRET curto', () => {
    const env = { ...process.env, PORT: '0', JWT_SECRET: 'curto' };
    const result = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], { env, cwd: TMP, timeout: 8000, encoding: 'utf8' });
    assert.equal(result.status, 1);
  });

  test('sobe de verdade e responde, com a atualização automática desligada', async () => {
    const free = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const env = { ...process.env, PORT: String(free), JWT_SECRET, RESULTS_SYNC_MINUTES: '0' };
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const limit = setTimeout(() => reject(new Error('o servidor não subiu a tempo')), 20000);
        child.stdout.on('data', (data) => {
          if (String(data).includes(`porta ${free}`)) {
            clearTimeout(limit);
            resolve();
          }
        });
        child.once('exit', (code) => {
          clearTimeout(limit);
          reject(new Error(`o servidor saiu com código ${code}`));
        });
      });
      const response = await call('GET', '/api/jogos/atualizacao', { base: `http://127.0.0.1:${free}` });
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.body, { updatedAt: null, games: [] });
    } finally {
      child.removeAllListeners('exit');
      child.kill();
    }
  });

  test('com a porta ocupada, avisa e sai com erro, sem fingir que subiu', async () => {
    // Sem endereço, como o servidor: ocupar só 127.0.0.1 não impediria o outro processo de escutar.
    const blocker = net.createServer();
    await new Promise((resolve) => { blocker.listen(0, resolve); });
    const busy = String(blocker.address().port);
    const env = { ...process.env, PORT: busy, JWT_SECRET, RESULTS_SYNC_MINUTES: '0' };
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      const code = await new Promise((resolve, reject) => {
        const limit = setTimeout(() => reject(new Error(`o servidor não saiu a tempo: ${stdout}`)), 20000);
        child.once('exit', (exitCode) => {
          clearTimeout(limit);
          resolve(exitCode);
        });
      });
      assert.equal(code, 1, stdout);
      assert.doesNotMatch(stdout, /rodando na porta/);
      assert.match(stderr, new RegExp(busy));
    } finally {
      child.kill();
      blocker.close();
    }
  });

  test('recusa token assinado com outro segredo', async () => {
    const { user } = await register();
    const forged = jwt.sign({ sub: user.id, id: user.id, role: 'SUPER_ADMIN' }, 'outro-segredo');
    assert.equal((await call('GET', '/api/auth/me', { token: forged })).status, 401);
  });
});

describe('cadastro (C4, A1, A6, A7, M9, PV1)', () => {
  test('o e-mail mestre antigo não dá papel de administrador', async () => {
    const { user } = await register({ email: process.env.MASTER_EMAIL });
    assert.equal(user.role, 'USER');
  });

  test('não grava a senha em log', async () => {
    const original = { log: console.log, error: console.error, info: console.info };
    const lines = [];
    for (const method of Object.keys(original)) console[method] = (...args) => lines.push(args.map(String).join(' '));
    try {
      await register({ password: 'senha-que-nao-pode-vazar' });
    } finally {
      Object.assign(console, original);
    }
    assert.equal(lines.filter((line) => line.includes('senha-que-nao-pode-vazar')).length, 0);
    assert.equal(lines.filter((line) => line.includes('DADOS RECEBIDOS')).length, 0);
  });

  const invalid = {
    'e-mail não textual': { email: 123 },
    'e-mail sem formato': { email: 'sem-arroba' },
    'e-mail só com espaços': { email: '    ' },
    'nickname não textual': { nickname: 42 },
    'nickname só com espaços': { nickname: '    ' },
    'nickname com caractere inválido': { nickname: 'nick com espaço' },
    'senha não textual': { password: 12345678 },
    'senha curta': { password: 'curta12' },
    'senha muito comum': { password: '12345678' },
    'senha muito comum em maiúsculas': { password: 'SENHA123' },
    'senha acima de 72 bytes': { password: 'ç'.repeat(40) },
    'data inválida': { birthDate: 'ontem' },
    'data futura': { birthDate: '2999-01-01' },
    'menor de 16 anos': { birthDate: new Date(Date.now() - 10 * 365 * 864e5).toISOString().slice(0, 10) },
    'gênero fora da lista': { gender: 'Outro valor' },
    'raça fora da lista': { race: 'Outro valor' },
    'cidade longa demais': { city: 'x'.repeat(200) },
    'sem aceite dos termos': { acceptTerms: false },
  };
  for (const [name, overrides] of Object.entries(invalid)) {
    test(`responde 400 para ${name}`, async () => {
      const response = await call('POST', '/api/auth/register', { body: newUserData(overrides) });
      assert.equal(response.status, 400, response.text);
      assert.equal(typeof response.body.error, 'string');
    });
  }

  test('gênero e raça são opcionais', async () => {
    const { user } = await register();
    assert.equal(user.gender, null);
    assert.equal(user.race, null);
  });

  test('aceita "Prefiro não informar" em gênero e raça', async () => {
    const { user } = await register({ gender: 'Prefiro não informar', race: 'Prefiro não informar' });
    assert.equal(user.race, 'Prefiro não informar');
  });

  test('registra data e versão do aceite dos termos', async () => {
    const { token } = await register();
    const me = await call('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200, me.text);
    assert.ok(me.body.termsAcceptedAt);
    assert.ok(me.body.termsVersion);
  });

  test('e-mail ou nickname repetido recebem a mesma resposta', async () => {
    const { data } = await register();
    const byEmail = await call('POST', '/api/auth/register', { body: newUserData({ email: data.email }) });
    const byNick = await call('POST', '/api/auth/register', { body: newUserData({ nickname: data.nickname }) });
    assert.equal(byEmail.status, 409);
    assert.equal(byNick.status, 409);
    assert.equal(byEmail.body.error, byNick.body.error);
  });

  test('dois cadastros simultâneos iguais não geram erro 500', async () => {
    const data = newUserData();
    const results = await Promise.all([1, 2].map(() => call('POST', '/api/auth/register', { body: data })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });
});

describe('login e sessão (A7, M3)', () => {
  test('entra por e-mail e por nickname', async () => {
    const { data } = await register();
    for (const loginUser of [data.email, data.nickname]) {
      const response = await call('POST', '/api/auth/login', { body: { loginUser, password: PASSWORD } });
      assert.equal(response.status, 200, response.text);
      assert.ok(response.body.token);
    }
  });

  test('senha errada e conta inexistente recebem a mesma resposta', async () => {
    const { data } = await register();
    const wrong = await call('POST', '/api/auth/login', { body: { loginUser: data.email, password: 'senha-errada-999' } });
    const missing = await call('POST', '/api/auth/login', { body: { loginUser: 'ninguem@example.com', password: 'senha-errada-999' } });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body.error, missing.body.error);
  });

  test('login com tipo errado responde 400', async () => {
    const response = await call('POST', '/api/auth/login', { body: { loginUser: 123, password: true } });
    assert.equal(response.status, 400);
  });

  test('limita tentativas de login', async () => {
    const base = await listen({ rateLimits: { login: 3, register: 1000, write: 1000 } });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await call('POST', '/api/auth/login', { base, body: { loginUser: 'alvo@example.com', password: 'senha-errada-999' } });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });

  test('erros vindos de outro endereço não bloqueiam a conta na hora', async () => {
    const base = await listen({ rateLimits: { login: 2, register: 1000, write: 1000 } });
    const { data } = await register();
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 3; i += 1) {
      await call('POST', '/api/auth/login', { base, headers: from('203.0.113.10'), body: { loginUser: data.email, password: 'senha-errada-999' } });
    }
    const owner = await call('POST', '/api/auth/login', { base, headers: from('203.0.113.20'), body: { loginUser: data.email, password: PASSWORD } });
    assert.equal(owner.status, 200, owner.text);
  });

  test('ainda limita a conta somando todos os endereços', async () => {
    const base = await listen({ rateLimits: { login: 2, register: 1000, write: 1000 } });
    const { data } = await register();
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await call('POST', '/api/auth/login', { base, headers: { 'X-Forwarded-For': `203.0.113.${i + 30}` }, body: { loginUser: data.email, password: 'senha-errada-999' } });
      statuses.push(response.status);
    }
    assert.equal(statuses.at(-1), 429);
  });

  test('logins corretos em sequência também contam no limite por endereço', async () => {
    const base = await listen({ rateLimits: { login: 1, register: 1000, write: 1000 } });
    const { data } = await register();
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await call('POST', '/api/auth/login', { base, body: { loginUser: data.email, password: PASSWORD } })).status);
    }
    assert.equal(statuses[0], 200);
    assert.equal(statuses.at(-1), 429);
  });

  test('sair invalida o token no servidor', async () => {
    const { token } = await register();
    assert.equal((await call('POST', '/api/auth/logout', { token })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
  });

  test('limita por conta as tentativas com a senha atual', async () => {
    const base = await listen({ rateLimits: { login: 1000, register: 1000, write: 1000, password: 2 } });
    const { token } = await register();
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await call('POST', '/api/auth/senha', { base, token, body: { currentPassword: 'errada-12345', newPassword: 'senha-nova-456789' } });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [403, 403, 429]);
    const del = await call('DELETE', '/api/auth/me', { base, token, body: { password: 'errada-12345' } });
    assert.equal(del.status, 429);
  });

  test('limita por conta as tentativas de trocar o e-mail', async () => {
    const base = await listen({ rateLimits: { login: 1000, register: 1000, write: 1000, password: 2 } });
    const { token } = await register();
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await call('PATCH', '/api/auth/me', { base, token, body: { email: `outro${i}@example.com`, currentPassword: 'errada-12345' } });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [403, 403, 429]);
    assert.equal((await call('PATCH', '/api/auth/me', { base, token, body: { city: 'Natal, RN' } })).status, 200);
  });

  test('o limite de escrita é por conta, não por endereço', async () => {
    const base = await listen({ rateLimits: { login: 1000, register: 1000, write: 1 } });
    const first = await register();
    const second = await register();
    const like = (token) => call('POST', '/api/materias/7/curtir', { base, token });
    assert.equal((await like(first.token)).status, 200);
    assert.equal((await like(first.token)).status, 429);
    assert.equal((await like(second.token)).status, 200);
  });

  test('respostas da API não ficam em cache', async () => {
    const { token } = await register();
    const me = await call('GET', '/api/auth/me', { token });
    assert.equal(me.headers.get('cache-control'), 'no-store');
  });

  test('limita cadastros em sequência', async () => {
    const base = await listen({ rateLimits: { login: 1000, register: 1, write: 1000 } });
    const first = await call('POST', '/api/auth/register', { base, body: newUserData() });
    const second = await call('POST', '/api/auth/register', { base, body: newUserData() });
    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
  });

  test('o token leva só identificador, versão e validade', async () => {
    const { token } = await register();
    assert.deepEqual(Object.keys(jwt.decode(token)).sort(), ['exp', 'iat', 'sub', 'v']);
  });

  test('o papel vem do banco, não do token', async () => {
    const { user } = await register();
    const forged = jwt.sign({ sub: user.id, v: 0, role: 'SUPER_ADMIN', id: user.id }, JWT_SECRET);
    const response = await call('POST', '/api/admin/promover', { token: forged, body: { email: 'x@example.com' } });
    assert.equal(response.status, 403);
  });

  test('rebaixar a conta vale na hora', async () => {
    const { user, token } = await register();
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    const body = { title: 'Aviso da equipe', category: 'Perguntas da ADM', content: 'Conteúdo do aviso' };
    assert.equal((await call('POST', '/api/forum/topicos', { token, body })).status, 201);
    await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });
    assert.equal((await call('POST', '/api/forum/topicos', { token, body })).status, 403);
  });
});

describe('perfil (US13, PV2)', () => {
  test('edita nome, cidade, gênero e raça', async () => {
    const { token } = await register({ gender: 'Mulher Cis', race: 'Parda' });
    const changes = { name: 'Nome Social Novo', city: 'Recife, PE', gender: 'Pessoa Não-Binária', race: null };
    const response = await call('PATCH', '/api/auth/me', { token, body: changes });
    assert.equal(response.status, 200, response.text);
    const me = await call('GET', '/api/auth/me', { token });
    assert.equal(me.body.name, 'Nome Social Novo');
    assert.equal(me.body.city, 'Recife, PE');
    assert.equal(me.body.gender, 'Pessoa Não-Binária');
    assert.equal(me.body.race, null);
  });

  test('edita o nickname e recusa um já usado', async () => {
    const other = await register();
    const { token } = await register();
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { nickname: `novo_${counter}` } })).status, 200);
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { nickname: other.data.nickname } })).status, 409);
  });

  test('trocar o e-mail exige a senha atual', async () => {
    const { token } = await register();
    counter += 1;
    const email = `troca${counter}@example.com`;
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { email } })).status, 403);
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { email, currentPassword: 'errada-12345' } })).status, 403);
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { email, currentPassword: PASSWORD } })).status, 200);
  });

  test('guarda foto válida e recusa o que não é imagem', async () => {
    const { token } = await register();
    const avatarUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    assert.equal((await call('PATCH', '/api/auth/me', { token, body: { avatarUrl } })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token })).body.avatarUrl, avatarUrl);
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 123]) {
      assert.equal((await call('PATCH', '/api/auth/me', { token, body: { avatarUrl: bad } })).status, 400, String(bad));
    }
  });

  test('a edição ignora campos que não são editáveis', async () => {
    const { token, user } = await register();
    await call('PATCH', '/api/auth/me', { token, body: { role: 'SUPER_ADMIN', name: 'Nome Novo' } });
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(stored.role, 'USER');
  });

  test('trocar a senha exige a atual e derruba os tokens antigos', async () => {
    const { token, data } = await register();
    const newPassword = 'senha-nova-456789';
    assert.equal((await call('POST', '/api/auth/senha', { token, body: { currentPassword: 'errada-12345', newPassword } })).status, 403);
    assert.equal((await call('POST', '/api/auth/senha', { token, body: { currentPassword: PASSWORD, newPassword: 'curta' } })).status, 400);
    const changed = await call('POST', '/api/auth/senha', { token, body: { currentPassword: PASSWORD, newPassword } });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
    assert.equal((await call('GET', '/api/auth/me', { token: changed.body.token })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { body: { loginUser: data.email, password: newPassword } })).status, 200);
  });

  test('excluir a conta exige a senha e apaga dados e publicações', async () => {
    const { token, data, user } = await register();
    const topic = await call('POST', '/api/forum/topicos', { token, body: { title: 'Tópico que some', category: 'Comunidade', content: 'Texto' } });
    assert.equal((await call('DELETE', '/api/auth/me', { token, body: { password: 'errada-12345' } })).status, 403);
    assert.equal((await call('DELETE', '/api/auth/me', { token, body: { password: PASSWORD } })).status, 200);
    assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
    assert.equal((await call('GET', `/api/forum/topicos/${topic.body.topic.id}`)).status, 404);
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { body: { loginUser: data.email, password: PASSWORD } })).status, 401);
  });
});

describe('fórum (A2, M9)', () => {
  test('cria, lista, abre e responde um tópico', async () => {
    const { token } = await register();
    const created = await call('POST', '/api/forum/topicos', { token, body: { title: 'Tópico de teste', category: 'Campeonatos', content: 'Texto do tópico' } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.topic.id;
    const list = await call('GET', '/api/forum/topicos');
    assert.equal(list.status, 200);
    assert.ok(list.body.some((topic) => topic.id === id));
    const comment = await call('POST', `/api/forum/topicos/${id}/comentarios`, { token, body: { content: 'Minha resposta' } });
    assert.equal(comment.status, 201, comment.text);
    const detail = await call('GET', `/api/forum/topicos/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.comments[0].content, 'Minha resposta');
    assert.equal(typeof detail.body.comments[0].author.nickname, 'string');
  });

  test('filtra por categoria', async () => {
    const { token } = await register();
    await call('POST', '/api/forum/topicos', { token, body: { title: 'Só dicas', category: 'Dicas & Gameplay', content: 'Texto' } });
    const list = await call('GET', `/api/forum/topicos?categoria=${encodeURIComponent('Dicas & Gameplay')}`);
    assert.ok(list.body.length > 0);
    assert.ok(list.body.every((topic) => topic.category === 'Dicas & Gameplay'));
  });

  test('a lista de tópicos não expõe e-mail nem dados pessoais do autor', async () => {
    const { token, data } = await register();
    await call('POST', '/api/forum/topicos', { token, body: { title: 'Privacidade', category: 'Comunidade', content: 'Texto' } });
    const list = await call('GET', '/api/forum/topicos');
    assert.equal(list.text.includes(data.email), false);
    assert.equal(list.text.includes('birthDate'), false);
  });

  test('tópicos e respostas trazem o endereço da foto, sem a imagem nem o papel do autor', async () => {
    const { token } = await register();
    await call('PATCH', '/api/auth/me', { token, body: { avatarUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' } });
    const created = await call('POST', '/api/forum/topicos', { token, body: { title: 'Com foto', category: 'Comunidade', content: 'Texto' } });
    const id = created.body.topic.id;
    const comment = await call('POST', `/api/forum/topicos/${id}/comentarios`, { token, body: { content: 'Resposta' } });
    await call('POST', '/api/materias/9/comentarios', { token, body: { content: 'Comentário' } });
    const [list, detail, articleComments] = await Promise.all([
      call('GET', '/api/forum/topicos'),
      call('GET', `/api/forum/topicos/${id}`),
      call('GET', '/api/materias/9/comentarios'),
    ]);
    for (const response of [created, comment, list, detail, articleComments]) {
      assert.equal(response.text.includes('data:image'), false);
      assert.equal(response.text.includes('avatarUpdatedAt'), false);
      assert.equal(response.text.includes('"role"'), false);
    }
    const photo = created.body.topic.author.avatarUrl;
    assert.match(photo, /^\/api\/usuarios\/[\w-]+\/foto\?v=\d+$/);
    assert.equal(comment.body.comment.author.avatarUrl, photo);
    assert.equal(list.body.find((topic) => topic.id === id).author.avatarUrl, photo);
    assert.equal(detail.body.author.avatarUrl, photo);
    assert.equal(detail.body.comments[0].author.avatarUrl, photo);
    assert.equal(articleComments.text.includes('avatarUrl'), false);
  });

  test('sem foto, o autor vem sem endereço de foto', async () => {
    const { token } = await register();
    const created = await call('POST', '/api/forum/topicos', { token, body: { title: 'Sem foto', category: 'Comunidade', content: 'Texto' } });
    assert.equal(created.body.topic.author.avatarUrl, null);
  });

  test('a foto sai como imagem, e o endereço muda quando ela muda', async () => {
    const { token, user } = await register();
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQ==', 'base64');
    await call('PATCH', '/api/auth/me', { token, body: { avatarUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
    const created = await call('POST', '/api/forum/topicos', { token, body: { title: 'Foto nova', category: 'Comunidade', content: 'Texto' } });
    const topicUrl = `/api/forum/topicos/${created.body.topic.id}`;
    const first = created.body.topic.author.avatarUrl;

    const image = await fetch(baseUrl + first);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.match(image.headers.get('cache-control'), /max-age=[1-9]/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    // Sem a versão atual no endereço, o navegador não guarda: a foto pode ter mudado.
    assert.equal((await fetch(`${baseUrl}/api/usuarios/${user.id}/foto?v=1`)).headers.get('cache-control'), 'no-cache');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await call('PATCH', '/api/auth/me', { token, body: { avatarUrl: 'data:image/png;base64,iVBORw0KGgo=' } });
    const second = (await call('GET', topicUrl)).body.author.avatarUrl;
    assert.notEqual(second, first);
    assert.equal((await fetch(baseUrl + second)).headers.get('content-type'), 'image/png');

    await call('PATCH', '/api/auth/me', { token, body: { avatarUrl: null } });
    assert.equal((await call('GET', topicUrl)).body.author.avatarUrl, null);
    assert.equal((await fetch(`${baseUrl}/api/usuarios/${user.id}/foto`)).status, 404);
  });

  test('limita o tamanho das listas', async () => {
    const { token, user } = await register();
    const topic = await prisma.forumTopic.create({ data: { title: 'Muitas respostas', category: 'Comunidade', content: 'Texto', authorId: user.id } });
    await prisma.forumComment.createMany({ data: Array.from({ length: 210 }, (_, i) => ({ content: `R${i}`, topicId: topic.id, authorId: user.id })) });
    await prisma.articleComment.createMany({ data: Array.from({ length: 210 }, (_, i) => ({ articleId: 8, content: `C${i}`, authorId: user.id })) });
    assert.equal((await call('GET', `/api/forum/topicos/${topic.id}`, { token })).body.comments.length, 200);
    assert.equal((await call('GET', '/api/materias/8/comentarios')).body.length, 200);
  });

  test('visitante não publica', async () => {
    const response = await call('POST', '/api/forum/topicos', { body: { title: 'Sem login', category: 'Comunidade', content: 'Texto' } });
    assert.equal(response.status, 401);
  });

  const badTopics = {
    'título vazio': { title: '   ', category: 'Comunidade', content: 'Texto' },
    'categoria desconhecida': { title: 'Título', category: 'Qualquer', content: 'Texto' },
    'texto não textual': { title: 'Título', category: 'Comunidade', content: 99 },
    'texto longo demais': { title: 'Título', category: 'Comunidade', content: 'x'.repeat(5001) },
  };
  for (const [name, body] of Object.entries(badTopics)) {
    test(`recusa tópico com ${name}`, async () => {
      const { token } = await register();
      assert.equal((await call('POST', '/api/forum/topicos', { token, body })).status, 400);
    });
  }

  test('responder tópico inexistente dá 404', async () => {
    const { token } = await register();
    const response = await call('POST', '/api/forum/topicos/nao-existe/comentarios', { token, body: { content: 'Oi' } });
    assert.equal(response.status, 404);
  });
});

describe('link de matéria compartilhado', () => {
  const APP_SCRIPT = '<script type="module" src="/js/app.mjs"></script>';
  const metaContent = (page, property) => (page.match(new RegExp(`<meta property="${property}" content="([^"]*)" />`)) ?? [])[1];

  test('a prévia mostra título, resumo e imagem da matéria', async () => {
    const { articles } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'data.mjs')).href);
    const article = articles.find((item) => item.id === 1);
    const page = await call('GET', '/materia/1');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(metaContent(page.text, 'og:title'), article.title.trim());
    assert.equal(metaContent(page.text, 'og:description'), article.summary);
    assert.equal(metaContent(page.text, 'og:image'), article.image);
    assert.equal(metaContent(page.text, 'og:url'), `${baseUrl}/materia/1`);
    assert.ok(page.text.includes(`<title>${article.title.trim()} | CTRL GIRL</title>`));
    assert.ok(page.text.includes(APP_SCRIPT), 'a página continua sendo o app');
  });

  test('matéria que não existe abre o app, sem prévia', async () => {
    for (const id of ['999', 'abc', '12345']) {
      const page = await call('GET', `/materia/${id}`);
      assert.equal(page.status, 404, id);
      assert.ok(page.text.includes(APP_SCRIPT), id);
      assert.equal(metaContent(page.text, 'og:title'), undefined, id);
    }
  });

  test('o texto da matéria entra escapado, e imagem local ganha o endereço do site', () => {
    const { articlePageHtml } = require('../articlePage');
    const template = '<head>\n  <title>CTRL GIRL - eSports Inclusivo</title>\n  <meta name="description" content="Portal" />\n</head>';
    const page = articlePageHtml(template, { id: 7, title: ' A & "B" <c> $& ', summary: "D'água", image: '/img/x.png' }, 'https://app.example');
    assert.ok(page.includes('<title>A &amp; &quot;B&quot; &lt;c&gt; $&amp; | CTRL GIRL</title>'), page);
    assert.equal(metaContent(page, 'og:description'), 'D&#39;água');
    assert.equal(metaContent(page, 'og:image'), 'https://app.example/img/x.png');
    assert.equal(metaContent(page, 'og:url'), 'https://app.example/materia/7');
    assert.equal(page.includes('Portal'), false);
  });
});

describe('jogos (A2, US14)', () => {
  let future;
  let past;

  before(async () => {
    future = await prisma.match.create({ data: { tournament: 'CBLOL 2099', date: new Date('2099-01-01T20:00:00Z'), teamA: 'A', teamB: 'B', status: 'UPCOMING' } });
    past = await prisma.match.create({ data: { tournament: 'CBLOL 2001', date: new Date('2001-01-01T20:00:00Z'), teamA: 'C', teamB: 'D', status: 'UPCOMING' } });
    await prisma.match.create({ data: { tournament: 'VCT', date: new Date('2020-01-01T20:00:00Z'), teamA: 'E', teamB: 'F', scoreA: 2, scoreB: 1, status: 'FINISHED' } });
  });

  test('próximos jogos não trazem partidas que já passaram', async () => {
    const response = await call('GET', '/api/jogos/proximos');
    assert.equal(response.status, 200, response.text);
    const ids = response.body.map((match) => match.id);
    assert.ok(ids.includes(future.id));
    assert.equal(ids.includes(past.id), false);
  });

  test('filtra por torneio sem diferenciar maiúsculas', async () => {
    const response = await call('GET', '/api/jogos/proximos?torneio=cblol');
    assert.equal(response.status, 200, response.text);
    assert.ok(response.body.every((match) => match.tournament.includes('CBLOL')));
  });

  test('resultados trazem só partidas encerradas', async () => {
    const response = await call('GET', '/api/jogos/resultados');
    assert.equal(response.status, 200, response.text);
    assert.ok(response.body.length > 0);
    assert.ok(response.body.every((match) => match.status === 'FINISHED'));
  });

  test('marca e desmarca lembrete', async () => {
    const { token } = await register();
    const on = await call('POST', `/api/jogos/${future.id}/lembrete`, { token });
    assert.equal(on.status, 201, on.text);
    assert.equal(on.body.active, true);
    const list = await call('GET', '/api/jogos/proximos', { token });
    assert.equal(list.body.find((match) => match.id === future.id).hasReminder, true);
    const off = await call('POST', `/api/jogos/${future.id}/lembrete`, { token });
    assert.equal(off.body.active, false);
  });

  test('lembrete de jogo inexistente dá 404', async () => {
    const { token } = await register();
    assert.equal((await call('POST', '/api/jogos/nao-existe/lembrete', { token })).status, 404);
  });

  test('jogo ao vivo vem antes dos resultados, com o placar', async () => {
    const live = await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date('2019-01-01T20:00:00Z'), teamA: 'G', teamB: 'H', scoreA: 1, scoreB: 0, status: 'LIVE', externalId: 'teste:ao-vivo', syncedAt: new Date() },
    });
    const response = await call('GET', '/api/jogos/resultados');
    await prisma.match.delete({ where: { id: live.id } });
    assert.equal(response.body[0].id, live.id);
    assert.equal(response.body[0].scoreA, 1);
  });

  test('jogo ao vivo que a fonte parou de confirmar não aparece como ao vivo', async () => {
    const stale = await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date(), teamA: 'I', teamB: 'J', scoreA: 1, scoreB: 0, status: 'LIVE', externalId: 'teste:parado', syncedAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    const response = await call('GET', '/api/jogos/resultados');
    await prisma.match.delete({ where: { id: stale.id } });
    assert.equal(response.body.some((match) => match.id === stale.id), false);
  });

  test('jogo cancelado sai das duas listas', async () => {
    const canceled = await prisma.match.create({
      data: { tournament: 'CBLOL 2099', date: new Date('2099-01-02T20:00:00Z'), teamA: 'K', teamB: 'L', status: 'CANCELED', externalId: 'teste:cancelado' },
    });
    const upcoming = await call('GET', '/api/jogos/proximos');
    const results = await call('GET', '/api/jogos/resultados');
    await prisma.match.delete({ where: { id: canceled.id } });
    assert.equal(upcoming.body.some((match) => match.id === canceled.id), false);
    assert.equal(results.body.some((match) => match.id === canceled.id), false);
  });

  test('próximos jogos têm limite, mesmo com muitos jogos vindos da fonte', async () => {
    const data = Array.from({ length: 205 }, (_, index) => ({
      tournament: 'Limite', date: new Date(Date.UTC(2098, 0, 1, 0, index)), teamA: 'M', teamB: 'N', status: 'UPCOMING',
    }));
    await prisma.match.createMany({ data });
    const response = await call('GET', '/api/jogos/proximos');
    await prisma.match.deleteMany({ where: { tournament: 'Limite' } });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.body.length <= 200, `${response.body.length} jogos`);
  });

  test('sem sincronização, a atualização responde vazia', async () => {
    const response = await call('GET', '/api/jogos/atualizacao');
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body, { updatedAt: null, games: [] });
  });

  test('informa quando os resultados foram atualizados', async () => {
    const base = await listen({ matchSync: { status: () => ({ updatedAt: new Date('2026-11-01T12:00:00Z'), games: ['VALORANT'] }) } });
    const response = await call('GET', '/api/jogos/atualizacao', { base });
    assert.deepEqual(response.body, { updatedAt: '2026-11-01T12:00:00.000Z', games: ['VALORANT'] });
    assert.match(response.headers.get('cache-control'), /no-store/);
  });
});

describe('matérias (US7)', () => {
  test('visitante vê contagens, mas não curte nem comenta', async () => {
    assert.equal((await call('GET', '/api/materias/interacoes')).status, 200);
    assert.equal((await call('POST', '/api/materias/3/curtir')).status, 401);
    assert.equal((await call('POST', '/api/materias/3/comentarios', { body: { content: 'Oi' } })).status, 401);
  });

  test('curtir alterna e fica salvo', async () => {
    const { token } = await register();
    const on = await call('POST', '/api/materias/1/curtir', { token });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.liked, true);
    const stats = await call('GET', '/api/materias/interacoes', { token });
    assert.equal(stats.body['1'].liked, true);
    assert.ok(stats.body['1'].likes >= 1);
    const off = await call('POST', '/api/materias/1/curtir', { token });
    assert.equal(off.body.liked, false);
  });

  test('comentário fica salvo e aparece com o autor', async () => {
    const { token, data } = await register();
    const created = await call('POST', '/api/materias/2/comentarios', { token, body: { content: 'Comentário salvo' } });
    assert.equal(created.status, 201, created.text);
    const list = await call('GET', '/api/materias/2/comentarios');
    assert.ok(list.body.some((c) => c.content === 'Comentário salvo' && c.author.nickname === data.nickname));
    assert.equal(list.text.includes(data.email), false);
  });

  test('recusa identificador inválido e comentário vazio', async () => {
    const { token } = await register();
    assert.equal((await call('POST', '/api/materias/abc/curtir', { token })).status, 400);
    assert.equal((await call('POST', '/api/materias/1/comentarios', { token, body: { content: '   ' } })).status, 400);
  });
});

describe('proteções gerais (M2)', () => {
  test('não libera CORS por padrão', async () => {
    const response = await call('GET', '/api/forum/topicos', { headers: { Origin: 'https://outro-site.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('libera CORS só para a origem configurada', async () => {
    const base = await listen({ corsOrigins: ['https://permitida.example'], rateLimits: { login: 1000, register: 1000, write: 1000 } });
    const ok = await call('GET', '/api/forum/topicos', { base, headers: { Origin: 'https://permitida.example' } });
    const other = await call('GET', '/api/forum/topicos', { base, headers: { Origin: 'https://outro-site.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://permitida.example');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  test('o número de proxies confiáveis é configurável, com 1 como padrão', () => {
    assert.equal(createApp({ prisma, jwtSecret: JWT_SECRET }).get('trust proxy'), 1);
    assert.equal(createApp({ prisma, jwtSecret: JWT_SECRET, trustProxyHops: 3 }).get('trust proxy'), 3);
  });

  test('envia cabeçalhos de segurança', async () => {
    const response = await call('GET', '/');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  test('JSON malformado dá 400, e corpo grande demais dá 413', async () => {
    assert.equal((await call('POST', '/api/auth/login', { raw: '{"quebrado":' })).status, 400);
    const big = await call('POST', '/api/auth/login', { body: { loginUser: 'x', password: 'y'.repeat(2_000_000) } });
    assert.equal(big.status, 413);
  });

  test('rota desconhecida da API responde 404 em JSON', async () => {
    const response = await call('GET', '/api/nao-existe');
    assert.equal(response.status, 404);
    assert.equal(typeof response.body.error, 'string');
  });

  test('registra o erro interno sem dados sensíveis (B5)', async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));
    const base = await listen({
      prisma: { user: { findFirst: () => { throw Object.assign(new Error('senha-secreta no erro'), { code: 'P9999' }); } } },
      rateLimits: { login: 1000, register: 1000, write: 1000 },
    });
    try {
      const response = await call('POST', '/api/auth/login', { base, body: { loginUser: 'x@example.com', password: 'senha-secreta' } });
      assert.equal(response.status, 500);
    } finally {
      console.error = original;
    }
    assert.ok(lines.some((line) => line.includes('P9999')));
    assert.equal(lines.some((line) => line.includes('senha-secreta')), false);
  });
});

describe('idade mínima (B2)', () => {
  test('conta o aniversário no fuso de São Paulo', () => {
    const { calculateAge } = require('../validation');
    assert.equal(calculateAge('2010-10-31', new Date('2026-10-31T12:00:00Z')), 16);
    assert.equal(calculateAge('2010-11-01', new Date('2026-10-31T12:00:00Z')), 15);
    assert.equal(calculateAge('2010-10-31', new Date('2026-10-31T02:00:00Z')), 15);
    assert.equal(calculateAge('2010-10-30', new Date('2026-10-31T02:00:00Z')), 16);
  });

  test('não aceita data que não existe no calendário', () => {
    const { calculateAge } = require('../validation');
    assert.equal(calculateAge('2010-02-31', new Date('2026-10-31T12:00:00Z')), null);
  });
});

describe('carga inicial (C4)', () => {
  const load = () => require('../prisma/seed');

  test('sem variáveis, não cria administrador', async () => {
    const { seed } = load();
    await seed(prisma, {});
    assert.equal(await prisma.user.count({ where: { role: 'SUPER_ADMIN' } }), 0);
  });

  test('recusa senha de administrador curta', async () => {
    const { seed } = load();
    await assert.rejects(seed(prisma, { ADMIN_EMAIL: 'adm@example.com', ADMIN_PASSWORD: 'curta' }));
  });

  test('cria o administrador, e a conta entra com a senha do ambiente', async () => {
    const { seed } = load();
    const env = { ADMIN_EMAIL: 'adm@example.com', ADMIN_PASSWORD: 'senha-longa-do-ambiente' };
    await seed(prisma, env);
    await seed(prisma, env);
    assert.equal(await prisma.user.count({ where: { role: 'SUPER_ADMIN' } }), 1);
    const login = await call('POST', '/api/auth/login', { body: { loginUser: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'SUPER_ADMIN');
  });

  test('conta comum com o e-mail do administrador perde a senha antiga ao ser promovida', async () => {
    const { seed } = load();
    const { data } = await register({ email: 'adm2@example.com' });
    await seed(prisma, { ADMIN_EMAIL: data.email, ADMIN_PASSWORD: 'outra-senha-longa-do-ambiente' });
    assert.equal((await call('POST', '/api/auth/login', { body: { loginUser: data.email, password: PASSWORD } })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { body: { loginUser: data.email, password: 'outra-senha-longa-do-ambiente' } })).status, 200);
  });

  test('carrega jogos e tópicos iniciais sem duplicar', async () => {
    const { seed } = load();
    await seed(prisma, {});
    const matches = await prisma.match.count();
    const topics = await prisma.forumTopic.count({ where: { author: { nickname: 'EquipeCTRLGIRL' } } });
    await seed(prisma, {});
    assert.equal(await prisma.match.count(), matches);
    assert.equal(await prisma.forumTopic.count({ where: { author: { nickname: 'EquipeCTRLGIRL' } } }), topics);
    assert.ok(topics > 0);
    const results = await call('GET', '/api/jogos/resultados');
    assert.ok(results.body.some((match) => match.teamA === 'LOS' && match.scoreA === 3));
    // Conferido com a PandaScore: a FURIA venceu a final inferior e foi à Grande Final.
    const lowerFinal = await prisma.match.findUnique({ where: { id: 'cblol-2026-final-inferior' } });
    assert.deepEqual([lowerFinal.scoreA, lowerFinal.scoreB], [0, 3]);
  });
});
