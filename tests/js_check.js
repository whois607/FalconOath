// Run by tests/check_app.py:  node js_check.js <app dir> <snapshot.json>
// The app's own code under node: lib/dtc.js search and lookup cases, then
// every screen rendered (every code, every model, paired or not, each sync
// state) with no exception and no "undefined", "NaN" or "[object Object]".
// Prints one JSON object: {n, fails: [...]}.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const [appDir, snapPath] = process.argv.slice(2);
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

/* ---- the app's screens */
function makeCtx(store) {
  const loc = { hash: "#/", protocol: "https:", hostname: "lap.tn.ts.net", host: "lap.tn.ts.net:8443" };
  const ctx = {
    console, Intl, Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, encodeURIComponent, decodeURIComponent, Array, Set, Map, Object, String, RegExp,
    location: loc, FO_TEST: true, FO_DTC: D, FO_IDB: { get: async () => null, put: async () => {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
                    removeItem: k => { delete store[k]; } },
    navigator: { onLine: true, serviceWorker: { controller: null } },
    document: { getElementById: () => null, querySelector: () => ({ content: "testbuild" }), querySelectorAll: () => [] },
    isSecureContext: true, matchMedia: () => ({ matches: false }), history: { replaceState() {}, length: 1 },
  };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(appDir, "app.js"), "utf8"), ctx, { filename: "app.js" });
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
  check(ctx, "#/upload", m, "step 2");
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

console.log(JSON.stringify({ n, fails: fails.slice(0, 30), nfails: fails.length }));
