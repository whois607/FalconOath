"""The listener and pairing, over live HTTP: it can't reach a database, it
needs a token for every /api/ route (from loopback too), pairing codes
expire and run out, tokens are stored hashed, removal locks out, ETag/304,
body cap, lockout, and only the app's own files are served. Also the
read-only Tailscale verdicts."""
import ast
import gzip
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from tests import _home as T

H = T.home("check_srv")
T.copy_real_dtc(H)

from falconoath import build, cfg, dtc_import, paths, srv, tailnet    # noqa: E402

print("the listener cannot reach a database")
out = subprocess.run([sys.executable, "-c", "import sys, falconoath.srv; print(' '.join(sorted(sys.modules)))"],
                     cwd=str(T.ROOT), capture_output=True, text=True).stdout.split()
T.ok("falconoath.srv" in out, "srv imports cleanly on its own")
for bad in ("sqlite3", "_sqlite3", "falconoath.db", "falconoath.build", "falconoath.dtc_import",
            "falconoath.apply"):
    T.ok(bad not in out, f"importing srv loads no {bad}")
for mod in ("srv", "cfg", "paths", "inbox"):
    tree = ast.parse((paths.CODE / f"{mod}.py").read_text(encoding="utf-8"))
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            names |= {a.name for a in n.names}
        elif isinstance(n, ast.ImportFrom):
            names |= {(n.module or "") + ":" + a.name for a in n.names} | {n.module or ""}
    T.ok(not any("sqlite" in x or x.endswith(":db") or x.endswith(":build") for x in names),
         f"{mod}.py names no database module", names)

print("allowed addresses")
for ip, want in [("127.0.0.1", True), ("::1", True), ("192.168.1.5", True), ("10.0.0.2", True),
                 ("100.71.232.86", True), ("8.8.8.8", False), ("100.128.0.1", False), ("nonsense", False)]:
    T.ok(srv.allowed_ip(ip) is want, f"{ip} -> {want}")

dtc_import.import_dtc()
build.build()
srv.Handler.log_message = lambda *a: None      # quiet: refusals are expected here
S = srv.start(0)
PORT = S.server_address[1]
BASE = f"http://127.0.0.1:{PORT}"


