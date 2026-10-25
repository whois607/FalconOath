// Run by tests/check_app.py:  node js_check.js <app dir> <snapshot.json> <fixture.txt> [samples dir]
// The app's own code under node: lib/dtc.js search and lookup cases, then
// every screen rendered (every code, every model, paired or not, each sync
// state) with no exception and no "undefined", "NaN" or "[object Object]".
// Prints one JSON object: {n, fails: [...]}.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const [appDir, snapPath, fixturePath, samplesDir] = process.argv.slice(2);
const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
const fails = [];
let n = 0;
const ok = (cond, label) => { n++; if (!cond) fails.push(label); };

/* ---- lib/dtc.js on its own */
const D = require(path.join(appDir, "lib", "dtc.js"));
const ix = D.index(snap);
const first = (q, m) => (D.search(ix, q, m)[0] || {}).code;
ok(first("P0325", "BA") === "P0325", "P0325 on BA finds P0325");
ok(first("p325", "BA") === "P0325", "p325 finds P0325");
ok(first(" p0325 ", "ALL") === "P0325", "spaces and lower case ignored");
ok(first("0325", "ALL") === "P0325", "0325 (no letter) finds P0325");
ok(D.search(ix, "knock", "ALL").some(x => x.code === "P0325"), "'knock' finds P0325");
ok(D.search(ix, "knock sensor", "BA").every(x => x.rows.every(r => r.model === "BA")), "model filter keeps BA rows only");
ok(D.search(ix, "U0073", "FG")[0].rows.length === 2, "FG U0073: both entries");
const fgx = D.search(ix, "U0140", "FGX")[0];
ok(fgx && fgx.rows.length && fgx.rows.every(r => r.model === "FG"), "FG X reads FG rows");
const L = D.lookup(ix, "U0140", "FGX");
ok(L.fallback === true && L.viaModel === "FG", "FG X lookup is marked as a fallback to FG");
ok(D.lookup(ix, "P0325", "FG").fallback === false, "FG lookup is not a fallback");
ok(D.search(ix, "", "ALL").length === 0 && D.search(ix, "zzzzqq", "ALL").length === 0, "empty and nonsense find nothing");
ok(D.lookup(ix, "P1709", "BA").rows.some(r => r.qualifier === "KOEO"), "P1709 BA carries KOEO");
ok(D.normCode("p1") === "P0001" && D.normCode("0325") === null, "normCode");
ok(D.search(ix, "P0", "ALL").length <= 80, "results capped at 80");

/* ---- lib/forscan.js: the parser and the status byte */
const F = require(path.join(appDir, "lib", "forscan.js"));
const fixText = fs.readFileSync(fixturePath, "utf8");
const fx = F.parse(fixText);
ok(fx.counts.modules === 7 && fx.counts.faults === 6 && fx.counts.unparsed === 1, `fixture: 7 modules, 6 faults, 1 unknown block (${JSON.stringify(fx.counts)})`);
ok(fx.counts.clean === 2, "fixture: TCM and RCM read clean");
const fq = code => fx.faults.find(x => x.code === code);
let d = fq("U0140").decoded;
ok(fq("U0140").format === "uds" && d.hex === "28" && d.state === "stored" && !d.lampOn && d.symptomCode === "87", "U0140:87-28 = stored, symptom 87");
ok(d.bits.map(b => b.bit).join() === "08,20", "0x28 = confirmed + failed since clear");
d = fq("U0401").decoded;
ok(d.state === "active" && d.agrees, "U0401:00-29 = active (testFailed), agrees with FORScan");
d = fq("C0034").decoded;
ok(d.testIncomplete && d.state === "stored" && d.agrees, "C0034 -68: stored, self-test not finished");
const k = fq("P0325");
ok(k.format === "packed" && k.decoded.status === 0x60 && k.decoded.symptomCode === "03" && k.decoded.state === "active" && k.decoded.agrees,
   "P0325-63 (older module) = status 60 active + symptom 03, as FORScan printed");
