/* FalconOath - the app (phone and laptop alike).

   Screens are hash routes (#/, #/search?q=, #/code/P0325, #/settings;
   cars and scans are in garage.js, manuals in manuals.js). The
   data copy comes from the laptop (/api/snapshot), is kept in IndexedDB and
   is all the app reads, so everything works with no signal. Sync and
   pairing follow VPA's phone app. Lookup logic lives in lib/dtc.js. */
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = encodeURIComponent;
const NUM = new Intl.NumberFormat("en-AU");
const n0 = v => v == null ? "–" : NUM.format(v);
const FORMATS = ["falconoath-snap/1", "falconoath-snap/2", "falconoath-snap/3", "falconoath-snap/4", "falconoath-snap/5"];   // /1: no cars or scans; /3 adds logs; /4 prices; /5 trims
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const TS_LINK = "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;" +
  "package=com.tailscale.ipn;S.browser_fallback_url=" +
  enc("https://play.google.com/store/apps/details?id=com.tailscale.ipn") + ";end";

/* Australian dates: "2026-10-25 18:12:02" -> 25/10/2026 (18:12) */
const pad2 = n => String(n).padStart(2, "0");
const dAU = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "–";
const dtAU = s => s ? `${dAU(s)} ${s.slice(11, 16)}` : "–";
const localIso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return dtAU(localIso(new Date(iso)));
}
function toast(msg, ms) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms || 2600);
}
const LS = {
  get(k) { try { return localStorage.getItem("falconoath." + k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("falconoath." + k) : localStorage.setItem("falconoath." + k, v); } catch (e) {} },
};
function withTimeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

/* ------------------------------------------------------------ data */
let DB = null;              // FO_DTC.index(snapshot)
function useSnapshot(snap) {
  DB = FO_DTC.index(snap);
  if (typeof GARAGE !== "undefined") GARAGE.cache = null;
}
const MODELS = [["ALL", "All"], ["BA", "BA"], ["BF", "BF"], ["FG", "FG"], ["FGX", "FG X"]];
function model() { const m = LS.get("model"); return MODELS.some(x => x[0] === m) ? m : "ALL"; }
const modelName = m => (MODELS.find(x => x[0] === m) || [m, m])[1];
function modelSeg(cur) {
  return `<div class="seg" role="group" aria-label="Model">${MODELS.map(([k, l]) =>
    `<button data-model="${k}" class="${cur === k ? "on" : ""}" aria-pressed="${cur === k}">${l}</button>`).join("")}</div>`;
}
function wireModelSeg() {
  document.querySelectorAll("[data-model]").forEach(b => b.onclick = () => {
    LS.set("model", b.dataset.model); render(true);
  });
}

/* ------------------------------------------------------------ sync */
const SYNC = { busy: false, state: LS.get("token") ? "idle" : "unpaired", error: null,
               lastOk: LS.get("lastOk"), lastTry: null };
async function sync(manual) {
  const token = LS.get("token");
  if (!token) { SYNC.state = "unpaired"; pill(); return; }
  if (SYNC.busy) return;
  SYNC.busy = true; SYNC.lastTry = Date.now(); pill();
  const H = { Authorization: "Bearer " + token };
  try {
    const r = await fetch("/api/meta", { headers: H, cache: "no-store", signal: withTimeout(8000) });
    if (r.status === 401 && LAUNCH.code) { SYNC.busy = false; if (await pairLaunch()) return; }    // FalconOath's window: pair again by itself
    if (r.status === 401) { SYNC.state = "removed"; SYNC.error = null; return; }
    if (r.status === 429) { SYNC.state = "error"; SYNC.error = "the laptop is refusing for ten minutes after too many failed attempts"; return; }
    const meta = await r.json();
    if (!meta.ok) { SYNC.state = "error"; SYNC.error = meta.error; return; }
    LS.set("laptopWin", meta.laptop ? "1" : null);
    const sent = await outboxSend(H);              // new cars and scans go first
    if (sent) {                                    // the laptop applies them in a few seconds
      clearTimeout(SYNC.followT);
      SYNC.followT = setTimeout(() => sync(false), 7000);
      setTimeout(() => { if (OUTBOX.some(o => !o.result)) sync(false); }, 20000);
    }
    const have = DB && DB.snap.version;
    if (meta.version !== have) {
      SYNC.state = "downloading"; pill();
      const s = await fetch("/api/snapshot", { headers: Object.assign({}, H, have ? { "If-None-Match": `"${have}"` } : {}),
                                               cache: "no-store", signal: withTimeout(120000) });
      if (s.status !== 200) throw new Error("the laptop answered " + s.status);
      const snap = await s.json();
      // check before replacing: a copy that doesn't match its description is not kept
      if (!FORMATS.includes(snap.format) || snap.version !== meta.version || !Array.isArray(snap.dtc)
          || snap.dtc.length !== meta.counts.dtc || snap.counts.dtc !== meta.counts.dtc
          || (snap.cars || []).length !== (meta.counts.cars || 0) || (snap.scans || []).length !== (meta.counts.scans || 0)
          || (snap.logs || []).length !== (meta.counts.logs || 0) || (snap.trims || []).length !== (meta.counts.trims || 0)
          || (snap.facts || []).length !== (meta.counts.facts || 0))
        throw new Error("the copy did not match its description - kept the one you had");
      const first = !DB;
      await FO_IDB.put("snap", snap);
      useSnapshot(snap);
      const notes = await outboxSettle(snap), fresh = forscanNew(snap);
      toast(notes.length ? notes.join(" · ") : first ? `Downloaded ${n0(snap.counts.dtc)} fault code entries` : "Data updated", notes.length ? 5000 : 2600);
      if (!pullUp(fresh)) rerender();
    }
    if (OUTBOX.some(o => BIG.includes(o.kind) && !o.uploaded && !o.result)) pumpUploads();   // PDFs and logs: in the background
    if (meta.library && (!LIB || LIB.lib.version !== meta.library.version)) { SYNC.state = "downloading"; pill(); }
    if (await syncLibrary(H, meta)) rerender();
    syncLogs(H);                                   // every log onto this device, in the background
    SYNC.state = "ok"; SYNC.error = null; SYNC.lastOk = new Date().toISOString(); LS.set("lastOk", SYNC.lastOk);
    LS.set("device", meta.device || "");
  } catch (e) {
    // no signal at all -> "offline" (normal in a shed, said quietly);
    // signal but no laptop -> "unreachable": Tailscale off, or the laptop asleep
    const net = navigator.onLine === false;
    SYNC.state = net ? "offline" : (e.name === "AbortError" || e instanceof TypeError) ? "unreachable" : "error";
    SYNC.error = e.name === "AbortError" ? "the laptop did not answer in time" : String(e.message || e);
    if (manual) toast(SYNC.state === "error" ? "Sync failed: " + SYNC.error
      : SYNC.state === "unreachable" ? (onLaptop() ? "FalconOath has stopped - open it again from its icon" : "Can't reach the laptop - is Tailscale on?")
      : "No signal - using the copy on this device", 3500);
  } finally {
    SYNC.busy = false; pill();
    if (/^#\/?(settings|cars|car|scan)?(\/|\?|$)/.test(location.hash || "#/") && !typing()) render(true);
    if (SYNC.state === "ok") waitLoop();
  }
}

/* News from the laptop while the app is open: one request held open until
   the data changes (/api/wait), then a sync. So a scan or log FORScan has
   just saved shows here within a few seconds, not at the next sync. */
let WAITING = false;
async function waitLoop() {
  if (WAITING || self.FO_TEST) return;
  WAITING = true;
  try {
    while (document.visibilityState === "visible" && LS.get("token") && DB) {
      const v = DB.snap.version, lv = LIB ? LIB.lib.version : "";
      let changed = false;
      try {
        const r = await fetch(`/api/wait?v=${enc(v)}&lv=${enc(lv)}`, { headers: { Authorization: "Bearer " + LS.get("token") },
                                                                       cache: "no-store", signal: withTimeout(40000) });
        if (!r.ok) break;                                    // unpaired, or an older laptop without it: syncs as before
        changed = !!(await r.json()).changed;
      } catch (e) { await new Promise(res => setTimeout(res, 15000)); continue; }   // no signal: try again shortly
      if (changed) {
        await sync(false);
        if (DB && DB.snap.version === v) await new Promise(res => setTimeout(res, 3000));   // didn't take: don't spin
      }
    }
  } finally {
    WAITING = false;
  }
}

/* What came in from FORScan's folder since this device last looked, newest
   last. The first time, everything already there counts as seen; and only
   files FORScan saved today or yesterday count as new. */
function forscanNew(snap) {
  const all = [].concat(
    (snap.scans || []).filter(s => s.origin === "forscan-folder").map(s => ({ kind: "scan", id: s.id, name: s.file_name, at: s.imported_at, on: s.scanned_on })),
    (snap.logs || []).filter(l => l.origin === "forscan-folder").map(l => ({ kind: "log", id: l.id, name: l.file_name, at: l.imported_at, on: l.recorded_on })));
  const raw = LS.get("forscanSeen");
  let seen = null;
  try { seen = raw ? new Set(JSON.parse(raw)) : null; } catch (e) {}
  const firstTime = !seen;
  if (firstTime) seen = new Set();
  const d = new Date(Date.now() - 86400000), since = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fresh = firstTime ? [] : all.filter(x => !seen.has(x.id) && String(x.on || "") >= since)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  all.forEach(x => seen.add(x.id));
  LS.set("forscanSeen", JSON.stringify(Array.from(seen).slice(-2000)));
  return fresh;
}
/* open the newest of them, unless something is being typed or filled in
   (then just say so). Returns true if it opened one. */
function pullUp(fresh) {
  if (!fresh.length) return false;
  const x = fresh[fresh.length - 1], more = fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : "";
  const what = x.kind === "log" ? "live-data log" : "fault scan";
  const busy = typing() || /^#\/(upload|newcar|addmanual|brochure\/)/.test(location.hash) || document.visibilityState === "hidden";
  if (busy) { toast(`New ${what} from FORScan: ${x.name}${more}. It's under Cars.`, 6000); return false; }
  location.hash = `#/${x.kind}/${enc(x.id)}`;
  toast(`New ${what} from FORScan: ${x.name}${more}`, 5000);
  return true;
}
/* redraw after new data, except on a screen with a form being filled in,
   or while something is being typed */
const typing = () => !!(document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName || ""));
function rerender() { if (!/^#\/(upload|newcar|search|addmanual|manual\/|brochure\/)/.test(location.hash) && !typing()) render(true); }
function pill() {
  const p = $("pill"); if (!p) return;
  const s = SYNC.state, data = DB ? DB.snap.built : null;
  let cls = "off", txt;
  if (SYNC.busy) { cls = "busy"; txt = SYNC.state === "downloading" ? "Downloading…" : "Syncing…"; }
  else if (s === "unpaired") { cls = "warn"; txt = "Not paired"; }
  else if (s === "removed") { cls = "warn"; txt = "Pair again"; }
  else if (s === "ok") { cls = "ok"; txt = "Synced " + ago(SYNC.lastOk); }
  else if (s === "offline") { txt = "Offline · " + (data ? dAU(data) : "no data"); }
  else if (s === "unreachable" && onLaptop()) { cls = "warn"; txt = "FalconOath stopped"; }
  else if (s === "unreachable") { txt = "Not synced · " + (data ? dAU(data) : "no data"); }
  else if (s === "error") { cls = "bad"; txt = "Sync failed"; }
  else txt = data ? "Data " + dAU(data) : "…";
  p.className = "pill " + cls; p.querySelector("span").textContent = txt;
}
let syncTimer = null, retryT = null;

/* ------------------------------------------------------------ the laptop
   FalconOath.exe opens its own window at /?pair=<one-time code>: the window
   pairs itself with it as "This laptop" (and again if that pairing is ever
   removed, while the code is fresh). On the laptop, "can't reach the laptop"
   means FalconOath has stopped. */
const LAUNCH = { code: null };
const onLaptop = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname || "");
function takeLaunchCode() {
  const m = /[?&]pair=([A-Za-z0-9_-]{8,64})/.exec(location.search || "");
  if (!m) return;
  LAUNCH.code = m[1];
  try { history.replaceState(null, "", "/" + (location.hash || "#/")); } catch (e) {}     // out of the address (and history)
}
async function pairLaunch() {
  const code = LAUNCH.code;
  LAUNCH.code = null;                                  // one try: it's single use
  if (!code) return false;
  try {
    const r = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, launch: true }), signal: withTimeout(10000) }).then(x => x.json());
    if (!r.ok) return false;
    LS.set("token", r.token); LS.set("device", r.device.name); SYNC.state = "idle";
    setTimeout(() => sync(false), 0);
    return true;
  } catch (e) { return false; }
}
function autoSync() {
  sync(false);
  clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (document.visibilityState === "visible") { sync(false); waitLoop(); } }, 5 * 60 * 1000);
}

