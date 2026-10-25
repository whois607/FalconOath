"""Run every check.

    python -X utf8 -m tests.run_all            everything (~30 s)
    python -X utf8 -m tests.run_all --quick    without the headless Chrome test
    python -X utf8 -m tests.run_all --only check_srv,check_app

Each suite works in its own folder under tests/synthetic/ (never the real
data/ or output/) and runs as its own process; full output is kept in
tests/synthetic/logs/<suite>.log and a failing suite's FAIL lines are printed.
Exit 0 = everything passed.

  check_dtc_import  counts, code normalisation, re-run adds nothing, source untouched, backups
  check_build       the data copy: only written when changed, meta last, newest two kept
  check_srv         the listener: no database reachable, tokens, pairing, 304, refusals, Tailscale
  check_scans       step 2 on the laptop: schema 2, FORScan imports, the inbox applied safely
  check_library     step 3 on the laptop: manuals folders, reading PDFs, the manuals' copy, PDFs from a device
  check_logs        step 4 on the laptop: live-data logs, FORScan's folder watched, logs to and from devices
  check_prices      step 5: VPA's asking prices averaged (and one real read-only read that leaves vpa.db untouched)
  check_trims       step 6 on the laptop: Brochures folders, trims and facts from devices (each citing its page)
  check_factory     step 7 on the laptop: a car's trim and plate codes from devices, code tables, changes to a car
  check_app         the app's JS under node: search, the FORScan parser, every screen
  check_inbox_e2e   a running serve: a device posts a car and scan, serve applies, the copy has them
  check_offline     headless Chrome: sync, stop the listener, reopen offline, search
"""
from __future__ import annotations

import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUITES = ["check_dtc_import", "check_build", "check_srv", "check_scans", "check_library", "check_logs", "check_prices", "check_trims", "check_factory", "check_app", "check_inbox_e2e",
          "check_offline"]
LOGS = ROOT / "tests" / "synthetic" / "logs"


def run(name: str) -> tuple[str, int, str, float]:
    t0 = time.monotonic()
    p = subprocess.run([sys.executable, "-X", "utf8", "-m", f"tests.{name}"], cwd=str(ROOT), stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = p.stdout + p.stderr
    LOGS.mkdir(parents=True, exist_ok=True)
    (LOGS / f"{name}.log").write_text(out, encoding="utf-8")
    return name, p.returncode, out, time.monotonic() - t0


def main(argv: list[str]) -> int:
    suites = SUITES
    if "--quick" in argv:
        suites = [s for s in suites if s != "check_offline"]
    if "--only" in argv:
        suites = argv[argv.index("--only") + 1].split(",")
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(run, suites))
    bad = 0
    for name, code, out, secs in results:
        last = (out.strip().splitlines() or ["(no output)"])[-1]
        print(f"{'PASS' if code == 0 else 'FAIL'}  {name:<18} {last}  ({secs:.1f} s)")
        if code != 0:
            bad += 1
            for line in out.splitlines():
                if "FAIL" in line or "Error" in line or "Traceback" in line:
                    print("        " + line.strip())
    print(f"\n{len(results) - bad}/{len(results)} suites passed in {time.monotonic() - t0:.0f} s")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
