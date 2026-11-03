const { test, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const DB_FILE = path.join(TMP, `sync-${process.pid}.db`);

fs.mkdirSync(TMP, { recursive: true });
process.env.DATABASE_URL = `file:${DB_FILE.replaceAll('\\', '/')}`;

execSync('npx prisma migrate deploy', { cwd: ROOT, stdio: 'pipe', env: process.env });

const { PrismaClient } = require('@prisma/client');
const { createDefaultSources, createPandaScoreSource, createVlrSource } = require('../matchSources');
const { createMatchSync, parseSyncMinutes } = require('../matchSync');

const prisma = new PrismaClient();
const NOW = new Date('2026-11-01T05:00:00Z');
const HOUR = 60 * 60 * 1000;
const TOKEN = 'token-de-teste-que-nao-pode-vazar';

// Só responde às rotas combinadas: qualquer outra vira 404, como numa fonte de verdade.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const address = decodeURIComponent(String(url));
    calls.push({ url: address, headers: init.headers ?? {}, signal: init.signal });
    const route = Object.keys(routes).filter((key) => address.includes(key)).sort((a, b) => b.length - a.length)[0];
    if (!route) return new Response('não encontrado', { status: 404 });
    const value = routes[route];
    if (value instanceof Response) return value.clone();
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { fetch, calls };
}

const team = (name, score = null) => ({ name, score, country: 'br', id: '1', logo: 'https://owcdn.net/img/x.png' });

const vlrUpcoming = (overrides = {}) => ({
  id: '773436',
  teams: [team('Gentle Mates GC'), team('KRÜ BLAZE')],
  status: 'Upcoming',
  event: 'Main Event–Grand Final',
  tournament: 'Game Changers 2026: Championship São Paulo',
  img: 'https://owcdn.net/img/x.png',
  in: '13h 0m',
  timestamp: 1793538000,
  utcDate: 'Sun, 01 Nov 2026 13:00:00 GMT',
  utc: '2026-11-01T13:00:00.000Z',
  ...overrides,
});

const vlrResult = (overrides = {}) => ({
  id: '773444',
  teams: [{ ...team('Shopify Rebellion Gold', '1'), won: false }, { ...team('KRÜ BLAZE', '3'), won: true }],
  status: 'Completed',
  ago: '10h 50m',
  event: 'Main Event–Lower Final',
  tournament: 'Game Changers 2026: Championship São Paulo',
  img: 'https://owcdn.net/img/x.png',
  ...overrides,
});

const vlrDetail = (id, date) => ({ [`/api/v1/matches/${id}`]: { status: 'OK', data: { id, timestamp: Date.parse(date) / 1000 } } });

const vlrFeed = ({ matches = [], results = [], extra = {} }) => ({
  '/api/v1/matches': { status: 'OK', size: matches.length, data: matches },
  '/api/v1/results': { status: 'OK', size: results.length, data: results },
  ...extra,
});

async function vlrMatches(feed) {
  const { fetch } = fakeFetch(vlrFeed(feed));
  return createVlrSource({ fetch }).fetchMatches(NOW);
}