ok(k.symptom && k.symptom.text === "Signal is Above Maximum Threshold" && /Knock sensor \(KS\)/.test(k.notes), "symptom text and FORScan's notes kept");
d = fq("B1267").decoded;
ok(d.status === 0x20 && d.symptomCode === null && d.symptomNone && d.state === "stored" && d.agrees, "B1267-2F = status 20 + no symptom (F)");
ok(fq("B1318").decoded.symptomCode === "02" && fq("B1318").decoded.agrees, "B1318-22 = symptom 02, as printed");
ok(fx.unparsed[0].raw === "Something odd" && fx.unparsed[0].body.includes("doesn't know"), "an unknown block is kept as written");
const crlf = F.parse("\uFEFF" + fixText.replace(/\n/g, "\r\n"));
ok(JSON.stringify(crlf.counts) === JSON.stringify(fx.counts), "CRLF and a BOM parse the same");
ok(F.sameReport(fixText, fixText.replace(/\n/g, "\r\n")) && !F.sameReport(fixText, fixText + "x"), "sameReport");
ok(F.parse("time(ms);RPM\n0;800").modules.length === 0 && F.parse("").faults.length === 0, "not a report -> nothing");
// every real report: each block parsed, and the byte agrees with FORScan's words every time
if (samplesDir && fs.existsSync(samplesDir)) {
  let blocks = 0, parsed = 0, faults = 0, disagree = [];
  for (const f of fs.readdirSync(samplesDir).filter(x => x.endsWith(".txt"))) {
    const t = fs.readFileSync(path.join(samplesDir, f), "utf8"), p = F.parse(t);
    blocks += (t.match(/^===(?!END )\S+ DTC .+===\s*$/gm) || []).length;
    parsed += p.counts.clean + p.counts.faults + p.counts.unparsed;
    faults += p.counts.faults;
    p.faults.filter(x => !x.decoded.agrees).forEach(x => disagree.push(f + " " + x.module + " " + x.raw));
  }
  ok(blocks > 0 && blocks === parsed, `real reports: all ${blocks} blocks parsed (${parsed})`);
  ok(disagree.length === 0, `real reports: the status byte agrees with FORScan for all ${faults} faults: ${disagree.slice(0, 5)}`);
  console.error(`real reports: ${blocks} blocks, ${faults} faults`);
}

/* ---- lib/manuals.js: searching the manuals' page text */
const M = require(path.join(appDir, "lib", "manuals.js"));
const LIBFIX = {
  format: "falconoath-lib/1", version: "v1", counts: { manuals: 4, pages: 6, text_pages: 5 },
  manuals: [
    { sha: "a".repeat(64), title: "FG Workshop Manual", folder: "FG", path: "FG/FG Workshop Manual.pdf", also: [], pages: 3, text_pages: 2, size: 5242880, error: "" },
    { sha: "b".repeat(64), title: "BA brochure <script>", folder: "BA", path: "BA/x.pdf", also: [], pages: 1, text_pages: 1, size: 900000, error: "" },
    { sha: "c".repeat(64), title: "Wiring", folder: "General", path: "General/w.pdf", also: [], pages: 1, text_pages: 1, size: 1000, error: "" },
    { sha: "d".repeat(64), title: "Scanned FG X handbook", folder: "FGX", path: "FGX/s.pdf", also: [], pages: 1, text_pages: 0, size: 1000, error: "" }],
  text: { ["a".repeat(64)]: ["Section 303-14 Electronic engine controls", "Knock sensor (KS) removal. P0325 knock sensor circuit. Torque the knock sensor to 20 Nm.", ""],
          ["b".repeat(64)]: ["XR6 knock-free performance <b>bold</b>"],
          ["c".repeat(64)]: ["A/C compressor relay, knock sensor shield wire"],
          ["d".repeat(64)]: [""] } };
