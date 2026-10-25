"""Test harness: import FIRST in every check, before anything from falconoath.

Points FALCONOATH_HOME at a fresh folder under tests/synthetic/<suite>, so a
test never touches the real data/ or output/. The real dtc.db, when a test
needs it, is copied in (and the original's hash is checked untouched).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REAL_DTC = ROOT / "data" / "sources" / "dtc.db"
_FAILS: list[str] = []
_N = [0]


def home(name: str) -> Path:
    h = ROOT / "tests" / "synthetic" / name
    if h.exists():
        shutil.rmtree(h)
    (h / "data" / "sources").mkdir(parents=True)
    os.environ["FALCONOATH_HOME"] = str(h)
    sys.path.insert(0, str(ROOT))
    return h


def sha(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def copy_real_dtc(h: Path) -> Path:
    if not REAL_DTC.is_file():
        print("SKIP: no data/sources/dtc.db (the real source) - run from the project")
        sys.exit(0)
    dst = h / "data" / "sources" / "dtc.db"
    shutil.copyfile(REAL_DTC, dst)
    return dst


def ok(cond, label: str, detail="") -> bool:
    _N[0] += 1
    if cond:
        print(f"  ok   {label}")
    else:
        _FAILS.append(label)
        print(f"  FAIL {label}" + (f": {detail}" if detail != "" else ""))
    return bool(cond)


def done() -> None:
    print(f"{_N[0] - len(_FAILS)}/{_N[0]} passed")
    sys.exit(1 if _FAILS else 0)
