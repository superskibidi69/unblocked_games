// service-worker.js
const VERSION = 'hoybad';
const CACHE = `unblocked-games-${VERSION}`;
const SHELL = ['/', '/index.html', '/offline.html'];

self.addEventListener('install', e=>{
  self.skipWaiting();
  e.waitUntil((async()=>{
    const c = await caches.open(CACHE);
    await c.addAll(SHELL).catch(()=>{});
    try { await crawl(self.location.origin + '/'); } catch{}
  })());
});

self.addEventListener('activate', e=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    for(const k of keys) if(k!==CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function fetchAndPut(req){
  const c = await caches.open(CACHE);
  try{
    // If req is a Request object or a URL string, get the url
    const url = typeof req === 'string' ? req : req.url;
    const isExternal = new URL(url).origin !== self.location.origin;
    // For cross-origin resources use no-cors so opaque responses can be cached.
    const opts = isExternal ? { mode: 'no-cors' } : undefined;
    const r = await fetch(req, opts);
    if(r && (r.ok || r.type === 'opaque')) await c.put(req, r.clone());
    return r;
  }catch{return null;}
}

async function crawl(start){
  const seen=new Set(),queue=[start];
  const c=await caches.open(CACHE);
  const MAX=310;
  while(queue.length && seen.size<MAX){
    const u=queue.shift();
    if(!u||seen.has(u))continue;
    seen.add(u);
    let resp;
    try{
      // choose no-cors for cross-origin requests so we can cache opaque responses
      const parsed = new URL(u);
      const isExternal = parsed.origin !== self.location.origin;
      resp = await fetch(u, isExternal ? {mode:'no-cors'} : undefined);
    }catch{continue;}
    if(!resp)continue;
    if(resp.ok||resp.type==='opaque') try{await c.put(u,resp.clone());}catch{}
    const ct=resp.headers.get('content-type')||'';
    if(!ct.includes('text/html'))continue;
    // only attempt to read HTML text for same-origin or CORS-allowed responses
    const html = await resp.text().catch(()=>null);
    if(!html)continue;
    const re=/(?:href|src)=["']([^"'#> ]+)["']/gi;
    let m;
    while((m=re.exec(html))!==null){
      try{
        const abs = new URL(m[1], u).toString().split('#')[0];
        if(!abs.startsWith('http')) continue;
        if(!seen.has(abs) && !queue.includes(abs)){
          // enqueue external and same-origin resources; external will be fetched with no-cors above
          queue.push(abs);
        }
      }catch{}
    }
  }
}

async function navFallback(req){
  const c=await caches.open(CACHE);
  try{
    const net=await fetch(req);
    try{await c.put(req,net.clone());}catch{}
    return net;
  }catch{
    return (await c.match(req))||c.match('/offline.html')||c.match('/index.html');
  }
}

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const isNavigate = req.mode === 'navigate';

  // Helper to trigger a background crawl of the origin root.
  const triggerCrawl = () => e.waitUntil((async()=>{
    try{ await crawl(self.location.origin + '/'); }catch{}
  })());

  if(isNavigate){
    // For navigation requests we try network first but refuse to serve redirect responses.
    e.respondWith((async()=>{
      const c = await caches.open(CACHE);
      const cached = await c.match(req);
      try{
        const net = await fetch(req);
        // If the network response was redirected (or a 3xx), don't return it to avoid navigation redirects.
        if(net && (net.redirected || (net.status>=300 && net.status<400))){
          // update cache in background and return cached or fallback
          triggerCrawl();
          return cached || c.match('/offline.html') || c.match('/index.html') || new Response('offline',{status:503});
        }
        // store whatever valid network response we got
        if(net && (net.ok || net.type==='opaque')){
          try{ await c.put(req, net.clone()); }catch{}
        }
        // after serving this navigation, kick off a full crawl in background so other pages get cached
        triggerCrawl();
        return net;
      }catch(err){
        // network failed: return cached or fallback, still trigger crawl attempt
        triggerCrawl();
        return cached || c.match('/offline.html') || c.match('/index.html') || new Response('offline',{status:503});
      }
    })());
    return;
  }

  // Non-navigation GETs: prefer cached to be fast, but always attempt to fetch-and-put in background
  e.respondWith((async()=>{
    const c = await caches.open(CACHE);
    const cached = await c.match(req);

    // Start a background fetch-and-put (will use no-cors for external origins)
    const bg = (async()=>{
      try{ await fetchAndPut(req); }catch{};
    })();
    // Also trigger a site-wide crawl in background so visiting a single page caches everything.
    triggerCrawl();

    // If we have cached content, return it immediately while bg caching continues.
    if(cached) return cached;

    // Otherwise wait for the network result from fetchAndPut
    const net = await (async()=>{
      try{
        const url = req.url;
        const isExternal = new URL(url).origin !== self.location.origin;
        const opts = isExternal ? { mode: 'no-cors' } : undefined;
        const r = await fetch(req, opts);
        return r;
      }catch{return null;}
    })();

    if(net){
      // do not return redirects to the client; prefer cached or fail
      if(net.redirected || (net.status>=300 && net.status<400)){
        return c.match(req) || new Response('',{status:503});
      }
      return net;
    }

    if(req.destination==='image'){
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
      <rect width="100%" height="100%" fill="#111"/>
      <text x="50%" y="50%" fill="#999" font-size="20" text-anchor="middle" dominant-baseline="middle">
      offline</text></svg>`;
      return new Response(svg,{headers:{'content-type':'image/svg+xml'}});
    }
    if(req.destination==='document')
      return c.match('/offline.html')||new Response('offline',{status:503});
    return new Response('',{status:503});
  })());
});

self.addEventListener('message',e=>{
  const d=e.data;
  if(!d) return;
  if(d.type==='PRECACHE_URLS'&&Array.isArray(d.urls)){
    caches.open(CACHE).then(async c=>{
      for(const u of d.urls){
        try{
          const r=await fetch(u,{mode:'no-cors'}).catch(()=>null);
          if(r) await c.put(u,r.clone());
        }catch{}
      }
    });
  }
});
