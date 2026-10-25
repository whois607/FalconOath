"""The app's JavaScript under node: lib/dtc.js search and lookup, and every
screen rendered from the real snapshot with nothing broken on screen."""
import gzip
import json
import shutil
import subprocess

from tests import _home as T

H = T.home("check_app")
T.copy_real_dtc(H)

from falconoath import build, dtc_import, paths    # noqa: E402

node = shutil.which("node")
if not node:
    print("SKIP: node is not installed")
    raise SystemExit(0)
dtc_import.import_dtc()
r = build.build()
snap = H / "snap.json"
snap.write_bytes(gzip.decompress((paths.OUT / r["file"]).read_bytes()))
p = subprocess.run([node, str(T.ROOT / "tests" / "js_check.js"), str(paths.APP), str(snap)],
                   capture_output=True, text=True, encoding="utf-8")
if p.returncode != 0:
    T.ok(False, "node ran js_check.js", p.stderr[-2000:])
    T.done()
res = json.loads(p.stdout.strip().splitlines()[-1])
T.ok(res["n"] > 2500, f"{res['n']:,} checks ran in node")
T.ok(res["nfails"] == 0, "every search case and screen correct", "\n    " + "\n    ".join(res["fails"]))
T.done()