/* ------------------------------------------------------------ routing */
const ROUTES = {};
function route(path, opt, fn) { ROUTES[path] = Object.assign({ fn }, opt); }
function parseHash() {
  const h = (location.hash || "#/").slice(1) || "/";
  const [p, qs] = h.split("?");
  const parts = p.split("/").filter(Boolean);
  const path = "/" + (parts[0] || ""), arg = parts.slice(1).map(decodeURIComponent).join("/");
  const q = {};
  (qs || "").split("&").filter(Boolean).forEach(kv => { const i = kv.indexOf("=");
    q[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")); });
  return { path, arg, q };
}
function noData() {
  const paired = !!LS.get("token");
  return `<div class="card"><h2>No data on this device yet</h2>
    <p class="sub">${paired ? "It downloads from the laptop on the next sync. The laptop must be on, with FalconOath running and Tailscale on."
      : "Pair this device with the laptop first. After that it works with no signal."}</p>
    <a class="btn primary block" href="#/settings">${paired ? "Sync now" : "Pair this device"}</a></div>`;
}
/* the HTML for a route (used by render, and by tests/js_check.js) */
function screen(hash) {
  if (hash != null) location.hash = hash;
  const r = parseHash(), R = ROUTES[r.path] || ROUTES["/"];
  return { R, r, html: R.needsData && !DB ? noData() : R.fn(r) };
}
function render(keepScroll) {
  const y = window.scrollY, s = screen();
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === s.R.tab));
  $("back").hidden = !s.R.back;
  $("main").innerHTML = s.html;
  $("main").classList.toggle("wide", !!s.R.wide);
  document.title = s.R.title ? s.R.title(s.r) + " · FalconOath" : "FalconOath";
  if (s.R.after && (!s.R.needsData || DB)) s.R.after(s.r);
  window.scrollTo(0, keepScroll ? y : 0);
}

/* ------------------------------------------------------------ home */
const IC = {
  browse: '<svg viewBox="0 0 24 24"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"/></svg>',
  price: '<svg viewBox="0 0 24 24"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 11h6"/></svg>',
};
route("/", { tab: "home" }, () => {
  const S = DB ? DB.snap : null;
  return `<section class="hero"><h1>FalconOath</h1><p>BA · BF · FG · FG X</p>
    <form id="homeQ" role="search"><input id="hq" type="search" placeholder="Fault code, e.g. P0325" autocomplete="off"
      autocapitalize="characters" enterkeyhint="search" aria-label="Fault code or words"><button class="btn primary">Look up</button></form></section>
    <div class="tiles">
      <a class="tile" href="#/browse">${IC.browse}<b>Browse</b><span>Trims, engines, options and colours from your brochures</span><span class="badge">${
        S && (S.trims || []).length ? n0(S.trims.length) + " trim" + (S.trims.length === 1 ? "" : "s") : "From brochures"}</span></a>
      <a class="tile" href="#/prices">${IC.price}<b>Prices</b><span>What BA to FG X Falcons are asking</span><span class="badge">${
        S && S.prices && S.prices.models && S.prices.models.FG ? "FG " + money(S.prices.models.FG.median) : "From VPA"}</span></a>
      <a class="tile" href="#/search">${IC.search}<b>Search</b><span>Fault codes, and your manuals' pages</span><span class="badge">Fault codes</span></a>
      <a class="tile" href="#/upload">${IC.upload}<b>Upload</b><span>FORScan fault scans and live-data logs</span><span class="badge">Scans · logs</span></a>
      <a class="tile" href="#/manuals">${IC.book}<b>Manuals</b><span>Your own PDFs, searchable offline</span><span class="badge">${
        LIB && LIB.manuals.length ? n0(LIB.manuals.length) + " manual" + (LIB.manuals.length === 1 ? "" : "s") : "Add yours"}</span></a>
    </div>${recentScansHtml()}
    <div class="card">${S ? `<div class="spread"><h2>On this device</h2><span class="faint">${dAU(S.built)}</span></div>
      <p class="sub">${n0(S.counts.dtc)} fault code entries for ${n0(S.counts.codes)} codes (BA, BF, FG; FG X reads FG's).</p>`
      : `<h2>No data yet</h2><p class="sub">${LS.get("token") ? "Waiting for the first sync from the laptop." : "Pair this device with the laptop to download the data."}</p>
         <a class="btn primary" href="#/settings">Settings</a>`}</div>`;
});
ROUTES["/"].after = () => {
  $("homeQ").onsubmit = e => { e.preventDefault(); const v = $("hq").value.trim();
    const c = FO_DTC.normCode(v);
    location.hash = c && DB && DB.byCode.has(c) ? "#/code/" + c : "#/search?q=" + enc(v); };
};

function recentScansHtml() {
  const g = garage();
  const ss = Array.from(g.scans.values()).sort((a, b) => scanWhen(b).localeCompare(scanWhen(a)) ||
    String(b.imported_at).localeCompare(String(a.imported_at))).slice(0, 3);
  if (!ss.length) return "";
  return `<div class="card"><div class="spread"><h2>Recent scans</h2><a href="#/cars" class="note" style="margin:0">All cars</a></div><ul class="list">${ss.map(s => {
    const p = parsedScan(s);
    return `<li><a href="#/scan/${enc(s.id)}"><span class="d"><b>${esc(carName(g.cars.get(s.car_id)))}</b>${pendingBadge(s)}<small>${dAU(scanWhen(s))}</small></span>
      <span style="text-align:right">${countChips(p)}</span>${CHEV}</a></li>`;
  }).join("")}</ul></div>`;
}

/* ------------------------------------------------------------ search */
function hl(text, words) {
  let s = String(text || "");
  if (!words.length) return esc(s);
  const re = new RegExp("(" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
  return s.split(re).map((part, i) => i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join("");
}
/* the codes, then the manual pages that mention it */
function searchResultsHtml(q, m) {
  return `<div class="card">${resultsHtml(q, m)}</div>${q.trim() ? manualHitsCard(q, 4) : ""}`;
}
function resultsHtml(q, m) {
  if (!q.trim()) return `<p class="empty">Type a code (P0325, p325, 0325) or words (knock sensor).</p>`;
  const res = FO_DTC.search(DB, q, m), words = /\d/.test(q) ? [] : q.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (!res.length) {
    const any = m !== "ALL" ? FO_DTC.search(DB, q, "ALL").length : 0;
    return `<p class="empty">Nothing for “${esc(q)}”${m !== "ALL" ? ` on ${esc(modelName(m))}` : ""}.${any ?
      ` <a href="#" data-model-all>Show all models (${any})</a>` : ""}</p>`;
  }
  return `<p class="note" style="margin:0 0 4px">${res.length === 80 ? "First 80" : n0(res.length)} code${res.length === 1 ? "" : "s"}${
    m !== "ALL" ? " · " + esc(modelName(m)) + (m === "FGX" ? " (from FG data)" : "") : ""}</p>
    <ul class="list">${res.map(x => {
      const r = x.rows[0], models = Array.from(new Set(x.rows.map(y => y.model)));
      return `<li><a href="#/code/${enc(x.code)}"><span class="codeTag">${esc(x.code)}</span><span class="d">${hl(r.description, words)}
        <small>${models.join(" · ")}${x.rows.length > models.length ? ` · ${x.rows.length} entries` : ""}${r.qualifier ? " · " + esc(r.qualifier) : ""}</small></span>${CHEV}</a></li>`;
    }).join("")}</ul>`;
}
route("/search", { tab: "search", needsData: true, title: () => "Search" }, r => {
  const q = r.q.q || "", m = model();
  return `<div class="card"><input id="q" class="text" type="search" value="${esc(q)}" placeholder="Fault code or words"
      autocomplete="off" autocapitalize="characters" enterkeyhint="search" aria-label="Fault code or words">
    <div style="margin-top:10px">${modelSeg(m)}</div></div>
    <div id="res">${searchResultsHtml(q, m)}</div>`;
});
ROUTES["/search"].after = r => {
  wireModelSeg();
  const inp = $("q"), res = $("res");
  const wireAll = () => { const a = res.querySelector("[data-model-all]");
    if (a) a.onclick = e => { e.preventDefault(); LS.set("model", "ALL"); render(true); }; };
  wireAll();
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    res.innerHTML = searchResultsHtml(inp.value, model()); wireAll();
    history.replaceState(null, "", "#/search" + (inp.value ? "?q=" + enc(inp.value) : ""));
  }, 120); };
  inp.onkeydown = e => { if (e.key === "Enter") { inp.blur(); } };
  if (!r.q.q && matchMedia("(min-width: 700px)").matches) inp.focus();
};

/* ------------------------------------------------------------ one code */
const SECTS = [["mechanical", "Mechanical"], ["sensor", "Sensor"], ["electrical", "Electrical"], ["other", "Other / what to do"]];
function rowHtml(r, i, n) {
  return `<div class="${i ? "sect" : ""}" style="${i ? "border-top:1px solid var(--line);padding-top:12px" : ""}">
    ${n > 1 ? `<div class="faint" style="font-size:12px">Entry ${i + 1} of ${n}</div>` : ""}
    <div class="desc">${esc(r.description)}${r.qualifier ? ` <span class="badge">${esc(r.qualifier)}</span>` : ""}</div>
    ${SECTS.filter(([k]) => r[k]).map(([k, l]) => `<div class="sect"><h3>${l}</h3><p>${esc(r[k])}</p></div>`).join("")}
    ${SECTS.every(([k]) => !r[k]) ? `<p class="note">No further notes for this entry.</p>` : ""}</div>`;
}
function byModel(rows) {
  const g = {};
  rows.forEach(r => { (g[r.model] = g[r.model] || []).push(r); });
  return Object.keys(g).sort().map(k => [k, g[k]]);
}
route("/code", { tab: "search", back: true, needsData: true, title: r => r.arg.toUpperCase() }, r => {
  // opened from a scan's fault: that fault, and its car's model rather than the one chosen here
  const sf = scanFault(r.q), fromScan = sf && sf.f.code === FO_DTC.normCode(r.arg) ? sf : null;
  const m = (fromScan && fromScan.carModel) || model(), L = FO_DTC.lookup(DB, r.arg, m), sys = FO_DTC.SYSTEMS[L.code[0]];
  let h = fromScan ? scanFaultCard(fromScan) : "";
  h += `<div class="card"><div class="codeHead"><span class="code">${esc(L.code)}</span>
    ${sys ? `<span class="badge sys">${sys}</span>` : ""}
    ${m !== "ALL" ? `<span class="badge">${esc(modelName(m))}</span>` : ""}
    ${L.fallback && L.rows.length ? `<span class="badge alt">from ${esc(L.viaModel)} data</span>` : ""}</div>`;
  if (L.rows.length) {
    if (L.fallback) h += `<p class="note">There is no ${esc(modelName(m))} list yet, so these are the ${esc(L.viaModel)} entries. Most FG X codes match the FG's.</p>`;
    if (m === "ALL") h += byModel(L.rows).map(([mo, rows]) => `<div class="sect" style="margin-top:16px"><span class="badge">${esc(mo)}</span>${
      rows.map((x, i) => rowHtml(x, i, rows.length)).join("")}</div>`).join("");
    else h += L.rows.map((x, i) => rowHtml(x, i, L.rows.length)).join("");
  } else if (L.others.length) {
    h += `<p class="sub">No ${esc(modelName(m))} entry for this code. Other models list it:</p>`;
  } else {
    h += `<p class="sub">This code isn't in the database for any model.${sys ? ` ${esc(L.code[0])} codes are ${sys.toLowerCase()} codes.` : ""}</p>`;
  }
  h += `</div>`;
  if (L.others.length) {
    const groups = byModel(L.others), open = !L.rows.length;
    h += `<div class="card"><details class="others"${open ? " open" : ""}><summary>${open ? "Other models" : `Also listed for ${groups.map(g => g[0]).join(", ")}`}</summary>${
      groups.map(([mo, rows]) => `<div class="sect" style="margin-top:12px"><span class="badge">${esc(mo)}</span>${
        rows.map((x, i) => rowHtml(x, i, rows.length)).join("")}</div>`).join("")}</details></div>`;
  }
  h += sightingsHtml(L.code);
  h += manualHitsCard(L.code, 4, m);
  h += fromScan && fromScan.carModel ? `<div class="card"><h2>Model</h2><p class="sub">Using ${esc(modelName(m))}, the model of ${esc(carName(fromScan.c))}.
      <a href="#/code/${enc(L.code)}">Look it up for another model</a></p></div>`
    : `<div class="card"><h2>Model</h2>${modelSeg(m)}<p class="note">Kept on this device. FG X uses FG's list.</p></div>`;
  return h;
});
ROUTES["/code"].after = () => wireModelSeg();

