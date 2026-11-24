// Offline support for the deployed (https) app.
//
// - App files (HTML, CSS, JS, icons) come from the cache first and are refreshed in the
//   background, so the app always opens, even without a connection.
// - The book list (books/library.json) is fetched from the network first, so new books show
//   up on the first open. The saved copy is used only when offline.
// - Book files are kept offline only for books the reader downloaded (one cache per level,
//   "leseecke-book-<edition id>", managed from the page). Other books are read from the
//   network and never stored.

const CACHE = 'leseecke-v6';
const BOOK_PREFIX = 'leseecke-book-';
const NETWORK_TIMEOUT = 4000;
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/format.js',
  'js/srs.js',
  'js/store.js',
  'js/speech.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'books/library.json',
  'books/glossary.txt',
];
// The book lists are fetched network-first so new books and levels show up on the first open.
// (books/index.json is the list format used by versions before multi-level books.)
const BOOK_LISTS = new Set(['books/library.json', 'books/index.json']);

const scopePath = new URL(self.registration.scope).pathname;
const relPath = (url) => (url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : url.pathname);
const bookOf = (rel) => rel.match(/^books\/([^/]+)\/[^/]+$/)?.[1];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// Older versions stored every book in the app cache. Move those files into per-book
// caches, so books that were already offline stay downloaded.
async function migrateBooks(oldCacheName) {
  const old = await caches.open(oldCacheName);
  for (const req of await old.keys()) {
    const id = bookOf(relPath(new URL(req.url)));
    if (!id) continue;
    const res = await old.match(req);
    if (res) await (await caches.open(BOOK_PREFIX + decodeURIComponent(id))).put(req, res);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key === CACHE || key.startsWith(BOOK_PREFIX)) continue;
        if (key.startsWith('leseecke-v')) await migrateBooks(key).catch(() => {});
        await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const rel = relPath(url);
  if (BOOK_LISTS.has(rel)) {
    event.respondWith(networkFirst(req, event));
    return;
  }
  const bookId = bookOf(rel);
  if (bookId) {
    event.respondWith(bookFile(req, BOOK_PREFIX + decodeURIComponent(bookId), event));
    return;
  }
  event.respondWith(staleWhileRevalidate(req, event));
});

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return network;
}

async function networkFirst(req, event) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT));
  try {
    return await Promise.race([network, timeout]);
  } catch {
    // Offline or a very slow connection: use the saved list if there is one.
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || network;
  }
}

async function bookFile(req, cacheName, event) {
  if (await caches.has(cacheName)) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      // Downloaded: answer instantly, and quietly pick up corrections to the text.
      event.waitUntil(
        fetch(req)
          .then(async (res) => {
            if (res.ok && (await caches.has(cacheName))) await cache.put(req, res);
          })
          .catch(() => {}),
      );
      return cached;
    }
  }
  return fetch(req); // not downloaded: always read from the network, never stored
}
