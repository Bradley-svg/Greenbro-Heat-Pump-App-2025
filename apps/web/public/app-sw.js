/* App SW: update prompts + light caching */
const CACHE = 'gb-app-v1';
const PRECACHE = ['/', '/overview', '/m', '/brand.css', '/brand/logo-white.svg', '/brand/manifest.webmanifest', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE) {
            return caches.delete(key);
          }
          return undefined;
        }),
      );
      self.clients.claim();
    })(),
  );
});

// Network-first for app pages; cache-first for brand + CSS
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') {
    return;
  }

  // brand & CSS: cache-first
  if (/^\/brand(\/|$)/.test(url.pathname) || url.pathname.endsWith('.css')) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // app routes: network-first with offline fallback
  if (['/', '/overview', '/m', '/login', '/alerts', '/devices'].some((path) => url.pathname.startsWith(path))) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match('/offline')),
      ),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
