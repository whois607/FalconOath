"""Applies what devices sent (data/inbox/*.json) to falcon.db, and imports
FORScan scans on the laptop directly (python -m falconoath import-scan).

Every item is checked here, on the laptop, whatever the device said:
* a car: a UUID id; VIN (if any) 17 characters with no I, O or Q, and not
  already on another car; a known model or none; a sensible year;
* a scan: a UUID id; text that is a FORScan DTC report (it has
  ===MODULE DTC ...=== blocks), at most 256 KB; a car that exists. Its
  SHA-256 is worked out here; the same report twice is one scan.
* a log: its upload is all there and is a gzipped FORScan live-data CSV
  (livelogs.facts); the same log twice is one log.
* attach: a log or scan moved onto a car (both must exist).
* a manual: its upload (inbox/uploads/<id>.part) is all there (the size the
  device said) and is a PDF; it goes into manuals/<folder>/ under its own
  name, never over another file. A PDF already in the library is a
  duplicate, and the upload is deleted.

One inbox file is one transaction, after a backup, and every change is in
change_log. Each item's result goes in inbox_applied (applied / updated /
duplicate / rejected, with the reason), which the device reads from the
next data copy. A file that can't be read at all is moved to
inbox/rejected/; a processed one to inbox/done/ (kept: it is what the
device sent).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
from datetime import date, datetime
from pathlib import Path

from . import db, inbox, paths

MAX_SCAN = 256 * 1024
VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
BLOCK_RE = re.compile(r"^===(\S+) DTC (.+?)===$", re.M)
KINDS = ("mine", "other", "ad")


class Invalid(ValueError):
    pass


def norm_text(raw: str) -> str:
    """One form for every copy of a report: no BOM, \\n line endings."""
    return raw.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")


def text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def new_id() -> str:
    return str(uuid.uuid4())


def _s(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _models(c) -> set[str]:
    return {r[0] for r in c.execute("SELECT code FROM models")}


def check_car(c, d: dict) -> dict:
    vin = str(d.get("vin") or "").strip().upper().replace(" ", "") or None
    if vin and not VIN_RE.match(vin):
        raise Invalid("the VIN must be 17 letters and numbers (no I, O or Q)")
    model = d.get("model") or None
    if model is not None and model not in _models(c):
        raise Invalid(f"unknown model {model!r}")
    year = d.get("year")
    if year in ("", None):
        year = None
    else:
        try:
            year = int(year)
        except (TypeError, ValueError):
            raise Invalid("the year must be a number")
        if not 1990 <= year <= 2030:
            raise Invalid("the year looks wrong")
    kind = d.get("kind") or "mine"
    if kind not in KINDS:
        raise Invalid("unknown kind of car")
    notes = str(d.get("notes") or "").strip()[:2000]
    return {"vin": vin, "model": model, "year": year, "nickname": _s(d.get("nickname"), 60),
            "kind": kind, "notes": notes}


def check_scan(c, d: dict) -> dict:
    text = d.get("text")
    if not isinstance(text, str) or not text.strip():
        raise Invalid("the scan has no text")
    text = norm_text(text)
    if len(text.encode("utf-8")) > MAX_SCAN:
        raise Invalid("the scan is over 256 KB - is it a FORScan DTC report?")
    if not BLOCK_RE.search(text):
        raise Invalid("this doesn't look like a FORScan DTC report (no ===MODULE DTC ...=== blocks)")
    car = d.get("car_id") or None
    if car is not None and not c.execute("SELECT 1 FROM cars WHERE id = ?", (car,)).fetchone():
        raise Invalid("the car for this scan isn't on the laptop")
    on = d.get("scanned_on") or None
    if on is not None:
        try:
            on = date.fromisoformat(str(on)[:10]).isoformat()
        except ValueError:
            raise Invalid("the scan date isn't a date")
    name = Path(str(d.get("file_name") or "scan.txt")).name
    return {"car_id": car, "file_name": _s(name, 200) or "scan.txt", "text": text,
            "sha256": text_sha(text), "scanned_on": on, "note": str(d.get("note") or "").strip()[:2000]}


def _row(c, sql: str, args) -> dict | None:
    cur = c.execute(sql, args)
    r = cur.fetchone()
    return dict(zip([x[0] for x in cur.description], r)) if r else None


def put_car(c, car_id: str, d: dict, origin: str) -> tuple[str, str]:
    """Insert or update a car. Returns (result, detail)."""
    v = check_car(c, d)
    if v["vin"]:
        other = c.execute("SELECT id, nickname FROM cars WHERE vin = ? AND id != ?",
                          (v["vin"], car_id)).fetchone()
        if other:
            raise Invalid(f"that VIN is already on another car ({other[1] or other[0][:8]})")
    old = _row(c, "SELECT * FROM cars WHERE id = ?", (car_id,))
    now = db.now()
    if old:
        c.execute("UPDATE cars SET vin=?, model=?, year=?, nickname=?, kind=?, notes=?, updated_at=? "
                  "WHERE id=?", (v["vin"], v["model"], v["year"], v["nickname"], v["kind"], v["notes"],
                                 now, car_id))
        db.log_change(c, "cars", car_id, "update", old, v, origin)
        return "updated", ""
    c.execute("INSERT INTO cars (id, vin, model, year, nickname, kind, notes, created_at, created_on, "
              "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (car_id, v["vin"], v["model"], v["year"], v["nickname"], v["kind"], v["notes"], now,
               origin, now))
    db.log_change(c, "cars", car_id, "insert", None, v, origin)
    return "applied", ""


def put_scan(c, scan_id: str, d: dict, origin: str) -> tuple[str, str, str]:
    """Insert a scan, or recognise it. Returns (result, detail, scan id)."""
    v = check_scan(c, d)
    same = _row(c, "SELECT id, car_id, file_name FROM scans WHERE sha256 = ?", (v["sha256"],))
    if same:
        if same["car_id"] is None and v["car_id"]:
            c.execute("UPDATE scans SET car_id = ? WHERE id = ?", (v["car_id"], same["id"]))
            db.log_change(c, "scans", same["id"], "attach", {"car_id": None}, {"car_id": v["car_id"]}, origin)
            return "duplicate", "already on the laptop; now attached to this car", same["id"]
        return "duplicate", f"already on the laptop (as {same['file_name']})", same["id"]
    if c.execute("SELECT 1 FROM scans WHERE id = ?", (scan_id,)).fetchone():
        raise Invalid("a different scan already has this id")
    c.execute("INSERT INTO scans (id, car_id, file_name, sha256, raw_text, scanned_on, note, imported_at, "
              "origin) VALUES (?,?,?,?,?,?,?,?,?)",
              (scan_id, v["car_id"], v["file_name"], v["sha256"], v["text"], v["scanned_on"], v["note"],
               db.now(), origin))
    db.log_change(c, "scans", scan_id, "insert", None,
                  {k: v[k] for k in ("car_id", "file_name", "sha256", "scanned_on", "note")}, origin)
    return "applied", "", scan_id


def _safe_name(name: str) -> str:
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", Path(str(name or "")).stem)
    stem = " ".join(stem.split()).strip(" .")[:120] or "manual"
    return stem + ".pdf"


def _library_has(sha: str) -> str | None:
    """Where a PDF with this SHA-256 already is in manuals/ (by the index,
    read-only), or None."""
    if not paths.LIBRARY.is_file():
        return None
    c = db.connect_ro(paths.LIBRARY)
    try:
        r = c.execute("SELECT path FROM files WHERE sha = ? ORDER BY path", (sha,)).fetchone()
    finally:
        c.close()
    return r[0] if r and (paths.MANUALS / r[0]).is_file() else None


def put_manual(c, item_id: str, d: dict, origin: str) -> tuple[str, str, str]:
    """Move a finished upload into manuals/<folder>/. Returns (result,
    detail, sha256). The PDF is indexed by the listener's next pass."""
    from . import library
    upload = d.get("upload_id")
    try:
        part = inbox.upload_path(upload)
    except inbox.Refused:
        raise Invalid("the upload id is wrong")
    folder = d.get("folder") or "General"
    if folder not in paths.MANUAL_FOLDERS:
        raise Invalid(f"unknown folder {folder!r}")
    if not part.is_file():
        raise Invalid("the PDF didn't arrive on the laptop - add it again")
    size = part.stat().st_size
    if size != d.get("size"):
        raise Invalid(f"only {size} of {d.get('size')} bytes arrived - add it again")
    with open(part, "rb") as f:
        if f.read(5) != b"%PDF-":
            raise Invalid("that isn't a PDF")
    sha = library.file_sha(part)
    there = _library_has(sha)
    if there:
        part.unlink(missing_ok=True)
        return "duplicate", f"already in the library (as {there})", sha
    dest_dir = library.ensure_folders() / folder
    name = _safe_name(d.get("file_name"))
    dest, i = dest_dir / name, 2
    while dest.exists():
        dest, i = dest_dir / f"{name[:-4]} ({i}).pdf", i + 1
    shutil.move(str(part), str(dest))
    rel = dest.relative_to(paths.MANUALS).as_posix()
    db.log_change(c, "manuals", sha, "add", None, {"path": rel, "size": size}, origin)
    return "applied", rel, sha


