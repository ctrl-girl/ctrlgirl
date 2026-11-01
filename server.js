// Em produção as variáveis vêm do ambiente; o .env existe só para rodar na própria máquina.
try {
  process.loadEnvFile();
} catch {
  // Sem .env local: segue com o ambiente.
}

const { PrismaClient } = require('@prisma/client');
const { createApp } = require('./app');
const { createDefaultSources } = require('./matchSources');
const { createMatchSync, parseSyncMinutes } = require('./matchSync');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET ausente ou curto. Defina um valor aleatório de pelo menos 32 caracteres no ambiente.');
  process.exit(1);
}

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 1;

const prisma = new PrismaClient();
const matchSync = createMatchSync({ prisma, sources: createDefaultSources({ pandascoreToken: process.env.PANDASCORE_TOKEN }) });
const app = createApp({ prisma, jwtSecret: JWT_SECRET, corsOrigins, trustProxyHops, matchSync });

app.listen(PORT, (error) => {
  // O Express 5 entrega aqui o erro ao abrir a porta, como quando ela já está ocupada.
  if (error) {
    console.error(`Não foi possível abrir a porta ${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Servidor CTRL GIRL rodando na porta ${PORT}`);
  matchSync.start(parseSyncMinutes(process.env.RESULTS_SYNC_MINUTES));
});
