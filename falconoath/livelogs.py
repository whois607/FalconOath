"""FORScan live-data logs (step 4): checking, storing, importing, and
watching FORScan's own folder.

A log is FORScan's CSV: `time(ms);NAME(unit);...`, `;`-separated, `-` for
no value. It is kept whole in falcon.db (`logs.csv_gz`), like a scan; the
app reads it (`app/lib/livelog.js` is the only parser). Here we only check
that a file is such a log and work out what's needed to list it: rows,
duration and the PID headers.

Every write goes through db.writing (backup, one transaction, change_log).
The watched folder is only ever read: a CSV there is imported once it has
stopped changing for SETTLE seconds (FORScan may still be writing it), with
no car; the app assigns one later (apply.py, "attach").
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import time
from datetime import date, datetime
from pathlib import Path

from . import cfg, db, paths

MAX_CSV = 100 * 1024 * 1024     # a long session at 30 ms rows is a few MB; this only stops junk
MAX_ROWS = 2_000_000
SETTLE = 10.0                   # seconds a watched file must be unchanged before it's read


class Invalid(ValueError):
    pass


def norm(raw: bytes | str) -> str:
    """One form for every copy of a log: text, no BOM, \\n line endings,
    no blank lines at the end."""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            raw = raw.decode("cp1252")
    t = raw.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return t.rstrip("\n") + "\n"


def facts(text: str) -> dict:
    """rows, duration_ms and pids of a log, or Invalid."""
    if len(text) > MAX_CSV:
        raise Invalid("the log is over 100 MB")
    lines = text.split("\n")
    head = lines[0].split(";")
    if head[0].strip().lower() != "time(ms)" or len(head) < 2:
        raise Invalid("this isn't a FORScan live-data log (it should start with time(ms);...)")
    rows = [ln for ln in lines[1:] if ln.strip()]
    if not rows:
        raise Invalid("the log has no rows")
    if len(rows) > MAX_ROWS:
        raise Invalid("the log has too many rows")
    times = []
    for ln in (rows[0], rows[-1]):
        try:
            times.append(int(float(ln.split(";", 1)[0])))
        except ValueError:
            raise Invalid("a row's time isn't a number")
    return {"rows": len(rows), "duration_ms": max(0, times[1] - times[0]),
            "pids": [h.strip() for h in head[1:]]}


def sha_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def put_log(c, log_id: str, text: str, file_name: str, car_id: str | None, origin: str,
            recorded_on: str | None = None, note: str = "", source: str | None = None) -> tuple[str, str, str]:
    """Insert a log, or recognise it. Returns (result, detail, log id)."""
    text = norm(text)
    f = facts(text)
    sha = sha_of(text)
    same = c.execute("SELECT id, car_id, file_name FROM logs WHERE sha256 = ?", (sha,)).fetchone()
    if same:
        if same[1] is None and car_id:
            c.execute("UPDATE logs SET car_id = ? WHERE id = ?", (car_id, same[0]))
            db.log_change(c, "logs", same[0], "attach", {"car_id": None}, {"car_id": car_id}, origin)
            return "duplicate", "already on the laptop; now attached to this car", same[0]
        return "duplicate", f"already on the laptop (as {same[2]})", same[0]
    if car_id is not None and not c.execute("SELECT 1 FROM cars WHERE id = ?", (car_id,)).fetchone():
        raise Invalid("the car for this log isn't on the laptop")
    if recorded_on:
        try:
            recorded_on = date.fromisoformat(str(recorded_on)[:10]).isoformat()
        except ValueError:
            raise Invalid("the log's date isn't a date")
    if c.execute("SELECT 1 FROM logs WHERE id = ?", (log_id,)).fetchone():
        raise Invalid("a different log already has this id")
    name = " ".join(Path(str(file_name or "log.csv")).name.split())[:200] or "log.csv"
    c.execute("INSERT INTO logs (id, car_id, file_name, sha256, csv_gz, bytes, rows, duration_ms, pids, recorded_on, "
              "note, imported_at, origin, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (log_id, car_id, name, sha, gzip.compress(text.encode("utf-8"), 9, mtime=0), len(text.encode("utf-8")),
               f["rows"], f["duration_ms"], json.dumps(f["pids"], ensure_ascii=False), recorded_on,
               str(note or "").strip()[:2000], db.now(), origin, source))
    db.log_change(c, "logs", log_id, "insert", None,
                  {"car_id": car_id, "file_name": name, "sha256": sha, "rows": f["rows"], "source": source}, origin)
    return "applied", "", log_id


def import_file(path: Path, car_id: str | None = None, new_car: dict | None = None,
                recorded_on: str | None = None, note: str = "") -> dict:
    """A CSV from this laptop's disk (python -m falconoath import-log). The file is only read."""
    from . import apply
    path = Path(path)
    text = norm(path.read_bytes())
    facts(text)                                        # say what's wrong before any backup
    if recorded_on is None:
        recorded_on = datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
    db.init()
    with db.writing("import-log") as (c, bak):
        if new_car is not None:
            car_id = apply.new_id()
            apply.put_car(c, car_id, new_car, "laptop")
        res, detail, lid = put_log(c, apply.new_id(), text, path.name, car_id, "laptop", recorded_on, note)
    return {"result": res, "detail": detail, "log_id": lid, "car_id": car_id, "backup": str(bak) if bak else None}


