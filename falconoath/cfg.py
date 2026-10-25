"""Settings, paired devices and pairing codes: data/settings.json.

Adapted from VPA's vpa/phonecfg.py. The CLI (which starts pairing) and the
listener (which checks tokens and redeems codes) are separate processes, so
every change is a read-modify-write under a lock file, written atomically.

Standard library only, and no route to any database: the listener imports
this and nothing else of ours that could open one (tests/check_srv.py walks
the imports to prove it).

    devices   paired phones and browsers: a name and the SHA-256 of their
              token. The token itself only ever exists on the device.
    pair      the pairing code showing right now, if any (hashed), with its
              expiry and the wrong guesses so far.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from . import paths

APP_ID = "falconoath"
PAIR_SECONDS = 600            # a pairing code lasts ten minutes
PAIR_TRIES = 5                # ...or five wrong guesses
MAX_DEVICES = 10

DEFAULTS = {"devices": [], "pair": None,
            "logs_folder": None}     # FORScan's folder to watch: a path, "" = off, None = FORScan's usual one


def _now() -> str:
    return datetime.now().isoformat(sep=" ", timespec="seconds")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ storage
@contextmanager
def _locked(timeout: float = 8.0):
    """Cross-process lock: a lock file created exclusively. One left by a
    crashed process is taken over after 15 s."""
    lock = paths.SETTINGS.with_name(paths.SETTINGS.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 15:
                    lock.unlink()
                    continue
            except OSError:
                pass
            if time.monotonic() - t0 > timeout:
                raise TimeoutError("settings are busy - try again")
            time.sleep(0.03)
    try:
        yield
    finally:
        os.close(fd)
        try:
            lock.unlink()
        except OSError:
            pass


def _replace(src: Path, dst: Path, tries: int = 40) -> None:
    """os.replace, retried while Windows or OneDrive holds the target."""
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.025 * (1 + i // 8))


def read_text_retry(path: Path, tries: int = 40) -> str:
    """read_text, retried while Windows briefly refuses it (the moment a
    writer's replace lands). Treating that as "no file" would make a paired
    phone look unpaired."""
    for i in range(tries):
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.025 * (1 + i // 8))
    raise OSError(path)


def load() -> dict:
    """The settings with defaults. Unreadable means nothing paired: the safe
    way to fail."""
    s = json.loads(json.dumps(DEFAULTS))
    try:
        d = json.loads(read_text_retry(paths.SETTINGS))
        if isinstance(d, dict):
            s.update({k: d[k] for k in DEFAULTS if k in d})
    except (OSError, ValueError):
        pass
    s["devices"] = [d for d in (s.get("devices") or []) if isinstance(d, dict)]
    return s


def update(fn) -> dict:
    """Apply fn(settings) under the lock and write atomically. fn's return
    value, if not None, comes back under "_result" (never saved)."""
    with _locked():
        s = load()
        res = fn(s)
        s.pop("_result", None)
        tmp = paths.SETTINGS.with_name(paths.SETTINGS.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
        _replace(tmp, paths.SETTINGS)
    if res is not None:
        s = dict(s, _result=res)
    return s


# ------------------------------------------------------------------ the copy
def read_meta() -> dict | None:
    """output/phone/meta.json: which snapshot is current (build.py writes it)."""
    try:
        m = json.loads(read_text_retry(paths.OUT / "meta.json"))
        return m if isinstance(m, dict) and m.get("file") else None
    except (OSError, ValueError):
        return None


def snapshot_path(meta: dict) -> Path:
    name = str(meta.get("file", ""))
    if "/" in name or "\\" in name or ".." in name or not name.startswith("snapshot-"):
        raise ValueError("bad snapshot name in meta.json")
    return paths.OUT / name


def read_library_meta() -> dict | None:
    """output/phone/library-meta.json: the manuals' copy (library.py writes it)."""
    try:
        m = json.loads(read_text_retry(paths.OUT / "library-meta.json"))
        name = str(m.get("file", "")) if isinstance(m, dict) else ""
        if not name.startswith("library-") or "/" in name or "\\" in name or ".." in name:
            return None
        return m
    except (OSError, ValueError):
        return None


def manual_path(sha: str) -> Path | None:
    """The PDF with this SHA-256, by library-files.json; only ever a file
    inside manuals/."""
    if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        return None
    try:
        rel = json.loads(read_text_retry(paths.OUT / "library-files.json")).get(sha)
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(rel, str) or not rel.lower().endswith(".pdf"):
        return None
    root = paths.MANUALS.resolve()
    p = (root / rel).resolve()
    return p if p.is_relative_to(root) and p.is_file() else None


# ------------------------------------------------------------------ pairing
def start_pairing() -> dict:
    """A fresh six-digit code, shown on the laptop and typed on the device.
    Only its hash is stored; it lasts ten minutes or five wrong guesses."""
    code = f"{secrets.randbelow(10 ** 6):06d}"
    exp = time.time() + PAIR_SECONDS

    def f(s):
        if len(s["devices"]) >= MAX_DEVICES:
            return "full"
        s["pair"] = {"code": _sha(code), "expires": exp, "tries": 0}
    if update(f).get("_result") == "full":
        return {"ok": False, "error": f"{MAX_DEVICES} devices are paired already - "
                                      f"remove one first (Devices.bat shows how)"}
    return {"ok": True, "code": code, "expires": exp, "seconds": PAIR_SECONDS}


def redeem(code: str, name: str) -> dict:
    """The device's half of pairing. Right code: a new device and its token
    (returned once, never stored). Wrong code: one of five tries used."""
    code = "".join(ch for ch in str(code or "") if ch.isdigit())[:6]
    name = " ".join(str(name or "").split())[:40] or "Phone"
    token = secrets.token_urlsafe(32)

    def f(s):
        p = s.get("pair")
        if not isinstance(p, dict):
            return "none"
        if time.time() > float(p.get("expires", 0)):
            s["pair"] = None
            return "expired"
        if len(code) != 6 or not hmac.compare_digest(_sha(code), str(p.get("code"))):
            p["tries"] = int(p.get("tries", 0)) + 1
            if p["tries"] >= PAIR_TRIES:
                s["pair"] = None
                return "voided"
            return "wrong"
        dev = {"id": secrets.token_hex(4), "name": name, "token": _sha(token),
               "paired": _now(), "last_seen": None, "last_version": None}
        s["devices"].append(dev)
        s["pair"] = None
        return dev
    r = update(f).get("_result")
    if isinstance(r, dict):
        return {"ok": True, "token": token, "device": {"id": r["id"], "name": r["name"]}}
    return {"ok": False, "error": {
        "none": "no pairing code is showing on the laptop - press P in the FalconOath window there (or run Pair.bat)",
        "expired": "that code has expired - press P on the laptop for a new one",
        "voided": "too many wrong codes - press P on the laptop for a new one",
        "wrong": "that is not the code on the laptop - check it and try again",
    }[r]}


def device_for(token: str, settings: dict | None = None) -> dict | None:
    """The paired device this token belongs to, or None. Compared against
    every device in constant time."""
    if not token or len(token) > 200:
        return None
    s = settings or load()
    h = _sha(token)
    hit = None
    for d in s["devices"]:
        if hmac.compare_digest(h, str(d.get("token", ""))):
            hit = d
    return hit


def seen(device_id: str, version: str | None) -> None:
    """Record a sync. Written at most once a minute per device unless it took
    a new version, so syncing never churns the file."""
    s = load()
    d = next((d for d in s["devices"] if d.get("id") == device_id), None)
    if d is None:
        return
    if d.get("last_version") == version and d.get("_t", 0) > time.time() - 60:
        return

    def f(s):
        for d in s["devices"]:
            if d.get("id") == device_id:
                d["last_seen"] = _now()
                d["_t"] = time.time()
                if version:
                    d["last_version"] = version
    try:
        update(f)
    except (TimeoutError, OSError):
        pass                       # a missed "last seen" must never fail a sync


def remove_device(device_id: str | None = None, everything: bool = False) -> dict:
    def f(s):
        before = len(s["devices"])
        s["devices"] = [] if everything else \
            [d for d in s["devices"] if d.get("id") != device_id]
        return before - len(s["devices"])
    n = update(f).get("_result") or 0
    return {"ok": bool(n), "removed": n, **({} if n else {"error": "no such device"})}


def public(s: dict | None = None) -> dict:
    """The settings without secrets."""
    s = s or load()
    p = s.get("pair")
    live = isinstance(p, dict) and time.time() < float(p.get("expires", 0))
    return {"devices": [{k: d.get(k) for k in ("id", "name", "paired", "last_seen",
                                               "last_version")} for d in s["devices"]],
            "pairing": {"expires": p["expires"], "tries": p.get("tries", 0)} if live else None}
