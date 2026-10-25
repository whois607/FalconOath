"""python -m falconoath <command>

    setup        init + import-dtc + build + library: everything to start with
    init         create data/falcon.db, or bring its schema up to date
    import-dtc   data/sources/dtc.db -> falcon.db (backup first; same file twice adds nothing)
    build        the data copy for devices (writes nothing if unchanged)
    open         start the listener in its own window if it isn't running, then open the app
    serve        the listener on 127.0.0.1:8767; rebuilds the copy when falcon.db changes
    pair         show a six-digit code to pair a phone or browser (10 minutes)
    devices      list paired devices
    unpair ID    remove a device (or --all)
    status       Tailscale's view of the HTTPS route, read-only
    import-scan  a FORScan DTC report (TXT) from this laptop -> falcon.db (backup first)
    cars         list cars and their scans
    apply        apply what devices sent (data/inbox/); serve does this by itself
    library      read new or changed PDFs in manuals/ and update the manuals' copy;
                 serve does this by itself whenever the folders change
    import-log   a FORScan live-data CSV from this laptop -> falcon.db (backup first)
    logs         list the live-data logs
    logs-folder  show or set the folder watched for FORScan's CSVs (PATH, --off, --default)
    watch-logs   import new CSVs from that folder now; serve does this by itself
    prices       read VPA's Falcon asking prices (read-only) into the averages; serve
                 does this by itself whenever VPA's data changes
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
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
        if not getattr(a, "quiet", False):
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
    return cmd_init(a) or cmd_import_dtc(a) or cmd_build(a) or cmd_library(a)


def _child(*args: str) -> None:
    """Run a command in a child process, so this process (the listener's)
    never opens the database itself."""
    subprocess.run([sys.executable, "-X", "utf8", "-m", "falconoath", *args], cwd=str(paths.ROOT))


def _rebuild() -> None:
    _child("build", "--quiet")


def cmd_library(a) -> int:
    from . import library
    root = library.ensure_folders()
    if not a.quiet:
        print(f"Manuals: {root}")
    n = library.index(progress=library.build)       # the copy grows as PDFs are read
    b = library.build()
    c = b["counts"]
    if not a.quiet or n["read"] or n["removed"] or b["written"]:
        print(f"Manuals: {c['manuals']} PDFs, {c['pages']:,} pages ({c['text_pages']:,} with text)"
              + (f"; read {n['read']} new" if n["read"] else "")
              + (f", {n['removed']} gone" if n["removed"] else "")
              + (f", {n['errors']} couldn't be read" if n["errors"] else "")
              + ("" if b["written"] or n["read"] or n["removed"] else "; no change"), flush=True)
    return 0


class LogWatcher:
    """Imports new CSVs from FORScan's folder in a child process, once the
    folder has been still for a while (FORScan may still be writing)."""

    def __init__(self):
        self.proc, self.sig, self.done_sig, self.changed = None, None, None, 0.0

    def tick(self) -> None:
        from . import livelogs
        if self.proc is not None:
            if self.proc.poll() is None:
                return
            self.proc = None
        sig = livelogs.signature(livelogs.folder())
        if sig != self.sig:
            self.sig, self.changed = sig, time.monotonic()
            return
        if sig == self.done_sig or time.monotonic() - self.changed < livelogs.SETTLE + 1:
            return
        self.done_sig = sig
        self.proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "watch-logs", "--quiet"],
                                     cwd=str(paths.ROOT))

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


class PriceWatcher:
    """Re-reads VPA's prices in a child process when vpa.db has changed and
    then been still for a minute (VPA's import is finished). Only ever
    stats the file; the child reads it read-only."""

    def __init__(self):
        self.proc, self.sig, self.done_sig, self.changed = None, None, None, 0.0

    def tick(self) -> None:
        from . import vpa_prices
        if self.proc is not None:
            if self.proc.poll() is None:
                return
            self.proc = None
        sig = vpa_prices.signature()
        if sig != self.sig:
            self.sig, self.changed = sig, time.monotonic()
            if self.done_sig is None and sig is not None and not (paths.DATA / "prices.json").exists():
                self.changed -= 60                       # never read yet: no need to wait
            return
        if sig is None or sig == self.done_sig or time.monotonic() - self.changed < 60:
            return
        self.done_sig = sig
        self.proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "prices", "--quiet"],
                                     cwd=str(paths.ROOT))

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


class Indexer:
    """Reads manuals in a child process while the listener keeps serving:
    a big workshop manual takes a minute or so. Started again whenever the
    folders change (a PDF added, removed or renamed, or one from a device)."""

    def __init__(self):
        self.proc, self.sig = None, None

    def tick(self) -> None:
        from . import library
        if self.proc is not None:
            if self.proc.poll() is None:
                return
            self.proc = None
        sig = library.signature()
        if sig == self.sig:
            return
        self.sig = sig
        self.proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "library", "--quiet"],
                                     cwd=str(paths.ROOT))

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


def cmd_serve(a) -> int:
    from . import inbox, srv
    if sys.platform == "win32" and sys.stdin and sys.stdin.isatty():
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW(f"{APP_NAME} listener")
    _child("init", "--quiet")
    if inbox.pending():
        _child("apply")
    _rebuild()
    idx, logw, pricew = Indexer(), LogWatcher(), PriceWatcher()
    idx.tick()
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
            if inbox.pending():                 # a device sent something: apply it, then rebuild now
                _child("apply")
                _rebuild()
            idx.tick()
            logw.tick()
            pricew.tick()
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
        idx.stop()
        logw.stop()
        pricew.stop()
        s.shutdown()
    return 0


KEYS_HELP = ("  Keys:  P = pairing code for a phone or browser    D = paired devices\n"
             "         M = open the manuals folder    S = Tailscale status    Q = stop")


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
    elif ch == "m":
        from . import library
        root = library.ensure_folders()
        print(f"Manuals: {root}  (one folder per model; PDFs are read within a few seconds)")
        if hasattr(os, "startfile"):
            os.startfile(root)
    elif ch == "q":
        return "quit"
    elif ch in ("h", "?", "\r", " "):
        print(KEYS_HELP)
    else:
        return None
    print(flush=True)
    return None


def _ping(port: int) -> bool:
    """Is FalconOath's listener answering on this port?"""
    import urllib.request
    from . import cfg
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=1) as r:
            return json.loads(r.read()).get("app") == cfg.APP_ID
    except (OSError, ValueError):
        return False


def _message(text: str) -> None:
    """A message box when there's no console to print to (the desktop icon)."""
    print(text)
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x30)


