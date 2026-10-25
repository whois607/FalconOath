/* FalconOath - trims and options, from your own brochures (step 6).
   Loaded after prices.js; uses app.js's helpers, the outbox (garage.js),
   the library and pdf.js (manuals.js), and lib/brochure.js.

   Nothing is pre-filled. A brochure is a PDF in manuals/<model>/Brochures/.
   Its reader (#/brochure/<sha>?p=) shows a page beside what lib/brochure.js
   found on it; you tick what's right, choose the trim (or the whole series,
   e.g. its colours) and save. Each fact keeps the brochure and page it came
   from. Trims and facts go to the laptop as "trim" and "fact" outbox items
   and come back in the data copy (snap.trims, snap.facts); this device's
   own changes show straight away, marked, until they do. */
"use strict";
const TRIM_BODIES = [["", "Any"], ["sedan", "Sedan"], ["ute", "Ute"], ["wagon", "Wagon"], ["cab chassis", "Cab chassis"]];
const bodyName = b => (TRIM_BODIES.find(x => x[0] === b) || [b, b ? b.charAt(0).toUpperCase() + b.slice(1) : ""])[1];
const DRIVE = ["power", "torque", "engine", "gearbox", "fuel"];

/* ------------------------------------------------------------ the data */
/* the laptop's trims and facts, with this device's changes on top */
function trimData() {
  const snap = DB ? DB.snap : {}, trims = new Map(), facts = new Map();
  (snap.trims || []).forEach(t => trims.set(t.id, Object.assign({}, t, { pending: false })));
  (snap.facts || []).forEach(f => facts.set(f.id, Object.assign({}, f, { pending: false })));
  OUTBOX.forEach(o => {
    if (o.kind !== "trim" && o.kind !== "fact") return;
    const m = o.kind === "trim" ? trims : facts, d = o.data;
    if (d.op === "del") {
      if (o.result === "rejected") return;
      m.delete(d.id);
      if (o.kind === "trim") for (const [k, f] of facts) if (f.trim_id === d.id) facts.delete(k);
      return;
    }
    if (o.kind === "fact" && d.trim_id && !trims.has(d.trim_id)) return;      // its trim was deleted here
    m.set(d.id, Object.assign({}, m.get(d.id) || { created_at: o.created }, d,
      { pending: true, rejected: o.result === "rejected", detail: o.detail, sent: o.sent }));
  });
  return { trims, facts };
}
const trimName = t => t ? [t.name, t.body ? bodyName(t.body).toLowerCase() : ""].filter(Boolean).join(" ") : "";
const sortTrims = ts => ts.sort((a, b) => String(a.series).localeCompare(String(b.series)) || a.name.localeCompare(b.name) || String(a.body).localeCompare(String(b.body)));
function trimsOf(T, model) { return sortTrims(Array.from(T.trims.values()).filter(t => t.model === model)); }
function factsOf(T, trimId) { return Array.from(T.facts.values()).filter(f => f.trim_id === trimId); }
const isCode = f => FO_BRO.CODE_KINDS.includes(f.kind);
function seriesFacts(T, model, series) { return Array.from(T.facts.values()).filter(f => !f.trim_id && f.model === model && f.series === series && !isCode(f)); }
function seriesOf(T, model) {
  const s = new Set();
  T.trims.forEach(t => { if (t.model === model) s.add(t.series); });
  T.facts.forEach(f => { if (f.model === model && !f.trim_id && !isCode(f)) s.add(f.series); });
  return Array.from(s).sort();
}
/* a model's code tables (step 7), for the Codes page and the checker */
const codesOf = (T, model) => Array.from(T.facts.values()).filter(f => f.model === model && isCode(f));
const seriesTitle = (model, s) => s || modelName(model) + " (series not given)";
/* the brochures for a model: its own folder (General ones for every model) */
function brochuresFor(model) {
  if (!LIB) return [];
  return LIB.manuals.filter(m => m.brochure && (!model || m.folder === model || m.folder === "General"));
}
const broModel = (m, q) => ["BA", "BF", "FG", "FGX"].includes(m.folder) ? m.folder
  : ["BA", "BF", "FG", "FGX"].includes(q) ? q : ["BA", "BF", "FG", "FGX"].includes(model()) ? model() : "FG";

/* the page a fact came from, as a link to it */
function srcLink(x) {
  const m = LIB && LIB.bySha.get(x.doc_sha);
  return m ? `<a class="src" href="#/manual/${x.doc_sha}?p=${x.page}" title="${esc(m.title)}, page ${x.page}">p ${esc(x.page)}</a>`
    : `<span class="src faint" title="That brochure isn't in the library any more">p ${esc(x.page)}</span>`;
}
const pendMark = x => x.rejected ? ` <span class="badge alt" title="${esc(x.detail)}">Refused</span>` : x.pending ? ' <span class="badge alt">Not on the laptop yet</span>' : "";

