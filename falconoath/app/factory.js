/* FalconOath - the factory check on each car (step 7). Loaded after
   browse.js; uses its trims and facts (trimData) and lib/checker.js.

   On a car's page: what it should be (its trim, from your brochures), the
   codes off its build plate, and a tile per check (lib/checker.js) that
   updates as you type. Saving sends the car with its trim and codes as a
   "car" outbox item naming the car (data.id); the laptop checks and keeps
   them. Code meanings come from the code tables: built in from your
   manuals (snap.ref) plus what you ticked (Browse → Codes); research notes
   are only "Noted". Below it, the car's service sheet: the built-in specs
   for its model, the ones that don't fit its engine or gearbox dimmed. */
"use strict";
const FC = { carId: null, v: null };
const FC_FIELDS = [["paint_code", "Paint", "e.g. A1"], ["trim_code", "Interior trim", "e.g. B1"], ["body_code", "Body", "e.g. SW"],
                   ["model_code", "Model code", "5 digits"], ["engine_code", "Engine", "e.g. H"], ["trans_code", "Gearbox", "e.g. A"]];
const FC_VERDICT = { good: ["good", "Factory"], warn: ["warn", "Check"], bad: ["bad", "Doesn't fit"], info: ["", "Noted"], unknown: ["", "Unknown"] };
const plateCode = s => String(s || "").toUpperCase().replace(/\s+/g, "");
const auMonth = ym => ym ? `${ym.slice(5, 7)}/${ym.slice(0, 4)}` : "";

function fcInit(c) {
  if (FC.carId === c.id && FC.v) return;
  FC.carId = c.id;
  FC.v = { trim_id: c.trim_id || "", build: auMonth(c.build_date), vin: c.vin || "" };
  FC_FIELDS.forEach(([k]) => { FC.v[k] = c[k] || ""; });
}
/* the car as it would be saved, from what's typed */
function fcCar(c) {
  const out = Object.assign({}, c, { trim_id: FC.v.trim_id || null, build_date: FO_CHECK.month(FC.v.build) || "", vin: plateCode(FC.v.vin) || null });
  FC_FIELDS.forEach(([k]) => { out[k] = plateCode(FC.v[k]); });
  return out;
}
function fcChanged(c) {
  const n = fcCar(c);
  return (n.trim_id || null) !== (c.trim_id || null) || n.build_date !== (c.build_date || "") || FO_CHECK.month(FC.v.build) === null || (n.vin || null) !== (c.vin || null)
    || FC_FIELDS.some(([k]) => n[k] !== (c[k] || ""));
}
function fcResultsHtml(c) {
  const T = trimData(), car = fcCar(c), trim = car.trim_id ? T.trims.get(car.trim_id) : null;
  const R = FO_CHECK.check({ car, trim, facts: Array.from(T.facts.values()), trimFacts: trim ? factsOf(T, trim.id) : [], models: DB ? DB.snap.models : [] });
  const k = R.counts;
  const sum = [k.bad ? `<span class="chip bad">${k.bad} doesn't fit</span>` : "", k.warn ? `<span class="chip warn">${k.warn} to check</span>` : "",
               k.good ? `<span class="chip good">${k.good} factory</span>` : "", k.unknown ? `<span class="chip">${k.unknown} unknown</span>` : ""].filter(Boolean).join(" ");
  return `<div class="fcsum">${sum}</div><div class="htiles fct">${R.checks.map(x => `<div class="htile ${FC_VERDICT[x.verdict][0]}"><span class="hv">${FC_VERDICT[x.verdict][1]}</span>
      <b>${esc(x.title)}${x.entered && x.id !== "trim" ? ` <code>${esc(x.entered)}</code>` : ""}</b>${x.meaning ? `<span class="hval">${esc(x.meaning)}</span>` : ""}
      ${x.note ? `<span class="hn">${esc(x.note)}</span>` : ""}${x.src && (x.src.doc_sha || x.src.research) ? `<span>${srcLink(x.src)}</span>` : ""}</div>`).join("")}</div>`;
}
function fcExpectedHtml(trim, T) {
  if (!trim) return "";
  const fs = factsOf(T, trim.id), first = k => fs.filter(f => f.kind === k).map(f => f.value)[0];
  const bits = [["Power", first("power")], ["Engine", first("engine")], ["Gearbox", first("gearbox")], ["Wheels", first("wheels")]].filter(x => x[1]);
  return `<a class="fcexp" href="#/trim/${enc(trim.id)}"><span class="faint">Should be</span> <b>${esc([trim.series, trim.name, bodyName(trim.body)].filter(Boolean).join(" "))}</b>${
    bits.map(([l, v]) => `<span class="fcb"><i>${l}</i> ${esc(v)}</span>`).join("")}<span class="note" style="margin:0">Everything it should have</span>${CHEV}</a>`;
}
function factoryCardHtml(c) {
  fcInit(c);
  const T = trimData(), ts = c.model ? trimsOf(T, c.model) : sortTrims(Array.from(T.trims.values()));
  const bySeries = {};
  ts.forEach(t => { const g = (c.model ? "" : modelName(t.model) + " ") + seriesTitle(t.model, t.series); (bySeries[g] = bySeries[g] || []).push(t); });
  const trim = FC.v.trim_id ? T.trims.get(FC.v.trim_id) : null;
  return `<div class="card fcheck"><div class="spread"><h2>Factory check</h2><a class="note" style="margin:0" href="#/codes?m=${enc(c.model || "FG")}">Code tables</a></div>
    <label class="field"><span>Trim</span><select id="fc-trim" class="text"><option value="">${ts.length ? "Not chosen" : `No ${c.model ? esc(modelName(c.model)) + " " : ""}trims yet: read a brochure in Browse`}</option>${
      Object.keys(bySeries).sort().map(s => `<optgroup label="${esc(s)}">${bySeries[s].map(t => `<option value="${esc(t.id)}"${FC.v.trim_id === t.id ? " selected" : ""}>${esc(trimName(t))}</option>`).join("")}</optgroup>`).join("")}</select></label>
    <div id="fc-exp">${fcExpectedHtml(trim, T)}</div>
    <div class="plate">${FC_FIELDS.map(([k, l, ph]) => `<label class="field"><span>${l}</span><input id="fc-${k}" maxlength="8" autocapitalize="characters" autocomplete="off" value="${esc(FC.v[k])}" placeholder="${ph}"></label>`).join("")}
      <label class="field"><span>Build date</span><input id="fc-build" maxlength="10" autocomplete="off" value="${esc(FC.v.build)}" placeholder="MM/YYYY"></label>
      <label class="field vinf"><span>VIN</span><input id="fc-vin" maxlength="17" autocapitalize="characters" autocomplete="off" value="${esc(FC.v.vin)}" placeholder="6FPAAA..."></label></div>
    <div id="fc-res">${fcResultsHtml(c)}</div>
    <div class="row" style="gap:10px;margin-top:10px"><button class="btn primary" id="fc-save"${fcChanged(c) ? "" : " disabled"}>Save to this car</button><span id="fc-msg" class="note bad" style="margin:0"></span></div>
    <p class="note">The codes as read off the build plate (engine bay or driver's A-pillar). What they mean comes from your manuals' code tables, built in; a <span class="chip warn">Research</span> meaning isn't from them, so it's only noted.</p></div>`;
}
function wireFactory(carId) {
  const c = garage().cars.get(carId);
  if (!c || !$("fc-trim")) return;
  const refresh = () => {
    $("fc-res").innerHTML = fcResultsHtml(c);
    $("fc-save").disabled = !fcChanged(c);
    $("fc-msg").textContent = FO_CHECK.month(FC.v.build) === null ? "Build date as MM/YYYY, e.g. 06/2010" : "";
  };
  $("fc-trim").onchange = e => { FC.v.trim_id = e.target.value; $("fc-exp").innerHTML = fcExpectedHtml(FC.v.trim_id ? trimData().trims.get(FC.v.trim_id) : null, trimData()); refresh(); };
  FC_FIELDS.forEach(([k]) => { $("fc-" + k).oninput = e => { FC.v[k] = e.target.value; refresh(); }; });
  $("fc-build").oninput = e => { FC.v.build = e.target.value; refresh(); };
  $("fc-vin").oninput = e => { FC.v.vin = e.target.value; refresh(); };
  $("fc-save").onclick = async () => {
    const n = fcCar(c), bad = FC_FIELDS.find(([k]) => n[k] && !/^[A-Z0-9]{1,8}$/.test(n[k]));
    if (FO_CHECK.month(FC.v.build) === null) { $("fc-msg").textContent = "Build date as MM/YYYY, e.g. 06/2010"; return; }
    if (bad) { $("fc-msg").textContent = `The ${bad[1].toLowerCase()} code is letters and numbers only.`; return; }
    if (n.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(n.vin)) { $("fc-msg").textContent = "The VIN is 17 letters and numbers (no I, O or Q)."; return; }
    const data = { id: c.id, nickname: c.nickname || "", model: c.model || null, year: c.year == null || c.year === "" ? null : c.year, vin: n.vin || null,
                   kind: c.kind || "mine", notes: c.notes || "", trim_id: n.trim_id, build_date: n.build_date };
    FC_FIELDS.forEach(([k]) => { data[k] = n[k]; });
    await outboxAdd([{ id: uuid(), kind: "car", data }]);
    FC.carId = null;
    toast("Saved to " + carName(c)); render(true); sync(false);
  };
}