describe('fonte de VALORANT', () => {
  test('traz o resultado com placar, torneio e fase em português', async () => {
    const [match] = await vlrMatches({ results: [vlrResult()] });
    assert.equal(match.externalId, 'vlr:773444');
    assert.equal(match.tournament, 'Game Changers 2026');
    assert.equal(match.stage, 'Championship São Paulo · Final da Chave Inferior');
    assert.equal(match.teamA, 'Shopify Rebellion Gold');
    assert.equal(match.teamB, 'KRÜ BLAZE');
    assert.equal(match.scoreA, 1);
    assert.equal(match.scoreB, 3);
    assert.equal(match.status, 'FINISHED');
  });

  test('traduz as fases que aparecem nos torneios', async () => {
    const stages = [
      ['Main Event–Grand Final', 'Championship São Paulo · Grande Final'],
      ['Main Event–Upper Quarterfinals', 'Championship São Paulo · Quartas da Chave Superior'],
      ['Main Event–Upper Semifinals', 'Championship São Paulo · Semifinal da Chave Superior'],
      ['Main Event–Lower Round 4', 'Championship São Paulo · Chave Inferior, Rodada 4'],
      ['Main Event–Upper Round 1', 'Championship São Paulo · Chave Superior, Rodada 1'],
      ['Group Stage–Round 3', 'Championship São Paulo · Fase de Grupos · Rodada 3'],
      ['Playoffs–Grand Finals', 'Championship São Paulo · Playoffs · Grande Final'],
      ['Playoffs–Upper Finals', 'Championship São Paulo · Playoffs · Final da Chave Superior'],
      ['Playoffs–Lower Finals', 'Championship São Paulo · Playoffs · Final da Chave Inferior'],
    ];
    for (const [event, expected] of stages) {
      const [match] = await vlrMatches({ results: [vlrResult({ event })] });
      assert.equal(match.stage, expected, event);
    }
  });

  test('o resultado usa a data exata da rota de detalhe, mesmo em jogo antigo', async () => {
    const [match] = await vlrMatches({
      results: [vlrResult({ ago: '1mo' })],
      extra: vlrDetail('773444', '2026-09-06T17:00:00Z'),
    });
    assert.equal(match.date.toISOString(), '2026-09-06T17:00:00.000Z');
    assert.equal(match.approximateDate, false);
  });

  test('sem o detalhe, resultado recente fica com a data estimada e marcada como tal', async () => {
    const [match] = await vlrMatches({ results: [vlrResult({ ago: '10h 50m' })] });
    assert.equal(match.date.toISOString(), '2026-10-31T18:10:00.000Z');
    assert.equal(match.approximateDate, true);
  });

  test('sem o detalhe, idade em semanas ou meses não vira data: o jogo fica de fora', async () => {
    for (const ago of ['1w 0d', '1mo', '2mo', '1y']) {
      assert.deepEqual(await vlrMatches({ results: [vlrResult({ ago })] }), [], ago);
    }
  });

  test('detalhe sem data válida, de outro jogo ou no futuro não é aceito', async () => {
    const answers = [
      { id: '773444', timestamp: null },
      { id: '773444', timestamp: 0 },
      { id: '773444', timestamp: 'ontem' },
      { id: '999', timestamp: 1788714000 },
      { id: '773444', timestamp: Date.parse('2026-12-01T00:00:00Z') / 1000 },
    ];
    for (const data of answers) {
      const matches = await vlrMatches({ results: [vlrResult({ ago: '1mo' })], extra: { '/api/v1/matches/773444': { status: 'OK', data } } });
      assert.deepEqual(matches, [], JSON.stringify(data));
    }
  });

  test('guarda a data exata entre as rodadas e tenta de novo só o que falhou', async () => {
    const routes = vlrFeed({
      results: [vlrResult({ id: '1', ago: '1mo' }), vlrResult({ id: '2', ago: '1mo' })],
      extra: { ...vlrDetail('1', '2026-09-06T17:00:00Z'), '/api/v1/matches/2': new Response('fora do ar', { status: 502 }) },
    });
    const { fetch, calls } = fakeFetch(routes);
    const source = createVlrSource({ fetch });
    const first = await source.fetchMatches(NOW);
    assert.deepEqual(first.map((match) => match.externalId), ['vlr:1']);

    Object.assign(routes, vlrDetail('2', '2026-09-05T15:00:00Z'));
    calls.length = 0;
    const second = await source.fetchMatches(NOW);
    assert.deepEqual(second.map((match) => match.externalId), ['vlr:1', 'vlr:2']);
    assert.equal(calls.filter((call) => call.url.endsWith('/matches/1')).length, 0);
    assert.equal(calls.filter((call) => call.url.endsWith('/matches/2')).length, 1);
  });

  test('não passa de 15 resultados por rodada: é o que a tela mostra, e a fonte limita as chamadas', async () => {
    const results = Array.from({ length: 20 }, (_, index) => vlrResult({ id: String(index + 1), ago: '1mo' }));
    const extra = Object.assign({}, ...results.map(({ id }) => vlrDetail(id, '2026-09-06T17:00:00Z')));
    const { fetch, calls } = fakeFetch(vlrFeed({ results, extra }));
    const matches = await createVlrSource({ fetch }).fetchMatches(NOW);
    assert.equal(matches.length, 15);
    assert.deepEqual(matches.map((match) => match.externalId).slice(0, 2), ['vlr:1', 'vlr:2']);
    assert.ok(calls.length <= 30, `${calls.length} chamadas`);
  });

  test('para de ler páginas assim que tem jogos suficientes', async () => {
    const results = Array.from({ length: 15 }, (_, index) => vlrResult({ id: String(index + 1) }));
    const { fetch, calls } = fakeFetch(vlrFeed({ results }));
    await createVlrSource({ fetch }).fetchMatches(NOW);
    assert.equal(calls.filter((call) => call.url.includes('/results?page=')).length, 1);
  });

  test('página funda fora do ar não perde o resto e é lida na rodada seguinte', async () => {
    const routes = vlrFeed({
      results: [vlrResult()],
      extra: { '/api/v1/results?page=3': new Response('fora do ar', { status: 502 }) },
    });
    const { fetch, calls } = fakeFetch(routes);
    const source = createVlrSource({ fetch });
    const first = await source.fetchMatches(NOW);
    assert.deepEqual(first.map((match) => match.externalId), ['vlr:773444']);

    delete routes['/api/v1/results?page=3'];
    calls.length = 0;
    await source.fetchMatches(NOW);
    assert.ok(calls.some((call) => call.url.includes('/results?page=3')), 'tentou a página de novo');
    calls.length = 0;
    await source.fetchMatches(NOW);
    assert.equal(calls.filter((call) => call.url.includes('/results?page=')).length, 1);
  });

  test('a primeira página fora do ar conta como falha da fonte', async () => {
    const { fetch } = fakeFetch(vlrFeed({ extra: { '/api/v1/results?page=1': new Response('fora do ar', { status: 502 }) } }));
    await assert.rejects(() => createVlrSource({ fetch }).fetchMatches(NOW), /502/);
  });

  test('se a fonte mudar de formato, conta como falha em vez de "atualizado" sem dados', async () => {
    const renamed = { id: '1', times: [], situacao: 'Completed' };
    await assert.rejects(() => vlrMatches({ matches: [renamed], results: [renamed] }), /formato/);
  });

  test('período sem jogos acompanhados é sucesso, não falha', async () => {
    assert.deepEqual(await vlrMatches({ results: [vlrResult({ tournament: 'Project Blender 2026' })] }), []);
    assert.deepEqual(await vlrMatches({}), []);
  });

  test('o campo utc da fonte é o horário de Nova York: converte para o horário real', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming()] });
    assert.equal(match.date.toISOString(), '2026-11-01T18:00:00.000Z');
    assert.equal(match.status, 'UPCOMING');
    assert.equal(match.approximateDate, false);
    assert.equal(match.scoreA, null);
    assert.equal(match.scoreB, null);
  });

  test('acerta o horário no dia em que Nova York sai do horário de verão', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming({ utc: '2026-11-01T04:00:00.000Z', in: '4h 0m' })] });
    assert.equal(match.date.toISOString(), '2026-11-01T09:00:00.000Z');
  });

  test('acerta o horário durante o horário de verão de Nova York', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming({ utc: '2026-07-10T15:30:00.000Z', in: '' })] });
    assert.equal(match.date.toISOString(), '2026-07-10T19:30:00.000Z');
  });

  test('se o fuso da fonte mudar, confia em quanto falta para o jogo', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming({ utc: '2026-11-01T13:00:00.000Z', in: '8h 0m' })] });
    assert.equal(match.date.toISOString(), '2026-11-01T13:00:00.000Z');
  });

  test('jogo ao vivo vem com o placar da série, e placar vazio vale zero', async () => {
    const [first, second] = await vlrMatches({
      matches: [
        vlrUpcoming({ status: 'LIVE', in: '', teams: [team('KRÜ BLAZE', '1'), team('Gentle Mates GC', '0')] }),
        vlrUpcoming({ id: '2', status: 'LIVE', in: '' }),
      ],
    });
    assert.equal(first.status, 'LIVE');
    assert.equal(first.scoreA, 1);
    assert.equal(first.scoreB, 0);
    assert.equal(first.approximateDate, true);
    assert.equal(second.scoreA, 0);
    assert.equal(second.scoreB, 0);
  });

  test('jogo sem horário válido nunca vira 1970', async () => {
    const live = await vlrMatches({ matches: [vlrUpcoming({ status: 'LIVE', in: '', utc: null })] });
    assert.deepEqual(live, []);
    const [upcoming] = await vlrMatches({ matches: [vlrUpcoming({ in: '2w 0d', utc: null })] });
    assert.equal(upcoming.date.toISOString(), new Date(NOW.getTime() + 14 * 24 * HOUR).toISOString());
  });

  test('jogo com estado "TBD" na fonte conta como próximo', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming({ status: 'TBD' })] });
    assert.equal(match.status, 'UPCOMING');
  });

  test('time ainda não definido aparece como "A definir"', async () => {
    const [match] = await vlrMatches({ matches: [vlrUpcoming({ teams: [team('TBD'), team('KRÜ BLAZE')] })] });
    assert.equal(match.teamA, 'A definir');
  });

  test('usa os nomes de torneio que o app já mostra', async () => {
    const names = [
      ['Valorant Champions 2026', 'VALORANT Champions 2026'],
      ['Valorant Masters London 2026', 'VALORANT Masters London 2026'],
      ['VCT 2026: Americas Stage 2', 'VCT Américas'],
      ['VCT 2027: Americas Kickoff', 'VCT Américas'],
      ['Game Changers 2026: Brazil Finals', 'Game Changers 2026'],
      ['Game Changers 2026: Americas Last Chance Qualifier', 'Game Changers 2026'],
    ];
    for (const [source, expected] of names) {
      const [match] = await vlrMatches({ results: [vlrResult({ tournament: source })] });
      assert.equal(match?.tournament, expected, source);
    }
  });

  test('ignora torneios fora do que o app acompanha', async () => {
    const others = [
      'VCT 2026: China Threshold',
      'VCT 2026: EMEA Stage 2',
      'VCT 2027: America Kickoff - Brazil Open Qualifier',
      'Project Blender 2026',
      'Spike Series 2026: Convergence EMEA - DACH',
      'Game Changers 2026: EMEA Stage 3',
      'Canadian Intercollegiate Exhibition 2026: Game Changers',
    ];
    for (const tournament of others) {
      assert.deepEqual(await vlrMatches({ results: [vlrResult({ tournament })] }), [], tournament);
    }
  });

  test('descarta linhas malformadas e limpa o texto que vem de fora', async () => {
    const matches = await vlrMatches({
      results: [
        {},
        null,
        vlrResult({ id: '../1' }),
        vlrResult({ id: '10', teams: [team('Só um time', '1')] }),
        vlrResult({ id: '11', teams: [team('A', 'x'), team('B', '1')] }),
        vlrResult({ id: '12', ago: 'ontem' }),
        vlrResult({ id: '13', teams: [team(`Time\u0007\u0000\n${'x'.repeat(200)}`, '2'), team('B', '1')] }),
      ],
    });
    assert.deepEqual(matches.map((match) => match.externalId), ['vlr:13']);
    assert.equal(matches[0].teamA.length <= 60, true);
    assert.doesNotMatch(matches[0].teamA, /\p{Cc}/u);
  });

  test('resposta que não é uma lista conta como falha da fonte', async () => {
    const { fetch } = fakeFetch({ '/api/v1/matches': { status: 'erro' }, '/api/v1/results': { data: [] } });
    await assert.rejects(() => createVlrSource({ fetch }).fetchMatches(NOW));
  });

  test('busca várias páginas só na primeira rodada e usa tempo limite', async () => {
    const { fetch, calls } = fakeFetch({ '/api/v1/matches': { data: [] }, '/api/v1/results': { data: [] } });
    const source = createVlrSource({ fetch });
    await source.fetchMatches(NOW);
    const firstRun = calls.filter((call) => call.url.includes('/results')).length;
    assert.ok(firstRun > 1, `primeira rodada leu ${firstRun} página(s)`);
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
    calls.length = 0;
    await source.fetchMatches(NOW);
    assert.equal(calls.filter((call) => call.url.includes('/results')).length, 1);
  });

  test('uma rodada inicial que falha repete as várias páginas', async () => {
    const routes = { '/api/v1/matches': { data: [] }, '/api/v1/results': new Response('fora do ar', { status: 502 }) };
    const { fetch, calls } = fakeFetch(routes);
    const source = createVlrSource({ fetch });
    await assert.rejects(() => source.fetchMatches(NOW));
    routes['/api/v1/results'] = { data: [] };
    calls.length = 0;
    await source.fetchMatches(NOW);
    assert.ok(calls.filter((call) => call.url.includes('/results')).length > 1);
  });
});