/* ------------------------------------------------------------ settings */
function connection() {
  const secure = location.protocol === "https:", ts = /\.ts\.net$/i.test(location.hostname);
  return secure && ts ? { cls: "good", text: "Tailscale · private HTTPS", host: location.host }
    : location.hostname === "localhost" || location.hostname === "127.0.0.1" ? { cls: "good", text: "This laptop", host: location.host }
    : secure ? { cls: "good", text: "HTTPS", host: location.host }
    : { cls: "warn", text: "Plain http", host: location.host };
}
const STORE = { persisted: null, usage: null, quota: null };
async function readStorage() {
  try {
    if (navigator.storage && navigator.storage.persisted) STORE.persisted = await navigator.storage.persisted();
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); STORE.usage = e.usage; STORE.quota = e.quota; }
  } catch (e) {}
}
const mb = b => b == null ? "–" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
function appBuild() { const m = document.querySelector('meta[name="falconoath-build"]'); return m ? m.content : "–"; }
route("/settings", { tab: "settings", title: () => "Settings" }, () => {
  const paired = !!LS.get("token"), S = DB ? DB.snap : null, cn = connection();
  const viaTs = /\.ts\.net$/i.test(location.hostname || "");
  let h = "";
  if (SYNC.state === "unreachable" && paired && onLaptop()) h += `<div class="card" style="border-color:var(--warn)">
    <h2>FalconOath has stopped</h2><p class="sub">Open it again from its desktop icon (or the Start menu): it starts by itself and this
      window carries on. ${S ? `Until then you're looking at the copy from <b>${dAU(S.built)}</b>; phones can't sync either.` : ""}</p>
    <button class="btn block" id="syncGo2" style="margin-top:8px">Try again</button></div>`;
  else if (SYNC.state === "unreachable" && paired) h += `<div class="card" style="border-color:var(--accent)">
    <h2>Can't reach the laptop</h2><p class="sub">${viaTs ? "Turn <b>Tailscale</b> on, then come back here. It syncs by itself."
      : "Check the laptop is on and FalconOath is running."} The laptop must be awake.
      ${S ? `Your copy is from <b>${dAU(S.built)}</b>.` : ""}</p>
    ${viaTs ? `<a class="btn primary block" href="${TS_LINK}">Open Tailscale</a>` : ""}
    <button class="btn block" id="syncGo2" style="margin-top:8px">Try again</button></div>`;
  if (!paired || SYNC.state === "removed") {
    h += `<div class="card"><h2>Pair this device</h2>${SYNC.state === "removed" ? '<p class="warn">This device was removed on the laptop. Pair it again to get updates. Your copy stays until then.</p>' : ""}
      <p class="sub">${onLaptop() ? "On this laptop: close this window and open <b>FalconOath</b> from its desktop icon. Its window pairs itself."
        : "On the laptop, open FalconOath → <b>Settings</b> → <b>Pair a phone</b>, and type the six-digit code it shows."}</p>
      <input type="text" id="code" class="code" inputmode="numeric" maxlength="7" autocomplete="one-time-code" placeholder="000 000" aria-label="Pairing code">
      <button class="btn primary block" id="pairGo" style="margin-top:10px">Pair</button><div id="pairMsg" class="note"></div></div>`;
  }
  if (LS.get("laptopWin") && paired) h += `<div class="card" id="lapcard">${laptopCardHtml()}</div>`;
  const st = { ok: ["good", "Up to date"], offline: ["", "No signal"], unreachable: ["", "Can't reach the laptop"], error: ["bad", "Sync failed"],
               downloading: ["", "Downloading"], idle: ["", "Waiting"], unpaired: ["warn", "Not paired"], removed: ["warn", "Removed on the laptop"] }[SYNC.state] || ["", SYNC.state];
  h += `<div class="card"><h2>This device's copy</h2>${S ? `<div class="big">${n0(S.counts.dtc)} entries</div>
    <div class="sub">${n0(S.counts.codes)} fault codes · BA, BF, FG (FG X reads FG)</div>
    <table class="tbl" style="margin-top:10px"><tr><td>Data as of</td><td>${dtAU(S.built)}</td></tr>
    <tr><td>Last checked</td><td>${ago(SYNC.lastOk)}</td></tr>
    <tr><td>Live-data logs</td><td>${logsLine()}</td></tr>
    <tr><td>Manuals</td><td>${LIB ? `${n0(LIB.manuals.length)} (${n0(LIB.lib.counts.pages)} pages)${KEPT.set.size ? `, ${KEPT.set.size} on this phone` : ""}` : "–"}</td></tr>
    <tr><td>Status</td><td class="${st[0]}">${st[1]}</td></tr>
    ${LS.get("device") ? `<tr><td>Paired as</td><td>${esc(LS.get("device"))}</td></tr>` : ""}
    <tr><td>Data version</td><td class="faint">${esc(S.version)}</td></tr></table>`
    : `<p class="sub">No copy yet.</p><table class="tbl"><tr><td>Status</td><td class="${st[0]}">${st[1]}</td></tr></table>`}
    <div class="spread" style="margin-top:10px;font-size:13px"><span class="muted">Connection</span>
      <span style="text-align:right"><span class="${cn.cls}">${esc(cn.text)}</span><br><span class="faint" style="font-size:11.5px">${esc(cn.host)}</span></span></div>
    ${SYNC.error && SYNC.state !== "ok" ? `<div class="note bad">${esc(SYNC.error)}</div>` : ""}
    ${paired ? `<div class="row" style="margin-top:12px;gap:8px"><button class="btn primary" style="flex:1" id="syncGo" ${SYNC.busy ? "disabled" : ""}>${SYNC.busy ? "Syncing…" : "Sync now"}</button>
      ${viaTs ? `<a class="btn" href="${TS_LINK}">Tailscale</a>` : ""}</div>` : ""}
    <div class="note">Syncs by itself when FalconOath opens, when you come back to it, and every few minutes while it's open. Only a newer copy is downloaded. With no signal, the copy on this device is used.</div></div>`;
  const waiting = OUTBOX.filter(o => !o.result), refused = OUTBOX.filter(o => o.result === "rejected");
  if (waiting.length || refused.length || SYNC.sendError) h += `<div class="card"><h2>Waiting for the laptop</h2>
    ${waiting.length ? `<p class="sub">${waiting.length} item${waiting.length === 1 ? "" : "s"} made on this device (${
      ["car", "scan", "log", "manual", "attach", "trim", "fact"].map(k => { const n = waiting.filter(o => o.kind === k).length; return n ? `${n} ${k}${n === 1 ? "" : "s"}` : ""; }).filter(Boolean).join(", ")
    }) ${waiting.some(o => o.sent) ? "sent; the laptop applies them within a few seconds." : "not sent yet. They go on the next sync."}</p>` : ""}
    ${SYNC.sendError ? `<p class="note bad">Last send: ${esc(SYNC.sendError)}</p>` : ""}
    ${refused.map(o => `<div class="spread" style="border-top:1px solid var(--line);padding:8px 0;margin-top:6px"><span><b>${o.kind === "car" ? esc(carName(o.data))
      : o.kind === "trim" ? "Trim " + esc(o.data.name || "") : o.kind === "fact" ? esc(o.data.value || "A fact") : esc(o.data.file_name || o.kind)}</b><br>
      <span class="bad" style="font-size:13px">Refused: ${esc(o.detail)}</span></span><button class="btn" data-dismiss="${esc(o.id)}">Dismiss</button></div>`).join("")}</div>`;
  const secure = window.isSecureContext && "serviceWorker" in navigator;
  const ready = secure && navigator.serviceWorker.controller;
  h += `<div class="card"><h2>Offline &amp; home screen</h2>
    <p class="sub" id="offl">${ready ? '<span class="good">Ready to open with no signal.</span>' : secure ? "Getting ready for offline use…"
      : '<span class="warn">This address is plain http</span>, so the app can\'t open with no signal (browsers only allow that on HTTPS). Open it through the laptop\'s Tailscale HTTPS address instead.'}</p>
    <p class="sub">Firefox: tap <b>⋮</b> → <b>Add app to Home screen</b> (or <b>Install</b>).</p>
    <table class="tbl" style="margin-top:8px"><tr><td>Storage kept safe</td><td class="${STORE.persisted ? "good" : STORE.persisted === false ? "warn" : ""}">${
      STORE.persisted ? "Yes" : STORE.persisted === false ? "Not yet" : "–"}</td></tr>
    <tr><td>Used on this device</td><td>${mb(STORE.usage)}${STORE.quota ? ` of ${mb(STORE.quota)}` : ""}</td></tr></table>
    ${STORE.persisted === false ? `<button class="btn block" id="persistGo" style="margin-top:10px">Keep data safe</button>
      <div class="note">Asks the browser not to clear FalconOath's data when space runs low. Firefox may ask you to allow it.</div>` : ""}</div>`;
  const th = window.foTheme ? foTheme() : "auto";
  h += `<div class="card"><h2>Appearance</h2><div class="seg">${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) =>
    `<button data-theme-set="${k}" class="${th === k ? "on" : ""}" aria-pressed="${th === k}">${l}</button>`).join("")}</div>
    <div class="note">Auto follows the device's own setting. Kept on this device only.</div>
    <h2 style="margin-top:14px">Model</h2>${modelSeg(model())}<div class="note">Used for fault code lookups. FG X uses FG's list.</div></div>`;
  h += `<div class="card"><h2>About</h2><table class="tbl"><tr><td>App build</td><td class="faint">${esc(appBuild())}</td></tr>
    <tr><td>Data source</td><td>${S && S.dtc_source ? `${esc(S.dtc_source.file)}, ${dAU(S.dtc_source.imported_at)}` : "–"}</td></tr></table>
    <div class="note">FalconOath ships with code only. Data comes from your own laptop.</div></div>`;
  if (paired) h += `<div class="card"><button class="btn danger block" id="unpair">Unpair this device</button>
    <div class="note">Removes the key from this device. Your copy of the data stays; pair again to get updates.</div></div>`;
  return h;
});
/* Settings → This laptop: what the listener's black window used to do, for
   FalconOath's own window only (the laptop checks that too) */
