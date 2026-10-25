/* FalconOath - the app (phone and laptop alike).

   Screens are hash routes (#/, #/search?q=, #/code/P0325, #/settings). The
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
const FORMAT = "falconoath-snap/1";
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
function useSnapshot(snap) { DB = FO_DTC.index(snap); }
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
    if (r.status === 401) { SYNC.state = "removed"; SYNC.error = null; return; }
    if (r.status === 429) { SYNC.state = "error"; SYNC.error = "the laptop is refusing for ten minutes after too many failed attempts"; return; }
    const meta = await r.json();
    if (!meta.ok) { SYNC.state = "error"; SYNC.error = meta.error; return; }
    const have = DB && DB.snap.version;
    if (meta.version !== have) {
      SYNC.state = "downloading"; pill();
      const s = await fetch("/api/snapshot", { headers: Object.assign({}, H, have ? { "If-None-Match": `"${have}"` } : {}),
                                               cache: "no-store", signal: withTimeout(120000) });
      if (s.status !== 200) throw new Error("the laptop answered " + s.status);
      const snap = await s.json();
      // check before replacing: a copy that doesn't match its description is not kept
      if (snap.format !== FORMAT || snap.version !== meta.version || !Array.isArray(snap.dtc)
          || snap.dtc.length !== meta.counts.dtc || snap.counts.dtc !== meta.counts.dtc)
        throw new Error("the copy did not match its description - kept the one you had");
      const first = !DB;
      await FO_IDB.put("snap", snap);
      useSnapshot(snap);
      toast(first ? `Downloaded ${n0(snap.counts.dtc)} fault code entries` : "Data updated");
      render(true);
    }
    SYNC.state = "ok"; SYNC.error = null; SYNC.lastOk = new Date().toISOString(); LS.set("lastOk", SYNC.lastOk);
    LS.set("device", meta.device || "");
  } catch (e) {
    // no signal at all -> "offline" (normal in a shed, said quietly);
    // signal but no laptop -> "unreachable": Tailscale off, or the laptop asleep
    const net = navigator.onLine === false;
    SYNC.state = net ? "offline" : (e.name === "AbortError" || e instanceof TypeError) ? "unreachable" : "error";
    SYNC.error = e.name === "AbortError" ? "the laptop did not answer in time" : String(e.message || e);
    if (manual) toast(SYNC.state === "error" ? "Sync failed: " + SYNC.error
      : SYNC.state === "unreachable" ? "Can't reach the laptop - is Tailscale on?" : "No signal - using the copy on this device", 3500);
  } finally {
    SYNC.busy = false; pill();
    if (location.hash.startsWith("#/settings") || (location.hash.replace(/^#\/?/, "") === "")) render(true);
  }
}
function pill() {
  const p = $("pill"); if (!p) return;
  const s = SYNC.state, data = DB ? DB.snap.built : null;
  let cls = "off", txt;
  if (SYNC.busy) { cls = "busy"; txt = SYNC.state === "downloading" ? "Downloading…" : "Syncing…"; }
  else if (s === "unpaired") { cls = "warn"; txt = "Not paired"; }
  else if (s === "removed") { cls = "warn"; txt = "Pair again"; }
  else if (s === "ok") { cls = "ok"; txt = "Synced " + ago(SYNC.lastOk); }
  else if (s === "offline") { txt = "Offline · " + (data ? dAU(data) : "no data"); }
  else if (s === "unreachable") { txt = "Not synced · " + (data ? dAU(data) : "no data"); }
  else if (s === "error") { cls = "bad"; txt = "Sync failed"; }
  else txt = data ? "Data " + dAU(data) : "…";
  p.className = "pill " + cls; p.querySelector("span").textContent = txt;
}
let syncTimer = null, retryT = null;
function autoSync() {
  sync(false);
  clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (document.visibilityState === "visible") sync(false); }, 5 * 60 * 1000);
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
  document.title = s.R.title ? s.R.title(s.r) + " · FalconOath" : "FalconOath";
  if (s.R.after && (!s.R.needsData || DB)) s.R.after(s.r);
  window.scrollTo(0, keepScroll ? y : 0);
}

/* ------------------------------------------------------------ home */
const IC = {
  browse: '<svg viewBox="0 0 24 24"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
};
route("/", { tab: "home" }, () => {
  const S = DB ? DB.snap : null;
  return `<section class="hero"><h1>FalconOath</h1><p>BA · BF · FG · FG X</p>
    <form id="homeQ" role="search"><input id="hq" type="search" placeholder="Fault code, e.g. P0325" autocomplete="off"
      autocapitalize="characters" enterkeyhint="search" aria-label="Fault code or words"><button class="btn primary">Look up</button></form></section>
    <div class="tiles">
      <a class="tile soon" href="#/browse">${IC.browse}<b>Browse</b><span>Models, trims and options</span><span class="badge">Coming</span></a>
      <a class="tile" href="#/search">${IC.search}<b>Search</b><span>Fault codes now; trims and prices later</span><span class="badge">Fault codes</span></a>
      <a class="tile soon" href="#/upload">${IC.upload}<b>Upload</b><span>FORScan scans and live data</span><span class="badge">Coming</span></a>
    </div>
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

/* placeholders: what each will become, and when */
function soon(title, step, what) {
  return `<div class="card"><h2>${esc(title)}</h2><p class="sub">${what}</p>
    <p class="note">Planned for step ${step} (see PLAN.md). For now, fault codes are under Search.</p>
    <a class="btn primary" href="#/search">Search fault codes</a></div>`;
}
route("/browse", { tab: "home", back: true, title: () => "Browse" }, () =>
  soon("Browse", 6, "Look through every model, series, trim and factory option, built from the sales brochures and service manuals."));
route("/upload", { tab: "home", back: true, title: () => "Upload" }, () =>
  soon("Upload", 2, "Bring in a FORScan fault scan (each fault explained, status decoded), live-data logs (step 4), and attach them to a car."));

/* ------------------------------------------------------------ search */
function hl(text, words) {
  let s = String(text || "");
  if (!words.length) return esc(s);
  const re = new RegExp("(" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
  return s.split(re).map((part, i) => i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join("");
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
    <div class="card" id="res">${resultsHtml(q, m)}</div>`;
});
ROUTES["/search"].after = r => {
  wireModelSeg();
  const inp = $("q"), res = $("res");
  const wireAll = () => { const a = res.querySelector("[data-model-all]");
    if (a) a.onclick = e => { e.preventDefault(); LS.set("model", "ALL"); render(true); }; };
  wireAll();
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    res.innerHTML = resultsHtml(inp.value, model()); wireAll();
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
  const m = model(), L = FO_DTC.lookup(DB, r.arg, m), sys = FO_DTC.SYSTEMS[L.code[0]];
  let h = `<div class="card"><div class="codeHead"><span class="code">${esc(L.code)}</span>
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
  h += `<div class="card"><h2>Model</h2>${modelSeg(m)}<p class="note">Kept on this device. FG X uses FG's list.</p></div>`;
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
  if (SYNC.state === "unreachable" && paired) h += `<div class="card" style="border-color:var(--accent)">
    <h2>Can't reach the laptop</h2><p class="sub">${viaTs ? "Turn <b>Tailscale</b> on, then come back here. It syncs by itself."
      : "Check the laptop is on and FalconOath is running."} The laptop must be awake.
      ${S ? `Your copy is from <b>${dAU(S.built)}</b>.` : ""}</p>
    ${viaTs ? `<a class="btn primary block" href="${TS_LINK}">Open Tailscale</a>` : ""}
    <button class="btn block" id="syncGo2" style="margin-top:8px">Try again</button></div>`;
  if (!paired || SYNC.state === "removed") {
    h += `<div class="card"><h2>Pair this device</h2>${SYNC.state === "removed" ? '<p class="warn">This device was removed on the laptop. Pair it again to get updates. Your copy stays until then.</p>' : ""}
      <p class="sub">On the laptop, run <b>python -m falconoath pair</b> and type the six-digit code it shows.</p>
      <input type="text" id="code" class="code" inputmode="numeric" maxlength="7" autocomplete="one-time-code" placeholder="000 000" aria-label="Pairing code">
      <button class="btn primary block" id="pairGo" style="margin-top:10px">Pair</button><div id="pairMsg" class="note"></div></div>`;
  }
  const st = { ok: ["good", "Up to date"], offline: ["", "No signal"], unreachable: ["", "Can't reach the laptop"], error: ["bad", "Sync failed"],
               downloading: ["", "Downloading"], idle: ["", "Waiting"], unpaired: ["warn", "Not paired"], removed: ["warn", "Removed on the laptop"] }[SYNC.state] || ["", SYNC.state];
  h += `<div class="card"><h2>This device's copy</h2>${S ? `<div class="big">${n0(S.counts.dtc)} entries</div>
    <div class="sub">${n0(S.counts.codes)} fault codes · BA, BF, FG (FG X reads FG)</div>
    <table class="tbl" style="margin-top:10px"><tr><td>Data as of</td><td>${dtAU(S.built)}</td></tr>
    <tr><td>Last checked</td><td>${ago(SYNC.lastOk)}</td></tr>
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
ROUTES["/settings"].after = () => {
  wireModelSeg();
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
self.FO = { ROUTES, screen, useSnapshot, SYNC, get DB() { return DB; } };    // for tests/js_check.js
if (!self.FO_TEST) {
  window.addEventListener("hashchange", () => render(false));
  $("back").onclick = () => { if (history.length > 1) history.back(); else location.hash = "#/search"; };
  $("pill").onclick = () => { location.hash = "#/settings"; };
  // Back in the app (e.g. after switching Tailscale on): sync now if the
  // last try failed, and once more a few seconds later while the VPN
  // finishes connecting. Otherwise at most every 30 s.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const failed = ["unreachable", "offline", "error"].includes(SYNC.state);
    if (failed || !SYNC.lastTry || Date.now() - SYNC.lastTry > 30000) {
      sync(false);
      clearTimeout(retryT);
      if (failed) retryT = setTimeout(() => { if (SYNC.state !== "ok") sync(false); }, 4000);
    }
  });
  window.addEventListener("online", () => sync(false));
  (async function start() {
    try { const snap = await FO_IDB.get("snap"); if (snap && snap.format === FORMAT && snap.dtc) useSnapshot(snap); }
    catch (e) { console.warn("no stored copy", e); }
    pill(); render(false);
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
}
