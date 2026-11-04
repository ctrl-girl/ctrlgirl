// Os mesmos testes da API, com o banco passando pelo adaptador do Turso, como em produção.
// O banco é um arquivo libSQL local: o caminho do código é o mesmo, sem depender da rede.
process.env.TEST_DB = 'libsql';
require('./api.test.js');