def req(path, method="GET", body=None, token=None, headers=None):
    h = dict(headers or {})
    if token:
        h["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, dict(e.headers), e.read()
        except (ConnectionAbortedError, ConnectionResetError):
            return e.code, dict(e.headers), b""
    except (ConnectionAbortedError, ConnectionResetError):
        return 0, {}, b""             # refused and closed before the whole body went (Windows, big bodies)


def js(b):
    try:
        return json.loads(b)
    except ValueError:
        return {}


print("routes without a token")
st, _, b = req("/ping")
T.ok(st == 200 and js(b).get("app") == "falconoath", "/ping answers with no token")
T.ok(req("/api/meta")[0] == 401, "/api/meta with no token -> 401 (from loopback too)")
T.ok(req("/api/snapshot")[0] == 401, "/api/snapshot with no token -> 401")
T.ok(req("/api/meta", token="not-a-real-token")[0] == 401, "a wrong token -> 401")
T.ok(req("/api/nothing")[0] == 404, "unknown /api/ route -> 404")

print("pairing")
st, _, b = req("/api/pair", "POST", {"code": "123456"})
T.ok(st == 403 and "no pairing code" in js(b).get("error", ""), "no code showing -> refused")
p = cfg.start_pairing()
T.ok(p["ok"] and len(p["code"]) == 6, "a six-digit code")
raw = paths.SETTINGS.read_text(encoding="utf-8")
T.ok(p["code"] not in raw, "the code is stored hashed, not as typed")
wrong = "000000" if p["code"] != "000000" else "111111"
for i in range(4):
    st, _, b = req("/api/pair", "POST", {"code": wrong})
T.ok(st == 403 and "not the code" in js(b)["error"], "wrong code -> try again")
st, _, b = req("/api/pair", "POST", {"code": wrong})
T.ok("too many wrong" in js(b)["error"], "the fifth wrong code voids it")
st, _, b = req("/api/pair", "POST", {"code": p["code"]})
T.ok(st == 403, "and then even the right code is refused")
p = cfg.start_pairing()
cfg.update(lambda s: s["pair"].__setitem__("expires", time.time() - 1))
st, _, b = req("/api/pair", "POST", {"code": p["code"]})
T.ok("expired" in js(b).get("error", ""), "an expired code is refused")
srv._FAILS.clear()
p = cfg.start_pairing()
st, _, b = req("/api/pair", "POST", {"code": p["code"][:3] + " " + p["code"][3:]},
               headers={"User-Agent": "Mozilla/5.0 (Android 15; Mobile) Firefox/140.0"})
d = js(b)
T.ok(st == 200 and d.get("ok") and len(d.get("token", "")) > 30, "the right code (with a space) -> a token")
T.ok(d.get("device", {}).get("name") == "Firefox on Android", "device named from its browser", d.get("device"))
TOK = d["token"]
raw = paths.SETTINGS.read_text(encoding="utf-8")
T.ok(TOK not in raw and cfg._sha(TOK) in raw, "only the token's SHA-256 is stored")
T.ok(json.loads(raw)["pair"] is None, "the code is used up")

print("the data copy")
st, _, b = req("/api/meta", token=TOK)
m = js(b)
T.ok(st == 200 and m.get("ok") and m["counts"]["dtc"] == 1195, "meta: version and counts", m)
st, hd, b = req("/api/snapshot", token=TOK)
T.ok(st == 200 and hd.get("Content-Encoding") == "gzip", "snapshot sent gzipped")
snap = json.loads(gzip.decompress(b))
T.ok(snap["version"] == m["version"] and len(snap["dtc"]) == 1195, "snapshot matches meta")
T.ok(hd.get("ETag") == f'"{m["version"]}"', "ETag is the version")
st, _, b = req("/api/snapshot", token=TOK, headers={"If-None-Match": f'"{m["version"]}"'})
T.ok(st == 304 and b == b"", "unchanged -> 304, nothing sent")
dev = cfg.load()["devices"][0]
T.ok(dev["last_version"] == m["version"] and dev["last_seen"], "last sync recorded")

print("requests that are refused")
st, _, b = req("/api/pair", "POST", b"x" * 5000)
T.ok(st == 413, "a body over 4 KB -> 413")
T.ok(req("/api/stars", "POST", {"a": 1})[0] == 404, "an unknown POST route -> 404")
st, _, b = req("/api/pair", "POST", b"not json")
T.ok(st == 400, "a body that isn't JSON -> 400")

print("static files")
st, hd, b = req("/")
T.ok(st == 200 and b"FalconOath" in b and b"__BUILD__" not in b, "/ is the app, BUILD stamped")
st, _, sw = req("/sw.js")
bid = srv.build_id()
T.ok(st == 200 and bid.encode() in sw and b"__BUILD__" not in sw, "sw.js carries the build id")
for path in ("/lib/dtc.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/maskable-512.png"):
    T.ok(req(path)[0] == 200, f"{path} served")
for path in ("/../data/settings.json", "/data/falcon.db", "/%2e%2e/cli.py", "/cli.py", "/app/app.js", "/.hidden"):
    T.ok(req(path)[0] == 404, f"{path} not served")
man = json.loads(req("/manifest.webmanifest")[2])
purposes = sorted((i["sizes"], i["purpose"]) for i in man["icons"])
T.ok(purposes == [("192x192", "any"), ("192x192", "maskable"), ("512x512", "any"), ("512x512", "maskable")],
     "manifest: 192/512 PNGs, any and maskable listed separately")
T.ok(man["display"] == "standalone" and man["name"] == "FalconOath", "manifest: standalone, named")

print("removing a device locks it out")
cfg.remove_device(dev["id"])
T.ok(req("/api/meta", token=TOK)[0] == 401, "a removed device gets 401")

print("lockout after too many failures")
srv._FAILS.clear()
for i in range(srv.FAIL_LIMIT):
    req("/api/meta", token=f"bad-{i}")
T.ok(req("/api/meta", token="bad-again")[0] == 429, f"after {srv.FAIL_LIMIT} bad tokens -> 429")
T.ok(req("/api/pair", "POST", {"code": "123456"})[0] == 429, "pairing refused too while locked out")
srv._FAILS.clear()
print("the inbox route")
import uuid                                          # noqa: E402
from falconoath import inbox                         # noqa: E402
srv._FAILS.clear()
p2 = cfg.start_pairing()
TOK2 = cfg.redeem(p2["code"], "inbox test")["token"]
item = {"id": str(uuid.uuid4()), "kind": "car", "data": {"nickname": "x"}}
st, _, b = req("/api/inbox", "POST", {"items": [item]})
T.ok(st == 401, "no token -> 401")
st, _, b = req("/api/inbox", "POST", {"items": [item]}, token="wrong")
T.ok(st == 401, "a wrong token -> 401")
T.ok(not inbox.pending(), "and nothing written")
st, _, b = req("/api/inbox", "POST", {"items": [item]}, token=TOK2)
T.ok(st == 200 and js(b).get("received") == [item["id"]], "a paired device's items are received", b)
files = inbox.pending()
T.ok(len(files) == 1 and files[0].parent == inbox.INBOX, "one file, in data/inbox/")
doc = json.loads(files[0].read_text(encoding="utf-8"))
T.ok(doc["device"]["name"] == "inbox test" and doc["items"][0]["id"] == item["id"], "it names the device and holds the item")
st, _, b = req("/api/inbox", "POST", {"items": [{"id": "nope", "kind": "car", "data": {}}]}, token=TOK2)
T.ok(st == 400 and "expected form" in js(b).get("error", ""), "a malformed item -> 400")
st, _, b = req("/api/inbox", "POST", {"items": [dict(item, data={"text": "x" * (inbox.MAX_BODY + 10)})]}, token=TOK2)
T.ok(st in (413, 0), "over the size limit -> 413 (or closed before it was all sent)")
st, _, b = req("/api/pair", "POST", {"code": "1" * 5000})
T.ok(st == 413, "pairing keeps its small 4 KB limit")
T.ok(len(inbox.pending()) == 1, "refused requests wrote nothing")
st, hd, _ = req("/favicon.ico")
T.ok(st == 200 and hd.get("Content-Type") == "image/png", "/favicon.ico served")

print("manuals: the copy, PDFs with ranges, uploads")
from falconoath import library                       # noqa: E402
from tests._pdf import make_pdf                      # noqa: E402
T.ok(js(req("/api/meta", token=TOK2)[2]).get("library") is None and req("/api/library", token=TOK2)[0] == 503,
     "no manuals copy yet: meta says none, /api/library 503")
mroot = library.ensure_folders()
pdf = make_pdf([["FG manual page one"], ["page two " + "x" * 3000]])
(mroot / "FG" / "fg.pdf").write_bytes(pdf)
library.index(say=lambda *_: None)
library.build()
sha = T.sha(mroot / "FG" / "fg.pdf")
lm = js(req("/api/meta", token=TOK2)[2]).get("library") or {}
T.ok(lm.get("counts", {}).get("manuals") == 1, "/api/meta names the manuals copy", lm)
T.ok(req("/api/library")[0] == 401 and req(f"/api/manual/{sha}")[0] == 401, "both need a token")
st, hd, b = req("/api/library", token=TOK2)
T.ok(st == 200 and json.loads(gzip.decompress(b))["manuals"][0]["sha"] == sha, "/api/library: the copy (gzip)")
T.ok(req("/api/library", token=TOK2, headers={"If-None-Match": hd.get("ETag")})[0] == 304, "/api/library 304 when had")
st, hd, b = req(f"/api/manual/{sha}", token=TOK2)
T.ok(st == 200 and b == pdf and hd.get("Accept-Ranges") == "bytes" and hd.get("Content-Type") == "application/pdf", "the whole PDF")
st, hd, b = req(f"/api/manual/{sha}", token=TOK2, headers={"Range": "bytes=10-19"})
T.ok(st == 206 and b == pdf[10:20] and hd.get("Content-Range") == f"bytes 10-19/{len(pdf)}", "a byte range -> 206 with just those bytes")
st, hd, b = req(f"/api/manual/{sha}", token=TOK2, headers={"Range": "bytes=-5"})
T.ok(st == 206 and b == pdf[-5:], "the last 5 bytes")
T.ok(req(f"/api/manual/{sha}", token=TOK2, headers={"Range": f"bytes={len(pdf) + 5}-"})[0] == 416, "a range past the end -> 416")
T.ok(req(f"/api/manual/{'0' * 64}", token=TOK2)[0] == 404, "an unknown manual -> 404")
T.ok(req("/api/manual/../../data/falcon.db", token=TOK2)[0] in (400, 404), "no paths in the URL")
(paths.OUT / "library-files.json").write_text(json.dumps({sha: "../data/settings.json", "a" * 64: "FG/fg.pdf"}), encoding="utf-8")
T.ok(req(f"/api/manual/{sha}", token=TOK2)[0] == 404, "a doctored map can't reach outside manuals/ or a non-PDF")
library.build(force=True)
up = str(uuid.uuid4())
T.ok(js(req(f"/api/upload/{up}", token=TOK2)[2]) == {"ok": True, "size": 0}, "a new upload has 0 bytes")
st, _, b = req(f"/api/upload/{up}?offset=0", "PUT", pdf[:50])
T.ok(st in (401, 0) and not inbox.upload_path(up).exists(), "a piece with no token -> 401 (or closed unread), nothing written")
st, _, b = req(f"/api/upload/{up}?offset=0", "PUT", pdf[:50], token=TOK2)
T.ok(st == 200 and js(b)["size"] == 50, "the first piece")
st, _, b = req(f"/api/upload/{up}?offset=0", "PUT", pdf[:50], token=TOK2)
T.ok(st == 409 and js(b)["size"] == 50, "the same piece again -> 409, with how much the laptop has")
st, _, b = req(f"/api/upload/{up}?offset=50", "PUT", pdf[50:], token=TOK2)
T.ok(st == 200 and inbox.upload_path(up).read_bytes() == pdf, "the rest: the upload is the whole PDF")
st, _, b = req(f"/api/upload/{uuid.uuid4()}?offset=0", "PUT", b"not a pdf", token=TOK2)
T.ok(st == 409 and "isn't a PDF" in js(b).get("error", ""), "a first piece that isn't a PDF -> refused")
st, _, b = req("/api/upload/not-an-id?offset=0", "PUT", b"%PDF-", token=TOK2)
T.ok(st == 404, "a bad upload id -> 404")
(paths.OUT / "logs").mkdir(parents=True, exist_ok=True)
lgz = gzip.compress(b"time(ms);RPM(1/min)\n0;700\n")
(paths.OUT / "logs" / ("e" * 64 + ".csv.gz")).write_bytes(lgz)
T.ok(req("/api/log/" + "e" * 64)[0] == 401, "a log needs a token")
st, hd, b = req("/api/log/" + "e" * 64, token=TOK2)
T.ok(st == 200 and b == lgz and hd.get("Content-Type") == "application/gzip" and not hd.get("Content-Encoding"),
     "/api/log: the gzip as stored (the device unpacks it)")
T.ok(req("/api/log/" + "f" * 64, token=TOK2)[0] == 404 and req("/api/log/..%2F..%2Fdata%2Ffalcon.db", token=TOK2)[0] == 404,
     "an unknown log -> 404; no paths")
st, hd, b = req("/vendor/pdfjs/pdf.min.mjs")
T.ok(st == 200 and hd.get("Content-Type", "").startswith("text/javascript"), "pdf.js is served as a module")
S.shutdown()

print("Tailscale verdicts (read-only)")
st_ok = {"BackendState": "Running", "Self": {"DNSName": "lap.tn.ts.net.", "TailscaleIPs": ["100.1.2.3"]},
         "CertDomains": ["lap.tn.ts.net"], "Peer": {"x": {"HostName": "phone", "OS": "android", "Online": True}}}
web = {"lap.tn.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8766"}}},
       "lap.tn.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8767"}}}}
