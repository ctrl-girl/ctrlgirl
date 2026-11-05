// Ao publicar, a própria mudança deste arquivo faz o navegador instalar a versão nova.
const CACHE = 'ctrl-girl-v8';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/theme.js',
  '/js/app.mjs',
  '/js/api.mjs',
  '/js/logic.mjs',
  '/js/data.mjs',
  '/img/mascote.svg',
  '/img/carranca.svg',
  '/icons/icon-192.png',
  '/vendor/fontawesome/css/all.min.css',
  '/vendor/fontawesome/webfonts/fa-solid-900.woff2',
  '/vendor/fontawesome/webfonts/fa-regular-400.woff2',
  '/vendor/fontawesome/webfonts/fa-brands-400.woff2',
  '/vendor/fonts/inter-latin-wght-normal.woff2',
  '/vendor/fonts/roboto-serif-latin-wght-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter((name) => name !== CACHE);
    await Promise.all(stale.map((name) => caches.delete(name)));
    await self.clients.claim();
    // Quem ainda está com uma página de versão antiga aberta recarrega uma vez.
    if (stale.length > 0) {
      const pages = await self.clients.matchAll({ type: 'window' });
      pages.forEach((page) => page.navigate(page.url));
    }
  })());
});

// Rede primeiro: com internet, sempre a versão publicada; sem internet, a última guardada.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('/index.html');
      throw error;
    }
  })());
});
