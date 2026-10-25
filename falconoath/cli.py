"""python -m falconoath <command>

    setup        init + import-dtc + build: everything step 1 needs
    init         create data/falcon.db, or bring its schema up to date
    import-dtc   data/sources/dtc.db -> falcon.db (backup first; same file twice adds nothing)
    build        the data copy for devices (writes nothing if unchanged)
    serve        the listener on 127.0.0.1:8767; rebuilds the copy when falcon.db changes
    pair         show a six-digit code to pair a phone or browser (10 minutes)
    devices      list paired devices
    unpair ID    remove a device (or --all)
    status       Tailscale's view of the HTTPS route, read-only
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime

from . import APP_NAME, paths


def _au(ts: str | None) -> str:
    """'2026-10-25 14:03:00' -> '25/10/2026 14:03'."""
    if not ts:
        return "-"
    try:
        return datetime.fromisoformat(ts).strftime("%d/%m/%Y %H:%M")
    except ValueError:
        return ts


def cmd_init(a) -> int:
    from . import db
    r = db.init()
    if r["from"] == r["to"]:
        print(f"falcon.db is up to date (schema {r['to']}).")
    else:
        print(f"falcon.db {'created' if r['created'] else 'updated'}: schema {r['from']} -> {r['to']}."
              + (f" Backup: {r['backup'].name}" if r["backup"] else ""))
    return 0


def cmd_import_dtc(a) -> int:
    from . import dtc_import
    r = dtc_import.import_dtc(a.source)
    if r["skipped"]:
        print(f"DTC source unchanged ({r['reason']}); {r['rows']} rows in falcon.db.")
    else:
        print(f"Imported {r['added']} DTC rows (replaced {r['replaced']}). "
              f"Backup: {r['backup'] or 'none (new database)'}")
        if r["unknown_models"]:
            print("  skipped rows for unknown models:", ", ".join(r["unknown_models"]))
        if not r["source_unchanged"]:
            print("  WARNING: the source file changed while it was read")
            return 1
    return 0


def cmd_build(a) -> int:
    from . import build
    r = build.build(force=a.force)
    if not a.quiet or r["written"]:
        c = r["counts"]
        print(f"{'Built' if r['written'] else 'Unchanged'}: {r['file']} "
              f"({c['dtc']} DTC rows, {c['codes']} codes)", flush=True)
    return 0


def cmd_setup(a) -> int:
    a.source, a.force, a.quiet = None, False, False
    return cmd_init(a) or cmd_import_dtc(a) or cmd_build(a)


def _rebuild() -> None:
    """Build in a child process, so this process (the listener's) never opens
    the database itself."""
    subprocess.run([sys.executable, "-X", "utf8", "-m", "falconoath", "build", "--quiet"],
                   cwd=str(paths.ROOT))


def cmd_serve(a) -> int:
    from . import srv
    _rebuild()
    try:
        s = srv.start(a.port, log_meta=a.log_meta)
    except OSError as e:
        print(f"Can't listen on 127.0.0.1:{a.port} ({e}). Is {APP_NAME} already running?")
        return 1
    print(f"{APP_NAME} listening on http://127.0.0.1:{a.port}")
    print(f"  laptop:  http://localhost:{a.port}  (or the Tailscale address below)")
    if not a.no_tailscale:
        from . import tailnet
        t = tailnet.check(a.port)
        if t["state"] == "ready":
            print(f"  phone:   {t['url']}")
        elif t["state"] == "funnel":
            print(f"  DANGER: Tailscale Funnel is ON for {t['url']} - this publishes "
                  f"{APP_NAME} to the internet. Run: tailscale funnel reset")
        else:
            print(f"  phone:   not ready ({t['state']}). Once, run: {t['command']}")
    keys = _console_keys()
    print("\n" + (KEYS_HELP if keys else "  pair a device: Pair.bat  (or python -m falconoath pair)") + "\n", flush=True)
    last = paths.DB.stat().st_mtime if paths.DB.exists() else 0
    changed_at, next_check = None, time.monotonic() + 4
    try:
        while True:
            time.sleep(0.1)
            k = keys() if keys else None
            if k and on_key(k, a) == "quit":
                break
            if time.monotonic() < next_check:
                continue
            next_check = time.monotonic() + 4
            m = paths.DB.stat().st_mtime if paths.DB.exists() else 0
            if m != last:
                last, changed_at = m, time.monotonic()
            elif changed_at and time.monotonic() - changed_at >= 2.5:
                changed_at = None
                _rebuild()
    except KeyboardInterrupt:
        pass
    finally:
        print("Stopped.")
        s.shutdown()
    return 0


KEYS_HELP = ("  Keys:  P = pairing code for a phone or browser    D = paired devices\n"
             "         S = Tailscale status    Q = stop")


def _console_keys():
    """A function returning the key just pressed in this window (or None),
    when this is a Windows console; None when there is no console to read
    (run from a test or a pipe)."""
    try:
        import msvcrt
    except ImportError:
        return None
    if not sys.stdin or not sys.stdin.isatty():
        return None

    def read():
        if not msvcrt.kbhit():
            return None
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):          # arrows and function keys: two parts, ignored
            msvcrt.getwch()
            return None
        return ch
    return read


def on_key(ch: str, a) -> str | None:
    """What a key pressed in the listener window does."""
    ch = (ch or "").lower()
    if ch == "p":
        cmd_pair(a)
    elif ch == "d":
        cmd_devices(a)
    elif ch == "s":
        cmd_status(argparse.Namespace(json=False))
    elif ch == "q":
        return "quit"
    elif ch in ("h", "?", "\r", " "):
        print(KEYS_HELP)
    else:
        return None
    print(flush=True)
    return None


def cmd_pair(a) -> int:
    from . import cfg
    r = cfg.start_pairing()
    if not r["ok"]:
        print(r["error"])
        return 1
    code = r["code"]
    print(f"\n   Pairing code:  {code[:3]} {code[3:]}\n")
    print(f"On the phone (or browser): {APP_NAME} -> Settings -> Pair this device, and type it.")
    print("It lasts 10 minutes or 5 wrong tries. The listener window must stay open.")
    return 0


def cmd_devices(a) -> int:
    from . import cfg
    p = cfg.public()
    if not p["devices"]:
        print("No devices paired.")
    for d in p["devices"]:
        print(f"{d['id']}  {d['name']:<28} paired {_au(d['paired'])}  "
              f"last sync {_au(d['last_seen'])}")
    if p["pairing"]:
        left = int(p["pairing"]["expires"] - time.time())
        print(f"A pairing code is showing ({left // 60} min left).")
    return 0


def cmd_unpair(a) -> int:
    from . import cfg
    if not a.all and not a.id:
        print("Give a device ID (see: python -m falconoath devices) or --all.")
        return 2
    r = cfg.remove_device(a.id, everything=a.all)
    print(f"Removed {r['removed']} device(s)." if r["ok"] else r["error"])
    return 0 if r["ok"] else 1


def cmd_status(a) -> int:
    from . import tailnet
    t = tailnet.check()
    if a.json:
        print(json.dumps(t, indent=1))
        return 0
    say = {"missing": "Tailscale is not installed on this laptop.",
           "stopped": "Tailscale is not running.",
           "no-https": "HTTPS certificates are not enabled for this tailnet (admin console -> DNS).",
           "not-served": f"Not served yet. Once, run:  {t['command']}",
           "funnel": "DANGER: Funnel is on for FalconOath's port. Run: tailscale funnel reset",
           "ready": f"Ready: {t.get('url')} -> 127.0.0.1:{paths.PORT} (tailnet only)"}
    print(say.get(t["state"], t["state"]))
    if t.get("vpa_443"):
        print(f"VPA's route (443) is untouched: -> {t['vpa_443']}")
    if t.get("funnel_any"):
        print("Funnel is on for:", ", ".join(t["funnel_any"]))
    for p in t.get("peers", []):
        print(f"  peer {p['name']} ({p['os']}): {'online' if p['online'] else 'offline'}")
    return 1 if t["state"] == "funnel" else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m falconoath", description=APP_NAME)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")
    sub.add_parser("init")
    p = sub.add_parser("import-dtc")
    p.add_argument("--source", default=None)
    p = sub.add_parser("build")
    p.add_argument("--force", action="store_true")
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("serve")
    p.add_argument("--port", type=int, default=paths.PORT)
    p.add_argument("--log-meta", action="store_true", help="log every /api/meta check too")
    p.add_argument("--no-tailscale", action="store_true")
    sub.add_parser("pair")
    sub.add_parser("devices")
    p = sub.add_parser("unpair")
    p.add_argument("id", nargs="?")
    p.add_argument("--all", action="store_true")
    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    return {"setup": cmd_setup, "init": cmd_init, "import-dtc": cmd_import_dtc,
            "build": cmd_build, "serve": cmd_serve, "pair": cmd_pair, "devices": cmd_devices,
            "unpair": cmd_unpair, "status": cmd_status}[a.cmd](a)
