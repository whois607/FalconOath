// Run by tests/check_app.py:  node js_check.js <app dir> <snapshot.json> <fixture.txt> [samples dir]
// The app's own code under node: lib/dtc.js search and lookup cases, then
// every screen rendered (every code, every model, paired or not, each sync
// state) with no exception and no "undefined", "NaN" or "[object Object]".
// Prints one JSON object: {n, fails: [...]}.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const [appDir, snapPath, fixturePath, samplesDir, logFixPath] = process.argv.slice(2);
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
    { sha: "a".repeat(64), title: "FG Workshop Manual", folder: "FG", path: "FG/Ford-Falcon-FG-2008-2014 <manual>/FG Workshop Manual.pdf", also: [], pages: 3, text_pages: 2, size: 5242880, error: "" },
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
let sf = M.searchFor(LX, "p0325", "FG");
ok(sf.via === null && sf.hits.length === 1, "searchFor: a FG car's own manual has P0325");
sf = M.searchFor(LX, "p0325", "BA");
ok(sf.via === "FG" && sf.hits.length === 1, "searchFor: nothing in BA's manuals, so the nearest that has it (FG), said so");
sf = M.searchFor(LX, "xr6", "FG");
ok(sf.via === "BA", "searchFor: from FG, falls back as far as BA");
ok(M.searchFor(LX, "zzzz", "BA").hits.length === 0 && M.searchFor(LX, "p0325", "ALL").via === null, "searchFor: nothing found, and no fallback for All");
const sn = M.snippet(LIBFIX.text["a".repeat(64)][1], "torque", 40);
ok(sn.some(([t, m]) => m && t === "Torque") && sn[0][0] === "…", "a snippet around the match, marked, with … where cut");

/* ---- lib/livelog.js: FORScan live-data logs */
const G = require(path.join(appDir, "lib", "livelog.js"));
const logText = fs.readFileSync(logFixPath, "utf8");
const LG = G.parse(logText);
ok(LG && LG.rows === 2001 && Math.round(LG.duration) === 60 && LG.cols.length === 11, "log fixture: 2,001 rows, 60 s, 11 PIDs");
const ectC = G.has(LG, "ECT");
ok(ectC.unit === "°C" && ectC.label === "Coolant temp" && ectC.num && isNaN(ectC.v[0]) && ectC.v[2] === 78, "ECT(°C): unit, plain name, '-' as no value");
const cr = G.has(LG, "CRUISE");
ok(!cr.num && cr.states.join() === "Off,On", "CRUISE is a word PID: Off / On");
ok(G.has(LG, "TP") === G.has(LG, "TP1") && G.has(LG, "O2S").base === "O2S11" && G.has(LG, "SPARK") === null, "TP finds TP1, O2S finds O2S11; nothing for a PID not logged");
const bst = G.stats(G.has(LG, "B+"), 0, LG.rows);
ok(bst.min > 14.1 && bst.max < 14.3 && Math.abs(bst.avg - 14.2) < 0.02, "stats: battery 14.2 V");
const sp = G.span(LG, 10, 20);
ok(LG.t[sp[0]] >= 10 && LG.t[sp[0] - 1] < 10 && LG.t[sp[1] - 1] >= 20 && LG.t[sp[1] - 1] < 20.05, "span: the rows of 10-20 s (and the next, to draw to the edge)");
const env = G.envelope(LG.t, G.has(LG, "RPM").v, 0, LG.rows, 0, 60, 100);
ok(env.lo.length === 100 && env.lo[0] < 710 && env.hi[99] > 1900, "envelope: min/max per pixel column");
const cks = G.checks(LG), cv = Object.fromEntries(cks.map(c => [c.id, c.verdict]));
ok(JSON.stringify(cv) === JSON.stringify({ trim1: "good", o2up1: "good", cat1: "good", ect: "good", bat: "good", idle: "good" }),
   "health checks on the healthy fixture: all six good " + JSON.stringify(cv));
ok(/700 rpm ±\d+ \(wants 700\)/.test(cks.find(c => c.id === "idle").value), "idle: rpm, spread and what the PCM wants");
const bad = G.parse(logText.replace(/;4\.0;/g, ";18.0;"));
ok(G.checks(bad).find(c => c.id === "trim1").verdict === "warn", "long-term trim +18% -> check (running lean)");
const hot = G.parse(logText.replace(/;9[01];/g, ";118;"));
ok(G.checks(hot).find(c => c.id === "ect").verdict === "bad", "coolant over 110 °C -> problem");
const open = G.parse(logText.replace(/;(-?\d+\.\d);4\.0;/g, ";0.0;0.0;"));
ok(G.checks(open).find(c => c.id === "trim1").verdict === "info" && G.checks(open).find(c => c.id === "o2up1").verdict === "info",
   "trims flat at 0: open loop, so trims and O2 are only noted, not judged");
ok(G.checks(G.parse("time(ms);FAN_F\n0;No Fault\n")).length === 0 && G.parse("hello") === null, "no checks without the PIDs; not a log -> null");
ok(G.suggest("P0325").pids.includes("RPM") && G.suggest("P0171").pids.includes("LONGFT") && G.suggest("B1267") === null, "suggest: PIDs for P0325 and P0171; none for B1267");
ok(G.covered(LG, G.suggest("P0420").pids).map(c => c.base).join() === "O2S11,O2S12,ECT,RPM", "covered: P0420's PIDs in this log");
ok(G.coveredNames(["RPM(1/min)", "TP1(V)"], ["TP", "MAF"]).join() === "TP", "coveredNames from just the headers");
ok(G.norm("\ufefftime(ms);A\r\n0;1\r\n\r\n") === "time(ms);A\n0;1\n", "norm matches the laptop's");

/* ---- lib/brochure.js: suggestions from a brochure page (step 6) */
const B = require(path.join(appDir, "lib", "brochure.js"));
const BPAGE = ["FG MkII Falcon XR6 Turbo sedan", "4.0L DOHC 24-valve turbocharged inline six", "270 kW @ 5250 rpm", "533 Nm @ 2000-4750 rpm",
  "ZF 6-speed automatic transmission", "Fuel economy (combined) 11.8L/100km", "Fuel tank 68 litres", '19" alloy wheels', "245/35 ZR19 tyres",
  "Overall length 4955 mm", "Kerb weight 1,815 kg", "Braked towing capacity 1,600 kg", "• Brembo front brakes", "• Sat nav (optional)",
  "Premium leather seats - optional", "XR6 and XR8 share the sports body kit"].join("\n");
