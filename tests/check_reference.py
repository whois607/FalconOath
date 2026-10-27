"""The built-in reference (data/sources/reference.json): read and checked
(reference.py), its citations turned into the library's PDFs, carried in
the snapshot, rebuilt when it changes, and the rest of the build plate
(engine and gearbox codes) kept on a car. An invented fixture and
synthetic PDFs only; nothing here touches real data."""
import gzip
import json
import shutil
import uuid

from tests import _home as T
from tests._pdf import make_pdf

H = T.home("check_reference")

from falconoath import apply, build, cli, db, inbox, library, paths, reference  # noqa: E402

FIX = T.ROOT / "tests" / "fixtures" / "reference_fixture.json"

# ---- no file: nothing built in, and why
r = reference.collect()
T.ok(r["trims"] == r["facts"] == r["specs"] == [] and r["error"] == "no reference file", "no reference file: nothing built in, said so")

# ---- the PDFs it cites, in the library
root = library.ensure_folders()
(root / "FG" / "Workshop.pdf").write_bytes(make_pdf([["Identification codes"]]))
(root / "FGX" / "Brochures" / "Test brochure.pdf").write_bytes(make_pdf([["Testa"], ["Colours"]]))
library.index(say=lambda *_: None)

paths.SOURCES.mkdir(parents=True, exist_ok=True)
shutil.copyfile(FIX, paths.REFERENCE)
r = reference.collect()
T.ok(r["error"] == "" and len(r["trims"]) == 2 and len(r["facts"]) == 14 and len(r["specs"]) == 4 and len(r["notes"]) == 1,
     "the fixture read whole", {k: len(v) for k, v in r.items() if isinstance(v, list)})
T.ok(all(x["id"].startswith("ref:") and x.get("builtin") for x in r["trims"] + r["facts"]), "built-in rows are marked, with ids that can't clash with yours")
ws = T.sha(root / "FG" / "Workshop.pdf")
code = next(f for f in r["facts"] if f["kind"] == "enginecode" and f["code"] == "Q")
T.ok(code["doc_sha"] == ws and code["page"] == 1, "a citation becomes the PDF's SHA-256 and page (so the app opens it)")
lost = next(s for s in r["specs"] if s["label"] == "Wheel nuts")
T.ok(lost["doc_sha"] is None and lost["page"] == 3, "a PDF that isn't in the library keeps its page, with no link")
rs = next(f for f in r["facts"] if f.get("research"))
T.ok(rs["doc_sha"] is None and "Invented" in rs["research"], "a research note has no page, and says what it is")
T.ok(next(f for f in r["facts"] if f["value"] == "4.0L Test I6" and f["kind"] == "engine")["trim_id"] == "ref:tx-testa", "a trim's facts name it")

# ---- broken files are refused whole, with the reason
for label, mut in [("an unknown kind", lambda d: d["facts"][0].update(kind="nonsense")),
                   ("a code with no code", lambda d: d["facts"][6].update(code="")),
                   ("no source", lambda d: d["specs"][0].pop("src")),
                   ("a fact naming no trim", lambda d: d["facts"][0].update(trim="nope")),
                   ("an unknown model", lambda d: d["specs"][0].update(model="XY")),
                   ("another format", lambda d: d.update(format="other/1"))]:
    d = json.loads(FIX.read_text(encoding="utf-8"))
    mut(d)
    paths.REFERENCE.write_text(json.dumps(d), encoding="utf-8")
    x = reference.collect()
    T.ok(x["error"] and not x["facts"] and not x["specs"], f"refused: {label}", x["error"])
paths.REFERENCE.write_text("{not json", encoding="utf-8")
T.ok(reference.collect()["error"], "refused: not JSON")
shutil.copyfile(FIX, paths.REFERENCE)

# ---- the snapshot carries it; a change to the file is a new version
db.init()
b1 = build.build()
snap = json.loads(gzip.decompress((paths.OUT / b1["file"]).read_bytes()))
T.ok(snap["format"] == "falconoath-snap/6" and len(snap["ref"]["facts"]) == 14 and snap["counts"]["ref"] == 20, "the snapshot carries the reference, counted", snap["counts"])
T.ok(build.build()["written"] is False, "nothing changed: nothing written")
d = json.loads(FIX.read_text(encoding="utf-8"))
d["specs"][0]["value"] = "8W-88 test oil"
paths.REFERENCE.write_text(json.dumps(d), encoding="utf-8")
b2 = build.build()
T.ok(b2["written"] and b2["version"] != b1["version"], "a change to the reference is a new data version")
s1 = cli._stamp()
paths.REFERENCE.write_text(json.dumps(d) + "\n", encoding="utf-8")
T.ok(cli._stamp() != s1, "the listener sees the reference change (and rebuilds)")
shutil.copyfile(FIX, paths.REFERENCE)

# ---- schema 6: the engine and gearbox codes on a car
c = db.connect_ro(paths.DB)
cols = {x[1] for x in c.execute("PRAGMA table_info(cars)")}
T.ok(db.schema_version(c) == 6 and {"engine_code", "trans_code"} <= cols, "schema 6: engine and gearbox codes")
c.close()
DEV = {"id": "dev1", "name": "test phone"}


def send(items):
    inbox.receive(DEV, {"items": items})
    return {x["id"]: (x["result"], x["detail"]) for f in apply.apply_pending() for x in f["results"]}


def q(sql, *a):
    c = db.connect_ro(paths.DB)
    try:
        return c.execute(sql, a).fetchall()
    finally:
        c.close()


car = str(uuid.uuid4())
res = send([{"id": car, "kind": "car", "data": {"nickname": "Test FG", "model": "FG", "engine_code": " q ", "trans_code": "m",
                                                 "vin": "6FPAAAJGSX8A00001"}}])
T.ok(res[car][0] == "applied" and q("SELECT engine_code, trans_code, vin FROM cars WHERE id = ?", car) == [("Q", "M", "6FPAAAJGSX8A00001")],
     "a car keeps its engine and gearbox codes (tidied)", res)
item = str(uuid.uuid4())
res = send([{"id": item, "kind": "car", "data": {"id": car, "nickname": "Test FG", "model": "FG", "paint_code": "Q7"}}])
T.ok(q("SELECT engine_code, trans_code, paint_code FROM cars WHERE id = ?", car) == [("Q", "M", "Q7")], "a device that doesn't send them keeps them", res)
item = str(uuid.uuid4())
res = send([{"id": item, "kind": "car", "data": {"id": car, "model": "FG", "engine_code": "Q-1"}}])
T.ok(res[item][0] == "rejected" and "engine code" in res[item][1], "an engine code with symbols is refused", res)
snap = json.loads(gzip.decompress((paths.OUT / build.build()["file"]).read_bytes()))
T.ok(next(x for x in snap["cars"] if x["id"] == car)["engine_code"] == "Q", "the snapshot carries them")

# ---- the laptop's command
import contextlib, io  # noqa: E402,E401
out = io.StringIO()
with contextlib.redirect_stdout(out):
    cli.main(["reference"])
T.ok("FGX  2 trim(s)" in out.getvalue() and "1 research note(s)" in out.getvalue() and "1 cite a PDF that isn't in the library" in out.getvalue(),
     "python -m falconoath reference: what's built in, and any page it can't link", out.getvalue())
T.done()
