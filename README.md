# CTRL GIRL

Portal de eSports inclusivo (PWA), com matérias, jogos, fórum e fonte para dislexia. Trabalho de Conclusão de Curso.

Backend em Express 5 + Prisma 5 (SQLite na máquina, Turso em produção) + JWT. O front é HTML, Tailwind compilado e módulos JavaScript, sem etapa de build na hospedagem.

## Rodar na sua máquina

Requer Node.js 20.12 ou mais recente.

```bash
npm install
cp .env.example .env
```

Preencha o `JWT_SECRET` no `.env` com um valor aleatório. Para gerar um:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Depois suba o app em http://localhost:3000:

```bash
npm start
```

O `npm start` aplica as migrações, carrega os dados iniciais e inicia o servidor.

## Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
| --- | --- | --- |
| `JWT_SECRET` | Sim | Assina as sessões. Aleatória, com pelo menos 32 caracteres. O servidor não sobe sem ela. |
| `DATABASE_URL` | Sim | Banco de dados. Ex.: `file:./dev.db`, relativo à pasta `prisma/`. Com o Turso ligado, fica sem uso, mas o Prisma ainda exige a variável. |
| `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` | Em produção | Endereço (`libsql://…`) e token do banco no Turso. Com o endereço preenchido, o app usa o Turso em vez do arquivo do `DATABASE_URL`. |
| `ADMIN_EMAIL` e `ADMIN_PASSWORD` | Não | Criam a conta `SUPER_ADMIN` ao iniciar. A senha precisa de pelo menos 12 caracteres e vale só na criação: depois, troque-a em Perfil > Editar perfil. |
| `CORS_ORIGINS` | Não | Outras origens que podem chamar a API, separadas por vírgula. |
| `TRUST_PROXY_HOPS` | Não | Quantos proxies ficam à frente do app, para os limites por IP. O padrão é 1. |
| `PANDASCORE_TOKEN` | Não | Liga a atualização automática de League of Legends. Sem ele, só VALORANT se atualiza. |
| `RESULTS_SYNC_MINUTES` | Não | De quantos em quantos minutos buscar os resultados, de 1 a 15. O padrão é 5, e `0` desliga. |
| `PORT` | Não | Porta do servidor. A hospedagem costuma definir sozinha. |

O arquivo `.env` nunca vai para o Git.

## Publicar no Render