/* deleting: what never left this device is just dropped; the rest is a "del" for the laptop */
async function dropRecord(kind, id) {
  const onLaptop = DB && (kind === "trim" ? (DB.snap.trims || []) : (DB.snap.facts || [])).some(x => x.id === id);
  const sentAlready = OUTBOX.some(o => o.kind === kind && o.data.id === id && o.sent);
  OUTBOX = OUTBOX.filter(o => !(!o.sent && !o.result && ((o.kind === kind && o.data.id === id) || (kind === "trim" && o.kind === "fact" && o.data.trim_id === id))));
  const items = [];
  if (onLaptop || sentAlready) items.push({ id: uuid(), kind, data: { op: "del", id } });
  if (items.length) await outboxAdd(items); else await outboxSave();
  sync(false);
}

/* ------------------------------------------------------------ browse */
function trimTile(T, t) {
  const fs = factsOf(T, t.id), first = k => (fs.find(f => f.kind === k) || {}).value;
  return `<a class="ttile" href="#/trim/${enc(t.id)}"><b>${esc(t.name)}</b><span class="faint">${esc([bodyName(t.body), t.years].filter(Boolean).join(" · ") || " ")}</span>
    ${first("power") ? `<span class="tk">${esc(first("power").replace(/\s*@.*/, ""))}</span>` : ""}
    <span class="tg">${esc([first("engine"), first("gearbox")].filter(Boolean).join(" · "))}</span>
    <span class="faint tn">${fs.length} fact${fs.length === 1 ? "" : "s"}${pendMark(t)}</span></a>`;
}
function brochureListHtml(T, model) {
  const bs = brochuresFor(model);
  if (!bs.length) return "";
  return `<div class="card"><h2>Brochures</h2><ul class="list">${bs.map(m => {
    const n = Array.from(T.facts.values()).filter(f => f.doc_sha === m.sha).length + Array.from(T.trims.values()).filter(t => t.doc_sha === m.sha && !factsOf(T, t.id).length).length;
    const last = +LS.get("bro.page." + m.sha) || 0;
    return `<li><a href="#/brochure/${m.sha}?p=${last || 1}${model ? "&m=" + model : ""}"><span class="mico">${BOOK}</span><span class="d"><b>${esc(m.title)}</b>${subHtml(m)}
      <small>${n0(m.pages)} pages${m.pages && !m.text_pages ? ' · <span class="warn">no text: type what you see</span>' : ""}${last ? ` · up to page ${last}` : ""}</small></span>
      <span class="chip ${n ? "good" : ""}">${n ? `${n} saved` : "Not read yet"}</span>${CHEV}</a></li>`;
  }).join("")}</ul></div>`;
}
function noBrochuresHtml(model) {
  const f = model || "FG";
  return `<div class="card"><h2>No brochures${model ? " for the " + esc(modelName(model)) : ""} yet</h2>
    <p class="sub">Trims and options come only from your own sales brochures. On the laptop, put the PDFs in <b>falcon-app\\manuals\\${esc(f)}\\Brochures</b>
      (press <b>M</b> in the FalconOath window to open the manuals folder). Then open one here and tick what's right on each page.</p>
    <a class="btn primary" href="#/addmanual?brochure=1">Send a brochure from this device</a></div>`;
}
route("/browse", { tab: "home", back: true, wide: true, title: () => "Browse" }, r => {
  const T = trimData(), pick = pickModel(r.q.m);
  let h = `<div class="card"><div class="seg">${PRICE_MODELS.map(([k, l]) => `<a class="segbtn${pick === k ? " on" : ""}" href="#/browse?m=${k}">${l}</a>`).join("")}
      <a class="segbtn${!pick ? " on" : ""}" href="#/browse?m=all">All</a></div>
    <p class="note">Trims, engines, options and colours, only as you've confirmed them from your own brochures. Each fact links to its page.</p></div>`;
  if (!pick) {
    h += `<div class="ttiles">${PRICE_MODELS.map(([k, l]) => { const ts = trimsOf(T, k), bs = brochuresFor(k).length;
      return `<a class="ttile" href="#/browse?m=${k}"><b>${l}</b><span class="tk">${ts.length}</span><span class="faint">trim${ts.length === 1 ? "" : "s"} · ${bs} brochure${bs === 1 ? "" : "s"}</span></a>`; }).join("")}</div>`;
    return h + (brochuresFor(null).length ? brochureListHtml(T, null) : noBrochuresHtml(null));
  }
  const ss = seriesOf(T, pick);
  if (!ss.length) h += brochuresFor(pick).length ? `<div class="card"><h2>No ${esc(modelName(pick))} trims yet</h2><p class="sub">Open a brochure below and tick what's right on its pages.</p></div>` : noBrochuresHtml(pick);
  ss.forEach(s => {
    const ts = trimsOf(T, pick).filter(t => t.series === s), sf = seriesFacts(T, pick, s), nc = sf.filter(f => f.kind === "colour").length;
    h += `<div class="card"><div class="spread"><h2>${esc(seriesTitle(pick, s))}</h2>${sf.length ? `<a class="note" style="margin:0" href="#/series?m=${pick}&s=${enc(s)}">${
      nc ? `${nc} colour${nc === 1 ? "" : "s"} · ` : ""}every ${esc(s || modelName(pick))}</a>` : ""}</div>
      ${ts.length ? `<div class="ttiles">${ts.map(t => trimTile(T, t)).join("")}</div>` : `<p class="sub">Only facts for the whole series so far.</p>`}</div>`;
  });
  return h + codesCardHtml(T, pick) + (ss.length || brochuresFor(pick).length ? brochureListHtml(T, pick) : "");
});
function codesCardHtml(T, model) {
  const cs = codesOf(T, model), n = k => cs.filter(f => f.kind === k).length;
  return `<a class="card pline codesline" href="#/codes?m=${model}"><b>Codes</b><span class="faint">${cs.length
    ? FO_BRO.CODE_KINDS.filter(k => n(k)).map(k => `${n(k)} ${FO_BRO.KIND_NAME[k].replace(" code", "").toLowerCase()}`).join(" · ") + " · for the factory check"
    : "Paint, body and model codes: tick them from your manual's identification codes page"}</span>${CHEV}</a>`;
}

