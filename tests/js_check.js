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

/* ---- the app's screens */
function makeCtx(store) {
  const loc = { hash: "#/", protocol: "https:", hostname: "lap.tn.ts.net", host: "lap.tn.ts.net:8443" };
  const ctx = {
    console, Intl, Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, encodeURIComponent, decodeURIComponent, Array, Set, Map, Object, String, RegExp,
    location: loc, FO_TEST: true, FO_DTC: D, FO_FORSCAN: F, FO_IDB: { get: async () => null, put: async () => {} },
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