def put_log_upload(c, item_id: str, d: dict, origin: str) -> tuple[str, str, str]:
    """A gzipped CSV sent in pieces, into falcon.db. Returns (result, detail, log id)."""
    import gzip
    from . import livelogs
    try:
        part = inbox.upload_path(d.get("upload_id"))
    except inbox.Refused:
        raise Invalid("the upload id is wrong")
    if not part.is_file():
        raise Invalid("the log didn't arrive on the laptop - add it again")
    size = part.stat().st_size
    if size != d.get("size"):
        raise Invalid(f"only {size} of {d.get('size')} bytes arrived - add it again")
    try:
        with gzip.open(part, "rb") as f:
            raw = f.read(livelogs.MAX_CSV + 1)
    except (OSError, EOFError):
        raise Invalid("the log arrived damaged - add it again")
    try:
        res = livelogs.put_log(c, item_id, raw.decode("utf-8", errors="replace"), d.get("file_name"),
                               d.get("car_id") or None, origin, d.get("recorded_on"), d.get("note", ""))
    except livelogs.Invalid as e:
        raise Invalid(str(e))
    part.unlink(missing_ok=True)
    return res


def attach(c, d: dict, origin: str) -> tuple[str, str, str]:
    """Put a log or a scan on a car (or another car)."""
    tbl = {"log": "logs", "scan": "scans"}.get(d.get("what"))
    if tbl is None:
        raise Invalid("attach what?")
    row = c.execute(f"SELECT car_id FROM {tbl} WHERE id = ?", (d.get("id"),)).fetchone()
    if not row:
        raise Invalid(f"that {d.get('what')} isn't on the laptop")
    car = d.get("car_id") or None
    if car is None or not c.execute("SELECT 1 FROM cars WHERE id = ?", (car,)).fetchone():
        raise Invalid("that car isn't on the laptop")
    if row[0] == car:
        return "duplicate", "already on that car", d["id"]
    c.execute(f"UPDATE {tbl} SET car_id = ? WHERE id = ?", (car, d["id"]))
    db.log_change(c, tbl, d["id"], "attach", {"car_id": row[0]}, {"car_id": car}, origin)
    return "applied", "", d["id"]