def cmd_open(a) -> int:
    """The desktop icon: start the listener in its own window if it isn't
    running yet, then open the app in the browser."""
    import webbrowser
    url = f"http://localhost:{a.port}/"
    if not _ping(a.port):
        py = sys.executable
        if py.lower().endswith("pythonw.exe"):          # the listener needs a console for its keys
            py = py[:-len("pythonw.exe")] + "python.exe"
        args = [py, "-X", "utf8", "-m", "falconoath", "serve", "--port", str(a.port)]
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        subprocess.Popen(args, cwd=str(paths.ROOT), creationflags=flags)
        t0 = time.monotonic()
        while not _ping(a.port):
            if time.monotonic() - t0 > 60:
                _message(f"{APP_NAME} didn't start within a minute. "
                         f"Look in the \"{APP_NAME} listener\" window for the reason.")
                return 1
            time.sleep(0.3)
    webbrowser.open(url)
    return 0


def cmd_apply(a) -> int:
    from . import apply
    for f in apply.apply_pending():
        if f.get("error"):
            print(f"{time.strftime('%H:%M:%S')} inbox {f['file']}: {f['error']}", flush=True)
            continue
        for r in f["results"]:
            print(f"{time.strftime('%H:%M:%S')} from a device: {r.get('kind', '')} {r['result']}"
                  + (f" - {r['detail']}" if r.get("detail") else ""), flush=True)
    return 0


def _car_name(c) -> str:
    m = {"FGX": "FG X"}.get(c["model"], c["model"] or "")
    return c["nickname"] or " ".join(str(x) for x in (c["year"], m) if x) or c["id"][:8]


def cmd_import_scan(a) -> int:
    from . import apply
    new_car = None
    if a.new_car is not None:
        new_car = {"nickname": a.new_car, "model": a.model, "year": a.year, "vin": a.vin, "kind": a.kind}
    for f in a.files:
        try:
            r = apply.import_scan_file(f, car_id=a.car, new_car=new_car, scanned_on=a.date, note=a.note or "")
        except apply.Invalid as e:
            print(f"{f}: not imported - {e}")
            return 1
        if new_car is not None and r["car_id"]:
            a.car, new_car = r["car_id"], None          # the next files go on the same new car
        print(f"{f}: {r['result']}" + (f" ({r['detail']})" if r["detail"] else "")
              + f"  scan {r['scan_id'][:8]}" + (f"  car {r['car_id'][:8]}" if r["car_id"] else ""))
    return 0


