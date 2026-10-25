/* FalconOath - the manual library's search (step 3), pure functions.

   The laptop sends every manual's page text (library-<v>.json.gz), so this
   works on the phone with no signal. A page matches when it has every word
   of the query; pages with more hits, the whole phrase, or the words in the
   manual's title come first. Used by the app and by tests/js_check.js. */
(function (root) {
  "use strict";
  const FOLDERS = [["BA", "BA"], ["BF", "BF"], ["FG", "FG"], ["FGX", "FG X"], ["General", "General"]];
  // which folders a model reads: its own, then General. FG X also reads FG's
  // (most FG X workshop procedures are the FG's), like the fault codes.
  const FOR_MODEL = { ALL: null, BA: ["BA", "General"], BF: ["BF", "General"], FG: ["FG", "General"],
                      FGX: ["FGX", "FG", "General"] };
  const MAX_HITS = 300;

  function index(lib) {
    const manuals = (lib && lib.manuals) || [], bySha = new Map(), low = new Map();
    manuals.forEach(m => {
      bySha.set(m.sha, m);
      low.set(m.sha, ((lib.text || {})[m.sha] || []).map(t => String(t || "").toLowerCase()));
    });
    return { lib, manuals, bySha, low, text: (lib && lib.text) || {} };
  }

  /* the words of a query: lower case, at least 2 characters (a fault code
     like p0325 is one word) */
  function terms(q) {
    return Array.from(new Set(String(q || "").toLowerCase().replace(/[^\p{L}\p{N}\s.\-\/]/gu, " ")
      .replace(/(\p{L})-(?=\p{L})/gu, "$1 ")                        // knock-sensor = knock sensor; 303-14 and A/C stay
      .split(/\s+/).map(w => w.replace(/^[.\-\/]+|[.\-\/]+$/g, "")).filter(w => w.length >= 2)));
  }

  function count(hay, w) {
    let n = 0, i = hay.indexOf(w);
    while (i >= 0 && n < 50) { n++; i = hay.indexOf(w, i + w.length); }
    return n;
  }

  /* opts: model (ALL, BA, ...), sha (one manual only), limit. Returns
     [{sha, page (1-based), score}] best first. */
  function search(L, q, opts) {
    opts = opts || {};
    const ws = terms(q);
    if (!L || !ws.length) return [];
    const phrase = ws.length > 1 ? ws.join(" ") : null, folders = FOR_MODEL[opts.model || "ALL"] || null;
    const hits = [];
    for (const m of L.manuals) {
      if (opts.sha && m.sha !== opts.sha) continue;
      if (folders && !folders.includes(m.folder)) continue;
      const title = m.title.toLowerCase(), pages = L.low.get(m.sha) || [];
      const tb = ws.filter(w => title.includes(w)).length;
      for (let i = 0; i < pages.length; i++) {
        const t = pages[i];
        if (!t) continue;
        let s = 0, all = true;
        for (const w of ws) { const c = count(t, w); if (!c) { all = false; break; } s += Math.min(c, 10); }
        if (!all) continue;
        if (phrase && t.includes(phrase)) s += 20;
        hits.push({ sha: m.sha, page: i + 1, score: s + tb * 2 });
      }
    }
    hits.sort((a, b) => b.score - a.score || L.manuals.indexOf(L.bySha.get(a.sha)) - L.manuals.indexOf(L.bySha.get(b.sha)) || a.page - b.page);
    return hits.slice(0, opts.limit || MAX_HITS);
  }

  /* about `width` characters of the page around the first match, as
     [text, isMatch] pieces (the caller escapes and marks them) */
  function snippet(text, q, width) {
    const t = String(text || "").replace(/\s+/g, " "), ws = terms(q);
    width = width || 180;
    const lowt = t.toLowerCase();
    let at = -1;
    for (const w of ws) { const i = lowt.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
    let a = Math.max(0, at - Math.floor(width / 3)), b = Math.min(t.length, a + width);
    if (at < 0) { a = 0; b = Math.min(t.length, width); }
    const part = t.slice(a, b);
    if (!ws.length) return [[(a ? "…" : "") + part + (b < t.length ? "…" : ""), false]];
    const re = new RegExp("(" + ws.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
    const out = part.split(re).map((x, i) => [x, i % 2 === 1]).filter(x => x[0]);
    if (a) out.unshift(["…", false]);
    if (b < t.length) out.push(["…", false]);
    return out;
  }

  /* the pages of one manual that match, in page order (for the viewer) */
  function pagesWith(L, sha, q) {
    return search(L, q, { sha, limit: 1000 }).map(h => h.page).sort((a, b) => a - b);
  }

  const api = { FOLDERS, FOR_MODEL, index, terms, search, snippet, pagesWith };
  root.FO_MAN = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
