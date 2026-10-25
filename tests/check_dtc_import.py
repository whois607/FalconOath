"""DTC import: counts, code normalisation, idempotence, source untouched,
backups, and that a failed import changes nothing."""
from tests import _home as T

H = T.home("check_dtc_import")
SRC = T.copy_real_dtc(H)
REAL_BEFORE = T.sha(T.REAL_DTC)

import sqlite3                                     # noqa: E402
from falconoath import db, dtc_import, paths       # noqa: E402

print("normalise")
for raw, want in [("P0355 -", ("P0355", "")), ("P1709KOEO", ("P1709", "KOEO")), ("p0325", ("P0325", "")),
                  (" B1046 ", ("B1046", "")), ("U0073", ("U0073", "")), ("XYZ", ("XYZ", ""))]:
    T.ok(dtc_import.normalise(raw) == want, f"{raw!r} -> {want}", dtc_import.normalise(raw))

print("first import (real dtc.db)")
src_sha = T.sha(SRC)
r = dtc_import.import_dtc()
T.ok(not r["skipped"] and r["added"] == 1195, "1,195 rows imported", r)
T.ok(r["source_unchanged"] and T.sha(SRC) == src_sha, "source file unchanged by the import")
c = db.connect_ro(paths.DB)
per = dict(c.execute("SELECT model, count(*) FROM dtc GROUP BY model").fetchall())
T.ok(per == {"BA": 246, "BF": 397, "FG": 552}, "per model 246/397/552", per)
T.ok(c.execute("SELECT code, code_raw FROM dtc WHERE code_raw = 'P0355 -'").fetchone() == ("P0355", "P0355 -"),
     "'P0355 -' stored as P0355, raw kept")
T.ok(c.execute("SELECT code, qualifier FROM dtc WHERE code_raw = 'P1709KOEO'").fetchone() == ("P1709", "KOEO"),
     "'P1709KOEO' -> P1709 + KOEO")
T.ok(c.execute("SELECT count(*) FROM dtc WHERE model='FG' AND code='U0073'").fetchone()[0] == 2,
     "duplicate FG U0073 rows both kept")
T.ok(c.execute("SELECT count(*) FROM dtc WHERE code NOT GLOB '[PBCU][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'").fetchone()[0] == 0,
     "every code normalised to the standard form")
T.ok(c.execute("SELECT count(*) FROM change_log WHERE tbl='dtc' AND action='import'").fetchone()[0] == 1,
     "the import is in change_log")
T.ok(db.schema_version(c) == db.SCHEMA_VERSION, "schema version recorded")
c.close()
T.ok(len(list(paths.BACKUPS.glob("falcon-*.db"))) >= 1, "a backup was made before writing")

print("second import of the same file")
nb = len(list(paths.BACKUPS.glob("*.db")))
r2 = dtc_import.import_dtc()
T.ok(r2["skipped"] and r2["added"] == 0, "re-run adds nothing", r2)
T.ok(len(list(paths.BACKUPS.glob("*.db"))) == nb, "and makes no backup (nothing written)")

print("a newer source replaces the rows, with a backup")
new = H / "data" / "sources" / "dtc2.db"
s = sqlite3.connect(new)
s.execute("CREATE TABLE dtc (model TEXT, dtc TEXT, description TEXT, mechanical TEXT, sensor TEXT, "
          "electrical TEXT, other TEXT, first_seen TEXT)")
s.executemany("INSERT INTO dtc VALUES (?,?,?,?,?,?,?,?)", [
    ("FG", "P0001", "Synthetic one", "", "", "", "", ""),
    ("BA", "P0002 -", "Synthetic   two", "a  b", "", "", "", ""),
    ("XX", "P0003", "Unknown model", "", "", "", "", "")])
s.commit()
s.close()
r3 = dtc_import.import_dtc(new)
T.ok(r3["added"] == 2 and r3["replaced"] == 1195, "2 rows replace 1,195", r3)
T.ok(r3["unknown_models"] == ["XX"], "rows for unknown models are skipped and reported")
T.ok(r3["backup"] is not None, "backup taken before replacing")
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT description, mechanical FROM dtc WHERE code='P0002'").fetchone() == ("Synthetic two", "a b"),
     "spaces closed up")
log = c.execute("SELECT before FROM change_log WHERE tbl='dtc' ORDER BY id DESC LIMIT 1").fetchone()[0]
T.ok('"rows": 1195' in log, "change_log records what was replaced")
c.close()
bak = db.connect_ro(r3["backup"])
T.ok(bak.execute("SELECT count(*) FROM dtc").fetchone()[0] == 1195, "the backup holds the 1,195 rows")
bak.close()

print("a failing import changes nothing")
before = T.sha(paths.DB)
broken = H / "data" / "sources" / "broken.db"
s = sqlite3.connect(broken)
s.execute("CREATE TABLE unrelated (x)")
s.commit()
s.close()
try:
    dtc_import.import_dtc(broken)
    T.ok(False, "a source without a dtc table is refused")
except sqlite3.OperationalError:
    T.ok(True, "a source without a dtc table is refused")
T.ok(T.sha(paths.DB) == before, "falcon.db unchanged after the refusal")

T.ok(T.sha(T.REAL_DTC) == REAL_BEFORE, "the project's real dtc.db is untouched")
T.done()