def cmd_import_log(a) -> int:
    from . import livelogs
    new_car = None
    if a.new_car is not None:
        new_car = {"nickname": a.new_car, "model": a.model, "year": a.year, "vin": a.vin, "kind": a.kind}
    for f in a.files:
        try:
            r = livelogs.import_file(f, car_id=a.car, new_car=new_car, recorded_on=a.date, note=a.note or "")
        except (livelogs.Invalid, ValueError) as e:
            print(f"{f}: not imported - {e}")
            return 1
        if new_car is not None and r["car_id"]:
            a.car, new_car = r["car_id"], None
        print(f"{f}: {r['result']}" + (f" ({r['detail']})" if r["detail"] else "")
              + f"  log {r['log_id'][:8]}" + (f"  car {r['car_id'][:8]}" if r["car_id"] else ""))
    return 0


def cmd_logs(a) -> int:
    from . import db
    db.init()
    c = db.connect_ro(paths.DB)
    try:
        rows = c.execute("SELECT l.id, l.file_name, l.rows, l.duration_ms, l.recorded_on, l.origin, c.nickname, c.model "
                         "FROM logs l LEFT JOIN cars c ON c.id = l.car_id ORDER BY coalesce(l.recorded_on, l.imported_at)").fetchall()
    finally:
        c.close()
    if not rows:
        print("No live-data logs yet.")
    for lid, name, n, ms, on, origin, nick, model in rows:
        car = nick or model or ("(no car)" if not (nick or model) else "")
        print(f"{lid[:8]}  {_au(on)[:10]:<10}  {ms / 1000:7.0f} s  {n:>7,} rows  {car:<18} {name}  [{origin}]")
    return 0


def cmd_logs_folder(a) -> int:
    from . import livelogs
    if a.off:
        livelogs.set_folder("")
    elif a.default:
        livelogs.set_folder(None)
    elif a.path:
        p = Path(a.path).expanduser().resolve()
        if not p.is_dir():
            print(f"No such folder: {p}")
            return 1
        livelogs.set_folder(str(p))
    f = livelogs.folder()
    print(f"Watching for FORScan logs in: {f}" if f else "Not watching any folder for FORScan logs.")
    return 0


def cmd_watch_logs(a) -> int:
    from . import livelogs
    f = livelogs.folder()
    if f is None:
        if not a.quiet:
            print("Not watching any folder (python -m falconoath logs-folder PATH).")
        return 0
    n = livelogs.watch(f)
    if n["new"] or not a.quiet:
        print(f"Logs from {f}: {n['new']} new, {n['known']} already in"
              + (f", {n['waiting']} still being written" if n["waiting"] else "")
              + (f", {n['skipped']} not logs" if n["skipped"] else ""), flush=True)
    return 0


def cmd_prices(a) -> int:
    from . import build, vpa_prices
    if vpa_prices.signature() is None:
        if not a.quiet:
            print(f"VPA's data isn't at {vpa_prices.vpa_db()}: no prices.")
        return 0
    try:
        s = vpa_prices.build()
    except Exception as e:                       # VPA busy or changed: keep the last averages
        print(f"Couldn't read VPA's prices ({type(e).__name__}: {e}); kept the last ones.")
        return 1
    print(f"Prices from VPA: {s['cars']:,} Falcons (BA-FG X), {s['first'] or '-'} to {s['last'] or '-'}, read in {s['read_secs']} s"
          + "".join(f"; {m} median ${d['median']:,}" for m, d in s["models"].items()), flush=True)
    r = build.build()
    if r["written"] and not a.quiet:
        print(f"Built: {r['file']}")
    return 0


