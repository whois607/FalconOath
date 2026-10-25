"""data/falcon.db: the one database FalconOath writes.

Rules (CLAUDE.md, "data safety above everything"):
* every write goes through `writing()`: a backup first (SQLite backup API,
  newest KEEP_BACKUPS kept), then one transaction, committed whole or not at
  all;
* each write records what it did in change_log;
* sources (dtc.db, later PDFs, FORScan files, VPA's vpa.db) are only ever
  opened with `connect_ro`.

The schema grows by numbered migrations; each step of PLAN.md adds its own.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from . import paths

KEEP_BACKUPS = 10

MIGRATIONS: list[tuple[int, str]] = [
    (1, """
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE models (
        code TEXT PRIMARY KEY,          -- BA, BF, FG, FGX
        name TEXT NOT NULL,             -- shown: BA, BF, FG, FG X
        year_from INTEGER, year_to INTEGER,
        dtc_model TEXT NOT NULL,        -- whose DTC rows it uses (FGX -> FG)
        sort INTEGER NOT NULL
    );
    CREATE TABLE dtc_sources (
        id INTEGER PRIMARY KEY,
        file TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL, rows INTEGER NOT NULL
    );
    CREATE TABLE dtc (
        id INTEGER PRIMARY KEY,
        model TEXT NOT NULL REFERENCES models(code),
        code TEXT NOT NULL,             -- normalised: P0355
        code_raw TEXT NOT NULL,         -- as in the source: 'P0355 -'
        qualifier TEXT NOT NULL DEFAULT '',   -- e.g. KOEO
        description TEXT NOT NULL DEFAULT '',
        mechanical TEXT NOT NULL DEFAULT '', sensor TEXT NOT NULL DEFAULT '',
        electrical TEXT NOT NULL DEFAULT '', other TEXT NOT NULL DEFAULT '',
        source_id INTEGER NOT NULL REFERENCES dtc_sources(id),
        UNIQUE (model, code_raw, description, mechanical, sensor, electrical, other)
    );
    CREATE INDEX dtc_code ON dtc (code, model);
    CREATE TABLE change_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL, origin TEXT NOT NULL,     -- laptop | phone:<device>
        tbl TEXT NOT NULL, row_id TEXT, action TEXT NOT NULL,
        before TEXT, after TEXT                     -- JSON
    );
    INSERT INTO models VALUES
        ('BA', 'BA', 2002, 2005, 'BA', 1),
        ('BF', 'BF', 2005, 2008, 'BF', 2),
        ('FG', 'FG', 2008, 2014, 'FG', 3),
        ('FGX', 'FG X', 2014, 2016, 'FG', 4);
    """),
    (2, """
    -- step 2: the car is the central record; scans attach to it.
    -- ids are UUIDs made on whichever device created the row, so a phone
    -- can create a car offline and its id never collides.
    CREATE TABLE cars (
        id TEXT PRIMARY KEY,
        vin TEXT UNIQUE,                -- optional; NULLs don't clash
        model TEXT REFERENCES models(code),   -- NULL = not sure
        year INTEGER,
        nickname TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'mine' CHECK (kind IN ('mine', 'other', 'ad')),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, created_on TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    -- a FORScan DTC report, kept whole (line endings normalised). The app
    -- parses it when it shows it; nothing here is derived, so a better
    -- parser later improves every old scan for free.
    CREATE TABLE scans (
        id TEXT PRIMARY KEY,
        car_id TEXT REFERENCES cars(id),
        file_name TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,    -- of raw_text, worked out on the laptop
        raw_text TEXT NOT NULL,
        scanned_on TEXT,                -- YYYY-MM-DD, as given at upload
        note TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL, origin TEXT NOT NULL
    );
    CREATE INDEX scans_car ON scans (car_id);
    -- what became of each item a device sent: the device clears its outbox
    -- from this (it comes down in the data copy), and a resent item is
    -- recognised and not applied twice.
    CREATE TABLE inbox_applied (
        item_id TEXT PRIMARY KEY,
        device TEXT NOT NULL, kind TEXT NOT NULL,
        received_at TEXT, applied_at TEXT NOT NULL,
        result TEXT NOT NULL,           -- applied | updated | duplicate | rejected
        detail TEXT NOT NULL DEFAULT '', target_id TEXT
    );
    """),
    (3, """
    -- step 4: FORScan live-data logs (CSV), kept whole like scans: the CSV
    -- with line endings normalised, gzipped. The app reads it (lib/livelog.js);
    -- only the facts needed to list a log are kept beside it.
    CREATE TABLE logs (
        id TEXT PRIMARY KEY,
        car_id TEXT REFERENCES cars(id),    -- NULL until a car is chosen
        file_name TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,        -- of the normalised CSV text
        csv_gz BLOB NOT NULL,
        bytes INTEGER NOT NULL,             -- of the CSV text
        rows INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        pids TEXT NOT NULL,                 -- JSON: the column headers after time(ms)
        recorded_on TEXT,                   -- YYYY-MM-DD
        note TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        origin TEXT NOT NULL,               -- laptop | phone:<device> | forscan-folder
        source TEXT                         -- the watched file it came from, if any
    );
    CREATE INDEX logs_car ON logs (car_id);
    -- files seen in the watched FORScan folder, so each is read once
    CREATE TABLE watched (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL,
        sha256 TEXT, seen_at TEXT NOT NULL
    );
    """),
    (4, """
    -- step 6: trims and their facts, only as confirmed from your own
    -- brochures: every row names the brochure (SHA-256 of the PDF) and page.
    CREATE TABLE trims (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL REFERENCES models(code),
        series TEXT NOT NULL DEFAULT '',     -- e.g. FG MkII; '' = not given
        name TEXT NOT NULL,                  -- e.g. XR6 Turbo
        body TEXT NOT NULL DEFAULT '',       -- sedan, ute, wagon, cab chassis
        years TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        doc_sha TEXT NOT NULL, page INTEGER NOT NULL,
        created_at TEXT NOT NULL, created_on TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX trims_model ON trims (model, series);
    CREATE TABLE trim_facts (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL REFERENCES models(code),
        series TEXT NOT NULL DEFAULT '',
        trim_id TEXT REFERENCES trims(id),   -- NULL = the whole series (e.g. its colours)
        kind TEXT NOT NULL,                  -- engine, power, gearbox, standard, option, colour, ...
        label TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',       -- a paint or option code, when printed (step 7)
        doc_sha TEXT NOT NULL, page INTEGER NOT NULL,
        created_at TEXT NOT NULL, created_on TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX trim_facts_trim ON trim_facts (trim_id);
    CREATE INDEX trim_facts_model ON trim_facts (model, series);
    """),
    (5, """
    -- step 7: the factory checker. A car's trim (from your brochures) and
    -- the codes on its build plate, as read off the car; the app checks
    -- them against the code tables ticked from your manuals.
    ALTER TABLE cars ADD COLUMN trim_id TEXT REFERENCES trims(id);
    ALTER TABLE cars ADD COLUMN paint_code TEXT NOT NULL DEFAULT '';
    ALTER TABLE cars ADD COLUMN trim_code TEXT NOT NULL DEFAULT '';   -- interior trim
    ALTER TABLE cars ADD COLUMN body_code TEXT NOT NULL DEFAULT '';
    ALTER TABLE cars ADD COLUMN model_code TEXT NOT NULL DEFAULT '';
    ALTER TABLE cars ADD COLUMN build_date TEXT NOT NULL DEFAULT '';  -- YYYY-MM
    """),
]
SCHEMA_VERSION = MIGRATIONS[-1][0]


def now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def connect_ro(path: Path) -> sqlite3.Connection:
    """Read-only: SQLite itself refuses every write on this connection.
    Close it as soon as the read is done."""
    return sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True, timeout=15)


def _connect_rw(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(path, timeout=15, isolation_level=None)   # explicit BEGIN only
    c.execute("PRAGMA foreign_keys = ON")
    return c


def schema_version(c: sqlite3.Connection) -> int:
    try:
        r = c.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(r[0]) if r else 0


def backup(reason: str, path: Path | None = None) -> Path | None:
    """A whole copy of falcon.db, through SQLite's backup API (safe while
    anything reads it). None if there is no database yet."""
    path = path or paths.DB
    if not path.is_file():
        return None
    paths.BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    tag = "".join(ch if ch.isalnum() else "-" for ch in reason)[:30]
    dst = paths.BACKUPS / f"falcon-{stamp}-{tag}.db"
    n = 1
    while dst.exists():
        n += 1
        dst = paths.BACKUPS / f"falcon-{stamp}-{tag}-{n}.db"
    src = connect_ro(path)
    try:
        out = sqlite3.connect(dst)
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()
    old = sorted(paths.BACKUPS.glob("falcon-*.db"), key=lambda p: p.stat().st_mtime)
    for p in old[:-KEEP_BACKUPS]:
        try:
            p.unlink()
        except OSError:
            pass
    return dst


@contextmanager
def writing(reason: str, path: Path | None = None):
    """Back up, then one transaction (BEGIN IMMEDIATE): committed if the
    block finishes, rolled back if it raises. Yields (conn, backup_path)."""
    path = path or paths.DB
    bak = backup(reason, path)
    c = _connect_rw(path)
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c, bak
        except BaseException:
            c.execute("ROLLBACK")
            raise
        c.execute("COMMIT")
    finally:
        c.close()


def log_change(c: sqlite3.Connection, tbl: str, row_id, action: str,
               before=None, after=None, origin: str = "laptop") -> None:
    c.execute("INSERT INTO change_log (at, origin, tbl, row_id, action, before, after) "
              "VALUES (?, ?, ?, ?, ?, ?, ?)",
              (now(), origin, tbl, None if row_id is None else str(row_id), action,
               None if before is None else json.dumps(before, ensure_ascii=False),
               None if after is None else json.dumps(after, ensure_ascii=False)))


def init(path: Path | None = None) -> dict:
    """Create falcon.db if missing and apply any migrations it lacks.
    Returns {"created", "from", "to", "backup"}."""
    path = path or paths.DB
    path.parent.mkdir(parents=True, exist_ok=True)
    created = not path.exists()
    if created:
        _connect_rw(path).close()
    c = _connect_rw(path)
    try:
        have = schema_version(c)
    finally:
        c.close()
    todo = [(n, sql) for n, sql in MIGRATIONS if n > have]
    if not todo:
        return {"created": created, "from": have, "to": have, "backup": None}
    with writing(f"migrate-{todo[-1][0]}", path) as (c, bak):
        for n, sql in todo:
            for stmt in _statements(sql):
                c.execute(stmt)
            c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                      (str(n),))
            log_change(c, "meta", "schema_version", "migrate", {"version": n - 1}, {"version": n})
        c.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)", (now(),))
    return {"created": created, "from": have, "to": todo[-1][0], "backup": bak}


def _statements(sql: str) -> list[str]:
    """Split a migration into statements (executescript would commit early)."""
    out, buf = [], ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            s = buf.strip()
            if s and s != ";":
                out.append(s)
            buf = ""
    if buf.strip():
        raise ValueError("incomplete SQL in migration: " + buf[:60])
    return out

