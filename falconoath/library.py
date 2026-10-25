"""The manual library (step 3): your own PDFs in manuals/<model>/.

    manuals/BA, BF, FG, FGX, General      drop PDFs in (subfolders are fine)

`index()` reads every PDF's text, page by page (pypdf), into data/library.db.
That file is an index of the PDFs, not recorded data: it can always be
rebuilt from them, so it gets no backups and nothing else writes it. The
PDFs themselves are only ever read. A file is read again only when its size
or date changes; a renamed or moved file is recognised by its SHA-256 and
not read again; the same PDF in two places is one manual.

`build()` writes what devices download, under output/phone/:
* library-<v>.json.gz: every manual's title, folder and page text, so
  searching works on the phone with no signal;
* library-files.json: sha256 -> path, so the listener can serve a PDF
  without a database;
* library-meta.json last (it names the other two). The newest two copies
  are kept, and nothing is written if nothing changed.

Scanned PDFs have no text to read (pages with no text are counted), so they
can be opened but not searched until OCR comes (later).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import re
import sqlite3
import time
from pathlib import Path

from . import db, paths
from .build import _write_atomic

FORMAT = "falconoath-lib/1"
KEEP = 2
MAX_PAGE_CHARS = 20000          # a page of a manual is ~2-4k; this only stops junk
README = """FalconOath manuals
==================

Put your own PDF manuals and brochures here, in the folder for the model:

    BA, BF, FG, FGX (FG X), or General (anything for every model)

Subfolders are fine. FalconOath reads the text of every page so you can
search it, on the laptop and on your phone (even with no signal). It never
changes, moves or uploads these files; they stay on this laptop. PDFs sent
from your phone land here too.

Scanned PDFs (pictures of pages) can be opened but not searched yet.
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    sha TEXT PRIMARY KEY, pages INTEGER NOT NULL, text_pages INTEGER NOT NULL,
    error TEXT NOT NULL DEFAULT '', indexed_at TEXT NOT NULL, secs REAL);
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,          -- relative to manuals/, with /
    sha TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
    sha TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (sha, page));
"""


def ensure_folders(root: Path | None = None) -> Path:
    root = root or paths.MANUALS
    for f in paths.MANUAL_FOLDERS:
        (root / f).mkdir(parents=True, exist_ok=True)
    rd = root / "README.txt"
    if not rd.exists():
        rd.write_text(README, encoding="utf-8")
    return root


def pdfs(root: Path | None = None) -> list[tuple[str, Path]]:
    """(relative path, file) for every PDF under manuals/, sorted."""
    root = root or paths.MANUALS
    if not root.is_dir():
        return []
    out = []
    for p in root.rglob("*"):
        if p.suffix.lower() == ".pdf" and p.is_file() and not p.name.startswith((".", "~$")):
            out.append((p.relative_to(root).as_posix(), p))
    return sorted(out)


def signature(root: Path | None = None) -> tuple:
    """Cheap: changes whenever a PDF is added, removed, renamed or changed."""
    out = []
    for rel, p in pdfs(root):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((rel, st.st_size, st.st_mtime))
    return tuple(out)


def _connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or paths.LIBRARY
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path, timeout=30)
    c.executescript(SCHEMA)
    return c


def file_sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def clean(text: str) -> str:
    """One space between words, paragraphs kept as single newlines."""
    lines = [" ".join(x.split()) for x in str(text or "").replace("\x00", "").splitlines()]
    return "\n".join(x for x in lines if x)[:MAX_PAGE_CHARS]


def read_pdf(p: Path) -> tuple[list[str], str]:
    """Each page's text, and an error ('' if none). Never raises."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return [], "pypdf isn't installed (python -m pip install pypdf)"
    logging.getLogger("pypdf").setLevel(logging.ERROR)     # the reason is reported below, once
    try:
        r = PdfReader(str(p))
        if r.is_encrypted:
            try:
                r.decrypt("")
            except Exception:
                return [], "the PDF is password-protected"
        out = []
        for pg in r.pages:
            try:
                out.append(clean(pg.extract_text() or ""))
            except Exception:              # one bad page doesn't lose the rest
                out.append("")
        return out, ""
    except Exception as e:
        return [], f"couldn't read it ({type(e).__name__}: {str(e)[:120]})"