const CBLOL = { id: 302, name: 'CBLOL', slug: 'league-of-legends-cblol-brazil' };
const WORLDS = { id: 297, name: 'Worlds', slug: 'league-of-legends-world-championship' };

const pandaMatch = (overrides = {}) => ({
  id: 1455226,
  begin_at: '2026-10-31T17:00:00Z',
  scheduled_at: '2026-10-31T17:00:00Z',
  league: CBLOL,
  league_id: CBLOL.id,
  name: 'Upper bracket final: LOUD vs FURIA',
  opponents: [
    { type: 'Team', opponent: { id: 10, name: 'LOUD', acronym: 'LLL' } },
    { type: 'Team', opponent: { id: 20, name: 'FURIA', acronym: 'FUR' } },
  ],
  results: [{ score: 3, team_id: 10 }, { score: 1, team_id: 20 }],
  serie: { id: 1, full_name: 'Split 3 2026', year: 2026 },
  status: 'finished',
  tournament: { id: 1, name: 'Playoffs' },
  winner_id: 10,
  ...overrides,
});

function pandaFetch({ past = [], running = [], upcoming = [], leagues = {} } = {}) {
  return fakeFetch({
    '/lol/leagues?search[name]=CBLOL': leagues.CBLOL ?? [CBLOL, { id: 900, name: 'CBLOL Academy' }],
    '/lol/leagues?search[name]=World': leagues.World ?? [WORLDS],
    '/lol/matches/past': past,
    '/lol/matches/running': running,
    '/lol/matches/upcoming': upcoming,
  });
}

