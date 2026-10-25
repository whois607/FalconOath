/* FalconOath - reading a sales brochure's page (step 6), pure functions.

   suggest(text, model) looks through one page's text (as the laptop read it
   from the PDF) and suggests what might be facts: trim names, series, body
   styles, engines, kW and Nm, gearboxes, fuel use, wheels and tyres,
   dimensions and weights, towing, paint colours, and bullet points
   (standard gear, or options). Nothing here is a fact: the app shows the
   suggestions beside the page, and only what you tick (or type) is saved,
   with the page it came from. The trim names below are only words to look
   for on a page.

   Used by the app and by tests/js_check.js. */
(function (root) {
  "use strict";
  const KINDS = [["power", "Power"], ["torque", "Torque"], ["engine", "Engine"], ["gearbox", "Gearbox"], ["fuel", "Fuel"],
                 ["standard", "Standard"], ["option", "Option"], ["colour", "Colour"], ["wheels", "Wheels"], ["tyres", "Tyres"],
                 ["dimension", "Size"], ["weight", "Weight"], ["towing", "Towing"], ["other", "Other"],
                 ["paintcode", "Paint code"], ["trimcode", "Trim code"], ["bodycode", "Body code"], ["modelcode", "Model code"]];
  const KIND_NAME = Object.fromEntries(KINDS);
  const CODE_KINDS = ["paintcode", "trimcode", "bodycode", "modelcode"];      // step 7: code tables (code = the code, value = its meaning)
  // how a trim's page groups them
  const GROUPS = [["drive", "Engine and drive", ["engine", "power", "torque", "gearbox", "fuel"]],
                  ["standard", "Standard", ["standard"]], ["option", "Options", ["option"]], ["colour", "Colours", ["colour"]],
                  ["wheels", "Wheels and tyres", ["wheels", "tyres"]], ["size", "Size, weight and towing", ["dimension", "weight", "towing"]],
                  ["other", "Other", ["other"]], ["codes", "Codes", CODE_KINDS]];
  const BODIES = ["sedan", "ute", "wagon", "cab chassis"];

  // words to look for (not facts): Falcon and FPV trim names of each generation
  const FPV = ["GT", "GT-P", "GT-E", "GS", "F6", "F6 Typhoon", "F6 Tornado", "F6E", "Pursuit", "Super Pursuit", "Force 6", "Force 8", "GT Cobra", "Cobra"];
  const TRIM_WORDS = {
    BA: ["XT", "XL", "XLS", "XR6", "XR6 Turbo", "XR8", "Futura", "Fairmont", "Fairmont Ghia", "RTV", "Super Cab"].concat(FPV),
    BF: ["XT", "XL", "XLS", "XR6", "XR6 Turbo", "XR8", "Futura", "Fairmont", "Fairmont Ghia", "G6", "G6E", "G6E Turbo", "RTV", "Super Cab"].concat(FPV),
    FG: ["XT", "XR6", "XR6 Turbo", "XR8", "G6", "G6E", "G6E Turbo", "R6", "Super Cab"].concat(FPV),
    FGX: ["XR6", "XR6 Turbo", "XR8", "XR6 Sprint", "XR8 Sprint", "G6E", "G6E Turbo", "Super Cab"],
  };
  const ALL_WORDS = Array.from(new Set([].concat(...Object.values(TRIM_WORDS))));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const NOT_WORD = "(?<![A-Za-z0-9])", END_WORD = "(?![A-Za-z0-9])";
  // a short code (XT, GT, R6) only in capitals; longer names in any case
  function wordRe(w) { return new RegExp(NOT_WORD + esc(w).replace(/\\? /g, "\\s+") + END_WORD, w.length <= 3 ? "g" : "gi"); }
  const WORD_RES = new Map(ALL_WORDS.map(w => [w, wordRe(w)]));

  /* trim names on the page, longest first so "XR6 Turbo" isn't also "XR6":
     [{name, n}] in the order they first appear */
  function trimNames(text, model) {
    let t = String(text || "");
    const words = (TRIM_WORDS[model] || ALL_WORDS).slice().sort((a, b) => b.length - a.length), out = [];
    for (const w of words) {
      const re = WORD_RES.get(w) || wordRe(w);
      re.lastIndex = 0;
      let m, n = 0, at = -1;
      while ((m = re.exec(t))) { n++; if (at < 0) at = m.index; }
      if (n) { out.push({ name: w, n, at }); t = t.replace(re, s => " ".repeat(s.length)); }
    }
    return out.sort((a, b) => a.at - b.at).map(({ name, n }) => ({ name, n }));
  }
  /* series, e.g. "FG MkII", "BF Mk III", "FG X" -> as Ford writes them */
  const ROMAN = { I: "", II: "MkII", III: "MkIII" };
  function seriesNames(text) {
    const out = new Set(), t = String(text || "");
    const re = /\b(BA|BF|FG)\s?(?:Mk|Mark|Series)\s?(II|III|2|3)\b/gi;
    let m;
    while ((m = re.exec(t))) out.add(m[1].toUpperCase() + " " + ROMAN[{ 2: "II", 3: "III" }[m[2]] || m[2].toUpperCase()]);
    if (/\bFG\s?X\b/.test(t)) out.add("FG X");
    return Array.from(out);
  }
  function bodies(text) {
    const t = String(text || "").toLowerCase();
    return BODIES.filter(b => new RegExp("\\b" + b.replace(" ", "[\\s-]") + "s?\\b").test(t));
  }

  const num = s => String(s).replace(/,/g, "");
  const tidy = s => String(s || "").replace(/\s+/g, " ").replace(/^[\s•●■▪◦\-–—*✓:;,.]+|[\s,;:*^®™†\-–—]+$/g, "").trim();
  const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

  /* everything on one line that looks like a fact: [{kind, label, value}] */
  function lineFacts(line, pageColours) {
    const out = [], L = line;
    const add = (kind, value, label) => out.push({ kind, label: label || "", value: tidy(value) });
    let m;
    const kw = /(\d{2,3}(?:\.\d)?)\s?kW(?:\s*(?:@|at)\s*([\d,]{4,5})\s*(?:rpm|r\/min))?/gi;
    while ((m = kw.exec(L))) add("power", `${m[1]} kW${m[2] ? ` @ ${num(m[2])} rpm` : ""}`);
    const nm = /(\d{3})\s?Nm(?:\s*(?:@|at)\s*([\d,]{4,5})(?:\s?[-–]\s?([\d,]{4,5}))?\s*(?:rpm|r\/min))?/gi;
    while ((m = nm.exec(L))) add("torque", `${m[1]} Nm${m[2] ? ` @ ${num(m[2])}${m[3] ? "–" + num(m[3]) : ""} rpm` : ""}`);
    const eng = /\b(\d\.\d)\s?(?:L|litre|-litre)\b(?!\s?\/\s?100)([^\n.;:,()]{0,45})/gi;
    while ((m = eng.exec(L))) add("engine", `${m[1]}L${tidy(m[2]) ? " " + tidy(m[2]) : ""}`);
    if (!out.some(x => x.kind === "engine")) {
      const e2 = /\b(EcoBoost|EcoLPi|Boss\s?\d{3}|Barra\s?\d{3}[A-Z]{0,3}|Coyote|Miami)\b([^\n.;:,()]{0,35})/i.exec(L);
      if (e2) add("engine", e2[1] + (tidy(e2[2]) ? " " + tidy(e2[2]) : ""));
    }
    const gb = /\b(?:(?:ZF|BTR|Tremec|Getrag)\s)?(\d|one|two|three|four|five|six|seven|eight)[-\s]?speed\b[^\n.;:,()]{0,40}?\b(automatic|auto|manual|sequential sports shift|transmission)\b/gi;
    while ((m = gb.exec(L))) {
      const brand = /\b(ZF|BTR|Tremec|Getrag)\b/i.exec(m[0]);
      add("gearbox", `${brand ? brand[1].toUpperCase() === "TREMEC" ? "Tremec " : brand[1].toUpperCase() + " " : ""}${WORDS[m[1].toLowerCase()] || m[1]}-speed ${m[2].toLowerCase() === "auto" ? "automatic" : m[2].toLowerCase()}`);
    }
    const fu = /(\d{1,2}(?:\.\d)?)\s?L\s?\/\s?100\s?km/gi;
    while ((m = fu.exec(L))) add("fuel", `${m[1]} L/100 km`, /urban|city/i.test(L) && !/extra/i.test(L) ? "Urban" : /extra|highway/i.test(L) ? "Extra-urban" : /combined/i.test(L) ? "Combined" : "");
    m = /fuel tank[^\d\n]{0,20}(\d{2,3})\s?(?:L|litres?)\b/i.exec(L);
    if (m) add("fuel", `${m[1]} L`, "Fuel tank");
    m = /\b(1[5-9]|2[0-2])\s?(?:"|”|″|''|-?\s?inch\b|\s?in\b)([^\n;:()]{0,45})/i.exec(L);
    if (m && /wheel|alloy|rim|steel|forged/i.test(L)) add("wheels", `${m[1]}" ${tidy(m[2])}`.trim());
    const ty = /\b(\d{3})\s?\/\s?(\d{2})\s?Z?R\s?(\d{2})\b/gi;
    while ((m = ty.exec(L))) add("tyres", `${m[1]}/${m[2]} R${m[3]}`);
    const dim = /\b(overall length|length|overall width|width|overall height|height|wheelbase|front track|rear track|ground clearance|turning circle)\b[^\d\n]{0,25}([\d,.]{3,6})\s?(mm|m)\b/gi;
    while ((m = dim.exec(L))) add("dimension", `${m[2]} ${m[3]}`, cap1(m[1].toLowerCase()));
    const wt = /\b(kerb weight|kerb mass|tare (?:weight|mass)|tare|gvm|gross vehicle mass|payload)\b[^\d\n]{0,25}([\d,]{3,5})\s?kg\b/gi;
    while ((m = wt.exec(L))) add("weight", `${m[2]} kg`, m[1].length <= 3 ? m[1].toUpperCase() : cap1(m[1].toLowerCase()));
    const tw = /\b(braked towing(?: capacity)?|unbraked towing(?: capacity)?|towing capacity|towing|braked|unbraked)\b[^\d\n]{0,30}([\d,]{3,5})\s?kg\b/gi;
    while ((m = tw.exec(L))) add("towing", `${m[2]} kg`, cap1(m[1].toLowerCase()));
    // a bullet point: standard gear, or an option when it says so
    const bullet = /^\s*[•●■▪◦✓*\-–]\s*(.{4,120})$/.exec(L);
    if (bullet && !out.length) add(/\boption(al)?\b/i.test(L) ? "option" : "standard", bullet[1]);
    else if (!out.length && /\b(optional|option)\b/i.test(L) && tidy(L).length >= 6 && tidy(L).length <= 100 && !/^options?$/i.test(tidy(L)))
      add("option", L.replace(/\(?\boptional\b\)?|\boption\b:?/gi, " "));
    // a colour: a short name on a page about paint
    if (pageColours && !out.length && looksLikeColour(L)) add("colour", L);
    return out.filter(x => x.value);
  }
  const NOT_COLOURS = /^(standard|optional|options?|features?|colou?rs?|paint|code|codes|name|description|operation|contents|general|information|section|exterior|interior|metallic|premium|prestige|available|trim|trims|seats?|cloth|leather|sedan|ute|wagon|falcon|ford|new|the|and|with|note|notes|page)$/i;
  function looksLikeColour(line) {
    const t = tidy(line);
    if (t.length < 3 || t.length > 28 || /\d/.test(t)) return false;
    const ws = t.split(" ");
    if (ws.length > 3 || !ws.every(w => /^[A-Z][a-zA-Z'’]*$/.test(w))) return false;
    if (ws.every(w => NOT_COLOURS.test(w))) return false;
    if (ALL_WORDS.some(w => w.toLowerCase() === t.toLowerCase())) return false;
    return true;
  }

  /* ---- code tables (step 7), as in a workshop manual's 100-01 Identification
     Codes: under a heading, lines that end in a code; and "Name (Q1) 6XXX"
     anywhere. Returns [{kind, code, value, label}] for one line. */
  const CODE_HEADS = [[/body\s*(style|type)\s*code/i, "bodycode"], [/model\s*code/i, "modelcode"],
                      [/paint\s*colou?r/i, "paintcode"], [/trim\s*colou?r/i, "trimcode"]];
  const NOT_NAMES = /^(compliance|vehicle|label|rules|design|code|colour|color|name|body|type|style|model|the)$/i;
  const spaced = s => tidy(s).replace(/([a-z])([A-Z])/g, "$1 $2");
  const lastName = s => { const m = /([A-Z][a-z’']+(?: [A-Z][a-z’']+)*)$/.exec(tidy(s)); return m ? m[1] : tidy(s); };
  function codeHead(line) { const h = CODE_HEADS.find(([r]) => r.test(line)); return h ? h[1] : null; }
  const BODY_FIRST = /(Sedan|Wagon|Ute|Cab Chassis)\b.*$/i;
  function codeLine(line, sec) {
    const out = [], L = String(line || "").trim()
      .replace(/\s+introduction(\s+[A-Z][a-z]{2,8})?\s*(\d{2}’)?\s*(?=\()/g, " ");   // "Name introduction May 05’ (NN)" -> "Name (NN)"
    let m;
    const named = /([A-Z][A-Za-z’']+(?: [A-Z][A-Za-z’']+){0,3}) \(([A-Z0-9]{2})\)(?:\s+(6[A-Z0-9]{3})\b)?/g;
    while ((m = named.exec(L))) {
      const glued = /^.*[a-z]{4}(?=[A-Z])/.exec(m[1]);       // "Heavy FinesGloomy" (two columns run together) -> "Gloomy"; "ReDoNe" stays
      const value = glued ? m[1].slice(glued[0].length) : m[1];
      if (!value.split(" ").some(w => NOT_NAMES.test(w)))
        out.push({ kind: sec === "trimcode" ? "trimcode" : "paintcode", code: m[2], value, label: m[3] || "" });
    }
    if (out.length || !sec || codeHead(L)) return out;
    if (sec === "modelcode") {
      m = /^(.{2,140}?)\s*(\d{5})$/.exec(L);
      if (m) { const b = BODY_FIRST.exec(m[1]);                  // text run in from the next column: keep from "Sedan"/"Ute" on
        out.push({ kind: sec, code: m[2], value: spaced(b ? b[0] : m[1]), label: "" }); }
    } else {
      m = /^(.{2,60}?)\s+([A-Z0-9]{2})$/.exec(L);
      if (m && !/^colou?r$/i.test(tidy(m[1]))) {
        const value = sec === "bodycode" ? spaced(m[1]) : lastName(m[1]);
        if (value && !value.split(" ").every(w => NOT_NAMES.test(w))) out.push({ kind: sec, code: m[2], value, label: "" });
      }
    }
    return out;
  }

  /* one page: {trims, series, bodies, facts: [{kind, label, value, code?}]},
     facts in page order, each once */
  function suggest(text, model) {
    const t = String(text || "");
    const colours = /\b(colou?rs?|paint)\b/i.test(t);
    const seen = new Set(), facts = [];
    let sec = null;
    for (const line of t.split(/\n/)) {
      const codes = codeLine(line, sec), head = codeHead(line);
      sec = head || sec;
      for (const f of codes.length ? codes : head ? [] : lineFacts(line, colours)) {
        const k = factKey(f);
        if (seen.has(k)) continue;
        seen.add(k); facts.push(f);
      }
    }
    return { trims: trimNames(t, model), series: seriesNames(t), bodies: bodies(t), facts: facts.slice(0, 160) };
  }

  /* the same fact twice (to hide a suggestion already saved) */
  const factKey = f => [f.kind, String(f.label || "").toLowerCase(), String(f.value || "").toLowerCase().replace(/\s+/g, " "),
                        String(f.code || "").toUpperCase()].join("|");

  /* a trim's facts grouped as its page shows them: [[id, title, facts]] (empty groups left out) */
  function grouped(facts) {
    return GROUPS.map(([id, title, kinds]) => [id, title, facts.filter(f => kinds.includes(f.kind))
      .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind))]).filter(g => g[2].length);
  }

  const api = { KINDS, KIND_NAME, CODE_KINDS, GROUPS, BODIES, TRIM_WORDS, trimNames, seriesNames, bodies, lineFacts, looksLikeColour,
                codeLine, suggest, factKey, grouped };
  root.FO_BRO = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