/* ------------------------------------------------------------ code tables */
route("/codes", { tab: "home", back: true, wide: true, title: r => `${modelName(r.q.m)} codes` }, r => {
  const T = trimData(), m = PRICE_MODELS.some(([k]) => k === r.q.m) ? r.q.m : "FG", edit = r.q.edit === "1", cs = codesOf(T, m);
  let h = `<div class="card"><div class="seg">${PRICE_MODELS.map(([k, l]) => `<a class="segbtn${m === k ? " on" : ""}" href="#/codes?m=${k}">${l}</a>`).join("")}</div>
    <div class="spread" style="margin-top:8px"><p class="note" style="margin:0">Build plate codes and what they mean, as you ticked them from your manuals. The factory check on each car reads these.</p>
    ${cs.length ? `<a class="note" style="margin:0" href="#/codes?m=${m}${edit ? "" : "&edit=1"}">${edit ? "Done" : "Edit"}</a>` : ""}</div></div>`;
  if (!cs.length) {
    const idp = LIB ? LIB.manuals.filter(x => (x.folder === m || x.folder === "General") && /identification/i.test(x.title)) : [];
    return h + `<div class="card"><h2>No ${esc(modelName(m))} codes yet</h2><p class="sub">Open your workshop manual's <b>100-01 Identification Codes</b> section and tick its body, model, paint and trim codes.${
      m === "FG" ? " (The FG manual's copy may be the BF section with an FG header: check the colours are FG ones.)" : ""}</p>
      ${idp.map(x => `<a class="btn" style="margin:4px 6px 0 0" href="#/brochure/${x.sha}?p=${firstCodePage(x.sha, m)}&m=${m}">Read ${esc(x.title)}${subPath(x) ? ` <span class="faint">(${esc(subPath(x).split(" › ").pop())})</span>` : ""}</a>`).join("")}</div>`;
  }
  FO_BRO.CODE_KINDS.forEach(k => {
    const xs = cs.filter(f => f.kind === k).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    if (!xs.length) return;
    h += `<div class="card"><h2>${esc(FO_BRO.KIND_NAME[k])}s</h2><div class="ctable">${xs.map(f => `<div class="crow"><code>${esc(f.code)}</code>
      <span>${esc(f.value)}${f.label ? ` <span class="faint">${esc(f.label)}</span>` : ""}${f.series ? ` <span class="chip">${esc(f.series)}</span>` : ""}${pendMark(f)}</span>${srcLink(f)}${
      edit ? `<button class="x" data-delfact="${esc(f.id)}" aria-label="Delete">×</button>` : ""}</div>`).join("")}</div></div>`;
  });
  return h;
});
ROUTES["/codes"].after = () => wireFactDeletes();
/* the first page of a manual with a code table on it (1 if none) */
function firstCodePage(sha, model) {
  const pages = (LIB && LIB.text[sha]) || [];
  const i = pages.findIndex(t => FO_BRO.suggest(t, model).facts.some(isCode));
  return i < 0 ? 1 : i + 1;
}

