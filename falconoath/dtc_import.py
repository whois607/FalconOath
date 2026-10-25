"""data/sources/dtc.db -> falcon.db's dtc table.

The source is opened read-only and never changed. An import is keyed by the
source file's SHA-256: the same file twice adds nothing. A different file
(a newer dtc.db) replaces the DTC rows as a whole, after the usual backup,
and change_log records how many rows each source had, so it can be undone
from the backup.

Codes are normalised for lookup and kept as found:
    'P0355 -'    -> code P0355
    'P1709KOEO'  -> code P1709, qualifier KOEO (Key On Engine Off test)
Rows with the same code for the same model are kept apart: they are
different explanations, and the app shows them all.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from . import db, paths

CODE_RE = re.compile(r"^([PBCU][0-9A-F]{4})(.*)$")
FIELDS = ("description", "mechanical", "sensor", "electrical", "other")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalise(raw: str) -> tuple[str, str]:
    """(code, qualifier) from a source code string."""
    s = " ".join(str(raw or "").upper().split())
    m = CODE_RE.match(s.replace(" ", ""))
    if not m:
        return s, ""
    qual = re.sub(r"[^A-Z0-9]+", " ", m.group(2)).strip()
    return m.group(1), qual


def clean(text) -> str:
    """Trimmed, with runs of spaces closed up. Line breaks are kept."""
    lines = [" ".join(line.split()) for line in str(text or "").splitlines()]
    return "\n".join(line for line in lines if line).strip()


def read_source(src: Path) -> list[dict]:
    c = db.connect_ro(src)
    try:
        rows = c.execute("SELECT model, dtc, description, mechanical, sensor, electrical, other "
                         "FROM dtc ORDER BY model, dtc").fetchall()
    finally:
        c.close()
    out = []
    for model, raw, *texts in rows:
        code, qual = normalise(raw)
        out.append({"model": str(model or "").strip().upper(), "code": code,
                    "code_raw": str(raw or "").strip(), "qualifier": qual,
                    **{k: clean(v) for k, v in zip(FIELDS, texts)}})
    return out


def import_dtc(src: Path | None = None) -> dict:
    """Import (or skip) the source. Returns a summary dict."""
    src = Path(src or paths.DTC_SOURCE)
    if not src.is_file():
        raise FileNotFoundError(f"no DTC source at {src}")
    db.init()
    sha = file_sha256(src)
    c = db.connect_ro(paths.DB)
    try:
        seen = c.execute("SELECT id, imported_at FROM dtc_sources WHERE sha256 = ?", (sha,)).fetchone()
        models = {r[0] for r in c.execute("SELECT dtc_model FROM models")}
        before = c.execute("SELECT count(*) FROM dtc").fetchone()[0]
    finally:
        c.close()
    if seen:
        return {"ok": True, "skipped": True, "reason": f"already imported on {seen[1]}",
                "rows": before, "added": 0, "backup": None}
    rows = read_source(src)
    bad = [r for r in rows if r["model"] not in models]
    rows = [r for r in rows if r["model"] in models]
    with db.writing("import-dtc") as (c, bak):
        old = c.execute("SELECT s.id, s.file, s.sha256, count(d.id) FROM dtc_sources s "
                        "LEFT JOIN dtc d ON d.source_id = s.id GROUP BY s.id").fetchall()
        c.execute("DELETE FROM dtc")
        sid = c.execute("INSERT INTO dtc_sources (file, sha256, imported_at, rows) "
                        "VALUES (?, ?, ?, 0)", (src.name, sha, db.now())).lastrowid
        added = 0
        for r in rows:
            cur = c.execute(
                "INSERT OR IGNORE INTO dtc (model, code, code_raw, qualifier, description, "
                "mechanical, sensor, electrical, other, source_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (r["model"], r["code"], r["code_raw"], r["qualifier"],
                 *(r[k] for k in FIELDS), sid))
            added += cur.rowcount
        c.execute("UPDATE dtc_sources SET rows = ? WHERE id = ?", (added, sid))
        db.log_change(c, "dtc", None, "import",
                      before={"rows": before, "sources": [
                          {"id": o[0], "file": o[1], "sha256": o[2], "rows": o[3]} for o in old]},
                      after={"rows": added, "source_id": sid, "file": src.name, "sha256": sha,
                             "backup": bak.name if bak else None})
    return {"ok": True, "skipped": False, "rows": added, "added": added, "replaced": before,
            "unknown_models": sorted({r["model"] for r in bad}),
            "source_unchanged": file_sha256(src) == sha,
            "backup": str(bak) if bak else None}
