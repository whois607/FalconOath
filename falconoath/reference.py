"""What FalconOath knows built in: data/sources/reference.json.

It is read by hand from your own manuals and brochures (its maker,
data/sources/make_reference.py, sits beside it), so it is Ford content and
lives in data/, never in git. Every trim, fact and spec in it cites a PDF
(its path under manuals/) and a page; a few facts are research notes
instead (`research`: what's known and why it isn't from your manuals),
and the app never treats those as factory.

collect() checks its shape and turns each citation into the PDF's SHA-256
from the library index (read-only), so the app can open the page. A
citation whose PDF has left the library keeps its page with no link.
Nothing here writes anything; a missing or broken file just means no
built-in reference (with the reason).

The app merges it under your own ticked trims and facts (browse.js), so
the factory check, Browse and each car's service sheet work with nothing
ticked.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import db, paths, trims

FORMAT = "falconoath-ref/1"
MODELS = ("BA", "BF", "FG", "FGX")
BODIES = ("", "sedan", "ute", "wagon", "cab chassis")


class Bad(ValueError):
    pass


def _s(v, n: int = 300) -> str:
    return " ".join(str(v or "").split())[:n]


def _shas() -> dict[str, str]:
    """manuals/ path -> SHA-256, from the library index (read-only)."""
    if not paths.LIBRARY.is_file():
        return {}
    c = db.connect_ro(paths.LIBRARY)
    try:
        return {p: s for p, s in c.execute("SELECT path, sha FROM files")}
    finally:
        c.close()


def _src(x: dict, shas: dict) -> dict:
    s = x.get("src")
    if not isinstance(s, dict) or not s.get("doc") or not isinstance(s.get("page"), int) or s["page"] < 1:
        raise Bad("every entry needs a source (doc and page), or a research note")
    return {"doc_sha": shas.get(s["doc"]), "page": s["page"]}


def _model(m) -> str:
    if m not in MODELS:
        raise Bad(f"unknown model {m!r}")
    return m


def collect(path: Path | None = None) -> dict:
    """{"trims", "facts", "specs", "notes", "error"}; empty lists (and the
    reason) if there's no reference or it's broken."""
    path = path or paths.REFERENCE
    empty = {"trims": [], "facts": [], "specs": [], "notes": [], "error": ""}
    if not path.is_file():
        return dict(empty, error="no reference file")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if raw.get("format") != FORMAT:
            raise Bad(f"format {raw.get('format')!r}, expected {FORMAT}")
        return dict(_check(raw, _shas()), error="")
    except (OSError, ValueError, AttributeError, TypeError, KeyError) as e:
        return dict(empty, error=f"{path.name}: {e}")


def _check(raw: dict, shas: dict) -> dict:
    out_t, ids = [], set()
    for t in raw.get("trims") or []:
        tid = "ref:" + _s(t["id"], 60)
        if tid in ids:
            raise Bad(f"trim {tid} twice")
        ids.add(tid)
        body = t.get("body") or ""
        if body not in BODIES:
            raise Bad(f"trim {tid}: body {body!r}")
        out_t.append({"id": tid, "model": _model(t["model"]), "series": _s(t.get("series"), 40), "name": _s(t["name"], 60),
                      "body": body, "years": _s(t.get("years"), 20), "notes": _s(t.get("notes"), 1000),
                      "builtin": True, **_src(t, shas)})
    out_f = []
    for i, f in enumerate(raw.get("facts") or []):
        kind = f.get("kind")
        if kind not in trims.KINDS:
            raise Bad(f"fact {i}: kind {kind!r}")
        trim = ("ref:" + f["trim"]) if f.get("trim") else None
        if trim and trim not in ids:
            raise Bad(f"fact {i}: no trim {trim}")
        code = _s(f.get("code"), 20)
        if kind in trims.CODE_KINDS and not code:
            raise Bad(f"fact {i}: a {kind} needs its code")
        x = {"id": f"ref:f{i}", "model": _model(f["model"]), "series": _s(f.get("series"), 40), "trim_id": trim,
             "kind": kind, "label": _s(f.get("label"), 200), "value": _s(f["value"], 300), "code": code, "builtin": True}
        if f.get("research"):
            x.update(research=_s(f["research"], 600), doc_sha=None, page=None)
        else:
            x.update(_src(f, shas))
        out_f.append(x)
    out_s = []
    for i, s in enumerate(raw.get("specs") or []):
        out_s.append({"id": f"ref:s{i}", "model": _model(s["model"]), "group": _s(s["group"], 60), "label": _s(s["label"], 80),
                      "value": _s(s["value"], 300), "applies": _s(s.get("applies"), 60), **_src(s, shas)})
    out_n = [{"model": _model(n["model"]), "text": _s(n["text"], 600), **_src(n, shas)} for n in raw.get("notes") or []]
    return {"trims": out_t, "facts": out_f, "specs": out_s, "notes": out_n}
