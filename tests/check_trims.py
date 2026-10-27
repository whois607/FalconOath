"""Step 6 on the laptop: the Brochures folders, brochures marked in the
manuals' copy, and trims and facts from a device checked and applied
(every fact citing a brochure page in the library), changed, deleted and
put in the snapshot. Synthetic PDFs only; nothing here touches real data."""
import contextlib
import gzip
import io
import json
import uuid

from tests import _home as T
from tests._pdf import make_pdf

H = T.home("check_trims")

from falconoath import apply, build, cli, db, inbox, library, paths  # noqa: E402

# ---- folders and brochures in the library
root = library.ensure_folders()
T.ok(all((root / f / "Brochures").is_dir() for f in ("BA", "BF", "FG", "FGX")) and not (root / "General" / "Brochures").exists(),
     "manuals/<model>/Brochures made for every model (not General)")
bro = make_pdf([["FG MkII Falcon", "XR6 Turbo", "270 kW @ 5250 rpm", "533 Nm @ 2000-4750 rpm", "ZF 6-speed automatic"],
                ["Colours", "Winter White", "Kinetic", "Silhouette"], []])
(root / "FG" / "Brochures" / "FG MkII brochure.pdf").write_bytes(bro)
(root / "FG" / "Workshop.pdf").write_bytes(make_pdf([["FG Workshop Manual"]]))
before = T.sha(root / "FG" / "Brochures" / "FG MkII brochure.pdf")
library.index(say=lambda *_: None)
library.build()
lib = json.loads(gzip.decompress((paths.OUT / library.read_meta()["file"]).read_bytes()))
by = {m["title"]: m for m in lib["manuals"]}
T.ok(by["FG MkII brochure"]["brochure"] is True and by["Workshop"]["brochure"] is False, "the copy marks the brochure (and not the workshop manual)")
T.ok(library.is_brochure("FGX/Ford/brochures/x.pdf") and not library.is_brochure("FG/Brochures.pdf"), "any folder named Brochures counts; a file named so doesn't")
SHA = by["FG MkII brochure"]["sha"]

# ---- schema 4
db.init()
r = db.init()
c = db.connect_ro(paths.DB)
T.ok(db.schema_version(c) >= 4 and {"trims", "trim_facts"} <= {x[0] for x in c.execute("SELECT name FROM sqlite_master")}, "schema 4 or later: trims and trim_facts")
c.close()

DEV = {"id": "dev1", "name": "test phone"}


def send(items, dev=DEV):
    inbox.receive(dev, {"items": items})
    out = apply.apply_pending()
    return {x["id"]: (x["result"], x["detail"]) for f in out for x in f["results"]}


def q(sql, *a):
    c = db.connect_ro(paths.DB)
    try:
        return c.execute(sql, a).fetchall()
    finally:
        c.close()


src = {"doc_sha": SHA, "page": 1}
tid, f1, f2, f3 = (str(uuid.uuid4()) for _ in range(4))
res = send([
    {"id": f1, "kind": "fact", "data": {"op": "put", "id": f1, "trim_id": tid, "model": "FG", "series": "FG MkII", "kind": "power", "value": "270 kW @ 5250 rpm", **src}},
    {"id": tid, "kind": "trim", "data": {"op": "put", "id": tid, "model": "FG", "series": "FG MkII", "name": "XR6 Turbo", "body": "Sedan", **src}},
    {"id": f2, "kind": "fact", "data": {"op": "put", "id": f2, "trim_id": tid, "model": "FG", "kind": "gearbox", "value": "ZF 6-speed automatic", **src}},
    {"id": f3, "kind": "fact", "data": {"op": "put", "id": f3, "trim_id": None, "model": "FG", "series": "FG MkII", "kind": "colour", "value": "Kinetic", "code": "kz", "doc_sha": SHA, "page": 2}},
])
T.ok(all(v[0] == "applied" for v in res.values()) and len(res) == 4, "a trim and its facts from a device: applied (the trim first, though sent after a fact)", res)
t = q("SELECT model, series, name, body, doc_sha, page, created_on FROM trims WHERE id = ?", tid)
T.ok(t == [("FG", "FG MkII", "XR6 Turbo", "sedan", SHA, 1, "phone:test phone")], "the trim, citing its brochure page", t)
T.ok(q("SELECT series FROM trim_facts WHERE id = ?", f2) == [("FG MkII",)], "a fact takes its trim's model and series")
T.ok(q("SELECT trim_id, code FROM trim_facts WHERE id = ?", f3) == [(None, "KZ")], "a fact for the whole series (a colour, with its code)")
T.ok(q("SELECT count(*) FROM change_log WHERE tbl IN ('trims', 'trim_facts') AND action = 'insert'") == [(4,)], "each one in change_log")

# ---- what's refused
bad = {}
for label, d in [("no brochure", {"value": "x", "kind": "standard", "model": "FG"}),
                 ("not in the library", {"value": "x", "kind": "standard", "model": "FG", "doc_sha": "f" * 64, "page": 1}),
                 ("page past the end", {"value": "x", "kind": "standard", "model": "FG", "doc_sha": SHA, "page": 9}),
                 ("unknown kind", {"value": "x", "kind": "spoiler", "model": "FG", **src}),
                 ("empty", {"value": "  ", "kind": "standard", "model": "FG", **src}),
                 ("no such trim", {"value": "x", "kind": "standard", "trim_id": str(uuid.uuid4()), **src}),
                 ("unknown model", {"value": "x", "kind": "standard", "model": "VE", **src})]:
    i = str(uuid.uuid4())
    bad[label] = send([{"id": i, "kind": "fact", "data": {"op": "put", "id": i, **d}}])[i]