def cmd_cars(a) -> int:
    from . import db
    db.init()
    c = db.connect_ro(paths.DB)
    try:
        c.row_factory = __import__("sqlite3").Row
        cars = c.execute("SELECT * FROM cars ORDER BY created_at").fetchall()
        scans = c.execute("SELECT car_id, count(*) n, max(scanned_on) last FROM scans GROUP BY car_id").fetchall()
    finally:
        c.close()
    per = {r["car_id"]: r for r in scans}
    if not cars and not per:
        print("No cars or scans yet.")
    for car in cars:
        s = per.get(car["id"])
        print(f"{car['id']}  {_car_name(car):<24} {car['vin'] or '':<17}  {car['kind']:<5} "
              f"{(s['n'] if s else 0)} scan(s)" + (f", last {_au(s['last'])[:10]}" if s and s["last"] else ""))
    if None in per:
        print(f"(no car)  {per[None]['n']} scan(s) not attached to a car")
    return 0


def cmd_trims(a) -> int:
    from . import db
    db.init()
    c = db.connect_ro(paths.DB)
    try:
        trims = c.execute("SELECT t.id, t.model, t.series, t.name, t.body, (SELECT count(*) FROM trim_facts f WHERE f.trim_id = t.id) "
                          "FROM trims t ORDER BY t.model, t.series, t.name").fetchall()
        whole = c.execute("SELECT model, series, count(*) FROM trim_facts WHERE trim_id IS NULL GROUP BY model, series").fetchall()
    finally:
        c.close()
    if not trims and not whole:
        print("No trims yet: put brochures in manuals/<model>/Brochures and read them in Browse.")
    for tid, model, series, name, body, n in trims:
        print(f"{tid[:8]}  {model:<4} {series or '-':<10} {name:<20} {body or '':<12} {n} fact(s)")
    for model, series, n in whole:
        print(f"{'':8}  {model:<4} {series or '-':<10} {'(whole series)':<20} {'':<12} {n} fact(s)")
    return 0


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
    p = sub.add_parser("init")
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("import-dtc")
    p.add_argument("--source", default=None)
    p = sub.add_parser("build")
    p.add_argument("--force", action="store_true")
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("open", help="start the listener if needed, then open the app (the desktop icon)")
    p.add_argument("--port", type=int, default=paths.PORT)
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
    sub.add_parser("apply")
    p = sub.add_parser("import-log", help="FORScan live-data CSV(s) -> falcon.db")
    p.add_argument("files", nargs="+")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--car", help="the car's id (see: cars)")
    g.add_argument("--new-car", metavar="NICKNAME")
    p.add_argument("--model", choices=["BA", "BF", "FG", "FGX"])
    p.add_argument("--year", type=int)
    p.add_argument("--vin")
    p.add_argument("--kind", choices=["mine", "other", "ad"], default="mine")
    p.add_argument("--date", help="recorded YYYY-MM-DD (default: the file's date)")
    p.add_argument("--note")
    sub.add_parser("logs")
    p = sub.add_parser("logs-folder", help="the folder watched for FORScan's CSVs")
    p.add_argument("path", nargs="?")
    p.add_argument("--off", action="store_true")
    p.add_argument("--default", action="store_true")
    p = sub.add_parser("prices", help="VPA's Falcon asking prices (read-only) -> averages")
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("watch-logs")
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("library", help="read new PDFs in manuals/ and update the manuals' copy")
    p.add_argument("--quiet", action="store_true")
    sub.add_parser("cars")
    sub.add_parser("trims", help="the trims read from your brochures")
    p = sub.add_parser("import-scan", help="FORScan DTC TXT file(s) -> falcon.db")
    p.add_argument("files", nargs="+")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--car", help="the car's id (see: cars)")
    g.add_argument("--new-car", metavar="NICKNAME", help="make a new car for these scans")
    p.add_argument("--model", choices=["BA", "BF", "FG", "FGX"])
    p.add_argument("--year", type=int)
    p.add_argument("--vin")
    p.add_argument("--kind", choices=["mine", "other", "ad"], default="mine")
    p.add_argument("--date", help="scan date YYYY-MM-DD (default: the file's date)")
    p.add_argument("--note")
    a = ap.parse_args(argv)
    return {"setup": cmd_setup, "init": cmd_init, "import-dtc": cmd_import_dtc,
            "build": cmd_build, "open": cmd_open, "serve": cmd_serve, "pair": cmd_pair, "devices": cmd_devices,
            "unpair": cmd_unpair, "status": cmd_status,
            "apply": cmd_apply, "library": cmd_library, "import-log": cmd_import_log, "logs": cmd_logs,
            "logs-folder": cmd_logs_folder, "watch-logs": cmd_watch_logs, "prices": cmd_prices, "cars": cmd_cars, "trims": cmd_trims, "import-scan": cmd_import_scan}[a.cmd](a)
