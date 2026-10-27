"""Builds the data copy the app downloads: output/phone/snapshot-<v>.json.gz.

Reads falcon.db read-only and writes only under output/phone/:
* the snapshot first, then meta.json (which names it) last, so a phone in
  the middle of a download always gets a whole file;
* the newest two snapshots are kept;
* the version is a hash of the content, the format and this builder's code,
  so a build with nothing changed writes nothing at all.

The app's own files (HTML, JS, CSS) are not part of this: they reach the
phone through the service worker, versioned by their own BUILD stamp.

Live-data logs (step 4) are listed in the snapshot without their data; each
log's gzipped CSV is written once to output/phone/logs/<sha256>.csv.gz
(before meta.json, so a listed log is always there to fetch), and devices
download the ones they lack. Files of logs no longer listed are removed.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import time
from pathlib import Path

from . import db, paths, reference, vpa_prices

FORMAT = "falconoath-snap/6"      # /3: logs; /4: prices; /5: trims and their facts; /6: the built-in reference
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
        cars, scans, applied, logs = [], [], [], []
        if schema >= 2:
            plate = ", trim_id, paint_code, trim_code, body_code, model_code, build_date" if schema >= 5 else ""
            plate += ", engine_code, trans_code" if schema >= 6 else ""
            cars = _dicts(c, f"SELECT id, vin, model, year, nickname, kind, notes, created_at, created_on, "
                             f"updated_at{plate} FROM cars ORDER BY created_at, id")
            scans = _dicts(c, "SELECT id, car_id, file_name, sha256, scanned_on, note, imported_at, origin, "
                              "raw_text AS text FROM scans ORDER BY coalesce(scanned_on, imported_at), id")
            applied = [list(r) for r in c.execute(
                "SELECT item_id, result, detail, target_id FROM inbox_applied "
                "ORDER BY applied_at DESC LIMIT ?", (MAX_APPLIED,))]
        if schema >= 3:
            logs = _dicts(c, "SELECT id, car_id, file_name, sha256, bytes, rows, duration_ms, pids, recorded_on, note, "
                             "imported_at, origin FROM logs ORDER BY coalesce(recorded_on, imported_at), id")
            for lg in logs:
                lg["pids"] = json.loads(lg["pids"])
        trims, facts = [], []
        if schema >= 4:
            trims = _dicts(c, "SELECT id, model, series, name, body, years, notes, doc_sha, page, created_at, created_on, "
                              "updated_at FROM trims ORDER BY model, series, name, body, id")
            facts = _dicts(c, "SELECT id, model, series, trim_id, kind, label, value, code, doc_sha, page, created_at "
                              "FROM trim_facts ORDER BY model, series, trim_id, kind, created_at, id")
    finally:
        c.close()
    ref = reference.collect()
    return {"models": models, "dtc_cols": DTC_COLS, "dtc": dtc,
            "dtc_source": src[0] if src else None, "schema": schema,
            "cars": cars, "scans": scans, "applied": applied, "logs": logs,
            "prices": vpa_prices.load(),                 # step 5: VPA's asking prices, averaged (None if never read)
            "trims": trims, "facts": facts,              # step 6: from your brochures
            "ref": ref,                                  # built in: read from your manuals (reference.py)
            "counts": {"dtc": len(dtc), "codes": len({r[1] for r in dtc}),
                       "models": len(models), "cars": len(cars), "scans": len(scans), "logs": len(logs),
                       "trims": len(trims), "facts": len(facts),
                       "ref": len(ref["trims"]) + len(ref["facts"]) + len(ref["specs"])}}


def _dicts(c, sql: str) -> list[dict]:
    cur = c.execute(sql)
    cols = [x[0] for x in cur.description]
    return [dict(zip(cols, r)) for r in cur]


def _code_hash() -> str:
    return hashlib.sha256((paths.CODE / "build.py").read_bytes()).hexdigest()      # the source (also for the .exe)


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


def write_logs(out: Path, logs: list[dict]) -> int:
    """Each listed log's gzipped CSV in out/logs/, written once (they never
    change: the name is the content's hash); others removed. Returns how
    many were written."""
    d = out / "logs"
    d.mkdir(parents=True, exist_ok=True)
    want = {lg["sha256"] for lg in logs}
    missing = [sha for sha in want if not (d / f"{sha}.csv.gz").is_file()]
    if missing:
        c = db.connect_ro(paths.DB)
        try:
            for sha in missing:
                r = c.execute("SELECT csv_gz FROM logs WHERE sha256 = ?", (sha,)).fetchone()
                if r:
                    _write_atomic(d / f"{sha}.csv.gz", bytes(r[0]))
        finally:
            c.close()
    for p in d.glob("*.csv.gz"):
        if p.name[:-7] not in want:
            try:
                p.unlink()
            except OSError:
                pass
    return len(missing)


def build(out: Path | None = None, force: bool = False) -> dict:
    """Build if anything changed. Returns {"written", "version", "file", ...}."""
    out = out or paths.OUT
    if not paths.DB.is_file():
        raise FileNotFoundError("no falcon.db yet - run: python -m falconoath init")
    content = collect()
    ver = version_of(content)
    meta = read_meta(out)
    write_logs(out, content["logs"])                 # before meta.json names them
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
