"""The listener: serves the app and its data copy to phones and the laptop.

Adapted from VPA's vpa/phonesrv.py. Deliberately tiny, and it cannot reach a
database: it reads files that build.py wrote under output/phone/, the app's
own files, and data/settings.json through cfg; it writes only files in
data/inbox/ (inbox.py). It imports nothing else of ours (tests/check_srv.py
walks its imports to prove it).

    GET  /ping            "a FalconOath laptop is here" - no data, no token
    POST /api/pair        a pairing code from the laptop -> a token
    GET  /api/meta        the current copy's version, counts and size
    GET  /api/wait?v=&lv= waits (up to WAIT_MAX s) until the copy or the manuals'
                          copy is no longer that version: an open app hears of
                          a new FORScan scan within a second, not at its next sync
    GET  /api/snapshot    the copy itself (gzip); 304 if the device has it
    POST /api/inbox       new cars, FORScan scans and manuals from a device:
                          written as a file to data/inbox/ (inbox.py) for the
                          laptop to apply
    GET  /api/library     the manuals' copy: titles and page text (gzip); 304 if had
    GET  /api/manual/<sha256>   one PDF from manuals/, with byte ranges (Range:)
    GET  /api/log/<sha256>      one live-data log, gzipped (build.py wrote it)
    GET  /api/upload/<id>       how much of a device's PDF upload has arrived
    PUT  /api/upload/<id>?offset=N   the next piece of it (inbox.append)
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
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import cfg, inbox, paths

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
         ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
         ".mjs": "text/javascript; charset=utf-8",                  # pdf.js
         ".pfb": "application/octet-stream", ".ttf": "font/ttf"}     # pdf.js's standard fonts
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
SHA_RE = re.compile(r"^/api/manual/([0-9a-f]{64})$")
UPLOAD_RE = re.compile(r"^/api/upload/([0-9a-f-]{36})$")
LOG_RE = re.compile(r"^/api/log/([0-9a-f]{64})$")
WAIT_MAX = 25.0                # seconds one /api/wait is held open
_LOCAL_WAIT = [0.0]            # when the app on this laptop (http://localhost) last waited


def laptop_app_open() -> bool:
    """Is the app open in a browser on this laptop (it waits for news all
    the time it's open)? The phone comes through Tailscale under its own
    name, so only localhost counts."""
    return time.monotonic() - _LOCAL_WAIT[0] < WAIT_MAX + 10


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
        if code.startswith(("4", "5")) or path in ("/api/snapshot", "/api/pair", "/api/library") \
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

    def _wait(self):
        """Answer when the data copy (v) or the manuals' copy (lv) is no
        longer the version the device has, or after WAIT_MAX seconds."""
        q = parse_qs(urlsplit(self.path).query)
        v, lv = (q.get("v") or [""])[0], (q.get("lv") or [""])[0]
        try:
            most = min(WAIT_MAX, max(0.5, float((q.get("t") or [WAIT_MAX])[0])))      # ?t= asks for less (tests)
        except ValueError:
            most = WAIT_MAX
        local = (self.headers.get("Host") or "").split(":")[0] in ("localhost", "127.0.0.1")
        t0 = time.monotonic()
        while True:
            if local:
                _LOCAL_WAIT[0] = time.monotonic()
            m, lib = cfg.read_meta() or {}, cfg.read_library_meta() or {}
            if (m.get("version") and m.get("version") != v) or (lv and lib.get("version") and lib.get("version") != lv):
                self._json({"ok": True, "changed": True, "version": m.get("version")})
                return
            if time.monotonic() - t0 >= most:
                self._json({"ok": True, "changed": False})
                return
            time.sleep(0.5)

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
            lib = cfg.read_library_meta()
            self._json({"ok": True, "device": dev.get("name"),
                        **{k: m.get(k) for k in ("format", "version", "built", "bytes",
                                                 "sha256", "counts")},
                        "library": {k: lib.get(k) for k in ("format", "version", "built", "bytes", "counts")}
                        if lib else None})
        elif path == "/api/wait":
            if self._device() is None:
                return
            self._wait()
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
        elif path == "/api/library":
            dev = self._device()
            if dev is None:
                return
            m = cfg.read_library_meta()
            f = paths.OUT / m["file"] if m else None
            if m is None or not f.is_file():
                self._json({"ok": False, "error": "no manuals copy yet"}, 503)
                return
            etag = f'"{m["version"]}"'
            if self.headers.get("If-None-Match", "") == etag:
                self._send(304, b"", "application/json", {"ETag": etag, "Cache-Control": "no-cache"})
                return
            self._send(200, f.read_bytes(), "application/json; charset=utf-8",
                       {"Content-Encoding": "gzip", "ETag": etag, "Cache-Control": "no-cache"})
        elif SHA_RE.match(path):
            if self._device() is None:
                return
            f = cfg.manual_path(SHA_RE.match(path).group(1))
            if f is None:
                self._json({"ok": False, "error": "that manual isn't on the laptop (moved or removed?)"}, 404)
                return
            self._pdf(f)
        elif LOG_RE.match(path):
            if self._device() is None:
                return
            f = paths.OUT / "logs" / f"{LOG_RE.match(path).group(1)}.csv.gz"
            if not f.is_file():
                self._json({"ok": False, "error": "that log isn't on the laptop"}, 404)
                return
            # gzip as stored: the device keeps it compressed and unpacks it to show it
            self._send(200, f.read_bytes(), "application/gzip", {"Cache-Control": "no-store"})
        elif UPLOAD_RE.match(path):
            if self._device() is None:
                return
            try:
                self._json({"ok": True, "size": inbox.upload_size(UPLOAD_RE.match(path).group(1))})
            except inbox.Refused as e:
                self._json({"ok": False, "error": str(e)}, 400)
        elif path.startswith("/api/"):
            self._send(404, b'{"ok":false,"error":"not found"}')
        else:
            self._static(path)

    def _pdf(self, f):
        """A PDF, whole or one byte range, streamed (manuals can be hundreds of MB)."""
        size = f.stat().st_size
        start, end, code = 0, size - 1, 200
        rng = (self.headers.get("Range") or "").strip()
        if rng:
            m = RANGE_RE.match(rng)
            a, b = m.groups() if m else ("", "")
            if not m or (a == "" and b == ""):
                start = -1
            elif a == "":                       # the last b bytes
                start, end = max(0, size - int(b)), size - 1
            else:
                start, end = int(a), min(int(b), size - 1) if b else size - 1
            if start < 0 or start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == "HEAD":
            return
        left = end - start + 1
        try:
            with open(f, "rb") as fh:
                fh.seek(start)
                while left > 0:
                    b = fh.read(min(left, 1 << 20))
                    if not b:
                        break
                    self.wfile.write(b)
                    left -= len(b)
        except (ConnectionError, OSError):
            pass

    def _static(self, path: str):
        files = app_files()
        p = files.get({"/": "/index.html", "/favicon.ico": "/icons/favicon.png"}.get(path, path))
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

    def do_PUT(self):
        """One piece of a PDF a device is sending (inbox.append)."""
        if not self._gate():
            return
        path, _, qs = self.path.partition("?")
        m = UPLOAD_RE.match(path)
        if not m:
            self._discard_body()
            self._send(404, b'{"ok":false,"error":"not found"}')
            return
        if self._device() is None:          # the token first: a piece is only read for a paired device
            self.close_connection = True
            return
        try:
            n = int(self.headers.get("Content-Length", -1))
            offset = int(dict(x.split("=", 1) for x in qs.split("&") if "=" in x).get("offset", -1))
        except ValueError:
            n = offset = -1
        if n <= 0 or n > inbox.MAX_PIECE or offset < 0:
            self.close_connection = True
            self._json({"ok": False, "error": "too big" if n > inbox.MAX_PIECE else "bad request"}, 413 if n > 0 else 400)
            return
        data = self.rfile.read(n)
        if len(data) != n:
            self.close_connection = True
            return
        try:
            self._json({"ok": True, "size": inbox.append(m.group(1), offset, data)})
        except inbox.Refused as e:
            self._json({"ok": False, "error": str(e), "size": inbox.upload_size(m.group(1))}, 409)
        except OSError as e:
            self._json({"ok": False, "error": f"the laptop couldn't save it ({e.strerror})"}, 503)

    def do_POST(self):
        if not self._gate():
            return
        if self.path not in ("/api/pair", "/api/inbox"):
            self._discard_body()
            self._send(404, b'{"ok":false,"error":"not found"}')
            return
        if _locked_out():
            self._discard_body()
            self._json({"ok": False, "error": "too many failed attempts - wait ten minutes"}, 429)
            return
        dev = None
        if self.path == "/api/inbox":
            # the token first: a big body is only read for a paired device
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.startswith("Bearer ") else ""
            dev = cfg.device_for(token) if token else None
            if dev is None:
                if token:
                    _fail()
                self._discard_body()
                self._json({"ok": False, "paired": False, "error": "this device is not paired "
                            "(or was removed) - pair it again"}, 401)
                return
        limit = inbox.MAX_BODY if dev else MAX_BODY
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            self._discard_body()
            self._json({"ok": False, "error": "too big" if n > limit else "bad request"}, 413)
            return
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            if not isinstance(d, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            self._json({"ok": False, "error": "bad request"}, 400)
            return
        if dev:
            try:
                self._json(inbox.receive(dev, d))
            except inbox.Refused as e:
                self._json({"ok": False, "error": str(e)}, 400)
            except OSError as e:
                self._json({"ok": False, "error": f"the laptop couldn't save it ({e.strerror})"}, 503)
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