v = tailnet.read_status(st_ok, {"Web": web})
T.ok(v["state"] == "ready" and v["url"] == "https://lap.tn.ts.net:8443", "8443 -> 8767 is ready", v)
T.ok(v["vpa_443"] == "http://127.0.0.1:8766", "VPA's 443 route reported, separately")
v = tailnet.read_status(st_ok, {"Web": {"lap.tn.ts.net:443": web["lap.tn.ts.net:443"]}})
T.ok(v["state"] == "not-served", "only VPA's route -> not served (VPA's 443 is never taken over)")
v = tailnet.read_status(st_ok, {"Web": web, "AllowFunnel": {"lap.tn.ts.net:8443": True}})
T.ok(v["state"] == "funnel", "Funnel on our port -> funnel, never ready")
T.ok(tailnet.read_status(None, None)["state"] == "stopped", "no answer -> stopped")
T.ok(tailnet.read_status(dict(st_ok, CertDomains=[]), {"Web": web})["state"] == "no-https", "no certs -> no-https")

print("keys in the listener window")
import argparse                       # noqa: E402
import contextlib                     # noqa: E402
import io                             # noqa: E402
from falconoath import cli            # noqa: E402
ns = argparse.Namespace()
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    r = cli.on_key("P", ns)
T.ok(r is None and "Pairing code:" in buf.getvalue(), "P shows a pairing code")
T.ok(cfg.public()["pairing"] is not None, "and that code is live")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    cli.on_key("d", ns)
T.ok("pairing code is showing" in buf.getvalue(), "D lists devices and the live code")
T.ok(cli.on_key("q", ns) == "quit" and cli.on_key("Q", ns) == "quit", "Q stops")
T.ok(cli.on_key("x", ns) is None, "other keys do nothing")
_stdin, sys.stdin = sys.stdin, io.StringIO()
T.ok(cli._console_keys() is None, "no console (a test or a pipe): keys are not read")
sys.stdin = _stdin

