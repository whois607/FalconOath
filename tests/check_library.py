"""Step 3 on the laptop: the manuals folders, reading PDFs into the index,
the manuals' copy for devices, and a PDF sent from a device being applied.
Synthetic PDFs only (tests/_pdf.py); nothing here touches the real data."""
import gzip
import json
import os
import shutil
import uuid

from tests import _home as T
from tests._pdf import make_pdf

H = T.home("check_library")

from falconoath import apply, db, inbox, library, paths  # noqa: E402

# ---- folders
root = library.ensure_folders()
T.ok(root == H / "manuals" and all((root / f).is_dir() for f in paths.MANUAL_FOLDERS), "manuals/BA, BF, FG, FGX, General made")
T.ok((root / "README.txt").read_text(encoding="utf-8").startswith("FalconOath manuals"), "with a README saying what goes where")
(root / "README.txt").write_text("my own notes", encoding="utf-8")
library.ensure_folders()
T.ok((root / "README.txt").read_text(encoding="utf-8") == "my own notes", "an existing README is never overwritten")

# ---- reading PDFs
ws = make_pdf([["FG Workshop Manual", "Section 303-14 Engine controls"],
               ["Knock sensor (KS) removal", "Disconnect the battery. P0325 knock sensor circuit."],
               []])                                            # a page with no text, like a scan
brochure = make_pdf([["BA Falcon XR6 Turbo", "Brembo brakes (optional)"]])
(root / "FG" / "Workshop").mkdir()
(root / "FG" / "Workshop" / "FG_Workshop_Manual.pdf").write_bytes(ws)
(root / "BA" / "BA brochure.pdf").write_bytes(brochure)
(root / "General" / "broken.pdf").write_bytes(b"%PDF-1.4 not really a pdf")
(root / "General" / "notes.txt").write_text("not a pdf", encoding="utf-8")
src_hash = {p: T.sha(p) for p in root.rglob("*.pdf")}
n = library.index(say=lambda *_: None)
T.ok(n["read"] == 3 and n["errors"] == 1 and n["pages"] == 4, "three PDFs read, the broken one noted", n)
T.ok(all(T.sha(p) == h for p, h in src_hash.items()), "the PDFs themselves are untouched")
c = db.connect_ro(paths.LIBRARY)
pages = c.execute("SELECT page, text FROM pages WHERE sha = ? ORDER BY page", (T.sha(root / "FG" / "Workshop" / "FG_Workshop_Manual.pdf"),)).fetchall()
c.close()
T.ok(len(pages) == 3 and "P0325 knock sensor circuit" in pages[1][1] and pages[2][1] == "", "page text kept per page; the scanned page is empty", pages)
n2 = library.index(say=lambda *_: None)
T.ok(n2["read"] == 0 and n2["same"] == 3,"nothing read again when nothing changed", n2)

# rename + copy: recognised by content, not read again
os.replace(root / "BA" / "BA brochure.pdf", root / "BA" / "BA XR6 brochure.pdf")
shutil.copyfile(root / "FG" / "Workshop" / "FG_Workshop_Manual.pdf", root / "FGX" / "copy.pdf")
n3 = library.index(say=lambda *_: None)
T.ok(n3["read"] == 0 and n3["moved"] == 2 and n3["removed"] == 1, "a renamed file and a copy aren't read again", n3)

# ---- the copy for devices
b = library.build()
T.ok(b["written"] and b["counts"] == {"manuals": 3, "pages": 4, "text_pages": 3}, "the copy: 3 manuals (the copy counts once), 4 pages", b)
meta = json.loads((paths.OUT / "library-meta.json").read_text(encoding="utf-8"))
lib = json.loads(gzip.decompress((paths.OUT / meta["file"]).read_bytes()))
m = {x["title"]: x for x in lib["manuals"]}
fg = m.get("FG Workshop Manual")
T.ok(fg and fg["folder"] == "FG" and fg["path"] == "FG/Workshop/FG_Workshop_Manual.pdf" and fg["also"] == ["FGX/copy.pdf"],
     "title from the file name, folder from the top folder, other copies listed", fg)
T.ok(m.get("BA XR6 brochure", {}).get("folder") == "BA" and m.get("broken", {}).get("error", "").startswith("couldn't read"),
     "the renamed brochure, and the broken PDF with its reason", list(m))
T.ok(lib["text"][fg["sha"]][1].startswith("Knock sensor (KS) removal"), "page text in the copy, so search works offline")
files = json.loads((paths.OUT / "library-files.json").read_text(encoding="utf-8"))
T.ok(files[fg["sha"]] == fg["path"] and len(files) == 3, "library-files.json maps each sha to its file, for the listener")
T.ok(not library.build()["written"], "building again with no change writes nothing")
(root / "FGX" / "copy.pdf").unlink()
library.index(say=lambda *_: None)
T.ok(library.build()["written"] and len(list(paths.OUT.glob("library-*.json.gz"))) == 2, "a change writes a new copy; the newest two are kept")