describe('fonte de League of Legends', () => {
  test('envia o token no cabeçalho, nunca no endereço', async () => {
    const { fetch, calls } = pandaFetch();
    await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(call.url.includes(TOKEN), false);
      assert.ok(call.signal instanceof AbortSignal);
    }
  });

  test('busca só as ligas acompanhadas e guarda os ids entre as rodadas', async () => {
    const { fetch, calls } = pandaFetch();
    const source = createPandaScoreSource({ token: TOKEN, fetch });
    await source.fetchMatches(NOW);
    const lists = calls.filter((call) => call.url.includes('/lol/matches/'));
    assert.equal(lists.length, 3);
    for (const call of lists) assert.ok(call.url.includes('filter[league_id]=302,297'), call.url);
    calls.length = 0;
    await source.fetchMatches(NOW);
    assert.equal(calls.filter((call) => call.url.includes('/lol/leagues')).length, 0);
  });

  test('resultado encerrado traz placar de cada time pelo id', async () => {
    const { fetch } = pandaFetch({
      past: [pandaMatch({ results: [{ score: 1, team_id: 20 }, { score: 3, team_id: 10 }] })],
    });
    const [match] = await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    assert.equal(match.externalId, 'pandascore:1455226');
    assert.equal(match.tournament, 'CBLOL');
    assert.equal(match.stage, 'Playoffs · Final da Chave Superior');
    assert.equal(match.teamA, 'LOUD');
    assert.equal(match.teamB, 'FURIA');
    assert.equal(match.scoreA, 3);
    assert.equal(match.scoreB, 1);
    assert.equal(match.status, 'FINISHED');
    assert.equal(match.date.toISOString(), '2026-10-31T17:00:00.000Z');
    assert.equal(match.approximateDate, false);
  });

  test('Worlds leva o ano no nome, como no resto do app', async () => {
    const { fetch } = pandaFetch({ past: [pandaMatch({ league: WORLDS, league_id: WORLDS.id })] });
    const [match] = await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    assert.equal(match.tournament, 'Worlds 2026');
  });

  test('traduz o estado de cada jogo', async () => {
    const { fetch } = pandaFetch({
      past: [pandaMatch({ id: 2, status: 'canceled', results: [] }), pandaMatch({ id: 3, status: 'postponed', results: [] })],
      running: [pandaMatch({ id: 4, status: 'running', results: [{ score: 1, team_id: 10 }, { score: 0, team_id: 20 }] })],
      upcoming: [pandaMatch({ id: 5, status: 'not_started', results: [], begin_at: null, scheduled_at: '2026-11-05T20:00:00Z' })],
    });
    const matches = await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    const statusOf = (id) => matches.find((match) => match.externalId === `pandascore:${id}`)?.status;
    assert.equal(statusOf(2), 'CANCELED');
    assert.equal(statusOf(3), 'CANCELED');
    assert.equal(statusOf(4), 'LIVE');
    assert.equal(statusOf(5), 'UPCOMING');
    const upcoming = matches.find((match) => match.externalId === 'pandascore:5');
    assert.equal(upcoming.date.toISOString(), '2026-11-05T20:00:00.000Z');
    assert.equal(upcoming.scoreA, null);
  });

  test('final com times a definir mantém a data e a fase', async () => {
    const { fetch } = pandaFetch({
      upcoming: [pandaMatch({ status: 'not_started', name: 'Grand final: TBD vs TBD', opponents: [], results: [] })],
    });
    const [match] = await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    assert.equal(match.teamA, 'A definir');
    assert.equal(match.teamB, 'A definir');
    assert.equal(match.stage, 'Playoffs · Grande Final');
  });

  test('descarta encerrado sem placar e jogo sem data', async () => {
    const { fetch } = pandaFetch({
      past: [pandaMatch({ id: 6, results: [] }), pandaMatch({ id: 7, begin_at: null, scheduled_at: null }), null],
    });
    assert.deepEqual(await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW), []);
  });

  test('token recusado vira erro sem repetir o token', async () => {
    const { fetch } = fakeFetch({ '/lol/leagues': new Response('{"error":"Token is invalid"}', { status: 401 }) });
    await assert.rejects(
      () => createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW),
      (error) => /401/.test(error.message) && !error.message.includes(TOKEN),
    );
  });

  test('sem nenhuma liga encontrada a fonte falha, em vez de buscar a lista inteira', async () => {
    const { fetch, calls } = pandaFetch({ leagues: { CBLOL: [], World: [] } });
    await assert.rejects(() => createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW));
    assert.equal(calls.filter((call) => call.url.includes('/lol/matches/')).length, 0);
  });

  test('liga que só começa com "World" não vira Worlds', async () => {
    const { fetch, calls } = pandaFetch({ leagues: { World: [WORLDS, { id: 500, name: 'World Cyber Arena' }] } });
    await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    const list = calls.find((call) => call.url.includes('/lol/matches/past'));
    assert.ok(list.url.includes('filter[league_id]=302,297'), list.url);
  });

  test('não deixa jogo sem data ocupar a lista de próximos', async () => {
    const { fetch, calls } = pandaFetch();
    await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    const upcoming = calls.find((call) => call.url.includes('/lol/matches/upcoming'));
    assert.ok(upcoming.url.includes('filter[unscheduled]=false'), upcoming.url);
  });

  test('jogo remarcado usa o novo horário oficial; jogo já começado usa o início real', async () => {
    const { fetch } = pandaFetch({
      upcoming: [pandaMatch({ id: 8, status: 'not_started', results: [], begin_at: '2026-11-05T20:00:00Z', scheduled_at: '2026-11-07T20:00:00Z' })],
      past: [pandaMatch({ id: 9, begin_at: '2026-10-31T18:30:00Z', scheduled_at: '2026-10-31T17:00:00Z' })],
    });
    const matches = await createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW);
    const dateOf = (id) => matches.find((match) => match.externalId === `pandascore:${id}`).date.toISOString();
    assert.equal(dateOf(8), '2026-11-07T20:00:00.000Z');
    assert.equal(dateOf(9), '2026-10-31T18:30:00.000Z');
  });

  test('resposta que não é lista conta como falha da fonte', async () => {
    const { fetch } = pandaFetch({ past: { erro: 'formato novo' } });
    await assert.rejects(() => createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW), /formato/);
  });

  test('se nenhuma linha puder ser lida, conta como falha em vez de "atualizado" sem dados', async () => {
    const { fetch } = pandaFetch({ past: [{ id: 'novo-formato' }, { id: 2, situacao: 'encerrado' }] });
    await assert.rejects(() => createPandaScoreSource({ token: TOKEN, fetch }).fetchMatches(NOW), /formato/);
  });

  test('token com quebra de linha falha sem chamar a API nem repetir o token', async () => {
    const { fetch, calls } = pandaFetch();
    await assert.rejects(
      () => createPandaScoreSource({ token: 'parte-secreta-1\nparte-secreta-2', fetch }).fetchMatches(NOW),
      (error) => /PANDASCORE_TOKEN/.test(error.message) && !error.message.includes('parte-secreta'),
    );
    assert.equal(calls.length, 0);
  });
});

