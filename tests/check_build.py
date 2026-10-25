"""The data copy: written only when something changed, meta.json last and
never naming a missing file, newest two kept, counts matching the DB."""
import gzip
import json
import time

from tests import _home as T

H = T.home("check_build")
T.copy_real_dtc(H)

from falconoath import build, db, dtc_import, paths    # noqa: E402

dtc_import.import_dtc()
print("first build")
r = build.build()
T.ok(r["written"], "written the first time")
meta = json.loads((paths.OUT / "meta.json").read_text(encoding="utf-8"))
f = paths.OUT / meta["file"]
T.ok(f.is_file(), "meta.json names a file that exists")
snap = json.loads(gzip.decompress(f.read_bytes()))
T.ok(snap["format"] == build.FORMAT and snap["version"] == meta["version"], "format and version agree")
T.ok(len(snap["dtc"]) == meta["counts"]["dtc"] == snap["counts"]["dtc"] == 1195, "counts agree (1,195)")
T.ok(snap["dtc_cols"] == build.DTC_COLS and all(len(x) == len(build.DTC_COLS) for x in snap["dtc"]),
     "every row has every column")
T.ok([m[0] for m in snap["models"]] == ["BA", "BF", "FG", "FGX"] and snap["models"][3][4] == "FG",
     "models in order; FG X reads FG")
T.ok(len(f.read_bytes()) < 200_000, f"small: {len(f.read_bytes()):,} bytes gzipped")

print("no change, no write")
mt = (paths.OUT / "meta.json").stat().st_mtime_ns
files = sorted(p.name for p in paths.OUT.iterdir())
time.sleep(0.05)
r2 = build.build()
T.ok(not r2["written"] and r2["version"] == r["version"], "second build writes nothing")
T.ok((paths.OUT / "meta.json").stat().st_mtime_ns == mt and sorted(p.name for p in paths.OUT.iterdir()) == files,
     "no file touched")

print("a data change makes a new version; newest two kept")
versions = [r["version"]]
for i in range(3):
    with db.writing("test-change") as (c, _):
        c.execute("UPDATE dtc SET other = other || ? WHERE id = 1", (f" x{i}",))
    ri = build.build()
    T.ok(ri["written"] and ri["version"] not in versions, f"change {i + 1}: new version {ri['version']}")
    versions.append(ri["version"])
    m = json.loads((paths.OUT / "meta.json").read_text(encoding="utf-8"))
    T.ok((paths.OUT / m["file"]).is_file(), f"change {i + 1}: meta.json names an existing file")
snaps = sorted(p.name for p in paths.OUT.glob("snapshot-*.json.gz"))
T.ok(len(snaps) == 2 and f"snapshot-{versions[-1]}.json.gz" in snaps, "two snapshots kept, the newest among them", snaps)
T.ok(not list(paths.OUT.glob("*.tmp")), "no temporary files left")

print("the builder's code is part of the version")
c0 = build.collect()
v0 = build.version_of(c0)
orig = build._code_hash
build._code_hash = lambda: "different"
T.ok(build.version_of(c0) != v0, "changed builder code -> changed version")
build._code_hash = orig

print("build is read-only on falcon.db")
before = T.sha(paths.DB)
build.build(force=True)
T.ok(T.sha(paths.DB) == before, "falcon.db unchanged by a build")
T.done()
