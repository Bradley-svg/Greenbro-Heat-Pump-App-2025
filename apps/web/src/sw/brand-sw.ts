/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;
const PRECACHE = ['/_app/brand.css', '/brand/logo.svg', '/brand/logo-white.svg', '/brand/logo-mono.svg'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('brand').then((cache) => cache.addAll(PRECACHE)).catch(() => undefined),
  );
});

sw.addEventListener('activate', () => {
  // noop - no upgrade logic yet
});

sw.addEventListener('fetch', (event) => {
  const fetchEvent = event as FetchEvent;
  const url = new URL(fetchEvent.request.url);
  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith('/brand/')) {
    fetchEvent.respondWith(
      (async () => {
        const cached = await caches.match(fetchEvent.request);
        const fresh = fetch(fetchEvent.request).then((response) => {
          const copy = response.clone();
          void caches.open('brand').then((cache) => cache.put(fetchEvent.request, copy));
          return response;
        });
        return cached ?? fresh;
      })(),
    );
  }
});