const BS = B.suggest(BPAGE, "FG"), bv = k => BS.facts.filter(f => f.kind === k).map(f => (f.label ? f.label + ": " : "") + f.value).join(" | ");
ok(BS.trims.map(t => t.name).join() === "XR6 Turbo,XR6,XR8" && BS.series.join() === "FG MkII" && BS.bodies.join() === "sedan",
   "brochure: trim names (XR6 Turbo not also XR6), the series, the body " + JSON.stringify([BS.trims, BS.series]));
ok(bv("power") === "270 kW @ 5250 rpm" && bv("torque") === "533 Nm @ 2000–4750 rpm" && bv("engine") === "4.0L DOHC 24-valve turbocharged inline six"
   && bv("gearbox") === "ZF 6-speed automatic", "brochure: power, torque, engine, gearbox " + [bv("power"), bv("torque"), bv("engine"), bv("gearbox")]);
ok(bv("fuel") === "Combined: 11.8 L/100 km | Fuel tank: 68 L" && bv("wheels") === '19" alloy wheels' && bv("tyres") === "245/35 R19",
   "brochure: fuel use and tank, wheels, tyres " + [bv("fuel"), bv("wheels"), bv("tyres")]);
ok(bv("dimension") === "Overall length: 4955 mm" && bv("weight") === "Kerb weight: 1,815 kg" && bv("towing") === "Braked towing capacity: 1,600 kg",
   "brochure: size, weight, towing " + [bv("dimension"), bv("weight"), bv("towing")]);
ok(bv("standard") === "Brembo front brakes" && bv("option") === "Sat nav (optional) | Premium leather seats" && BS.facts.length === 14,
   "brochure: a bullet is standard gear, one saying optional is an option; nothing else made up " + [bv("standard"), bv("option"), BS.facts.length]);
const BC = B.suggest("Colours\nWinter White\nKinetic\nSilhouette\nLightning Strike*\nSTANDARD\nPrestige paint\nXR6", "FG");
ok(BC.facts.map(f => f.kind + ":" + f.value).join() === "colour:Winter White,colour:Kinetic,colour:Silhouette,colour:Lightning Strike",
   "brochure: colour names on a paint page, not headings or trim names " + JSON.stringify(BC.facts));
ok(B.suggest("Winter White\nKinetic", "FG").facts.length === 0, "brochure: no colours suggested on a page that isn't about paint");
const BF = B.suggest("BF Mk II and BF Series III, Fairmont Ghia, G6E Turbo; the XT and GT, a gt and xt", "BF");
ok(BF.series.join() === "BF MkII,BF MkIII" && BF.trims.map(t => t.name).join() === "Fairmont Ghia,G6E Turbo,XT,GT" && BF.trims.every(t => t.n === 1),
   "brochure: series written any way; short names only in capitals " + JSON.stringify(BF));
ok(B.suggest("", "FG").facts.length === 0 && B.suggest(null, "BA").trims.length === 0, "brochure: an empty page suggests nothing");
ok(B.factKey({ kind: "power", label: "", value: "270  kW" }) === B.factKey({ kind: "power", label: "", value: "270 kW" }), "factKey ignores spacing");
ok(B.grouped([{ kind: "colour" }, { kind: "gearbox" }, { kind: "power" }]).map(g => g[0] + ":" + g[2].map(f => f.kind)).join() === "drive:power,gearbox,colour:colour",
   "grouped: engine and drive first (power first), then colours");

/* ---- lib/brochure.js on code tables, and lib/checker.js (step 7) */
const IDPAGE = ["Body Style Code", "BODY TYPE CODE", "XT Sedan SW", "XR Ute CM", "Model Code", "Body Type Body Style Model Code", "SedanXT 10333",
  "A typical plate is shown here.Sedan XR 10335", "Ute XR Tray 40375", "Sedan FMT Ghia 10338",
  "Paint Colour and Code Vehicle Compliance (VC) Label", "Name Colour Code", "requiredPolar Test (Q1) 6TSA rules",
  "Heavy FinesGloomy introduction May (NN) 6ZZA Apply", "ReDoNe introduction Dec (PP) 6RDA", "Burnt Test HO",
  "Compliance Plate (A-pillar)Spectre P3", "Trim Colour and Code", "Colour Code", "Soft Grey B1", "DESCRIPTION AND OPERATION"].join("\n");
const IS = B.suggest(IDPAGE, "BF"), iv = k => IS.facts.filter(f => f.kind === k).map(f => f.code + "=" + f.value + (f.label ? "/" + f.label : "")).join(" | ");
ok(iv("bodycode") === "SW=XT Sedan | CM=XR Ute", "codes: body codes under their heading " + iv("bodycode"));
ok(iv("modelcode") === "10333=Sedan XT | 10335=Sedan XR | 40375=Ute XR Tray | 10338=Sedan FMT Ghia", "codes: model codes, run-in text and glued words fixed " + iv("modelcode"));
ok(iv("paintcode") === "Q1=Polar Test/6TSA | NN=Gloomy/6ZZA | PP=ReDoNe/6RDA | HO=Burnt Test | P3=Spectre",
   "codes: paint codes from 'Name (Q1) 6TSA', 'introduction' dates dropped, columns unglued, not (VC) " + iv("paintcode"));
ok(iv("trimcode") === "B1=Soft Grey" && !IS.facts.some(f => f.kind === "colour"), "codes: interior trim codes; headings aren't colours " + iv("trimcode") + JSON.stringify(IS.facts.filter(f => f.kind === "colour")));
const C = require(path.join(appDir, "lib", "checker.js"));
ok(C.month("06/2010") === "2010-06" && C.month("6/10") === "2010-06" && C.month("062010") === "2010-06" && C.month("2010-6") === "2010-06"
   && C.month("") === "" && C.month("13/2010") === null && C.month("junk") === null, "month: MM/YYYY and friends");
