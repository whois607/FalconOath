/* FalconOath - cars and FORScan scans (step 2). Loaded after app.js and
   uses its helpers (esc, dAU, route, render, DB, LS...).

   The car is the central record: scans attach to a car, including other
   people's cars and cars from ads. Cars and scans made on this device go
   in the OUTBOX (IndexedDB) and are shown straight away, marked "not yet on
   the laptop". sync() sends them to the laptop's inbox; the laptop checks
   and applies them, and the next data copy says what became of each
   (snap.applied), which clears it from the outbox. */
"use strict";
const KINDS = [["mine", "Mine"], ["other", "Someone else's"], ["ad", "From an ad"]];
const CAR_MODELS = [["BA", "BA"], ["BF", "BF"], ["FG", "FG"], ["FGX", "FG X"], ["", "Not sure"]];
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAX_SCAN = 256 * 1024;

/* ------------------------------------------------------------ outbox */
let OUTBOX = [];
async function outboxLoad() {
  try { const o = await FO_IDB.get("outbox"); OUTBOX = Array.isArray(o) ? o : []; } catch (e) { OUTBOX = []; }
  GARAGE.cache = null;
}
async function outboxSave() { GARAGE.cache = null; await FO_IDB.put("outbox", OUTBOX); }
function uuid() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function outboxAdd(items) {
  const now = new Date().toISOString();
  items.forEach(i => OUTBOX.push(Object.assign({ created: now, sent: null, result: null, detail: "" }, i)));
  await outboxSave();
}
/* the laptop's verdicts, from a data copy: settled items leave the outbox;
   rejected ones stay (with the reason) until dismissed. Returns messages. */
async function outboxSettle(snap) {
  const res = new Map((snap.applied || []).map(a => [a[0], a]));
  const notes = [];
  let changed = false;
  OUTBOX = OUTBOX.filter(o => {
    const a = res.get(o.id);
    if (!a) return true;
    if (a[1] === "rejected") {
      if (o.result !== "rejected") { o.result = "rejected"; o.detail = a[2]; changed = true;
        notes.push(`The laptop refused a ${o.kind}: ${a[2]}`); }
      return true;
    }
    changed = true;
    if (a[1] === "duplicate" && o.kind === "scan") notes.push("That scan was already on the laptop");
    return false;
  });
  if (changed) await outboxSave();
  return notes;
}
/* send what hasn't been settled (resending is safe: the laptop applies an
   item once). Returns how many went. Throws on no connection. */
