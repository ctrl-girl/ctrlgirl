// Escolhe o banco. Com TURSO_DATABASE_URL, os dados ficam no Turso e sobrevivem a deploys e hibernações.
// Sem ela, vale o SQLite do DATABASE_URL, como na máquina de quem desenvolve e nos testes.
const { PrismaClient } = require('@prisma/client');

function createLibsqlClient(env = process.env) {
  const { createClient } = require('@libsql/client');
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined });
}

function createPrisma(env = process.env) {
  if (!env.TURSO_DATABASE_URL) return new PrismaClient();
  const { PrismaLibSQL } = require('@prisma/adapter-libsql');
  const libsql = createLibsqlClient(env);
  const prisma = new PrismaClient({ adapter: new PrismaLibSQL(libsql) });
  // O $disconnect do Prisma não fecha a conexão do libSQL. Aberta, ela seguraria o processo do seed,
  // e o npm start nunca chegaria ao servidor.
  const disconnect = prisma.$disconnect.bind(prisma);
  prisma.$disconnect = async () => {
    await disconnect();
    libsql.close();
  };
  return prisma;
}

module.exports = { createPrisma, createLibsqlClient };
