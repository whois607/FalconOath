/* FalconOath - Falcon asking prices from VPA (step 5): overall averages.
   Loaded after logs.js; uses app.js's helpers. The laptop works them out
   from VPA (read-only) and sends them in the snapshot (snap.prices): per
   model, then per series and per trim, the median asking price, the mean,
   the middle half (25th-75th percentile), median km and how many cars.
   One price per car (its latest), used cars only. */
"use strict";
const PRICE_MODELS = [["BA", "BA"], ["BF", "BF"], ["FG", "FG"], ["FGX", "FG X"]];
const money = n => n == null ? "–" : "$" + NUM.format(Math.round(n));
const kmk = n => n == null ? "–" : NUM.format(Math.round(n / 1000)) + "k km";
const prices = () => (DB && DB.snap.prices && DB.snap.prices.models) ? DB.snap.prices : null;
/* the model a screen shows: ?m=FG, ?m=all (null: every model), or else the one chosen in Settings */
const pickModel = q => q === "all" ? null : PRICE_MODELS.some(([k]) => k === q) ? q : (PRICE_MODELS.some(([k]) => k === model()) ? model() : null);

/* one line for a car's page: what its model is asking */
function priceLineHtml(model) {
  const P = prices(), d = P && model && P.models[model];
  if (!d) return "";
  return `<a class="pline" href="#/prices?m=${enc(model)}"><span class="faint">${esc(modelName(model))}s for sale</span>
    <b>${money(d.median)}</b><span class="faint">typical ${money(d.p25)}–${money(d.p75)} · ${NUM.format(d.cars)} cars</span>${CHEV}</a>`;
}

/* a row with a bar: the middle half of prices on a shared scale, the median marked */
function rangeRows(list, lo, hi, extra) {
  const x = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  return `<div class="prows">${list.map(t => `<div class="prow"><div class="pname"><b>${esc(t.name)}</b><span class="faint">${NUM.format(t.cars)} car${t.cars === 1 ? "" : "s"}${extra ? extra(t) : ""}</span></div>
    <div class="pmed">${money(t.median)}</div>
    <div class="pbar" title="${money(t.p25)} to ${money(t.p75)}"><i style="left:${x(t.p25)}%;width:${Math.max(1.5, x(t.p75) - x(t.p25))}%"></i><u style="left:${x(t.median)}%"></u></div>
    <div class="prange faint">${money(t.p25)}–${money(t.p75)}</div></div>`).join("")}</div>`;
}

route("/prices", { tab: "home", back: true, wide: true, title: () => "Prices" }, r => {
  const P = prices();
  if (!P) return `<div class="card"><h2>No prices yet</h2><p class="sub">They come from VPA (the price tracker) on the laptop: FalconOath reads its Falcon listings, read-only, and works out the averages. They arrive with the next sync once VPA has some.</p></div>`;
  const pick = pickModel(r.q.m);
  let h = `<div class="card"><div class="seg">${PRICE_MODELS.map(([k, l]) => `<a class="segbtn${pick === k ? " on" : ""}" href="#/prices?m=${k}">${l}</a>`).join("")}
      <a class="segbtn${!pick ? " on" : ""}" href="#/prices?m=all">All</a></div>
    <p class="note">Asking prices from the Falcon listings saved in VPA, ${dAU(P.first)} to ${dAU(P.last)}: one price per car (its latest), used cars only. The middle figure is the median: half asked less, half more.</p></div>`;
  if (!pick) {
    const ms = PRICE_MODELS.filter(([k]) => P.models[k]);
    const lo = Math.min(...ms.map(([k]) => P.models[k].p25)), hi = Math.max(...ms.map(([k]) => P.models[k].p75));
    h += `<div class="card"><h2>Every model</h2>${rangeRows(ms.map(([k, l]) => Object.assign({ name: l }, P.models[k])), lo * 0.9, hi * 1.05, t => " · " + kmk(t.km))}
      <p class="note">The bar is the middle half of asking prices; the mark is the median. Tap a model above for its series and trims.</p></div>`;
    return h;
  }
  const d = P.models[pick];
  if (!d) return h + `<div class="card"><p class="sub">No ${esc(modelName(pick))}s in VPA yet.</p></div>`;
  h += `<div class="card pbig"><div class="pk"><span class="faint">${esc(modelName(pick))} asking price</span><b>${money(d.median)}</b>
      <span class="faint">median · mean ${money(d.mean)}</span></div>
    <div class="pstats"><div><b>${money(d.p25)}–${money(d.p75)}</b><span>typical (middle half)</span></div>
      <div><b>${NUM.format(d.cars)}</b><span>cars seen</span></div><div><b>${kmk(d.km)}</b><span>median km</span></div>
      <div><b>${NUM.format(d.recent)}</b><span>seen in the last ${P.recent_days || 14} days</span></div></div></div>`;
  const all = d.series.concat(d.trims), lo = Math.min(...all.map(t => t.p25)), hi = Math.max(...all.map(t => t.p75));
  if (d.series.length > 1) h += `<div class="card"><h2>By series</h2>${rangeRows(d.series, lo, hi, t => " · " + kmk(t.km))}</div>`;
  h += `<div class="card"><h2>By trim</h2>${rangeRows(d.trims, lo, hi, t => " · " + kmk(t.km))}
    <p class="note">Trims with only a car or two are a guide at best. The bar is the middle half of asking prices; the mark is the median.</p></div>`;
  return h;
});

self.FO_PRICES_APP = { priceLineHtml, prices };   // tests