const S7 = "a".repeat(64), cf = (id, model, kind, code, value, extra) => Object.assign({ id, model, series: "", trim_id: null, kind, code, value, label: "", doc_sha: S7, page: 4 }, extra || {});
const CODES = [cf("c1", "BF", "bodycode", "SW", "XT Sedan"), cf("c2", "BF", "bodycode", "SW", "XR Sedan"), cf("c3", "BF", "bodycode", "CM", "XR Ute"),
  cf("c4", "BF", "modelcode", "10335", "Sedan XR"), cf("c5", "BF", "modelcode", "10333", "Sedan XT"), cf("c6", "BF", "modelcode", "10338", "Sedan FMT Ghia"),
  cf("c7", "BF", "paintcode", "A1", "Winter White"), cf("c8", "BF", "paintcode", "09", "Lightning Strike"), cf("c9", "BF", "paintcode", "ST", "Silhouette"),
  cf("c10", "BF", "trimcode", "B1", "Warm Charcoal"), cf("c11", "BF", "colour", "A1", "Winter White", { series: "BF MkII", code: "" }),
  cf("c12", "BF", "colour", "", "Silhouette", { series: "BF MkII", code: "" }), cf("c13", "FG", "paintcode", "KZ", "Kinetic")];
const XR6 = { id: "t1", model: "BF", series: "BF MkII", name: "XR6 Turbo", body: "sedan", years: "2006-2008" };
const MODS = [["BA", "BA", 2002, 2005, "BA"], ["BF", "BF", 2005, 2008, "BF"], ["FG", "FG", 2008, 2014, "FG"], ["FGX", "FG X", 2014, 2016, "FG"]];
const run = (car, trim) => C.check({ car: Object.assign({ model: "BF" }, car), trim: trim === undefined ? XR6 : trim, facts: CODES, models: MODS });
const vd = R => Object.fromEntries(R.checks.map(x => [x.id, x.verdict]));
let R7 = run({ paint_code: "st", trim_code: "B1", body_code: "SW", model_code: "10335", build_date: "2007-03" });
ok(JSON.stringify(vd(R7)) === JSON.stringify({ trim: "good", paint_code: "good", trim_code: "info", body_code: "good", model_code: "good", build_date: "good" }),
   "checker: an XR6 Turbo with its own codes is factory throughout " + JSON.stringify(vd(R7)));
ok(R7.checks.find(x => x.id === "body_code").meaning === "XT Sedan / XR Sedan" && R7.checks.find(x => x.id === "paint_code").src.page === 4, "checker: what a code means, and the page it came from");
R7 = run({ paint_code: "O9", body_code: "CM", model_code: "10333" });
ok(vd(R7).paint_code === "warn" && /Not in the BF MkII colours/.test(R7.checks.find(x => x.id === "paint_code").note) && /O and 0/.test(R7.checks.find(x => x.id === "paint_code").note),
   "checker: a colour the series' brochure doesn't list is to check (O9 read as 09, said so)");
ok(vd(R7).body_code === "bad" && vd(R7).model_code === "warn", "checker: a ute body code on a sedan doesn't fit; an XT model code on an XR6 Turbo is to check");
ok(/is a Sedan XT; this car is set as an XR6 Turbo/.test(R7.checks.find(x => x.id === "model_code").note) && /the trim is a sedan/.test(R7.checks.find(x => x.id === "body_code").note),
   "checker: plain English (an XR6, a sedan) " + R7.checks.find(x => x.id === "model_code").note);
ok(vd(run({ model_code: "10338" }, Object.assign({}, XR6, { name: "Fairmont Ghia" }))).model_code === "good", "checker: FMT in the tables is a Fairmont");
R7 = run({ paint_code: "ZZ", build_date: "2011-01" });
ok(vd(R7).paint_code === "unknown" && vd(R7).build_date === "bad", "checker: a code not in your tables is unknown (not guessed); built after the BF ended doesn't fit");
ok(vd(run({ build_date: "2005-02" })).build_date === "warn", "checker: built outside the trim's years is to check");
R7 = run({ paint_code: "KZ" }, { id: "t2", model: "FGX", series: "", name: "XR6", body: "sedan", years: "" });
ok(vd(R7).paint_code === "info" && /Only in the FG tables/.test(R7.checks.find(x => x.id === "paint_code").note), "checker: another model's table is only a hint, said so");
ok(vd(run({}, null)).trim === "unknown" && vd(run({ model: "BA" })).trim === "bad", "checker: no trim chosen; a trim of another model doesn't fit");
ok(run({ paint_code: "A1" }, null).checks.find(x => x.id === "paint_code").verdict === "info", "checker: without a trim a code is only explained");

