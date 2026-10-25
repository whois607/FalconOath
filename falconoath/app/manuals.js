/* FalconOath - the manual library (step 3). Loaded after garage.js; uses
   app.js's helpers (esc, route, render, LS, sync...) and the outbox.

   Your PDFs stay on the laptop, in manuals/<model>/. The laptop reads their
   text and sends it (/api/library), so searching works here with no signal.
   A manual opens from the laptop (/api/manual/<sha>, streamed in pieces by
   pdf.js), or from this device if you chose "Keep on this phone": then the
   whole PDF is kept in the "falconoath-manuals" cache, which the service
   worker answers from, and which an app update never clears.

   A PDF added here is kept in IndexedDB until it has gone to the laptop in
   pieces (/api/upload/<id>), then a "manual" outbox item tells the laptop
   where to put it. It reaches the library on the laptop's next read. */
"use strict";
const MAN_CACHE = "falconoath-manuals";
const PIECE = 2 * 1024 * 1024;           // upload piece; the laptop takes up to 8 MB
const DL_PIECE = 4 * 1024 * 1024;        // keep-on-phone download piece
const MAX_PDF = 500 * 1024 * 1024;
let LIB = null;                          // FO_MAN.index(the manuals' copy)
function useLibrary(lib) { LIB = lib ? FO_MAN.index(lib) : null; }
const folderName = f => (FO_MAN.FOLDERS.find(x => x[0] === f) || [f, f])[1];
const isLaptop = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname || "");

/* ------------------------------------------------------------ the copy */
async function syncLibrary(H, meta) {
  const want = meta.library;
  if (!want || (LIB && LIB.lib.version === want.version)) return false;
  const r = await fetch("/api/library", { headers: Object.assign({}, H, LIB ? { "If-None-Match": `"${LIB.lib.version}"` } : {}),
                                          cache: "no-store", signal: withTimeout(300000) });
  if (r.status === 304) return false;
  if (r.status !== 200) throw new Error("the laptop answered " + r.status + " for the manuals");
  const lib = await r.json();
  if (lib.format !== "falconoath-lib/1" || lib.version !== want.version || !Array.isArray(lib.manuals)
      || lib.manuals.length !== want.counts.manuals || lib.manuals.some(m => !Array.isArray((lib.text || {})[m.sha])))
    throw new Error("the manuals copy did not match its description - kept the one you had");
  await FO_IDB.put("lib", lib);
  useLibrary(lib);
  return true;
}

