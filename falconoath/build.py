"""Builds the data copy the app downloads: output/phone/snapshot-<v>.json.gz.

Reads falcon.db read-only and writes only under output/phone/:
* the snapshot first, then meta.json (which names it) last, so a phone in
  the middle of a download always gets a whole file;
* the newest two snapshots are kept;
* the version is a hash of the content, the format and this builder's code,
  so a build with nothing changed writes nothing at all.

The app's own files (HTML, JS, CSS) are not part of this: they reach the
phone through the service worker, versioned by their own BUILD stamp.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import time
from pathlib import Path

from . import db, paths

FORMAT = "falconoath-snap/2"
DTC_COLS = ["model", "code", "qualifier", "description", "mechanical", "sensor",
            "electrical", "other"]
KEEP = 2
MAX_APPLIED = 1000      # inbox results sent to devices (each device clears its outbox from them)


def _replace(src: Path, dst: Path, tries: int = 40) -> None:
    """os.replace, retried: Windows refuses it while anything (a reader, or
    OneDrive syncing) holds the target for a moment."""
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.025 * (1 + i // 8))


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    _replace(tmp, path)


def collect(dbpath: Path | None = None) -> dict:
    """Everything the app needs, read in one short read-only visit."""
    c = db.connect_ro(dbpath or paths.DB)
    try:
        models = [list(r) for r in c.execute(
            "SELECT code, name, year_from, year_to, dtc_model FROM models ORDER BY sort")]
        dtc = [list(r) for r in c.execute(
            f"SELECT {', '.join(DTC_COLS)} FROM dtc ORDER BY code, model, id")]
        src = [dict(zip(("file", "sha256", "imported_at", "rows"), r)) for r in c.execute(
            "SELECT file, sha256, imported_at, rows FROM dtc_sources ORDER BY id DESC LIMIT 1")]
        schema = db.schema_version(c)
        cars, scans, applied = [], [], []
        if schema >= 2:
            cars = _dicts(c, "SELECT id, vin, model, year, nickname, kind, notes, created_at, created_on, "
                             "updated_at FROM cars ORDER BY created_at, id")
            scans = _dicts(c, "SELECT id, car_id, file_name, sha256, scanned_on, note, imported_at, origin, "
                              "raw_text AS text FROM scans ORDER BY coalesce(scanned_on, imported_at), id")
            applied = [list(r) for r in c.execute(
                "SELECT item_id, result, detail, target_id FROM inbox_applied "
                "ORDER BY applied_at DESC LIMIT ?", (MAX_APPLIED,))]
    finally:
        c.close()
    return {"models": models, "dtc_cols": DTC_COLS, "dtc": dtc,
            "dtc_source": src[0] if src else None, "schema": schema,
            "cars": cars, "scans": scans, "applied": applied,
            "counts": {"dtc": len(dtc), "codes": len({r[1] for r in dtc}),
                       "models": len(models), "cars": len(cars), "scans": len(scans)}}


def _dicts(c, sql: str) -> list[dict]:
    cur = c.execute(sql)
    cols = [x[0] for x in cur.description]
    return [dict(zip(cols, r)) for r in cur]


def _code_hash() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def version_of(content: dict) -> str:
    h = hashlib.sha256()
    h.update(FORMAT.encode())
    h.update(_code_hash().encode())
    h.update(json.dumps(content, sort_keys=True, ensure_ascii=False,
                        separators=(",", ":")).encode("utf-8"))
    return h.hexdigest()[:16]


def read_meta(out: Path | None = None) -> dict | None:
    try:
        m = json.loads(((out or paths.OUT) / "meta.json").read_text(encoding="utf-8"))
        return m if isinstance(m, dict) and m.get("file") else None
    except (OSError, ValueError):
        return None


def build(out: Path | None = None, force: bool = False) -> dict:
    """Build if anything changed. Returns {"written", "version", "file", ...}."""
    out = out or paths.OUT
    if not paths.DB.is_file():
        raise FileNotFoundError("no falcon.db yet - run: python -m falconoath init")
    content = collect()
    ver = version_of(content)
    meta = read_meta(out)
    if not force and meta and meta.get("version") == ver and (out / meta["file"]).is_file():
        return {"written": False, "version": ver, "file": meta["file"], "counts": meta["counts"]}
    out.mkdir(parents=True, exist_ok=True)
    built = db.now()
    snap = {"format": FORMAT, "version": ver, "built": built, **content}
    raw = json.dumps(snap, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=9, mtime=0)
    name = f"snapshot-{ver}.json.gz"
    _write_atomic(out / name, gz)
    meta = {"format": FORMAT, "version": ver, "built": built, "file": name, "bytes": len(gz),
            "raw_bytes": len(raw), "sha256": hashlib.sha256(gz).hexdigest(),
            "counts": content["counts"]}
    _write_atomic(out / "meta.json", json.dumps(meta, indent=1).encode("utf-8"))
    olds = sorted((p for p in out.glob("snapshot-*.json.gz") if p.name != name),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for p in olds[KEEP - 1:]:
        try:
            p.unlink()
        except OSError:
            pass
    return {"written": True, "version": ver, "file": name, "counts": content["counts"],
            "bytes": len(gz)}
