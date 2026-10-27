/* FalconOath - the built-in reference, pure functions.

   The reference (snap.ref) is read from your own manuals and brochures on
   the laptop (falconoath/reference.py): code tables, FG X trims, service
   specs. This file has what the app works out from it:

   vin(v)          a Falcon VIN in its parts, as the workshop manual's 100-01
                   draws it (6FP AAA J G SW 2 B 12345); the year and month
                   letters are general Ford knowledge, marked as such
   family(text)    an engine's kind from its description: v8, turbo, lpg,
                   eco (EcoBoost) or i6
   carContext(..)  what's known about a car's engine, gearbox and body,
                   from its plate codes, else its trim
   relevant(s, x)  does a spec (its "applies" words) fit this car? true,
                   false, or null when it can't tell

   Used by the app and by tests/js_check.js. */
(function (root) {
  "use strict";
  const low = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Ford's build month letters: two years in a row, then over again (general Ford knowledge, not from your manuals)
  const MONTH_1 = "JUMPBRAGCKDE", MONTH_2 = "LYSTJUMPBRAG";
  const PLANTS = { G: "Broadmeadows" };

  /* "6FPAAAJGSX8Y00001" -> its parts (null if it isn't a 6FP Falcon VIN) */
  function vin(v) {
    const s = String(v || "").toUpperCase().replace(/[\s-]/g, "");
    if (!/^6FP[A-Z0-9]{14}$/.test(s)) return null;
    const yc = s[10], mc = s[11];
    const year = /\d/.test(yc) ? 2000 + +yc : /[A-H]/.test(yc) ? 2010 + "ABCDEFGH".indexOf(yc) : null;
    const months = [MONTH_1.indexOf(mc), MONTH_2.indexOf(mc)].filter(i => i >= 0).map(i => MONTHS[i]);
    return { vin: s, prefix: s.slice(0, 3), source: s[6], plant: s[7], plantName: PLANTS[s[7]] || "", body: s.slice(8, 10),
             yearChar: yc, year, monthChar: mc, months: Array.from(new Set(months)), serial: s.slice(12) };
  }

  /* an engine's kind from its description */
  function family(text) {
    const t = low(text);
    if (!t) return null;
    if (/\bv8\b|5\.0l|5\.4l|boss/.test(t)) return "v8";
    if (/turbo/.test(t) && !/ecoboost/.test(t)) return "turbo";
    if (/lpg|lpi|e-gas|egas/.test(t)) return "lpg";
    if (/ecoboost|\bi4\b|2\.0l/.test(t)) return "eco";
    if (/\bi6\b|4\.0l|six/.test(t)) return "i6";
    return null;
  }
  /* a gearbox's kind: manual, auto4 (BTR 4-speed), auto (other automatics) */
  function gearbox(text) {
    const t = low(text);
    if (!t) return null;
    if (/manual/.test(t) && !/auto/.test(t)) return "manual";
    if (/4[- ]speed/.test(t) && /auto/.test(t)) return "auto4";
    if (/auto/.test(t)) return "auto";
    return null;
  }

  /* what's known about a car: codeMeaning(kind, code) gives a plate code's
     meaning ("" if unknown); the trim's engine and gearbox facts are the
     fallback (the trim's standard one: the first without "Optional") */
  function carContext(car, trim, trimFacts, codeMeaning) {
    car = car || {};
    const std = k => (trimFacts || []).filter(f => f.kind === k && !/option/i.test(f.label || ""));
    const em = car.engine_code ? codeMeaning("enginecode", car.engine_code) : "";
    const tm = car.trans_code ? codeMeaning("transcode", car.trans_code) : "";
    const bm = car.body_code ? codeMeaning("bodycode", car.body_code) : "";
    const ef = std("engine")[0], gf = std("gearbox")[0];
    const body = /\bute\b/i.test(bm) ? "ute" : /sedan|wagon|fairlane|ltd/i.test(bm) ? (/wagon/i.test(bm) ? "wagon" : "sedan")
      : trim && trim.body ? trim.body : null;
    return { engine: family(em) || (ef ? family(ef.value) : null), engineFrom: em ? "plate" : ef ? "trim" : null,
             gearbox: gearbox(tm) || (gf && !/\(standard\).*\(option\)/i.test(gf.value) ? gearbox(gf.value) : null),
             body, trim: trim ? trim.name : null, model: car.model || (trim && trim.model) || null };
  }

  /* does this spec fit the car? true / false / null (can't tell, or it's for every car) */
  function relevant(spec, x) {
    const all = low(spec.applies);
    if (!all || !x) return null;
    // trim names (FG X tyre pressures: "XR6 Turbo, G6E Turbo") are read on their own, not as engine words
    const TRIM_RE = /^(falcon|xr6|xr8|g6e|gs)\b/, parts = all.split(/\s*,\s*/);
    const names = parts.filter(n => TRIM_RE.test(n)), a = parts.filter(n => !TRIM_RE.test(n)).join(", ");
    const tells = [];
    // engine words
    const eng = [];
    if (/\bv8\b|boss/.test(a)) eng.push("v8");
    if (/turbo/.test(a)) eng.push("turbo");
    if (/lpg|lpi/.test(a)) eng.push("lpg");
    if (/\bi6\b/.test(a)) eng.push("i6", "turbo", "lpg");
    if (eng.length && x.engine) tells.push(eng.includes(x.engine));
    // gearbox words
    const gb = [];
    if (/manual/.test(a)) gb.push("manual");
    if (/4-speed auto/.test(a)) gb.push("auto4");
    if (/zf|6-speed auto/.test(a)) gb.push("auto");
    if (gb.length && x.gearbox) tells.push(gb.includes(x.gearbox));
    // body words
    if (/\bute\b/.test(a) && x.body) tells.push(x.body === "ute");
    else if (/sedan|irs/.test(a) && x.body) tells.push(x.body !== "ute");
    if (names.length && x.trim) {
      const t = low(x.trim);
      tells.push(names.some(n => n === t || (n.startsWith(t + " ") && (!/ecolpi|lpi/.test(n) || x.engine === "lpg") && !/turbo/.test(n.slice(t.length)))
        || (n.startsWith(t + " ") && /\d+"/.test(n))));
    }
    if (!tells.length) return null;
    return tells.every(Boolean);
  }

  const api = { vin, family, gearbox, carContext, relevant, MONTHS };
  root.FO_REF = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