/* ------------------------------------------------------------ one trim (or a whole series) */
function factItem(f, edit) {
  return `<li class="fi"><span class="fv">${f.label ? `<span class="faint">${esc(f.label)}</span> ` : ""}${esc(f.value)}${f.code ? ` <code>${esc(f.code)}</code>` : ""}${pendMark(f)}</span>${srcLink(f)}${
    edit ? `<button class="x" data-delfact="${esc(f.id)}" aria-label="Delete">×</button>` : ""}</li>`;
}
function factsHtml(fs, edit, inherited) {
  const G = FO_BRO.grouped(fs);
  if (!G.length) return "";
  let h = "";
  const drive = G.find(g => g[0] === "drive");
  if (drive) {
    h += `<div class="stiles">${DRIVE.map(k => [k, drive[2].filter(f => f.kind === k)]).filter(x => x[1].length).map(([k, xs]) =>
      `<div class="stile"><span class="sl">${esc(FO_BRO.KIND_NAME[k])}</span>${xs.map(f => `<div class="sv"><b>${esc(f.value)}</b>${f.label ? ` <span class="faint">${esc(f.label)}</span>` : ""}${pendMark(f)}${srcLink(f)}${
        edit ? `<button class="x" data-delfact="${esc(f.id)}" aria-label="Delete">×</button>` : ""}</div>`).join("")}</div>`).join("")}</div>`;
  }
  G.filter(g => g[0] !== "drive").forEach(([id, title, xs]) => {
    h += `<div class="fsec ${id}"><h3>${esc(title)}${inherited ? ` <span class="faint">· ${esc(inherited)}</span>` : ""}</h3>${id === "colour"
      ? `<div class="ccol">${xs.map(f => `<span class="cchip">${esc(f.value)}${f.code ? ` <code>${esc(f.code)}</code>` : ""}${pendMark(f)}${srcLink(f)}${
          edit ? `<button class="x" data-delfact="${esc(f.id)}" aria-label="Delete">×</button>` : ""}</span>`).join("")}</div>`
      : `<ul class="fl ${id === "standard" || id === "option" ? "cols" : ""}">${xs.map(f => factItem(f, edit)).join("")}</ul>`}</div>`;
  });
  return h;
}
function trimPrice(t) {
  const P = prices(), d = P && P.models[t.model];
  const low = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const x = d && (d.trims || []).find(y => low(y.name) === low(t.name));
  return x ? `<a class="pline" href="#/prices?m=${enc(t.model)}"><span class="faint">${esc(modelName(t.model))} ${esc(t.name)}s for sale</span>
    <b>${money(x.median)}</b><span class="faint">typical ${money(x.p25)}–${money(x.p75)} · ${NUM.format(x.cars)} car${x.cars === 1 ? "" : "s"}</span>${CHEV}</a>` : "";
}
const TEDIT = { id: null, v: null };
route("/trim", { tab: "home", back: true, wide: true, title: r => (trimData().trims.get(r.arg) || {}).name || "Trim" }, r => {
  const T = trimData(), t = T.trims.get(r.arg), edit = r.q.edit === "1";
  if (!t) return `<div class="card"><h2>Trim not found</h2><p class="sub">It may have been deleted, or not reached this device yet.</p><a class="btn" href="#/browse">Browse</a></div>`;
  const fs = factsOf(T, t.id), sf = seriesFacts(T, t.model, t.series);
  let h = `<div class="card"><div class="spread"><h2 style="font-size:21px">${esc(t.name)}</h2>
      <a class="note" style="margin:0" href="#/trim/${enc(t.id)}${edit ? "" : "?edit=1"}">${edit ? "Done" : "Edit"}</a></div>
    <div class="tags"><span class="chip">${esc(modelName(t.model))}</span>${t.series ? `<span class="chip">${esc(t.series)}</span>` : ""}${
      t.body ? `<span class="chip">${esc(bodyName(t.body))}</span>` : ""}${t.years ? `<span class="chip">${esc(t.years)}</span>` : ""}${pendMark(t)}
      <span class="faint" style="font-size:12.5px">from ${srcLink(t)}</span></div>
    ${t.rejected ? `<p class="note bad">${esc(t.detail)}</p>` : ""}${t.notes ? `<p class="sub">${esc(t.notes)}</p>` : ""}${trimPrice(t)}`;
  if (edit) {
    if (TEDIT.id !== t.id) Object.assign(TEDIT, { id: t.id, v: { series: t.series, name: t.name, body: t.body, years: t.years, notes: t.notes } });
    h += `<div class="tedit">${trimFieldsHtml(TEDIT.v, "te")}<label class="field"><span>Notes</span><input id="te-notes" maxlength="1000" value="${esc(TEDIT.v.notes)}"></label>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" id="te-save">Save changes</button><span style="flex:1"></span>
      <button class="btn danger" id="te-del">Delete this trim</button></div><div id="te-msg" class="note bad"></div></div>`;
  }
  h += `</div>`;
  h += fs.length ? `<div class="card">${factsHtml(fs, edit)}</div>` : `<div class="card"><p class="sub">No facts on this trim yet. Open its brochure and tick them.</p></div>`;
  if (sf.length) h += `<div class="card">${factsHtml(sf, edit, "every " + (t.series || modelName(t.model)))}</div>`;
  const b = LIB && LIB.bySha.get(t.doc_sha);
  if (b) h += `<a class="btn block" href="#/brochure/${t.doc_sha}?p=${t.page}&m=${t.model}&t=${enc(t.id)}">Add more from ${esc(b.title)}</a>`;
  return h;
});
ROUTES["/trim"].after = r => {
  wireFactDeletes();
  if (!$("te-save")) return;
  wireTrimFields(TEDIT.v, "te");
  $("te-notes").oninput = e => { TEDIT.v.notes = e.target.value; };
  $("te-save").onclick = async () => {
    const t = trimData().trims.get(r.arg), v = TEDIT.v;
    if (!String(v.name || "").trim()) { $("te-msg").textContent = "The trim needs a name."; return; }
    if (sameTrimAs(t.model, v, t.id)) { $("te-msg").textContent = "Another trim already has that name."; return; }
    await outboxAdd([{ id: uuid(), kind: "trim", data: { op: "put", id: t.id, model: t.model, series: v.series.trim(), name: v.name.trim(), body: v.body,
      years: v.years.trim(), notes: String(v.notes || "").trim(), doc_sha: t.doc_sha, page: t.page } }]);
    TEDIT.id = null; location.hash = "#/trim/" + enc(t.id); toast("Saved"); sync(false);
  };
  $("te-del").onclick = async () => {
    const t = trimData().trims.get(r.arg), n = factsOf(trimData(), t.id).length;
    if (!confirm(`Delete ${t.name}${n ? ` and its ${n} fact${n === 1 ? "" : "s"}` : ""}? (The brochure itself isn't touched.)`)) return;
    await dropRecord("trim", t.id);
    location.hash = "#/browse?m=" + t.model; toast("Deleted");
  };
};
function wireFactDeletes() {
  document.querySelectorAll("[data-delfact]").forEach(b => b.onclick = async e => {
    e.preventDefault();
    const f = trimData().facts.get(b.dataset.delfact);
    if (!f || !confirm(`Delete “${f.value}”?`)) return;
    await dropRecord("fact", f.id); render(true);
  });
}
route("/series", { tab: "home", back: true, wide: true, title: r => r.q.s || modelName(r.q.m) }, r => {
  const T = trimData(), m = r.q.m, s = r.q.s || "", edit = r.q.edit === "1", sf = PRICE_MODELS.some(([k]) => k === m) ? seriesFacts(T, m, s) : [];
  return `<div class="card"><div class="spread"><h2 style="font-size:21px">Every ${esc(seriesTitle(m, s))}</h2>
      <a class="note" style="margin:0" href="#/series?m=${enc(m)}&s=${enc(s)}${edit ? "" : "&edit=1"}">${edit ? "Done" : "Edit"}</a></div>
    <p class="sub">Facts the brochure gives for the whole series rather than one trim, such as its paint colours.</p></div>
    ${sf.length ? `<div class="card">${factsHtml(sf, edit)}</div>` : `<div class="card"><p class="sub">Nothing for the whole series yet.</p></div>`}`;
});
ROUTES["/series"].after = () => wireFactDeletes();

