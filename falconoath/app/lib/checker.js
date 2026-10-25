/* FalconOath - the factory checker (step 7), pure functions.

   A car's build plate codes (paint, interior trim, body, model code, build
   month), as read off the car, against two things you confirmed yourself:
   the code tables ticked from your manuals (facts of kind paintcode,
   trimcode, bodycode, modelcode; a brochure colour with a code counts as a
   paint code) and the car's trim from your brochures. Nothing is known here
   that isn't in those facts: a code not in your tables is "unknown", never
   guessed.

   check(input) -> {checks: [{id, title, entered, meaning, verdict, note, src}], counts}
   verdict: good | warn (check it) | bad (doesn't fit) | info | unknown.
   Used by the app and by tests/js_check.js. */
(function (root) {
  "use strict";
  const PLATE = [["paint_code", "paintcode", "Paint"], ["trim_code", "trimcode", "Interior trim"],
                 ["body_code", "bodycode", "Body"], ["model_code", "modelcode", "Model code"]];
  const MODEL_NAME = { BA: "BA", BF: "BF", FG: "FG", FGX: "FG X" };
  const NEAR = { BA: ["BF", "FG", "FGX"], BF: ["BA", "FG", "FGX"], FG: ["FGX", "BF", "BA"], FGX: ["FG", "BF", "BA"] };
  const ABBR = { fmt: "fairmont", fmnt: "fairmont" };       // as the model code tables shorten them
  const BODY_WORDS = ["cab chassis", "sedan", "wagon", "ute"];

  const up = s => String(s || "").toUpperCase().replace(/\s+/g, "");
  const low = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const zeroO = s => up(s).replace(/O/g, "0");                 // plates and scans mix up O and 0
  const a = w => (/^[AEIOaeio]/.test(String(w)) || /^[FHLMNRSX][A-Z0-9]/.test(String(w)) ? "an " : "a ") + w;   // an XR6, an FG; a Fairmont, a sedan, a ute

  /* the facts that explain `code` for this kind: [{fact, close}] (close: matched only with O read as 0) */
  function matches(facts, kind, code) {
    const c = up(code);
    if (!c) return [];
    const out = [];
    for (const f of facts) {
      if (!(f.kind === kind || (kind === "paintcode" && f.kind === "colour" && f.code))) continue;
      if (up(f.code) === c) out.push({ fact: f, close: false });
      else if (zeroO(f.code) === zeroO(c)) out.push({ fact: f, close: true });
    }
    return out;
  }
  /* the car's model first (its series, or the whole model), then the nearest
     model that has it, as a hint: {hits, via} */
  function lookup(facts, kind, code, model, series) {
    const all = matches(facts, kind, code);
    if (!all.length) return { hits: [], via: null };
    const own = all.filter(x => x.fact.model === model && (!x.fact.series || !series || x.fact.series === series));
    if (own.length || !model) return { hits: model ? own : all, via: null };
    for (const m of NEAR[model] || []) {
      const h = all.filter(x => x.fact.model === m);
      if (h.length) return { hits: h, via: m };
    }
    return { hits: [], via: null };
  }
  const bodyWord = s => BODY_WORDS.find(b => low(s).includes(b)) || "";
  const names = hits => Array.from(new Set(hits.map(x => x.fact.value)));
  /* the colours the brochure gives for this trim or its series (empty if none were ticked) */
  function offered(facts, trim) {
    if (!trim) return [];
    return facts.filter(f => (f.kind === "colour" || f.kind === "paintcode") && f.model === trim.model
      && (f.trim_id === trim.id || (!f.trim_id && f.series && f.series === trim.series)));
  }
  /* does a model code's meaning ("Sedan XR", "Sedan FMT Ghia") fit the trim's name? */
  function nameFits(meaning, trim) {
    const words = low(meaning).split(" ").filter(w => !BODY_WORDS.some(b => b.split(" ").includes(w)) && !["tray", "ssb", "lwb"].includes(w));
    if (!words.length) return null;
    const t = low(trim.name).replace(/\s+/g, "");
    const first = ABBR[words[0]] || words[0];
    return t.startsWith(first.replace(/\s+/g, "")) && words.slice(1).every(w => low(trim.name).includes(ABBR[w] || w));
  }
  function years(s) {
    const m = /(\d{4})\s*[-–to]+\s*(\d{4})/.exec(String(s || "")) || /(\d{4})/.exec(String(s || ""));
    return m ? [+m[1], +(m[2] || m[1])] : null;
  }

  function check(input) {
    const car = input.car || {}, trim = input.trim || null, facts = input.facts || [], model = car.model || (trim && trim.model) || null;
    const series = trim ? trim.series : "", out = [];
    const mn = m => MODEL_NAME[m] || m;
    const add = (id, title, entered, meaning, verdict, note, src) => out.push({ id, title, entered: entered || "", meaning: meaning || "", verdict, note: note || "", src: src || null });

    if (!trim) add("trim", "Trim", "", "Not chosen", "unknown", "Choose the car's trim (from your brochures) to check the codes against it.");
    else if (car.model && trim.model !== car.model) add("trim", "Trim", trim.name, `${mn(trim.model)} ${trim.name}`, "bad", `That trim is ${a(mn(trim.model))}'s; this car is ${a(mn(car.model))}.`);
    else add("trim", "Trim", trim.name, [trim.series, trim.name, trim.body].filter(Boolean).join(" "), "good", "What its plate should agree with.", trim);

    for (const [field, kind, title] of PLATE) {
      const code = up(car[field]);
      if (!code) continue;
      const L = lookup(facts, kind, code, model, series), hits = L.hits, src = hits.length ? hits[0].fact : null;
      const close = hits.length && hits.every(x => x.close) ? ` (your table has ${up(hits[0].fact.code)}: O and 0 look alike)` : "";
      const meaning = names(hits).join(" / ");
      if (!hits.length) { add(field, title, code, "Not in your code tables", "unknown", `Tick the ${title.toLowerCase()} codes on your manual's identification codes page${model ? ` (${mn(model)})` : ""}.`); continue; }
      if (L.via) { add(field, title, code, meaning, "info", `Only in the ${mn(L.via)} tables, not the ${mn(model)}'s: a hint, not a check.${close}`, src); continue; }
      if (kind === "paintcode") {
        const list = offered(facts, trim);
        if (!trim || !list.length) add(field, title, code, meaning, "info", (trim ? `No colour list ticked for the ${series || mn(trim.model)} yet, so whether it was offered can't be checked.` : "") + close, src);
        else {
          const ok = list.some(f => up(f.code) === code || zeroO(f.code) === zeroO(code) || names(hits).some(n => low(n) === low(f.value)));
          add(field, title, code, meaning, ok ? "good" : "warn", ok ? `Offered for the ${trim.series || trim.name}.${close}`
            : `Not in the ${trim.series || trim.name} colours you ticked (${list.map(f => f.value).join(", ")}): resprayed, or a colour the brochure doesn't show?${close}`, src);
        }
      } else if (kind === "bodycode" || kind === "modelcode") {
        const bodies = Array.from(new Set(names(hits).map(bodyWord).filter(Boolean)));
        if (!trim) { add(field, title, code, meaning, "info", close.trim(), src); continue; }
        const tb = trim.body || "";
        if (tb && bodies.length && !bodies.includes(tb)) { add(field, title, code, meaning, "bad", `The plate says ${bodies.join(" or ")}; the trim is ${a(tb)}.${close}`, src); continue; }
        if (kind === "modelcode") {
          const fits = names(hits).map(n => nameFits(n, trim)).filter(x => x !== null);
          if (fits.length && !fits.some(Boolean)) { add(field, title, code, meaning, "warn", `The plate's model code is ${a(meaning)}; this car is set as ${a(trim.name)}. A different trim, or rebadged?${close}`, src); continue; }
          add(field, title, code, meaning, fits.some(Boolean) || (tb && bodies.includes(tb)) ? "good" : "info", (fits.some(Boolean) ? `Matches the ${trim.name}.` : tb ? "" : "The trim's body isn't set, so only the code is explained.") + close, src);
        } else add(field, title, code, meaning, tb && bodies.includes(tb) ? "good" : "info", (tb && bodies.includes(tb) ? `${a(tb).replace(/^a/, "A")}, like the trim.` : tb ? "" : "The trim's body isn't set, so only the code is explained.") + close, src);
      } else add(field, title, code, meaning, "info", close.trim(), src);
    }

    const bd = /^(\d{4})-(\d{2})$/.exec(car.build_date || "");
    if (bd) {
      const y = +bd[1], md = (input.models || []).find(m => m[0] === model), ty = trim ? years(trim.years) : null;
      const shown = `${bd[2]}/${bd[1]}`;
      if (md && md[2] && md[3] && (y < md[2] - 1 || y > md[3])) add("build_date", "Build date", shown, "", "bad", `The ${mn(model)} was built ${md[2]}–${md[3]}.`);
      else if (ty && (y < ty[0] || y > ty[1])) add("build_date", "Build date", shown, "", "warn", `Your brochure gives the ${trim.name} as ${trim.years}.`, trim);
      else add("build_date", "Build date", shown, "", ty || md ? "good" : "info", ty ? `Within the ${trim.name}'s ${trim.years}.` : md ? `Within the ${mn(model)}'s run.` : "");
    }
    const counts = { good: 0, warn: 0, bad: 0, info: 0, unknown: 0 };
    out.forEach(c => { counts[c.verdict]++; });
    return { checks: out, counts };
  }

  /* "06/2010", "6/10", "2010-06" -> "2010-06"; "" if blank; null if not a month */
  function month(s) {
    const t = String(s || "").trim();
    if (!t) return "";
    let m = /^(\d{4})-(\d{1,2})$/.exec(t);
    if (m) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${String(+m[2]).padStart(2, "0")}` : null;
    m = /^(\d{1,2})\s*[\/.\-\s]?\s*(\d{4})$/.exec(t) || /^(\d{1,2})\s*[\/.\-]\s*(\d{2})$/.exec(t);
    if (!m || +m[1] < 1 || +m[1] > 12) return null;
    const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return y >= 1995 && y <= 2020 ? `${y}-${String(+m[1]).padStart(2, "0")}` : null;
  }

  const api = { PLATE, lookup, offered, nameFits, check, month };
  root.FO_CHECK = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
