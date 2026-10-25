/* FalconOath - FORScan live-data logs (step 4). Loaded after manuals.js;
   uses app.js's and garage.js's helpers.

   The snapshot lists every log (no data). After each sync, syncLogs()
   downloads each one this device lacks from /api/log/<sha256>, checks it
   unpacks to that hash, and keeps it gzipped in IndexedDB ("logcsv:<sha>"),
   so every log opens with no signal. A log added on this device is read from
   its own gzip ("upl:<id>") until the laptop has it.

   The viewer (#/log/<id>?pids=A,B) draws one lane per PID on a canvas with a
   shared time axis: drag to pan, pinch / wheel / buttons to zoom, tap for a
   cursor. Health tiles (lib/livelog.js checks) come first; tapping one shows
   its PIDs. "Compare with" overlays another log's same PIDs from its start. */
"use strict";
const LOGS = { have: new Set(), busy: false, parsed: new Map() };
const CHART = '<svg viewBox="0 0 24 24"><path d="M3 3v18h18M7 15l3-4 3 3 5-7"/></svg>';
async function logsLoad() {
  try { (await FO_IDB.keys()).forEach(k => { if (String(k).startsWith("logcsv:")) LOGS.have.add(String(k).slice(7)); }); } catch (e) {}
}
const logWhen = l => l.recorded_on || String(l.imported_at || "").slice(0, 10);
function logsOf(carId) {
  return Array.from(garage().logs.values()).filter(l => (l.car_id || null) === carId)
    .sort((a, b) => logWhen(b).localeCompare(logWhen(a)) || String(b.imported_at).localeCompare(String(a.imported_at)));
}
function fmtDur(s) {
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  if (r < 3600) return `${Math.floor(r / 60)} min${r % 60 ? ` ${r % 60} s` : ""}`;
  return `${Math.floor(r / 3600)} h ${Math.round((r % 3600) / 60)} min`;
}
const mmss = s => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const VERDICT = { good: ["good", "Good"], warn: ["warn", "Check"], bad: ["bad", "Problem"], info: ["", "Note"] };
function verdictCounts(cs) {
  return ["bad", "warn", "good", "info"].map(v => { const n = cs.filter(c => c.verdict === v).length;
    return n ? `<span class="chip ${VERDICT[v][0]}">${n} ${VERDICT[v][1].toLowerCase()}</span>` : ""; }).join(" ");
}
function logsLine() {
  const n = garage().logs.size, here = Array.from(garage().logs.values()).filter(l => LOGS.have.has(l.sha256) || l.pending).length;
  return n ? `${n}${here < n ? `, ${here} on this device` : ", all on this device"}` : "–";
}

