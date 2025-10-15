// service-worker.js
const VERSION = 'v2-immediate-dasdasr-all';
const CACHE = `unblocked-games-${VERSION}`;
const SHELL = ['/', '/index.html'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL).catch(() => {});
    
    // IMMEDIATELY START CRAWLING EVERYTHING FROM ROOT
    console.log('INSTALL: Starting immediate recursive crawl of everything...');
    try {
      await crawl(self.location.origin + '/');
      console.log('INSTALL: Recursive crawl completed');
    } catch (err) {
      console.log('INSTALL: Crawl completed with some issues', err);
    }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    for (const k of keys) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    
    // Tell all clients we're ready
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SW_READY',
        message: 'Service Worker activated and ready to serve offline'
      });
    });
  })());
});

async function crawl(startUrl) {
  const seen = new Set();
  const queue = [startUrl];
  const c = await caches.open(CACHE);
  
  console.log('CRAWL: Starting from', startUrl);
  
  // Very high limit to cache everything
  const MAX_URLS = 50000;
  let crawledCount = 0;
  
  while (queue.length > 0 && seen.size < MAX_URLS) {
    const url = queue.shift();
    
    if (!url || seen.has(url)) continue;
    seen.add(url);
    crawledCount++;
    
    if (crawledCount % 50 === 0) {
      console.log(`CRAWL: Progress - ${crawledCount} URLs processed`);
    }
    
    try {
      const urlObj = new URL(url);
      const isExternal = urlObj.origin !== self.location.origin;
      
      // For same-origin, try normally first, then no-cors as fallback
      let response;
      if (!isExternal) {
        try {
          response = await fetch(url, { 
            mode: 'cors',
            credentials: 'include',
            cache: 'no-cache'
          });
        } catch {
          response = await fetch(url, { mode: 'no-cors' });
        }
      } else {
        response = await fetch(url, { mode: 'no-cors' });
      }
      
      if (response && (response.ok || response.type === 'opaque')) {
        await c.put(url, response.clone());
        
        // Only parse HTML for same-origin to find more links
        if (!isExternal && response.headers.get('content-type')?.includes('text/html')) {
          try {
            const html = await response.text();
            const links = extractUrls(html, url);
            
            for (const link of links) {
              if (!seen.has(link) && !queue.includes(link)) {
                queue.push(link);
              }
            }
          } catch {
            // Skip HTML parsing if it fails
          }
        }
      }
    } catch (error) {
      // Continue with next URL even if one fails
      continue;
    }
  }
  
  console.log(`CRAWL: Completed! Processed ${crawledCount} URLs`);
}

function extractUrls(html, baseUrl) {
  const urls = new Set();
  
  // Match href attributes
  const hrefRegex = /href=["']([^"'\s#>]+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const absoluteUrl = new URL(match[1], baseUrl).toString().split('#')[0];
      if (absoluteUrl.startsWith('http')) {
        urls.add(absoluteUrl);
      }
    } catch {}
  }
  
  // Match src attributes  
  const srcRegex = /src=["']([^"'\s#>]+)["']/gi;
  while ((match = srcRegex.exec(html)) !== null) {
    try {
      const absoluteUrl = new URL(match[1], baseUrl).toString().split('#')[0];
      if (absoluteUrl.startsWith('http')) {
        urls.add(absoluteUrl);
      }
    } catch {}
  }
  
  // Match action attributes (forms)
  const actionRegex = /action=["']([^"'\s#>]+)["']/gi;
  while ((match = actionRegex.exec(html)) !== null) {
    try {
      const absoluteUrl = new URL(match[1], baseUrl).toString().split('#')[0];
      if (absoluteUrl.startsWith('http')) {
        urls.add(absoluteUrl);
      }
    } catch {}
  }
  
  // Match CSS url() values
  const cssUrlRegex = /url\(["']?([^"')]+)["']?\)/gi;
  while ((match = cssUrlRegex.exec(html)) !== null) {
    try {
      const absoluteUrl = new URL(match[1], baseUrl).toString().split('#')[0];
      if (absoluteUrl.startsWith('http')) {
        urls.add(absoluteUrl);
      }
    } catch {}
  }
  
  return Array.from(urls);
}

self.addEventListener('fetch', e => {
  const request = e.request;
  
  // Skip non-GET requests
  if (request.method !== 'GET') return;
  
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    
    // Always try cache first for maximum offline performance
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Background update from network
      e.waitUntil((async () => {
        try {
          const networkResponse = await fetch(request);
          if (networkResponse.ok || networkResponse.type === 'opaque') {
            await cache.put(request, networkResponse.clone());
          }
        } catch {
          // Ignore network errors for background update
        }
      })());
      
      return cachedResponse;
    }
    
    // If not in cache, try network
    try {
      const networkResponse = await fetch(request);
      
      // Cache successful responses
      if (networkResponse.ok || networkResponse.type === 'opaque') {
        await cache.put(request, networkResponse.clone());
      }
      
      return networkResponse;
    } catch (error) {
      // Network failed - try to find alternative in cache
      
      // For navigation requests, try index.html as fallback
      if (request.mode === 'navigate') {
        const fallback = await cache.match('/index.html') || 
                         await cache.match('/') ||
                         new Response('Offline - no cached content available', {
                           status: 503,
                           headers: { 'Content-Type': 'text/plain' }
                         });
        return fallback;
      }
      
      // For other requests, return appropriate fallback
      if (request.destination === 'image') {
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
            <rect width="100%" height="100%" fill="#ccc"/>
            <text x="50%" y="50%" font-family="Arial" font-size="10" text-anchor="middle" dy=".3em">❌</text>
           </svg>`,
          { headers: { 'Content-Type': 'image/svg+xml' } }
        );
      }
      
      return new Response('Network error', { 
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  })());
});

// Handle messages from main page
self.addEventListener('message', e => {
  const data = e.data;
  if (!data) return;
  
  if (data.type === 'PRECACHE_URLS' && Array.isArray(data.urls)) {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      for (const url of data.urls) {
        try {
          const response = await fetch(url, { mode: 'no-cors' });
          if (response) await cache.put(url, response.clone());
        } catch {}
      }
    })());
  }
  
  if (data.type === 'GET_CACHE_STATUS') {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const keys = await cache.keys();
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'CACHE_STATUS',
          count: keys.length,
          urls: keys.map(req => req.url)
        });
      });
    })());
  }
});