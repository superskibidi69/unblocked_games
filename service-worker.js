const CACHE_NAME = 'unblocked-games-v1.0.0.1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/suika/index.html',
  '/offline.html',
  '/404.html',
  '/service-worker.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS).catch(()=>{});
    // After pre-caching the shell, crawl the site starting at root and cache same-origin resources.
    try {
      await crawlAndCache(self.location.origin + '/');
    } catch (e) {
      // swallow crawl errors to not fail install
    }
  })());
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

// Crawl same-origin HTML pages starting from a URL and cache discovered same-origin links.
// This is bounded to avoid runaway installs on very large sites.
async function crawlAndCache(startUrl) {
  const MAX_ENTRIES = 300; // safety bound
  const queue = [startUrl];
  const seen = new Set();
  const cache = await caches.open(CACHE_NAME);

  while (queue.length > 0 && seen.size < MAX_ENTRIES) {
    const url = queue.shift();
    if (!url) continue;
    // Only same-origin
    try {
      const parsed = new URL(url);
      if (parsed.origin !== self.location.origin) continue;
    } catch (e) { continue; }

    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const req = new Request(url, { method: 'GET', credentials: 'same-origin' });
      const resp = await fetch(req).catch(()=>null);
      if (!resp) continue;

      // Cache the response if it's successful or opaque
      try { if (resp.status === 200 || resp.type === 'opaque' || resp.status === 0) await cache.put(url, resp.clone()).catch(()=>{}); } catch (e) {}

      const contentType = resp.headers && resp.headers.get ? resp.headers.get('content-type') || '' : '';
      if (contentType.indexOf('text/html') !== -1) {
        // Read HTML and extract links (href/src)
        const text = await resp.text().catch(()=>'');
        if (!text) continue;
        // crude regex to find href/src values
        const re = /(?:href|src)=(?:"|')([^"'#> ]+)(?:"|')/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const raw = m[1];
          try {
            const abs = new URL(raw, url).toString();
            // only queue same-origin and within site root
            if (abs.startsWith(self.location.origin)) {
              // strip hash; keep query
              const normalized = abs.split('#')[0];
              if (!seen.has(normalized) && !queue.includes(normalized)) {
                queue.push(normalized);
              }
            }
          } catch (e) { /* ignore bad URLs */ }
        }
      }
    } catch (e) {
      // ignore and continue
    }
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