print("FalconOath's own window (FalconOath.exe) and its laptop buttons")
srv._FAILS.clear()                    # the lockout tested above
S = srv.start(0)                      # (the first one was stopped above)
BASE = f"http://127.0.0.1:{S.server_address[1]}"
code = cfg.start_launch()
T.ok(js(req("/api/pair", "POST", {"code": "wrong-code-123", "launch": True})[2]).get("ok") is False, "a wrong window code is refused")
st, _, b = req("/api/pair", "POST", {"code": code, "launch": True})
win = js(b)
T.ok(st == 200 and win.get("ok") and win["device"]["name"] == cfg.LAPTOP_NAME, "the window pairs itself with its one-time code, as This laptop", win)
T.ok(js(req("/api/pair", "POST", {"code": code, "launch": True})[2]).get("ok") is False, "the code works once")
WT = win["token"]
T.ok(js(req("/api/meta", token=WT)[2]).get("laptop") is True, "/api/meta tells the window it's the laptop")
code2 = cfg.start_launch()
win2 = js(req("/api/pair", "POST", {"code": code2, "launch": True})[2])
T.ok(win2.get("ok") and req("/api/meta", token=WT)[0] == 401 and sum(1 for d in cfg.public()["devices"] if d.get("laptop")) == 1,
     "a new window's pairing replaces the old one (one This laptop)")