1. **Antes de publicar**, em **Environment**, defina `JWT_SECRET` e `DATABASE_URL`. Sem elas, o deploy falha e o Render mantém a versão anterior no ar.
2. Em **Settings**, use `npm install` como Build Command e `npm start` como Start Command.
3. Ligue o banco no Turso. O disco do Render é temporário: um arquivo SQLite some a cada deploy, reinício e, no plano Free, a cada hibernação. Veja [Banco no Turso](#banco-no-turso).
4. Depois do primeiro deploy, confira que o banco antigo não está mais exposto. O resultado esperado é `404`:

```bash
curl -I https://SEU-APP.onrender.com/prisma/dev.db
```

5. Se pessoas diferentes receberem o aviso de muitas tentativas ao entrar ou se cadastrar, elas podem estar dividindo o mesmo IP. O Render não documenta quantos proxies ficam à frente do app: ajuste `TRUST_PROXY_HOPS` aos poucos. Um valor acima do real permite falsificar o IP.

6. Para League of Legends se atualizar sozinho, defina também `PANDASCORE_TOKEN` em **Environment**.

## Banco no Turso

Em produção, os dados ficam no [Turso](https://turso.tech), um banco compatível com SQLite que tem plano gratuito. Contas, tópicos, curtidas e lembretes sobrevivem a deploys e hibernações. Na sua máquina e nos testes, nada muda: sem `TURSO_DATABASE_URL`, o app usa o arquivo do `DATABASE_URL`.

**Para ligar:**

1. Crie uma conta no Turso e um banco, por exemplo `ctrlgirl`, na região mais perto de Oregon, onde o Render roda o app. Dá para fazer tudo pelo painel do site. A linha de comando do Turso só roda no Windows pelo WSL:

   ```bash
   turso db create ctrlgirl
   ```

2. Copie o endereço do banco, que começa com `libsql://`, e gere um token de leitura e escrita. Pela linha de comando:

   ```bash
   turso db show ctrlgirl --url
   ```

   ```bash
   turso db tokens create ctrlgirl
   ```

3. No Render, em **Environment**, defina `TURSO_DATABASE_URL` com o endereço e `TURSO_AUTH_TOKEN` com o token. Mantenha o `DATABASE_URL`. O token é senha: não vai para o Git nem para mensagens.
4. Publique. No primeiro início, o `npm start` cria as tabelas no Turso e faz a carga inicial. O log mostra `Migrações aplicadas no Turso`. Nos inícios seguintes, mostra `O Turso já está com todas as migrações.`

**Migrações:** o Prisma Migrate não funciona com o Turso. Por isso, `scripts/migrate.js` aplica cada `prisma/migrations/*/migration.sql` uma vez só, numa transação, e registra o nome na tabela `_libsql_migrations`. Para mudar o banco, crie a migração na sua máquina com `npx prisma migrate dev --name descricao`, e o próximo deploy a aplica no Turso. Não rode as migrações à mão no Turso: o registro ficaria sem elas, e o deploy tentaria aplicar de novo.

## Resultados automáticos

O servidor busca os jogos a cada 5 minutos e grava no banco. O navegador só fala com a API do próprio app, e a tela inicial renova o placar a cada minuto. Um botão ao lado da hora da última atualização pausa essa renovação (WCAG 2.2.2), e a escolha fica guardada no navegador.

| Jogo | Fonte | O que precisa |
| --- | --- | --- |
| VALORANT | [vlresports](https://github.com/Orloxx23/vlresports), projeto aberto que lê o vlr.gg | Nada |
| League of Legends | [PandaScore](https://developers.pandascore.co), plano gratuito | `PANDASCORE_TOKEN` |

Para ter o token, crie uma conta em [app.pandascore.co](https://app.pandascore.co) e copie o valor do painel. Ele é privado: fica no `.env` ou no painel da hospedagem, nunca no front nem no Git.

Os torneios acompanhados estão em `VLR_TOURNAMENTS` e `LOL_LEAGUES`, em `matchSources.js`: CBLOL, Worlds, VCT Américas, Masters, Champions e Game Changers do Brasil e das Américas, além do Championship.

Se uma fonte sair do ar, nada é apagado: a tela continua com os últimos dados e mostra a hora da última atualização. Um jogo só aparece como ao vivo enquanto a fonte confirma, no máximo 30 minutos depois da última confirmação.

Na lista de resultados, o vlresports só informa há quanto tempo foi cada jogo, como "1mo". Por isso a data vem da rota de detalhe, uma busca por jogo novo, e são guardados no máximo os 15 mais recentes por rodada. O vlresports limita a 30 chamadas por minuto, e a primeira rodada usa cerca de 20.

O vlresports é um projeto de terceiros, sem garantia de continuar no ar e sem termos de uso publicados. Se ele parar, a PandaScore também tem VALORANT (`/valorant/matches`), no mesmo formato.

## Testes

```bash
npm test
```

Os testes usam um banco temporário em `test/.tmp`. Os testes da API rodam duas vezes: uma com o SQLite do Prisma e outra pelo adaptador do Turso (`test/turso.test.js`), num arquivo libSQL local, sem depender da rede. No Windows, o libSQL só solta o arquivo quando o processo termina, então pode sobrar banco em `test/.tmp`. As sobras com mais de uma hora são apagadas na rodada seguinte.

## Mudanças no visual

O CSS em `public/css/app.css` e as fontes em `public/vendor` são gerados e ficam no Git. Depois de mudar classes do Tailwind ou `src/styles.css`, rode:

```bash
npm run build
```

Ao publicar uma mudança no front, altere também `public/sw.js`, por exemplo o nome em `CACHE`. É isso que faz o navegador instalar a versão nova do service worker.

## Conteúdo

- **Matérias:** `public/js/data.mjs`. O link de compartilhar é `/materia/N`: o servidor devolve o app com o título, o resumo (`summary`) e a imagem da matéria nas tags que o WhatsApp, o Telegram e as redes usam para montar a prévia. Por isso, a imagem precisa de endereço completo ou começar com `/`, e o resumo é o texto que aparece embaixo do título.
- **Fotos de perfil:** no fórum, aparecem ao lado do apelido, carregadas de `/api/usuarios/:id/foto`.
- **Jogos e resultados:** vêm das fontes acima. Use `prisma/seed.js` para o que as fontes não cobrem: inclua o jogo ali, com um `id` próprio, e reinicie o servidor. Jogos com data passada não aparecem em Próximos jogos.
- **Jogo cadastrado à mão que também está na fonte:** a fonte assume a linha em vez de duplicar, desde que o torneio e os times sejam os mesmos e a diferença de horário seja de até 18 horas. A exceção é o jogo que a fonte já listava como "A definir" antes de você cadastrar: ele fica duplicado, e basta tirar o seu do `seed.js`.

## Estrutura

```text
app.js              rotas da API e proteções
articlePage.js      prévia das matérias no link compartilhado
db.js               escolha do banco: Turso ou SQLite local
server.js           início do servidor e leitura do ambiente
validation.js       regras de validação
matchSources.js     fontes externas de jogos
matchSync.js        atualização automática dos jogos
prisma/             schema, migrações e carga inicial
public/             tudo o que é servido ao navegador
src/styles.css      origem do CSS
scripts/            migrações no início, geração do CSS e cópia das fontes
test/               testes da API e do front
```