# ------------------------------------------------------------------ FORScan's folder
def default_folder() -> Path | None:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    for p in (home / "OneDrive" / "Documents" / "FORScan", home / "Documents" / "FORScan"):
        if p.is_dir():
            return p
    return None


def folder() -> Path | None:
    """The folder watched for new logs: the one set with `logs-folder`, else
    FORScan's usual one if it exists; None if turned off or not found."""
    v = cfg.load().get("logs_folder")
    if v == "":
        return None
    if v:
        p = Path(v)
        return p if p.is_dir() else None
    if os.environ.get("FALCONOATH_HOME"):     # tests and scratch copies never pick up the real FORScan folder
        return None
    return default_folder()


def set_folder(value: str | None) -> None:
    """A path, "" to stop watching, or None to go back to FORScan's usual folder."""
    def f(s):
        s["logs_folder"] = value
    cfg.update(f)


def csvs(root: Path) -> list[Path]:
    try:
        return sorted(p for p in root.rglob("*") if p.suffix.lower() == ".csv" and p.is_file())
    except OSError:
        return []


def signature(root: Path | None) -> tuple:
    if root is None:
        return ()
    out = []
    for p in csvs(root):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((str(p), st.st_size, st.st_mtime))
    return tuple(out)


def watch(root: Path | None = None, say=print, now: float | None = None) -> dict:
    """Import every new, settled CSV in the folder. Returns counts."""
    root = root if root is not None else folder()
    n = {"new": 0, "known": 0, "waiting": 0, "skipped": 0}
    if root is None:
        return n
    db.init()
    now = time.time() if now is None else now
    c = db.connect_ro(paths.DB)
    try:
        seen = {r[0]: (r[1], r[2]) for r in c.execute("SELECT path, size, mtime FROM watched")}
        have = {r[0] for r in c.execute("SELECT sha256 FROM logs")}
    finally:
        c.close()
    todo = []
    for p in csvs(root):
        try:
            st = p.stat()
        except OSError:
            continue
        key = str(p)
        if seen.get(key) == (st.st_size, st.st_mtime):
            n["known"] += 1
            continue
        if now - st.st_mtime < SETTLE:
            n["waiting"] += 1                 # FORScan may still be writing it
            continue
        try:
            text = norm(p.read_bytes())
            facts(text)
        except (OSError, Invalid) as e:
            todo.append((key, st, None, None, str(e)))
            continue
        todo.append((key, st, text, sha_of(text), ""))
    if not todo:
        return n
    from . import apply
    with db.writing("forscan-folder") as (c, bak):
        for key, st, text, sha, err in todo:
            if text is not None and sha not in have:
                rec = datetime.fromtimestamp(st.st_mtime).date().isoformat()
                put_log(c, apply.new_id(), text, Path(key).name, None, "forscan-folder", rec, "", key)
                have.add(sha)
                n["new"] += 1
                say(f"  new log from FORScan's folder: {Path(key).name}")
            elif text is None:
                n["skipped"] += 1
                say(f"  not a log, skipped: {Path(key).name} ({err})")
            else:
                n["known"] += 1
            c.execute("INSERT OR REPLACE INTO watched (path, size, mtime, sha256, seen_at) VALUES (?,?,?,?,?)",
                      (key, st.st_size, st.st_mtime, sha, db.now()))
    return n