/* ------------------------------------------------------------ onto this device */
async function gunzip(blob) { return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text(); }
async function syncLogs(H) {
  if (LOGS.busy || !DB || !self.DecompressionStream) return;
  LOGS.busy = true;
  let got = 0;
  try {
    for (const l of DB.snap.logs || []) {
      if (LOGS.have.has(l.sha256)) continue;
      const r = await fetch("/api/log/" + l.sha256, { headers: H, cache: "no-store", signal: withTimeout(120000) });
      if (r.status !== 200) continue;
      const blob = await r.blob();
      if (await sha256hex(FO_LOG.norm(await gunzip(blob))) !== l.sha256) continue;     // damaged on the way: try next sync
      await FO_IDB.put("logcsv:" + l.sha256, blob);
      LOGS.have.add(l.sha256);
      got++;
    }
  } catch (e) { /* no connection: carries on next sync */ }
  finally { LOGS.busy = false; }
  if (got && /^#\/(cars?|log|settings)/.test(location.hash) && !typing()) render(true);
}
async function logText(l) {
  let blob = null;
  if (l.sha256 && LOGS.have.has(l.sha256)) blob = await FO_IDB.get("logcsv:" + l.sha256);
  if (!blob && l.upload_id) blob = await FO_IDB.get("upl:" + l.upload_id);
  if (!blob && l.sha256 && LS.get("token")) {
    const r = await fetch("/api/log/" + l.sha256, { headers: { Authorization: "Bearer " + LS.get("token") }, cache: "no-store", signal: withTimeout(60000) });
    if (r.status === 200) { blob = await r.blob(); FO_IDB.put("logcsv:" + l.sha256, blob).then(() => LOGS.have.add(l.sha256)).catch(() => {}); }
  }
  return blob ? gunzip(blob) : null;
}
async function logParsed(l) {
  if (LOGS.parsed.has(l.id)) return LOGS.parsed.get(l.id);
  const t = await logText(l), L = t ? FO_LOG.parse(t) : null;
  if (L) {
    LOGS.parsed.set(l.id, L);
    if (LOGS.parsed.size > 4) LOGS.parsed.delete(LOGS.parsed.keys().next().value);
  }
  return L;
}

/* ------------------------------------------------------------ choosing a car */
function assignHtml(what, id, current) {
  const cars = Array.from(garage().cars.values()).filter(c => !c.rejected);
  if (!cars.length) return `<p class="note">Add a car first (Cars → Add a car), then choose it here.</p>`;
  return `<label class="field assign"><span>${current ? "Car" : "Which car is this from?"}</span><select class="text" data-assign="${what}:${esc(id)}">
    ${current ? "" : '<option value="">Choose a car…</option>'}${cars.map(c => `<option value="${esc(c.id)}"${c.id === current ? " selected" : ""}>${esc(carName(c))}${c.model ? " · " + esc(modelName(c.model)) : ""}</option>`).join("")}</select></label>`;
}
function wireAssign() {
  document.querySelectorAll("[data-assign]").forEach(sel => sel.onchange = async () => {
    const [what, id] = sel.dataset.assign.split(":"), car = sel.value;
    if (!car) return;
    await outboxAdd([{ id: uuid(), kind: "attach", data: { what, id, car_id: car } }]);
    toast(`On ${carName(garage().cars.get(car))}: the laptop gets it on the next sync`);
    render(true);
    sync(false);
  });
}

/* ------------------------------------------------------------ lists */
function logsCardHtml(list, none) {
  if (none && !list.length) return "";
  const items = list.map(l => {
    const u = typeof UPS !== "undefined" && UPS[l.id];
    const state = l.pending ? (u && u.total && !l.uploaded ? ` · sending ${mb(u.done)} of ${mb(u.total)}` : "") : LOGS.have.has(l.sha256) ? "" : " · downloading";
    return `<li><a href="#/log/${enc(l.id)}"><span class="mico">${CHART}</span><span class="d"><b>${dAU(logWhen(l))}</b>${pendingBadge(l)}
      <small>${esc(l.file_name || "")} · ${fmtDur((l.duration_ms || 0) / 1000)} · ${plural((l.pids || []).length, "PID")}${state}</small></span>${CHEV}</a>
      ${none && !l.pending ? `<div style="padding:0 0 10px 34px">${assignHtml("log", l.id)}</div>` : ""}</li>`;
  }).join("");
  return `<div class="card"><h2>Live-data logs</h2>${list.length ? `<ul class="list">${items}</ul>`
    : `<p class="sub">No logs yet. In FORScan's <b>Live data</b> tab, record, then save the log (.csv) and add it here. On the laptop, FalconOath also picks up logs saved in FORScan's own folder.</p>`}</div>`;
}

/* ------------------------------------------------------------ fault links */
const PID_GROUP = { O2S: "O2 sensors", SHRTFT: "short-term fuel trims", LONGFT: "long-term fuel trims", TP: "throttle", "B+": "battery voltage" };
const pidWords = pids => pids.map(p => PID_GROUP[p] || (FO_LOG.NAMES[p] || p).toLowerCase()).join(", ");
/* the header names of a log's columns that a suggestion covers */
function coveredCols(names, pids) {
  return (names || []).filter(h => { const b = FO_LOG.splitName(h).base;
    return pids.some(p => b === p || (b.startsWith(p) && /^[\d.]/.test(b.slice(p.length)))); });
}
/* "check it with live data", for a fault row and the code page */
function logHintHtml(code, carId) {
  const s = FO_LOG.suggest(code);
  if (!s) return "";
  const logs = carId ? logsOf(carId) : [];
  let best = null, bestCols = [];
  logs.forEach(l => { const cols = coveredCols(l.pids, s.pids); if (cols.length > bestCols.length) { best = l; bestCols = cols; } });
  return `<div class="mlinks loghint"><div class="mlh">${CHART}<b>Check it with live data</b></div>
    <p class="sub" style="margin:2px 0 6px">${esc(s.why)}</p>
    ${best ? `<a class="mlink" href="#/log/${enc(best.id)}?pids=${enc(bestCols.join(","))}"><span class="pg">${dAU(logWhen(best)).slice(0, 5)}</span><span>Open that log at ${esc(bestCols.map(h => FO_LOG.splitName(h).label).join(", "))}</span>${CHEV}</a>`
      : `<p class="note" style="margin:0 0 4px">Log: ${esc(pidWords(s.pids))}.</p>`}</div>`;
}

/* ------------------------------------------------------------ the viewer */
const VIEWL = { id: null, L: null, L2: null, cmp: "", sel: [], v0: 0, v1: 1, cursor: null };
const PRIORITY = ["RPM", "VSS", "ECT", "TP", "TP1", "TP.OBDII", "LONGFT1", "SHRTFT1", "O2S11", "O2S12", "B+", "MAF", "IAT", "INST_LITRE_HR", "CRUISE"];
const CHECK_PIDS = { trim1: ["LONGFT1", "SHRTFT1", "RPM"], trim2: ["LONGFT2", "SHRTFT2", "RPM"], o2up1: ["O2S11", "O2S12"], cat1: ["O2S11", "O2S12"],
                     o2up2: ["O2S21", "O2S22"], cat2: ["O2S21", "O2S22"], ect: ["ECT", "IAT"], bat: ["B+", "VPWR", "RPM"], idle: ["RPM", "DSDRPM", "TP", "TP1"] };
function defaultSel(L, want) {
  const by = name => L.cols.findIndex(c => c.name === name || c.base === name);
  let sel = (want || []).map(by).filter(i => i >= 0);
  if (!sel.length) sel = PRIORITY.map(by).filter(i => i >= 0);
  if (!sel.length) sel = L.cols.map((c, i) => i);
  return Array.from(new Set(sel)).slice(0, 4);
}
route("/log", { tab: "cars", back: true, wide: true, title: r => { const l = garage().logs.get(r.arg); return l ? "Log " + dAU(logWhen(l)) : "Log"; } }, r => {
  const g = garage(), l = g.logs.get(r.arg);
  if (!l) return `<div class="card"><h2>Log not found</h2><p class="sub">It may not have reached this device yet.</p><a class="btn" href="#/cars">Cars</a></div>`;
  const c = l.car_id ? g.cars.get(l.car_id) : null;
  const others = Array.from(g.logs.values()).filter(x => x.id !== l.id)
    .sort((a, b) => ((b.car_id === l.car_id) - (a.car_id === l.car_id)) || logWhen(b).localeCompare(logWhen(a)));
  return `<div class="card"><div class="spread"><h2 style="font-size:19px">${dAU(logWhen(l))}</h2><span class="faint">${fmtDur((l.duration_ms || 0) / 1000)} · ${n0(l.rows)} rows</span></div>
      <p class="sub">${c ? `<a href="#/car/${enc(c.id)}">${esc(carName(c))}</a> · ` : ""}${esc(l.file_name || "")}${l.origin === "forscan-folder" ? " · from FORScan's folder" : ""}</p>
      ${l.note ? `<p class="sub">${esc(l.note)}</p>` : ""}${pendingBadge(l)}${l.rejected ? `<p class="note bad">${esc(l.detail)}</p>` : ""}
      ${l.pending ? "" : assignHtml("log", l.id, l.car_id || "")}</div>
    <div id="lhealth"></div>
    <div class="card lchart"><div id="lpids" class="pidchips"></div>
      <div class="cbar"><button class="btn small" id="lzout" aria-label="Zoom out">−</button><button class="btn small" id="lzin" aria-label="Zoom in">+</button>
        <button class="btn small" id="lzall">All</button><span class="faint" id="lwin"></span><span style="flex:1"></span>
        <select id="lcmp" class="text small" aria-label="Compare with another log"><option value="">Compare with…</option>${others.map(x => {
          const xc = x.car_id ? g.cars.get(x.car_id) : null;
          return `<option value="${esc(x.id)}">${dAU(logWhen(x))} · ${esc(xc ? carName(xc) : "no car")} · ${esc(x.file_name || "")}</option>`; }).join("")}</select></div>
      <div id="lmsg" class="note">Opening the log…</div>
      <div class="cvwrap"><canvas id="lcv"></canvas></div>
      <div id="llegend" class="note"></div>
      <p class="note">Drag to move along the log, pinch or + / − to zoom, tap for the values at that moment.</p></div>
    <div id="lfaults"></div>`;
});
ROUTES["/log"].after = async r => {
  wireAssign();
  const l = garage().logs.get(r.arg);
  if (!l) return;
  const fresh = VIEWL.id !== l.id;
  if (fresh) Object.assign(VIEWL, { id: l.id, L: null, L2: null, cmp: "", cursor: null });
  let L;
  try { L = await logParsed(l); } catch (e) { L = null; }
  if (!$("lcv")) return;
  if (!L) { $("lmsg").innerHTML = `<span class="bad">Couldn't open it.</span> ${LOGS.have.has(l.sha256) ? "It's damaged on this device." : "It isn't on this device yet, and the laptop can't be reached."}`; return; }
  $("lmsg").textContent = "";
  if (fresh || !VIEWL.L) Object.assign(VIEWL, { L, sel: defaultSel(L, r.q.pids ? r.q.pids.split(",") : null), v0: L.t[0], v1: L.t[L.rows - 1] || L.t[0] + 1 });
  VIEWL.L = L;
  const cs = FO_LOG.checks(L);
  $("lhealth").innerHTML = cs.length ? `<div class="card"><div class="spread"><h2>Health checks</h2><span>${verdictCounts(cs)}</span></div>
    <div class="htiles">${cs.map(c => `<button class="htile ${c.verdict}" data-check="${c.id}"><span class="hv">${VERDICT[c.verdict][1]}</span>
      <b>${esc(c.title)}</b><span class="hval">${esc(c.value)}</span><span class="hx">${esc(c.explain)}</span></button>`).join("")}</div>
    <p class="note">Tap one for what it means; its PIDs show in the chart below.</p></div>`
    : `<div class="card"><p class="sub">No health checks for these PIDs. They need fuel trims, O2 sensors, coolant temp, battery voltage or engine speed.</p></div>`;
  document.querySelectorAll("[data-check]").forEach(b => b.onclick = () => {
    const open = !b.classList.contains("open");
    document.querySelectorAll("[data-check]").forEach(x => x.classList.toggle("open", x === b && open));
    const sel = defaultSel(L, CHECK_PIDS[b.dataset.check] || []);
    if (open && sel.length) { VIEWL.sel = sel; chips(); drawLog(); }
  });
  faultsForLog(l, L);
  chips();
  if ($("lcmp")) {
    $("lcmp").value = VIEWL.cmp;
    $("lcmp").onchange = async e => {
      VIEWL.cmp = e.target.value; VIEWL.L2 = null;
      const o = garage().logs.get(VIEWL.cmp);
      if (o) VIEWL.L2 = await logParsed(o).catch(() => null);
      if (VIEWL.cmp && !VIEWL.L2) toast("That log isn't on this device yet");
      drawLog();
    };
  }
  const zoom = f => { const m = VIEWL.cursor != null ? VIEWL.cursor : (VIEWL.v0 + VIEWL.v1) / 2; setWin(m - (m - VIEWL.v0) * f, m + (VIEWL.v1 - m) * f); };
  $("lzin").onclick = () => zoom(0.5);
  $("lzout").onclick = () => zoom(2);
  $("lzall").onclick = () => setWin(L.t[0], L.t[L.rows - 1]);
  wireCanvas();
  drawLog();
};
function chips() {
  const L = VIEWL.L, el = $("lpids");
  if (!el || !L) return;
  el.innerHTML = L.cols.map((c, i) => `<button class="chip${VIEWL.sel.includes(i) ? " on" : ""}" data-pid="${i}" title="${esc(c.name)}">${esc(c.label)}${c.unit ? ` <i>${esc(c.unit)}</i>` : ""}</button>`).join("");
  el.querySelectorAll("[data-pid]").forEach(b => b.onclick = () => {
    const i = +b.dataset.pid;
    VIEWL.sel = VIEWL.sel.includes(i) ? VIEWL.sel.filter(x => x !== i) : VIEWL.sel.concat(i).slice(-8);
    chips(); drawLog();
  });
}
/* faults on this car that this log can show */
function faultsForLog(l, L) {
  const el = $("lfaults");
  if (!el || !l.car_id) return;
  const codes = new Map();
  scansOf(l.car_id).forEach(s => parsedScan(s).faults.forEach(f => { if (!codes.has(f.code)) codes.set(f.code, f); }));
  const rows = [];
  codes.forEach((f, code) => {
    const s = FO_LOG.suggest(code);
    if (!s) return;
    const cols = FO_LOG.covered(L, s.pids);
    if (cols.length) rows.push(`<button class="mlink" data-fpids="${esc(cols.map(c => L.cols.indexOf(c)).join(","))}"><span class="pg">${esc(code)}</span>
      <span>${esc(f.title || "")}<span class="msub">Show ${esc(cols.map(c => c.label).join(", "))}</span></span>${CHEV}</button>`);
  });
  el.innerHTML = rows.length ? `<div class="card"><h2>Faults on this car this log can show</h2><div class="mlinks">${rows.join("")}</div></div>` : "";
  el.querySelectorAll("[data-fpids]").forEach(b => b.onclick = () => {
    VIEWL.sel = b.dataset.fpids.split(",").map(Number).slice(0, 8); chips(); drawLog();
    $("lcv").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
function setWin(a, b) {
  const L = VIEWL.L, lo = L.t[0], hi = L.t[L.rows - 1], w = Math.max(1, Math.min(hi - lo, b - a));
  a = Math.max(lo, Math.min(a, hi - w));
  VIEWL.v0 = a; VIEWL.v1 = a + w;
  drawLog();
}
function wireCanvas() {
  const cv = $("lcv"), P = new Map();
  let start = null, moved = false;
  const tAt = x => VIEWL.v0 + (x / cv.clientWidth) * (VIEWL.v1 - VIEWL.v0);
  cv.onpointerdown = e => {
    cv.setPointerCapture(e.pointerId);
    P.set(e.pointerId, { x: e.offsetX });
    start = { v0: VIEWL.v0, v1: VIEWL.v1, x: e.offsetX, d: P.size === 2 ? Math.abs([...P.values()][0].x - [...P.values()][1].x) : 0 };
    moved = false;
  };
  cv.onpointermove = e => {
    if (!P.has(e.pointerId) || !start) return;
    P.get(e.pointerId).x = e.offsetX;
    const w = start.v1 - start.v0;
    if (P.size === 2) {
      const xs = [...P.values()].map(p => p.x), d = Math.abs(xs[0] - xs[1]);
      if (start.d > 10 && d > 10) {
        const mid = (xs[0] + xs[1]) / 2, tm = start.v0 + (mid / cv.clientWidth) * w, nw = w * start.d / d;
        setWin(tm - (mid / cv.clientWidth) * nw, tm + (1 - mid / cv.clientWidth) * nw);
        moved = true;
      }
      return;
    }
    const dx = e.offsetX - start.x;
    if (Math.abs(dx) > 5) moved = true;
    if (moved) setWin(start.v0 - dx / cv.clientWidth * w, start.v1 - dx / cv.clientWidth * w);
  };
  const end = e => {
    if (P.size === 1 && !moved && start) { VIEWL.cursor = tAt(e.offsetX); drawLog(); }
    P.delete(e.pointerId);
    if (!P.size) start = null;
  };
  cv.onpointerup = end;
  cv.onpointercancel = e => { P.delete(e.pointerId); start = null; };
  cv.onwheel = e => {
    e.preventDefault();
    const t = tAt(e.offsetX), f = e.deltaY > 0 ? 1.25 : 0.8;
    setWin(t - (t - VIEWL.v0) * f, t + (VIEWL.v1 - t) * f);
  };
  if (!wireCanvas.resize) { wireCanvas.resize = true; window.addEventListener("resize", () => { if ($("lcv")) drawLog(); }); }
}
const STATE_COLOURS = ["#4d8bff", "#f0a63a", "#3ccf7c", "#ff5d6c", "#b07cff", "#2ec4c4"];
function niceStep(span, px) {
  const want = span / Math.max(2, px / 90);
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(s => s >= want) || 3600;
}
function drawLog() {
  const cv = $("lcv"), L = VIEWL.L;
  if (!cv || !L) return;
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim() || "#888";
  const ink = col("--ink"), muted = col("--muted"), faint = col("--faint"), line = col("--line"), accent = col("--accent"), other = col("--warn");
  const W = Math.max(200, cv.parentElement.clientWidth), sel = VIEWL.sel, LH = W < 520 ? 104 : 126, AX = 24, H = Math.max(1, sel.length) * LH + AX;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const { v0, v1 } = VIEWL, x = t => (t - v0) / (v1 - v0) * W, [i0, i1] = FO_LOG.span(L, v0, v1);
  const L2 = VIEWL.L2, shift = L2 ? L.t[0] - L2.t[0] : 0, sp2 = L2 ? FO_LOG.span(L2, v0 - shift, v1 - shift) : null;
  const ci = VIEWL.cursor != null ? Math.min(L.rows - 1, FO_LOG.at(L.t, VIEWL.cursor)) : null;
  const ci2 = L2 && VIEWL.cursor != null ? Math.min(L2.rows - 1, FO_LOG.at(L2.t, VIEWL.cursor - shift)) : null;
  const fmt = v => Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  g.font = "600 12px system-ui, sans-serif";
  if (!sel.length) { g.fillStyle = muted; g.fillText("Choose PIDs above to draw them.", 8, 40); }
  sel.forEach((ix, k) => {
    const c = L.cols[ix], top = k * LH, c2 = L2 ? L2.cols.find(o => o.name === c.name) : null;
    g.strokeStyle = line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, top + 0.5); g.lineTo(W, top + 0.5); g.stroke();
    const label = c.label + (c.unit ? ` (${c.unit})` : "");
    if (c.num) {
      const st = FO_LOG.stats(c, i0, i1), st2 = c2 && c2.num ? FO_LOG.stats(c2, sp2[0], sp2[1]) : null;
      if (!st) { g.fillStyle = faint; g.fillText(label + ": no values here", 6, top + 15); return; }
      let lo = Math.min(st.min, st2 ? st2.min : Infinity), hi = Math.max(st.max, st2 ? st2.max : -Infinity);
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08, yt = top + 22, yh = LH - 30, y = v => yt + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * yh;
      const trace = (LL, cc, a, b, sh, colour) => {
        const px = Math.max(50, Math.floor(W)), env = FO_LOG.envelope(LL.t, cc.v, a, b, v0 - sh, v1 - sh, px);
        g.strokeStyle = colour; g.lineWidth = 1.6; g.beginPath();
        let on = false;
        for (let p = 0; p < px; p++) {
          const l2 = env.lo[p], h2 = env.hi[p];
          if (l2 !== l2) continue;
          const xx = p + 0.5, ym = y((l2 + h2) / 2);
          if (!on) { g.moveTo(xx, ym); on = true; } else g.lineTo(xx, ym);
          if (y(l2) - y(h2) > 1.5) { g.moveTo(xx, y(h2)); g.lineTo(xx, y(l2)); g.moveTo(xx, ym); }
        }
        g.stroke();
      };
      if (st2) trace(L2, c2, sp2[0], sp2[1], shift, other);
      trace(L, c, i0, i1, 0, accent);
      g.fillStyle = faint; g.font = "500 10.5px system-ui, sans-serif";
      g.fillText(fmt(hi), W - g.measureText(fmt(hi)).width - 4, yt + 8); g.fillText(fmt(lo), W - g.measureText(fmt(lo)).width - 4, yt + yh);
      g.font = "600 12px system-ui, sans-serif"; g.fillStyle = muted; g.fillText(label, 6, top + 15);
      const right = ci != null && c.v[ci] === c.v[ci] ? fmt(c.v[ci]) + (st2 && ci2 != null && c2.v[ci2] === c2.v[ci2] ? `  vs ${fmt(c2.v[ci2])}` : "")
        : `${fmt(st.min)}–${fmt(st.max)}, avg ${fmt(st.avg)}`;
      g.font = (ci != null ? "700 14px " : "500 12px ") + "system-ui, sans-serif"; g.fillStyle = ci != null ? ink : muted;
      const lw = g.measureText(label).width + 16, rw = g.measureText(right).width;
      g.fillText(right, Math.max(lw, W - rw - 6), top + 15);
      g.font = "600 12px system-ui, sans-serif";
    } else {
      const states = c.states, yt = top + 26, hh = LH - 40;
      for (let i = i0; i < i1;) {
        const v = c.s[i];
        let j = i + 1;
        while (j < i1 && c.s[j] === v) j++;
        if (v !== null) {
          const xa = Math.max(0, x(L.t[i])), xb = Math.min(W, x(L.t[Math.min(j, L.rows - 1)]));
          g.fillStyle = STATE_COLOURS[states.indexOf(v) % STATE_COLOURS.length]; g.globalAlpha = 0.35;
          g.fillRect(xa, yt, Math.max(1, xb - xa), hh); g.globalAlpha = 1;
          if (xb - xa > g.measureText(v).width + 8) { g.fillStyle = ink; g.fillText(v, xa + 4, yt + hh / 2 + 4); }
        }
        i = j;
      }
      g.fillStyle = muted; g.fillText(label, 6, top + 15);
      if (ci != null && c.s[ci] !== null) { g.font = "700 14px system-ui, sans-serif"; g.fillStyle = ink; const v = c.s[ci]; g.fillText(v, W - g.measureText(v).width - 6, top + 15); g.font = "600 12px system-ui, sans-serif"; }
    }
  });
  // time axis, from the start of the log
  const yA = sel.length * LH, step = niceStep(v1 - v0, W), t00 = L.t[0];
  g.strokeStyle = line; g.beginPath(); g.moveTo(0, yA + 0.5); g.lineTo(W, yA + 0.5); g.stroke();
  g.fillStyle = faint; g.font = "500 11px system-ui, sans-serif";
  for (let s = Math.ceil((v0 - t00) / step) * step; t00 + s <= v1; s += step) {
    const xx = x(t00 + s);
    g.fillRect(xx, yA, 1, 4);
    const lab = step < 1 ? (s).toFixed(1) + " s" : mmss(s);
    g.fillText(lab, Math.min(W - g.measureText(lab).width - 2, Math.max(2, xx - g.measureText(lab).width / 2)), yA + 16);
  }
  if (ci != null) {
    const xx = x(L.t[ci]);
    g.strokeStyle = ink; g.globalAlpha = 0.6; g.lineWidth = 1; g.beginPath(); g.moveTo(xx + 0.5, 0); g.lineTo(xx + 0.5, yA); g.stroke(); g.globalAlpha = 1;
  }
  const w = $("lwin");
  if (w) w.textContent = `${mmss(v0 - t00)}–${mmss(v1 - t00)}` + (ci != null ? ` · cursor ${mmss(L.t[ci] - t00)}` : "");
  const lg = $("llegend");
  if (lg) lg.innerHTML = L2 ? `<span style="color:${accent}">━ this log</span> &nbsp; <span style="color:${other}">━ ${esc(dAU(logWhen(garage().logs.get(VIEWL.cmp) || {})))} log</span>, lined up at their starts${
    sel.some(ix => !L2.cols.find(o => o.name === L.cols[ix].name)) ? " (it doesn't have every PID)" : ""}` : "";
}

self.FO_LOGS_APP = { LOGS, VIEWL, logsOf, logsLine, logHintHtml, logsCardHtml, defaultSel, syncLogs };   // tests
