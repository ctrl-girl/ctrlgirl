const { test, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLibsqlClient, createPrisma } = require('../db');
const { applyMigrations, migrationNames, splitStatements } = require('../scripts/migrate');

const TMP = path.join(__dirname, '.tmp');
const MIGRATIONS = path.join(__dirname, '..', 'prisma', 'migrations');
const HOUR = 60 * 60 * 1000;
const created = [];

fs.mkdirSync(TMP, { recursive: true });

// No Windows, arquivo aberto não pode ser apagado, e o libSQL só solta o arquivo quando o processo termina.
// O que sobrar fica em test/.tmp e sai na primeira rodada depois de uma hora.
for (const name of fs.readdirSync(TMP)) {
  const file = path.join(TMP, name);
  // Os outros arquivos de teste rodam ao mesmo tempo e podem apagar o próprio banco entre a lista e esta leitura.
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat && Date.now() - stat.mtimeMs > HOUR) fs.rmSync(file, { recursive: true, force: true });
}

function removeDatabase(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(file + suffix, { force: true });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
    }
  }
}

function newEnv(name) {
  const file = path.join(TMP, `${name}-${process.pid}.db`);
  created.push(file);
  return { TURSO_DATABASE_URL: `file:${file.replaceAll('\\', '/')}` };
}

const newDatabase = (name) => createLibsqlClient(newEnv(name));
const tableNames = async (client) => (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((row) => row.name);
const appliedNames = async (client) => (await client.execute('SELECT "name" FROM "_libsql_migrations" ORDER BY "name"')).rows.map((row) => row.name);

after(() => created.forEach(removeDatabase));

describe('banco no Turso', () => {
  test('desconectar o Prisma fecha a conexão com o Turso, para o processo poder terminar', async () => {
    const env = newEnv('desconectar');
    const client = createLibsqlClient(env);
    await applyMigrations(client);
    client.close();
    const prisma = createPrisma(env);
    assert.equal(await prisma.user.count(), 0);
    await prisma.$disconnect();
    await assert.rejects(prisma.user.count());
  });
});

describe('migrações no Turso', () => {
  test('divide cada migração do Prisma em comandos inteiros, sem os comentários', () => {
    for (const name of migrationNames()) {
      const statements = splitStatements(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
      assert.ok(statements.length > 0, name);
      for (const statement of statements) {
        assert.doesNotMatch(statement, /^\s*--/m, name);
        assert.doesNotMatch(statement, /;\s*$/, name);
      }
    }
    const sql = '-- CreateTable\nCREATE TABLE "A" (\n    "x" TEXT\n);\n\n-- Comentário\nUPDATE "A" SET "x" = \'1\';\n';
    assert.deepEqual(splitStatements(sql), ['CREATE TABLE "A" (\n    "x" TEXT\n)', 'UPDATE "A" SET "x" = \'1\'']);
  });

  test('aplica cada migração uma vez só e registra o nome', async () => {
    const client = newDatabase('migracoes');
    try {
      assert.deepEqual(await applyMigrations(client), migrationNames());
      assert.deepEqual(await applyMigrations(client), []);
      assert.deepEqual(await appliedNames(client), migrationNames());
      const userColumns = (await client.execute('PRAGMA table_info("User")')).rows.map((row) => row.name);
      assert.ok(userColumns.includes('avatarUpdatedAt'));
    } finally {
      client.close();
    }
  });

  test('migração com erro não fica pela metade nem registrada', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'migracoes-'));
    fs.mkdirSync(path.join(dir, '001_boa'));
    fs.writeFileSync(path.join(dir, '001_boa', 'migration.sql'), 'CREATE TABLE "Boa" ("x" TEXT);\n');
    fs.mkdirSync(path.join(dir, '002_ruim'));
    fs.writeFileSync(path.join(dir, '002_ruim', 'migration.sql'), 'CREATE TABLE "Metade" ("x" TEXT);\nINSERT INTO "NaoExiste" VALUES (1);\n');
    const client = newDatabase('migracao-ruim');
    try {
      await assert.rejects(applyMigrations(client, dir));
      const tables = await tableNames(client);
      assert.ok(tables.includes('Boa'));
      assert.equal(tables.includes('Metade'), false);
      assert.deepEqual(await appliedNames(client), ['001_boa']);
    } finally {
      client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
