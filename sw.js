// Offline support for the deployed (https) app. Every file is served from the cache
// first and refreshed in the background, so the app works without a connection and
// picks up new books and updates on the next visit.

const CACHE = 'leseecke-v3';
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
  'books/index.json',
];

// The app shell plus every book, so everything is readable offline right after installing.
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  try {
    const books = await (await fetch('books/index.json', { cache: 'no-cache' })).json();
    const files = books.flatMap((b) => [`books/${b.id}/glossary.txt`, ...b.chapters.map((c) => `books/${b.id}/${c}`)]);
    await cache.addAll(files);
  } catch (err) {
    // Not fatal: books are also cached the first time they are opened.
    console.warn('Could not pre-cache books', err);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
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
    }),
  );
});
