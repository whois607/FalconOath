"""Step 4 on the laptop: live-data logs. Schema 3, checking and importing a
FORScan CSV, the watched FORScan folder (read only, settled files only, no
car), the snapshot listing logs and build writing their files, a log sent
from a device in pieces, and attaching logs and scans to cars. The made-up
fixture only (tests/fixtures/forscan_log_fixture.csv)."""
import gzip
import json
import os
import time
import uuid

from tests import _home as T

H = T.home("check_logs")
T.copy_real_dtc(H)
FIX = T.ROOT / "tests" / "fixtures" / "forscan_log_fixture.csv"
SCAN = T.ROOT / "tests" / "fixtures" / "forscan_fixture.txt"

from falconoath import apply, build, cfg, db, dtc_import, inbox, livelogs, paths  # noqa: E402

dtc_import.import_dtc()
r = db.init()
T.ok(r["to"] >= 3 and db.schema_version(db.connect_ro(paths.DB)) == db.SCHEMA_VERSION, "schema 3 or later (logs, watched)", r)

# ---- checking a file
raw = FIX.read_bytes()
text = livelogs.norm(raw)
T.ok("\r" not in text and text.endswith("\n") and livelogs.norm(b"\xef\xbb\xbf" + raw) == text, "normalised: no CR, no BOM")
f = livelogs.facts(text)
T.ok(f["rows"] == 2001 and f["duration_ms"] == 59940 and f["pids"][4] == "ECT(°C)" and f["pids"][-1] == "CRUISE",
     "rows, duration and PID headers", f)
for bad, why in [("hello;world\n1;2\n", "isn't a FORScan"), ("time(ms);RPM(1/min)\n", "no rows"), ("time(ms);RPM\nx;1\n", "isn't a number")]:
    try:
        livelogs.facts(bad)
        T.ok(False, f"refused: {why}")
    except livelogs.Invalid as e:
        T.ok(why in str(e), f"refused: {why}", e)
T.ok(livelogs.norm("time(ms);ECT(\xb0C)\n0;1\n".encode("cp1252")).startswith("time(ms);ECT(°C)"), "a cp1252 file is read too")

# ---- importing on the laptop
r = livelogs.import_file(FIX, new_car={"nickname": "Test FG", "model": "FG"}, note="cold start")
car = r["car_id"]
T.ok(r["result"] == "applied" and car, "imported, onto a new car", r)
c = db.connect_ro(paths.DB)
row = c.execute("SELECT car_id, rows, duration_ms, pids, recorded_on, origin, csv_gz, bytes, note FROM logs WHERE id = ?", (r["log_id"],)).fetchone()
log_n = c.execute("SELECT count(*) FROM change_log WHERE tbl = 'logs'").fetchone()[0]
c.close()
T.ok(row[0] == car and row[1] == 2001 and json.loads(row[3])[0] == "DSDRPM(1/min)" and row[5] == "laptop" and row[8] == "cold start",
     "stored with its car, rows, PIDs, origin and note")
T.ok(gzip.decompress(row[6]).decode() == text and len(row[6]) < row[7] / 3, f"kept whole, gzipped ({len(row[6]):,} of {row[7]:,} bytes)")
T.ok(log_n == 1 and r["backup"], "logged in change_log, after a backup")
r2 = livelogs.import_file(FIX)
T.ok(r2["result"] == "duplicate" and r2["log_id"] == r["log_id"], "the same log again is one log")

# ---- the watched folder
watched = H / "FORScan"
watched.mkdir()
(watched / "drive.csv").write_bytes(raw.replace(b"78;", b"79;"))        # a different log
(watched / "fresh.csv").write_bytes(raw.replace(b"78;", b"80;"))
(watched / "notalog.csv").write_text("a;b\n1;2\n", encoding="utf-8")
(watched / "notes.txt").write_text("not a csv", encoding="utf-8")                # FORScan keeps other .txt files there
(watched / "DTC report.txt").write_bytes(SCAN.read_bytes())                    # a fault scan FORScan saved
old = time.time() - 60
for n in ("drive.csv", "notalog.csv", "DTC report.txt"):
    os.utime(watched / n, (old, old))
before = {p.name: T.sha(p) for p in watched.iterdir()}
livelogs.set_folder(str(watched))
T.ok(livelogs.folder() == watched, "the folder can be set")
n = livelogs.watch(say=lambda *_: None)
T.ok({k: n[k] for k in ("new", "known", "waiting", "skipped")} == {"new": 2, "known": 0, "waiting": 2, "skipped": 1}
     and sorted(x[0] for x in n["items"]) == ["log", "scan"],
     "a new log and a new fault scan; two still being written are left; a non-log is skipped", n)
T.ok({p.name: T.sha(p) for p in watched.iterdir()} == before, "the watched folder is never changed")
c = db.connect_ro(paths.DB)
w = c.execute("SELECT car_id, origin, source, recorded_on FROM logs WHERE source LIKE '%drive.csv'").fetchone()
s = c.execute("SELECT car_id, origin, file_name, scanned_on, raw_text FROM scans WHERE origin = 'forscan-folder'").fetchone()
c.close()
T.ok(w and w[0] is None and w[1] == "forscan-folder" and w[3] == time.strftime("%Y-%m-%d", time.localtime(old)),
     "it arrives with no car, from forscan-folder, dated by the file", w)
T.ok(s and s[0] is None and s[2] == "DTC report.txt" and s[3] == time.strftime("%Y-%m-%d", time.localtime(old)) and "U0140" in s[4],
     "the fault scan too: no car yet, dated by the file, kept whole", s and s[:4])
