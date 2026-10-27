"""python -m falconoath <command>

    setup        init + import-dtc + build + library: everything to start with
    init         create data/falcon.db, or bring its schema up to date
    import-dtc   data/sources/dtc.db -> falcon.db (backup first; same file twice adds nothing)
    build        the data copy for devices (writes nothing if unchanged)
    app          what FalconOath.exe does: start the listener out of sight if it
                 isn't running, then open FalconOath's own window (also: open)
    window       just the window (--at "#/scan/ID" to open at something)
    serve        the listener on 127.0.0.1:8767; rebuilds the copy when falcon.db changes
                 (--hidden: no console; it writes data/falconoath.log)
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


LOG = None              # the log file, when the listener runs out of sight (serve --hidden)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def self_cmd(*args: str) -> list[str]:
    """This program with a command: FalconOath.exe <command>, or python -m falconoath <command>."""
    if paths.FROZEN:
        return [sys.executable, *args]
    return [sys.executable, "-X", "utf8", "-m", "falconoath", *args]


def _popen(*args: str, wait: bool = False):
    """A child process of ours, writing to the log when there's no console
    to write to (and never flashing a console window)."""
    kw = {"cwd": str(paths.ROOT)}
    if LOG is not None:
        kw.update(stdout=LOG, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    return subprocess.run(self_cmd(*args), **kw) if wait else subprocess.Popen(self_cmd(*args), **kw)


def _child(*args: str) -> None:
    """Run a command in a child process, so this process (the listener's)
    never opens the database itself."""
    _popen(*args, wait=True)


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
    """Imports new logs and fault scans from FORScan's folder in a child
    process, once the folder has been still for a few seconds (FORScan may
    still be writing). tick() returns True when a child has just finished,
    so the listener can rebuild and show what came in straight away."""

    def __init__(self):
        self.proc, self.sig, self.done_sig, self.changed, self.started = None, None, None, 0.0, ""

    def tick(self) -> bool:
        from . import db, livelogs
        if self.proc is not None:
            if self.proc.poll() is None:
                return False
            self.proc = None
            return True
        sig = livelogs.signature(livelogs.folder())
        if sig != self.sig:
            self.sig, self.changed = sig, time.monotonic()
            return False
        if sig == self.done_sig or time.monotonic() - self.changed < livelogs.SETTLE + 0.5:
            return False
        self.done_sig, self.started = sig, db.now()
        self.proc = _popen("watch-logs", "--quiet")
        return False

    def new_items(self) -> list[tuple[str, str, str]]:
        """What the last child brought in from FORScan's folder that FORScan
        saved today or yesterday (not old files found for the first time):
        [(kind, id, file name)], newest last."""
        from datetime import date, timedelta
        from . import db
        if not self.started or not paths.DB.is_file():
            return []
        since = (date.today() - timedelta(days=1)).isoformat()
        c = db.connect_ro(paths.DB)
        try:
            rows = [("scan", *r) for r in c.execute(
                "SELECT id, file_name, imported_at FROM scans WHERE origin = 'forscan-folder' AND imported_at >= ? "
                "AND coalesce(scanned_on, '') >= ?", (self.started, since))]
            rows += [("log", *r) for r in c.execute(
                "SELECT id, file_name, imported_at FROM logs WHERE origin = 'forscan-folder' AND imported_at >= ? "
                "AND coalesce(recorded_on, '') >= ?", (self.started, since))]
        finally:
            c.close()
        return [(k, i, n) for k, i, n, _ in sorted(rows, key=lambda r: r[3])]

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
        self.proc = _popen("prices", "--quiet")

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
        self.proc = _popen("library", "--quiet")

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


def cmd_serve(a) -> int:
    from . import inbox, srv
    if a.hidden:
        _log_to_file()
    elif sys.platform == "win32" and sys.stdin and sys.stdin.isatty():
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
    print(f"{time.strftime('%d/%m/%Y %H:%M:%S')} {APP_NAME} listening on http://127.0.0.1:{a.port}")
    print(f"  laptop:  http://localhost:{a.port}  (or the Tailscale address below)")
    status = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "phone": None, "phone_state": "not checked", "phone_command": None}
    if not a.no_tailscale:
        from . import tailnet
        t = tailnet.check(a.port)
        status.update(phone=t.get("url"), phone_state=t["state"], phone_command=t.get("command"))
        if t["state"] == "ready":
            print(f"  phone:   {t['url']}")
        elif t["state"] == "funnel":
            print(f"  DANGER: Tailscale Funnel is ON for {t['url']} - this publishes "
                  f"{APP_NAME} to the internet. Run: tailscale funnel reset")
        else:
            print(f"  phone:   not ready ({t['state']}). Once, run: {t['command']}")
    _write_status(status)
    keys = None if a.hidden else _console_keys()
    print("\n" + (KEYS_HELP if keys else "  Pair a phone, devices, folders and Stop: Settings in FalconOath's window") + "\n", flush=True)
    last = _stamp()
    changed_at, next_check, next_watch = None, time.monotonic() + 4, time.monotonic() + 1
    try:
        while True:
            time.sleep(0.1)
            k = keys() if keys else None
            if k and on_key(k, a) == "quit":
                break
            if _laptop_actions() == "stop":      # Settings → Stop FalconOath, in its window
                break
            if time.monotonic() >= next_watch:  # FORScan's folder: every second, so a new scan shows at once
                next_watch = time.monotonic() + 1
                if logw.tick():
                    new = logw.new_items()
                    if new:
                        _rebuild()
                        last = _stamp()
                        _show_new(new, a.port)
            if time.monotonic() < next_check:
                continue
            next_check = time.monotonic() + 4
            if inbox.pending():                 # a device sent something: apply it, then rebuild now
                _child("apply")
                _rebuild()
            idx.tick()
            pricew.tick()
            m = _stamp()
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


def _stamp() -> tuple:
    """What a rebuild depends on that can change under the listener: falcon.db
    and the built-in reference (data/sources/reference.json)."""
    return tuple(p.stat().st_mtime if p.exists() else 0 for p in (paths.DB, paths.REFERENCE))


def _show_new(new: list, port: int) -> None:
    """Something new from FORScan's folder: the apps already open hear at
    once (/api/wait) and open it themselves. If FalconOath's window isn't
    open on this laptop, open it at the newest one (unless turned off in
    Settings, or with O)."""
    from . import cfg, srv
    kind, iid, name = new[-1]
    print(f"{time.strftime('%H:%M:%S')} ready to look at: {name}"
          + (f" (and {len(new) - 1} more)" if len(new) > 1 else ""), flush=True)
    if not cfg.load().get("open_new", True) or srv.laptop_app_open():
        return
    _popen("window", "--port", str(port), "--at", f"#/{'log' if kind == 'log' else 'scan'}/{iid}")


def _log_to_file() -> None:
    """The listener out of sight: what it would print goes to data/falconoath.log
    (and its children's too). Kept short: the older half is dropped past 2 MB."""
    global LOG
    f = paths.DATA / "falconoath.log"
    paths.DATA.mkdir(parents=True, exist_ok=True)
    try:
        if f.stat().st_size > 2_000_000:
            f.write_bytes(f.read_bytes()[-1_000_000:])
    except OSError:
        pass
    LOG = open(f, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = LOG


def _write_status(status: dict) -> None:
    """output/phone/laptop.json: what Settings shows in FalconOath's window
    (the phone's address, FORScan's folder). The listener reads it, so it
    needn't reach Tailscale or the folders itself."""
    from . import livelogs
    from .build import _write_atomic
    f = livelogs.folder()
    status["forscan"] = str(f) if f else None
    paths.OUT.mkdir(parents=True, exist_ok=True)
    _write_atomic(paths.OUT / "laptop.json", json.dumps(status, indent=1).encode("utf-8"))


def _laptop_actions() -> str | None:
    """Do what FalconOath's window asked for (srv.ACTIONS). Returns "stop" to stop."""
    import queue
    from . import library, livelogs, srv
    while True:
        try:
            do = srv.ACTIONS.get_nowait()
        except queue.Empty:
            return None
        if do == "stop":
            print(f"{time.strftime('%H:%M:%S')} stopped from FalconOath's window", flush=True)
            return "stop"
        target = library.ensure_folders() if do == "open:manuals" else livelogs.folder()
        if target is not None and hasattr(os, "startfile"):
            os.startfile(target)


KEYS_HELP = ("  Keys:  P = pairing code for a phone or browser    D = paired devices\n"
             "         M = open the manuals folder    S = Tailscale status    Q = stop\n"
             "         O = open new FORScan scans in the browser by itself (on/off)")


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
    elif ch == "o":
        from . import cfg
        on = not cfg.load().get("open_new", True)
        cfg.update(lambda s: s.__setitem__("open_new", on))
        print("New FORScan scans and logs will " + ("open in the browser by themselves (when the app isn't open)."
                                                     if on else "only show in the app when it's open."))
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


def cmd_app(a) -> int:
    """FalconOath.exe (and the desktop icon): start the listener out of
    sight if it isn't running yet (it keeps running when the window closes,
    so phones still sync), then open FalconOath's window."""
    if not _ping(a.port):
        py = sys.executable
        if py.lower().endswith("pythonw.exe"):
            py = py[:-len("pythonw.exe")] + "python.exe"
        args = ([py] if paths.FROZEN else [py, "-X", "utf8", "-m", "falconoath"]) + ["serve", "--hidden", "--port", str(a.port)]
        flags = NO_WINDOW | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(args, cwd=str(paths.ROOT), creationflags=flags, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        t0 = time.monotonic()
        while not _ping(a.port):
            if time.monotonic() - t0 > 60:
                _message(f"{APP_NAME} didn't start within a minute. The reason is at the end of "
                         f"{paths.DATA / 'falconoath.log'}")
                return 1
            time.sleep(0.3)
    a.at = getattr(a, "at", None)
    return cmd_window(a)


def cmd_window(a) -> int:
    """FalconOath's own window (WebView2, the engine inside Windows), on the
    listener. It carries a one-time code that pairs it as "This laptop" the
    first time; its data is kept in data/window/."""
    from . import cfg
    try:
        import webview
    except ImportError:                    # without pywebview: the browser, as before
        import webbrowser
        webbrowser.open(f"http://localhost:{a.port}/{a.at or ''}")
        return 0
    code = cfg.start_launch()
    url = f"http://localhost:{a.port}/?pair={code}{a.at or '#/'}"
    webview.create_window(APP_NAME, url, width=1280, height=860, min_size=(380, 520), background_color="#0b1422")
    webview.start(private_mode=False, storage_path=str(paths.DATA / "window"))
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
        print(f"From FORScan's folder ({f}): {n['new']} new, {n['known']} already in"
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


def cmd_reference(a) -> int:
    from . import reference
    r = reference.collect()
    if r["error"]:
        print(f"No built-in reference: {r['error']} ({paths.REFERENCE})")
        return 1
    from collections import Counter
    for m in reference.MODELS:
        t = [x for x in r["trims"] if x["model"] == m]
        f = Counter(x["kind"] for x in r["facts"] if x["model"] == m)
        sp = sum(1 for x in r["specs"] if x["model"] == m)
        print(f"{m:<4} {len(t)} trim(s), {sum(f.values())} fact(s) ({', '.join(f'{n} {k}' for k, n in sorted(f.items()))}), {sp} spec(s)")
    rows = r["trims"] + r["facts"] + r["specs"] + r["notes"]
    lost = sum(1 for x in rows if not x.get("research") and not x.get("doc_sha"))
    res = sum(1 for x in r["facts"] if x.get("research"))
    print(f"{res} research note(s), never shown as factory." + (f" {lost} cite a PDF that isn't in the library." if lost else
          " Every other entry links to its page."))
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
    for name in ("app", "open"):
        p = sub.add_parser(name, help="start the listener out of sight if needed, then open FalconOath's window")
        p.add_argument("--port", type=int, default=paths.PORT)
        p.add_argument("--at", help='open at this screen, e.g. "#/scan/ID"')
    p = sub.add_parser("window", help="FalconOath's own window, on a running listener")
    p.add_argument("--port", type=int, default=paths.PORT)
    p.add_argument("--at", help='open at this screen, e.g. "#/scan/ID"')
    p = sub.add_parser("serve")
    p.add_argument("--port", type=int, default=paths.PORT)
    p.add_argument("--log-meta", action="store_true", help="log every /api/meta check too")
    p.add_argument("--no-tailscale", action="store_true")
    p.add_argument("--hidden", action="store_true", help="no console: write data/falconoath.log")
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
    sub.add_parser("reference", help="what is built in, read from your manuals (data/sources/reference.json)")
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
            "build": cmd_build, "app": cmd_app, "open": cmd_app, "window": cmd_window, "serve": cmd_serve, "pair": cmd_pair, "devices": cmd_devices,
            "unpair": cmd_unpair, "status": cmd_status,
            "apply": cmd_apply, "library": cmd_library, "import-log": cmd_import_log, "logs": cmd_logs,
            "logs-folder": cmd_logs_folder, "watch-logs": cmd_watch_logs, "prices": cmd_prices, "cars": cmd_cars, "trims": cmd_trims, "reference": cmd_reference, "import-scan": cmd_import_scan}[a.cmd](a)
