"""The app's JavaScript under node: lib/dtc.js search and lookup, and every
screen rendered from the real snapshot with nothing broken on screen."""
import gzip
import json
import shutil
import subprocess

from tests import _home as T

H = T.home("check_app")
T.copy_real_dtc(H)

from falconoath import apply, build, dtc_import, paths    # noqa: E402

FIX = T.ROOT / "tests" / "fixtures" / "forscan_fixture.txt"
SAMPLES = T.ROOT / "samples" / "forscan"

node = shutil.which("node")
if not node:
    print("SKIP: node is not installed")
    raise SystemExit(0)
dtc_import.import_dtc()
apply.import_scan_file(FIX)                                   # a scan with no car
car = None
for f in sorted(SAMPLES.glob("*.txt")) if SAMPLES.is_dir() else []:
    r = apply.import_scan_file(f, car_id=car, new_car=None if car else {"nickname": "Sample FG", "model": "FG"})
    car = r["car_id"]
# live-data logs: the made-up one on a car, and a copy with no car (as if from FORScan's folder)
from falconoath import livelogs                               # noqa: E402
LOGFIX = T.ROOT / "tests" / "fixtures" / "forscan_log_fixture.csv"
r = livelogs.import_file(LOGFIX, car_id=car, new_car=None if car else {"nickname": "Sample FG", "model": "FG"})
car = car or r["car_id"]
loose = H / "loose.csv"
loose.write_bytes(LOGFIX.read_bytes().replace(b"78;", b"79;"))
livelogs.import_file(loose)
r = build.build()
snap = H / "snap.json"
snap.write_bytes(gzip.decompress((paths.OUT / r["file"]).read_bytes()))
p = subprocess.run([node, str(T.ROOT / "tests" / "js_check.js"), str(paths.APP), str(snap), str(FIX), str(SAMPLES), str(LOGFIX)],
                   capture_output=True, text=True, encoding="utf-8")
if p.returncode != 0:
    T.ok(False, "node ran js_check.js", p.stderr[-2000:])
    T.done()
res = json.loads(p.stdout.strip().splitlines()[-1])
T.ok(res["n"] > 2500, f"{res['n']:,} checks ran in node")
T.ok(res["nfails"] == 0, "every search case and screen correct", "\n    " + "\n    ".join(res["fails"]))
T.done()
