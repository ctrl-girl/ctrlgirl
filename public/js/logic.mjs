// Regras do front sem dependência da página, para poderem ser testadas.

const TIME_ZONE = 'America/Sao_Paulo';

// ---------- HTML seguro ----------
class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

// Template que escapa tudo o que é interpolado: conteúdo de quem usa o app nunca vira HTML.
export function html(strings, ...values) {
  return new SafeHtml(strings.reduce((output, text, index) => output + text + (index < values.length ? renderValue(values[index]) : ''), ''));
}

// Texto final para o innerHTML, aceitando um template ou uma lista deles.
export function toHtml(value) {
  return renderValue(value);
}

// Só para HTML escrito pela equipe, como o texto das matérias.
export function raw(value) {
  return new SafeHtml(value);
}

// ---------- Rotas ----------
const STATIC_ROUTES = {
  '#/inicio': 'home',
  '#/pesquisar': 'search',
  '#/jogos': 'matches',
  '#/forum': 'forum',
  '#/sobre': 'about',
  '#/perfil': 'profile',
  '#/perfil/editar': 'profileEdit',
  '#/entrar': 'auth',
};

export function parseRoute(hash) {
  if (STATIC_ROUTES[hash]) return { view: STATIC_ROUTES[hash] };
  const article = /^#\/materia\/(\d{1,4})$/.exec(hash);
  if (article) return { view: 'article', id: Number(article[1]) };
  const topic = /^#\/forum\/([\w-]+)$/.exec(hash);
  if (topic) return { view: 'topic', id: topic[1] };
  return { view: 'home' };
}

// ---------- Busca e filtros ----------
const normalize = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function gameOfTournament(tournament) {
  const name = normalize(tournament);
  if (/vct|valorant/.test(name)) return 'valorant';
  return 'lol';
}

export function searchContent({ query, filter, articles, matches, topics }) {
  const term = normalize(query).trim();
  const found = (...fields) => !term || fields.some((field) => normalize(field).includes(term));
  return {
    articles: articles.filter((article) => (filter === 'all' || article.games.includes(filter))
      && found(article.title, article.summary, article.category)),
    matches: matches.filter((match) => (filter === 'all' || gameOfTournament(match.tournament) === filter)
      && found(match.teamA, match.teamB, match.tournament)),
    topics: filter === 'all' ? topics.filter((topic) => found(topic.title, topic.content, topic.category)) : [],
  };
}

export function filterByTournament(matches, filter) {
  if (filter === 'all') return matches;
  return matches.filter((match) => normalize(match.tournament).includes(normalize(filter)));
}

export function summarizeResults(results) {
  const counts = new Map();
  results.forEach(({ tournament }) => counts.set(tournament, (counts.get(tournament) ?? 0) + 1));
  return [...counts].map(([name, count]) => `${count} ${name}`).join(', ');
}

// ---------- Datas ----------
function dateParts(value, options) {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, ...options }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatDate(value) {
  const { day, month, year } = dateParts(value, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${day}/${month}/${year}`;
}

// Nascimento é só uma data, sem hora: não pode mudar de dia ao converter o fuso.
export function formatBirthDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

export function formatMatchDate(value) {
  const { weekday, day, month, hour, minute } = dateParts(value, {
    weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return `${weekday}, ${day}/${month} às ${hour}:${minute}`;
}

export function formatDateTime(value) {
  const { hour, minute } = dateParts(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${formatDate(value)} às ${hour}:${minute}`;
}

// Data mais recente que permite o cadastro: hoje, 16 anos atrás.
export function maxBirthDate(now = new Date()) {
  const { day, month, year } = dateParts(now, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${Number(year) - 16}-${month}-${day}`;
}

// ---------- Perfil ----------
export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ---------- Agenda e compartilhamento ----------
const icsDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (text) => String(text).replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');

export function buildIcs(match, now = new Date()) {
  const start = new Date(match.date);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CTRL GIRL//Jogos//PT-BR',
    'BEGIN:VEVENT',
    `UID:${match.id}@ctrlgirl`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${match.teamA} x ${match.teamB} (${match.tournament})`)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:O jogo começa em 30 minutos',
    'TRIGGER:-PT30M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function shareLinks({ title, url }) {
  const text = encodeURIComponent(`${title} ${url}`);
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  return {
    whatsapp: `https://wa.me/?text=${text}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`,
    telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedTitle}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
  };
}
