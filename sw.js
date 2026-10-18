// NomuHub CRM as an installed app (Anton, 18 Oct 2026). This service worker
// only exists so browsers can install the site: it caches nothing, so the
// installed app always shows the live dashboard and every deploy appears
// straight away. With no connection, a page load gets a small offline screen
// instead of the browser's error.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NomuHub CRM · offline</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#2099ac;font-family:Segoe UI,system-ui,sans-serif">
<div style="background:#fff;border-radius:20px;padding:30px;max-width:360px;text-align:center;color:#0f2f38">
<img src="/brand/icon-192.png" width="72" height="72" style="border-radius:14px" alt="">
<h1 style="font-size:20px;margin:14px 0 6px">You're offline</h1>
<p style="color:#557580;line-height:1.5;margin:0 0 18px">NomuHub CRM shows live data, so it needs an internet connection.</p>
<button onclick="location.reload()" style="padding:11px 22px;border:0;border-radius:10px;background:#2099ac;color:#fff;font-size:15px;font-weight:700;cursor:pointer">Try again</button>
</div></body>`;

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // everything else goes straight to the network
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