T.ok(all(v[0] == "rejected" for v in bad.values()), "refused: no brochure, one not in the library, a page past the end, an unknown kind, empty, no such trim, unknown model", bad)
T.ok("isn't in the laptop's library" in bad["not in the library"][1] and "3 pages" in bad["page past the end"][1], "with reasons the phone can show", bad)
i = str(uuid.uuid4())
T.ok(send([{"id": i, "kind": "trim", "data": {"op": "put", "id": i, "model": "FG", "name": "", **src}}])[i][0] == "rejected", "a trim with no name is refused")

# ---- the same trim made on another device, with a fact on it
tid2, f4, f5 = (str(uuid.uuid4()) for _ in range(3))
res = send([{"id": tid2, "kind": "trim", "data": {"op": "put", "id": tid2, "model": "FG", "series": "FG MkII", "name": "xr6 turbo", "body": "sedan", **src}},
            {"id": f4, "kind": "fact", "data": {"op": "put", "id": f4, "trim_id": tid2, "kind": "torque", "value": "533 Nm", **src}},
            {"id": f5, "kind": "fact", "data": {"op": "put", "id": f5, "trim_id": tid, "kind": "gearbox", "value": "zf 6-speed AUTOMATIC", **src}}],
           {"id": "dev2", "name": "laptop browser"})
T.ok(res[tid2][0] == "duplicate" and res[f4][0] == "applied" and q("SELECT trim_id FROM trim_facts WHERE id = ?", f4) == [(tid,)],
     "the same trim from another device is one trim; its fact goes on the laptop's", res)
T.ok(res[f5][0] == "duplicate" and q("SELECT count(*) FROM trims") == [(1,)], "the same fact twice is one fact")

# ---- changing and deleting
e1 = str(uuid.uuid4())
res = send([{"id": e1, "kind": "trim", "data": {"op": "put", "id": tid, "model": "FG", "series": "FG MkII", "name": "XR6 Turbo", "body": "sedan", "years": "2011-2014", **src}}])
T.ok(res[e1][0] == "updated" and q("SELECT years FROM trims WHERE id = ?", tid) == [("2011-2014",)], "a trim changed from a device")
log = q("SELECT before, after FROM change_log WHERE tbl = 'trims' AND action = 'update'")
T.ok(log and json.loads(log[-1][0])["years"] == "" and json.loads(log[-1][1])["years"] == "2011-2014", "with what it was before")
e2 = str(uuid.uuid4())
send([{"id": e2, "kind": "fact", "data": {"op": "del", "id": f3}}])
T.ok(q("SELECT count(*) FROM trim_facts WHERE id = ?", f3) == [(0,)] and json.loads(q("SELECT before FROM change_log WHERE row_id = ? AND action = 'delete'", f3)[0][0])["value"] == "Kinetic",
     "a fact deleted, kept whole in change_log")

# ---- the snapshot, before the trim is deleted
b = build.build()
snap = json.loads(gzip.decompress((paths.OUT / b["file"]).read_bytes()))
T.ok(snap["format"] == "falconoath-snap/6" and snap["counts"]["trims"] == 1 and snap["counts"]["facts"] == 3
     and {f["kind"] for f in snap["facts"]} == {"power", "gearbox", "torque"}, "the snapshot carries trims and facts, with counts", snap["counts"])
T.ok(snap["trims"][0]["doc_sha"] == SHA and all(f["doc_sha"] == SHA and f["page"] for f in snap["facts"]), "every one with its brochure page")
out = io.StringIO()
with contextlib.redirect_stdout(out):
    cli.main(["trims"])
T.ok("XR6 Turbo" in out.getvalue() and "3 fact(s)" in out.getvalue(), "python -m falconoath trims lists them", out.getvalue())

e3 = str(uuid.uuid4())
res = send([{"id": e3, "kind": "trim", "data": {"op": "del", "id": tid}}])
T.ok(res[e3][0] == "applied" and q("SELECT count(*) FROM trims") == [(0,)] and q("SELECT count(*) FROM trim_facts") == [(0,)],
     "deleting a trim deletes its facts")
T.ok(q("SELECT count(*) FROM change_log WHERE action = 'delete' AND tbl = 'trim_facts'") == [(4,)], "each deleted fact logged (with the one before)")
e4 = str(uuid.uuid4())
T.ok(send([{"id": e4, "kind": "trim", "data": {"op": "del", "id": tid}}])[e4][0] == "duplicate", "deleting it again: already gone")
T.ok(len(list(paths.BACKUPS.glob("falcon-*.db"))) >= 1, "backed up before writing")

# ---- a brochure sent from a device lands in the model's Brochures folder
pdf = make_pdf([["BA brochure"]])
up, man = str(uuid.uuid4()), str(uuid.uuid4())
inbox.append(up, 0, pdf)
res = send([{"id": man, "kind": "manual", "data": {"upload_id": up, "file_name": "BA XR8 brochure.pdf", "folder": "BA", "size": len(pdf), "brochure": True}}])
T.ok(res[man] == ("applied", "BA/Brochures/BA XR8 brochure.pdf") and (root / "BA" / "Brochures" / "BA XR8 brochure.pdf").read_bytes() == pdf,
     "a brochure from a device is filed in BA/Brochures", res)
T.ok(T.sha(root / "FG" / "Brochures" / "FG MkII brochure.pdf") == before, "the brochure PDF itself is untouched")
T.done()
