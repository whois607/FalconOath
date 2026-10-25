/* FalconOath - fault code lookup over the data copy.

   Pure functions, no DOM: the app uses them in the browser, and
   tests/js_check.js runs them under node. Written once, here; the laptop
   has no second copy in Python.

   index(snap)            -> an index object built once per snapshot
   search(ix, q, model)   -> [{code, rows, how}] best first
   lookup(ix, code, model)-> {code, rows, others, viaModel, fallback}
   model codes: "ALL", "BA", "BF", "FG", "FGX" (FG X uses FG's rows) */
(function (root) {
  "use strict";
  const CODE_RE = /^([PBCU])([0-9A-F]{4})$/;

  function index(snap) {
    const cols = snap.dtc_cols, at = {};
    cols.forEach((c, i) => { at[c] = i; });
    const rows = snap.dtc.map((r, i) => {
      const o = { i };
      cols.forEach(c => { o[c] = r[at[c]] == null ? "" : String(r[at[c]]); });
      o.text = [o.description, o.mechanical, o.sensor, o.electrical, o.other].join("\n").toLowerCase();
      o.desc = o.description.toLowerCase();
      return o;
    });
    const byCode = new Map();
    rows.forEach(r => { if (!byCode.has(r.code)) byCode.set(r.code, []); byCode.get(r.code).push(r); });
    const models = snap.models.map(m => ({ code: m[0], name: m[1], from: m[2], to: m[3], dtc: m[4] }));
    const byModel = {};
    models.forEach(m => { byModel[m.code] = m; });
    return { snap, rows, byCode, codes: Array.from(byCode.keys()).sort(), models, byModel };
  }

  /* the model whose rows a chosen model reads: FGX -> FG; ALL -> null */
  function dtcModel(ix, model) {
    if (!model || model === "ALL") return null;
    const m = ix.byModel[model];
    return m ? m.dtc : model;
  }

  function rowsFor(ix, code, model) {
    const all = ix.byCode.get(code) || [], dm = dtcModel(ix, model);
    return dm ? all.filter(r => r.model === dm) : all;
  }

  /* "p325" -> "P0325", " P0325 " -> "P0325", "0325" -> null (no letter) */
  function normCode(q) {
    const s = String(q || "").toUpperCase().replace(/[\s-]+/g, "");
    const m = /^([PBCU])([0-9A-F]{1,4})$/.exec(s);
    return m ? m[1] + m[2].padStart(4, "0") : null;
  }

  function search(ix, q, model, limit) {
    limit = limit || 80;
    const raw = String(q || "").trim();
    if (!raw) return [];
    const s = raw.toUpperCase().replace(/[\s-]+/g, "");
    const out = [], seen = new Set();
    const add = (code, how) => {
      if (seen.has(code)) return;
      const rows = rowsFor(ix, code, model);
      if (!rows.length) return;
      seen.add(code); out.push({ code, rows, how });
    };
    const looksCode = /^[PBCU]?[0-9A-F]{1,5}$/.test(s) && /[0-9]/.test(s);
    if (looksCode) {
      const full = normCode(s);
      if (full) add(full, "exact");
      if (/^[PBCU]/.test(s)) ix.codes.forEach(c => { if (c.startsWith(s)) add(c, "starts"); });
      else {
        const p = s.padStart(4, "0");
        ix.codes.forEach(c => { if (c.slice(1) === p) add(c, "exact"); });
        ix.codes.forEach(c => { if (c.slice(1).startsWith(s)) add(c, "starts"); });
      }
      ix.codes.forEach(c => { if (c.includes(s)) add(c, "contains"); });
    }
    const words = raw.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (words.length && !(looksCode && out.length)) {
      const hits = [];
      ix.rows.forEach(r => {
        if (!words.every(w => r.text.includes(w))) return;
        hits.push({ code: r.code, score: words.every(w => r.desc.includes(w)) ? 0 : 1 });
      });
      hits.sort((a, b) => a.score - b.score || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      hits.forEach(h => add(h.code, "text"));
    }
    return out.slice(0, limit);
  }

  function lookup(ix, code, model) {
    code = normCode(code) || String(code || "").toUpperCase();
    const all = ix.byCode.get(code) || [], dm = dtcModel(ix, model);
    const rows = dm ? all.filter(r => r.model === dm) : all;
    const others = dm ? all.filter(r => r.model !== dm) : [];
    return { code, rows, others, viaModel: dm,
             fallback: !!(dm && model && dm !== model) };    // e.g. FG X reading FG rows
  }

  /* what the letter means */
  const SYSTEMS = { P: "Powertrain", B: "Body", C: "Chassis", U: "Network" };

  const api = { index, search, lookup, rowsFor, normCode, dtcModel, SYSTEMS, CODE_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FO_DTC = api;
})(typeof self !== "undefined" ? self : this);
