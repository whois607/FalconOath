"""The whole chain, live: a paired device posts a new car and a FORScan scan
to a running `serve`; the listener writes them to the inbox; serve applies
them (in a child process) and rebuilds; the next /api/meta and snapshot
carry them, with their results. Nothing here touches the real data."""
import gzip
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

from tests import _home as T

H = T.home("check_inbox_e2e")
T.copy_real_dtc(H)
FIX = T.ROOT / "tests" / "fixtures" / "forscan_fixture.txt"

from falconoath import build, cfg, dtc_import, inbox    # noqa: E402

dtc_import.import_dtc()
build.build()
p = cfg.start_pairing()
TOK = cfg.redeem(p["code"], "e2e phone")["token"]
s = socket.socket()
s.bind(("127.0.0.1", 0))
PORT = s.getsockname()[1]
s.close()
proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "serve", "--port", str(PORT), "--no-tailscale"],
                        cwd=str(T.ROOT), env=dict(os.environ), stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")


def call(path, body=None):
    h = {"Authorization": "Bearer " + TOK}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, headers=h, method="POST" if data else "GET")
    with urllib.request.urlopen(r, timeout=10) as resp:
        raw = resp.read()
        return json.loads(gzip.decompress(raw) if resp.headers.get("Content-Encoding") == "gzip" else raw)


try:
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    m0 = call("/api/meta")
    T.ok(m0["ok"] and m0["counts"]["scans"] == 0, "serving, no scans yet (schema 2 applied at start)", m0.get("counts"))
    car, scan = str(uuid.uuid4()), str(uuid.uuid4())
    r = call("/api/inbox", {"items": [
        {"id": car, "kind": "car", "data": {"nickname": "E2E FG", "model": "FG"}},
        {"id": scan, "kind": "scan", "data": {"text": FIX.read_text(encoding="utf-8"), "file_name": "f.txt", "car_id": car}}]})
    T.ok(r.get("received") == [car, scan], "the listener received both")
    t0, m = time.monotonic(), m0
    while time.monotonic() - t0 < 30 and m["counts"]["scans"] < 1:
        time.sleep(0.5)
        m = call("/api/meta")
    secs = time.monotonic() - t0
    T.ok(m["counts"]["scans"] == 1 and m["counts"]["cars"] == 1, f"applied and rebuilt by serve itself ({secs:.1f} s)", m["counts"])
    T.ok(secs < 15, "within a few seconds")
    snap = call("/api/snapshot")
    T.ok(snap["version"] == m["version"], "the snapshot is that version")
    res = {a[0]: a[1] for a in snap["applied"]}
    T.ok(res.get(car) == "applied" and res.get(scan) == "applied", "both results in the copy, for the device's outbox")
    T.ok(snap["scans"][0]["car_id"] == car and "U0140" in snap["scans"][0]["text"], "the scan is on its car, text whole")
    T.ok(not inbox.pending() and len(list((inbox.INBOX / "done").glob("*.json"))) == 1, "the inbox file was moved to done/")
finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
T.ok("from a device: car applied" in out and "from a device: scan applied" in out, "the listener window says what came in")
T.done()
