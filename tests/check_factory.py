"""Step 7 on the laptop: schema 5, a car's trim and build plate codes from a
device (checked, kept when a device doesn't send them, changed through an
item naming the car), code table facts, and a deleted trim leaving its cars.
Synthetic PDFs only; nothing here touches real data."""
import gzip
import json
import uuid

from tests import _home as T
from tests._pdf import make_pdf

H = T.home("check_factory")

from falconoath import apply, build, db, inbox, library, paths  # noqa: E402

root = library.ensure_folders()
(root / "BF" / "Workshop").mkdir()
(root / "BF" / "Workshop" / "100-01 Identification Codes.pdf").write_bytes(make_pdf([["Body Style Code", "XR Sedan SW"], ["Model Code", "Sedan XR 10335"]]))
(root / "BF" / "Brochures" / "BF brochure.pdf").write_bytes(make_pdf([["BF MkII XR6 Turbo sedan"]]))
library.index(say=lambda *_: None)
c = db.connect_ro(paths.LIBRARY)
sha = {p.split("/")[-1]: s for p, s in c.execute("SELECT path, sha FROM files")}
c.close()
IDS, BRO = sha["100-01 Identification Codes.pdf"], sha["BF brochure.pdf"]

r = db.init()
c = db.connect_ro(paths.DB)
cols = {x[1] for x in c.execute("PRAGMA table_info(cars)")}
T.ok(db.schema_version(c) >= 5 and {"trim_id", "paint_code", "trim_code", "body_code", "model_code", "build_date"} <= cols, "schema 5 or later: a car's trim and plate codes")
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


nid = lambda: str(uuid.uuid4())  # noqa: E731

# ---- code tables: facts that need their code
f1, f2, f3 = nid(), nid(), nid()
res = send([{"id": f1, "kind": "fact", "data": {"id": f1, "model": "BF", "series": "", "kind": "bodycode", "code": "sw", "value": "XR Sedan", "doc_sha": IDS, "page": 1}},
            {"id": f2, "kind": "fact", "data": {"id": f2, "model": "BF", "series": "", "kind": "modelcode", "code": "10335", "value": "Sedan XR", "doc_sha": IDS, "page": 2}},
            {"id": f3, "kind": "fact", "data": {"id": f3, "model": "BF", "series": "", "kind": "paintcode", "code": "", "value": "Winter White", "doc_sha": IDS, "page": 2}}])
T.ok(res[f1][0] == res[f2][0] == "applied" and q("SELECT code FROM trim_facts WHERE id = ?", f1) == [("SW",)], "code table entries from a manual page (any manual, not just brochures)", res)
T.ok(res[f3] == ("rejected", "a code table entry needs its code"), "a code table entry without its code is refused", res[f3])

# ---- a trim and a car naming it, in one batch (the trim goes first)
tid, car, ba = nid(), nid(), nid()
res = send([{"id": car, "kind": "car", "data": {"nickname": "Yard XR6", "model": "BF", "trim_id": tid, "paint_code": " a1 ", "body_code": "SW",
                                                 "model_code": "10335", "trim_code": "b1", "build_date": "2007-03"}},
            {"id": tid, "kind": "trim", "data": {"id": tid, "model": "BF", "series": "BF MkII", "name": "XR6 Turbo", "body": "sedan", "doc_sha": BRO, "page": 1}},
            {"id": ba, "kind": "car", "data": {"nickname": "A BA", "model": "BA"}}])
T.ok(res[tid][0] == "applied" and res[car][0] == "applied", "a trim and a car naming it, sent together: applied (the trim first)", res)
T.ok(q("SELECT trim_id, paint_code, trim_code, body_code, model_code, build_date FROM cars WHERE id = ?", car) == [(tid, "A1", "B1", "SW", "10335", "2007-03")],
     "the car keeps its trim and plate codes (tidied to capitals)")

# ---- what's refused
bad = {}
for label, d in [("code with symbols", {"paint_code": "A-1"}), ("code too long", {"model_code": "123456789"}),
                 ("not a month", {"build_date": "03/2007"}), ("year out of range", {"build_date": "1980-01"}),
                 ("trim of another model", {"trim_id": tid, "model": "BA"}), ("no such trim", {"trim_id": nid()})]:
    i = nid()
    bad[label] = send([{"id": i, "kind": "car", "data": {"id": ba if label == "trim of another model" else car, "nickname": "x", "model": "BF", **d}}])[i]
T.ok(all(v[0] == "rejected" for v in bad.values()), "refused: odd codes, a build date that isn't a month, a trim of another model, no such trim", bad)
T.ok("for the BF, not this car's model" in bad["trim of another model"][1], "with a reason the phone can show", bad["trim of another model"])
T.ok(q("SELECT paint_code, build_date FROM cars WHERE id = ?", car) == [("A1", "2007-03")], "and nothing changed")

# ---- changing a car: an item naming it; fields not sent are kept
e1 = nid()
res = send([{"id": e1, "kind": "car", "data": {"id": car, "nickname": "Yard XR6", "model": "BF", "paint_code": "ST"}}])
T.ok(res[e1][0] == "updated" and q("SELECT paint_code, body_code, trim_id, build_date FROM cars WHERE id = ?", car) == [("ST", "SW", tid, "2007-03")],
     "a change names its car (data.id); the paint changed, what wasn't sent is kept", res)
e2 = nid()
T.ok(send([{"id": e2, "kind": "car", "data": {"id": car, "nickname": "Yard XR6", "model": "BF", "trim_id": None, "paint_code": ""}}])[e2][0] == "updated"
     and q("SELECT paint_code, trim_id FROM cars WHERE id = ?", car) == [("", None)], "a code or trim can be cleared")
e3 = nid()
T.ok(send([{"id": e3, "kind": "car", "data": {"id": nid(), "nickname": "ghost"}}])[e3][0] == "rejected", "a change to a car the laptop doesn't have is refused")
T.ok(q("SELECT count(*) FROM cars") == [(2,)], "no extra cars made")
log = q("SELECT before, after FROM change_log WHERE tbl = 'cars' AND row_id = ? AND action = 'update' ORDER BY id", car)
T.ok(len(log) == 2 and json.loads(log[0][0])["paint_code"] == "A1" and json.loads(log[0][1])["paint_code"] == "ST", "each change in change_log, with what it was")

# ---- the snapshot, then deleting the trim leaves the car without it
e4 = nid()
send([{"id": e4, "kind": "car", "data": {"id": car, "nickname": "Yard XR6", "model": "BF", "trim_id": tid}}])
b = build.build()
snap = json.loads(gzip.decompress((paths.OUT / b["file"]).read_bytes()))
sc = next(x for x in snap["cars"] if x["id"] == car)
T.ok(sc["trim_id"] == tid and sc["body_code"] == "SW" and sc["build_date"] == "2007-03" and {f["kind"] for f in snap["facts"]} == {"bodycode", "modelcode"},
     "the snapshot carries the car's trim and codes, and the code tables", sc)
e5 = nid()
T.ok(send([{"id": e5, "kind": "trim", "data": {"op": "del", "id": tid}}])[e5][0] == "applied"
     and q("SELECT trim_id, body_code FROM cars WHERE id = ?", car) == [(None, "SW")], "deleting a trim takes it off its cars (their codes stay)")
T.ok(json.loads(q("SELECT before FROM change_log WHERE tbl = 'cars' AND row_id = ? ORDER BY id DESC", car)[0][0]) == {"trim_id": tid}, "logged")
T.done()
