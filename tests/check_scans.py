"""Step 2 on the laptop: schema 2 on an existing step-1 database, FORScan
imports, and the inbox (what devices send) applied safely: checks, results,
duplicates, resends, refusals, failures rolled back, and all of it in the
data copy."""
import gzip
import json
import shutil
import sqlite3
import uuid

from tests import _home as T

H = T.home("check_scans")
T.copy_real_dtc(H)
FIX = T.ROOT / "tests" / "fixtures" / "forscan_fixture.txt"
SAMPLES = T.ROOT / "samples" / "forscan"

from falconoath import apply, build, db, dtc_import, inbox, paths    # noqa: E402

print("schema 2 on a step-1 database")
# a step-1 database: only migration 1
real_migs = db.MIGRATIONS[:]
db.MIGRATIONS[:] = real_migs[:1]
dtc_import.import_dtc()
db.MIGRATIONS[:] = real_migs
c = db.connect_ro(paths.DB)
T.ok(db.schema_version(c) == 1, "starts at schema 1")
c.close()
r = db.init()
T.ok(r["from"] == 1 and r["to"] == 2 and r["backup"], "migrated 1 -> 2 with a backup first", r)
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT count(*) FROM dtc").fetchone()[0] == 1195, "DTC rows untouched by the migration")
T.ok({"cars", "scans", "inbox_applied"} <= {x[0] for x in c.execute("SELECT name FROM sqlite_master")}, "new tables")
c.close()

print("laptop import of a FORScan TXT")
src_sha = T.sha(FIX)
r = apply.import_scan_file(FIX, new_car={"nickname": "Fixture FG", "model": "FG", "year": 2010, "kind": "mine"})
T.ok(r["result"] == "applied" and r["car_id"] and r["backup"], "imported onto a new car, after a backup", r)
T.ok(T.sha(FIX) == src_sha, "the TXT file itself is only read")
CAR = r["car_id"]
r2 = apply.import_scan_file(FIX, new_car={"nickname": "Should not exist"})
T.ok(r2["result"] == "duplicate" and r2["scan_id"] == r["scan_id"], "the same report again is the same scan")
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT count(*) FROM cars").fetchone()[0] == 1, "and no second car is made for it")
crlf = H / "crlf.txt"
crlf.write_bytes(b"\xef\xbb\xbf" + FIX.read_bytes().replace(b"\n", b"\r\n"))
c.close()
T.ok(apply.import_scan_file(crlf)["result"] == "duplicate", "a CRLF / BOM copy is still the same report")
try:
    apply.import_scan_file(T.ROOT / "README.md")
    T.ok(False, "a file that isn't a FORScan report is refused")
except apply.Invalid:
    T.ok(True, "a file that isn't a FORScan report is refused")
if SAMPLES.is_dir():
    n = 0
    for f in sorted(SAMPLES.glob("*.txt")):
        n += apply.import_scan_file(f, car_id=CAR)["result"] == "applied"
    T.ok(n == len(list(SAMPLES.glob("*.txt"))), f"all {n} real sample reports import")

print("the inbox: a device's car and scan, applied")
dev = {"id": "d1", "name": "Test phone"}
car2, scan2 = str(uuid.uuid4()), str(uuid.uuid4())
text2 = FIX.read_text(encoding="utf-8").replace("Something odd", "Something else")
inbox.receive(dev, {"items": [
    {"id": scan2, "kind": "scan", "data": {"text": text2, "file_name": "x.txt", "car_id": car2, "scanned_on": "2026-10-01"}},
    {"id": car2, "kind": "car", "data": {"nickname": "Mate's BA", "model": "BA", "year": "2004", "vin": "6fpaaajgsw4x12345", "kind": "other"}},
]})
T.ok(len(inbox.pending()) == 1, "the listener's half wrote one file")
res = apply.apply_pending()
by = {x["id"]: x for x in res[0]["results"]}
T.ok(by[car2]["result"] == "applied" and by[scan2]["result"] == "applied", "car first, then its scan, both applied", res)
T.ok(not inbox.pending() and (inbox.INBOX / "done" / res[0]["file"]).is_file(), "the file moved to inbox/done")
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT vin, year, kind FROM cars WHERE id=?", (car2,)).fetchone() == ("6FPAAAJGSW4X12345", 2004, "other"),
     "VIN upper-cased, year a number")
T.ok(c.execute("SELECT origin FROM scans WHERE id=?", (scan2,)).fetchone()[0] == "phone:Test phone", "origin recorded")
T.ok(c.execute("SELECT count(*) FROM change_log WHERE tbl IN ('cars','scans')").fetchone()[0] >= 4, "changes logged")
c.close()