def _move(f: Path, where: str) -> None:
    dst = inbox.INBOX / where
    dst.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(f), str(dst / f.name))
    except OSError:
        pass


def apply_file(f: Path) -> dict:
    """One inbox file, in one transaction. Returns {"file", "results": [...]}."""
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
        dev = doc["device"]
        items = inbox.check_shape(doc)
    except (OSError, ValueError, KeyError, TypeError) as e:
        _move(f, "rejected")
        return {"file": f.name, "error": f"unreadable: {e}", "results": []}
    origin = f"phone:{_s(dev.get('name'), 40) or dev.get('id')}"
    results = []
    # cars first, so a scan or log can name a car made in the same batch; attaching last
    order = sorted(items, key=lambda it: {"car": 0, "attach": 2}.get(it["kind"], 1))
    try:
        bak = _apply_items(doc, dev, order, origin, results)
    except Exception as e:                  # rolled back whole; kept aside, never retried blindly
        _move(f, "failed")
        return {"file": f.name, "error": f"not applied ({type(e).__name__}: {e})", "results": []}
    _move(f, "done")
    return {"file": f.name, "results": results, "backup": bak.name if bak else None}


def _apply_items(doc: dict, dev: dict, order: list[dict], origin: str, results: list) -> Path | None:
    with db.writing("inbox") as (c, bak):
        for it in order:
            if c.execute("SELECT 1 FROM inbox_applied WHERE item_id = ?", (it["id"],)).fetchone():
                results.append({"id": it["id"], "kind": it["kind"], "result": "skipped", "detail": "already applied"})
                continue
            target = it["id"]
            try:
                if it["kind"] == "car":
                    res, detail = put_car(c, it["id"], it["data"], origin)
                elif it["kind"] == "manual":
                    res, detail, target = put_manual(c, it["id"], it["data"], origin)
                elif it["kind"] == "log":
                    res, detail, target = put_log_upload(c, it["id"], it["data"], origin)
                elif it["kind"] == "attach":
                    res, detail, target = attach(c, it["data"], origin)
                else:
                    res, detail, target = put_scan(c, it["id"], it["data"], origin)
            except Invalid as e:
                res, detail = "rejected", str(e)
            c.execute("INSERT INTO inbox_applied (item_id, device, kind, received_at, applied_at, result, "
                      "detail, target_id) VALUES (?,?,?,?,?,?,?,?)",
                      (it["id"], str(dev.get("id") or ""), it["kind"], doc.get("received_at"), db.now(),
                       res, detail, target))
            results.append({"id": it["id"], "kind": it["kind"], "result": res, "detail": detail})
    return bak


