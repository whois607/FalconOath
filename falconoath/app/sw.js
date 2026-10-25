/* FalconOath - offline shell (adapted from VPA's sw.js).

   Keeps the app's own files so FalconOath opens with no signal. The data
   lives in IndexedDB, not here. Service workers only run on a secure
   address (HTTPS, or localhost). The laptop stamps BUILD with a hash of the
   app files, so a changed app is a new worker that replaces this one on the
   next open. /api/ and /ping are never touched: sync always asks the laptop.

   Later (step 3), manuals get their own store, which an app update never
   deletes. */
const BUILD = "__BUILD__";
const CACHE = "falconoath-shell-" + BUILD;
const SHELL = ["/", "/app.js", "/app.css", "/lib/dtc.js", "/lib/idb.js", "/manifest.webmanifest",
               "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-192.png",
               "/icons/maskable-512.png", "/icons/favicon.png", "/icons/logo.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("falconoath-shell-") && k !== CACHE)
      .map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin
      || url.pathname.startsWith("/api/") || url.pathname === "/ping") return;
  const key = e.request.mode === "navigate" ? "/" : url.pathname;
  e.respondWith(caches.open(CACHE).then(c => c.match(key).then(hit => hit || fetch(e.request))));
});
