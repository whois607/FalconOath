"""Falcon asking prices from VPA (step 5): overall averages only.

VPA (vehicle-price-analysis, beside this project) owns its database; this
only ever READS it, through VPA's own `read_frame`, which opens vpa.db with
mode=ro and closes it again (VPA's INTEGRATION.md). Run in a child process
(`python -m falconoath prices`) so the listener never imports pandas or
touches VPA.

One price per car: its latest asking price. Used cars only, nothing under
MIN_PRICE. Grouped by FalconOath's models (BA, BF, FG, FG X), then by
series (BA / BA MkII ...) and by trim. The result is derived, not recorded:
data/prices.json, rebuilt whenever VPA changes; build.py puts it in the
snapshot.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from . import paths

GEN_MODEL = {"BA": "BA", "BA MkII": "BA", "BF": "BF", "BF MkII": "BF", "BF MkIII": "BF",
             "FG": "FG", "FG MkII": "FG", "FG X": "FGX"}
NOT_USED = {"new", "new to order", "demo"}
MIN_PRICE = 500
RECENT_DAYS = 14
FORMAT = "falconoath-prices/1"


def vpa_dir() -> Path | None:
    """VPA's folder: FALCONOATH_VPA if set, else beside this project. A test
    or scratch home (FALCONOATH_HOME) never reads the real VPA by default."""
    if os.environ.get("FALCONOATH_VPA"):
        return Path(os.environ["FALCONOATH_VPA"])
    if os.environ.get("FALCONOATH_HOME"):
        return None
    return paths.ROOT.parent / "vehicle-price-analysis"


def vpa_db() -> Path | None:
    d = vpa_dir()
    return d / "data" / "vpa.db" if d else None


def signature() -> tuple | None:
    """vpa.db's size and date: a stat, never an open."""
    if vpa_db() is None:
        return None
    try:
        st = vpa_db().stat()
        return (st.st_size, st.st_mtime)
    except OSError:
        return None


def read():
    """VPA's analysis frame (pandas), read-only, Falcons only."""
    sys.path.insert(0, str(vpa_dir()))
    try:
        from vpa.store import read_frame
    finally:
        sys.path.pop(0)
    df = read_frame(vpa_db())
    return df[(df["make"] == "Ford") & (df["model"] == "Falcon")]


def _group(g, recent_from) -> dict:
    p = g["price_aud"]
    km = g["odometer_km"].dropna()
    return {"cars": int(len(g)), "median": int(round(p.median())), "mean": int(round(p.mean())),
            "p25": int(round(p.quantile(0.25))), "p75": int(round(p.quantile(0.75))),
            "km": int(round(km.median())) if len(km) else None,
            "recent": int((g["capture_date"] >= recent_from).sum())}


def summarise(df) -> dict:
    """The averages, from VPA's frame (or any frame with its columns)."""
    import pandas as pd
    f = df[df["generation"].isin(GEN_MODEL)].copy()
    if "condition" in f:
        f = f[~f["condition"].fillna("").str.lower().isin(NOT_USED)]
    f = f[f["price_aud"].notna() & (f["price_aud"] >= MIN_PRICE)]
    f["capture_date"] = pd.to_datetime(f["capture_date"])
    out = {"format": FORMAT, "models": {}, "cars": 0, "first": None, "last": None}
    if f.empty:
        return out
    last = f.sort_values(["capture_date"]).groupby("key").tail(1).copy()     # one price per car: its latest
    last["fo_model"] = last["generation"].map(GEN_MODEL)
    newest = f["capture_date"].max()
    recent_from = newest - pd.Timedelta(days=RECENT_DAYS)
    out.update(cars=int(len(last)), first=f["capture_date"].min().date().isoformat(), last=newest.date().isoformat(),
               recent_days=RECENT_DAYS)
    for m, g in last.groupby("fo_model"):
        d = _group(g, recent_from)
        d["series"] = [dict(name=str(k), **_group(x, recent_from))
                       for k, x in sorted(g.groupby("generation"), key=lambda kv: list(GEN_MODEL).index(kv[0]))]
        trims = g["trim_base"].fillna("").replace("", "Other")
        d["trims"] = sorted((dict(name=str(k), **_group(x, recent_from)) for k, x in g.groupby(trims)),
                            key=lambda t: (-t["cars"], t["name"]))
        out["models"][m] = d
    return out


def build(out: Path | None = None) -> dict:
    """Read VPA, write data/prices.json (atomically). Returns the summary."""
    from .build import _write_atomic
    out = out or (paths.DATA / "prices.json")
    t0 = time.monotonic()
    s = summarise(read())
    s["read_secs"] = round(time.monotonic() - t0, 1)
    s["vpa_signature"] = list(signature() or [])
    out.parent.mkdir(parents=True, exist_ok=True)
    _write_atomic(out, json.dumps(s, indent=1).encode("utf-8"))
    return s


def load() -> dict | None:
    """data/prices.json, for build.py's snapshot (None if never built)."""
    try:
        d = json.loads((paths.DATA / "prices.json").read_text(encoding="utf-8"))
        return d if d.get("format") == FORMAT else None
    except (OSError, ValueError):
        return None