/* ---- the app's screens */
function makeCtx(store) {
  const loc = { hash: "#/", protocol: "https:", hostname: "lap.tn.ts.net", host: "lap.tn.ts.net:8443" };
  const ctx = {
    console, Intl, Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, encodeURIComponent, decodeURIComponent, Array, Set, Map, Object, String, RegExp,
    location: loc, FO_TEST: true, FO_DTC: D, FO_FORSCAN: F, FO_MAN: M, FO_LOG: G, FO_BRO: B, FO_CHECK: C,
    FO_IDB: { get: async () => null, put: async () => {}, del: async () => {} },
    Uint8Array, crypto: { getRandomValues: a => a, randomUUID: (() => { let i = 0; return () => "00000000-0000-4000-8000-" + String(++i).padStart(12, "0"); })() },
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
  vm.runInContext(fs.readFileSync(path.join(appDir, "logs.js"), "utf8"), ctx, { filename: "logs.js" });
  vm.runInContext(fs.readFileSync(path.join(appDir, "prices.js"), "utf8"), ctx, { filename: "prices.js" });
  vm.runInContext(fs.readFileSync(path.join(appDir, "browse.js"), "utf8"), ctx, { filename: "browse.js" });
  vm.runInContext(fs.readFileSync(path.join(appDir, "factory.js"), "utf8"), ctx, { filename: "factory.js" });
  return ctx;
}
const BAD = /undefined|NaN|\[object Object\]/;
const PENDING = [];      // checks that finish later (awaited before the results are printed)
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
  check(ctx, "#/browse", m, "only as you've confirmed them");
  check(ctx, "#/upload", m, "Choose the .txt or .csv file");
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
  check(ctx, "#/cars", m, "Add a FORScan file");
  for (const id of carIds) check(ctx, "#/car/" + id, m + " car", "Fault scans");
  if ((snap.scans || []).some(s => !s.car_id)) check(ctx, "#/car/none", m, "Without a car yet");
  for (const id of scanIds) {
    const h = check(ctx, "#/scan/" + id, m + " scan", "The report as FORScan saved it");
    ok(!/<script/i.test(h.replace(/&lt;script/g, "")), "scan page has no raw script tag");
  }
  check(ctx, "#/scan/not-a-scan", m, "Scan not found");
  // grouped by status (the default), and by module when chosen
  const fixScan = (snap.scans || []).find(x => x.text.includes("Something odd"));
  if (fixScan) {
    const bs = check(ctx, "#/scan/" + fixScan.id, m + " by status", "FORScan's notes and the status byte");
    const at = t => bs.indexOf(t);
    ok(!bs.includes("How this was worked out") && !bs.includes("<summary>FORScan's notes"), "the fault rows no longer fold out the notes or the status byte");
    ok(bs.includes(`#/code/C0034?scan=${encodeURIComponent(fixScan.id)}&amp;f=2`) || bs.includes(`#/code/C0034?scan=${encodeURIComponent(fixScan.id)}&f=2`),
       "'All about C0034' opens the code page with this scan's fault");
    // the code page, opened from the scan: this fault's status, notes and byte
    const cf = check(ctx, `#/code/C0034?scan=${encodeURIComponent(fixScan.id)}&f=2`, m + " code from scan", "This fault in your scan");
    ok(cf.includes("How this was worked out (status byte 68)"), "the code page explains the status byte (68)");
    ok(/<tr class="on"><td><code>40<\/code><\/td><td>Its self-test hasn't finished this drive cycle<\/td><td>Yes/.test(cf.replace(/&#39;/g, "'")),
       "the flags table marks 40 on for C0034 (-68)");
    const cu = check(ctx, `#/code/U0140?scan=${encodeURIComponent(fixScan.id)}&f=0`, m + " code from scan", "How this was worked out (status byte 28)");
    const ck = check(ctx, `#/code/B1267?scan=${encodeURIComponent(fixScan.id)}&f=4`, m + " code from scan (older module)");
    ok(ck.includes("packs <b>two things into one byte</b>") && ck.includes("(F means none given)"), "older modules' split byte explained");
    ok(!check(ctx, `#/code/P0325?scan=${encodeURIComponent(fixScan.id)}&f=0`, m + " mismatched f").includes("This fault in your scan"),
       "a code page whose f points at another code shows no scan fault");
    ok(!check(ctx, "#/code/C0034?scan=nope&f=2", m + " unknown scan").includes("This fault in your scan"), "an unknown scan shows none either");
    ok(at("<h2>Active at the scan</h2>") > 0 && at("<h2>Active at the scan</h2>") < at("<h2>Stored, not active</h2>")
       && at("<h2>Stored, not active</h2>") < at("<h2>Not understood</h2>"), "by status: active, then stored, then not understood");
    ok(/data-jump="active"><b>2<\/b>/.test(bs) && /data-jump="stored"><b>4<\/b>/.test(bs) && /t pending zero"/.test(bs), "the tally: 2 active, 0 pending, 4 stored");
    ok((bs.match(/<details class="frow /g) || []).length === 7, "one tappable row per fault and unknown block");
    ok(/<summary>\s*<span class="fc">U0401<\/span>/.test(bs) && bs.includes('<span class="chip ">No lamp</span>'), "a row leads with the code; tags are short");
    vm.runInContext('LS.set("scanOrder", "module")', ctx);
    const bm = check(ctx, "#/scan/" + fixScan.id, m + " by module", "Antilock braking system");
    ok(!bm.includes("<h2>Active at the scan</h2>") && bm.includes('<span class="chip bad">Active at the scan</span>'), "by module: grouped by module, each fault says its status");
    vm.runInContext('LS.set("scanOrder", null)', ctx);
  }
  check(ctx, "#/car/not-a-car", m, "Car not found");
  check(ctx, "#/upload", m, "Choose the .txt or .csv file");
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
  if (m !== "BA") ok(sr.includes('<span class="msub">Ford-Falcon-FG-2008-2014 &lt;manual&gt;</span>') && (sr.match(/class="msub"/g) || []).length === 1,
     m + ": a hit shows the manual's subfolder (escaped); one straight in a model folder shows none");
  if (m !== "BA") ok(lst.includes('<span class="msub">Ford-Falcon-FG-2008-2014 &lt;manual&gt;</span>'), m + ": the manual list shows the subfolder too");
  check(mc, "#/manuals?q=zzzz", m + " manual search, nothing", "No page has");
  const bs = check(mc, "#/manuals?q=" + encodeURIComponent("<b>"), m + " escape in manual search");
  ok(!bs.includes("<b>bold") , m + ": page text is escaped in snippets");
  check(mc, "#/search?q=" + encodeURIComponent("knock sensor"), m + " code search", "In your manuals");
  const cp = check(mc, "#/code/P0325", m + " code page");
  ok(cp.includes("In your manuals") && cp.includes("from the <b>FG</b> manual") === (m === "BA"),
     m + ": the P0325 page lists its manual page (for BA, from the FG manual, said so)");
  const fs = (snap.scans || []).find(x => x.text.includes("Something odd"));
  if (fs) {
    const sp = check(mc, "#/scan/" + fs.id, m + " scan with manuals", "Manual pages");
    ok(sp.includes(`#/manual/${"a".repeat(64)}?p=2&amp;q=P0325`) || sp.includes(`#/manual/${"a".repeat(64)}?p=2&q=P0325`),
       m + ": a fault row links straight to the manual page for its code");
  }
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

// live-data logs: on the car page, without a car, the viewer's page, and links from faults
{
  const lc = makeCtx({ "falconoath.token": "t" }); lc.FO.useSnapshot(snap);
  const logs = snap.logs || [];
  ok(logs.length === 2, "the snapshot has 2 logs");
  const onCar = logs.find(l => l.car_id), loose = logs.find(l => !l.car_id);
  if (onCar && loose) {
    const cp = check(lc, "#/car/" + onCar.car_id, "car with a log", "Live-data logs");
    ok(cp.includes("#/log/" + onCar.id) && cp.includes("1 min") && cp.includes("11 PIDs"), "the car lists its log: duration and PID count");
    const cars = check(lc, "#/cars", "cars with a loose log", "Without a car yet");
    ok(cars.includes("1 log (from FORScan's folder)") && cars.includes("Choose a car"), "a log with no car shows on Cars, asking for a car");
    const none = check(lc, "#/car/none", "without a car", "Which car is this from?");
    ok(none.includes(`data-assign="log:${loose.id}"`), "and can be put on a car there");
    const v = check(lc, "#/log/" + onCar.id, "log viewer", "Opening the log");
    ok(v.includes('id="lcv"') && v.includes("Compare with") && v.includes(`value="${loose.id}"`) && v.includes(`data-assign="log:${onCar.id}"`),
       "viewer: a canvas, compare with the other log, and its car can be changed");
    check(lc, "#/log/nope", "log viewer", "Log not found");
    const hint = lc.FO_LOGS_APP.logHintHtml("P0325", onCar.car_id);
    ok(hint.includes("Check it with live data") && hint.includes("#/log/" + onCar.id + "?pids=") && hint.includes("Engine speed"),
       "a fault links to this car's log at the PIDs that show it");
    ok(lc.FO_LOGS_APP.logHintHtml("P0325", null).includes("Log: engine speed, throttle"), "no log yet: which PIDs to log");
    ok(lc.FO_LOGS_APP.logHintHtml("B1267", onCar.car_id) === "", "no hint for codes live data can't show");
    const d = lc.FO_LOGS_APP.defaultSel(LG, null).map(i => LG.cols[i].base);
    ok(d.join() === "RPM,VSS,ECT,TP1", "the viewer starts with engine speed, road speed, coolant and throttle");
    ok(lc.FO_LOGS_APP.defaultSel(LG, ["ECT(°C)", "B+"]).map(i => LG.cols[i].base).join() === "ECT,B+", "or the PIDs in the link");
    const up = check(lc, "#/upload", "upload", "Choose the .txt or .csv file");
    ok(up.includes('accept=".txt,.csv'), "the upload page takes logs too");
    const st2 = check(lc, "#/settings", "settings with logs", "Live-data logs");
    ok(st2.includes("2, 0 on this device"), "Settings: how many logs, and how many are on this device");
  }
  vm.runInContext(`OUTBOX = [{id: "66666666-6666-4666-8666-666666666666", kind: "attach", data: {what: "log", id: ${JSON.stringify(loose ? loose.id : "")}, car_id: ${JSON.stringify(onCar ? onCar.car_id : "")}},
    created: "2026-10-25T01:00:00Z", sent: null, result: null, detail: ""}]; GARAGE.cache = null;`, lc);
  if (onCar) ok(check(lc, "#/car/" + onCar.car_id, "car after attach").includes("#/log/" + loose.id), "a log put on a car here shows on it straight away");
  ok(vm.runInContext("OUTBOX.filter(o => !o.result && !(BIG.includes(o.kind) && !o.uploaded)).length", lc) === 1, "an attach item goes with the next sync");
}

// prices from VPA (step 5): the screens, a car's market line, the home tile
{
  const pc = makeCtx({ "falconoath.token": "t" });
  pc.FO.useSnapshot(snap);
  check(pc, "#/prices", "no prices", "No prices yet");
  const g = (name, cars, median, p25, p75) => ({ name, cars, median, mean: median + 500, p25, p75, km: 150000, recent: 3 });
  const PR = { format: "falconoath-prices/1", cars: 9, first: "2026-05-15", last: "2026-10-25", recent_days: 14, models: {
    FG: Object.assign(g("FG", 6, 16000, 11000, 25000), { series: [g("FG", 3, 14000, 9000, 20000), g("FG MkII", 3, 17000, 12000, 28000)],
                                                       trims: [g("XR6", 4, 14000, 10000, 19000), g("XR6 <Turbo>", 2, 31000, 25000, 36000)] }),
    BA: Object.assign(g("BA", 3, 12000, 6000, 20000), { series: [g("BA", 3, 12000, 6000, 20000)], trims: [g("XR8", 3, 20000, 15000, 25000)] }) } };
  pc.FO.useSnapshot(Object.assign({}, snap, { prices: PR }));
  const all = check(pc, "#/prices", "prices, every model", "Every model");
  ok(all.includes("$16,000") && all.includes("$12,000") && all.includes("15/05/2026 to 25/10/2026") && !all.includes("<b>BF</b>") && all.includes("<b>FG</b>"), "every model with prices, Australian dates, none for models without");
  const fg = check(pc, "#/prices?m=FG", "prices FG", "By trim");
  ok(fg.includes("By series") && fg.includes("FG MkII") && fg.includes("$11,000–$25,000") && fg.includes("XR6 &lt;Turbo&gt;"), "FG: headline, middle half, series and trims (escaped)");
  ok(!check(pc, "#/prices?m=BA", "prices BA", "By trim").includes("By series"), "one series: no series table");
  check(pc, "#/prices?m=BF", "prices BF", "No BFs in VPA yet");
  ok(pc.FO_PRICES_APP.priceLineHtml("FG").includes("$16,000") && pc.FO_PRICES_APP.priceLineHtml("FGX") === "" && pc.FO_PRICES_APP.priceLineHtml(null) === "",
     "a car's market line: its model's median; nothing without prices or a model");
  const fgCar = (snap.cars || []).find(c => c.model === "FG");
  if (fgCar) ok(check(pc, "#/car/" + fgCar.id, "car with prices").includes("FGs for sale"), "an FG car's page shows what FGs are asking");
  ok(check(pc, "#/", "home with prices").includes("FG $16,000"), "the Prices tile on Home");
}

// trims from brochures (step 6): Browse, a trim, a series, the brochure reader, deletes and the outbox
{
  const E = "e".repeat(64), T1 = "77777777-7777-4777-8777-777777777777";
  const fact = (id, kind, value, extra) => Object.assign({ id, model: "FG", series: "FG MkII", trim_id: T1, kind, label: "", value, code: "",
    doc_sha: E, page: 1, created_at: "2026-10-25 10:00:00" }, extra || {});
  const TSNAP = Object.assign({}, snap, {
    trims: [{ id: T1, model: "FG", series: "FG MkII", name: "XR6 Turbo", body: "sedan", years: "2011-2014", notes: "<i>notes</i>", doc_sha: E, page: 1,
              created_at: "2026-10-25 10:00:00", created_on: "phone:x", updated_at: "2026-10-25 10:00:00" }],
    facts: [fact("70000000-0000-4000-8000-000000000001", "power", "270 kW @ 5250 rpm"), fact("70000000-0000-4000-8000-000000000002", "standard", "Brembo <brakes>"),
            fact("70000000-0000-4000-8000-000000000003", "colour", "Kinetic", { trim_id: null, code: "KZ", page: 2 })] });
  const BLIB = JSON.parse(JSON.stringify(LIBFIX));
  BLIB.manuals.push({ sha: E, title: "FG MkII brochure", folder: "FG", path: "FG/Brochures/FG MkII brochure.pdf", brochure: true, also: [], pages: 3, text_pages: 2, size: 3000000, error: "" });
  BLIB.text[E] = [BPAGE, "Colours\nWinter White\nKinetic", ""];
  BLIB.counts.manuals = 5;
  const bc = makeCtx({ "falconoath.token": "t", "falconoath.model": "FG" });
  bc.FO.useSnapshot(snap);
  bc.FO_MAN_APP.useLibrary(BLIB);
  check(bc, "#/browse?m=FG", "browse, no trims", "Open a brochure below");
  check(bc, "#/browse?m=BA", "browse BA, no brochures", "manuals\\BA\\Brochures");
  bc.FO.useSnapshot(TSNAP);
  const br = check(bc, "#/browse?m=FG", "browse FG", "FG MkII");
  ok(br.includes(`#/trim/${T1}`) && br.includes('<span class="tk">270 kW</span>') && br.includes("ZF") === false && br.includes("1 colour · every FG MkII"),
     "browse: a tile per trim (power big), the series' colours linked");
  ok(br.includes(`#/brochure/${E}?p=1&m=FG`) && br.includes("3 saved"), "browse: the brochure, with how much has been saved from it");
  const ball = check(bc, "#/browse?m=all", "browse all", "Brochures");
  ok(ball.includes("#/browse?m=FG") && ball.includes('<span class="tk">1</span>'), "browse All: each model with its trim count (All works with a model chosen)");
  const tp = check(bc, "#/trim/" + T1, "trim page", "XR6 Turbo");
  ok(tp.includes("270 kW @ 5250 rpm") && tp.includes("Brembo &lt;brakes&gt;") && tp.includes("&lt;i&gt;notes&lt;/i&gt;") && !tp.includes("<i>notes"),
     "trim page: power, standard gear, notes, all escaped");
  ok(tp.includes(`#/manual/${E}?p=1`) && tp.includes("Kinetic") && tp.includes("every FG MkII") && tp.includes("<code>KZ</code>"),
     "trim page: each fact links to its brochure page; the series' colours (with code) too");
  ok(!tp.includes("data-delfact") && check(bc, `#/trim/${T1}?edit=1`, "trim edit", "Delete this trim").includes("data-delfact"), "edit mode: delete buttons and the trim's fields");
  check(bc, "#/trim/nope", "trim page", "Trim not found");
  check(bc, "#/series?m=FG&s=" + encodeURIComponent("FG MkII"), "series page", "Kinetic");
  const rd = check(bc, `#/brochure/${E}?p=1&m=FG`, "brochure reader", "Found on this page");
  ok(rd.includes(`value="${T1}" selected`), "reader: saves to the trim named on the page that's already there");
  ok(!rd.includes('value="270 kW @ 5250 rpm"') && rd.includes('value="533 Nm @ 2000–4750 rpm"') && rd.includes("Saved from this page"),
     "reader: what's already saved isn't suggested again, and is listed as saved");
  ok((rd.match(/data-on="/g) || []).length === 13 && !/data-on="\d+" checked/.test(rd), "reader: the other 13 suggestions, none ticked until you do");
  ok(rd.includes('data-pickname="XR6 Turbo"') && rd.includes("+ A new trim") && rd.includes("The whole series"), "reader: the trims on the page, a new trim, or the whole series");
  check(bc, `#/brochure/${E}?p=3`, "brochure reader, empty page", "No text on this page");
  check(bc, `#/brochure/${E}?p=99`, "brochure reader, past the end", "3");
  check(bc, "#/brochure/nope", "brochure reader", "Brochure not found");
  ok(check(bc, `#/manual/${E}?p=2`, "viewer of a brochure").includes(`#/brochure/${E}?p=2`), "the viewer offers Read for trims on a brochure");
  ok(check(bc, "#/manuals", "manuals with a brochure").includes('<span class="chip">Brochure</span>'), "the manuals list marks brochures");
  ok(check(bc, "#/", "home with trims").includes("1 trim"), "the Browse tile on Home counts trims");
  check(bc, "#/addmanual?brochure=1", "add a brochure", "It's a sales brochure");
  // step 7: the factory check on a car, the Codes page, and a car change going through the outbox
  const fgCar = (snap.cars || []).find(x => x.model === "FG");
  if (fgCar) {
    const cp0 = check(bc, "#/car/" + fgCar.id, "car with a factory check", "Factory check");
    ok(cp0.includes(`<option value="${T1}"`) && cp0.includes("Not chosen") && cp0.includes('id="fc-paint_code"') && cp0.includes("Choose the car&#39;s trim"),
       "car page: choose its trim (from your brochures), type the plate codes; until then it says so");
    const CSNAP = JSON.parse(JSON.stringify(TSNAP));
    CSNAP.facts.push(fact("70000000-0000-4000-8000-000000000004", "paintcode", "Kinetic", { trim_id: null, series: "", code: "KZ", page: 2 }),
                     fact("70000000-0000-4000-8000-000000000005", "bodycode", "XR <Sedan>", { trim_id: null, series: "", code: "SW", page: 2 }));
    Object.assign(CSNAP.cars.find(x => x.id === fgCar.id), { trim_id: T1, paint_code: "KZ", body_code: "SW", model_code: "99999", build_date: "2012-05" });
    bc.FO.useSnapshot(CSNAP);
    bc.FO_FACTORY_APP.FC.carId = null;
    const cp = check(bc, "#/car/" + fgCar.id, "car with codes", "Should be");
    ok(cp.includes(`<option value="${T1}" selected`) && cp.includes("270 kW @ 5250 rpm") && cp.includes(`#/trim/${T1}`) && cp.includes('value="05/2012"'),
       "car page: its trim with what it should be (power, a link to the rest); the build month in Australian order");
    ok(cp.includes("Offered for the FG MkII") && cp.includes("XR &lt;Sedan&gt;") && cp.includes("A sedan, like the trim") && cp.includes("Not in your code tables")
       && cp.includes(`#/manual/${E}?p=2`), "car page: paint offered, body fits (escaped), an unknown model code, each with its page");
    ok(/<span class="chip good">4 factory<\/span>/.test(cp) && cp.includes('<span class="chip">1 unknown</span>'), "car page: the summary counts");
    const cd = check(bc, "#/codes?m=FG", "codes page", "Paint codes");
    ok(cd.includes("<code>KZ</code>") && cd.includes("Body codes") && cd.includes(`#/manual/${E}?p=2`), "Codes page: each code, what it means and its page");
    check(bc, "#/codes?m=BA", "codes page, none", "No BA codes yet");
    const IDSHA = "f".repeat(64);
    bc.FO_MAN_APP.LIB.manuals.push({ sha: IDSHA, title: "100-01 Identification Codes", folder: "BF", path: "BF/x/100-01 Identification Codes.pdf", brochure: false,
                                     also: [], pages: 3, text_pages: 2, size: 1000, error: "" });
    bc.FO_MAN_APP.LIB.bySha.set(IDSHA, bc.FO_MAN_APP.LIB.manuals[bc.FO_MAN_APP.LIB.manuals.length - 1]);
    bc.FO_MAN_APP.LIB.text[IDSHA] = ["Contents", IDPAGE, ""];
    ok(check(bc, "#/codes?m=BF", "codes page, a manual to read").includes(`#/brochure/${IDSHA}?p=2&amp;m=BF`)
       || check(bc, "#/codes?m=BF", "codes page, a manual to read").includes(`#/brochure/${IDSHA}?p=2&m=BF`), "Codes page: opens the identification codes at the first page with codes");
    ok(check(bc, `#/manual/${IDSHA}`, "viewer of a workshop manual").includes("Read for codes"), "the viewer offers Read for codes on any manual");
    const rc = check(bc, `#/brochure/${IDSHA}?p=2&m=BF`, "reader on a code page", "Found on this page");
    ok(/<option value="series" selected>/.test(rc) && rc.includes('value=""') && rc.includes("blank: every BF") && rc.includes("brow hascode"),
       "reader on a code page: saves for the whole model (series blank), codes shown");
    ok(check(bc, "#/browse?m=FG", "browse with codes").includes("1 paint · 1 body · for the factory check"), "Browse: the model's code tables, counted");
    ok(!check(bc, "#/trim/" + T1, "trim page with codes").includes("<code>SW</code>"), "the trim page doesn't list the code tables");
    vm.runInContext(`OUTBOX = [{id: "99999999-9999-4999-8999-999999999999", kind: "car", data: Object.assign({}, ${JSON.stringify(fgCar)}, {paint_code: "A1", trim_id: null}),
      created: "x", sent: null, result: null, detail: ""}]; GARAGE.cache = null; FC.carId = null;`, bc);
    const g = vm.runInContext(`garage().cars.get(${JSON.stringify(fgCar.id)})`, bc);
    ok(g.paint_code === "A1" && g.trim_id === null && g.pending && vm.runInContext("garage().cars.size", bc) === (snap.cars || []).length,
       "a change to a car shows on it straight away (not as a second car)");
    vm.runInContext("OUTBOX = []; GARAGE.cache = null;", bc);
    bc.FO.useSnapshot(TSNAP);
  }
  // a new trim from the reader: the trim goes before its facts, each citing the page
  bc.FO_BROWSE_APP.BRO.key = null;
  vm.runInContext(`location.hash = "#/brochure/${E}?p=1&m=FG"; screen(); BRO.target = "new"; BRO.nt = { series: "FG MkII", name: "XR6", body: "sedan", years: "" };
    BRO.rows.forEach((x, i) => { x.on = i < 2; }); OUTBOX = [];`, bc);
  vm.runInContext("sync = () => {}; render = () => {};", bc);
  vm.runInContext(`broSave(LIB.bySha.get("${E}"))`, bc);
  PENDING.push(new Promise(done => setTimeout(() => {
    const ob = vm.runInContext("OUTBOX.map(o => o.kind + ':' + (o.data.trim_id || o.data.name || '') + ':' + o.data.doc_sha.slice(0, 1) + o.data.page + ':' + (o.kind === 'trim' ? o.id === o.data.id : o.id === o.data.id))", bc);
    const tid = vm.runInContext("OUTBOX[0] && OUTBOX[0].data.id", bc);
    ok(ob.length === 3 && ob[0] === "trim:XR6:e1:true" && ob[1] === `fact:${tid}:e1:true` && ob[2] === `fact:${tid}:e1:true`,
       "saving to a new trim: the trim, then the ticked facts on it, each citing the page (item id = row id) " + ob);
    const T = bc.FO_BROWSE_APP.trimData();
    ok(T.trims.get(tid) && T.trims.get(tid).pending && T.facts.size === 5, "they show straight away, marked as not on the laptop yet "
       + JSON.stringify([!!T.trims.get(tid), T.trims.get(tid) && T.trims.get(tid).pending, T.facts.size]));
    ok(vm.runInContext("FO.screen('#/settings').html", bc).includes("1 trim, 2 facts"), "Settings counts them as waiting");
    // deleting what never left this device just drops it; deleting the laptop's sends a del
    bc.FO_BROWSE_APP.dropRecord("trim", tid).then(() => {
      ok(vm.runInContext("OUTBOX.length", bc) === 0, "deleting an unsent trim drops it and its facts from the outbox");
      return bc.FO_BROWSE_APP.dropRecord("fact", "70000000-0000-4000-8000-000000000002");
    }).then(() => {
      const o = vm.runInContext("OUTBOX.map(o => o.kind + ':' + o.data.op + ':' + o.data.id)", bc);
      ok(o.length === 1 && o[0] === "fact:del:70000000-0000-4000-8000-000000000002" && bc.FO_BROWSE_APP.trimData().facts.size === 2,
         "deleting a fact the laptop has: a del goes, and it's gone here at once " + o);
      vm.runInContext(`OUTBOX = [{id: "88888888-8888-4888-8888-888888888888", kind: "trim", data: {op: "del", id: "${T1}"}, created: "x", sent: null, result: null, detail: ""}]`, bc);
      ok(bc.FO_BROWSE_APP.trimData().trims.size === 0 && bc.FO_BROWSE_APP.trimData().facts.size === 1, "a trim deleted here takes its facts with it (the series' colour stays)");
    }).catch(e => ok(false, "trim outbox: threw " + e.message)).then(done);
  }, 0)));
}

// new from FORScan's folder: the first copy only marks what's there as seen; later, a new one opens by itself
{
  const fc = makeCtx({ "falconoath.token": "t" });
  fc.FO.useSnapshot(snap);
  const today = new Date(), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const scan0 = Object.assign({}, (snap.scans || [])[0]);
  const fsScan = (id, name, on) => Object.assign({}, scan0, { id, car_id: null, file_name: name, origin: "forscan-folder", scanned_on: on, imported_at: iso + " 10:00:0" + id.slice(-1) });
  const S1 = Object.assign({}, snap, { scans: (snap.scans || []).concat([fsScan("aaaaaaaa-0000-4000-8000-000000000001", "old.txt", iso)]) });
  ok(fc.FO.forscanNew(S1).length === 0 && JSON.parse(fc.localStorage.getItem("falconoath.forscanSeen")).length === 1,
     "FORScan's folder: the first copy marks everything already there as seen (nothing pops up)");
  const S2 = Object.assign({}, S1, { scans: S1.scans.concat([fsScan("aaaaaaaa-0000-4000-8000-000000000002", "DTC new.txt", iso),
                                                             fsScan("aaaaaaaa-0000-4000-8000-000000000003", "found late.txt", "2020-01-01")]) });
  const fresh = fc.FO.forscanNew(S2);
  ok(fresh.length === 1 && fresh[0].name === "DTC new.txt" && fresh[0].kind === "scan", "a new one FORScan saved today is new; an old file found late isn't");
  ok(fc.FO.forscanNew(S2).length === 0, "and it's only new once");
  fc.location.hash = "#/cars";
  ok(fc.FO.pullUp(fresh) === true && fc.location.hash === "#/scan/aaaaaaaa-0000-4000-8000-000000000002", "it opens by itself");
  fc.location.hash = "#/upload";
  ok(fc.FO.pullUp(fresh) === false && fc.location.hash === "#/upload", "but not over a form being filled in (it just says so)");
  ok(fc.FO.pullUp([]) === false, "nothing new: nothing happens");
}

// FalconOath's own window on the laptop: laptop words, and Settings → This laptop
{
  const lc = makeCtx({ "falconoath.token": "t", "falconoath.laptopWin": "1" });
  lc.location.hostname = "localhost"; lc.location.host = "localhost:8767"; lc.location.protocol = "http:";
  lc.FO.useSnapshot(snap);
  lc.FO.SYNC.state = "unreachable";
  const s = check(lc, "#/settings", "laptop window, stopped", "FalconOath has stopped");
  ok(!s.includes("Open Tailscale") && s.includes("desktop icon") && s.includes('id="lapcard"') && s.includes("This laptop"),
     "on the laptop: 'FalconOath has stopped, open it from its icon' (not Tailscale), and the This laptop card");
  vm.runInContext(`LAP.st = { ok: true, started: "2026-10-26 09:00:00", phone: "https://lap.tn.ts.net:8443", phone_state: "ready", forscan: "C:\\\\FORScan",
    open_new: true, devices: [{ id: "a1", name: "This laptop", laptop: true, paired: "2026-10-26 09:00:00" }, { id: "b2", name: "Firefox on <Android>", paired: "2026-10-20 10:00:00", last_seen: "2026-10-26 08:00:00" }] };`, lc);
  const card = vm.runInContext("laptopCardHtml()", lc);
  ok(card.includes("Show a pairing code") && card.includes("https://lap.tn.ts.net:8443") && card.includes('data-unpair="b2"') && !card.includes('data-unpair="a1"')
     && card.includes("Firefox on &lt;Android&gt;") && card.includes('data-lap="open:manuals"') && card.includes('data-lap="stop"') && card.includes("26/10/2026 09:00"),
     "This laptop: pair a phone, the phone's address, devices (not itself, escaped), folders, Stop");
  vm.runInContext(`LAP.code = "123456";`, lc);
  ok(vm.runInContext("laptopCardHtml()", lc).includes('<div class="paircode">123 456</div>'), "the pairing code, big");
  lc.FO.SYNC.state = "unpaired"; lc.localStorage.removeItem("falconoath.token");
  ok(check(lc, "#/settings", "laptop window, unpaired", "Pair this device").includes("Its window pairs itself"), "unpaired on the laptop: open it from its icon, it pairs itself");
  const ph = makeCtx({ "falconoath.token": "t" }); ph.FO.useSnapshot(snap);
  ph.FO.SYNC.state = "unreachable";
  const ps = check(ph, "#/settings", "phone, unreachable", "Open Tailscale");
  ok(!ps.includes('id="lapcard"') && !ps.includes("FalconOath has stopped"), "a phone still says Tailscale, and has no laptop card");
}

// settling: applied items leave the outbox, refused ones stay with their reason
(async () => {
  await Promise.all(PENDING);
  const fake = { applied: [["11111111-1111-4111-8111-111111111111", "applied", "", "11111111-1111-4111-8111-111111111111"],
                           ["22222222-2222-4222-8222-222222222222", "duplicate", "already", "x"]] };
  const notes = await ctx.outboxSettle(fake);
  const left = vm.runInContext("OUTBOX.map(o => o.id[0] + ':' + (o.result || ''))", ctx);
  ok(left.join() === "3:rejected", "settle: applied and duplicate leave, the refused one stays: " + left);
  ok(notes.some(x => /already on the laptop/.test(x)), "settle: a duplicate is mentioned");
  console.log(JSON.stringify({ n, fails: fails.slice(0, 30), nfails: fails.length }));
})();
