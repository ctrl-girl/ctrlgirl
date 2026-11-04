// Aplica as migrações de prisma/migrations antes de o servidor subir.
// No SQLite local, quem aplica é o próprio Prisma. No Turso o Prisma Migrate não funciona, então cada
// migration.sql roda aqui, uma vez só, e o nome dela fica registrado na tabela _libsql_migrations.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MIGRATIONS = path.join(__dirname, '..', 'prisma', 'migrations');

// O Prisma gera cada comando terminando em ";" no fim da linha, e os comentários em linhas com "--".
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function migrationNames(dir = MIGRATIONS) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Cada migração vai numa transação junto com o registro: ou entra inteira, ou não entra.
async function applyMigrations(client, dir = MIGRATIONS) {
  await client.execute('CREATE TABLE IF NOT EXISTS "_libsql_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)');
  const { rows } = await client.execute('SELECT "name" FROM "_libsql_migrations"');
  const applied = new Set(rows.map((row) => row.name));
  const pending = migrationNames(dir).filter((name) => !applied.has(name));
  for (const name of pending) {
    const statements = splitStatements(fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'));
    await client.batch([
      ...statements,
      { sql: 'INSERT INTO "_libsql_migrations" ("name", "appliedAt") VALUES (?, ?)', args: [name, new Date().toISOString()] },
    ], 'write');
  }
  return pending;
}

if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch {
    // Sem .env local: segue com o ambiente.
  }
  if (!process.env.TURSO_DATABASE_URL) {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } else {
    const { createLibsqlClient } = require('../db');
    const client = createLibsqlClient();
    applyMigrations(client)
      .then((pending) => console.log(pending.length ? `Migrações aplicadas no Turso: ${pending.join(', ')}` : 'O Turso já está com todas as migrações.'))
      .catch((error) => {
        console.error(`A migração no Turso falhou: ${error.message}`);
        process.exitCode = 1;
      })
      .finally(() => client.close());
  }
}

module.exports = { applyMigrations, migrationNames, splitStatements };
