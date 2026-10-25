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
from falconoath import livelogs   # noqa: E402
FORSCAN = H / "FORScan"                       # a stand-in for FORScan's folder
FORSCAN.mkdir()
livelogs.set_folder(str(FORSCAN))
cfg.update(lambda s: s.__setitem__("open_new", False))     # never open a browser from a test
p = cfg.start_pairing()
TOK = cfg.redeem(p["code"], "e2e phone")["token"]
s = socket.socket()
s.bind(("127.0.0.1", 0))
PORT = s.getsockname()[1]
s.close()
proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "falconoath", "serve", "--port", str(PORT), "--no-tailscale"],
                        cwd=str(T.ROOT), env=dict(os.environ), stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")


def call(path, body=None, timeout=10):
    h = {"Authorization": "Bearer " + TOK}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, headers=h, method="POST" if data else "GET")
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(gzip.decompress(raw) if resp.headers.get("Content-Encoding") == "gzip" else raw)


try:
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    from falconoath import cli                      # noqa: E402
    T.ok(cli._ping(PORT) and not cli._ping(1), "the desktop icon can tell FalconOath is already running")
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

    # a PDF manual from the device: in pieces, then filed, read and offered back
    from tests._pdf import make_pdf
    pdf = make_pdf([["FG Workshop Manual"], ["Knock sensor removal P0325"]])
    up, man = str(uuid.uuid4()), str(uuid.uuid4())
    for at in range(0, len(pdf), 400):
        r = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/upload/{up}?offset={at}", data=pdf[at:at + 400], method="PUT",
                                   headers={"Authorization": "Bearer " + TOK})
        urllib.request.urlopen(r, timeout=10).read()
    call("/api/inbox", {"items": [{"id": man, "kind": "manual",
                                   "data": {"upload_id": up, "file_name": "FG workshop.pdf", "folder": "FG", "size": len(pdf)}}]})
    t0, lib = time.monotonic(), None
    while time.monotonic() - t0 < 40:
        time.sleep(0.5)
        lib = call("/api/meta").get("library")
        if lib and lib["counts"]["manuals"] == 1:
            break
    secs = time.monotonic() - t0
    T.ok(lib and lib["counts"] == {"manuals": 1, "pages": 2, "text_pages": 2}, f"filed in manuals/FG, read and offered back by serve itself ({secs:.1f} s)", lib)
    libc = call("/api/library")
    sha = libc["manuals"][0]["sha"]
    T.ok(libc["manuals"][0]["path"] == "FG/FG workshop.pdf" and "P0325" in libc["text"][sha][1], "the copy has its page text, for offline search")
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/manual/{sha}", headers={"Authorization": "Bearer " + TOK})
    T.ok(urllib.request.urlopen(r, timeout=10).read() == pdf, "and the PDF opens from the laptop")
    T.ok({a[0]: a[1] for a in call("/api/snapshot")["applied"]}.get(man) == "applied", "the device's outbox hears it was applied")

    # FORScan saves a fault scan into its folder: an open app waiting on /api/wait hears within seconds
    import threading
    v0 = call("/api/meta")["version"]
    got = {}
    th = threading.Thread(target=lambda: got.update(call(f"/api/wait?v={v0}", timeout=40), at=time.monotonic()))
    th.start()
    time.sleep(1)
    (FORSCAN / "DTC 25-10-2026.txt").write_bytes(FIX.read_bytes().replace(b"U0140", b"U0141"))   # a scan not seen before
    t0 = time.monotonic()
    th.join(40)
    secs = got.get("at", 0) - t0
    T.ok(got.get("changed") is True and got.get("version") != v0, f"a waiting app hears of a scan FORScan just saved ({secs:.1f} s)", got)
    T.ok(0 < secs < 12, "within seconds (3 s to settle, then read and rebuilt)", secs)
    snap = call("/api/snapshot")
    new = [x for x in snap["scans"] if x["origin"] == "forscan-folder"]
    T.ok(len(new) == 1 and new[0]["car_id"] is None and new[0]["file_name"] == "DTC 25-10-2026.txt" and "U0141" in new[0]["text"],
         "it's in the copy, from FORScan's folder, waiting for a car", [(x["file_name"], x["car_id"]) for x in new])
    t1 = time.monotonic()
    w = call(f"/api/wait?v={snap['version']}&lv=&t=2", timeout=40)
    T.ok(w.get("changed") is False and time.monotonic() - t1 >= 1.9, "with nothing new, a wait just ends after a while (the app asks again)")
finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
T.ok("from a device: car applied" in out and "from a device: scan applied" in out, "the listener window says what came in")
T.ok("ready to look at: DTC 25-10-2026.txt" in out, "and names the new FORScan scan")
T.done()