def apply_pending() -> list[dict]:
    """Every file waiting in the inbox, oldest first."""
    files = inbox.pending()
    if not files:
        return []
    db.init()
    return [apply_file(f) for f in files]


# ------------------------------------------------------------------ laptop imports
def import_scan_file(path: Path, car_id: str | None = None, new_car: dict | None = None,
                     scanned_on: str | None = None, note: str = "") -> dict:
    """A FORScan TXT from this laptop's disk, straight into falcon.db (with
    the same checks as a device's). The file itself is only read."""
    path = Path(path)
    raw = path.read_bytes().decode("utf-8", errors="replace")
    if scanned_on is None:
        scanned_on = datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
    db.init()
    c = db.connect_ro(paths.DB)
    try:
        same = c.execute("SELECT car_id FROM scans WHERE sha256 = ?", (text_sha(norm_text(raw)),)).fetchone()
    finally:
        c.close()
    if same and same[0]:
        new_car = None                       # already on a car: don't make a second one for nothing
    with db.writing("import-scan") as (c, bak):
        if new_car is not None:
            car_id = new_id()
            put_car(c, car_id, new_car, "laptop")
        res, detail, sid = put_scan(c, new_id(), {"text": raw, "file_name": path.name, "car_id": car_id,
                                                  "scanned_on": scanned_on, "note": note}, "laptop")
    return {"result": res, "detail": detail, "scan_id": sid, "car_id": car_id,
            "backup": str(bak) if bak else None}