/* ------------------------------------------------------------ kept on this phone */
const KEPT = { set: new Set(), sizes: {} };    // which manuals' PDFs are in MAN_CACHE
const DL = {};                                  // sha -> {done, total, error}
const manUrl = sha => "/api/manual/" + sha;
async function keptLoad() {
  if (!self.caches) return;
  try {
    const keys = await (await caches.open(MAN_CACHE)).keys();
    KEPT.set = new Set(keys.map(k => new URL(k.url).pathname.split("/").pop()));
  } catch (e) {}
}
async function keep(sha) {
  if (!self.caches || DL[sha]) return;
  const m = LIB && LIB.bySha.get(sha), token = LS.get("token");
  if (!m || !token) return;
  DL[sha] = { done: 0, total: m.size, error: null };
  dlShow(sha);
  const parts = [];
  try {
    for (let at = 0; at < m.size; at += DL_PIECE) {
      const end = Math.min(m.size, at + DL_PIECE) - 1;
      const r = await fetch(manUrl(sha), { headers: { Authorization: "Bearer " + token, Range: `bytes=${at}-${end}` },
                                           cache: "no-store", signal: withTimeout(120000) });
      if (r.status !== 206 && !(r.status === 200 && at === 0)) throw new Error(r.status === 404 ? "the laptop doesn't have it any more" : "the laptop answered " + r.status);
      const b = await r.blob();
      parts.push(b);
      if (r.status === 200) { DL[sha].done = b.size; break; }
      DL[sha].done = at + b.size;
      dlShow(sha);
    }
    const blob = new Blob(parts, { type: "application/pdf" });
    if (blob.size !== m.size) throw new Error("the download was the wrong size");
    await (await caches.open(MAN_CACHE)).put(manUrl(sha), new Response(blob, {
      headers: { "Content-Type": "application/pdf", "Content-Length": String(blob.size) } }));
    KEPT.set.add(sha);
    delete DL[sha];
    toast(`${m.title} is on this phone`);
  } catch (e) {
    DL[sha].error = e.name === "AbortError" ? "timed out" : String(e.message || e);
    toast("Couldn't keep it: " + DL[sha].error, 4000);
    setTimeout(() => { delete DL[sha]; }, 100);
  }
  if (/^#\/manual/.test(location.hash)) render(true);
}
async function unkeep(sha) {
  try { await (await caches.open(MAN_CACHE)).delete(manUrl(sha)); } catch (e) {}
  KEPT.set.delete(sha);
  render(true);
}
function dlShow(sha) {
  const d = DL[sha], el = document.getElementById("dl-" + sha);
  if (el && d) el.textContent = `Downloading… ${mb(d.done)} of ${mb(d.total)}`;
}
function keepBtn(m) {
  if (!self.caches && !self.FO_TEST) return "";
  if (DL[m.sha]) return `<span class="note" id="dl-${m.sha}" style="margin:0">Downloading… ${mb(DL[m.sha].done)} of ${mb(DL[m.sha].total)}</span>`;
  return KEPT.set.has(m.sha) ? `<button class="btn small" data-unkeep="${m.sha}">On this phone ✓</button>`
    : `<button class="btn small" data-keep="${m.sha}">Keep on this phone</button>`;
}
function wireKeep() {
  document.querySelectorAll("[data-keep]").forEach(b => b.onclick = e => { e.preventDefault(); keep(b.dataset.keep); render(true); });
  document.querySelectorAll("[data-unkeep]").forEach(b => b.onclick = e => {
    e.preventDefault();
    if (confirm("Remove this PDF from this phone? It stays on the laptop, and search still works.")) unkeep(b.dataset.unkeep);
  });
}

/* ------------------------------------------------------------ uploads from this device */
const UPS = {};                     // outbox id -> {done, total, error}
let upBusy = false;
async function pumpUploads() {
  const token = LS.get("token");
  if (upBusy || !token) return;
  upBusy = true;
  let finished = 0;
  try {
    for (const o of OUTBOX.filter(x => x.kind === "manual" && !x.uploaded && !x.result)) {
      const blob = await FO_IDB.get("upl:" + o.data.upload_id);
      if (!blob) { UPS[o.id] = { error: "the file is no longer on this device - add it again" }; continue; }
      const H = { Authorization: "Bearer " + token };
      let r = await fetch("/api/upload/" + o.data.upload_id, { headers: H, cache: "no-store", signal: withTimeout(15000) });
      let at = (await r.json()).size || 0;
      UPS[o.id] = { done: at, total: blob.size, error: null };
      while (at < blob.size) {
        r = await fetch(`/api/upload/${o.data.upload_id}?offset=${at}`, { method: "PUT", headers: H,
          body: blob.slice(at, Math.min(blob.size, at + PIECE)), cache: "no-store", signal: withTimeout(120000) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && typeof j.size === "number" && j.size !== at) { at = j.size; continue; }   // resume where the laptop is
        if (!r.ok || !j.ok) { UPS[o.id].error = j.error || "the laptop answered " + r.status; break; }
        at = j.size;
        UPS[o.id].done = at;
        const el = document.getElementById("up-" + o.id);
        if (el) el.textContent = `Sending to the laptop… ${mb(at)} of ${mb(blob.size)}`;
      }
      if (at >= blob.size && !UPS[o.id].error) { o.uploaded = new Date().toISOString(); finished++; await outboxSave(); }
    }
  } catch (e) {
    // no connection: it carries on from where the laptop got to, next sync
  } finally {
    upBusy = false;
  }
  if (finished) sync(false);            // now the "manual" items themselves go
  if (/^#\/(manuals|settings)/.test(location.hash)) render(true);
}
const ADD = { file: null, folder: null, error: "" };
route("/addmanual", { tab: "manuals", back: true, title: () => "Add a manual" }, () => {
  if (!ADD.folder) ADD.folder = ({ BA: "BA", BF: "BF", FG: "FG", FGX: "FGX" })[model()] || "General";
  const f = ADD.file;
  return `<div class="card"><h2>Add a PDF manual</h2>
    <p class="sub">A workshop manual, owner's handbook, brochure or wiring diagram. It goes to the laptop's <b>manuals</b> folder for the model you pick, and its text becomes searchable everywhere.</p>
    <label class="drop" id="mdrop"><input type="file" id="mfile" accept=".pdf,application/pdf">
      <b>${f ? esc(f.name) : "Choose a PDF"}</b><span class="faint">${f ? mb(f.size) + " · tap to choose another" : "or drop it here"}</span></label>
    ${ADD.error ? `<p class="note bad">${esc(ADD.error)}</p>` : ""}
    <div class="field"><span>Which model is it for?</span><div class="seg">${FO_MAN.FOLDERS.map(([k, l]) =>
      `<button type="button" data-mfolder="${k}" class="${ADD.folder === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <button class="btn primary block" id="msave" style="margin-top:12px" ${f ? "" : "disabled"}>Send to the laptop</button>
    <div class="note">${LS.get("token") ? "Kept on this device until the laptop has all of it. Big manuals take a while; it carries on where it left off if the connection drops."
      : "This device isn't paired yet (Settings): it's kept here and sent once paired."}${isLaptop() ? " On the laptop you can also just copy PDFs into the manuals folder (press M in the FalconOath window)." : ""}</div></div>`;
});
ROUTES["/addmanual"].after = () => {
  const take = file => {
    if (!file) return;
    ADD.error = "";
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { ADD.file = null; ADD.error = "That isn't a PDF."; }
    else if (file.size > MAX_PDF) { ADD.file = null; ADD.error = "That's over 500 MB."; }
    else ADD.file = file;
    render(true);
  };
  $("mfile").onchange = e => take(e.target.files[0]);
  const d = $("mdrop");
  d.ondragover = e => { e.preventDefault(); d.classList.add("over"); };
  d.ondragleave = () => d.classList.remove("over");
  d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); take(e.dataTransfer.files[0]); };
  document.querySelectorAll("[data-mfolder]").forEach(b => b.onclick = () => { ADD.folder = b.dataset.mfolder; render(true); });
  $("msave").onclick = async () => {
    const f = ADD.file;
    if (!f) return;
    const head = new Uint8Array(await f.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF-") { ADD.error = "That file isn't a PDF inside."; render(true); return; }
    const upload_id = uuid();
    try { await FO_IDB.put("upl:" + upload_id, f); }
    catch (e) { ADD.error = "This device couldn't store it (out of space?)."; render(true); return; }
    await outboxAdd([{ id: uuid(), kind: "manual", uploaded: null,
                       data: { upload_id, file_name: f.name, folder: ADD.folder, size: f.size } }]);
    ADD.file = null; ADD.error = "";
    location.hash = "#/manuals";
    toast("Sending to the laptop");
    pumpUploads();
  };
};
function pendingManualsHtml() {
  const ps = OUTBOX.filter(o => o.kind === "manual");
  if (!ps.length) return "";
  return `<div class="card"><h2>Going to the laptop</h2><ul class="list">${ps.map(o => {
    const u = UPS[o.id] || {}, refused = o.result === "rejected";
    const st = refused ? `<span class="bad">Refused: ${esc(o.detail)}</span>`
      : u.error ? `<span class="bad">${esc(u.error)}</span>`
      : o.uploaded ? (o.sent ? "Sent; the laptop files it in a few seconds, then reads it" : "All there; filing it next sync")
      : u.total ? `Sending to the laptop… ${mb(u.done)} of ${mb(u.total)}` : "Waiting to send (needs the laptop)";
    return `<li><a><span class="d"><b>${esc(o.data.file_name)}</b><small id="up-${esc(o.id)}">${st}</small></span><span class="badge">${esc(folderName(o.data.folder))}</span></a></li>`;
  }).join("")}</ul></div>`;
}

/* ------------------------------------------------------------ the library and search */
const BOOK = '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 11h6"/></svg>';
function snipHtml(text, q) {
  return FO_MAN.snippet(text, q, 200).map(([t, m]) => m ? `<mark>${esc(t)}</mark>` : esc(t)).join("");
}
/* the folders a PDF sits in below its model's folder, e.g.
   "Ford-Falcon-FG-2008-2014-factory-service-manual", so two sections with
   the same name can be told apart ("" for a PDF straight in the folder) */
function subPath(m) {
  const parts = String(m.path || "").split("/").slice(0, -1);
  if (parts.length && FO_MAN.FOLDERS.some(([f]) => f === parts[0])) parts.shift();
  return parts.join(" › ");
}
const subHtml = m => { const s = subPath(m); return s ? `<span class="msub">${esc(s)}</span>` : ""; };
/* hits grouped by manual: [{m, hits}] in the order of each manual's best hit */
function grouped(hits) {
  const g = new Map();
  hits.forEach(h => { if (!g.has(h.sha)) g.set(h.sha, []); g.get(h.sha).push(h); });
  return Array.from(g, ([sha, hs]) => ({ m: LIB.bySha.get(sha), hits: hs }));
}
function hitsHtml(q, hits, perManual) {
  return grouped(hits).map(({ m, hits: hs }) => `<div class="mgroup"><div class="spread"><span class="mhead"><a class="mtitle" href="#/manual/${m.sha}?q=${enc(q)}">${esc(m.title)}</a>${subHtml(m)}</span>
      <span class="mmeta"><span class="badge">${esc(folderName(m.folder))}</span> <span class="faint" style="font-size:12.5px">${hs.length} page${hs.length === 1 ? "" : "s"}</span></span></div>
    <ul class="list hits">${hs.slice(0, perManual).map(h => `<li><a href="#/manual/${m.sha}?p=${h.page}&q=${enc(q)}"><span class="pg">p ${h.page}</span>
      <span class="d">${snipHtml(LIB.text[m.sha][h.page - 1], q)}</span>${CHEV}</a></li>`).join("")}
    ${hs.length > perManual ? `<li><a href="#/manual/${m.sha}?q=${enc(q)}" class="more"><span class="d">${hs.length - perManual} more page${hs.length - perManual === 1 ? "" : "s"} in this manual</span>${CHEV}</a></li>` : ""}</ul></div>`).join("");
}
/* "In your manuals", for the search and code pages: the model's own manuals,
   or the nearest generation's when those have nothing (said so) */
const viaNote = (mdl, via) => `<p class="note" style="margin:0 0 4px">Nothing in the ${esc(modelName(mdl))} manuals, so these are from the <b>${esc(modelName(via))}</b> manual.</p>`;
function manualHitsCard(q, max, mdl) {
  if (!LIB || !LIB.manuals.length || FO_MAN.terms(q).length === 0) return "";
  mdl = mdl || model();
  const { hits, via } = FO_MAN.searchFor(LIB, q, mdl);
  if (!hits.length) return "";
  return `<div class="card"><div class="spread"><h2>In your manuals</h2><a class="note" style="margin:0" href="#/manuals?q=${enc(q)}">All ${hits.length === 300 ? "300+" : hits.length} pages</a></div>
    ${via ? viaNote(mdl, via) : ""}${hitsHtml(q, hits.slice(0, max), 3)}</div>`;
}
/* a fault's manual pages, for a scan's fault row: short links straight to the page */
function manualLinksHtml(code, carModel, max) {
  if (!LIB || !LIB.manuals.length) return "";
  const { hits, via } = FO_MAN.searchFor(LIB, code, carModel || "ALL");
  if (!hits.length) return `<div class="mlinks"><span class="faint">No manual page mentions ${esc(code)}.</span></div>`;
  return `<div class="mlinks"><div class="mlh">${BOOK}<b>Manual pages</b>${via ? `<span class="badge alt">from the ${esc(modelName(via))} manual</span>` : ""}</div>
    ${hits.slice(0, max || 4).map(h => { const m = LIB.bySha.get(h.sha);
      return `<a class="mlink" href="#/manual/${m.sha}?p=${h.page}&q=${enc(code)}"><span class="pg">p ${h.page}</span><span class="mhead">${esc(m.title)}${subHtml(m)}</span>${CHEV}</a>`; }).join("")}
    ${hits.length > (max || 4) ? `<a class="note" href="#/manuals?q=${enc(code)}">All ${hits.length} pages</a>` : ""}</div>`;
}
function libraryListHtml(m) {
  const folders = FO_MAN.FOR_MODEL[m];
  const ms = LIB.manuals.filter(x => !folders || folders.includes(x.folder));
  if (!ms.length) return `<div class="card"><p class="sub">No manuals for ${esc(modelName(m))} yet.</p></div>`;
  return FO_MAN.FOLDERS.filter(([f]) => ms.some(x => x.folder === f)).map(([f, l]) => `<div class="card"><div class="spread"><h2>${l}</h2><span class="faint">${ms.filter(x => x.folder === f).length}</span></div>
    <ul class="list">${ms.filter(x => x.folder === f).map(x => `<li><a href="#/manual/${x.sha}"><span class="mico">${BOOK}</span><span class="d"><b>${esc(x.title)}</b>${subHtml(x)}
      <small>${n0(x.pages)} page${x.pages === 1 ? "" : "s"} · ${mb(x.size)}${x.error ? ` · <span class="bad">${esc(x.error)}</span>`
        : x.pages && !x.text_pages ? ' · <span class="warn">scanned: no text to search yet</span>'
        : x.text_pages < x.pages ? ` · ${n0(x.pages - x.text_pages)} pages without text` : ""}</small></span>
      ${KEPT.set.has(x.sha) ? '<span class="chip good">On this phone</span>' : ""}${CHEV}</a></li>`).join("")}</ul></div>`).join("");
}
function emptyLibraryHtml() {
  return `<div class="card"><h2>No manuals yet</h2>
    <p class="sub">Put your own PDF manuals on the laptop, in <b>falcon-app\\manuals\\</b>, in the folder for the model: <b>BA</b>, <b>BF</b>, <b>FG</b>, <b>FGX</b> or <b>General</b>.
      Press <b>M</b> in the FalconOath window on the laptop to open that folder. They're read within a few seconds and searchable here, even with no signal.</p>
    <p class="sub">Or send one from this device:</p><a class="btn primary" href="#/addmanual">Add a manual</a></div>`;
}
route("/manuals", { tab: "manuals", wide: true, title: () => "Manuals" }, r => {
  const q = r.q.q || "", m = model();
  let h = `<div class="card"><div class="row" style="gap:8px"><input id="mq" class="text" type="search" value="${esc(q)}" placeholder="Search every page: knock sensor, P0325, torque…"
      autocomplete="off" enterkeyhint="search" aria-label="Search the manuals" style="flex:1"><a class="btn" href="#/addmanual" title="Add a manual">+ Add</a></div>
    <div style="margin-top:10px">${modelSeg(m)}</div>
    ${LIB ? `<p class="note">${n0(LIB.manuals.length)} manual${LIB.manuals.length === 1 ? "" : "s"}, ${n0(LIB.lib.counts.pages)} pages${m === "FGX" ? " · FG X also shows FG manuals" : m !== "ALL" ? " · with General" : ""}. Search works with no signal.</p>` : ""}</div>`;
  h += pendingManualsHtml();
  if (!LIB) return h + `<div class="card"><h2>No manuals on this device yet</h2><p class="sub">${LS.get("token") ? "They come from the laptop on the next sync." : "Pair this device with the laptop first (Settings)."}</p></div>`;
  if (!LIB.manuals.length) return h + emptyLibraryHtml();
  h += `<div id="mres">${q.trim() ? manualResultsHtml(q, m) : libraryListHtml(m)}</div>`;
  return h;
});
function manualResultsHtml(q, m) {
  if (!FO_MAN.terms(q).length) return `<div class="card"><p class="empty">Type at least two letters.</p></div>`;
  const hits = FO_MAN.search(LIB, q, { model: m });
  if (!hits.length) return `<div class="card"><p class="empty">No page has “${esc(q)}”${m !== "ALL" ? ` in the ${esc(modelName(m))} manuals` : ""}.${
    m !== "ALL" && FO_MAN.search(LIB, q, { model: "ALL", limit: 1 }).length ? ` <a href="#" data-model-all>Search all models</a>` : ""}</p></div>`;
  return `<div class="card"><p class="note" style="margin:0 0 6px">${hits.length === 300 ? "The best 300" : n0(hits.length)} page${hits.length === 1 ? "" : "s"}</p>${hitsHtml(q, hits, 5)}</div>`;
}
ROUTES["/manuals"].after = r => {
  wireModelSeg(); wireKeep();
  const inp = $("mq"), res = $("mres");
  if (!inp) return;
  const wireAll = () => { const a = document.querySelector("[data-model-all]");
    if (a) a.onclick = e => { e.preventDefault(); LS.set("model", "ALL"); render(true); }; };
  wireAll();
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    if (res) res.innerHTML = inp.value.trim() ? manualResultsHtml(inp.value, model()) : libraryListHtml(model());
    wireAll(); wireKeep();
    history.replaceState(null, "", "#/manuals" + (inp.value ? "?q=" + enc(inp.value) : ""));
  }, 150); };
  inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); };
  if (OUTBOX.some(o => o.kind === "manual" && !o.uploaded)) pumpUploads();
};

/* ------------------------------------------------------------ the viewer */
let PDFJS = null;
async function pdfjs() {
  if (!PDFJS) {
    PDFJS = await import("/vendor/pdfjs/pdf.min.mjs");
    PDFJS.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  }
  return PDFJS;
}
const VIEW = { sha: null, doc: null, task: null, zoom: 1, ratio: 1.414, rendered: new Map(), io: null, cur: 1 };
route("/manual", { tab: "manuals", back: true, wide: true, title: r => (LIB && LIB.bySha.get(r.arg) || {}).title || "Manual" }, r => {
  const m = LIB && LIB.bySha.get(r.arg);
  if (!m) return `<div class="card"><h2>Manual not found</h2><p class="sub">It may have been removed on the laptop, or not reached this device yet.</p><a class="btn" href="#/manuals">All manuals</a></div>`;
  const q = r.q.q || "", on = q ? FO_MAN.pagesWith(LIB, m.sha, q) : [];
  return `<div class="card vhead"><div class="spread"><h2>${esc(m.title)}</h2><span class="badge">${esc(folderName(m.folder))}</span></div>
      <p class="note" style="margin-top:2px">${n0(m.pages)} pages · ${mb(m.size)} · on the laptop in manuals/${esc(m.path)}</p>
      <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">${keepBtn(m)}</div>
      ${q ? `<div class="vmatch"><span class="faint">“${esc(q)}” on</span> ${on.length ? on.slice(0, 40).map(p => `<button class="chip" data-goto="${p}">p ${p}</button>`).join(" ")
        + (on.length > 40 ? ` <span class="faint">+${on.length - 40} more</span>` : "") : '<span class="faint">no pages</span>'}</div>` : ""}</div>
    <div class="vbar" id="vbar"><button class="btn small" id="vprev" aria-label="Previous page">‹</button>
      <label class="vpage"><input id="vnum" inputmode="numeric" value="${esc(r.q.p || 1)}" aria-label="Page"> / ${n0(m.pages)}</label>
      <button class="btn small" id="vnext" aria-label="Next page">›</button><span style="flex:1"></span>
      <button class="btn small" id="vout" aria-label="Smaller">−</button><button class="btn small" id="vin" aria-label="Bigger">+</button></div>
    <div id="vmsg" class="note"></div><div id="vpages" class="vpages"></div>`;
});
ROUTES["/manual"].after = r => {
  wireKeep();
  const m = LIB && LIB.bySha.get(r.arg);
  if (!m) return;
  openViewer(m, Math.max(1, Math.min(m.pages || 1, parseInt(r.q.p, 10) || 1)));
  document.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => goPage(+b.dataset.goto));
  $("vprev").onclick = () => goPage(VIEW.cur - 1);
  $("vnext").onclick = () => goPage(VIEW.cur + 1);
  $("vnum").onchange = () => goPage(parseInt($("vnum").value, 10) || 1);
  $("vin").onclick = () => setZoom(VIEW.zoom * 1.25);
  $("vout").onclick = () => setZoom(VIEW.zoom / 1.25);
};
async function openViewer(m, page) {
  const box = $("vpages"), msg = $("vmsg");
  if (VIEW.sha !== m.sha || !VIEW.doc) {
    if (VIEW.task) { try { VIEW.task.destroy(); } catch (e) {} }
    Object.assign(VIEW, { sha: m.sha, doc: null, task: null, zoom: 1, rendered: new Map() });
    msg.textContent = "Opening…";
    try {
      const lib = await pdfjs(), token = LS.get("token");
      VIEW.task = lib.getDocument({ url: manUrl(m.sha), httpHeaders: token ? { Authorization: "Bearer " + token } : {},
        rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" });
      VIEW.doc = await VIEW.task.promise;
      const p1 = await VIEW.doc.getPage(1), v = p1.getViewport({ scale: 1 });
      VIEW.ratio = v.height / v.width;
    } catch (e) {
      VIEW.sha = null;
      msg.innerHTML = `<span class="bad">Couldn't open it.</span> ${navigator.onLine === false || /fetch|network/i.test(String(e && e.message))
        ? "It isn't on this phone and the laptop can't be reached. Next time, tap <b>Keep on this phone</b> while connected." : esc(String(e && e.message || e))}`;
      return;
    }
  }
  if (!$("vpages")) return;
  msg.textContent = "";
  layout(box);
  // after render() has finished: it scrolls a new screen to the top once
  // after() returns, which would undo the jump when the PDF is already open
  setTimeout(() => goPage(page, true), 0);
}
function layout(box) {
  const n = VIEW.doc.numPages, w = Math.round(box.clientWidth * VIEW.zoom);
  VIEW.rendered.clear();
  box.innerHTML = Array.from({ length: n }, (_, i) =>
    `<div class="vp" data-p="${i + 1}" style="width:${w}px;height:${Math.round(w * VIEW.ratio)}px"><span class="vpn">${i + 1}</span></div>`).join("");
  if (VIEW.io) VIEW.io.disconnect();
  VIEW.io = new IntersectionObserver(es => es.forEach(e => {
    const p = +e.target.dataset.p;
    if (e.isIntersecting) drawPage(e.target, p);
    else if (VIEW.rendered.has(p) && Math.abs(p - VIEW.cur) > 6) { e.target.querySelector("canvas")?.remove(); VIEW.rendered.delete(p); }
  }), { rootMargin: "1200px 0px" });
  box.querySelectorAll(".vp").forEach(el => VIEW.io.observe(el));
  const seen = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { VIEW.cur = +e.target.dataset.p; const n = $("vnum"); if (n && document.activeElement !== n) n.value = VIEW.cur; }
  }), { rootMargin: "-45% 0px -45% 0px" });
  box.querySelectorAll(".vp").forEach(el => seen.observe(el));
}
async function drawPage(el, p) {
  if (VIEW.rendered.has(p) || !VIEW.doc) return;
  VIEW.rendered.set(p, true);
  try {
    const page = await VIEW.doc.getPage(p), base = page.getViewport({ scale: 1 });
    const css = el.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: css / base.width * dpr });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = css + "px"; c.style.height = Math.round(css * vp.height / vp.width) + "px";
    el.style.height = c.style.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (VIEW.rendered.has(p)) { el.querySelector("canvas")?.remove(); el.appendChild(c); }
  } catch (e) { VIEW.rendered.delete(p); }
}
function goPage(p, instant) {
  if (!VIEW.doc) return;
  p = Math.max(1, Math.min(VIEW.doc.numPages, p));
  VIEW.cur = p;
  const el = document.querySelector(`.vp[data-p="${p}"]`), n = $("vnum");
  if (n) n.value = p;
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - ($("vbar").offsetHeight + 70), behavior: instant ? "auto" : "smooth" });
}
function setZoom(z) {
  VIEW.zoom = Math.max(0.5, Math.min(4, z));
  const p = VIEW.cur;
  layout($("vpages"));
  goPage(p, true);
}

self.FO_MAN_APP = { useLibrary, get LIB() { return LIB; }, KEPT, syncLibrary, pumpUploads, keptLoad, manualHitsCard, manualLinksHtml };   // tests, app.js