n = livelogs.watch(say=lambda *_: None, now=time.time() + 60)
T.ok(n["new"] == 1 and n["skipped"] == 1 and n["known"] == 3 and n["waiting"] == 0,
     "the settled ones are read on a later pass (a .txt that isn't a DTC report is skipped); seen files aren't read again", n)
n = livelogs.watch(say=lambda *_: None, now=time.time() + 60)
T.ok(n == {"new": 0, "known": 5, "waiting": 0, "skipped": 0, "items": []}, "nothing new: nothing read, no backup", n)
(watched / "copy.csv").write_bytes(raw)
(watched / "copy of report.txt").write_bytes(SCAN.read_bytes().replace(b"\n", b"\r\n"))
for f in ("copy.csv", "copy of report.txt"):
    os.utime(watched / f, (old, old))
n = livelogs.watch(say=lambda *_: None)
T.ok(n["new"] == 0 and n["known"] == 7, "a copy of a log or scan that's already in (even with Windows line endings) adds nothing", n)
livelogs.set_folder("")
T.ok(livelogs.folder() is None and livelogs.watch(say=lambda *_: None)["new"] == 0, "watching can be turned off")
livelogs.set_folder(None)
T.ok(cfg.load()["logs_folder"] is None and livelogs.folder() is None,
     "back to the default, which in a test (or scratch) home never means the real FORScan folder")

# ---- the copy for devices
b = build.build()
meta = build.read_meta()
snap = json.loads(gzip.decompress((paths.OUT / meta["file"]).read_bytes()))
T.ok(snap["format"] == build.FORMAT and snap["counts"]["logs"] == 3 and len(snap["logs"]) == 3, "the snapshot lists 3 logs", snap["counts"])
lg = next(x for x in snap["logs"] if x["car_id"] == car)
T.ok("csv_gz" not in lg and lg["pids"][0] == "DSDRPM(1/min)" and lg["rows"] == 2001, "listed without their data, PIDs as a list")
files = sorted(p.name for p in (paths.OUT / "logs").iterdir())
T.ok(len(files) == 3 and f"{lg['sha256']}.csv.gz" in files, "each log's gzip written for the listener")
T.ok(gzip.decompress((paths.OUT / "logs" / f"{lg['sha256']}.csv.gz").read_bytes()).decode() == text, "the file is the log")
(paths.OUT / "logs" / f"{lg['sha256']}.csv.gz").unlink()
(paths.OUT / "logs" / ("0" * 64 + ".csv.gz")).write_bytes(b"x")
b2 = build.build()
T.ok(not b2["written"] and (paths.OUT / "logs" / f"{lg['sha256']}.csv.gz").is_file() and not (paths.OUT / "logs" / ("0" * 64 + ".csv.gz")).exists(),
     "a missing log file is written again, a stray one removed, with the snapshot unchanged")

# ---- from a device: gzipped, in pieces, then a "log" item; then attaching
up = str(uuid.uuid4())
gz = gzip.compress(raw.replace(b"78;", b"77;"))
inbox.append(up, 0, gz[:5000])
inbox.append(up, 5000, gz[5000:])
lid, att, att_scan, bad = (str(uuid.uuid4()) for _ in range(4))
loose = next(x["id"] for x in snap["logs"] if x["car_id"] is None)
sr = apply.import_scan_file(SCAN)                          # a scan with no car
inbox.receive({"id": "d1", "name": "Phone"}, {"items": [
    {"id": lid, "kind": "log", "data": {"upload_id": up, "file_name": "phone.csv", "car_id": car, "size": len(gz),
                                        "recorded_on": "2026-10-20", "note": "after the new plugs"}},
    {"id": att, "kind": "attach", "data": {"what": "log", "id": loose, "car_id": car}},
    {"id": att_scan, "kind": "attach", "data": {"what": "scan", "id": sr["scan_id"], "car_id": car}},
    {"id": bad, "kind": "attach", "data": {"what": "log", "id": loose, "car_id": str(uuid.uuid4())}}]})
res = {x["id"]: x for x in apply.apply_pending()[0]["results"]}
T.ok(res[lid]["result"] == "applied" and not inbox.upload_path(up).exists(), "a gzipped log from a device: applied, its upload removed", res[lid])
T.ok(res[att]["result"] == "applied" and res[att_scan]["result"] == "applied", "a folder log and a loose scan attached to a car")
T.ok(res[bad]["result"] == "rejected" and "car isn't on the laptop" in res[bad]["detail"], "attaching to an unknown car is refused", res[bad])
c = db.connect_ro(paths.DB)
T.ok(c.execute("SELECT recorded_on, note, origin FROM logs WHERE id = ?", (lid,)).fetchone() == ("2026-10-20", "after the new plugs", "phone:Phone"),
     "the device's date, note and origin kept")
T.ok(c.execute("SELECT car_id FROM logs WHERE id = ?", (loose,)).fetchone()[0] == car
     and c.execute("SELECT car_id FROM scans WHERE id = ?", (sr["scan_id"],)).fetchone()[0] == car, "both now on the car")
T.ok(c.execute("SELECT count(*) FROM change_log WHERE action = 'attach'").fetchone()[0] == 2, "each attach in change_log")
c.close()
up2 = str(uuid.uuid4())
inbox.append(up2, 0, gzip.compress(b"hello;world\n1;2\n"))
dud = str(uuid.uuid4())
inbox.receive({"id": "d1", "name": "Phone"}, {"items": [{"id": dud, "kind": "log", "data": {"upload_id": up2, "file_name": "x.csv",
                                                                                              "size": inbox.upload_size(up2)}}]})
r = apply.apply_pending()[0]["results"][0]
T.ok(r["result"] == "rejected" and "isn't a FORScan" in r["detail"], "a CSV that isn't a FORScan log is refused with the reason", r)
T.done()