/* the car's service sheet: its model's built-in specs, fitted to what's known of it */
function fcContext(c) {
  const T = trimData(), trim = c.trim_id ? T.trims.get(c.trim_id) : null, all = Array.from(T.facts.values());
  const meaning = (kind, code) => { const L = FO_CHECK.lookup(all, kind, code, c.model, trim ? trim.series : ""); return L.via ? "" : Array.from(new Set(L.hits.filter(x => !x.fact.research).map(x => x.fact.value))).join(" / "); };
  return FO_REF.carContext(c, trim, trim ? factsOf(T, trim.id) : [], meaning);
}
function serviceSheetHtml(c) {
  if (!c.model || !specsOf(c.model).length) return "";
  const x = fcContext(c), ENG = { i6: "six", turbo: "turbo six", lpg: "LPG six", v8: "V8", eco: "EcoBoost four" }, GB = { manual: "manual", auto4: "4-speed auto", auto: "automatic" };
  const known = [x.engine ? `${ENG[x.engine]} (from its ${x.engineFrom})` : "", x.gearbox ? GB[x.gearbox] : "", x.body || ""].filter(Boolean);
  return `<div class="card"><details class="more"${LS.get("svc.open") === "1" ? " open" : ""} id="svc"><summary><h2 style="display:inline">Service sheet</h2>
    <span class="faint"> · ${known.length ? esc(known.join(", ")) : "add its engine code or trim to fit it"}</span></summary>
    ${specsHtml(c.model, x)}<p class="note">From your ${esc(modelName(c.model))} manuals; specs for other engines or gearboxes are dimmed. <a href="#/specs?m=${enc(c.model)}">All ${esc(modelName(c.model))} specs</a></p></details></div>`;
}

self.FO_FACTORY_APP = { FC, fcCar, factoryCardHtml, serviceSheetHtml };   // tests