describe('fontes usadas', () => {
  test('sem token só VALORANT atualiza', () => {
    assert.deepEqual(createDefaultSources({}).map((source) => source.game), ['VALORANT']);
    assert.deepEqual(createDefaultSources({ pandascoreToken: '  ' }).map((source) => source.game), ['VALORANT']);
  });

  test('com token entra League of Legends', () => {
    assert.deepEqual(createDefaultSources({ pandascoreToken: TOKEN }).map((source) => source.game), ['League of Legends', 'VALORANT']);
  });
});

const incoming = (overrides = {}) => ({
  externalId: 'teste:1',
  tournament: 'VCT Américas',
  stage: 'Final',
  date: new Date('2026-10-31T20:00:00Z'),
  approximateDate: false,
  teamA: 'LOUD',
  teamB: 'NRG',
  scoreA: null,
  scoreB: null,
  status: 'UPCOMING',
  ...overrides,
});

const sourceOf = (lists, { game = 'VALORANT', name = 'teste' } = {}) => {
  let run = 0;
  const source = {
    name,
    game,
    calls: 0,
    fetchMatches: async () => {
      source.calls += 1;
      const list = lists[Math.min(run, lists.length - 1)];
      run += 1;
      if (list instanceof Error) throw list;
      return list;
    },
  };
  return source;
};