/* trim fields (new or edited): series, name, body, years */
function trimFieldsHtml(v, p, seriesList) {
  return `<div class="row2"><label class="field"><span>Series</span><input id="${p}-series" maxlength="40" list="${p}-sl" value="${esc(v.series)}" placeholder="e.g. FG MkII">
      <datalist id="${p}-sl">${(seriesList || []).map(s => `<option value="${esc(s)}">`).join("")}</datalist></label>
    <label class="field"><span>Trim name</span><input id="${p}-name" maxlength="60" value="${esc(v.name)}" placeholder="e.g. XR6 Turbo"></label></div>
    <div class="row2"><label class="field"><span>Years <i class="faint">(optional)</i></span><input id="${p}-years" maxlength="20" value="${esc(v.years)}" placeholder="2008-2011"></label>
    <div class="field"><span>Body</span><div class="seg">${TRIM_BODIES.map(([k, l]) => `<button type="button" data-${p}body="${esc(k)}" class="${v.body === k ? "on" : ""}">${l}</button>`).join("")}</div></div></div>`;
}
function wireTrimFields(v, p, onChange) {
  ["series", "name", "years"].forEach(k => { const el = $(`${p}-${k}`); if (el) el.oninput = () => { v[k] = el.value; if (onChange) onChange(); }; });
  document.querySelectorAll(`[data-${p}body]`).forEach(b => b.onclick = () => {
    v.body = b.getAttribute(`data-${p}body`);
    document.querySelectorAll(`[data-${p}body]`).forEach(x => x.classList.toggle("on", x === b));
    if (onChange) onChange();
  });
}
const lowName = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function sameTrimAs(model, v, notId) {
  return trimsOf(trimData(), model).find(t => t.id !== notId && t.series === String(v.series || "").trim() && lowName(t.name) === lowName(v.name) && t.body === (v.body || ""));
}

