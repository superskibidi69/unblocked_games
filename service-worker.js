// service-worker.js
const VERSION = '1.2.0.3';
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
    const r = await fetch(req);
    if(r && (r.ok || r.type==='opaque')) await c.put(req, r.clone());
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
    try{resp=await fetch(u);}catch{continue;}
    if(!resp)continue;
    if(resp.ok||resp.type==='opaque') try{await c.put(u,resp.clone());}catch{}
    const ct=resp.headers.get('content-type')||'';
    if(!ct.includes('text/html'))continue;
    const html=await resp.text().catch(()=>null);
    if(!html)continue;
    const re=/(?:href|src)=["']([^"'#> ]+)["']/gi;
    let m;
    while((m=re.exec(html))!==null){
      try{
        const abs=new URL(m[1],u).toString().split('#')[0];
        if(abs.startsWith(self.location.origin)&&!seen.has(abs)&&!queue.includes(abs))
          queue.push(abs);
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

  if(req.mode==='navigate'){
    e.respondWith(navFallback(req));
    return;
  }

  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    const cached=await c.match(req);
    if(cached) return cached;
    const net=await fetchAndPut(req);
    if(net) return net;

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