print("resends, duplicates and refusals")
inbox.receive(dev, {"items": [{"id": scan2, "kind": "scan", "data": {"text": text2, "car_id": car2}}]})
r = apply.apply_pending()[0]["results"][0]
T.ok(r["result"] == "skipped", "a resent item is applied once", r)
dup = str(uuid.uuid4())
inbox.receive(dev, {"items": [{"id": dup, "kind": "scan", "data": {"text": text2, "car_id": CAR}}]})
r = apply.apply_pending()[0]["results"][0]
T.ok(r["result"] == "duplicate", "the same report under a new id -> duplicate", r)
bad = {
    "bad VIN": {"kind": "car", "data": {"vin": "6FPAAAJGOW4X12345"}},
    "VIN on another car": {"kind": "car", "data": {"vin": "6FPAAAJGSW4X12345"}},
    "unknown model": {"kind": "car", "data": {"model": "XR8"}},
    "silly year": {"kind": "car", "data": {"year": 1066}},
    "not a FORScan report": {"kind": "scan", "data": {"text": "time(ms);RPM\n0;800"}},
    "car not on the laptop": {"kind": "scan", "data": {"text": text2 + "\n", "car_id": str(uuid.uuid4())}},
    "too big": {"kind": "scan", "data": {"text": "===A DTC None===\n" + "x" * 300_000}},
    "bad date": {"kind": "scan", "data": {"text": text2.replace("odd", "odder"), "scanned_on": "31/02/2026"}},
}
ids = {}
for label, it in bad.items():
    ids[label] = str(uuid.uuid4())
inbox.receive(dev, {"items": [dict(it, id=ids[label]) for label, it in bad.items()]})
res = {x["id"]: x for x in apply.apply_pending()[0]["results"]}
for label in bad:
    T.ok(res[ids[label]]["result"] == "rejected" and res[ids[label]]["detail"], f"refused: {label}", res[ids[label]])
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT count(*) FROM inbox_applied WHERE result='rejected'").fetchone()[0] == len(bad),
     "every refusal recorded with its reason")
c.close()

print("the listener's checks")
for label, body in [("no items", {}), ("not a list", {"items": "x"}), ("bad id", {"items": [{"id": "1", "kind": "car", "data": {}}]}),
                    ("bad kind", {"items": [{"id": str(uuid.uuid4()), "kind": "log", "data": {}}]}),
                    ("too many", {"items": [{"id": str(uuid.uuid4()), "kind": "car", "data": {}}] * 51})]:
    try:
        inbox.receive(dev, body)
        T.ok(False, f"refused at the door: {label}")
    except inbox.Refused:
        T.ok(True, f"refused at the door: {label}")
T.ok(not inbox.pending(), "and nothing written for them")

print("files that can't be applied")
(inbox.INBOX / "zz-broken.json").write_text("{not json", encoding="utf-8")
r = apply.apply_pending()
T.ok(r[0].get("error") and (inbox.INBOX / "rejected" / "zz-broken.json").is_file(), "unreadable -> inbox/rejected")
before = T.sha(paths.DB)
inbox.receive(dev, {"items": [{"id": str(uuid.uuid4()), "kind": "car", "data": {"nickname": "boom"}}]})
orig = apply.put_car
apply.put_car = lambda *a: (_ for _ in ()).throw(sqlite3.OperationalError("disk I/O error (simulated)"))
r = apply.apply_pending()
apply.put_car = orig
T.ok(r[0].get("error") and list((inbox.INBOX / "failed").glob("*.json")), "a failure mid-file -> inbox/failed")
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT count(*) FROM cars WHERE nickname='boom'").fetchone()[0] == 0, "and nothing of it in falcon.db")
c.close()

print("the data copy")
b = build.build()
snap = json.loads(gzip.decompress((paths.OUT / b["file"]).read_bytes()))
c = db.connect_ro(paths.DB)
nc, ns = c.execute("SELECT count(*) FROM cars").fetchone()[0], c.execute("SELECT count(*) FROM scans").fetchone()[0]
c.close()
T.ok(snap["format"] == "falconoath-snap/2" and len(snap["cars"]) == nc == snap["counts"]["cars"], "cars in the copy")
T.ok(len(snap["scans"]) == ns == snap["counts"]["scans"] and all(s["text"] for s in snap["scans"]), "scans with their text")
T.ok(any(a[0] == scan2 and a[1] == "applied" for a in snap["applied"]), "inbox results in the copy")
shutil.rmtree(H / "output", ignore_errors=True)
T.done()
