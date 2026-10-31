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
    const links = shareLinks({ title: 'Título & cia', url: 'https://app.example/#/materia/2' });
    assert.ok(links.whatsapp.startsWith('https://wa.me/?text='));
    assert.ok(links.whatsapp.includes(encodeURIComponent('https://app.example/#/materia/2')));
    assert.ok(links.twitter.includes(encodeURIComponent('Título & cia')));
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
});
