// De onde vêm os jogos: cada fonte devolve a lista no formato da tabela Match.
// O que chega de fora é conferido campo a campo: linha estranha é descartada, não gravada.

const REQUEST_TIMEOUT_MS = 15000;
const TO_BE_DEFINED = 'A definir';
const MAX_TEAM_LENGTH = 60;
const MAX_TEXT_LENGTH = 80;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DURATION_UNITS = { y: 365 * DAY, mo: 30 * DAY, w: 7 * DAY, d: DAY, h: HOUR, m: MINUTE };

const cleanText = (value, maxLength = MAX_TEXT_LENGTH) => String(value ?? '')
  .replace(/\p{Cc}/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const isValidDate = (date) => date instanceof Date && !Number.isNaN(date.getTime());

const STAGE_TERMS = [
  [/grand finals?/gi, 'Grande Final'],
  [/upper(?: bracket)? finals?/gi, 'Final da Chave Superior'],
  [/lower(?: bracket)? finals?/gi, 'Final da Chave Inferior'],
  [/upper(?: bracket)? semi-?finals?/gi, 'Semifinal da Chave Superior'],
  [/lower(?: bracket)? semi-?finals?/gi, 'Semifinal da Chave Inferior'],
  [/upper(?: bracket)? quarter-?finals?/gi, 'Quartas da Chave Superior'],
  [/lower(?: bracket)? quarter-?finals?/gi, 'Quartas da Chave Inferior'],
  [/upper(?: bracket)? round (\d+)/gi, 'Chave Superior, Rodada $1'],
  [/lower(?: bracket)? round (\d+)/gi, 'Chave Inferior, Rodada $1'],
  [/semi-?finals?/gi, 'Semifinal'],
  [/quarter-?finals?/gi, 'Quartas de Final'],
  [/group stage/gi, 'Fase de Grupos'],
  [/regular season/gi, 'Temporada Regular'],
  [/\bround (\d+)/gi, 'Rodada $1'],
  [/\bweek (\d+)/gi, 'Semana $1'],
  [/\bday (\d+)/gi, 'Dia $1'],
];

const translateStage = (text) => STAGE_TERMS.reduce((stage, [term, label]) => stage.replace(term, label), text);

function buildStage(parts) {
  const stage = parts.map((part) => cleanText(part)).filter(Boolean).map(translateStage).join(' · ');
  return stage.slice(0, MAX_TEXT_LENGTH) || null;
}

async function getJson(fetch, url, label, headers = {}) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${label} respondeu ${response.status}`);
  return response.json();
}

// ---------- VALORANT: vlresports, projeto aberto que lê o site vlr.gg. Não pede chave. ----------
const VLR_API = 'https://vlr.orlandomm.net/api/v1';
// A tela mostra os 15 mais recentes. Não adianta guardar mais, e cada um pode custar uma busca de detalhe.
const VLR_MAX_RESULTS = 15;
// Na primeira rodada, volta mais no tempo para não começar só com os jogos do último dia.
const VLR_FIRST_RUN_PAGES = 4;

// Só o que interessa ao público do app: Américas, torneios internacionais e Game Changers do Brasil.
const VLR_TOURNAMENTS = [
  { pattern: /^valorant champions (\d{4})/i, name: (found) => `VALORANT Champions ${found[1]}` },
  { pattern: /^valorant masters (.+)$/i, name: (found) => `VALORANT Masters ${found[1]}` },
  { pattern: /^vct \d{4}: americas (.+)$/i, name: () => 'VCT Américas', stage: (found) => found[1] },
  { pattern: /^game changers (\d{4}): ((?:championship|brazil|americas).*)$/i, name: (found) => `Game Changers ${found[1]}`, stage: (found) => found[2] },
];

function parseDuration(text) {
  let total = 0;
  for (const [, amount, unit] of String(text ?? '').matchAll(/(\d+)\s*(mo|y|w|d|h|m)/g)) {
    total += Number(amount) * DURATION_UNITS[unit];
  }
  return total > 0 ? total : null;
}

// "1w 0d" ou "1mo" podem errar por dias ou semanas; "3d 5h" erra por menos de uma hora.
const isCoarseDuration = (text) => /\d\s*(?:w|mo|y)/.test(String(text ?? ''));

const roundToFiveMinutes = (time) => new Date(Math.round(time / (5 * MINUTE)) * 5 * MINUTE);

// Diferença do relógio de Nova York para o UTC naquele instante, em milissegundos.
function newYorkOffset(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const wallClock = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
  return wallClock - Math.floor(date.getTime() / MINUTE) * MINUTE;
}

// A fonte rotula como UTC o horário que o site mostra, que é o de Nova York.
// São duas passagens porque a troca de horário de verão pode cair entre o rótulo e o horário real.
function newYorkToUtc(labeled) {
  const firstGuess = new Date(labeled.getTime() - newYorkOffset(labeled));
  return new Date(labeled.getTime() - newYorkOffset(firstGuess));
}

function vlrScheduledDate(row, now) {
  const remaining = parseDuration(row.in);
  const estimated = remaining === null ? null : roundToFiveMinutes(now.getTime() + remaining);
  // A fonte manda null quando não entende a data, e new Date(null) seria 1970.
  const labeled = new Date(row.utc ?? NaN);
  if (!isValidDate(labeled)) return estimated;
  const converted = newYorkToUtc(labeled);
  // Com semanas no prazo a estimativa é vaga demais para desconfiar; nos outros casos, ela é a prova do fuso.
  if (estimated && !isCoarseDuration(row.in) && Math.abs(converted.getTime() - estimated.getTime()) > 2 * HOUR) return estimated;
  return converted;
}

function vlrTeamName(team) {
  const name = cleanText(team?.name, MAX_TEAM_LENGTH);
  return /^tbd$/i.test(name) ? TO_BE_DEFINED : name;
}

function vlrScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isInteger(score) && score >= 0 && score < 100 ? score : undefined;
}

const isVlrRow = (row) => /^\d+$/.test(String(row?.id)) && Array.isArray(row.teams) && typeof row.status === 'string';

function vlrMatch(row, now) {
  if (!isVlrRow(row) || row.teams.length !== 2) return null;
  const tournament = cleanText(row.tournament);
  const rule = VLR_TOURNAMENTS.find(({ pattern }) => pattern.test(tournament));
  if (!rule) return null;
  const found = tournament.match(rule.pattern);

  const [teamA, teamB] = row.teams.map(vlrTeamName);
  if (!teamA || !teamB) return null;

  const [first, second] = row.teams.map((team) => vlrScore(team?.score));
  if (first === undefined || second === undefined) return null;

  const base = {
    externalId: `vlr:${row.id}`,
    tournament: rule.name(found),
    stage: buildStage([rule.stage?.(found), ...cleanText(row.event).split(/\s*–\s*/).filter((part) => !/^main event$/i.test(part))]),
    teamA,
    teamB,
  };

  const state = cleanText(row.status).toLowerCase();
  if (state === 'completed') {
    if (first === null || second === null) return null;
    // O resultado só informa há quanto tempo foi. A data exata vem depois, da rota de detalhe;
    // sem ela, idade longa não vira data, porque um jogo de setembro apareceria em outubro.
    const age = isCoarseDuration(row.ago) ? null : parseDuration(row.ago);
    const date = age === null ? null : roundToFiveMinutes(now.getTime() - age);
    return { ...base, status: 'FINISHED', scoreA: first, scoreB: second, date, approximateDate: true };
  }
  const date = vlrScheduledDate(row, now);
  if (!isValidDate(date)) return null;
  if (state === 'live') return { ...base, status: 'LIVE', scoreA: first ?? 0, scoreB: second ?? 0, date, approximateDate: true };
  if (state === 'upcoming' || state === 'tbd') return { ...base, status: 'UPCOMING', scoreA: null, scoreB: null, date, approximateDate: false };
  return null;
}

async function getVlrList(fetch, path) {
  const body = await getJson(fetch, `${VLR_API}${path}`, 'vlresports');
  if (!Array.isArray(body?.data)) throw new Error('vlresports respondeu num formato inesperado');
  return body.data;
}

function createVlrSource({ fetch = globalThis.fetch } = {}) {
  let needsHistory = true;
  const exactDates = new Map();

  async function findExactDate(id, now) {
    if (exactDates.has(id)) return exactDates.get(id);
    try {
      const { data } = await getJson(fetch, `${VLR_API}/matches/${id}`, 'vlresports');
      const date = new Date(data.timestamp * 1000);
      if (String(data.id) !== id || !Number.isInteger(data.timestamp) || data.timestamp <= 0 || date > now) return null;
      exactDates.set(id, date);
      return date;
    } catch {
      // Sem o detalhe, a rodada segue, e a próxima tenta de novo.
      return null;
    }
  }

  async function readResults(now) {
    const rows = [];
    // Um jogo pode vir duas vezes: quando entra um resultado novo, a lista anda entre uma página e outra.
    const results = new Map();
    let readAllPages = true;
    const pages = needsHistory ? VLR_FIRST_RUN_PAGES : 1;
    for (let page = 1; page <= pages && results.size < VLR_MAX_RESULTS; page += 1) {
      let list;
      try {
        list = await getVlrList(fetch, `/results?page=${page}`);
      } catch (error) {
        if (page === 1) throw error;
        // Página funda fora do ar não invalida o que já foi lido: a próxima rodada volta a buscá-la.
        readAllPages = false;
        break;
      }
      rows.push(...list);
      for (const match of list.map((row) => vlrMatch(row, now))) {
        if (match?.status === 'FINISHED') results.set(match.externalId, match);
      }
    }
    needsHistory = !readAllPages;
    return { rows, results: [...results.values()].slice(0, VLR_MAX_RESULTS) };
  }

  return {
    name: 'vlresports',
    game: 'VALORANT',
    async fetchMatches(now) {
      const scheduled = await getVlrList(fetch, '/matches');
      const { rows, results } = await readResults(now);
      // Lista cheia sem nenhuma linha reconhecível é mudança de formato, não período sem jogos.
      const all = [...scheduled, ...rows];
      if (all.length > 0 && !all.some(isVlrRow)) throw new Error('vlresports respondeu num formato inesperado');

      const finished = [];
      for (const match of results) {
        const date = await findExactDate(match.externalId.replace('vlr:', ''), now);
        if (date) finished.push({ ...match, date, approximateDate: false });
        else if (match.date) finished.push(match);
      }
      const upcoming = scheduled.map((row) => vlrMatch(row, now)).filter((match) => match && match.status !== 'FINISHED');
      // Na hora em que o jogo acaba, ele pode estar nas duas listas: o resultado vale mais.
      return [...new Map([...upcoming, ...finished].map((match) => [match.externalId, match])).values()];
    },
  };
}

// ---------- League of Legends: PandaScore, API oficial com plano gratuito. Pede token. ----------
const PANDASCORE_API = 'https://api.pandascore.co';
const PANDASCORE_PAGE_SIZE = 30;

const LOL_LEAGUES = [
  { search: 'CBLOL', pattern: /^cblol\b(?!.*academy)/i, name: () => 'CBLOL' },
  { search: 'World', pattern: /^(?:worlds|world championship)\b/i, name: (row) => (row.serie?.year ? `Worlds ${row.serie.year}` : 'Worlds') },
];

const PANDASCORE_STATUS = { not_started: 'UPCOMING', running: 'LIVE', finished: 'FINISHED', canceled: 'CANCELED', postponed: 'CANCELED' };

const isPandaScoreRow = (row) => Number.isInteger(row?.id) && Object.hasOwn(PANDASCORE_STATUS, row.status);

function pandaScoreMatch(row, namesByLeague) {
  if (!isPandaScoreRow(row)) return null;
  const rule = namesByLeague.get(row.league_id ?? row.league?.id);
  const status = PANDASCORE_STATUS[row.status];
  if (!rule) return null;

  // Antes de começar, o horário oficial é o scheduled_at; depois, o begin_at é o início real.
  const moments = status === 'UPCOMING' ? [row.scheduled_at, row.begin_at] : [row.begin_at, row.scheduled_at];
  const date = new Date(moments.find(Boolean) ?? NaN);
  if (!isValidDate(date)) return null;

  const opponents = Array.isArray(row.opponents) ? row.opponents.map((item) => item?.opponent) : [];
  const [teamA, teamB] = [0, 1].map((index) => cleanText(opponents[index]?.name, MAX_TEAM_LENGTH) || TO_BE_DEFINED);

  const scoreOf = (team) => {
    const result = (Array.isArray(row.results) ? row.results : []).find((item) => team && item?.team_id === team.id);
    return Number.isInteger(result?.score) ? result.score : null;
  };
  const [first, second] = [scoreOf(opponents[0]), scoreOf(opponents[1])];
  if (status === 'FINISHED' && (first === null || second === null)) return null;

  const hasScore = status === 'FINISHED' || status === 'LIVE';
  // O nome vem como "Grand final: LOUD vs FURIA": só o que está antes dos dois-pontos é a fase.
  const stageName = String(row.name ?? '').split(':').slice(0, -1).join(':');
  return {
    externalId: `pandascore:${row.id}`,
    tournament: rule.name(row),
    stage: buildStage([row.tournament?.name, stageName]),
    date,
    approximateDate: false,
    teamA,
    teamB,
    scoreA: hasScore ? first ?? 0 : null,
    scoreB: hasScore ? second ?? 0 : null,
    status,
  };
}

function createPandaScoreSource({ token, fetch = globalThis.fetch }) {
  // No cabeçalho, e não no endereço, para o token não aparecer em registros de acesso.
  async function getList(path) {
    const list = await getJson(fetch, `${PANDASCORE_API}${path}`, 'PandaScore', { Authorization: `Bearer ${token}` });
    if (!Array.isArray(list)) throw new Error('PandaScore respondeu num formato inesperado');
    return list;
  }

  let namesByLeague = null;

  async function findLeagues() {
    if (namesByLeague) return namesByLeague;
    const found = new Map();
    for (const rule of LOL_LEAGUES) {
      const leagues = await getList(`/lol/leagues?search[name]=${encodeURIComponent(rule.search)}&per_page=50`);
      for (const league of leagues) {
        if (rule.pattern.test(league?.name ?? '')) found.set(league.id, rule);
      }
    }
    if (found.size === 0) throw new Error('PandaScore não encontrou as ligas acompanhadas');
    namesByLeague = found;
    return found;
  }

  return {
    name: 'PandaScore',
    game: 'League of Legends',
    async fetchMatches() {
      // Com caractere inválido, o fetch repetiria o cabeçalho inteiro, com o token, na mensagem de erro.
      if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('PANDASCORE_TOKEN tem caracteres inválidos');
      const leagues = await findLeagues();
      const filter = `filter[league_id]=${[...leagues.keys()].join(',')}`;
      const lists = await Promise.all([
        getList(`/lol/matches/past?${filter}&sort=-scheduled_at&per_page=${PANDASCORE_PAGE_SIZE}`),
        getList(`/lol/matches/running?${filter}&per_page=${PANDASCORE_PAGE_SIZE}`),
        // Sem data, o jogo viria primeiro na ordem e ocuparia a lista sem poder ser mostrado.
        getList(`/lol/matches/upcoming?${filter}&filter[unscheduled]=false&sort=scheduled_at&per_page=${PANDASCORE_PAGE_SIZE}`),
      ]);
      const rows = lists.flat();
      if (rows.length > 0 && !rows.some(isPandaScoreRow)) throw new Error('PandaScore respondeu num formato inesperado');
      return rows.map((row) => pandaScoreMatch(row, leagues)).filter(Boolean);
    },
  };
}

// VALORANT não pede chave. League of Legends só entra quando há token configurado.
function createDefaultSources({ pandascoreToken, fetch } = {}) {
  const token = pandascoreToken?.trim();
  return [
    ...(token ? [createPandaScoreSource({ token, fetch })] : []),
    createVlrSource({ fetch }),
  ];
}

module.exports = { createDefaultSources, createPandaScoreSource, createVlrSource };