async function outboxSend(headers) {
  // not yet sent, or sent a while ago with no answer (the laptop may have been off)
  const todo = OUTBOX.filter(o => !o.result && (!o.sent || Date.now() - Date.parse(o.sent) > 120000));
  let n = 0;
  for (let i = 0; i < todo.length; i += 20) {
    const chunk = todo.slice(i, i + 20);
    const r = await fetch("/api/inbox", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify({ items: chunk.map(o => ({ id: o.id, kind: o.kind, data: o.data, created: o.created })) }),
      cache: "no-store", signal: withTimeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { SYNC.sendError = j.error || "the laptop answered " + r.status; break; }
    SYNC.sendError = null;
    const now = new Date().toISOString();
    chunk.forEach(o => { o.sent = now; });
    n += chunk.length;
  }
  if (n) await outboxSave();
  return n;
}

/* ------------------------------------------------------------ the garage */
const GARAGE = { cache: null };
function garage() {
  if (GARAGE.cache) return GARAGE.cache;
  const snap = DB ? DB.snap : {}, cars = new Map(), scans = new Map();
  (snap.cars || []).forEach(c => cars.set(c.id, Object.assign({}, c, { pending: false })));
  (snap.scans || []).forEach(s => scans.set(s.id, Object.assign({}, s, { pending: false })));
  OUTBOX.forEach(o => {
    const extra = { pending: true, rejected: o.result === "rejected", detail: o.detail, sent: o.sent };
    if (o.kind === "car" && !cars.has(o.id)) cars.set(o.id, Object.assign({ id: o.id, created_at: o.created }, o.data, extra));
    if (o.kind === "scan" && !scans.has(o.id)) scans.set(o.id, Object.assign({ id: o.id, imported_at: o.created }, o.data, extra));
  });
  const applied = new Map((snap.applied || []).map(a => [a[0], a]));
  GARAGE.cache = { cars, scans, applied, parsed: new Map(), codes: null };
  return GARAGE.cache;
}
function parsedScan(s) {
  const g = garage();
  if (!g.parsed.has(s.id)) g.parsed.set(s.id, FO_FORSCAN.parse(s.text || ""));
  return g.parsed.get(s.id);
}
const scanWhen = s => s.scanned_on || String(s.imported_at || "").slice(0, 10);
function scansOf(carId) {
  return Array.from(garage().scans.values()).filter(s => (s.car_id || null) === carId)
    .sort((a, b) => scanWhen(b).localeCompare(scanWhen(a)));
}
function carName(c) {
  if (!c) return "No car";
  return c.nickname || [c.year, c.model ? modelName(c.model) : ""].filter(Boolean).join(" ") || "Unnamed car";
}
const kindName = k => (KINDS.find(x => x[0] === k) || ["", ""])[1];
/* every scan a code turns up in: code -> [{scan, fault}] */
function codeSightings(code) {
  const g = garage();
  if (!g.codes) {
    g.codes = new Map();
    g.scans.forEach(s => parsedScan(s).faults.forEach(f => {
      if (!g.codes.has(f.code)) g.codes.set(f.code, []);
      g.codes.get(f.code).push({ scan: s, fault: f });
    }));
  }
  return (g.codes.get(code) || []).slice().sort((a, b) => scanWhen(b.scan).localeCompare(scanWhen(a.scan)));
}
const stateChip = d => d.state === "active" ? '<span class="chip bad">Active at the scan</span>'
  : d.state === "pending" ? '<span class="chip warn">Pending</span>' : '<span class="chip">Stored, not active</span>';
function stateChips(d) {
  return stateChip(d)
    + (d.lampOn ? ' <span class="chip bad">Warning lamp</span>' : "")
    + (d.testIncomplete ? ' <span class="chip">Self-test not finished</span>' : "");
}
function countChips(p) {
  if (!p.counts.modules) return '<span class="chip warn">Not a DTC report</span>';
  if (!p.counts.faults) return '<span class="chip good">No faults</span>';
  return (p.counts.active ? `<span class="chip bad">${p.counts.active} active</span> ` : "")
    + (p.counts.stored ? `<span class="chip">${p.counts.stored} stored</span>` : "");
}
function pendingBadge(x) {
  return x.rejected ? ' <span class="badge alt">Refused by the laptop</span>'
    : x.pending ? ` <span class="badge alt">${x.sent ? "Sent, not applied yet" : "Not on the laptop yet"}</span>` : "";
}

/* ------------------------------------------------------------ car form */
const blankCar = () => ({ nickname: "", model: LS.get("model") && LS.get("model") !== "ALL" ? LS.get("model") : "", year: "", vin: "", kind: "mine", notes: "" });
function carFieldsHtml(v) {
  return `<label class="field"><span>Name</span><input id="nc-nick" maxlength="60" value="${esc(v.nickname)}" placeholder="e.g. My FG, a mate's BA"></label>
    <div class="field"><span>Model</span><div class="seg">${CAR_MODELS.map(([k, l]) =>
      `<button type="button" data-ncmodel="${k}" class="${v.model === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="row2"><label class="field"><span>Year</span><input id="nc-year" inputmode="numeric" maxlength="4" value="${esc(v.year)}" placeholder="2010"></label>
    <label class="field"><span>VIN <i class="faint">(optional)</i></span><input id="nc-vin" maxlength="17" autocapitalize="characters" value="${esc(v.vin)}" placeholder="6FPAAAJGxxxxxxxxx"></label></div>
    <div class="field"><span>Whose</span><div class="seg">${KINDS.map(([k, l]) =>
      `<button type="button" data-nckind="${k}" class="${v.kind === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div id="nc-msg" class="note bad"></div>`;
}
function wireCarFields(v) {
  const seg = (attr, key) => document.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => {
    v[key] = b.dataset[attr === "ncmodel" ? "ncmodel" : "nckind"];
    document.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle("on", x === b));
  });
  seg("ncmodel", "model"); seg("nckind", "kind");
  [["nc-nick", "nickname"], ["nc-year", "year"], ["nc-vin", "vin"]].forEach(([id, k]) => {
    if ($(id)) $(id).oninput = () => { v[k] = $(id).value; if ($("nc-msg")) $("nc-msg").textContent = ""; };
  });
}
/* the same checks the laptop makes, so a problem shows now, not later */
function carProblem(v) {
  const vin = String(v.vin || "").toUpperCase().replace(/\s/g, "");
  if (vin && !VIN_RE.test(vin)) return "The VIN is 17 letters and numbers, with no I, O or Q.";
  if (vin) for (const c of garage().cars.values()) if ((c.vin || "") === vin) return `That VIN is already on ${carName(c)}.`;
  if (v.year !== "" && v.year != null && !(+v.year >= 1990 && +v.year <= 2030)) return "The year looks wrong.";
  return null;
}
function carData(v) {
  return { nickname: String(v.nickname || "").trim(), model: v.model || null, year: v.year === "" ? null : +v.year,
           vin: String(v.vin || "").toUpperCase().replace(/\s/g, "") || null, kind: v.kind || "mine", notes: String(v.notes || "").trim() };
}
const NEWCAR = { v: blankCar() };
route("/newcar", { tab: "cars", back: true, title: () => "Add a car" }, () =>
  `<div class="card"><h2>Add a car</h2><p class="sub">Yours, a mate's, or one from an ad. Scans and (later) prices attach to it.</p>
    ${carFieldsHtml(NEWCAR.v)}<button class="btn primary block" id="nc-save" style="margin-top:12px">Save car</button></div>`);
ROUTES["/newcar"].after = () => {
  wireCarFields(NEWCAR.v);
  $("nc-save").onclick = async () => {
    const p = carProblem(NEWCAR.v);
    if (p) { $("nc-msg").textContent = p; return; }
    const id = uuid();
    await outboxAdd([{ id, kind: "car", data: carData(NEWCAR.v) }]);
    NEWCAR.v = blankCar(); LS.set("lastCar", id);
    location.hash = "#/car/" + id; sync(false);
  };
};

/* ------------------------------------------------------------ cars */
route("/cars", { tab: "cars", title: () => "Cars" }, () => {
  const g = garage(), cars = Array.from(g.cars.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const loose = scansOf(null);
  let h = `<div class="card"><div class="spread"><h2>Cars</h2><span class="faint">${cars.length}</span></div>
    <div class="row" style="gap:8px;margin-top:8px"><a class="btn primary" style="flex:1" href="#/upload">Add a FORScan scan</a><a class="btn" href="#/newcar">Add a car</a></div></div>`;
  if (!cars.length && !loose.length) return h + `<div class="card"><p class="sub">No cars yet. Add a FORScan scan and make its car as you go, or add a car first.</p></div>`;
  h += `<div class="card"><ul class="list">${cars.map(c => {
    const ss = scansOf(c.id), last = ss[0];
    return `<li><a href="#/car/${enc(c.id)}"><span class="d"><b>${esc(carName(c))}</b>${pendingBadge(c)}
      <small>${[c.model ? modelName(c.model) : "", c.year, kindName(c.kind), c.vin ? "VIN …" + esc(c.vin.slice(-6)) : ""].filter(Boolean).join(" · ")}</small></span>
      <span class="faint" style="font-size:13px;text-align:right">${ss.length} scan${ss.length === 1 ? "" : "s"}${last ? `<br>${dAU(scanWhen(last))}` : ""}</span>${CHEV}</a></li>`;
  }).join("")}${loose.length ? `<li><a href="#/car/none"><span class="d"><b>Scans without a car</b><small>${loose.length} scan${loose.length === 1 ? "" : "s"}</small></span>${CHEV}</a></li>` : ""}</ul></div>`;
  return h;
});
route("/car", { tab: "cars", back: true, title: r => r.arg === "none" ? "Scans without a car" : carName(garage().cars.get(r.arg)) }, r => {
  const none = r.arg === "none", c = none ? null : garage().cars.get(r.arg);
  if (!none && !c) return `<div class="card"><h2>Car not found</h2><p class="sub">It may not have reached this device yet.</p><a class="btn" href="#/cars">All cars</a></div>`;
  const ss = scansOf(none ? null : c.id);
  let h = `<div class="card">`;
  if (none) h += `<h2>Scans without a car</h2><p class="sub">Imported on the laptop without choosing a car.</p>`;
  else h += `<div class="spread"><h2 style="font-size:19px">${esc(carName(c))}</h2><span class="badge">${esc(kindName(c.kind))}</span></div>${pendingBadge(c)}
    ${c.rejected ? `<p class="note bad">${esc(c.detail)}</p>` : ""}
    <table class="tbl" style="margin-top:8px"><tr><td>Model</td><td>${c.model ? esc(modelName(c.model)) : "Not sure"}</td></tr>
    <tr><td>Year</td><td>${c.year ? esc(c.year) : "–"}</td></tr><tr><td>VIN</td><td style="font-family:ui-monospace,Consolas,monospace">${c.vin ? esc(c.vin) : "–"}</td></tr>
    ${c.notes ? `<tr><td>Notes</td><td>${esc(c.notes)}</td></tr>` : ""}</table>`;
  h += `${none ? "" : `<a class="btn primary block" style="margin-top:12px" href="#/upload?car=${enc(c.id)}">Add a FORScan scan</a>`}</div>`;
  h += `<div class="card"><h2>Fault scans</h2>${ss.length ? `<ul class="list">${ss.map(s => {
    const p = parsedScan(s);
    return `<li><a href="#/scan/${enc(s.id)}"><span class="d"><b>${dAU(scanWhen(s))}</b>${pendingBadge(s)}
      <small>${esc(s.file_name || "")}${p.counts.modules ? ` · ${p.counts.modules} modules read` : ""}</small></span>
      <span style="text-align:right">${countChips(p)}</span>${CHEV}</a></li>`;
  }).join("")}</ul>` : `<p class="sub">No scans yet.</p>`}</div>`;
  return h;
});

/* ------------------------------------------------------------ upload */
const UP = { name: "", text: "", parsed: null, error: "", date: "", note: "", car: null, newCar: blankCar(), dupOf: null };
function upReset() { Object.assign(UP, { name: "", text: "", parsed: null, error: "", date: "", note: "", dupOf: null, newCar: blankCar() }); }
const isoDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
async function upTake(file) {
  upReset();
  UP.name = file.name;
  if (file.size > MAX_SCAN) { UP.error = "That file is over 256 KB. FORScan's DTC report is usually 5-15 KB: is it the right file?"; return; }
  let text = "";
  try { text = await file.text(); } catch (e) { UP.error = "Couldn't read that file."; return; }
  const p = FO_FORSCAN.parse(text);
  if (!p.modules.length) {
    UP.error = /;|time\(ms\)/.test(text.slice(0, 300)) ? "That looks like a FORScan live-data log (CSV). Live data comes in step 4; this takes the DTC report (TXT)."
      : "This isn't a FORScan DTC report: it has no ===MODULE DTC ...=== blocks. In FORScan, read the codes on the DTC tab, then Save.";
    return;
  }
  UP.text = text; UP.parsed = p; UP.date = isoDay(new Date(file.lastModified || Date.now()));
  for (const s of garage().scans.values()) if (s.text && FO_FORSCAN.sameReport(s.text, text)) { UP.dupOf = s.id; break; }
}
route("/upload", { tab: "home", back: true, title: () => "Add a FORScan scan" }, r => {
  const g = garage();
  if (r.q.car && g.cars.has(r.q.car)) UP.car = r.q.car;
  if (UP.car == null) UP.car = g.cars.has(LS.get("lastCar")) ? LS.get("lastCar") : (g.cars.size ? Array.from(g.cars.keys()).pop() : "new");
  if (UP.car !== "new" && !g.cars.has(UP.car)) UP.car = "new";
  const p = UP.parsed;
  let h = `<div class="card"><h2>FORScan fault scan</h2>
    <p class="sub">In FORScan: <b>DTC</b> tab → read the codes → <b>Save</b> (the disk icon) → a .txt file. Pick that file here.</p>
    <label class="drop" id="drop"><input type="file" id="file" accept=".txt,text/plain">
      <b>${UP.name ? esc(UP.name) : "Choose the .txt file"}</b><span class="faint">${UP.name ? "tap to choose another" : "or drop it here"}</span></label>
    ${UP.error ? `<p class="note bad">${esc(UP.error)}</p>` : ""}</div>`;
  if (p) {
    h += `<div class="card"><div class="spread"><h2>In this report</h2><span>${countChips(p)}</span></div>
      <p class="sub">${p.counts.modules} modules read, ${p.counts.clean} with no faults.</p>
      <div class="codes">${p.faults.map(f => `<span class="chip ${f.decoded.state === "active" ? "bad" : ""}">${esc(f.code)}</span>`).join(" ")}</div>
      ${p.counts.unparsed ? `<p class="note warn">${p.counts.unparsed} block(s) in a form FalconOath doesn't know yet; they're kept and shown as written.</p>` : ""}
      ${UP.dupOf ? `<p class="note warn">This report is already in FalconOath. <a href="#/scan/${enc(UP.dupOf)}">Open it</a></p>` : ""}</div>`;
    const cars = Array.from(g.cars.values());
    h += `<div class="card"><h2>Which car?</h2>
      <select id="up-car" class="text">${cars.map(c => `<option value="${esc(c.id)}"${UP.car === c.id ? " selected" : ""}>${esc(carName(c))}${c.model ? " · " + esc(modelName(c.model)) : ""}</option>`).join("")}
        <option value="new"${UP.car === "new" ? " selected" : ""}>+ A new car</option></select>
      ${UP.car === "new" ? `<div style="margin-top:10px">${carFieldsHtml(UP.newCar)}</div>` : ""}</div>
      <div class="card"><h2>When</h2><label class="field"><span>Scan date</span><input type="date" id="up-date" class="text" value="${esc(UP.date)}"></label>
      <label class="field"><span>Note <i class="faint">(optional)</i></span><textarea id="up-note" class="text" rows="2" maxlength="2000" placeholder="e.g. after the new battery">${esc(UP.note)}</textarea></label>
      <button class="btn primary block" id="up-save" style="margin-top:12px">Save scan</button>
      <div class="note">${LS.get("token") ? "Saved on this device now, and sent to the laptop on the next sync." : "Saved on this device. It goes to the laptop once this device is paired (Settings)."}</div></div>`;
  }
  return h;
});
ROUTES["/upload"].after = () => {
  const take = async file => { if (!file) return; await upTake(file); render(true); };
  $("file").onchange = e => take(e.target.files[0]);
  const drop = $("drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
  if (!UP.parsed) return;
  $("up-car").onchange = e => { UP.car = e.target.value; render(true); };
  if (UP.car === "new") wireCarFields(UP.newCar);
  $("up-date").oninput = e => { UP.date = e.target.value; };
  $("up-note").oninput = e => { UP.note = e.target.value; };
  $("up-save").onclick = async () => {
    const items = [];
    let carId = UP.car;
    if (carId === "new") {
      const prob = carProblem(UP.newCar);
      if (prob) { $("nc-msg").textContent = prob; $("nc-msg").scrollIntoView({ block: "center" }); return; }
      carId = uuid();
      items.push({ id: carId, kind: "car", data: carData(UP.newCar) });
    }
    const sid = uuid();
    items.push({ id: sid, kind: "scan", data: { text: UP.text, file_name: UP.name, car_id: carId, scanned_on: UP.date || null, note: UP.note.trim() } });
    await outboxAdd(items);
    LS.set("lastCar", carId); upReset(); UP.car = null;
    location.hash = "#/scan/" + sid;
    toast("Scan saved");
    sync(false);
  };
};

/* ------------------------------------------------------------ one scan */
function notesText(f) {
  // FORScan repeats the title under "Diagnostic Trouble Code details"; drop that
  return String(f.notes || "").split("\n").map(s => s.trim()).filter(s => s && s !== "Diagnostic Trouble Code details" && s !== f.title).join("\n");
}
function explainHtml(f, carModel) {
  if (!DB) return `<p class="note">The fault code list arrives with the first sync from the laptop.</p>`;
  const L = FO_DTC.lookup(DB, f.code, carModel || "ALL"), rows = L.rows.length ? L.rows : L.others;
  if (!rows.length) return `<p class="note">Not in the fault code list.</p>`;
  const from = L.rows.length ? (L.fallback ? `from ${L.viaModel} data` : carModel ? modelName(carModel) + " list" : rows.map(x => x.model).filter((x, i, a) => a.indexOf(x) === i).join(", "))
    : `not in the ${modelName(carModel)} list; ${rows[0].model}'s`;
  return `<div class="explain"><div class="faint" style="font-size:12px">Fault code list · ${esc(from)}</div>${rows.slice(0, 2).map(r =>
    `<div style="margin-top:4px"><b>${esc(r.description)}</b>${SECTS.filter(([k]) => r[k]).map(([k, l]) => `<div class="sect"><h3>${l}</h3><p>${esc(r[k])}</p></div>`).join("")}</div>`).join("")}
    ${rows.length > 2 ? `<a href="#/code/${enc(f.code)}" class="note">${rows.length - 2} more entr${rows.length - 2 === 1 ? "y" : "ies"}</a>` : ""}</div>`;
}
function statusHtml(f) {
  const d = f.decoded;
  const said = f.statusLines.length ? f.statusLines.map(esc).join("; ") : "nothing";
  return `<details class="more"><summary>Status byte ${d.hex}${f.format === "packed" ? ` (status ${d.status.toString(16).toUpperCase().padStart(2, "0")} + symptom ${(d.byte & 15).toString(16).toUpperCase()})` : ""}</summary>
    <ul class="bits">${d.bits.map(b => `<li><code>${b.bit}</code> ${esc(b.says)}${b.name ? ` <span class="faint">${esc(b.name)}</span>` : ""}</li>`).join("") || "<li>no bits set</li>"}</ul>
    <p class="note">${f.format === "uds" ? "Standard (ISO 14229) status byte." : "Older module: the high half is the status, the low half the symptom."}
      FORScan said: ${said}. ${d.agrees ? '<span class="good">The byte agrees.</span>' : '<span class="warn">The byte reads differently; FORScan\'s words are what\'s shown above.</span>'}</p></details>`;
}
function faultHtml(f, carModel) {
  if (f.unparsed) return `<div class="fault"><div class="spread"><b>${esc(f.raw)}</b><span class="chip warn">Unknown form</span></div><pre class="raw">${esc(f.body)}</pre></div>`;
  const d = f.decoded, sym = f.symptom ? `${f.symptom.code}: ${f.symptom.text}` : null, notes = notesText(f);
  return `<div class="fault"><div class="fhead"><a class="code" href="#/code/${enc(f.code)}">${esc(f.code)}</a> <span>${stateChips(d)}</span></div>
    <div class="desc" style="margin:6px 0 2px">${esc(f.title || "")}</div>
    ${sym ? `<div class="sub">Symptom ${esc(sym)}</div>` : ""}
    ${explainHtml(f, carModel)}
    ${notes ? `<details class="more"><summary>FORScan's notes</summary><p style="white-space:pre-line;margin:6px 0 0">${esc(notes)}</p></details>` : ""}
    ${statusHtml(f)}</div>`;
}
route("/scan", { tab: "cars", back: true, title: () => "Scan" }, r => {
  const g = garage();
  let s = g.scans.get(r.arg);
  if (!s) {                                     // sent as a duplicate: the laptop's own copy
    const a = g.applied.get(r.arg);
    if (a && a[3] && g.scans.has(a[3])) s = g.scans.get(a[3]);
  }
  if (!s) return `<div class="card"><h2>Scan not found</h2><p class="sub">It may not have reached this device yet.</p><a class="btn" href="#/cars">Cars</a></div>`;
  const c = s.car_id ? g.cars.get(s.car_id) : null, p = parsedScan(s), carModel = c ? c.model : null;
  let h = `<div class="card"><div class="spread"><h2 style="font-size:19px">${dAU(scanWhen(s))}</h2><span>${countChips(p)}</span></div>
    <p class="sub"><a href="#/car/${enc(c ? c.id : "none")}">${esc(carName(c))}</a>${c && c.model ? " · " + esc(modelName(c.model)) : ""} · ${esc(s.file_name || "")}</p>${pendingBadge(s)}
    ${s.rejected ? `<p class="note bad">${esc(s.detail)}</p>` : ""}${s.note ? `<p class="sub">${esc(s.note)}</p>` : ""}
    <p class="note">${p.counts.modules} modules read${p.counts.clean ? ` · no faults in ${p.modules.filter(m => m.clean).map(m => esc(m.module)).join(", ")}` : ""}.
      ${!carModel ? "No model set for this car, so explanations come from every model's list." : ""}</p></div>`;
  p.modules.filter(m => m.faults.length).forEach(m => {
    h += `<div class="card"><div class="spread"><h2>${esc(m.name || m.module)}</h2><span class="badge">${esc(m.module)}</span></div>${m.faults.map(f => faultHtml(f, carModel)).join("")}</div>`;
  });
  h += `<div class="card"><details class="more"><summary>The report as FORScan saved it</summary><pre class="raw">${esc(FO_FORSCAN.norm(s.text || ""))}</pre></details></div>`;
  return h;
});

/* "in your scans", for the code page */
function sightingsHtml(code) {
  const hits = codeSightings(code);
  if (!hits.length) return "";
  const g = garage();
  return `<div class="card"><h2>In your scans</h2><ul class="list">${hits.slice(0, 20).map(x => {
    const c = x.scan.car_id ? g.cars.get(x.scan.car_id) : null;
    return `<li><a href="#/scan/${enc(x.scan.id)}"><span class="d"><b>${esc(carName(c))}</b><small>${dAU(scanWhen(x.scan))} · ${esc(x.fault.module)}</small></span>
      <span>${stateChip(x.fault.decoded)}</span>${CHEV}</a></li>`;
  }).join("")}</ul></div>`;
}
