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
| `PANDASCORE_TOKEN` | Não | Liga a atualização automática de League of Legends. Sem ele, só VALORANT se atualiza. |
| `RESULTS_SYNC_MINUTES` | Não | De quantos em quantos minutos buscar os resultados, de 1 a 15. O padrão é 5, e `0` desliga. |
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

6. Para League of Legends se atualizar sozinho, defina também `PANDASCORE_TOKEN` em **Environment**.

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

Os testes usam um banco temporário em `test/.tmp`.

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
server.js           início do servidor e leitura do ambiente
validation.js       regras de validação
matchSources.js     fontes externas de jogos
matchSync.js        atualização automática dos jogos
prisma/             schema, migrações e carga inicial
public/             tudo o que é servido ao navegador
src/styles.css      origem do CSS
scripts/            geração do CSS e cópia das fontes
test/               testes da API e do front
```
