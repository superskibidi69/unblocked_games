const CACHE_NAME = 'unblocked-games-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/suika/index.html',
  '/offline.html',
  '/404.html',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(()=>{}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));
      await self.clients.claim();
    })()
  );
});

// Try to fetch and cache a request. If successful, cache the response (opaque responses allowed).
async function fetchAndCache(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // Cache successful responses (200) and opaque (0) responses from cross-origin.
    if (response && (response.status === 200 || response.type === 'opaque' || response.status === 0)) {
      try { await cache.put(request, response.clone()); } catch (e) { /* ignore quota errors */ }
    }
    return response;
  } catch (err) {
    return null;
  }
}

// Navigation fallback: prefer network (and cache result), fall back to cached navigation or offline page.
async function respondWithNavigationFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const netResp = await fetch(request);
    if (netResp && netResp.status === 404) {
      return cache.match('/404.html') || netResp;
    }
    // cache the navigation response
    try { await cache.put(request, netResp.clone()); } catch (e) {}
    return netResp;
  } catch (err) {
    // network failed — try to serve cached navigation or offline page
    return (await cache.match(request)) || (await cache.match('/offline.html')) || (await cache.match('/index.html'));
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return; // don't handle non-GET

  // Handle navigation requests separately
  if (request.mode === 'navigate') {
    event.respondWith(respondWithNavigationFallback(request));
    return;
  }

  // For all other GET requests: try cache first, otherwise network and cache; if network fails, return cached or fallback.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    // Not cached — try network and cache the result so it's available offline later.
    const networkResponse = await fetchAndCache(request);
    if (networkResponse) return networkResponse;

    // Network failed — try to return a suitable fallback
    if (request.destination === 'document') {
      return cache.match('/offline.html') || cache.match('/index.html') || new Response('offline', { status: 503 });
    }
    if (request.destination === 'image') {
      // Return a tiny SVG placeholder (inline) if image is unavailable
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" fill="#999" font-size="20" text-anchor="middle" dominant-baseline="middle">Offline</text></svg>';
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
    }

    // Generic fallback: try offline page or a plain response
    return cache.match('/offline.html') || new Response('offline', { status: 503 });
  })());
});

// Allow clients to ask the SW to prefetch and cache a list of URLs (useful for 'download for offline')
self.addEventListener('message', (event) => {
  if (!event.data) return;
  const { type, urls } = event.data;
  if (type === 'PRECACHE_URLS' && Array.isArray(urls)) {
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const u of urls) {
        try {
          const req = new Request(u, { mode: 'no-cors' });
          const resp = await fetch(req).catch(()=>null);
          if (resp) await cache.put(u, resp.clone()).catch(()=>{});
        } catch (e) { /* ignore individual errors */ }
      }
    });
  }
});
