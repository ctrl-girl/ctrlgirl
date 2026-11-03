import { articles, HERO_ARTICLE_ID } from './data.mjs';
import { api, session } from './api.mjs';
import {
  html,
  toHtml,
  parseRoute,
  sharedArticleHash,
  searchContent,
  filterByTournament,
  summarizeResults,
  resultsKey,
  resultsUpdatedLabel,
  resultsPausedLabel,
  shouldRefreshResults,
  gameOfTournament,
  formatDate,
  formatBirthDate,
  formatDateTime,
  formatMatchDate,
  maxBirthDate,
  initials,
  buildIcs,
  shareLinks,
} from './logic.mjs';

const GUEST_KEY = 'ctrlgirl_guest';
const DYSLEXIA_KEY = 'ctrlgirl_dyslexia_font';
const RESULTS_PAUSED_KEY = 'ctrlgirl_results_paused';
const MAX_AVATAR_SIZE = 256;
const RESULTS_REFRESH_MS = 60 * 1000;
const RESULTS_FIRST_SYNC_WAIT_MS = 10 * 1000;

const VIEWS = {
  auth: { id: 'viewAuth', title: 'Entrar' },
  home: { id: 'viewHome', title: 'Início', nav: 'navHome', render: renderHome },
  search: { id: 'viewSearch', title: 'Buscar', nav: 'navSearch', render: renderSearch },
  matches: { id: 'viewMatches', title: 'Próximos jogos', nav: 'navMatches', render: renderMatches },
  forum: { id: 'viewChat', title: 'Fórum', nav: 'navChat', render: renderForum },
  topic: { id: 'viewTopicDetail', title: 'Discussão', nav: 'navChat', render: renderTopic },
  about: { id: 'viewAbout', title: 'Sobre' },
  profile: { id: 'viewProfile', title: 'Perfil', nav: 'navProfile', render: renderProfile },
  profileEdit: { id: 'viewProfileEdit', title: 'Editar perfil', nav: 'navProfile', render: renderProfileEdit },
  article: { id: 'viewArticleDetail', title: 'Matéria', nav: 'navHome', render: renderArticle },
};

const FILTERS = {
  match: {
    container: 'matchFilters',
    options: [
      { value: 'all', label: 'Todos', active: 'bg-brand-purple' },
      { value: 'CBLOL', label: 'CBLOL', active: 'bg-purple-700' },
      { value: 'Worlds', label: 'Worlds', active: 'bg-indigo-700' },
      { value: 'VCT', label: 'VCT Américas', active: 'bg-sky-700' },
      { value: 'VALORANT Champions', label: 'VALORANT Champions', active: 'bg-pink-700' },
      { value: 'Game Changers', label: 'Game Changers', active: 'bg-fuchsia-700' },
    ],
  },
  forum: {
    container: 'forumFilters',
    options: [
      { value: 'all', label: 'Todos', active: 'bg-brand-purple' },
      { value: 'Campeonatos', label: 'Campeonatos', active: 'bg-purple-700' },
      { value: 'Comunidade', label: 'Comunidade', active: 'bg-emerald-700' },
      { value: 'Dicas & Gameplay', label: 'Dicas & Gameplay', active: 'bg-amber-700' },
    ],
  },
  search: {
    container: 'searchFilters',
    options: [
      { value: 'all', label: 'Tudo', active: 'bg-brand-purple' },
      { value: 'lol', label: 'League of Legends', active: 'bg-purple-700' },
      { value: 'valorant', label: 'Valorant', active: 'bg-sky-700' },
    ],
  },
};

const state = {
  user: null,
  isGuest: false,
  route: null,
  returnTo: null,
  filters: { match: 'all', forum: 'all', search: 'all' },
  results: [],
  resultsSync: null,
  resultsPaused: false,
  matches: [],
  topics: [],
  stats: {},
  article: null,
  topic: null,
  scroll: {},
};

const $ = (id) => document.getElementById(id);
const setHtml = (id, template) => { $(id).innerHTML = toHtml(template); };
const isSignedIn = () => state.user !== null;

// ---------- Avisos ----------
let toastTimer;

function showToast(message, type = 'success') {
  $('toastMsg').textContent = message;
  $('toastIcon').className = type === 'error'
    ? 'fa-solid fa-circle-exclamation text-rose-300'
    : 'fa-solid fa-circle-check text-green-400';
  $('toast').classList.remove('hidden');
  $('toast').classList.add('flex');
  clearTimeout(toastTimer);
  // Erro fica na tela até ser fechado, para dar tempo de ler.
  if (type !== 'error') toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  $('toast').classList.add('hidden');
  $('toast').classList.remove('flex');
}