/* ------------------------------------------------------------ reading a brochure */
const BRO = { key: null, sha: null, page: 1, model: null, target: null, nt: null, rows: [], view: { sha: null, doc: null, task: null } };
function broSetup(m, page, q) {
  const key = m.sha + ":" + page;
  BRO.model = broModel(m, q.m);
  if (BRO.key === key && BRO.rows) return;
  const T = trimData(), text = (LIB.text[m.sha] || [])[page - 1] || "", S = FO_BRO.suggest(text, BRO.model);
  const saved = new Set(Array.from(T.facts.values()).filter(f => f.model === BRO.model && f.doc_sha === m.sha).map(FO_BRO.factKey));
  Object.assign(BRO, { key, sha: m.sha, page, sugg: S, rows: S.facts.filter(f => !saved.has(FO_BRO.factKey(f))).map(f => Object.assign({ on: false, code: "" }, f)) });
  // where to save: the trim asked for (from its page); else the first trim the page
  // names (one already here, or a new one); else as last time on this brochure
  const ts = trimsOf(T, BRO.model), named = S.trims.map(x => x.name);
  const keep = LS.get("bro.target." + m.sha);
  const hit = ts.find(t => lowName(t.name) === lowName(named[0]) && (!S.series.length || S.series.includes(t.series)));
  const fresh = named.find(n => !ts.some(t => lowName(t.name) === lowName(n))) || "";
  // a page of code tables (a manual's identification codes): for the whole model, unless it names a series
  const codes = S.facts.length && S.facts.filter(f => FO_BRO.CODE_KINDS.includes(f.kind)).length * 2 >= S.facts.length;
  const series = S.series[0] || (codes ? "" : LS.get("bro.series." + BRO.model) || "");
  BRO.target = q.t && T.trims.has(q.t) ? q.t : codes ? "series" : hit ? hit.id : named.length && fresh ? "new"
    : keep && (keep === "series" || T.trims.has(keep)) ? keep : "new";
  BRO.nt = { series, name: fresh, body: S.bodies.length === 1 ? S.bodies[0] : "", years: "" };
}
function broTargetName() {
  if (BRO.target === "series") return "every " + (BRO.nt.series || modelName(BRO.model));
  if (BRO.target === "new") return BRO.nt.name ? `a new trim, ${BRO.nt.name}` : "a new trim";
  return trimName(trimData().trims.get(BRO.target));
}
function broSaveLabel() {
  const n = BRO.rows.filter(x => x.on && String(x.value).trim()).length;
  return n ? `Save ${n} to ${broTargetName()}` : BRO.target === "new" && BRO.nt.name ? `Save the trim ${BRO.nt.name}` : "Tick what's right first";
}
function broRowsHtml() {
  if (!BRO.rows.length) return "";
  return `<div class="brows">${BRO.rows.map((x, i) => `<div class="brow${x.on ? " on" : ""}${FO_BRO.CODE_KINDS.includes(x.kind) ? " hascode" : ""}" data-row="${i}">
      <input type="checkbox" data-on="${i}"${x.on ? " checked" : ""} aria-label="Keep this">
      <select data-k="${i}" class="small" aria-label="Kind">${FO_BRO.KINDS.map(([k, l]) => `<option value="${k}"${x.kind === k ? " selected" : ""}>${l}</option>`).join("")}</select>
      <input data-v="${i}" value="${esc(x.value)}" aria-label="Value" placeholder="What the brochure says">
      <input data-l="${i}" class="bl" value="${esc(x.label)}" aria-label="Label" placeholder="Label">
      <input data-c="${i}" class="bc" value="${esc(x.code)}" aria-label="Code" placeholder="Code" maxlength="20"></div>`).join("")}</div>`;
}
route("/brochure", { tab: "home", back: true, wide: true, title: r => (LIB && LIB.bySha.get(r.arg) || {}).title || "Brochure" }, r => {
  const m = LIB && LIB.bySha.get(r.arg);
  if (!m) return `<div class="card"><h2>Brochure not found</h2><p class="sub">It may have been removed on the laptop, or not reached this device yet.</p><a class="btn" href="#/browse">Browse</a></div>`;
  const page = Math.max(1, Math.min(m.pages || 1, parseInt(r.q.p, 10) || 1));
  broSetup(m, page, r.q);
  const T = trimData(), S = BRO.sugg, ts = trimsOf(T, BRO.model), text = (LIB.text[m.sha] || [])[page - 1] || "";
  const here = Array.from(T.facts.values()).filter(f => f.doc_sha === m.sha && f.page === page);
  const hereTrims = Array.from(T.trims.values()).filter(t => t.doc_sha === m.sha && t.page === page);
  const bySeries = {};
  ts.forEach(t => { (bySeries[t.series] = bySeries[t.series] || []).push(t); });
  let side = `<div class="card"><div class="spread"><h2>Saving to</h2>${m.folder === "General" ? "" : `<span class="badge">${esc(modelName(BRO.model))}</span>`}</div>
    ${m.folder === "General" ? `<div class="seg" style="margin-bottom:8px">${PRICE_MODELS.map(([k, l]) => `<a class="segbtn${BRO.model === k ? " on" : ""}" href="#/brochure/${m.sha}?p=${page}&m=${k}">${l}</a>`).join("")}</div>` : ""}
    <select id="b-target" class="text">${Object.keys(bySeries).sort().map(s => `<optgroup label="${esc(seriesTitle(BRO.model, s))}">${bySeries[s].map(t =>
      `<option value="${esc(t.id)}"${BRO.target === t.id ? " selected" : ""}>${esc(trimName(t))}</option>`).join("")}</optgroup>`).join("")}
      <option value="series"${BRO.target === "series" ? " selected" : ""}>The whole series (e.g. its colours)</option>
      <option value="new"${BRO.target === "new" ? " selected" : ""}>+ A new trim</option></select>
    ${S.trims.length ? `<div class="vmatch"><span class="faint">On this page:</span> ${S.trims.map(x => `<button class="chip" data-pickname="${esc(x.name)}">${esc(x.name)}</button>`).join(" ")}</div>` : ""}
    ${BRO.target === "new" ? `<div style="margin-top:4px">${trimFieldsHtml(BRO.nt, "nt", seriesOf(T, BRO.model).filter(Boolean).concat(S.series))}</div>`
      : BRO.target === "series" ? `<label class="field"><span>Series <i class="faint">(blank: every ${esc(modelName(BRO.model))})</i></span><input id="nt-series" maxlength="40" value="${esc(BRO.nt.series)}" placeholder="e.g. FG MkII"></label>` : ""}</div>`;
  side += `<div class="card"><div class="spread"><h2>Found on this page</h2><span class="row" style="gap:6px">${BRO.rows.length ? `<button class="btn small" id="b-all">Tick all</button>` : ""}
      <button class="btn small" id="b-add">+ Add</button></span></div>
    ${!text ? `<p class="note warn" style="margin-top:0">No text on this page (a picture of it?). Read it off the page and type it in: <b>+ Add</b>.</p>`
      : !BRO.rows.length ? `<p class="note" style="margin-top:0">Nothing more found here${here.length ? " (what was found is saved below)" : ""}. Anything else: <b>+ Add</b>.</p>` : ""}
    ${broRowsHtml()}
    <button class="btn primary block" id="b-save" style="margin-top:10px">${esc(broSaveLabel())}</button>
    <div id="b-msg" class="note bad"></div></div>`;
  if (here.length || hereTrims.length) side += `<div class="card"><h2>Saved from this page</h2><ul class="fl">${hereTrims.map(t =>
      `<li class="fi"><span class="fv"><a href="#/trim/${enc(t.id)}"><b>${esc(trimName(t))}</b></a> <span class="faint">(the trim)</span>${pendMark(t)}</span></li>`).join("")}${here.map(f => {
      const t = f.trim_id ? T.trims.get(f.trim_id) : null;
      return `<li class="fi"><span class="fv"><span class="faint">${esc(t ? t.name : "every " + (f.series || modelName(f.model)))} · ${esc(FO_BRO.KIND_NAME[f.kind] || f.kind)}${f.label ? " · " + esc(f.label) : ""}</span> ${
        f.code ? `<code>${esc(f.code)}</code> ` : ""}${esc(f.value)}${pendMark(f)}</span>
        <button class="x" data-delfact="${esc(f.id)}" aria-label="Delete">×</button></li>`; }).join("")}</ul></div>`;
  if (text) side += `<div class="card"><details class="more"><summary>The page's text</summary><pre class="raw">${esc(text)}</pre></details></div>`;
  return `<div class="card vhead"><div class="spread"><h2>${esc(m.title)}</h2><a class="note" style="margin:0" href="#/manual/${m.sha}?p=${page}">Open in the viewer</a></div>${subHtml(m)}</div>
    <div class="bro"><div class="bpage"><div class="vbar"><a class="btn small" id="bprev" href="#/brochure/${m.sha}?p=${Math.max(1, page - 1)}${r.q.m ? "&m=" + enc(r.q.m) : ""}" aria-label="Previous page">‹</a>
        <label class="vpage"><input id="bnum" inputmode="numeric" value="${page}" aria-label="Page"> / ${n0(m.pages)}</label>
        <a class="btn small" id="bnext" href="#/brochure/${m.sha}?p=${Math.min(m.pages || 1, page + 1)}${r.q.m ? "&m=" + enc(r.q.m) : ""}" aria-label="Next page">›</a></div>
      <div id="bmsg" class="note"></div><div class="bcanvas" id="bcanvas"></div></div>
    <div class="bside">${side}</div></div>`;
});
ROUTES["/brochure"].after = r => {
  const m = LIB && LIB.bySha.get(r.arg);
  if (!m) return;
  LS.set("bro.page." + m.sha, BRO.page);
  wireFactDeletes();
  broDraw(m, BRO.page);
  $("bnum").onchange = () => { location.hash = `#/brochure/${m.sha}?p=${parseInt($("bnum").value, 10) || 1}${r.q.m ? "&m=" + enc(r.q.m) : ""}`; };
  const label = () => { if ($("b-save")) $("b-save").textContent = broSaveLabel(); };
  $("b-target").onchange = e => { BRO.target = e.target.value; render(true); };
  document.querySelectorAll("[data-pickname]").forEach(b => b.onclick = () => {
    const n = b.dataset.pickname, t = trimsOf(trimData(), BRO.model).find(x => lowName(x.name) === lowName(n) && (!BRO.nt.series || x.series === BRO.nt.series))
      || trimsOf(trimData(), BRO.model).find(x => lowName(x.name) === lowName(n));
    if (t) BRO.target = t.id; else { BRO.target = "new"; BRO.nt.name = n; }
    render(true);
  });
  if (BRO.target === "new") wireTrimFields(BRO.nt, "nt", label);
  else if ($("nt-series")) $("nt-series").oninput = e => { BRO.nt.series = e.target.value; label(); };
  const rowOf = el => BRO.rows[+(el.dataset.on || el.dataset.k || el.dataset.v || el.dataset.l || el.dataset.c)];
  document.querySelectorAll("[data-on]").forEach(el => el.onchange = () => { rowOf(el).on = el.checked; el.closest(".brow").classList.toggle("on", el.checked); label(); });
  document.querySelectorAll("[data-k]").forEach(el => el.onchange = () => { rowOf(el).kind = el.value;
    el.closest(".brow").classList.toggle("hascode", FO_BRO.CODE_KINDS.includes(el.value)); label(); });
  document.querySelectorAll("[data-v]").forEach(el => el.oninput = () => { const x = rowOf(el); x.value = el.value;
    if (!x.on && el.value.trim()) { x.on = true; const c = el.closest(".brow"); c.classList.add("on"); c.querySelector("[data-on]").checked = true; } label(); });
  document.querySelectorAll("[data-l]").forEach(el => el.oninput = () => { rowOf(el).label = el.value; });
  document.querySelectorAll("[data-c]").forEach(el => el.oninput = () => { rowOf(el).code = el.value; });
  if ($("b-all")) $("b-all").onclick = () => { const all = BRO.rows.every(x => x.on); BRO.rows.forEach(x => { x.on = !all; }); render(true); };
  $("b-add").onclick = () => {
    BRO.rows.push({ on: true, kind: BRO.rows.length ? BRO.rows[BRO.rows.length - 1].kind : "standard", label: "", value: "", code: "" });
    render(true);
    const v = document.querySelector(`[data-v="${BRO.rows.length - 1}"]`); if (v) v.focus();
  };
  $("b-save").onclick = () => broSave(m);
};
async function broSave(m) {
  const msg = $("b-msg"), T = trimData(), rows = BRO.rows.filter(x => x.on && String(x.value).trim());
  const src = { doc_sha: m.sha, page: BRO.page }, items = [];
  let trimId = null, series = "";
  if (BRO.target === "new") {
    const v = BRO.nt;
    if (!String(v.name || "").trim()) { msg.textContent = "Give the new trim a name (or choose one above)."; return; }
    const same = sameTrimAs(BRO.model, v);
    if (same) trimId = same.id;                       // already here: add to it
    else {
      trimId = uuid();
      items.push({ id: trimId, kind: "trim", data: Object.assign({ op: "put", id: trimId, model: BRO.model, series: v.series.trim(), name: v.name.trim(),
        body: v.body || "", years: v.years.trim(), notes: "" }, src) });
    }
    series = v.series.trim();
  } else if (BRO.target === "series") {
    if (!rows.length) { msg.textContent = "Tick what's right first."; return; }
    series = BRO.nt.series.trim();
  } else {
    const t = T.trims.get(BRO.target);
    if (!t) { msg.textContent = "Choose where to save it."; return; }
    trimId = t.id; series = t.series;
  }
  if (!rows.length && !items.length) { msg.textContent = "Tick what's right first."; return; }
  const noCode = rows.find(x => FO_BRO.CODE_KINDS.includes(x.kind) && !String(x.code || "").trim());
  if (noCode) { msg.textContent = `“${noCode.value}” needs its code.`; return; }
  rows.forEach(x => { const id = uuid();
    items.push({ id, kind: "fact", data: Object.assign({ op: "put", id, trim_id: trimId, model: BRO.model, series, kind: x.kind,
      label: String(x.label || "").trim(), value: String(x.value).trim(), code: String(x.code || "").trim() }, src) }); });
  await outboxAdd(items);
  LS.set("bro.target." + m.sha, trimId || "series");
  if (series) LS.set("bro.series." + BRO.model, series);
  BRO.rows = BRO.rows.filter(x => !rows.includes(x));
  BRO.target = trimId || "series";
  toast(rows.length ? `Saved ${rows.length} to ${trimId ? trimName(trimData().trims.get(trimId)) : "every " + (series || modelName(BRO.model))}` : "Trim saved");
  render(true); sync(false);
}
async function broDraw(m, page) {
  const box = $("bcanvas"), msg = $("bmsg");
  if (!box) return;
  const V = BRO.view;
  try {
    if (V.sha !== m.sha || !V.doc) {
      if (V.task) { try { V.task.destroy(); } catch (e) {} }
      Object.assign(V, { sha: m.sha, doc: null, task: null });
      msg.textContent = "Opening…";
      const lib = await pdfjs(), token = LS.get("token");
      V.task = lib.getDocument({ url: manUrl(m.sha), httpHeaders: token ? { Authorization: "Bearer " + token } : {},
        rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" });
      V.doc = await V.task.promise;
    }
    const pg = await V.doc.getPage(Math.min(page, V.doc.numPages)), base = pg.getViewport({ scale: 1 });
    if (!$("bcanvas") || BRO.page !== page) return;
    const css = Math.min(box.clientWidth || 600, 1000), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = pg.getViewport({ scale: css / base.width * dpr }), c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = css + "px"; c.style.height = Math.round(css * vp.height / vp.width) + "px";
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (!$("bcanvas") || BRO.page !== page) return;
    box.innerHTML = ""; box.appendChild(c); msg.textContent = "";
  } catch (e) {
    V.sha = null;
    if (msg) msg.innerHTML = `<span class="bad">Couldn't show the page.</span> ${navigator.onLine === false || /fetch|network/i.test(String(e && e.message))
      ? "It isn't on this phone and the laptop can't be reached. Its text is still here to read and tick." : esc(String(e && e.message || e))}`;
  }
}

self.FO_BROWSE_APP = { trimData, broSetup, BRO, dropRecord };   // tests