const LX = M.index(LIBFIX);
ok(M.terms("Knock-sensor, A/C 303-14 x").join() === "knock,sensor,a/c,303-14", "manual search words: hyphens split, A/C and 303-14 kept, 1-letter dropped");
const ks = M.search(LX, "knock sensor");
ok(ks.length === 2 && ks[0].sha === "a".repeat(64) && ks[0].page === 2, "'knock sensor': the workshop page first (more hits, the phrase)");
ok(M.search(LX, "knock sensor", { model: "BA" }).every(h => ["b".repeat(64), "c".repeat(64)].includes(h.sha)), "BA reads BA and General manuals only");
ok(M.search(LX, "p0325", { model: "FGX" }).length === 1, "FG X reads FG's manuals too");
ok(M.search(LX, "p0325", { model: "BF" }).length === 0, "BF doesn't read FG's");
ok(M.search(LX, "a/c").length === 1 && M.search(LX, "zzzz").length === 0 && M.search(LX, "").length === 0, "A/C found; nonsense and empty find nothing");
ok(M.pagesWith(LX, "a".repeat(64), "knock").join() === "2", "pages of one manual that match");
const sn = M.snippet(LIBFIX.text["a".repeat(64)][1], "torque", 40);
ok(sn.some(([t, m]) => m && t === "Torque") && sn[0][0] === "…", "a snippet around the match, marked, with … where cut");

/* ---- the app's screens */
function makeCtx(store) {
  const loc = { hash: "#/", protocol: "https:", hostname: "lap.tn.ts.net", host: "lap.tn.ts.net:8443" };
  const ctx = {
    console, Intl, Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, encodeURIComponent, decodeURIComponent, Array, Set, Map, Object, String, RegExp,
    location: loc, FO_TEST: true, FO_DTC: D, FO_FORSCAN: F, FO_MAN: M,
    FO_IDB: { get: async () => null, put: async () => {}, del: async () => {} },
    Uint8Array, crypto: { getRandomValues: a => a, randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
                    removeItem: k => { delete store[k]; } },
    navigator: { onLine: true, serviceWorker: { controller: null } },
    document: { getElementById: () => null, querySelector: () => ({ content: "testbuild" }), querySelectorAll: () => [] },
    isSecureContext: true, matchMedia: () => ({ matches: false }), history: { replaceState() {}, length: 1 },
  };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(appDir, "app.js"), "utf8"), ctx, { filename: "app.js" });
  vm.runInContext(fs.readFileSync(path.join(appDir, "garage.js"), "utf8"), ctx, { filename: "garage.js" });
  vm.runInContext(fs.readFileSync(path.join(appDir, "manuals.js"), "utf8"), ctx, { filename: "manuals.js" });
  return ctx;
}
const BAD = /undefined|NaN|\[object Object\]/;
function check(ctx, hash, label, must) {
  let html = "";
  try { html = ctx.FO.screen(hash).html; } catch (e) { ok(false, `${label} ${hash}: threw ${e.message}`); return ""; }
  const m = BAD.exec(html);
  ok(!m, `${label} ${hash}: shows "${m && m[0]}"`);
  if (must) ok(html.includes(must), `${label} ${hash}: should show "${must}"`);
  return html;
}

const MODELS = ["ALL", "BA", "BF", "FG", "FGX"];
// no data, unpaired
let ctx = makeCtx({});
check(ctx, "#/", "no data", "No data yet");
check(ctx, "#/search?q=P0325", "no data", "Pair this device");
check(ctx, "#/code/P0325", "no data", "Pair this device");
check(ctx, "#/settings", "no data", "Pair this device");

