// Minimal app shell: improves installability, not a persistent background media service.
const CACHE='roomwave-shell-v3';
const SHELL=['/','/index.html','/styles.css','/app.js','/room-utils.mjs','/media-utils.mjs','/youtube-utils.mjs','/media-session.mjs','/favicon.svg','/manifest.webmanifest'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  // Network-first avoids stale rooms and prevents storing streamed audio, chat or third-party content.
  event.respondWith(fetch(req).catch(async()=>{
    if(req.mode==='navigate')return await caches.match('/index.html')||Response.error();
    return await caches.match(req)||Response.error();
  }));
});
