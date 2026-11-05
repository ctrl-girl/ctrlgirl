import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const logic = () => import('../public/js/logic.mjs');
const data = () => import('../public/js/data.mjs');

describe('injeção de HTML (A5)', () => {
  test('o template escapa qualquer valor interpolado', async () => {
    const { html } = await logic();
    const output = String(html`<p title="${'"x"'}">${'<img src=x onerror=alert(1)>'}</p>`);
    assert.equal(output, '<p title="&quot;x&quot;">&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  test('só raw() deixa passar HTML confiável, e templates aninhados não escapam duas vezes', async () => {
    const { html, raw } = await logic();
    assert.equal(String(html`<div>${raw('<b>ok</b>')}</div>`), '<div><b>ok</b></div>');
    assert.equal(String(html`<ul>${[1, 2].map((n) => html`<li>${n}</li>`)}</ul>`), '<ul><li>1</li><li>2</li></ul>');
    assert.equal(String(html`<i>${null}${undefined}${false}</i>`), '<i></i>');
  });
});

describe('montagem de listas', () => {
  test('lista de templates vira HTML sem vírgulas entre os itens', async () => {
    const { html, toHtml } = await logic();
    assert.equal(toHtml([html`<li>1</li>`, html`<li>2</li>`]), '<li>1</li><li>2</li>');
    assert.equal(toHtml(html`<p>${'<x>'}</p>`), '<p>&lt;x&gt;</p>');
  });
});

describe('dados das matérias (US5)', () => {
  test('o destaque aponta para a matéria do guia', async () => {
    const { articles, HERO_ARTICLE_ID } = await data();
    assert.match(articles.find((article) => article.id === HERO_ARTICLE_ID).title, /Guia de sobrevivência/);
  });

  test('o HTML das matérias está balanceado e sem título acima de h2', async () => {
    const { articles } = await data();
    for (const article of articles) {
      const opened = (article.content.match(/<p>/g) || []).length;
      const closed = (article.content.match(/<\/p>/g) || []).length;
      assert.equal(opened, closed, `matéria ${article.id}`);
      assert.doesNotMatch(article.content, /<h1/);
    }
  });
});

describe('busca e filtros (US6, US8, US24)', () => {
  const matches = [{ id: 'a', tournament: 'Worlds 2026', teamA: 'FURIA', teamB: 'MVK' }, { id: 'b', tournament: 'VCT Américas', teamA: '100Thieves', teamB: 'LOUD' }];
  const topics = [{ id: 't', title: 'Dicas de duo', content: 'Como lidar com toxicidade' }];

  test('encontra a principal notícia pelo título', async () => {
    const { searchContent } = await logic();
    const { articles } = await data();
    const found = searchContent({ query: articles[0].title.slice(0, 20), filter: 'all', articles, matches, topics });
    assert.ok(found.articles.some((article) => article.id === 0));
  });

  test('sem texto e sem filtro, traz tudo', async () => {
    const { searchContent } = await logic();
    const { articles } = await data();
    const found = searchContent({ query: '', filter: 'all', articles, matches, topics });
    assert.equal(found.articles.length, articles.length);
    assert.equal(found.matches.length, matches.length);
    assert.equal(found.topics.length, topics.length);
  });

  test('encontra jogo do Worlds e tópico do fórum', async () => {
    const { searchContent } = await logic();
    const { articles } = await data();
    assert.equal(searchContent({ query: 'worlds', filter: 'all', articles: [], matches, topics }).matches.length, 1);
    assert.equal(searchContent({ query: 'toxicidade', filter: 'all', articles, matches, topics }).topics.length, 1);
  });

  test('o filtro de jogo separa League of Legends e Valorant', async () => {
    const { searchContent } = await logic();
    const { articles } = await data();
    const lol = searchContent({ query: '', filter: 'lol', articles, matches, topics });
    const valorant = searchContent({ query: '', filter: 'valorant', articles, matches, topics });
    assert.ok(lol.articles.some((article) => article.category === 'CBLOL'));
    assert.ok(lol.matches.every((match) => match.tournament === 'Worlds 2026'));
    assert.ok(valorant.articles.every((article) => article.games.includes('valorant')));
    assert.ok(valorant.matches.every((match) => match.tournament === 'VCT Américas'));
  });

  test('filtrar por categoria mostra só aquela categoria', async () => {
    const { filterByTournament } = await logic();
    const list = [{ tournament: 'CBLOL 2026' }, { tournament: 'Worlds 2026' }, { tournament: 'VCT Américas' }];
    assert.equal(filterByTournament(list, 'all').length, 3);
    assert.deepEqual(filterByTournament(list, 'CBLOL').map((m) => m.tournament), ['CBLOL 2026']);
  });

  test('o selo de resultados é contado a partir dos dados (US22)', async () => {
    const { summarizeResults } = await logic();
    const results = [{ tournament: 'CBLOL' }, { tournament: 'CBLOL' }, { tournament: 'VCT Américas' }, { tournament: 'VALORANT Champions 2026' }];
    assert.equal(summarizeResults(results), '2 CBLOL, 1 VCT Américas, 1 VALORANT Champions 2026');
  });

  test('Game Changers e Masters contam como Valorant', async () => {
    const { gameOfTournament } = await logic();
    assert.equal(gameOfTournament('Game Changers 2026'), 'valorant');
    assert.equal(gameOfTournament('VALORANT Masters London 2026'), 'valorant');
    assert.equal(gameOfTournament('Worlds 2026'), 'lol');
  });
});

describe('aviso de atualização dos resultados', () => {
  const NOW = new Date('2026-11-01T18:00:00Z');

  test('sem atualização confirmada, não afirma nada', async () => {
    const { resultsUpdatedLabel } = await logic();
    assert.equal(resultsUpdatedLabel({ updatedAt: null, games: [] }, NOW), '');
    assert.equal(resultsUpdatedLabel(null, NOW), '');
  });

  test('no mesmo dia mostra só a hora, no fuso de Brasília', async () => {
    const { resultsUpdatedLabel } = await logic();
    assert.equal(resultsUpdatedLabel({ updatedAt: '2026-11-01T17:32:00Z', games: ['VALORANT'] }, NOW), 'VALORANT atualizado às 14:32');
  });

  test('em outro dia mostra a data, para não parecer atual', async () => {
    const { resultsUpdatedLabel } = await logic();
    assert.equal(resultsUpdatedLabel({ updatedAt: '2026-10-30T17:32:00Z', games: ['VALORANT'] }, NOW), 'VALORANT atualizado em 30/10 às 14:32');
  });

  test('com os dois jogos, concorda no plural', async () => {
    const { resultsUpdatedLabel } = await logic();
    const label = resultsUpdatedLabel({ updatedAt: '2026-11-01T17:32:00Z', games: ['League of Legends', 'VALORANT'] }, NOW);
    assert.equal(label, 'League of Legends e VALORANT atualizados às 14:32');
  });

  test('a lista só é redesenhada quando muda algo que aparece no cartão', async () => {
    const { resultsKey } = await logic();
    const match = { id: 'a', status: 'LIVE', tournament: 'VCT Américas', stage: 'Final', date: '2026-11-01T18:00:00Z', teamA: 'LOUD', teamB: 'NRG', scoreA: 1, scoreB: 0, syncedAt: '2026-11-01T18:00:00Z' };
    assert.equal(resultsKey([match]), resultsKey([{ ...match, syncedAt: '2026-11-01T18:05:00Z' }]));
    assert.notEqual(resultsKey([match]), resultsKey([{ ...match, scoreB: 1 }]));
    assert.notEqual(resultsKey([match]), resultsKey([{ ...match, status: 'FINISHED' }]));
    assert.notEqual(resultsKey([match]), resultsKey([]));
  });

  test('a tela inicial tem onde mostrar o aviso', () => {
    assert.match(read('public/index.html'), /id="resultsUpdated"/);
  });

  test('pausada, avisa e mostra de quando são os dados, sempre com a data', async () => {
    const { resultsPausedLabel } = await logic();
    assert.equal(resultsPausedLabel({ updatedAt: '2026-11-01T17:32:00Z', games: ['VALORANT'] }), 'Atualização pausada. VALORANT atualizado em 01/11 às 14:32');
  });

  test('pausada e sem atualização confirmada, só avisa da pausa', async () => {
    const { resultsPausedLabel } = await logic();
    assert.equal(resultsPausedLabel({ updatedAt: null, games: [] }), 'Atualização pausada');
    assert.equal(resultsPausedLabel(null), 'Atualização pausada');
  });

  test('só renova com a tela inicial aberta, visível e sem pausa (WCAG 2.2.2)', async () => {
    const { shouldRefreshResults } = await logic();
    assert.equal(shouldRefreshResults({ view: 'home', hidden: false, paused: false }), true);
    assert.equal(shouldRefreshResults({ view: 'home', hidden: false, paused: true }), false);
    assert.equal(shouldRefreshResults({ view: 'home', hidden: true, paused: false }), false);
    assert.equal(shouldRefreshResults({ view: 'forum', hidden: false, paused: false }), false);
  });

  test('a tela inicial tem o botão de pausar, com alvo de toque de 44 px (WCAG 2.2.2)', () => {
    const button = read('public/index.html').match(/<button\b[^>]*data-action="toggle-results-pause"[^>]*>/)?.[0];
    assert.ok(button, 'sem botão de pausar');
    assert.match(button, /\bmin-h-11\b/);
  });

  test('a escolha de pausar continua depois de recarregar', () => {
    const app = read('public/js/app.mjs');
    assert.match(app, /localStorage\.setItem\(RESULTS_PAUSED_KEY, String\(paused\)\)/);
    assert.match(app, /setResultsPaused\(localStorage\.getItem\(RESULTS_PAUSED_KEY\) === 'true'\)/);
  });

  test('a renovação olha a pausa antes da busca e também depois dela', () => {
    const refresh = read('public/js/app.mjs').match(/async function refreshResults\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(refresh, 'sem refreshResults');
    assert.match(refresh, /shouldRefreshResults\(/);
    assert.match(refresh, /await loadResults\(\)[\s\S]*if \(state\.resultsPaused\) return;/);
  });

  test('pausada, a bolinha do selo "Ao vivo" para de piscar', () => {
    assert.match(read('public/js/app.mjs'), /motion-safe:animate-pulse group-data-\[paused\]:animate-none/);
    assert.match(read('public/css/app.css'), /group-data-\\\[paused\\\]\\:animate-none/);
  });
});

describe('rotas (US11)', () => {
  test('traduz o endereço em tela', async () => {
    const { parseRoute } = await logic();
    assert.deepEqual(parseRoute('#/inicio'), { view: 'home' });
    assert.deepEqual(parseRoute('#/materia/2'), { view: 'article', id: 2 });
    assert.deepEqual(parseRoute('#/forum/abc-123'), { view: 'topic', id: 'abc-123' });
    assert.deepEqual(parseRoute('#/perfil/editar'), { view: 'profileEdit' });
    assert.deepEqual(parseRoute('#/entrar'), { view: 'auth' });
    assert.deepEqual(parseRoute(''), { view: 'home' });
    assert.deepEqual(parseRoute('#/nao-existe'), { view: 'home' });
    assert.deepEqual(parseRoute('#/materia/abc'), { view: 'home' });
  });

  test('o link compartilhado de matéria vira a rota interna', async () => {
    const { sharedArticleHash } = await logic();
    assert.equal(sharedArticleHash('/materia/3'), '#/materia/3');
    assert.equal(sharedArticleHash('/materia/3/'), '#/materia/3');
    assert.equal(sharedArticleHash('/'), null);
    assert.equal(sharedArticleHash('/materia/abc'), null);
    assert.equal(sharedArticleHash('/materia/12345'), null);
  });

  test('o app compartilha /materia/N e traduz esse endereço antes de escolher a tela', () => {
    const app = read('public/js/app.mjs');
    assert.match(app, /const articleUrl = \(\) => `\$\{location\.origin\}\/materia\/\$\{state\.article\.id\}`;/);
    const boot = app.slice(app.indexOf('async function boot()'));
    const translate = boot.indexOf('sharedArticleHash(location.pathname)');
    assert.ok(translate > -1);
    assert.ok(translate < boot.indexOf('await route()'));
  });
});

describe('utilidades', () => {
  test('monta iniciais para o avatar (US17)', async () => {
    const { initials } = await logic();
    assert.equal(initials('Maria Silva'), 'MS');
    assert.equal(initials('gamerx'), 'GA');
    assert.equal(initials(''), '?');
  });

  test('calcula a data máxima de nascimento para 16 anos (US12)', async () => {
    const { maxBirthDate } = await logic();
    assert.equal(maxBirthDate(new Date('2026-10-31T12:00:00Z')), '2010-10-31');
  });

  test('mostra data e hora no fuso de São Paulo (US14)', async () => {
    const { formatMatchDate } = await logic();
    assert.equal(formatMatchDate('2026-10-15T23:00:00.000Z'), 'quinta-feira, 15/10 às 20:00');
  });

  test('mostra a data de nascimento sem deslocar pelo fuso', async () => {
    const { formatBirthDate } = await logic();
    assert.equal(formatBirthDate('2000-05-20T00:00:00.000Z'), '20/05/2000');
  });

  test('gera arquivo de agenda real para o lembrete (US3)', async () => {
    const { buildIcs } = await logic();
    const ics = buildIcs({ id: 'x1', tournament: 'CBLOL, final', teamA: 'LOS', teamB: 'FURIA', date: '2099-01-01T20:00:00.000Z' }, new Date('2026-10-31T12:00:00Z'));
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /DTSTART:20990101T200000Z/);
    assert.match(ics, /SUMMARY:LOS x FURIA \(CBLOL\\, final\)/);
    assert.match(ics, /BEGIN:VALARM/);
    assert.match(ics, /\r\n/);
  });

  test('monta os links de compartilhamento com o endereço da matéria (US3)', async () => {
    const { shareLinks } = await logic();
    const links = shareLinks({ title: ' Título & cia ', url: 'https://app.example/materia/2' });
    assert.equal(links.whatsapp, `https://wa.me/?text=${encodeURIComponent('Título & cia https://app.example/materia/2')}`);
    assert.ok(links.twitter.includes(`text=${encodeURIComponent('Título & cia')}&`));
    assert.ok(links.telegram.startsWith('https://t.me/share/url?'));
    assert.ok(links.facebook.startsWith('https://www.facebook.com/sharer/'));
  });
});

describe('página (CSP e acessibilidade)', () => {
  test('não tem script, estilo nem evento inline', () => {
    const page = read('public/index.html');
    assert.doesNotMatch(page, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/i);
    assert.doesNotMatch(page, /\sstyle\s*=/i);
    assert.doesNotMatch(page, /<style/i);
  });

  test('todo ícone usado existe na versão do Font Awesome do projeto', () => {
    const css = read('public/vendor/fontawesome/css/all.min.css');
    const used = new Set();
    for (const file of ['public/index.html', 'public/js/app.mjs']) {
      for (const [, name] of read(file).matchAll(/\bfa-(?:solid|regular|brands) fa-([a-z0-9-]+)/g)) used.add(name);
    }
    assert.ok(used.has('x-twitter'));
    for (const name of used) assert.match(css, new RegExp(`\\.fa-${name}[,:{]`), name);
  });

  test('o fórum mostra a foto de quem escreveu no tópico, na discussão e nas respostas', () => {
    const app = read('public/js/app.mjs');
    assert.match(app, /function authorPhoto\(author\)/);
    assert.equal((app.match(/authorPhoto\((topic|comment)\.author\)/g) || []).length, 3);
  });

  test('no cadastro, o link dos termos aparece uma vez só', () => {
    const page = read('public/index.html');
    const start = page.indexOf('id="authPageRegister"');
    const register = page.slice(start, page.indexOf('</form>', start));
    assert.equal((register.match(/data-action="open-terms"/g) || []).length, 1);
    assert.match(page, /<button id="authTermsButton" type="button" data-action="open-terms"/);
    const app = read('public/js/app.mjs');
    const start2 = app.indexOf('function switchAuthPage(');
    assert.match(app.slice(start2, start2 + 700), /\$\('authTermsButton'\)\.classList\.toggle\('hidden', page === 'register'\)/);
  });

  test('a tela de jogos mostra "Onde assistir" uma vez só, no topo, e não em cada cartão', async () => {
    const { HERO_ARTICLE_ID } = await data();
    const page = read('public/index.html');
    const header = page.slice(page.indexOf('id="viewMatches"'), page.indexOf('id="matchesContainer"'));
    assert.match(header, new RegExp(`href="#/materia/${HERO_ARTICLE_ID}"[^>]*>[\\s\\S]*?Onde assistir`));
    const app = read('public/js/app.mjs');
    const card = app.slice(app.indexOf('function matchCard('), app.indexOf('function showMatches('));
    assert.doesNotMatch(card, /Onde assistir/);
    assert.match(card, /data-action="add-to-calendar"[^>]*aria-pressed=/);
  });

  test('aria-pressed recebe "true" ou "false" por extenso, porque o template apaga o false', () => {
    const app = read('public/js/app.mjs');
    const values = [...app.matchAll(/aria-pressed="\$\{([^}]*)\}"/g)].map((found) => found[1]);
    assert.ok(values.length >= 2);
    for (const value of values) assert.match(value, /^String\(/, value);
  });

  test('não depende de CDN em tempo de execução (M4, M5)', () => {
    assert.doesNotMatch(read('public/index.html'), /https?:\/\/(cdn|cdnjs|fonts)\./i);
    assert.doesNotMatch(read('public/css/app.css'), /@master|cdn\.jsdelivr/);
  });

  test('não tem barra de status fictícia (AC4, US18)', () => {
    const page = read('public/index.html');
    assert.doesNotMatch(page, /12:09 PM/);
    assert.doesNotMatch(page, /Bateria 100%/);
  });

  test('filtros não usam tablist (AC5)', () => {
    assert.equal((read('public/index.html').match(/role="tablist"/g) || []).length, 1);
  });

  test('todo campo tem rótulo (AC7)', () => {
    const page = read('public/index.html');
    const fields = [...page.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="(file|hidden)"/.test(tag));
    assert.ok(fields.length > 10);
    for (const tag of fields) {
      const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
      assert.ok(id, `sem id: ${tag}`);
      assert.ok(page.includes(`for="${id}"`), `sem rótulo: ${id}`);
    }
  });

  test('campos de conta têm autocomplete (AC7)', () => {
    const page = read('public/index.html');
    for (const id of ['loginUser', 'loginPass', 'regName', 'regNick', 'regEmail', 'regPass', 'regBirthDate']) {
      assert.match(page, new RegExp(`id="${id}"[^>]*autocomplete="[a-z-]+"`), id);
    }
  });

  test('campos usam fonte de 16 px para evitar zoom no iPhone (AC2)', () => {
    const page = read('public/index.html');
    for (const tag of page.match(/<(input|select|textarea)\b[^>]*>/g)) {
      assert.doesNotMatch(tag, /\btext-(xs|sm)\b/, tag);
    }
  });

  test('não sobra texto de 10 ou 11 px (AC2)', () => {
    for (const file of ['public/index.html', 'public/js/app.mjs']) {
      assert.doesNotMatch(read(file), /text-\[1[01]px\]/, file);
    }
  });

  test('a folha de estilos respeita movimento reduzido (AC11)', () => {
    assert.match(read('public/css/app.css'), /prefers-reduced-motion/);
  });

  test('o manifest aponta para ícones que existem (M4)', () => {
    const manifest = JSON.parse(read('public/manifest.json'));
    const sizes = manifest.icons.map((icon) => icon.sizes);
    assert.ok(sizes.includes('192x192'));
    assert.ok(sizes.includes('512x512'));
    for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, 'public', icon.src)), icon.src);
  });

  test('o service worker versiona o cache e apaga os antigos (M4)', () => {
    const worker = read('public/sw.js');
    assert.match(worker, /addEventListener\('activate'/);
    assert.match(worker, /caches\.delete/);
    assert.doesNotMatch(worker, /ctrl-girl-cache-v1'\)/);
  });
});

describe('repositório (C3, M6, M8)', () => {
  test('o .gitignore cobre .env e bancos locais', () => {
    const ignore = read('.gitignore');
    assert.match(ignore, /^\.env\*$/m);
    assert.match(ignore, /^!\.env\.example$/m);
    assert.match(ignore, /^\*\.db\*$/m);
  });

  test('o início não usa db push, e o postinstall não esconde falhas', () => {
    const { scripts, dependencies } = JSON.parse(read('package.json'));
    assert.doesNotMatch(scripts.start, /db push/);
    assert.match(scripts.start, /migrate deploy/);
    assert.doesNotMatch(scripts.postinstall, /exit 0/);
    assert.doesNotMatch(scripts.test, /no test specified/);
    assert.equal(dependencies.bcrypt, undefined);
  });

  test('há .env.example sem valores reais', () => {
    const example = read('.env.example');
    assert.match(example, /JWT_SECRET=/);
    assert.match(example, /DATABASE_URL=/);
    assert.doesNotMatch(example, /@gmail\.com/);
  });

  test('o token dos resultados fica fora do repositório', () => {
    assert.match(read('.env.example'), /^PANDASCORE_TOKEN=""$/m);
    assert.match(read('.env.example'), /^RESULTS_SYNC_MINUTES=""$/m);
  });

  test('a busca de resultados roda só no servidor: o navegador não fala com as fontes', () => {
    for (const file of ['public/index.html', 'public/js/app.mjs', 'public/js/api.mjs', 'public/js/logic.mjs']) {
      assert.doesNotMatch(read(file), /pandascore\.co|orlandomm\.net/, file);
    }
  });
});
