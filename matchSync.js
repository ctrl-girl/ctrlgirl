// Mantém a tabela Match em dia com as fontes externas. Fonte fora do ar nunca apaga nada:
// o que já foi gravado continua na tela, e a próxima rodada tenta de novo.

const MINUTE = 60 * 1000;
// Cobre atraso e horário digitado à mão com folga, mas fica abaixo de um dia: revanche no dia seguinte é outro jogo.
const SAME_MATCH_WINDOW = 18 * 60 * MINUTE;
const TO_BE_DEFINED = 'A definir';
const DEFAULT_SYNC_MINUTES = 5;
// O jogo deixa de aparecer como ao vivo depois de 30 minutos sem confirmação da fonte: 15 dá duas chances.
const MAX_SYNC_MINUTES = 15;

const nameKey = (name) => String(name ?? '').normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();

// "LOS" e "LOS Grandes" são o mesmo time; "LOUD" e "Lobos", não.
function isSameTeam(first, second) {
  const [a, b] = [nameKey(first), nameKey(second)];
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// "CBLOL" e "CBLOL 2026" são o mesmo torneio. Times de nome parecido em torneios diferentes, como
// "MIBR" no VCT e "MIBR GC" no Game Changers, não podem virar o mesmo jogo.
function isSameTournament(first, second) {
  const [a, b] = [nameKey(first), nameKey(second)];
  return a.includes(b) || b.includes(a);
}

function isSameMatch(row, match) {
  if (!isSameTournament(row.tournament, match.tournament)) return false;
  const sameOrder = isSameTeam(row.teamA, match.teamA) && isSameTeam(row.teamB, match.teamB);
  const swapped = isSameTeam(row.teamA, match.teamB) && isSameTeam(row.teamB, match.teamA);
  return sameOrder || swapped;
}

// Jogos da carga inicial também existem nas fontes: a fonte assume a linha em vez de criar outra,
// e assim o lembrete de quem já marcou aquele jogo continua valendo.
async function findManualTwin(prisma, match) {
  if (match.teamA === TO_BE_DEFINED || match.teamB === TO_BE_DEFINED) return null;
  const candidates = await prisma.match.findMany({
    where: {
      externalId: null,
      date: {
        gte: new Date(match.date.getTime() - SAME_MATCH_WINDOW),
        lte: new Date(match.date.getTime() + SAME_MATCH_WINDOW),
      },
    },
  });
  const distance = (row) => Math.abs(row.date.getTime() - match.date.getTime());
  return candidates.filter((row) => isSameMatch(row, match)).sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

async function saveMatch(prisma, { approximateDate, ...match }, syncedAt) {
  const existing = await prisma.match.findUnique({ where: { externalId: match.externalId } })
    ?? await findManualTwin(prisma, match);
  if (!existing) return prisma.match.create({ data: { ...match, syncedAt } });
  const { date, ...fields } = match;
  // Data estimada nunca substitui a que já existe, que pode ser exata.
  return prisma.match.update({
    where: { id: existing.id },
    data: { ...fields, syncedAt, ...(approximateDate ? {} : { date }) },
  });
}

function createMatchSync({ prisma, sources, now = () => new Date(), logger = console }) {
  const lastSuccess = new Map();
  let running = null;
  let timer = null;

  async function syncSource(source) {
    const syncedAt = now();
    const matches = await source.fetchMatches(syncedAt);
    let failed = 0;
    for (const match of matches) {
      try {
        await saveMatch(prisma, match, syncedAt);
      } catch (error) {
        failed += 1;
        logger.error(`Resultados: ${source.name} não gravou ${match.externalId}: ${error.message}`);
      }
    }
    if (failed < matches.length || matches.length === 0) lastSuccess.set(source, syncedAt);
  }

  async function runAll() {
    for (const source of sources) {
      try {
        await syncSource(source);
      } catch (error) {
        // "fetch failed" não diz muito: o motivo de verdade, como um tempo esgotado, vem em cause.
        const reason = error.cause?.code ? `${error.message} (${error.cause.code})` : error.message;
        logger.error(`Resultados: falha em ${source.name}: ${reason}`);
      }
    }
  }

  // Uma rodada lenta não pode se sobrepor à seguinte.
  function run() {
    if (!running) running = runAll().finally(() => { running = null; });
    return running;
  }

  function start(minutes) {
    if (!(minutes > 0)) return;
    run();
    timer = setInterval(run, minutes * MINUTE);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Só cita o que atualizou de fato, com o horário da fonte mais atrasada: é a promessa que dá para cumprir.
  function status() {
    const updated = sources.filter((source) => lastSuccess.has(source));
    if (updated.length === 0) return { updatedAt: null, games: [] };
    const updatedAt = new Date(Math.min(...updated.map((source) => lastSuccess.get(source).getTime())));
    return { updatedAt, games: updated.map((source) => source.game) };
  }

  return { run, start, stop, status };
}

// Número fora do esperado volta ao padrão: um valor enorme estouraria o relógio e bombardearia as fontes.
function parseSyncMinutes(value) {
  if (value === undefined || value === '') return DEFAULT_SYNC_MINUTES;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_SYNC_MINUTES ? minutes : DEFAULT_SYNC_MINUTES;
}

module.exports = { createMatchSync, parseSyncMinutes };
