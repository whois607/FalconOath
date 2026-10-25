"""The listener: serves the app and its data copy to phones and the laptop.

Adapted from VPA's vpa/phonesrv.py. Deliberately tiny, and it cannot reach a
database: it reads files that build.py wrote under output/phone/, the app's
own files, and data/settings.json through cfg. It imports nothing else of
ours (tests/check_srv.py walks its imports to prove it).

    GET  /ping            "a FalconOath laptop is here" - no data, no token
    POST /api/pair        a pairing code from the laptop -> a token
    GET  /api/meta        the current copy's version, counts and size
    GET  /api/snapshot    the copy itself (gzip); 304 if the device has it
    GET  /, app files     the app shell (no data in it), BUILD stamped into sw.js

Every /api/ route but pairing needs a paired device's token, from loopback
too: `tailscale serve` delivers phone requests from 127.0.0.1, so loopback
proves nothing. Clients outside loopback, private ranges and Tailscale's
100.64/10 are refused outright. Binds 127.0.0.1 only.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import cfg, paths

MAX_BODY = 4096
DISCARD_MAX = 64 * 1024
FAIL_WINDOW = 600              # seconds
FAIL_LIMIT = 30                # bad tokens / codes per window, all callers together
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_FAILS: list[float] = []
_FAIL_LOCK = threading.Lock()

# the app's files, by extension; anything else under app/ is never served
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}


def allowed_ip(host: str) -> bool:
    """Loopback, private ranges and Tailscale's 100.64/10 only."""
    try:
        ip = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        return False
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_private or (ip.version == 4 and ip in _CGNAT)


def _fail() -> None:
    with _FAIL_LOCK:
        _FAILS.append(time.time())


def _locked_out() -> bool:
    with _FAIL_LOCK:
        cut = time.time() - FAIL_WINDOW
        while _FAILS and _FAILS[0] < cut:
            _FAILS.pop(0)
        return len(_FAILS) >= FAIL_LIMIT


def _device_name(ua: str) -> str:
    ua = ua or ""
    os_ = ("Android" if "Android" in ua else "iPhone" if "iPhone" in ua
           else "Windows" if "Windows" in ua else "Mac" if "Mac OS" in ua
           else "Linux" if "Linux" in ua else "")
    br = ("Firefox" if "Firefox" in ua else "Edge" if "Edg/" in ua
          else "Chrome" if "Chrome" in ua else "Safari" if "Safari" in ua else "")
    return " on ".join(x for x in (br, os_) if x) or "Device"


# ------------------------------------------------------------------ app files
def app_files() -> dict[str, object]:
    """URL path -> file, for every servable file under app/. Read fresh each
    time, so edits show up without a restart."""
    out = {}
    for p in sorted(paths.APP.rglob("*")):
        rel = p.relative_to(paths.APP).as_posix()
        if p.is_file() and p.suffix in TYPES and not any(x.startswith(".") for x in rel.split("/")):
            out["/" + rel] = p
    return out


def build_id(files: dict | None = None) -> str:
    """A hash of the app's own files. sw.js carries it, so a changed app is a
    changed worker, and devices pick it up on their next open."""
    h = hashlib.sha1()
    for url, p in sorted((files or app_files()).items()):
        h.update(url.encode())
        try:
            h.update(p.read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:12]