# moved before the index catches up (a folder dragged into FG): never offered at its old path
(root / "General" / "Ford manual").mkdir()
(root / "General" / "Ford manual" / "100-00 Index.PDF").write_bytes(make_pdf([["Contents index"]]))
library.index(say=lambda *_: None)
library.build()
(root / "FG" / "Ford manual").mkdir()
os.replace(root / "General" / "Ford manual" / "100-00 Index.PDF", root / "FG" / "Ford manual" / "100-00 Index.PDF")
library.build()
files = json.loads((paths.OUT / "library-files.json").read_text(encoding="utf-8"))
T.ok(not any(v.startswith("General/Ford manual") for v in files.values()), "a moved PDF's old path is dropped from the copy at once", files)
calls = []
n4 = library.index(say=lambda *_: None, progress=lambda: calls.append(library.build()), every=0)
files = json.loads((paths.OUT / "library-files.json").read_text(encoding="utf-8"))
T.ok(calls and "FG/Ford manual/100-00 Index.PDF" in files.values() and n4["moved"] == 1,
     "while reading, the copy is rewritten as it goes (the moved PDF is back, at its new path, upper-case .PDF too)", files)

# ---- a PDF sent from a device
db.init()
up = str(uuid.uuid4())
pdf = make_pdf([["BF Owner's handbook", "Tyre pressures"]])
T.ok(inbox.append(up, 0, pdf[:300]) == 300, "the first piece lands")
try:
    inbox.append(up, 0, pdf[:300])
    T.ok(False, "a resent piece is refused")
except inbox.Refused as e:
    T.ok("has 300 bytes" in str(e), "a resent piece is refused, saying how much arrived", e)
T.ok(inbox.append(up, 300, pdf[300:]) == len(pdf), "the rest lands")
try:
    inbox.append(str(uuid.uuid4()), 0, b"hello")
    T.ok(False, "a non-PDF is refused")
except inbox.Refused:
    T.ok(True, "an upload that doesn't start like a PDF is refused")
try:
    inbox.upload_path("../../evil")
    T.ok(False, "a bad id is refused")
except inbox.Refused:
    T.ok(True, "an upload id must be a UUID (no paths)")

item, short, dup = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
up2 = str(uuid.uuid4())
inbox.append(up2, 0, pdf[:100])
up3 = str(uuid.uuid4())
inbox.append(up3, 0, brochure)                                   # already in the library
r = inbox.receive({"id": "dev1", "name": "Test phone"}, {"items": [
    {"id": item, "kind": "manual", "data": {"upload_id": up, "file_name": "BF/Owner's: handbook?.pdf", "folder": "BF", "size": len(pdf)}},
    {"id": short, "kind": "manual", "data": {"upload_id": up2, "file_name": "x.pdf", "folder": "BF", "size": len(pdf)}},
    {"id": dup, "kind": "manual", "data": {"upload_id": up3, "file_name": "again.pdf", "folder": "BA", "size": len(brochure)}}]})
T.ok(r["ok"], "the manual items are received")
res = apply.apply_pending()
got = {x["id"]: x for x in res[0]["results"]}
T.ok(got[item]["result"] == "applied" and got[item]["detail"] == "BF/Owner's handbook.pdf", "applied into manuals/BF under a safe name", got[item])
T.ok((root / "BF" / "Owner's handbook.pdf").read_bytes() == pdf and not inbox.upload_path(up).exists(), "the PDF moved whole; the upload is gone")
T.ok(got[short]["result"] == "rejected" and "only 100 of" in got[short]["detail"], "a part-arrived upload is refused with the reason", got[short])
T.ok(got[dup]["result"] == "duplicate" and "BA XR6 brochure.pdf" in got[dup]["detail"] and not inbox.upload_path(up3).exists(),
     "a PDF already in the library is a duplicate, and its upload deleted", got[dup])
c = db.connect_ro(paths.DB)
log = c.execute("SELECT tbl, action, after FROM change_log WHERE tbl = 'manuals'").fetchall()
c.close()
T.ok(len(log) == 1 and "Owner's handbook.pdf" in log[0][2], "the new manual is in change_log", log)
again = str(uuid.uuid4())
inbox.append(again, 0, pdf)
inbox.receive({"id": "dev1", "name": "Test phone"}, {"items": [
    {"id": str(uuid.uuid4()), "kind": "manual", "data": {"upload_id": again, "file_name": "Owner's handbook.pdf", "folder": "BF", "size": len(pdf) }}]})
library.index(say=lambda *_: None)                                 # not indexed yet: same name, different place
T.ok(apply.apply_pending()[0]["results"][0]["result"] == "duplicate", "sent twice: the second is a duplicate (by content)")
T.done()
