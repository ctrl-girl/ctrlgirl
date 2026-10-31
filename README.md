# CTRL GIRL

Portal de eSports inclusivo (PWA), com matérias, jogos, fórum e fonte para dislexia. Trabalho de Conclusão de Curso.

Backend em Express 5 + Prisma 5 (SQLite) + JWT. O front é HTML, Tailwind compilado e módulos JavaScript, sem etapa de build na hospedagem.

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
| `DATABASE_URL` | Sim | Banco de dados. Ex.: `file:./dev.db`, relativo à pasta `prisma/`. |
| `ADMIN_EMAIL` e `ADMIN_PASSWORD` | Não | Criam a conta `SUPER_ADMIN` ao iniciar. A senha precisa de pelo menos 12 caracteres e vale só na criação: depois, troque-a em Perfil > Editar perfil. |
| `CORS_ORIGINS` | Não | Outras origens que podem chamar a API, separadas por vírgula. |
| `TRUST_PROXY_HOPS` | Não | Quantos proxies ficam à frente do app, para os limites por IP. O padrão é 1. |
| `PORT` | Não | Porta do servidor. A hospedagem costuma definir sozinha. |

O arquivo `.env` nunca vai para o Git.

## Publicar no Render

1. **Antes de publicar**, em **Environment**, defina `JWT_SECRET` e `DATABASE_URL`. Sem elas, o deploy falha e o Render mantém a versão anterior no ar.
2. Em **Settings**, use `npm install` como Build Command e `npm start` como Start Command.
3. Decida onde o banco fica. O disco do Render é temporário: sem disco persistente, os cadastros somem a cada deploy ou reinício e, no plano Free, também quando o serviço hiberna. As opções são:
   - disco persistente em plano pago, com `DATABASE_URL="file:/caminho-do-disco/ctrlgirl.db"`;
   - banco PostgreSQL, trocando o `provider` em `prisma/schema.prisma` e gerando uma nova migração.
4. Depois do primeiro deploy, confira que o banco antigo não está mais exposto. O resultado esperado é `404`:

```bash
curl -I https://SEU-APP.onrender.com/prisma/dev.db
```

5. Se pessoas diferentes receberem o aviso de muitas tentativas ao entrar ou se cadastrar, elas podem estar dividindo o mesmo IP. O Render não documenta quantos proxies ficam à frente do app: ajuste `TRUST_PROXY_HOPS` aos poucos. Um valor acima do real permite falsificar o IP.

## Testes

```bash
npm test
```

Os testes usam um banco temporário em `test/.tmp`.

## Mudanças no visual

O CSS em `public/css/app.css` e as fontes em `public/vendor` são gerados e ficam no Git. Depois de mudar classes do Tailwind ou `src/styles.css`, rode:

```bash
npm run build
```

Ao publicar uma mudança no front, altere também `public/sw.js`, por exemplo o nome em `CACHE`. É isso que faz o navegador instalar a versão nova do service worker.

## Conteúdo

- **Matérias:** `public/js/data.mjs`.
- **Jogos e resultados:** `prisma/seed.js`. Inclua jogos novos ali, com um `id` próprio, e reinicie o servidor. Jogos com data passada não aparecem em Próximos jogos.

## Estrutura

```text
app.js              rotas da API e proteções
server.js           início do servidor e leitura do ambiente
validation.js       regras de validação
prisma/             schema, migrações e carga inicial
public/             tudo o que é servido ao navegador
src/styles.css      origem do CSS
scripts/            geração do CSS e cópia das fontes
test/               testes da API e do front
```