def index(root: Path | None = None, say=print) -> dict:
    """Bring data/library.db up to date with manuals/. Returns counts."""
    root = root or paths.MANUALS
    ensure_folders(root)
    c = _connect()
    known = {r[0]: (r[1], r[2], r[3]) for r in c.execute("SELECT path, sha, size, mtime FROM files")}
    have = {r[0] for r in c.execute("SELECT sha FROM docs")}
    seen, n = set(), {"read": 0, "moved": 0, "same": 0, "removed": 0, "errors": 0, "pages": 0}
    for rel, p in pdfs(root):
        try:
            st = p.stat()
        except OSError:
            continue
        seen.add(rel)
        k = known.get(rel)
        if k and k[1] == st.st_size and abs(k[2] - st.st_mtime) < 0.001 and k[0] in have:
            n["same"] += 1
            continue
        sha = file_sha(p)
        if sha not in have:
            say(f"  reading {rel} ...")
            t0 = time.monotonic()
            texts, err = read_pdf(p)
            secs = round(time.monotonic() - t0, 1)
            with c:
                c.execute("DELETE FROM pages WHERE sha = ?", (sha,))
                c.executemany("INSERT INTO pages (sha, page, text) VALUES (?,?,?)",
                              [(sha, i + 1, t) for i, t in enumerate(texts)])
                c.execute("INSERT OR REPLACE INTO docs (sha, pages, text_pages, error, indexed_at, secs) "
                          "VALUES (?,?,?,?,?,?)", (sha, len(texts), sum(1 for t in texts if t), err,
                                                   time.strftime("%Y-%m-%d %H:%M:%S"), secs))
            have.add(sha)
            n["read"] += 1
            n["pages"] += len(texts)
            if err:
                n["errors"] += 1
                say(f"    {err}")
            else:
                blank = sum(1 for t in texts if not t)
                say(f"    {len(texts)} pages in {secs} s" + (f" ({blank} with no text: scanned?)" if blank else ""))
        else:
            n["moved" if not k else "same"] += 1
        with c:
            c.execute("INSERT OR REPLACE INTO files (path, sha, size, mtime) VALUES (?,?,?,?)",
                      (rel, sha, st.st_size, st.st_mtime))
    gone = [r for r in known if r not in seen]
    with c:
        for rel in gone:
            c.execute("DELETE FROM files WHERE path = ?", (rel,))
        n["removed"] = len(gone)
        # a manual no longer in any folder goes from the index too
        c.execute("DELETE FROM pages WHERE sha NOT IN (SELECT sha FROM files)")
        c.execute("DELETE FROM docs WHERE sha NOT IN (SELECT sha FROM files)")
    c.close()
    return n


def title_of(rel: str) -> str:
    stem = Path(rel).stem
    return " ".join(re.sub(r"[_]+", " ", stem).split()) or stem


def folder_of(rel: str) -> str:
    top = rel.split("/", 1)[0] if "/" in rel else ""
    return top if top in paths.MANUAL_FOLDERS else "General"


def collect() -> dict:
    """What devices get: every manual (one per PDF, however many copies) and
    its page text."""
    if not paths.LIBRARY.is_file():
        return {"manuals": [], "text": {}, "counts": {"manuals": 0, "pages": 0, "text_pages": 0}}
    c = db.connect_ro(paths.LIBRARY)
    try:
        docs = {r[0]: r[1:] for r in c.execute("SELECT sha, pages, text_pages, error, indexed_at FROM docs")}
        files = {}
        for rel, sha, size in c.execute("SELECT path, sha, size FROM files ORDER BY path"):
            files.setdefault(sha, []).append((rel, size))
        manuals, text = [], {}
        for sha, locs in files.items():
            if sha not in docs:
                continue
            rel, size = locs[0]
            pages, text_pages, err, at = docs[sha]
            manuals.append({"sha": sha, "title": title_of(rel), "folder": folder_of(rel), "path": rel,
                            "also": [x[0] for x in locs[1:]], "pages": pages, "text_pages": text_pages,
                            "size": size, "error": err, "indexed_at": at})
            text[sha] = [t for (t,) in c.execute("SELECT text FROM pages WHERE sha = ? ORDER BY page", (sha,))]
    finally:
        c.close()
    manuals.sort(key=lambda m: (paths.MANUAL_FOLDERS.index(m["folder"]), m["title"].lower(), m["sha"]))
    return {"manuals": manuals, "text": text,
            "counts": {"manuals": len(manuals), "pages": sum(m["pages"] for m in manuals),
                       "text_pages": sum(m["text_pages"] for m in manuals)}}


def version_of(content: dict) -> str:
    h = hashlib.sha256()
    h.update(FORMAT.encode())
    h.update(hashlib.sha256(Path(__file__).read_bytes()).digest())
    h.update(json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return h.hexdigest()[:16]


def read_meta(out: Path | None = None) -> dict | None:
    try:
        m = json.loads(((out or paths.OUT) / "library-meta.json").read_text(encoding="utf-8"))
        return m if isinstance(m, dict) and m.get("file") else None
    except (OSError, ValueError):
        return None


def build(out: Path | None = None, force: bool = False) -> dict:
    """Write the library copy for devices if anything changed."""
    out = out or paths.OUT
    content = collect()
    ver = version_of(content)
    meta = read_meta(out)
    if not force and meta and meta.get("version") == ver and (out / meta["file"]).is_file():
        return {"written": False, "version": ver, "counts": meta["counts"]}
    out.mkdir(parents=True, exist_ok=True)
    built = time.strftime("%Y-%m-%d %H:%M:%S")
    raw = json.dumps({"format": FORMAT, "version": ver, "built": built, **content},
                     ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=9, mtime=0)
    name = f"library-{ver}.json.gz"
    _write_atomic(out / name, gz)
    _write_atomic(out / "library-files.json",
                  json.dumps({m["sha"]: m["path"] for m in content["manuals"]}, indent=0).encode("utf-8"))
    meta = {"format": FORMAT, "version": ver, "built": built, "file": name, "bytes": len(gz),
            "raw_bytes": len(raw), "counts": content["counts"]}
    _write_atomic(out / "library-meta.json", json.dumps(meta, indent=1).encode("utf-8"))
    olds = sorted((p for p in out.glob("library-*.json.gz") if p.name != name),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for p in olds[KEEP - 1:]:
        try:
            p.unlink()
        except OSError:
            pass
    return {"written": True, "version": ver, "counts": content["counts"], "bytes": len(gz)}