WT = win2["token"]
phone = cfg.redeem(cfg.start_pairing()["code"], "Test phone")["token"]
st, _, b = req("/api/laptop", "POST", {"do": "status"}, token=phone)
T.ok(st == 403, "a phone can't use the laptop's buttons", (st, b))
T.ok(req("/api/laptop", "POST", {"do": "status"})[0] == 401, "nor can anything without a token")
(paths.OUT).mkdir(parents=True, exist_ok=True)
(paths.OUT / "laptop.json").write_text(json.dumps({"started": "2026-10-26 09:00:00", "phone": "https://lap.tn.ts.net:8443",
                                                     "phone_state": "ready", "forscan": "C:\\FORScan"}), encoding="utf-8")
s = js(req("/api/laptop", "POST", {"do": "status"}, token=WT)[2])
T.ok(s.get("ok") and s["phone"] == "https://lap.tn.ts.net:8443" and s["forscan"] == "C:\\FORScan" and s["open_new"] is True
     and any(d["name"] == "Test phone" for d in s["devices"]) and all("token" not in d for d in s["devices"]),
     "status: the phone's address, FORScan's folder, devices (no tokens)", s)
p = js(req("/api/laptop", "POST", {"do": "pair"}, token=WT)[2])
T.ok(p.get("ok") and len(p["code"]) == 6, "Pair a phone: a six-digit code")
T.ok(js(req("/api/laptop", "POST", {"do": "open_new", "on": False}, token=WT)[2]).get("open_new") is False
     and cfg.load()["open_new"] is False, "open new scans by themselves can be turned off")
me = next(d["id"] for d in cfg.public()["devices"] if d.get("laptop"))
T.ok(req("/api/laptop", "POST", {"do": "unpair", "id": me}, token=WT)[0] == 400, "the window can't remove itself")
ph = next(d["id"] for d in cfg.public()["devices"] if d["name"] == "Test phone")
T.ok(js(req("/api/laptop", "POST", {"do": "unpair", "id": ph}, token=WT)[2]).get("ok") and req("/api/meta", token=phone)[0] == 401,
     "it can remove a phone")
while not srv.ACTIONS.empty():
    srv.ACTIONS.get_nowait()
for what in ("open:manuals", "stop"):
    req("/api/laptop", "POST", {"do": what}, token=WT)
T.ok([srv.ACTIONS.get_nowait(), srv.ACTIONS.get_nowait()] == ["open:manuals", "stop"], "folders and Stop go to the main loop, not done here")
T.ok(req("/api/laptop", "POST", {"do": "rm -rf"}, token=WT)[0] == 400, "nothing else")
srv.ACTIONS.put("stop")
T.ok(cli._laptop_actions() == "stop", "the main loop stops when the window says Stop")
T.ok(cli.self_cmd("watch-logs")[-3:] == ["-m", "falconoath", "watch-logs"] and not paths.FROZEN, "children: python -m falconoath ... (FalconOath.exe <cmd> when frozen)")
S.shutdown()
T.done()
