"""Trims and their facts (step 6), as confirmed from your own brochures.

Nothing here is pre-filled: a trim or a fact exists only because you ticked
or typed it on a brochure page in the app, and every row names that
brochure (the PDF's SHA-256) and page. The laptop checks the brochure is in
the library and the page is in it.

Devices send `trim` and `fact` items (apply.py), each with op "put" (add
or change; `id` is the row's id) or "del". A trim made on a device has the
item's own id, so if the laptop already has that trim (same model, series,
name and body, made on another device) the facts sent with it are put on
the one the laptop has. Deleting a trim deletes its facts. Every change is
in change_log, with what it was before.
"""
from __future__ import annotations

import re

from . import db, paths

KINDS = ("engine", "power", "torque", "gearbox", "fuel", "standard", "option", "colour",
         "wheels", "tyres", "dimension", "weight", "towing", "other",
         "paintcode", "trimcode", "bodycode", "modelcode")      # step 7: code tables, from your manuals
CODE_KINDS = KINDS[-4:]
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class Invalid(ValueError):
    pass


def _s(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _row(c, sql: str, args) -> dict | None:
    cur = c.execute(sql, args)
    r = cur.fetchone()
    return dict(zip([x[0] for x in cur.description], r)) if r else None


def library_pages(sha: str) -> int | None:
    """How many pages the brochure with this SHA-256 has, if it's in the
    library (by the index, read-only, and still on disk); else None."""
    if not paths.LIBRARY.is_file():
        return None
    c = db.connect_ro(paths.LIBRARY)
    try:
        d = c.execute("SELECT pages FROM docs WHERE sha = ?", (sha,)).fetchone()
        files = [r[0] for r in c.execute("SELECT path FROM files WHERE sha = ?", (sha,))]
    finally:
        c.close()
    if not d or not any((paths.MANUALS / f).is_file() for f in files):
        return None
    return d[0]


def _source(d: dict, old: dict | None) -> tuple[str, int]:
    """The brochure and page a row cites: in the library, the page in it.
    A row being changed may keep the page it already had, even if that
    brochure has since left the library."""
    sha, page = str(d.get("doc_sha") or ""), d.get("page")
    try:
        page = int(page)
    except (TypeError, ValueError):
        raise Invalid("which page of the brochure?")
    if old and old["doc_sha"] == sha and old["page"] == page:
        return sha, page
    if not SHA_RE.match(sha):
        raise Invalid("every fact needs the brochure it came from")
    n = library_pages(sha)
    if n is None:
        raise Invalid("that brochure isn't in the laptop's library")
    if not 1 <= page <= max(n, 1):
        raise Invalid(f"the brochure has {n} pages, not {page}")
    return sha, page


def _model(c, m) -> str:
    if not c.execute("SELECT 1 FROM models WHERE code = ?", (m,)).fetchone():
        raise Invalid(f"unknown model {m!r}")
    return m


def _id(d: dict) -> str:
    i = d.get("id")
    if not isinstance(i, str) or not ID_RE.match(i):
        raise Invalid("a bad id")
    return i


def put_trim(c, d: dict, origin: str) -> tuple[str, str, str]:
    """Add or change a trim. Returns (result, detail, trim id)."""
    tid = _id(d)
    old = _row(c, "SELECT * FROM trims WHERE id = ?", (tid,))
    v = {"model": _model(c, d.get("model")), "series": _s(d.get("series"), 40), "name": _s(d.get("name"), 60),
         "body": _s(d.get("body"), 30).lower(), "years": _s(d.get("years"), 20),
         "notes": str(d.get("notes") or "").strip()[:1000]}
    if not v["name"]:
        raise Invalid("the trim needs a name")
    v["doc_sha"], v["page"] = _source(d, old)
    same = c.execute("SELECT id FROM trims WHERE model = ? AND series = ? AND lower(name) = lower(?) AND body = ? AND id != ?",
                     (v["model"], v["series"], v["name"], v["body"], tid)).fetchone()
    if same:
        if old:
            raise Invalid("another trim already has that name")
        return "duplicate", "the laptop already has this trim", same[0]
    now = db.now()
    if old:
        c.execute("UPDATE trims SET model=?, series=?, name=?, body=?, years=?, notes=?, doc_sha=?, page=?, updated_at=? "
                  "WHERE id=?", (*v.values(), now, tid))
        if (old["model"], old["series"]) != (v["model"], v["series"]):
            c.execute("UPDATE trim_facts SET model = ?, series = ? WHERE trim_id = ?", (v["model"], v["series"], tid))
        db.log_change(c, "trims", tid, "update", {k: old[k] for k in v}, v, origin)
        return "updated", "", tid
    c.execute("INSERT INTO trims (id, model, series, name, body, years, notes, doc_sha, page, created_at, created_on, "
              "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (tid, *v.values(), now, origin, now))
    db.log_change(c, "trims", tid, "insert", None, v, origin)
    return "applied", "", tid


def trim_for(c, tid: str) -> dict | None:
    """The trim with this id, or the one the laptop kept instead of it (a
    duplicate made on another device)."""
    t = _row(c, "SELECT * FROM trims WHERE id = ?", (tid,))
    if t:
        return t
    r = c.execute("SELECT target_id FROM inbox_applied WHERE item_id = ? AND kind = 'trim' AND result = 'duplicate'",
                  (tid,)).fetchone()
    return _row(c, "SELECT * FROM trims WHERE id = ?", (r[0],)) if r and r[0] else None


def put_fact(c, d: dict, origin: str) -> tuple[str, str, str]:
    """Add or change a fact about a trim (or a whole series)."""
    fid = _id(d)
    old = _row(c, "SELECT * FROM trim_facts WHERE id = ?", (fid,))
    kind = d.get("kind")
    if kind not in KINDS:
        raise Invalid(f"unknown kind of fact {kind!r}")
    trim = None
    if d.get("trim_id"):
        trim = trim_for(c, str(d["trim_id"]))
        if not trim:
            raise Invalid("the trim for this fact isn't on the laptop")
        model, series = trim["model"], trim["series"]
    else:
        model, series = _model(c, d.get("model")), _s(d.get("series"), 40)
    v = {"model": model, "series": series, "trim_id": trim["id"] if trim else None, "kind": kind,
         "label": _s(d.get("label"), 60), "value": _s(d.get("value"), 300), "code": _s(d.get("code"), 20).upper()}
    if not v["value"]:
        raise Invalid("the fact is empty")
    if kind in CODE_KINDS and not v["code"]:
        raise Invalid("a code table entry needs its code")
    v["doc_sha"], v["page"] = _source(d, old)
    now = db.now()
    if old:
        c.execute("UPDATE trim_facts SET model=?, series=?, trim_id=?, kind=?, label=?, value=?, code=?, doc_sha=?, page=?, "
                  "updated_at=? WHERE id=?", (*v.values(), now, fid))
        db.log_change(c, "trim_facts", fid, "update", {k: old[k] for k in v}, v, origin)
        return "updated", "", fid
    same = c.execute("SELECT id FROM trim_facts WHERE trim_id IS ? AND model = ? AND series = ? AND kind = ? AND label = ? "
                     "AND lower(value) = lower(?)", (v["trim_id"], model, series, kind, v["label"], v["value"])).fetchone()
    if same:
        return "duplicate", "the laptop already has this", same[0]
    c.execute("INSERT INTO trim_facts (id, model, series, trim_id, kind, label, value, code, doc_sha, page, created_at, "
              "created_on, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (fid, *v.values(), now, origin, now))
    db.log_change(c, "trim_facts", fid, "insert", None, v, origin)
    return "applied", "", fid


def delete(c, tbl: str, d: dict, origin: str) -> tuple[str, str, str]:
    """Delete a trim (and its facts) or one fact; each row logged whole."""
    rid = _id(d)
    old = _row(c, f"SELECT * FROM {tbl} WHERE id = ?", (rid,))
    if not old:
        return "duplicate", "already gone", rid
    if tbl == "trims":
        if db.schema_version(c) >= 5:            # cars of this trim keep their codes, lose the trim
            for (car,) in c.execute("SELECT id FROM cars WHERE trim_id = ?", (rid,)).fetchall():
                c.execute("UPDATE cars SET trim_id = NULL WHERE id = ?", (car,))
                db.log_change(c, "cars", car, "update", {"trim_id": rid}, {"trim_id": None}, origin)
        for f in c.execute("SELECT * FROM trim_facts WHERE trim_id = ?", (rid,)).fetchall():
            cols = [x[1] for x in c.execute("PRAGMA table_info(trim_facts)")]
            c.execute("DELETE FROM trim_facts WHERE id = ?", (f[0],))
            db.log_change(c, "trim_facts", f[0], "delete", dict(zip(cols, f)), None, origin)
    c.execute(f"DELETE FROM {tbl} WHERE id = ?", (rid,))
    db.log_change(c, tbl, rid, "delete", old, None, origin)
    return "applied", "", rid


def apply_item(c, kind: str, d: dict, origin: str) -> tuple[str, str, str]:
    """One `trim` or `fact` item from a device."""
    op = d.get("op") or "put"
    tbl = "trims" if kind == "trim" else "trim_facts"
    if op == "del":
        return delete(c, tbl, d, origin)
    if op != "put":
        raise Invalid(f"unknown op {op!r}")
    return put_trim(c, d, origin) if kind == "trim" else put_fact(c, d, origin)