function announce(message) {
  $('liveStatus').textContent = '';
  setTimeout(() => { $('liveStatus').textContent = message; }, 50);
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const loadError = (message) => html`
  <div class="bg-white p-6 rounded-2xl text-center space-y-3 border border-slate-200">
    <p class="text-sm text-slate-800 font-semibold">${message}</p>
    <button type="button" data-action="retry" class="px-4 bg-brand-purple text-white font-bold rounded-xl text-sm">Tentar de novo</button>
  </div>
`;

// ---------- Sessão ----------
async function restoreSession() {
  if (session.token) {
    try {
      state.user = await api('/auth/me');
    } catch (error) {
      if (error.status === 401) session.clear();
    }
  } else {
    session.clear();
  }
  state.isGuest = !state.user && sessionStorage.getItem(GUEST_KEY) === 'true';
}

function enterAsGuest() {
  state.isGuest = true;
  sessionStorage.setItem(GUEST_KEY, 'true');
  updateAccountUi();
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function finishLogin(user, token, message) {
  session.token = token;
  state.user = user;
  state.isGuest = false;
  sessionStorage.removeItem(GUEST_KEY);
  $('authPageLogin').reset();
  $('authPageRegister').reset();
  updateAccountUi();
  showToast(message);
  const target = state.returnTo ?? '#/inicio';
  state.returnTo = null;
  navigate(target);
}

function clearSession() {
  session.clear();
  sessionStorage.removeItem(GUEST_KEY);
  state.user = null;
  state.isGuest = false;
  state.stats = {};
  state.matches = [];
  state.returnTo = null;
  document.querySelectorAll('form').forEach((form) => {
    form.reset();
    clearErrors(form);
  });
  // Em computador compartilhado, os dados da conta não podem ficar na página oculta.
  $('profileDetails').innerHTML = '';
  $('profileAvatar').innerHTML = '';
  $('profileName').textContent = '';
  $('profileNickname').textContent = '';
  updateAccountUi();
}

async function logout() {
  // Sem conexão, o token some deste aparelho e expira sozinho no servidor.
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  clearSession();
  closeDialogs();
  showToast('Sua sessão foi encerrada.');
  navigate('#/entrar');
}

function promptLogin(reason) {
  $('loginDialogText').textContent = `Entre ou crie uma conta para ${reason}.`;
  $('loginDialog').showModal();
}

function goToLogin() {
  const here = state.route?.view;
  if (here && here !== 'auth') state.returnTo = location.hash;
  closeDialogs();
  navigate('#/entrar');
}

function avatarMarkup(user) {
  if (user.avatarUrl) return html`<img src="${user.avatarUrl}" alt="" class="w-full h-full object-cover" />`;
  return html`<span aria-hidden="true">${initials(user.name || user.nickname)}</span>`;
}

function updateAccountUi() {
  const account = $('btnDrawerAccount');
  if (isSignedIn()) {
    setHtml('headerAvatar', avatarMarkup(state.user));
    setHtml('drawerUserStatus', html`Conectado como <b>${state.user.nickname}</b>`);
    account.textContent = 'Sair do app';
    account.dataset.action = 'logout';
  } else {
    setHtml('headerAvatar', html`<i class="fa-solid fa-user" aria-hidden="true"></i>`);
    setHtml('drawerUserStatus', html`Você entrou como <b>visitante</b>`);
    account.textContent = 'Entrar ou criar conta';
    account.dataset.action = 'go-login';
  }
}

// ---------- Rotas ----------
function scrollPosition() {
  return Math.max($('mainContent').scrollTop, window.scrollY);
}

function setScroll(position) {
  $('mainContent').scrollTop = position;
  window.scrollTo(0, position);
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
}

async function route() {
  const next = parseRoute(location.hash);
  const hasDestination = location.hash.startsWith('#/') && next.view !== 'auth';

  if (!isSignedIn() && !state.isGuest) {
    // Link direto (uma matéria compartilhada, por exemplo) abre sem exigir login.
    if (hasDestination) enterAsGuest();
    else return showView({ view: 'auth' });
  }
  if (next.view === 'auth' && isSignedIn()) return navigate('#/inicio');
  if (next.view === 'profileEdit' && !isSignedIn()) return navigate('#/perfil');
  return showView(next);
}

async function showView(next) {
  const config = VIEWS[next.view];
  const previous = state.route;
  if (previous) state.scroll[previous.view] = scrollPosition();

  Object.values(VIEWS).forEach(({ id }) => $(id).classList.add('hidden'));
  const section = $(config.id);
  section.classList.remove('hidden');

  const isAuth = next.view === 'auth';
  $('mainHeader').classList.toggle('hidden', isAuth);
  $('mainHeader').classList.toggle('flex', !isAuth);
  $('mainFooter').classList.toggle('hidden', isAuth);
  $('mainFooter').classList.toggle('flex', !isAuth);
  document.querySelectorAll('#mainFooter a').forEach((link) => {
    if (link.id === config.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  document.title = `${config.title} | CTRL GIRL`;
  next.from = previous?.view;
  state.route = next;
  closeDialogs();

  // Ao abrir, começa do topo; ao voltar de uma matéria ou tópico, a lista fica onde estava.
  const returning = previous?.from === next.view && ['article', 'topic', 'profileEdit'].includes(previous.view);
  setScroll(0);
  if (previous) section.focus({ preventScroll: true });
  if (config.render) await config.render(next);
  setScroll(returning ? state.scroll[next.view] ?? 0 : 0);
}

// ---------- Filtros ----------
function renderFilter(group) {
  const { container, options } = FILTERS[group];
  setHtml(container, options.map(({ value, label, active }) => {
    const on = state.filters[group] === value;
    const color = on ? `${active} text-white font-extrabold shadow-sm` : 'bg-slate-200 text-slate-800 hover:bg-slate-300 font-semibold';
    return html`
      <button type="button" data-action="filter" data-group="${group}" data-value="${value}" aria-pressed="${on}" class="${color} px-3 rounded-full whitespace-nowrap transition flex items-center gap-1.5">
        ${on ? html`<i class="fa-solid fa-check text-xs" aria-hidden="true"></i>` : ''} ${label}
      </button>
    `;
  }));
}

// ---------- Início ----------
async function loadStats() {
  try {
    state.stats = await api('/materias/interacoes');
  } catch {
    state.stats = {};
  }
}

const statsFor = (id) => state.stats[id] ?? { likes: 0, comments: 0, liked: false };

function renderHero() {
  const hero = articles.find((article) => article.id === HERO_ARTICLE_ID);
  $('heroImage').src = hero.image;
  $('heroLink').href = `#/materia/${hero.id}`;
  $('heroLink').textContent = hero.title;
  $('heroDate').textContent = hero.date;
}

function articleCard(article, { showStats = true } = {}) {
  const stats = statsFor(article.id);
  return html`
    <li>
      <article class="relative bg-white p-3 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-3 hover:border-purple-300 transition">
        <img src="${article.image}" alt="" loading="lazy" class="w-20 h-20 rounded-xl object-cover shrink-0" />
        <div class="flex-1 min-w-0">
          <span class="text-xs font-extrabold text-brand-darkPurple bg-purple-50 px-2 py-0.5 rounded">${article.category}</span>
          <h3 class="font-bold text-slate-900 text-sm leading-snug mt-1">
            <a href="#/materia/${article.id}" class="card-link">${article.title}</a>
          </h3>
          <p class="flex items-center gap-3 text-xs text-slate-700 font-medium mt-1.5">
            <span><i class="fa-regular fa-calendar mr-1" aria-hidden="true"></i>${article.date}</span>
            ${showStats ? html`<span><i class="fa-regular fa-heart text-pink-700 mr-1" aria-hidden="true"></i><span class="sr-only">Curtidas: </span>${stats.likes}</span>` : ''}
          </p>
        </div>
      </article>
    </li>
  `;
}

function renderFeed() {
  setHtml('newsFeedList', articles.map((article) => articleCard(article)));
}

function resultCard(match) {
  const family = gameOfTournament(match.tournament) === 'valorant'
    ? { badge: 'bg-sky-950/90 text-sky-100 border border-sky-700/80', border: 'border-l-4 border-l-sky-500' }
    : { badge: 'bg-purple-950/90 text-purple-100 border border-purple-700/80', border: 'border-l-4 border-l-brand-purple' };
  const isLive = match.status === 'LIVE';
  // Enquanto o jogo não acaba, quem está na frente ainda não ganhou.
  const teamColor = (mine, other) => (!isLive && mine > other ? 'text-emerald-300 font-extrabold' : 'text-slate-200 font-semibold');
  return html`
    <article class="shrink-0 w-72 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-xl p-3 border border-slate-700/70 shadow-sm space-y-2.5 ${family.border}">
      <div class="flex items-center justify-between gap-2 text-xs border-b border-slate-800/80 pb-1.5">
        <span class="font-extrabold px-2.5 py-0.5 rounded-full ${family.badge}">${match.tournament}</span>
        ${isLive ? html`
          <span class="inline-flex items-center gap-1.5 text-rose-200 font-extrabold shrink-0">
            <span class="w-2 h-2 rounded-full bg-rose-400 motion-safe:animate-pulse group-data-[paused]:animate-none" aria-hidden="true"></span>Ao vivo
          </span>
        ` : html`<span class="text-slate-200 font-semibold shrink-0">${formatDate(match.date)}</span>`}
      </div>
      ${match.stage ? html`<p class="text-xs font-bold text-slate-200">${match.stage}</p>` : ''}
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 bg-slate-950/90 px-3 py-2 rounded-lg border border-slate-800/90 text-sm">
        <span class="${teamColor(match.scoreA, match.scoreB)} break-words">${match.teamA}</span>
        <span class="bg-gradient-to-r from-purple-950 to-slate-900 border border-purple-500/50 text-emerald-300 font-black px-2.5 py-1 rounded shadow-inner">
          <span aria-hidden="true">${match.scoreA} - ${match.scoreB}</span><span class="sr-only">${match.scoreA} a ${match.scoreB}</span>
        </span>
        <span class="${teamColor(match.scoreB, match.scoreA)} text-right break-words">${match.teamB}</span>
      </div>
    </article>
  `;
}

async function loadResults() {
  // O aviso de atualização é um extra: se falhar, os resultados aparecem do mesmo jeito.
  const [results, resultsSync] = await Promise.all([api('/jogos/resultados'), api('/jogos/atualizacao').catch(() => null)]);
  return { results, resultsSync };
}

function showResults() {
  $('resultsSummary').textContent = summarizeResults(state.results);
  setHtml('resultsContainer', state.results.length
    ? state.results.map(resultCard)
    : html`<p class="text-sm text-slate-200 py-6 px-2">Nenhum resultado por enquanto.</p>`);
}

function showResultsUpdate() {
  $('resultsUpdated').textContent = state.resultsPaused ? resultsPausedLabel(state.resultsSync) : resultsUpdatedLabel(state.resultsSync);
}

// Pausar não redesenha nada: os cartões ficam onde estão, e só a bolinha do "Ao vivo" para.
function setResultsPaused(paused) {
  state.resultsPaused = paused;
  $('resultsContainer').toggleAttribute('data-paused', paused);
  $('resultsPauseIcon').className = `fa-solid ${paused ? 'fa-play' : 'fa-pause'}`;
  $('resultsPauseLabel').textContent = paused ? 'Retomar atualização' : 'Pausar atualização';
  showResultsUpdate();
}

async function renderHome() {
  renderHero();
  renderFeed();
  setHtml('resultsContainer', html`<p class="text-sm text-slate-200 py-6 px-2">Carregando resultados…</p>`);
  await loadStats();
  renderFeed();
  try {
    Object.assign(state, await loadResults());
    showResults();
    showResultsUpdate();
  } catch (error) {
    // Lista vazia para a próxima renovação redesenhar e tirar o aviso, mesmo que os resultados sejam os mesmos de antes.
    state.results = [];
    setHtml('resultsContainer', html`<p class="text-sm text-slate-200 py-6 px-2">${error.message}</p>`);
  }
  // Servidor recém-acordado: a primeira busca ainda está em andamento, então vale olhar de novo logo.
  if (!state.resultsSync?.updatedAt) setTimeout(refreshResults, RESULTS_FIRST_SYNC_WAIT_MS);
}

// Com a tela inicial aberta, o placar anda sozinho. Só redesenha o que mudou,
// para não atrapalhar quem está rolando a lista ou usando leitor de tela.
async function refreshResults() {
  if (!shouldRefreshResults({ view: state.route?.view, hidden: document.hidden, paused: state.resultsPaused })) return;
  let fresh;
  try {
    fresh = await loadResults();
  } catch {
    // Sem conexão: continua mostrando o último placar, e a próxima rodada tenta de novo.
    return;
  }
  // Pausou com a busca a caminho: o que chegou fica de fora, para a tela não mudar depois do clique.
  if (state.resultsPaused) return;
  const changed = resultsKey(fresh.results) !== resultsKey(state.results);
  Object.assign(state, fresh);
  if (changed) showResults();
  showResultsUpdate();
}

// ---------- Jogos ----------
async function loadMatches() {
  state.matches = await api('/jogos/proximos');
}

function matchCard(match) {
  return html`
    <article aria-label="${match.teamA} contra ${match.teamB}, ${match.tournament}" class="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-purple-100 text-purple-950 border border-purple-300">${match.tournament}</span>
        <span class="text-xs font-bold text-slate-800"><i class="fa-regular fa-clock mr-1" aria-hidden="true"></i>${formatMatchDate(match.date)}</span>
      </div>
      <div class="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200">
        <span class="font-extrabold text-slate-900 text-sm flex-1 break-words">${match.teamA}</span>
        <span class="font-black text-slate-700 text-sm px-2" aria-hidden="true">VS</span>
        <span class="font-extrabold text-slate-900 text-sm flex-1 text-right break-words">${match.teamB}</span>
      </div>
      <div class="flex flex-wrap justify-between items-center gap-2 text-sm">
        <a href="#/materia/${HERO_ARTICLE_ID}" class="inline-flex items-center min-h-11 text-brand-darkPurple font-bold underline">Onde assistir</a>
        <button type="button" data-action="add-to-calendar" data-id="${match.id}" aria-pressed="${Boolean(match.hasReminder)}" class="px-3 text-brand-darkPurple font-bold bg-purple-50 hover:bg-purple-100 rounded-xl flex items-center gap-1.5">
          <i class="fa-${match.hasReminder ? 'solid' : 'regular'} fa-bell" aria-hidden="true"></i>
          ${match.hasReminder ? 'Na sua agenda' : 'Adicionar à agenda'}
        </button>
      </div>
    </article>
  `;
}

function showMatches() {
  const list = filterByTournament(state.matches, state.filters.match);
  setHtml('matchesContainer', list.length ? list.map(matchCard) : html`
    <div class="bg-white p-6 rounded-2xl text-center text-sm text-slate-800 font-semibold border border-slate-200 space-y-2">
      <p>Nenhum jogo agendado por enquanto.</p>
      <a href="#/inicio" class="inline-flex items-center min-h-11 text-brand-darkPurple font-bold underline">Ver os últimos resultados</a>
    </div>
  `);
  return list.length;
}

async function renderMatches() {
  renderFilter('match');
  setHtml('matchesContainer', html`<p class="text-sm text-slate-700 p-2">Carregando jogos…</p>`);
  try {
    await loadMatches();
    showMatches();
  } catch (error) {
    setHtml('matchesContainer', loadError(error.message));
  }
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// O arquivo .ics é o lembrete de verdade: a agenda do aparelho avisa 30 minutos antes.
async function addToCalendar(button) {
  const match = state.matches.find((item) => item.id === button.dataset.id);
  if (!match) return;
  const removing = match.hasReminder;
  if (!removing) downloadFile(`${match.teamA}-x-${match.teamB}.ics`, buildIcs(match), 'text/calendar');
  if (isSignedIn()) {
    try {
      const { active } = await api(`/jogos/${match.id}/lembrete`, { method: 'POST' });
      match.hasReminder = active;
      showMatches();
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
  }
  showToast(removing ? 'Jogo retirado da sua lista.' : 'Arquivo de agenda baixado. Abra-o para salvar o aviso de 30 minutos antes.');
}

// ---------- Fórum ----------
// Foto de quem escreveu; sem foto, o ícone de pessoa.
function authorPhoto(author) {
  if (!author.avatarUrl) return html`<i class="fa-regular fa-user text-brand-purple" aria-hidden="true"></i>`;
  return html`<img src="${author.avatarUrl}" alt="" loading="lazy" class="w-6 h-6 rounded-full object-cover shrink-0" />`;
}

function topicCard(topic, heading = 'h2') {
  return html`
    <article class="relative p-4 rounded-2xl shadow-sm border transition hover:border-purple-300 bg-white border-slate-200 space-y-2.5">
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="font-extrabold px-2.5 py-0.5 rounded-full bg-purple-100 text-brand-darkPurple">${topic.category}</span>
        <span class="text-slate-700 font-medium shrink-0">${formatDate(topic.createdAt)}</span>
      </div>
      <${heading} class="font-extrabold text-slate-900 text-base leading-snug break-words">
        <a href="#/forum/${topic.id}" class="card-link">${topic.title}</a>
      </${heading}>
      <p class="text-sm text-slate-700 line-clamp-2 break-words">${topic.content}</p>
      <div class="flex items-center justify-between gap-2 pt-1 text-xs text-slate-700 font-medium border-t border-slate-200">
        <span class="flex items-center gap-1.5 min-w-0 break-words">${authorPhoto(topic.author)} ${topic.author.nickname}</span>
        <span class="bg-slate-100 px-2 py-0.5 rounded-full text-slate-800 font-bold flex items-center gap-1 shrink-0">
          <i class="fa-regular fa-comment" aria-hidden="true"></i> ${plural(topic._count.comments, 'resposta', 'respostas')}
        </span>
      </div>
    </article>
  `;
}

function showTopics() {
  const filter = state.filters.forum;
  const list = filter === 'all' ? state.topics : state.topics.filter((topic) => topic.category === filter);
  setHtml('forumTopicsContainer', list.length ? list.map((topic) => topicCard(topic)) : html`
    <div class="bg-white p-6 rounded-2xl text-center text-sm text-slate-800 font-semibold border border-slate-200">Nenhum tópico nesta categoria ainda.</div>
  `);
  return list.length;
}

async function renderForum() {
  renderFilter('forum');
  const isStaff = ['ADMIN', 'SUPER_ADMIN'].includes(state.user?.role);
  const category = $('topicCategory');
  const staffOption = [...category.options].find((option) => option.value === 'Perguntas da ADM');
  if (isStaff && !staffOption) category.add(new Option('Perguntas da ADM'));
  if (!isStaff && staffOption) staffOption.remove();

  setHtml('forumTopicsContainer', html`<p class="text-sm text-slate-700 p-2">Carregando tópicos…</p>`);
  try {
    state.topics = await api('/forum/topicos');
    showTopics();
  } catch (error) {
    setHtml('forumTopicsContainer', loadError(error.message));
  }
}

function openNewTopic() {
  if (!isSignedIn()) return promptLogin('criar um tópico');
  $('newTopicForm').classList.remove('hidden');
  $('btnNewTopic').classList.add('hidden');
  $('topicTitle').focus();
}

function closeNewTopic() {
  const form = $('newTopicForm').querySelector('form');
  form.reset();
  clearErrors(form);
  $('newTopicForm').classList.add('hidden');
  $('btnNewTopic').classList.remove('hidden');
  $('btnNewTopic').focus();
}

function commentItem(comment) {
  return html`
    <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 text-sm space-y-1">
      <div class="flex flex-wrap items-center justify-between gap-1 font-bold text-slate-900">
        <span class="flex items-center gap-1.5 break-words min-w-0">${authorPhoto(comment.author)} @${comment.author.nickname}</span>
        <span class="text-xs text-slate-600 font-normal">${formatDateTime(comment.createdAt)}</span>
      </div>
      <p class="text-slate-800 leading-relaxed whitespace-pre-line break-words">${comment.content}</p>
    </div>
  `;
}

function showReplies() {
  const { comments } = state.topic;
  $('topicRepliesCount').textContent = comments.length;
  setHtml('topicRepliesList', comments.length
    ? comments.map(commentItem)
    : html`<p class="text-sm text-slate-700 p-2">Nenhuma resposta ainda. Que tal ser a primeira pessoa a responder?</p>`);
}

async function renderTopic({ id }) {
  try {
    state.topic = await api(`/forum/topicos/${encodeURIComponent(id)}`);
  } catch (error) {
    showToast(error.status === 404 ? 'Este tópico não existe mais.' : error.message, 'error');
    return navigate('#/forum');
  }
  const { topic } = state;
  document.title = `${topic.title} | CTRL GIRL`;
  $('topicDetailCategory').textContent = topic.category;
  $('topicDetailDate').textContent = formatDate(topic.createdAt);
  $('topicDetailTitle').textContent = topic.title;
  setHtml('topicDetailAuthor', html`${authorPhoto(topic.author)} <span>Por @${topic.author.nickname}</span>`);
  $('topicDetailContent').textContent = topic.content;
  $('replyForm').classList.toggle('hidden', !isSignedIn());
  $('replyLoginPrompt').classList.toggle('hidden', isSignedIn());
  showReplies();
}

// ---------- Pesquisa ----------
function showSearchResults() {
  const query = $('searchInput').value;
  const found = searchContent({ query, filter: state.filters.search, articles, matches: state.matches, topics: state.topics });
  const total = found.articles.length + found.matches.length + found.topics.length;

  setHtml('searchResults', total === 0 ? html`
    <div class="bg-white p-6 rounded-2xl text-center space-y-2 border border-slate-200">
      <i class="fa-solid fa-magnifying-glass text-3xl text-slate-500" aria-hidden="true"></i>
      <p class="text-sm text-slate-800 font-bold">Nenhum resultado encontrado.</p>
      <p class="text-sm text-slate-700">Tente outro termo ou troque o filtro.</p>
    </div>
  ` : html`
    ${found.articles.length ? html`
      <h2 class="text-sm font-extrabold text-slate-800 pt-1">Matérias (${found.articles.length})</h2>
      <ul class="space-y-3">${found.articles.map((article) => articleCard(article, { showStats: false }))}</ul>
    ` : ''}
    ${found.matches.length ? html`
      <h2 class="text-sm font-extrabold text-slate-800 pt-3">Próximos jogos (${found.matches.length})</h2>
      ${found.matches.map(matchCard)}
    ` : ''}
    ${found.topics.length ? html`
      <h2 class="text-sm font-extrabold text-slate-800 pt-3">Fórum (${found.topics.length})</h2>
      ${found.topics.map((topic) => topicCard(topic, 'h3'))}
    ` : ''}
  `);
  announce(plural(total, 'resultado', 'resultados'));
}

async function renderSearch() {
  renderFilter('search');
  showSearchResults();
  const [matches, topics] = await Promise.allSettled([api('/jogos/proximos'), api('/forum/topicos')]);
  if (matches.status === 'fulfilled') state.matches = matches.value;
  if (topics.status === 'fulfilled') state.topics = topics.value;
  showSearchResults();
}

// ---------- Matéria ----------
function showLikes() {
  const { likes, liked } = statsFor(state.article.id);
  const button = $('btnLikeArticle');
  $('likeLabel').textContent = plural(likes, 'curtida', 'curtidas');
  button.setAttribute('aria-pressed', String(liked));
  button.setAttribute('aria-label', `Curtir matéria. ${plural(likes, 'curtida', 'curtidas')}.`);
  $('likeIcon').className = `${liked ? 'fa-solid text-pink-700' : 'fa-regular'} fa-heart text-base`;
}

async function loadComments() {
  const comments = await api(`/materias/${state.article.id}/comentarios`);
  $('commentCount').textContent = comments.length;
  setHtml('commentList', comments.length
    ? comments.map(commentItem)
    : html`<p class="text-sm text-slate-700">Ainda não há comentários. Que tal ser a primeira pessoa a comentar?</p>`);
}

async function renderArticle({ id }) {
  const article = articles.find((item) => item.id === id);
  if (!article) return navigate('#/inicio');
  state.article = article;

  document.title = `${article.title} | CTRL GIRL`;
  $('artCategory').textContent = article.category;
  $('artTitle').textContent = article.title;
  $('artAuthor').textContent = `Por ${article.author}`;
  $('artDate').textContent = article.date;
  $('artImage').src = article.image;
  // Texto escrito pela equipe em data.mjs, sem conteúdo de quem usa o app.
  $('artBody').innerHTML = article.content;
  $('commentForm').classList.toggle('hidden', !isSignedIn());
  $('commentLoginPrompt').classList.toggle('hidden', isSignedIn());

  showLikes();
  setHtml('commentList', html`<p class="text-sm text-slate-700">Carregando comentários…</p>`);
  await loadStats();
  showLikes();
  try {
    await loadComments();
  } catch (error) {
    setHtml('commentList', html`<p class="text-sm text-slate-700">${error.message}</p>`);
  }
}

async function likeArticle() {
  if (!isSignedIn()) return promptLogin('curtir matérias');
  try {
    const { liked, likes } = await api(`/materias/${state.article.id}/curtir`, { method: 'POST' });
    state.stats[state.article.id] = { ...statsFor(state.article.id), liked, likes };
    showLikes();
  } catch (error) {
    handleActionError(error);
  }
}

// ---------- Compartilhar ----------
// Sem "#": o servidor recebe o endereço inteiro e devolve a prévia com título e imagem da matéria.
const articleUrl = () => `${location.origin}/materia/${state.article.id}`;

function openShare() {
  const links = shareLinks({ title: state.article.title, url: articleUrl() });
  $('shareModalArticleName').textContent = state.article.title;
  $('shareWhatsapp').href = links.whatsapp;
  $('shareTwitter').href = links.twitter;
  $('shareTelegram').href = links.telegram;
  $('shareFacebook').href = links.facebook;
  $('shareModal').showModal();
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(articleUrl());
    $('shareModal').close();
    showToast('Link copiado.');
  } catch {
    showToast(`Não foi possível copiar. O link é: ${articleUrl()}`, 'error');
  }
}

async function nativeShare() {
  try {
    await navigator.share({ title: state.article.title, url: articleUrl() });
    $('shareModal').close();
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Não foi possível abrir o compartilhamento.', 'error');
  }
}

// ---------- Perfil ----------
function renderProfile() {
  const { user } = state;
  $('guestNotice').classList.toggle('hidden', isSignedIn());
  $('profileDetails').classList.toggle('hidden', !isSignedIn());
  $('profileActions').classList.toggle('hidden', !isSignedIn());
  $('btnChangeAvatar').classList.toggle('hidden', !isSignedIn());

  if (!user) {
    setHtml('profileAvatar', html`<i class="fa-solid fa-user-secret" aria-hidden="true"></i>`);
    $('profileNickname').textContent = 'Visitante';
    $('profileName').textContent = '';
    return;
  }

  setHtml('profileAvatar', avatarMarkup(user));
  $('profileNickname').textContent = `@${user.nickname}`;
  $('profileName').textContent = user.name;
  $('btnRemoveAvatar').classList.toggle('hidden', !user.avatarUrl);
  const row = (label, value) => html`
    <div class="py-2 flex justify-between gap-3">
      <dt class="font-semibold text-slate-700 shrink-0">${label}</dt>
      <dd class="text-slate-900 font-medium text-right break-words min-w-0">${value || 'Não informado'}</dd>
    </div>
  `;
  setHtml('profileDetails', [
    row('E-mail', user.email),
    row('Nascimento', `${formatBirthDate(user.birthDate)} (${user.age} anos)`),
    row('Cidade', user.city),
    row('Gênero', user.gender),
    row('Raça ou etnia', user.race),
  ]);
}

function renderProfileEdit() {
  const { user } = state;
  const form = $('profileForm');
  clearErrors(form);
  form.elements.name.value = user.name;
  form.elements.nickname.value = user.nickname;
  form.elements.email.value = user.email;
  form.elements.currentPassword.value = '';
  form.elements.city.value = user.city ?? '';
  form.elements.gender.value = user.gender ?? '';
  form.elements.race.value = user.race ?? '';
}

// Reduz a foto antes de enviar: o servidor só aceita imagens pequenas.
async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_AVATAR_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function saveAvatar(avatarUrl, message) {
  try {
    const { user } = await api('/auth/me', { method: 'PATCH', body: { avatarUrl } });
    state.user = user;
    updateAccountUi();
    renderProfile();
    showToast(message);
  } catch (error) {
    handleActionError(error);
  }
}

async function changeAvatar(file) {
  try {
    await saveAvatar(await resizeImage(file), 'Foto de perfil atualizada.');
  } catch {
    showToast('Não foi possível ler essa imagem. Tente um arquivo JPG, PNG ou WebP.', 'error');
  }
}

// ---------- Formulários ----------
function clearErrors(form) {
  form.querySelectorAll('[data-error-for], [data-form-error]').forEach((element) => {
    element.textContent = '';
    element.classList.add('hidden');
  });
  form.querySelectorAll('[aria-invalid]').forEach((element) => element.removeAttribute('aria-invalid'));
}

function showFieldError(form, name, message) {
  const slot = name ? form.querySelector(`[data-error-for="${name}"]`) : null;
  const target = slot ?? form.querySelector('[data-form-error]');
  if (!target) return showToast(message, 'error');
  target.textContent = message;
  target.classList.remove('hidden');
  const field = name ? form.elements[name] : null;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function validationMessage(field) {
  if (field.validity.valueMissing && field.dataset.valueMissingMessage) return field.dataset.valueMissingMessage;
  if (field.validity.rangeOverflow && field.dataset.rangeMessage) return field.dataset.rangeMessage;
  return field.validationMessage;
}

function handleActionError(error) {
  if (error.status === 401) {
    clearSession();
    enterAsGuest();
    showToast('Sua sessão expirou. Entre de novo para continuar.', 'error');
    route();
    return;
  }
  showToast(error.message, 'error');
}

async function submitForm(form, handler) {
  clearErrors(form);
  const invalid = [...form.elements].filter((field) => field.willValidate && !field.checkValidity());
  if (invalid.length > 0) {
    [...invalid].reverse().forEach((field) => showFieldError(form, field.name, validationMessage(field)));
    return;
  }

  const button = form.querySelector('[type="submit"]');
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Enviando…';
  try {
    await handler(form);
  } catch (error) {
    if (error.status === 401 && form.dataset.form !== 'login') handleActionError(error);
    else showFieldError(form, error.field, error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

const FORM_HANDLERS = {
  async login(form) {
    const { loginUser, password } = form.elements;
    const { user, token } = await api('/auth/login', {
      method: 'POST',
      body: { loginUser: loginUser.value, password: password.value },
    });
    finishLogin(user, token, `Boas-vindas, ${user.nickname}!`);
  },

  async register(form) {
    const { name, nickname, email, password, birthDate, gender, race, city } = form.elements;
    const { user, token } = await api('/auth/register', {
      method: 'POST',
      body: {
        name: name.value,
        nickname: nickname.value,
        email: email.value,
        password: password.value,
        birthDate: birthDate.value,
        gender: gender.value || null,
        race: race.value || null,
        city: city.value || null,
        acceptTerms: form.elements.acceptTerms.checked,
      },
    });
    finishLogin(user, token, `Conta criada. Boas-vindas, ${user.nickname}!`);
  },

  async topic(form) {
    const { title, category, content } = form.elements;
    await api('/forum/topicos', {
      method: 'POST',
      body: { title: title.value, category: category.value, content: content.value },
    });
    closeNewTopic();
    state.topics = await api('/forum/topicos');
    showTopics();
    showToast('Tópico publicado.');
  },

  async reply(form) {
    const { comment } = await api(`/forum/topicos/${state.topic.id}/comentarios`, {
      method: 'POST',
      body: { content: form.elements.content.value },
    });
    state.topic.comments.push(comment);
    form.reset();
    showReplies();
    showToast('Resposta enviada.');
    form.elements.content.focus();
  },

  async comment(form) {
    await api(`/materias/${state.article.id}/comentarios`, {
      method: 'POST',
      body: { content: form.elements.content.value },
    });
    form.reset();
    await loadComments();
    showToast('Comentário publicado.');
    form.elements.content.focus();
  },

  async profile(form) {
    const { name, nickname, email, currentPassword, city, gender, race } = form.elements;
    const body = {
      name: name.value,
      nickname: nickname.value,
      city: city.value || null,
      gender: gender.value || null,
      race: race.value || null,
    };
    if (email.value.trim().toLowerCase() !== state.user.email) {
      body.email = email.value;
      body.currentPassword = currentPassword.value;
    }
    const { user } = await api('/auth/me', { method: 'PATCH', body });
    state.user = user;
    updateAccountUi();
    showToast('Perfil atualizado.');
    navigate('#/perfil');
  },

  async password(form) {
    const { token } = await api('/auth/senha', {
      method: 'POST',
      body: { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value },
    });
    session.token = token;
    form.reset();
    showToast('Senha alterada.');
  },

  async delete(form) {
    await api('/auth/me', { method: 'DELETE', body: { password: form.elements.password.value } });
    clearSession();
    closeDialogs();
    showToast('Sua conta foi excluída.');
    navigate('#/entrar');
  },
};

// ---------- Fonte para dislexia ----------
function setDyslexia(on) {
  document.body.classList.toggle('dyslexia-mode', on);
  document.querySelectorAll('[data-dyslexia-toggle]').forEach((button) => button.setAttribute('aria-pressed', String(on)));
  document.querySelectorAll('[data-dyslexia-badge]').forEach((badge) => {
    badge.textContent = on ? 'Ligada' : 'Desligada';
    badge.className = on
      ? 'text-xs font-extrabold px-2 py-0.5 rounded-full bg-brand-darkPurple text-white'
      : 'text-xs font-extrabold px-2 py-0.5 rounded-full bg-slate-200 text-slate-800';
  });
}

// ---------- Abas de entrar e criar conta ----------
function switchAuthPage(page, { focus = false } = {}) {
  const tabs = { login: $('authTabBtnLogin'), register: $('authTabBtnRegister') };
  const panels = { login: $('authPageLogin'), register: $('authPageRegister') };
  Object.keys(tabs).forEach((name) => {
    const selected = name === page;
    tabs[name].setAttribute('aria-selected', String(selected));
    tabs[name].tabIndex = selected ? 0 : -1;
    panels[name].classList.toggle('hidden', !selected);
  });
  if (focus) tabs[page].focus();
}

// ---------- Ações ----------
const ACTIONS = {
  'skip-to-content': (element, event) => {
    event.preventDefault();
    $('mainContent').focus();
  },
  'open-menu': () => {
    $('sideDrawer').showModal();
    $('btnOpenMenu').setAttribute('aria-expanded', 'true');
  },
  'close-dialog': (element) => element.closest('dialog').close(),
  'open-terms': () => $('termsModal').showModal(),
  'toggle-dyslexia': () => {
    const on = !document.body.classList.contains('dyslexia-mode');
    localStorage.setItem(DYSLEXIA_KEY, String(on));
    setDyslexia(on);
    showToast(on ? 'Fonte para dislexia ligada.' : 'Fonte padrão restaurada.');
  },
  'switch-auth': (element) => switchAuthPage(element.dataset.page),
  'toggle-password': (element) => {
    const input = $(element.dataset.target);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    element.textContent = show ? 'Ocultar' : 'Mostrar';
    element.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    element.setAttribute('aria-pressed', String(show));
  },
  'login-as-guest': () => {
    enterAsGuest();
    const target = state.returnTo ?? '#/inicio';
    state.returnTo = null;
    navigate(target);
  },
  'go-login': goToLogin,
  'prompt-login': (element) => promptLogin(element.dataset.reason),
  logout,
  filter: (element) => {
    const { group, value } = element.dataset;
    state.filters[group] = value;
    renderFilter(group);
    if (group === 'match') announce(plural(showMatches(), 'jogo', 'jogos'));
    if (group === 'forum') announce(plural(showTopics(), 'tópico', 'tópicos'));
    if (group === 'search') showSearchResults();
    $(FILTERS[group].container).querySelector(`[data-value="${CSS.escape(value)}"]`).focus();
  },
  'scroll-results': (element) => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('resultsContainer').scrollBy({ left: Number(element.dataset.direction) * 300, behavior: smooth ? 'smooth' : 'auto' });
  },
  'toggle-results-pause': () => {
    const paused = !state.resultsPaused;
    localStorage.setItem(RESULTS_PAUSED_KEY, String(paused));
    setResultsPaused(paused);
    announce(paused ? 'Atualização dos resultados pausada.' : 'Atualização dos resultados retomada.');
    if (!paused) refreshResults();
  },
  'add-to-calendar': addToCalendar,
  'new-topic': openNewTopic,
  'cancel-topic': closeNewTopic,
  'like-article': likeArticle,
  'share-article': openShare,
  'copy-link': copyLink,
  'native-share': nativeShare,
  'change-avatar': () => $('avatarFileInput').click(),
  'remove-avatar': () => saveAvatar(null, 'Foto removida.'),
  'open-delete': () => {
    const form = $('deleteDialog').querySelector('form');
    form.reset();
    clearErrors(form);
    $('deleteDialog').showModal();
  },
  retry: () => route(),
  'close-toast': hideToast,
};

function onClick(event) {
  // Clique fora do conteúdo de uma janela (no fundo escurecido) fecha a janela.
  if (event.target instanceof HTMLDialogElement) {
    event.target.close();
    return;
  }
  const closer = event.target.closest('[data-close-dialog]');
  if (closer) closer.closest('dialog').close();

  const element = event.target.closest('[data-action]');
  if (element) ACTIONS[element.dataset.action]?.(element, event);
}

function onSubmit(event) {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  submitForm(form, FORM_HANDLERS[form.dataset.form]);
}

let searchTimer;

function onInput(event) {
  if (!event.target.matches('[data-search]')) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(showSearchResults, 150);
}

function onKeydown(event) {
  if (!event.target.matches('[role="tab"]')) return;
  const pages = ['login', 'register'];
  const current = pages.indexOf(event.target.dataset.page);
  const next = {
    ArrowRight: (current + 1) % pages.length,
    ArrowLeft: (current + pages.length - 1) % pages.length,
    Home: 0,
    End: pages.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  switchAuthPage(pages[next], { focus: true });
}

function onChange(event) {
  if (event.target.id !== 'avatarFileInput') return;
  const [file] = event.target.files;
  event.target.value = '';
  if (file) changeAvatar(file);
}

// Imagem de site externo que saiu do ar não deixa um quadro quebrado na tela.
function onImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || image.dataset.fallback) return;
  image.dataset.fallback = 'true';
  image.src = '/img/mascote.svg';
}

// ---------- Início do app ----------
function hideSplash() {
  const splash = $('splashScreen');
  splash.classList.add('opacity-0');
  setTimeout(() => splash.classList.add('hidden'), 300);
}

async function boot() {
  // Link compartilhado chega como /materia/N: vira #/materia/N, e os links internos voltam a partir da raiz.
  const shared = sharedArticleHash(location.pathname);
  if (shared) history.replaceState(null, '', `/${shared}`);

  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('change', onChange);
  document.addEventListener('error', onImageError, true);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', refreshResults);
  setInterval(refreshResults, RESULTS_REFRESH_MS);
  $('sideDrawer').addEventListener('close', () => $('btnOpenMenu').setAttribute('aria-expanded', 'false'));

  $('regBirthDate').max = maxBirthDate();
  if (navigator.share) {
    $('btnNativeShare').classList.remove('hidden');
    $('btnNativeShare').classList.add('flex');
  }
  setDyslexia(localStorage.getItem(DYSLEXIA_KEY) === 'true');
  setResultsPaused(localStorage.getItem(RESULTS_PAUSED_KEY) === 'true');

  await restoreSession();
  updateAccountUi();
  await route();
  hideSplash();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sem service worker o app funciona normalmente, só não abre sem internet.
    });
  }
}

boot();
