"""The inbox: what devices send (new cars, FORScan scans), as files.

The listener's half, so standard library only and no route to a database:
it checks a request's shape and size, then writes it whole to
data/inbox/<time>-<device>-<random>.json, atomically. The laptop applies it
later in a separate process (apply.py: validate, back up, write falcon.db),
and the result reaches the device in the next data copy.

A device keeps each item in its outbox until the data copy says what became
of it, and may send it again meanwhile. Item ids are UUIDs, so a resent item
is recognised and applied once.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from . import paths

INBOX = paths.DATA / "inbox"
MAX_BODY = 1_500_000            # one request: a few scans (a scan is ~5-15 KB)
MAX_ITEMS = 50
MAX_PENDING_FILES = 200         # past this, refuse until the laptop catches up
KINDS = ("car", "scan")
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class Refused(ValueError):
    pass


def pending() -> list[Path]:
    try:
        return sorted(INBOX.glob("*.json"))
    except OSError:
        return []


def check_shape(body: dict) -> list[dict]:
    """The items, if the request is the right shape. Content is checked
    properly by apply.py; this only keeps junk out of the inbox."""
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise Refused("nothing to send")
    if len(items) > MAX_ITEMS:
        raise Refused(f"at most {MAX_ITEMS} items at once")
    out = []
    for it in items:
        if not isinstance(it, dict) or it.get("kind") not in KINDS \
                or not isinstance(it.get("id"), str) or not ID_RE.match(it["id"]) \
                or not isinstance(it.get("data"), dict):
            raise Refused("an item is not in the expected form")
        out.append({"id": it["id"], "kind": it["kind"], "data": it["data"],
                    "created": str(it.get("created") or "")[:40]})
    return out


def receive(device: dict, body: dict) -> dict:
    """Write one request to the inbox. Returns {"ok", "received": [ids]}."""
    items = check_shape(body)
    if len(pending()) >= MAX_PENDING_FILES:
        raise Refused("the laptop has a backlog - try again in a minute")
    INBOX.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dev = re.sub(r"[^0-9a-z]", "", str(device.get("id", "")))[:16] or "device"
    name = f"{stamp}-{dev}-{secrets.token_hex(3)}.json"
    doc = {"device": {"id": device.get("id"), "name": device.get("name")},
           "received_at": datetime.now().isoformat(sep=" ", timespec="seconds"), "items": items}
    tmp = INBOX / f".{name}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    for i in range(40):
        try:
            os.replace(tmp, INBOX / name)
            break
        except PermissionError:
            if i == 39:
                raise
            time.sleep(0.025 * (1 + i // 8))
    return {"ok": True, "received": [it["id"] for it in items]}