class Handler(BaseHTTPRequestHandler):
    server_version = "falconoath"
    sys_version = ""

    def log_message(self, fmt, *args):
        """One short line for a download, a pairing or a refusal - never a
        token, and not every "no change" check."""
        code = str(args[1]) if len(args) > 1 else ""
        path = self.path.split("?")[0]
        if code.startswith(("4", "5")) or path in ("/api/snapshot", "/api/pair") \
                or (path == "/api/meta" and getattr(self.server, "log_meta", False)):
            print(f"{time.strftime('%H:%M:%S')} {self.client_address[0]} "
                  f"{self.command} {path} -> {code}", flush=True)

    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json",
              headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if "Cache-Control" not in (headers or {}):
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj: dict, code: int = 200):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def _gate(self) -> bool:
        if not allowed_ip(self.client_address[0]):
            self._send(403, b'{"ok":false,"error":"not from this network"}')
            return False
        return True

    def _device(self):
        """The paired device making this request, or None (401/429 sent)."""
        if _locked_out():
            self._json({"ok": False, "error": "too many failed attempts - wait ten minutes"}, 429)
            return None
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        dev = cfg.device_for(token) if token else None
        if dev is None:
            if token:
                _fail()
            self._json({"ok": False, "paired": False,
                        "error": "this device is not paired (or was removed) - pair it "
                                 "again (press P in the FalconOath window on the laptop)"}, 401)
        return dev

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._gate():
            return
        path = self.path.split("?", 1)[0]
        if path == "/ping":
            self._json({"app": cfg.APP_ID})
        elif path == "/api/meta":
            dev = self._device()
            if dev is None:
                return
            m = cfg.read_meta()
            if m is None:
                self._json({"ok": False, "error": "the laptop has not built the data "
                            "copy yet - run: python -m falconoath build"}, 503)
                return
            self._json({"ok": True, "device": dev.get("name"),
                        **{k: m.get(k) for k in ("format", "version", "built", "bytes",
                                                 "sha256", "counts")}})
        elif path == "/api/snapshot":
            dev = self._device()
            if dev is None:
                return
            m = cfg.read_meta()
            f = cfg.snapshot_path(m) if m else None
            if m is None or not f.is_file():
                self._json({"ok": False, "error": "no data copy yet"}, 503)
                return
            etag = f'"{m["version"]}"'
            if self.headers.get("If-None-Match", "") == etag:
                cfg.seen(dev["id"], m["version"])
                self._send(304, b"", "application/json", {"ETag": etag, "Cache-Control": "no-cache"})
                return
            body = f.read_bytes()
            self._send(200, body, "application/json; charset=utf-8",
                       {"Content-Encoding": "gzip", "ETag": etag, "Cache-Control": "no-cache"})
            cfg.seen(dev["id"], m["version"])
        elif path.startswith("/api/"):
            self._send(404, b'{"ok":false,"error":"not found"}')
        else:
            self._static(path)

    def _static(self, path: str):
        files = app_files()
        p = files.get("/index.html" if path == "/" else path)
        if p is None:
            self._send(404, b"not found", "text/plain")
            return
        body = p.read_bytes()
        if path == "/sw.js":
            body = body.replace(b"__BUILD__", build_id(files).encode())
        elif path in ("/", "/index.html"):
            body = body.replace(b"__BUILD__", build_id(files).encode())
        self._send(200, body, TYPES[p.suffix], {"Cache-Control": "no-cache"})

    def _discard_body(self):
        """Read and drop a refused request's body: answering before it is read
        makes Windows reset the connection, and the client sees an abort."""
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return
        if 0 < n <= DISCARD_MAX:
            self.rfile.read(n)

    def do_POST(self):
        if not self._gate():
            return
        if self.path != "/api/pair":
            self._discard_body()
            self._send(404, b'{"ok":false,"error":"not found"}')
            return
        if _locked_out():
            self._discard_body()
            self._json({"ok": False, "error": "too many failed attempts - wait ten minutes"}, 429)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            self._discard_body()
            self._json({"ok": False, "error": "bad request"}, 413)
            return
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            if not isinstance(d, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            self._json({"ok": False, "error": "bad request"}, 400)
            return
        name = d.get("name") or _device_name(self.headers.get("User-Agent", ""))
        try:
            r = cfg.redeem(d.get("code"), name)
        except TimeoutError as e:
            self._json({"ok": False, "error": str(e)}, 503)
            return
        if not r["ok"]:
            _fail()
        self._json(r, 200 if r["ok"] else 403)


def start(port: int = paths.PORT, log_meta: bool = False) -> ThreadingHTTPServer:
    """Listen on 127.0.0.1 in a daemon thread and return the server.
    Raises OSError if the port is taken."""
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    srv.log_meta = log_meta
    threading.Thread(target=srv.serve_forever, name="falconoath-http", daemon=True).start()
    return srv