const LAP = { st: null, code: null, err: "", busy: false };
async function laptopCall(body) {
  const r = await fetch("/api/laptop", { method: "POST", cache: "no-store", signal: withTimeout(10000),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + LS.get("token") }, body: JSON.stringify(body) });
  return r.json();
}
function laptopCardHtml() {
  const s = LAP.st;
  if (!s) return `<h2>This laptop</h2><p class="sub">${LAP.err ? `<span class="bad">${esc(LAP.err)}</span>` : "Asking FalconOath…"}</p>`;
  const others = (s.devices || []).filter(d => !d.laptop);
  return `<div class="spread"><h2>This laptop</h2><span class="faint" style="font-size:12.5px">running since ${dtAU(s.started)}</span></div>
    ${LAP.err ? `<p class="note bad" style="margin-top:2px">${esc(LAP.err)}</p>` : ""}
    <div class="lapgrid">
      <div><h3 class="lh">Pair a phone</h3>${LAP.code ? `<div class="paircode">${esc(LAP.code.slice(0, 3))} ${esc(LAP.code.slice(3))}</div>
        <p class="note" style="margin-top:2px">On the phone: Settings → type this. Good for 10 minutes.</p>`
        : `<button class="btn primary" data-lap="pair">Show a pairing code</button>`}
        <p class="note">${s.phone_state === "ready" ? `The phone's address: <b>${esc(s.phone)}</b>` : s.phone_state === "funnel"
          ? `<span class="bad">Tailscale Funnel is on: FalconOath is open to the internet. Run: tailscale funnel reset</span>`
          : `Phones can't reach it yet (${esc(s.phone_state)}).${s.phone_command ? ` Once, run: <code>${esc(s.phone_command)}</code>` : ""}`}</p></div>
      <div><h3 class="lh">Paired devices</h3>${others.length ? `<ul class="list">${others.map(d => `<li><a><span class="d"><b>${esc(d.name)}</b>
        <small>paired ${dAU(d.paired)}${d.last_seen ? " · last synced " + dtAU(d.last_seen) : " · not synced yet"}</small></span>
        <button class="btn small danger" data-unpair="${esc(d.id)}">Remove</button></a></li>`).join("")}</ul>` : `<p class="sub">No phones yet.</p>`}</div>
      <div><h3 class="lh">FORScan</h3><div class="seg">${[[true, "Open new scans by themselves"], [false, "Just list them"]].map(([v, l]) =>
        `<button data-opennew="${v}" class="${s.open_new === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <p class="note">${s.forscan ? `Watching ${esc(s.forscan)}. ` : "No FORScan folder found. "}A scan or log saved there opens in this window within seconds, even if it's closed.</p></div>
      <div><h3 class="lh">Folders</h3><div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" data-lap="open:manuals">Manuals</button>
        ${s.forscan ? `<button class="btn" data-lap="open:forscan">FORScan's folder</button>` : ""}</div></div>
    </div>
    <button class="btn danger block" data-lap="stop" style="margin-top:12px">Stop FalconOath</button>
    <p class="note">Closing this window leaves FalconOath running, so phones keep syncing. Stop it here; it starts again from its icon.</p>`;
}
async function laptopRefresh(err) {
  try { const r = await laptopCall({ do: "status" }); if (r.ok) { LAP.st = r; LAP.err = err || ""; } else LAP.err = r.error; }
  catch (e) { LAP.err = "FalconOath isn't answering on this laptop."; }
  const c = $("lapcard");
  if (c) { c.innerHTML = laptopCardHtml(); wireLaptop(); }
}
function wireLaptop() {
  document.querySelectorAll("[data-lap]").forEach(b => b.onclick = async () => {
    const what = b.dataset.lap;
    if (what === "stop" && !confirm("Stop FalconOath? Phones can't sync until you open it again from its icon.")) return;
    let err = "";
    try {
      const r = await laptopCall({ do: what });
      if (!r.ok) err = r.error;
      else if (what === "pair") { LAP.code = r.code; setTimeout(() => { LAP.code = null; laptopRefresh(); }, r.seconds * 1000); }
      else if (what === "stop") { toast("FalconOath stopped"); SYNC.state = "unreachable"; pill(); return render(true); }
    } catch (e) { err = "FalconOath isn't answering on this laptop."; }
    laptopRefresh(err);
  });
  document.querySelectorAll("[data-unpair]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this device? It keeps its copy, but can't sync until it's paired again.")) return;
    await laptopCall({ do: "unpair", id: b.dataset.unpair }).catch(() => {});
    laptopRefresh();
  });
  document.querySelectorAll("[data-opennew]").forEach(b => b.onclick = async () => {
    await laptopCall({ do: "open_new", on: b.dataset.opennew === "true" }).catch(() => {});
    laptopRefresh();
  });
}
ROUTES["/settings"].after = () => {
  wireModelSeg();
  if ($("lapcard")) { wireLaptop(); laptopRefresh(); }
  const ths = document.querySelectorAll("[data-theme-set]");
  ths.forEach(b => b.onclick = () => {
    if (window.foTheme) foTheme(b.dataset.themeSet);
    ths.forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
  });
  if (!ROUTES["/settings"].storageRead) {
    ROUTES["/settings"].storageRead = true;
    readStorage().then(() => { if (location.hash.startsWith("#/settings")) render(true); ROUTES["/settings"].storageRead = false; });
  }
  if ($("persistGo")) $("persistGo").onclick = async () => {
    try { const ok = await navigator.storage.persist(); toast(ok ? "Data will be kept" : "The browser said no - try again after adding to the home screen"); }
    catch (e) { toast("This browser can't do that"); }
    await readStorage(); render(true);
  };
  if (window.isSecureContext && "serviceWorker" in navigator && !navigator.serviceWorker.controller)
    navigator.serviceWorker.getRegistration().then(r => {
      if (r && r.active && $("offl")) $("offl").innerHTML = '<span class="good">Ready to open with no signal.</span>'; });
  if ($("syncGo")) $("syncGo").onclick = () => sync(true);
  if ($("syncGo2")) $("syncGo2").onclick = () => sync(true);
  document.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this refused item from this device? (The laptop never had it.)")) return;
    const gone = OUTBOX.find(o => o.id === b.dataset.dismiss);
    if (gone && BIG.includes(gone.kind)) FO_IDB.del("upl:" + gone.data.upload_id).catch(() => {});
    OUTBOX = OUTBOX.filter(o => o.id !== b.dataset.dismiss); await outboxSave(); render(true);
  });
  if ($("unpair")) $("unpair").onclick = () => {
    if (!confirm("Unpair this device? Your copy of the data stays on it.")) return;
    LS.set("token", null); SYNC.state = "unpaired"; pill(); render(true);
  };
  if ($("pairGo")) $("pairGo").onclick = async () => {
    const code = $("code").value.replace(/\D/g, ""), m = $("pairMsg");
    if (code.length !== 6) { m.innerHTML = '<span class="bad">The code is six digits.</span>'; return; }
    m.textContent = "Pairing…";
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }), signal: withTimeout(10000) }).then(x => x.json());
      if (!r.ok) { m.innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
      LS.set("token", r.token); LS.set("device", r.device.name); SYNC.state = "idle";
      toast("Paired as " + r.device.name); render(true); sync(true);
    } catch (e) { m.innerHTML = '<span class="bad">Can\'t reach the laptop. Is FalconOath running there, and Tailscale on?</span>'; }
  };
};

/* ------------------------------------------------------------ start */
self.FO = { ROUTES, screen, useSnapshot, SYNC, forscanNew, pullUp, get DB() { return DB; } };    // for tests/js_check.js
if (!self.FO_TEST) document.addEventListener("DOMContentLoaded", () => {     // after garage.js has loaded
  window.addEventListener("hashchange", () => render(false));
  $("back").onclick = () => { if (history.length > 1) history.back(); else location.hash = "#/search"; };
  $("pill").onclick = () => { location.hash = "#/settings"; };
  // Back in the app (e.g. after switching Tailscale on): sync now if the
  // last try failed, and once more a few seconds later while the VPN
  // finishes connecting. Otherwise at most every 30 s.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    waitLoop();
    const failed = ["unreachable", "offline", "error"].includes(SYNC.state);
    if (failed || !SYNC.lastTry || Date.now() - SYNC.lastTry > 30000) {
      sync(false);
      clearTimeout(retryT);
      if (failed) retryT = setTimeout(() => { if (SYNC.state !== "ok") sync(false); }, 4000);
    }
  });
  window.addEventListener("online", () => sync(false));
  (async function start() {
    takeLaunchCode();
    if (LAUNCH.code && !LS.get("token")) await pairLaunch();
    try { const snap = await FO_IDB.get("snap"); if (snap && FORMATS.includes(snap.format) && snap.dtc) useSnapshot(snap); }
    catch (e) { console.warn("no stored copy", e); }
    try { const lib = await FO_IDB.get("lib"); if (lib && Array.isArray(lib.manuals)) useLibrary(lib); }
    catch (e) { console.warn("no stored manuals", e); }
    await keptLoad();
    await logsLoad();
    await outboxLoad();
    if (DB) await outboxSettle(DB.snap);
    const fresh = DB ? forscanNew(DB.snap) : [];      // the first time, marks what's there as seen
    pill(); render(false);
    pullUp(fresh);
    autoSync();
    if (window.isSecureContext && "serviceWorker" in navigator) {
      let reloading = false;
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hadController && !reloading) { reloading = true; location.reload(); }     // a new app version
      });
      navigator.serviceWorker.register("/sw.js").catch(e => console.warn("offline shell unavailable", e));
    }
    // ask once for storage the browser won't clear under pressure
    if (navigator.storage && navigator.storage.persist && !LS.get("persistAsked")) {
      LS.set("persistAsked", "1");
      try { await navigator.storage.persist(); } catch (e) {}
    }
  })();
});
