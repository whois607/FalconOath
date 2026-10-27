/* FalconOath - offline shell (adapted from VPA's sw.js).

   Keeps the app's own files so FalconOath opens with no signal. The data
   lives in IndexedDB, not here. Service workers only run on a secure
   address (HTTPS, or localhost). The laptop stamps BUILD with a hash of the
   app files, so a changed app is a new worker that replaces this one on the
   next open. /api/ and /ping go to the laptop: sync always asks it.

   The one exception: /api/manual/<sha> for a manual you chose to keep on
   this phone is answered from the "falconoath-manuals" cache, a byte range
   at a time (pdf.js reads big PDFs in pieces). An app update never deletes
   that cache. pdf.js's fonts are kept the first time they're used. */
const BUILD = "__BUILD__";
const CACHE = "falconoath-shell-" + BUILD;
const MANUALS = "falconoath-manuals";
const SHELL = ["/", "/app.js", "/garage.js", "/manuals.js", "/logs.js", "/prices.js", "/browse.js", "/factory.js", "/app.css", "/lib/dtc.js", "/lib/forscan.js", "/lib/idb.js",
               "/lib/manuals.js", "/lib/livelog.js", "/lib/brochure.js", "/lib/reference.js", "/lib/checker.js", "/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs", "/manifest.webmanifest",
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
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (/^\/api\/manual\/[0-9a-f]{64}$/.test(url.pathname)) { e.respondWith(kept(e.request, url.pathname)); return; }
  if (url.pathname.startsWith("/api/") || url.pathname === "/ping") return;
  if (url.pathname.startsWith("/vendor/pdfjs/standard_fonts/")) {
    e.respondWith(caches.open(CACHE).then(c => c.match(url.pathname).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) c.put(url.pathname, r.clone());
      return r;
    }))));
    return;
  }
  const key = e.request.mode === "navigate" ? "/" : url.pathname;
  e.respondWith(caches.open(CACHE).then(c => c.match(key).then(hit => hit || fetch(e.request))));
});

/* a kept manual, whole or the byte range asked for; otherwise the laptop */
async function kept(req, path) {
  const hit = await (await caches.open(MANUALS)).match(path);
  if (!hit) return fetch(req);
  const blob = await hit.blob(), size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("Range") || "");
  const head = { "Content-Type": "application/pdf", "Accept-Ranges": "bytes" };
  if (!m || (m[1] === "" && m[2] === "")) return new Response(blob, { status: 200, headers: Object.assign(head, { "Content-Length": String(size) }) });
  let a = m[1] === "" ? Math.max(0, size - +m[2]) : +m[1], b = m[1] !== "" && m[2] !== "" ? Math.min(+m[2], size - 1) : size - 1;
  if (a > b || a >= size) return new Response("", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(blob.slice(a, b + 1), { status: 206, headers: Object.assign(head, {
    "Content-Length": String(b - a + 1), "Content-Range": `bytes ${a}-${b}/${size}` }) });
}
