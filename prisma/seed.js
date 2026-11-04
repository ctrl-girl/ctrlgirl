// Carga inicial: jogos, tópicos de boas-vindas e a conta de administração.
// Pode rodar a cada início do servidor: nada é duplicado nem sobrescrito.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const MIN_ADMIN_PASSWORD = 12;
const TEAM_NICKNAME = 'EquipeCTRLGIRL';

// Os jogos chegam sozinhos pelas fontes de matchSources.js. Aqui fica o que elas não cobrem:
// inclua o jogo com um id próprio e reinicie o servidor.
const MATCHES = [
  { id: 'cblol-2026-grande-final', tournament: 'CBLOL', stage: 'Grande Final', date: '2026-10-10T13:00:00-03:00', teamA: 'LOS', teamB: 'FURIA', scoreA: 3, scoreB: 2, status: 'FINISHED' },
  { id: 'champions-2026-playoffs-nrg', tournament: 'VALORANT Champions 2026', stage: 'Playoffs', date: '2026-10-10T12:00:00-03:00', teamA: 'LOUD', teamB: 'NRG', scoreA: 2, scoreB: 1, status: 'FINISHED' },
  { id: 'cblol-2026-final-inferior', tournament: 'CBLOL', stage: 'Final da Chave Inferior', date: '2026-10-03T12:00:00-03:00', teamA: 'LOUD', teamB: 'FURIA', scoreA: 0, scoreB: 3, status: 'FINISHED' },
  { id: 'cblol-2026-final-superior', tournament: 'CBLOL', stage: 'Final da Chave Superior', date: '2026-09-27T12:00:00-03:00', teamA: 'LOUD', teamB: 'LOS', scoreA: 2, scoreB: 3, status: 'FINISHED' },
  { id: 'vct-americas-2026-final', tournament: 'VCT Américas', stage: 'Final', date: '2026-09-06T14:00:00-03:00', teamA: '100Thieves', teamB: 'LOUD', scoreA: 3, scoreB: 2, status: 'FINISHED' },
  { id: 'vct-americas-2026-playoffs', tournament: 'VCT Américas', stage: 'Playoffs', date: '2026-09-05T12:00:00-03:00', teamA: 'LOUD', teamB: 'NRG', scoreA: 3, scoreB: 2, status: 'FINISHED' },
  { id: 'worlds-2026-furia-mvk', tournament: 'Worlds 2026', stage: 'Fase de Entrada', date: '2026-10-15T20:00:00-03:00', teamA: 'FURIA', teamB: 'MVK', status: 'UPCOMING' },
  { id: 'champions-2026-loud-vit', tournament: 'VALORANT Champions 2026', stage: null, date: '2026-10-16T03:00:00-03:00', teamA: 'LOUD', teamB: 'VIT', status: 'UPCOMING' },
];

const STARTER_TOPICS = [
  {
    title: 'Dicas para melhorar a comunicação em duo sem toxicidade?',
    category: 'Dicas & Gameplay',
    content: 'Como vocês lidam quando encontram pessoas tóxicas nas partidas ranqueadas?',
  },
  {
    title: 'Expectativas para a fase de grupos do VCT Américas?',
    category: 'Campeonatos',
    content: 'Quais times vocês acham que garantem vaga nos playoffs neste ano?',
  },
];

async function seedMatches(prisma) {
  for (const { id, date, ...match } of MATCHES) {
    const data = { ...match, date: new Date(date) };
    await prisma.match.upsert({ where: { id }, update: {}, create: { id, ...data } });
  }
}

// A conta da equipe só publica os tópicos iniciais: a senha aleatória não é guardada em lugar nenhum.
async function seedStarterTopics(prisma) {
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const team = await prisma.user.upsert({
    where: { nickname: TEAM_NICKNAME },
    update: {},
    create: {
      name: 'Equipe CTRL GIRL',
      nickname: TEAM_NICKNAME,
      email: 'equipe@ctrlgirl.invalid',
      password: unusablePassword,
      birthDate: new Date('2000-01-01T00:00:00Z'),
    },
  });
  const existing = await prisma.forumTopic.count({ where: { authorId: team.id } });
  if (existing > 0) return;
  for (const topic of STARTER_TOPICS) {
    await prisma.forumTopic.create({ data: { ...topic, authorId: team.id } });
  }
}

// A administração nasce daqui, nunca do cadastro público. Se já existir uma conta comum
// com esse e-mail, ela perde a senha antiga: só quem tem a senha do ambiente entra como SUPER_ADMIN.
async function seedAdmin(prisma, env) {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password || password.length < MIN_ADMIN_PASSWORD) {
    throw new Error(`Defina ADMIN_EMAIL e ADMIN_PASSWORD (mínimo de ${MIN_ADMIN_PASSWORD} caracteres), ou deixe as duas vazias.`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.role === 'SUPER_ADMIN') return;

  const hash = await bcrypt.hash(password, 10);
  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { role: 'SUPER_ADMIN', password: hash, tokenVersion: { increment: 1 } },
    });
    return;
  }
  await prisma.user.create({
    data: {
      name: 'Administração',
      nickname: `admin_${crypto.randomBytes(3).toString('hex')}`,
      email,
      password: hash,
      birthDate: new Date('2000-01-01T00:00:00Z'),
      role: 'SUPER_ADMIN',
    },
  });
}

async function seed(prisma, env) {
  await seedMatches(prisma);
  await seedStarterTopics(prisma);
  await seedAdmin(prisma, env);
}

if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch {
    // Sem .env local: segue com o ambiente.
  }
  const { createPrisma } = require('../db');
  const prisma = createPrisma();
  seed(prisma, process.env)
    .catch((error) => {
      console.error(`Carga inicial falhou: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { seed };
