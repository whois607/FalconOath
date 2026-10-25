/* FalconOath - the factory check on each car (step 7). Loaded after
   browse.js; uses its trims and facts (trimData) and lib/checker.js.

   On a car's page: what it should be (its trim, from your brochures), the
   codes off its build plate, and a tile per check (lib/checker.js) that
   updates as you type. Saving sends the car with its trim and codes as a
   "car" outbox item naming the car (data.id); the laptop checks and keeps
   them. Code meanings come only from the code tables you ticked (Browse →
   Codes). */
"use strict";
const FC = { carId: null, v: null };
const FC_FIELDS = [["paint_code", "Paint", "e.g. A1"], ["trim_code", "Interior trim", "e.g. B1"], ["body_code", "Body", "e.g. SW"],
                   ["model_code", "Model code", "5 digits"]];
const FC_VERDICT = { good: ["good", "Factory"], warn: ["warn", "Check"], bad: ["bad", "Doesn't fit"], info: ["", "Noted"], unknown: ["", "Unknown"] };
const plateCode = s => String(s || "").toUpperCase().replace(/\s+/g, "");
const auMonth = ym => ym ? `${ym.slice(5, 7)}/${ym.slice(0, 4)}` : "";

function fcInit(c) {
  if (FC.carId === c.id && FC.v) return;
  FC.carId = c.id;
  FC.v = { trim_id: c.trim_id || "", build: auMonth(c.build_date) };
  FC_FIELDS.forEach(([k]) => { FC.v[k] = c[k] || ""; });
}
/* the car as it would be saved, from what's typed */
function fcCar(c) {
  const out = Object.assign({}, c, { trim_id: FC.v.trim_id || null, build_date: FO_CHECK.month(FC.v.build) || "" });
  FC_FIELDS.forEach(([k]) => { out[k] = plateCode(FC.v[k]); });
  return out;
}
function fcChanged(c) {
  const n = fcCar(c);
  return (n.trim_id || null) !== (c.trim_id || null) || n.build_date !== (c.build_date || "") || FO_CHECK.month(FC.v.build) === null
    || FC_FIELDS.some(([k]) => n[k] !== (c[k] || ""));
}
function fcResultsHtml(c) {
  const T = trimData(), car = fcCar(c), trim = car.trim_id ? T.trims.get(car.trim_id) : null;
  const R = FO_CHECK.check({ car, trim, facts: Array.from(T.facts.values()), models: DB ? DB.snap.models : [] });
  const k = R.counts;
  const sum = [k.bad ? `<span class="chip bad">${k.bad} doesn't fit</span>` : "", k.warn ? `<span class="chip warn">${k.warn} to check</span>` : "",
               k.good ? `<span class="chip good">${k.good} factory</span>` : "", k.unknown ? `<span class="chip">${k.unknown} unknown</span>` : ""].filter(Boolean).join(" ");
  return `<div class="fcsum">${sum}</div><div class="htiles fct">${R.checks.map(x => `<div class="htile ${FC_VERDICT[x.verdict][0]}"><span class="hv">${FC_VERDICT[x.verdict][1]}</span>
      <b>${esc(x.title)}${x.entered && x.id !== "trim" ? ` <code>${esc(x.entered)}</code>` : ""}</b>${x.meaning ? `<span class="hval">${esc(x.meaning)}</span>` : ""}
      ${x.note ? `<span class="hn">${esc(x.note)}</span>` : ""}${x.src && x.src.doc_sha ? `<span>${srcLink(x.src)}</span>` : ""}</div>`).join("")}</div>`;
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
      <label class="field"><span>Build date</span><input id="fc-build" maxlength="10" autocomplete="off" value="${esc(FC.v.build)}" placeholder="MM/YYYY"></label></div>
    <div id="fc-res">${fcResultsHtml(c)}</div>
    <div class="row" style="gap:10px;margin-top:10px"><button class="btn primary" id="fc-save"${fcChanged(c) ? "" : " disabled"}>Save to this car</button><span id="fc-msg" class="note bad" style="margin:0"></span></div>
    <p class="note">The codes as read off the build plate (engine bay) and compliance plate (A-pillar). What they mean comes only from the code tables you ticked from your manuals.</p></div>`;
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
  $("fc-save").onclick = async () => {
    const n = fcCar(c), bad = FC_FIELDS.find(([k]) => n[k] && !/^[A-Z0-9]{1,8}$/.test(n[k]));
    if (FO_CHECK.month(FC.v.build) === null) { $("fc-msg").textContent = "Build date as MM/YYYY, e.g. 06/2010"; return; }
    if (bad) { $("fc-msg").textContent = `The ${bad[1].toLowerCase()} code is letters and numbers only.`; return; }
    const data = { id: c.id, nickname: c.nickname || "", model: c.model || null, year: c.year == null || c.year === "" ? null : c.year, vin: c.vin || null,
                   kind: c.kind || "mine", notes: c.notes || "", trim_id: n.trim_id, build_date: n.build_date };
    FC_FIELDS.forEach(([k]) => { data[k] = n[k]; });
    await outboxAdd([{ id: uuid(), kind: "car", data }]);
    FC.carId = null;
    toast("Saved to " + carName(c)); render(true); sync(false);
  };
}

self.FO_FACTORY_APP = { FC, fcCar, factoryCardHtml };   // tests
