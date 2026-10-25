# FalconOath (falcon-app/)

Offline Falcon app for BA, BF, FG and FG X. The laptop (Python + SQLite)
builds the data. One web app (`falconoath/app/`) runs on both the phone and
the laptop, and syncs over Tailscale using the VPA pattern. PLAN.md has the
architecture, the tables and the build order. NOTES.md has the history and
the phone checklist.

## Rules

* **Data safety first.** Only `data/falcon.db` is ever written, and only
  through `db.writing()`: a backup first, then one transaction, logged in
  `change_log`. Sources (`data/sources/dtc.db`, and later PDFs, FORScan
  files and VPA's `vpa.db`) are opened with `db.connect_ro` only. Commit
  before changes. Back up before any data operation.
* **The listener can't reach a database.** `srv.py` imports only `cfg`,
  `inbox` and `paths`, and `tests/check_srv.py` enforces it. Device writes
  land as files in `data/inbox/`. Builds and `apply` run in child processes.
* **FORScan reports are stored whole** (`scans.raw_text`). The only parser
  is `app/lib/forscan.js`; don't add a Python one.
* **Manuals are only read.** `manuals/` holds your own PDFs; nothing moves,
  changes or deletes them except `apply.py` filing a device's upload into a
  folder (never over a file). `data/library.db` is an index rebuilt from them
  (`library.py` only), so it has no backups. The listener serves a PDF only
  by SHA-256 through `output/phone/library-files.json`, inside `manuals/`.
* **FORScan's folder is only read.** `livelogs.watch` imports settled CSVs
  from it (no car) and remembers them in `watched`; it never writes there.
  A test or scratch home (FALCONOATH_HOME) never watches the real one.
  Logs are kept whole in falcon.db; `app/lib/livelog.js` is their only parser.
* **VPA is only read.** `vpa_prices.read` uses VPA's own `read_frame`
  (mode=ro) in a child process; the listener only stats vpa.db. Never
  write to, copy, or hold open `vehicle-price-analysis/data/vpa.db` (its
  INTEGRATION.md). A test or scratch home reads VPA only if FALCONOATH_VPA
  names it. `data/prices.json` is derived (no backups).
* **Python never renders screens.** UI and lookup logic live once, in JS
  (`app/lib/*.js`), and are tested under node (`tests/js_check.js`).
* **Ports:** listener 127.0.0.1:8767, Tailscale HTTPS 8443. VPA owns 8766
  and 443; never touch them.
* **Code only in git (the GitHub repo is public).** `data/`, `output/`,
  `samples/`, `manuals/` and `tools/dtc_archive.py` are gitignored. They hold
  forum and Ford content, your PDFs and friends' cars. The app ships code only.
* **No scraping.** `tools/dtc_archive.py` is kept for reference and is never
  run. `dtc.db` is a fixed source.
* Australian dates on screen (DD/MM/YYYY). Australian spelling.

## Commands

Python: `%LOCALAPPDATA%\Programs\Python\Python312\python.exe -X utf8` (needs `pypdf`: `python -m pip install -r requirements.txt`)

    python -m falconoath setup      init + import-dtc + build + library (makes manuals/)
    python -m falconoath serve      listener
    python -m falconoath open       the desktop icon: starts serve in its own window if needed, opens the app
    python tools/make_launcher.py   (Setup FalconOath.bat) the icon on the Desktop + Start menu
    python -m falconoath pair       six-digit code (or P in the listener window, or Pair.bat)
    python -m falconoath devices / unpair ID / status
    python -m falconoath import-scan FILE... --new-car NAME --model FG   (or --car ID)
    python -m falconoath cars       cars and their scans
    python -m falconoath apply      apply data/inbox/ by hand (serve does it by itself)
    python -m falconoath library    read new PDFs in manuals/ and update the copy (serve does it by itself)
    python -m falconoath import-log FILE... --car ID   (or --new-car NAME --model FG)
    python -m falconoath logs / logs-folder [PATH|--off|--default] / watch-logs
    python -m falconoath prices     VPA's Falcon asking prices -> data/prices.json (serve does it by itself)
    python -m tests.run_all         every check (~5 s; --quick skips headless Chrome)
    python tools/make_icons.py      redraw the icons (Pillow)

Tests set FALCONOATH_HOME to `tests/synthetic/<suite>` and never touch the
real data.

Git: commit with the workspace's email (see the workspace CLAUDE.md). Push only when
asked. The remote is public on GitHub: code only, never data, manuals, samples or
personal details (device names, paths, friends' names).
