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
        return e.code, dict(e.headers), e.read()


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
T.ok(st == 413, "over the size limit -> 413")
st, _, b = req("/api/pair", "POST", {"code": "1" * 5000})
T.ok(st == 413, "pairing keeps its small 4 KB limit")
T.ok(len(inbox.pending()) == 1, "refused requests wrote nothing")
st, hd, _ = req("/favicon.ico")
T.ok(st == 200 and hd.get("Content-Type") == "image/png", "/favicon.ico served")
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
T.done()
