"""Offline smoke test in headless Chrome: pair, sync, let the worker install,
stop the listener, reopen: the app still opens from its cache with the
stored data, and search works. Skipped if Chrome or node is missing.

Chrome gets a short --user-data-dir (a long one breaks CacheStorage), and
the app is opened at http://localhost, which browsers treat as secure."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from tests import _home as T

H = T.home("check_offline")
T.copy_real_dtc(H)

from falconoath import build, cfg, dtc_import    # noqa: E402

CHROMES = [Path(os.environ.get("ProgramFiles", "")) / "Google/Chrome/Application/chrome.exe",
           Path(os.environ.get("ProgramFiles(x86)", "")) / "Google/Chrome/Application/chrome.exe",
           Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe"]
chrome = next((str(p) for p in CHROMES if p.is_file()), None)
node = shutil.which("node")
if not chrome or not node:
    print("SKIP: needs Chrome (or Edge) and node")
    raise SystemExit(0)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


dtc_import.import_dtc()
build.build()
p = cfg.start_pairing()
tok = cfg.redeem(p["code"], "headless test")["token"]
port, dtp = free_port(), free_port()
listener = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "serve", "--port", str(port),
                             "--no-tailscale"], cwd=str(T.ROOT), env=dict(os.environ),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
profile = Path(tempfile.mkdtemp(prefix="fo", dir=os.environ.get("TEMP")))
browser = None
try:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.2)
    browser = subprocess.Popen([chrome, "--headless=new", f"--remote-debugging-port={dtp}",
                                f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                                "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = subprocess.run([node, str(T.ROOT / "tests" / "offline_check.js"), str(dtp), f"http://localhost:{port}/",
                        tok, str(listener.pid)], capture_output=True, text=True, timeout=120)
    res = json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
    T.ok(res.get("synced"), "paired browser downloads the 1,195 entries", res)
    T.ok(res.get("worker") and res.get("controlled"), "the offline worker installs and takes control")
    T.ok(res.get("listenerGone"), "the listener is stopped")
    T.ok(res.get("offlineOpens"), "the app still opens with the laptop gone")
    T.ok(res.get("offlineData"), "search for P0325 works from the stored copy")
    T.ok(str(res.get("pill", "")).startswith("Not synced"), "the status says it is not synced", res.get("pill"))
finally:
    if browser:
        browser.kill()
    listener.kill()
    time.sleep(0.5)
    shutil.rmtree(profile, ignore_errors=True)
T.done()