const silentLogger = () => {
  const lines = [];
  return { lines, error: (...args) => lines.push(args.join(' ')), log: (...args) => lines.push(args.join(' ')) };
};

function syncWith(sources, overrides = {}) {
  return createMatchSync({ prisma, sources, now: () => NOW, logger: silentLogger(), ...overrides });
}

describe('sincronização', () => {
  beforeEach(async () => {
    await prisma.matchReminder.deleteMany();
    await prisma.match.deleteMany();
  });

  test('grava o jogo e, nas rodadas seguintes, atualiza a mesma linha', async () => {
    const sync = syncWith([sourceOf([
      [incoming()],
      [incoming({ status: 'LIVE', scoreA: 1, scoreB: 0, approximateDate: true })],
      [incoming({ status: 'FINISHED', scoreA: 2, scoreB: 1, approximateDate: true })],
    ])]);
    await sync.run();
    const created = await prisma.match.findUnique({ where: { externalId: 'teste:1' } });
    assert.equal(created.status, 'UPCOMING');
    assert.equal(created.syncedAt.toISOString(), NOW.toISOString());
    await sync.run();
    assert.equal((await prisma.match.findUnique({ where: { id: created.id } })).status, 'LIVE');
    await sync.run();
    const finished = await prisma.match.findUnique({ where: { id: created.id } });
    assert.equal(finished.status, 'FINISHED');
    assert.equal(finished.scoreA, 2);
    assert.equal(await prisma.match.count(), 1);
  });

  test('não troca a data exata por uma estimativa', async () => {
    const sync = syncWith([sourceOf([
      [incoming()],
      [incoming({ status: 'FINISHED', scoreA: 2, scoreB: 1, date: new Date('2026-10-31T23:40:00Z'), approximateDate: true })],
    ])]);
    await sync.run();
    await sync.run();
    const match = await prisma.match.findUnique({ where: { externalId: 'teste:1' } });
    assert.equal(match.date.toISOString(), '2026-10-31T20:00:00.000Z');
  });

  test('adiando um jogo, a nova data exata substitui a antiga', async () => {
    const sync = syncWith([sourceOf([[incoming()], [incoming({ date: new Date('2026-11-03T20:00:00Z') })]])]);
    await sync.run();
    await sync.run();
    const match = await prisma.match.findUnique({ where: { externalId: 'teste:1' } });
    assert.equal(match.date.toISOString(), '2026-11-03T20:00:00.000Z');
  });

  test('lembrete continua ligado ao jogo depois das atualizações', async () => {
    const sync = syncWith([sourceOf([[incoming()], [incoming({ status: 'LIVE', scoreA: 0, scoreB: 0 })]])]);
    await sync.run();
    const match = await prisma.match.findUnique({ where: { externalId: 'teste:1' } });
    const user = await prisma.user.create({
      data: { name: 'Pessoa', nickname: `p_${Date.now()}`, email: `p${Date.now()}@example.com`, password: 'x', birthDate: new Date('2000-01-01') },
    });
    await prisma.matchReminder.create({ data: { userId: user.id, matchId: match.id } });
    await sync.run();
    assert.equal(await prisma.matchReminder.count({ where: { matchId: match.id } }), 1);
    await prisma.user.delete({ where: { id: user.id } });
  });

  test('jogo já cadastrado à mão é assumido pela fonte, sem duplicar', async () => {
    const manual = await prisma.match.create({
      data: { id: 'cblol-manual', tournament: 'CBLOL', stage: 'Grande Final', date: new Date('2026-10-10T16:00:00Z'), teamA: 'LOS', teamB: 'FURIA', scoreA: 3, scoreB: 2, status: 'FINISHED' },
    });
    const sync = syncWith([sourceOf([[incoming({
      externalId: 'pandascore:9',
      tournament: 'CBLOL',
      date: new Date('2026-10-10T17:30:00Z'),
      approximateDate: true,
      teamA: 'FURIA Esports',
      teamB: 'LOS Grandes',
      scoreA: 2,
      scoreB: 3,
      status: 'FINISHED',
    })]], { game: 'League of Legends' })]);
    await sync.run();
    assert.equal(await prisma.match.count(), 1);
    const match = await prisma.match.findUnique({ where: { id: manual.id } });
    assert.equal(match.externalId, 'pandascore:9');
    assert.equal(match.teamA, 'FURIA Esports');
    assert.equal(match.scoreB, 3);
    assert.equal(match.date.toISOString(), '2026-10-10T16:00:00.000Z');
  });

  test('a carga inicial não recria nem sobrescreve o jogo assumido pela fonte', async () => {
    const { seed } = require('../prisma/seed');
    await seed(prisma, {});
    const before = await prisma.match.count();
    const sync = syncWith([sourceOf([[incoming({
      externalId: 'pandascore:10',
      tournament: 'CBLOL',
      date: new Date('2026-10-10T16:00:00Z'),
      teamA: 'LOS',
      teamB: 'FURIA',
      scoreA: 3,
      scoreB: 1,
      status: 'FINISHED',
    })]], { game: 'League of Legends' })]);
    await sync.run();
    await seed(prisma, {});
    assert.equal(await prisma.match.count(), before);
    assert.equal((await prisma.match.findUnique({ where: { externalId: 'pandascore:10' } })).scoreB, 1);
  });

  test('times iguais em outro jogo ou em outra data não são o mesmo jogo', async () => {
    await prisma.match.create({
      data: { tournament: 'CBLOL', date: new Date('2026-10-31T20:00:00Z'), teamA: 'LOUD', teamB: 'NRG', scoreA: 3, scoreB: 0, status: 'FINISHED' },
    });
    await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date('2026-10-20T20:00:00Z'), teamA: 'LOUD', teamB: 'NRG', scoreA: 2, scoreB: 0, status: 'FINISHED' },
    });
    await syncWith([sourceOf([[incoming()]])]).run();
    assert.equal(await prisma.match.count(), 3);
  });

  test('times de nome parecido em outro torneio não assumem o jogo cadastrado', async () => {
    const manual = await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date('2026-11-10T20:00:00Z'), teamA: 'MIBR', teamB: 'LOUD', status: 'UPCOMING' },
    });
    await syncWith([sourceOf([[incoming({
      externalId: 'vlr:gc',
      tournament: 'Game Changers 2026',
      date: new Date('2026-11-10T22:00:00Z'),
      teamA: 'LOUD GC',
      teamB: 'MIBR GC',
    })]])]).run();
    assert.equal(await prisma.match.count(), 2);
    assert.equal((await prisma.match.findUnique({ where: { id: manual.id } })).externalId, null);
  });

  test('o nome do torneio pode trazer o ano, sem deixar de ser o mesmo', async () => {
    const manual = await prisma.match.create({
      data: { tournament: 'CBLOL 2026', date: new Date('2026-11-10T20:00:00Z'), teamA: 'LOUD', teamB: 'FURIA', status: 'UPCOMING' },
    });
    await syncWith([sourceOf([[incoming({ tournament: 'CBLOL', date: new Date('2026-11-10T20:00:00Z'), teamA: 'LOUD', teamB: 'FURIA' })]])]).run();
    assert.equal(await prisma.match.count(), 1);
    assert.equal((await prisma.match.findUnique({ where: { id: manual.id } })).externalId, 'teste:1');
  });

  test('entre dois jogos cadastrados, assume o de data mais próxima', async () => {
    const data = { tournament: 'VCT Américas', teamA: 'LOUD', teamB: 'NRG', status: 'UPCOMING' };
    const earlier = await prisma.match.create({ data: { ...data, date: new Date('2026-11-10T04:00:00Z') } });
    const closer = await prisma.match.create({ data: { ...data, date: new Date('2026-11-10T18:00:00Z') } });
    await syncWith([sourceOf([[incoming({ date: new Date('2026-11-10T20:00:00Z') })]])]).run();
    assert.equal((await prisma.match.findUnique({ where: { id: closer.id } })).externalId, 'teste:1');
    assert.equal((await prisma.match.findUnique({ where: { id: earlier.id } })).externalId, null);
  });

  test('revanche no dia anterior não leva o lembrete do jogo cadastrado', async () => {
    const manual = await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date('2026-11-10T20:00:00Z'), teamA: 'LOUD', teamB: 'FURIA', status: 'UPCOMING' },
    });
    const user = await prisma.user.create({
      data: { name: 'Pessoa', nickname: `r_${Date.now()}`, email: `r${Date.now()}@example.com`, password: 'x', birthDate: new Date('2000-01-01') },
    });
    await prisma.matchReminder.create({ data: { userId: user.id, matchId: manual.id } });
    await syncWith([sourceOf([[
      incoming({ externalId: 'teste:semifinal', date: new Date('2026-11-09T20:00:00Z'), teamA: 'LOUD', teamB: 'FURIA', status: 'FINISHED', scoreA: 2, scoreB: 0 }),
      incoming({ externalId: 'teste:final', date: new Date('2026-11-10T20:00:00Z'), teamA: 'LOUD', teamB: 'FURIA' }),
    ]])]).run();
    const final = await prisma.match.findUnique({ where: { externalId: 'teste:final' } });
    assert.equal(final.id, manual.id);
    assert.equal(await prisma.matchReminder.count({ where: { matchId: final.id } }), 1);
    await prisma.user.delete({ where: { id: user.id } });
  });

  test('times a definir nunca assumem um jogo cadastrado', async () => {
    await prisma.match.create({
      data: { tournament: 'VCT Américas', date: new Date('2026-10-31T20:00:00Z'), teamA: 'A definir', teamB: 'A definir', status: 'UPCOMING' },
    });
    await syncWith([sourceOf([[incoming({ teamA: 'A definir', teamB: 'A definir' })]])]).run();
    assert.equal(await prisma.match.count(), 2);
  });

  test('uma fonte fora do ar não afeta a outra nem apaga o que já foi gravado', async () => {
    const logger = silentLogger();
    const broken = sourceOf([[incoming({ externalId: 'quebrada:1' })], new Error('HTTP 502')], { game: 'League of Legends', name: 'quebrada' });
    const working = sourceOf([[incoming({ externalId: 'boa:1', teamA: 'Time C', teamB: 'Time D' })]], { name: 'boa' });
    const sync = syncWith([broken, working], { logger });
    await sync.run();
    await assert.doesNotReject(() => sync.run());
    assert.equal(await prisma.match.count(), 2);
    assert.ok(logger.lines.some((line) => line.includes('quebrada') && line.includes('502')));
  });

  test('o que uma fonte grava com erro em um jogo não derruba os outros', async () => {
    const logger = silentLogger();
    const sync = syncWith([sourceOf([[
      incoming({ externalId: 'teste:ruim', date: new Date('data inválida') }),
      incoming({ externalId: 'teste:bom', teamA: 'Time C', teamB: 'Time D' }),
    ]])], { logger });
    await sync.run();
    assert.ok(await prisma.match.findUnique({ where: { externalId: 'teste:bom' } }));
    assert.ok(logger.lines.length > 0);
  });

  test('duas rodadas ao mesmo tempo viram uma só', async () => {
    const source = sourceOf([[incoming()]]);
    const sync = syncWith([source]);
    await Promise.all([sync.run(), sync.run()]);
    assert.equal(source.calls, 1);
    assert.equal(await prisma.match.count(), 1);
  });

  test('status conta só o que atualizou de fato, pela fonte mais atrasada', async () => {
    let current = NOW;
    const flaky = sourceOf([[], new Error('HTTP 500')], { game: 'League of Legends', name: 'instavel' });
    const stable = sourceOf([[]]);
    const never = sourceOf([new Error('HTTP 401')], { game: 'Outro', name: 'nunca' });
    const sync = syncWith([flaky, stable, never], { now: () => current });
    assert.deepEqual(sync.status(), { updatedAt: null, games: [] });
    await sync.run();
    assert.deepEqual(sync.status(), { updatedAt: NOW, games: ['League of Legends', 'VALORANT'] });
    current = new Date(NOW.getTime() + HOUR);
    await sync.run();
    assert.deepEqual(sync.status(), { updatedAt: NOW, games: ['League of Legends', 'VALORANT'] });
  });

  test('o registro traz o motivo de verdade de uma falha de rede', async () => {
    const logger = silentLogger();
    const offline = new Error('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    await syncWith([sourceOf([offline], { name: 'fora' })], { logger }).run();
    assert.ok(logger.lines.some((line) => line.includes('fora') && line.includes('ETIMEDOUT')));
  });

  test('o token nunca aparece no registro de erros', async () => {
    const logger = silentLogger();
    const { fetch } = fakeFetch({ '/lol/leagues': new Response('{"error":"Token is invalid"}', { status: 401 }) });
    await syncWith([createPandaScoreSource({ token: TOKEN, fetch })], { logger }).run();
    assert.ok(logger.lines.length > 0);
    assert.equal(logger.lines.join(' ').includes(TOKEN), false);
  });

  test('start roda na hora e repete a cada intervalo; stop e zero minutos param', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const settle = () => new Promise((resolve) => { setImmediate(resolve); });
    const source = sourceOf([[]]);

    syncWith([source]).start(0);
    await settle();
    assert.equal(source.calls, 0);

    const sync = syncWith([source]);
    sync.start(5);
    await settle();
    assert.equal(source.calls, 1);
    t.mock.timers.tick(5 * 60 * 1000);
    await settle();
    assert.equal(source.calls, 2);
    sync.stop();
    t.mock.timers.tick(5 * 60 * 1000);
    await settle();
    assert.equal(source.calls, 2);
  });
});

describe('intervalo da atualização', () => {
  test('vazio usa o padrão, e zero desliga', () => {
    assert.equal(parseSyncMinutes(undefined), 5);
    assert.equal(parseSyncMinutes(''), 5);
    assert.equal(parseSyncMinutes('0'), 0);
    assert.equal(parseSyncMinutes('10'), 10);
  });

  test('valor absurdo não estoura o relógio nem esconde o "Ao vivo": volta ao padrão', () => {
    for (const value of ['100000', '60', '16', '-1', '1.5', 'abc']) {
      assert.equal(parseSyncMinutes(value), 5, value);
    }
  });
});

after(async () => {
  await prisma.$disconnect();
  for (const suffix of ['', '-journal']) fs.rmSync(DB_FILE + suffix, { force: true });
});