// with data, every model
for (const m of MODELS) {
  ctx = makeCtx({ "falconoath.model": m, "falconoath.token": "t", "falconoath.lastOk": new Date().toISOString() });
  ctx.FO.useSnapshot(snap);
  check(ctx, "#/", m, "1,195 fault code entries");
  check(ctx, "#/browse", m, "step 6");
  check(ctx, "#/upload", m, "Choose the .txt file");
  check(ctx, "#/search", m);
  for (const q of ["P0325", "p325", "0325", "knock", "knock sensor", "U0", "zzzz", "B1201", "<script>"])
    check(ctx, "#/search?q=" + encodeURIComponent(q), m);
  for (const c of ix.codes) check(ctx, "#/code/" + c, m);
  check(ctx, "#/code/P9999", m, "isn't in the database");
  const h = check(ctx, "#/code/U0140", m);
  if (m === "FGX") ok(h.includes("from FG data"), "FG X code page shows the 'from FG data' badge");
  else ok(!h.includes("from FG data"), `${m} code page has no FG-data badge`);
  for (const st of ["idle", "ok", "offline", "unreachable", "error", "removed", "downloading"]) {
    ctx.FO.SYNC.state = st; ctx.FO.SYNC.error = st === "error" ? "boom" : null;
    const s = check(ctx, "#/settings", m + "/" + st);
    if (st === "unreachable") ok(s.includes("Open Tailscale") && s.includes("intent:#Intent"), "unreachable offers Open Tailscale");
  }
}
// a BA-only code seen from FG: the other models' entries are offered
ctx = makeCtx({ "falconoath.model": "FG" }); ctx.FO.useSnapshot(snap);
const baOnly = ix.codes.find(c => { const r = ix.byCode.get(c); return r.every(x => x.model === "BA"); });
if (baOnly) check(ctx, "#/code/" + baOnly, "BA-only on FG", "Other models list it");
// HTML in a query is escaped
const xs = check(ctx, "#/search?q=" + encodeURIComponent("<b>x</b>"), "escape");
ok(!xs.includes("<b>x</b>"), "a query is shown escaped");

