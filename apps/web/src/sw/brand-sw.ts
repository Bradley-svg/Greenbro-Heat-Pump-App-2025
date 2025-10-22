/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => {
  // noop - we only care about fetch events
});

sw.addEventListener('activate', () => {
  // noop - no upgrade logic yet
});

sw.addEventListener('fetch', (event) => {
  const fetchEvent = event as FetchEvent;
  const url = new URL(fetchEvent.request.url);
  if (url.pathname.startsWith('/brand/')) {
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
