"""Tailscale, read-only: is FalconOath's private HTTPS route ready?

Adapted from VPA's vpa/tailnet.py. It runs `tailscale status --json` and
`tailscale serve status --json` and never changes anything. Setting up Serve
stays a command you run yourself:

    tailscale serve --bg --https=8443 8767

VPA keeps the default HTTPS port (443 -> 8766); FalconOath uses 8443, which
also makes it a separate origin (its own storage on the phone).

Funnel (publishing a port to the whole internet) on FalconOath's port is
reported as an error, never as ready.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from . import paths


def _exe() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base and (Path(base) / "Tailscale" / "tailscale.exe").is_file():
            return str(Path(base) / "Tailscale" / "tailscale.exe")
    return None


def _run(exe: str, *args) -> dict | None:
    try:
        r = subprocess.run([exe, *args], capture_output=True, text=True, timeout=6,
                           encoding="utf-8", errors="replace",
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout or "{}")
    except ValueError:
        return None


def _target(web: dict, hostport: str) -> str:
    h = (web.get(hostport) or {}).get("Handlers", {}).get("/") or {}
    return str(h.get("Proxy") or "")


def _is_port(target: str, port: int) -> bool:
    return target.rstrip("/") in (f"http://127.0.0.1:{port}", f"http://localhost:{port}",
                                  f"127.0.0.1:{port}", f"localhost:{port}", str(port))


def read_status(status: dict | None, serve: dict | None,
                port: int = paths.PORT, https_port: int = paths.HTTPS_PORT) -> dict:
    """The verdict from the two JSON answers (separate so tests can feed them).
    state: stopped | no-https | not-served | ready | funnel."""
    if status is None:
        return {"state": "stopped"}
    if status.get("BackendState") != "Running":
        return {"state": "stopped", "detail": str(status.get("BackendState") or "not running")}
    me = status.get("Self") or {}
    name = str(me.get("DNSName") or "").rstrip(".")
    certs = [str(c).rstrip(".") for c in (status.get("CertDomains") or [])]
    out = {"name": name, "url": f"https://{name}:{https_port}" if name else None,
           "peers": [{"name": p.get("HostName"), "os": p.get("OS"), "online": bool(p.get("Online"))}
                     for p in (status.get("Peer") or {}).values()]}
    if not name or name not in certs:
        return dict(out, state="no-https")
    web = (serve or {}).get("Web") or {}
    key = f"{name}:{https_port}"
    target = _target(web, key)
    out["serve_target"] = target or None
    out["vpa_443"] = _target(web, f"{name}:443") or None         # shown, never touched
    funnel = (serve or {}).get("AllowFunnel") or {}
    out["funnel_any"] = sorted(k for k, v in funnel.items() if v)
    if funnel.get(key):
        return dict(out, state="funnel")
    if not _is_port(target, port):
        return dict(out, state="not-served")
    return dict(out, state="ready")


def check(port: int = paths.PORT, https_port: int = paths.HTTPS_PORT) -> dict:
    exe = _exe()
    if not exe:
        v = {"state": "missing"}
    else:
        st = _run(exe, "status", "--json")
        sv = _run(exe, "serve", "status", "--json") if st else None
        v = read_status(st, sv, port, https_port)
    v["command"] = f"tailscale serve --bg --https={https_port} {port}"
    return v