/* ---- cars and scans */
const carIds = (snap.cars || []).map(c => c.id), scanIds = (snap.scans || []).map(s => s.id);
ok(carIds.length >= 1 && scanIds.length >= 1, "the snapshot has cars and scans to show");
for (const m of ["ALL", "FG"]) {
  ctx = makeCtx({ "falconoath.model": m, "falconoath.token": "t" }); ctx.FO.useSnapshot(snap);
  check(ctx, "#/", m + " home with scans", "Recent scans");
  check(ctx, "#/cars", m, "Add a FORScan scan");
  for (const id of carIds) check(ctx, "#/car/" + id, m + " car", "Fault scans");
  if ((snap.scans || []).some(s => !s.car_id)) check(ctx, "#/car/none", m, "Scans without a car");
  for (const id of scanIds) {
    const h = check(ctx, "#/scan/" + id, m + " scan", "The report as FORScan saved it");
    ok(!/<script/i.test(h.replace(/&lt;script/g, "")), "scan page has no raw script tag");
  }
  check(ctx, "#/scan/not-a-scan", m, "Scan not found");
  // grouped by status (the default), and by module when chosen
  const fixScan = (snap.scans || []).find(x => x.text.includes("Something odd"));
  if (fixScan) {
    const bs = check(ctx, "#/scan/" + fixScan.id, m + " by status", "How this was worked out (status byte 28)");
    const at = t => bs.indexOf(t);
    ok(at("<h2>Active at the scan</h2>") > 0 && at("<h2>Active at the scan</h2>") < at("<h2>Stored, not active</h2>")
       && at("<h2>Stored, not active</h2>") < at("<h2>Not understood</h2>"), "by status: active, then stored, then not understood");
    ok(/data-jump="active"><b>2<\/b>/.test(bs) && /data-jump="stored"><b>4<\/b>/.test(bs) && /t pending zero"/.test(bs), "the tally: 2 active, 0 pending, 4 stored");
    ok((bs.match(/<details class="frow /g) || []).length === 7, "one tappable row per fault and unknown block");
    ok(/<summary>\s*<span class="fc">U0401<\/span>/.test(bs) && bs.includes('<span class="chip ">No lamp</span>'), "a row leads with the code; tags are short");
    ok(/<tr class="on"><td><code>40<\/code><\/td><td>Its self-test hasn't finished this drive cycle<\/td><td>Yes/.test(bs.replace(/&#39;/g, "'")),
       "the flags table marks 40 on for C0034 (-68)");
    ok(bs.includes("packs <b>two things into one byte</b>") && bs.includes("(F means none given)"), "older modules' split byte explained");
    vm.runInContext('LS.set("scanOrder", "module")', ctx);
    const bm = check(ctx, "#/scan/" + fixScan.id, m + " by module", "Antilock braking system");
    ok(!bm.includes("<h2>Active at the scan</h2>") && bm.includes('<span class="chip bad">Active at the scan</span>'), "by module: grouped by module, each fault says its status");
    vm.runInContext('LS.set("scanOrder", null)', ctx);
  }
  check(ctx, "#/car/not-a-car", m, "Car not found");
  check(ctx, "#/upload", m, "Choose the .txt file");
  check(ctx, "#/newcar", m, "Save car");
  for (const code of ["U0140", "P0325", "B1267"]) check(ctx, "#/code/" + code, m + " code with sightings", "In your scans");
}
// what's made on this device and not yet on the laptop: shown, marked, and listed in Settings
ctx = makeCtx({ "falconoath.token": "t" }); ctx.FO.useSnapshot(snap);
vm.runInContext(`OUTBOX = [
  {id: "11111111-1111-4111-8111-111111111111", kind: "car", data: {nickname: "Pending car", model: "FGX", year: 2015, vin: null, kind: "ad"}, created: "2026-10-25T01:00:00Z", sent: null, result: null, detail: ""},
  {id: "22222222-2222-4222-8222-222222222222", kind: "scan", data: {text: ${JSON.stringify(fixText)}, file_name: "pending.txt", car_id: "11111111-1111-4111-8111-111111111111", scanned_on: "2026-10-24", note: "<b>note</b>"}, created: "2026-10-25T01:00:00Z", sent: "2026-10-25T01:00:01Z", result: null, detail: ""},
  {id: "33333333-3333-4333-8333-333333333333", kind: "car", data: {nickname: "Refused car"}, created: "2026-10-25T01:00:00Z", sent: "x", result: "rejected", detail: "that VIN is already on another car"}
]; GARAGE.cache = null;`, ctx);
check(ctx, "#/cars", "outbox", "Pending car");
check(ctx, "#/car/11111111-1111-4111-8111-111111111111", "outbox car", "Not on the laptop yet");
const ps = check(ctx, "#/scan/22222222-2222-4222-8222-222222222222", "outbox scan", "Sent, not applied yet");
ok(ps.includes("from FG data") && ps.includes("&lt;b&gt;note&lt;/b&gt;"), "a pending FG X scan explains from FG data; its note is escaped");
const st = check(ctx, "#/settings", "outbox", "Waiting for the laptop");
ok(st.includes("2 items") && st.includes("Refused: that VIN is already on another car") && st.includes("data-dismiss"), "Settings lists waiting and refused items");
// manuals: the library, search, the viewer's page, adding one, and one on its way to the laptop
let mc;
for (const m of ["ALL", "BA", "FGX"]) {
  mc = makeCtx({ "falconoath.token": "t", "falconoath.model": m }); mc.FO.useSnapshot(snap);
  check(mc, "#/manuals", m + " manuals, none synced", "No manuals on this device yet");
  mc.FO_MAN_APP.useLibrary(LIBFIX);
  const lst = check(mc, "#/manuals", m + " manuals", m === "BA" ? "BA brochure" : "FG Workshop Manual");
  ok(!lst.includes("<script>") && lst.includes("BA brochure &lt;script&gt;") === (m !== "FGX"), m + ": titles escaped; FG X shows FG X + FG + General");
  if (m !== "BA") ok(lst.includes("scanned: no text to search yet") === (m === "ALL" || m === "FGX"), m + ": a scanned manual says so");
  const sr = check(mc, "#/manuals?q=" + encodeURIComponent("knock sensor"), m + " manual search");
  if (m !== "BA") ok(sr.includes("<mark>Knock</mark> <mark>sensor</mark>") && sr.includes("#/manual/" + "a".repeat(64) + "?p=2&q=knock%20sensor"), m + ": hits link to the page, matches marked");
  check(mc, "#/manuals?q=zzzz", m + " manual search, nothing", "No page has");
  const bs = check(mc, "#/manuals?q=" + encodeURIComponent("<b>"), m + " escape in manual search");
  ok(!bs.includes("<b>bold") , m + ": page text is escaped in snippets");
  check(mc, "#/search?q=" + encodeURIComponent("knock sensor"), m + " code search", "In your manuals");
  const cp = check(mc, "#/code/P0325", m + " code page");
  ok(cp.includes("In your manuals") === (m !== "BA"), m + ": the P0325 page lists the manual page that mentions it (not for BA)");
  const v = check(mc, "#/manual/" + "a".repeat(64) + "?p=2&q=knock", m + " viewer", "FG Workshop Manual");
  ok(v.includes('data-goto="2"') && v.includes('value="2"') && v.includes("Keep on this phone"), m + ": viewer: page 2, the matching pages, keep button");
  check(mc, "#/manual/nope", m + " viewer", "Manual not found");
  check(mc, "#/addmanual", m + " add", "Choose a PDF");
  check(mc, "#/", m + " home", "4 manuals");
  check(mc, "#/settings", m + " settings", "4 (6 pages)");
}
mc = makeCtx({ "falconoath.token": "t" }); mc.FO.useSnapshot(snap); mc.FO_MAN_APP.useLibrary({ format: "falconoath-lib/1", version: "e", counts: { manuals: 0, pages: 0 }, manuals: [], text: {} });
check(mc, "#/manuals", "empty library", "press <b>M</b>".replace("press", "Press"));
vm.runInContext(`OUTBOX = [{id: "44444444-4444-4444-8444-444444444444", kind: "manual", uploaded: null,
  data: {upload_id: "55555555-5555-4555-8555-555555555555", file_name: "FG <wiring>.pdf", folder: "FG", size: 1048576},
  created: "2026-10-25T01:00:00Z", sent: null, result: null, detail: ""}]; GARAGE.cache = null;`, mc);
const pm = check(mc, "#/manuals", "manual going to the laptop", "Going to the laptop");
ok(pm.includes("FG &lt;wiring&gt;.pdf") && pm.includes("Waiting to send"), "a manual on its way is listed, escaped, with its state");
ok(check(mc, "#/settings", "manual in outbox").includes("1 manual"), "Settings counts it as waiting");
ok(vm.runInContext("OUTBOX.filter(o => !o.result && !(o.kind === 'manual' && !o.uploaded)).length", mc) === 0, "a manual's item isn't sent before its PDF is all on the laptop");

// settling: applied items leave the outbox, refused ones stay with their reason
(async () => {
  const fake = { applied: [["11111111-1111-4111-8111-111111111111", "applied", "", "11111111-1111-4111-8111-111111111111"],
                           ["22222222-2222-4222-8222-222222222222", "duplicate", "already", "x"]] };
  const notes = await ctx.outboxSettle(fake);
  const left = vm.runInContext("OUTBOX.map(o => o.id[0] + ':' + (o.result || ''))", ctx);
  ok(left.join() === "3:rejected", "settle: applied and duplicate leave, the refused one stays: " + left);
  ok(notes.some(x => /already on the laptop/.test(x)), "settle: a duplicate is mentioned");
  console.log(JSON.stringify({ n, fails: fails.slice(0, 30), nfails: fails.length }));
})();
