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
* **The listener can't reach a database.** `srv.py` imports only `cfg` and
  `paths`, and `tests/check_srv.py` enforces it. Builds run in a child
  process.
* **Python never renders screens.** UI and lookup logic live once, in JS
  (`app/lib/*.js`), and are tested under node (`tests/js_check.js`).
* **Ports:** listener 127.0.0.1:8767, Tailscale HTTPS 8443. VPA owns 8766
  and 443; never touch them.
* **Local git only.** `data/`, `output/`, `samples/` and `tools/dtc_archive.py`
  are gitignored. They hold forum and Ford content and friends' cars. The app
  ships code only.
* **No scraping.** `tools/dtc_archive.py` is kept for reference and is never
  run. `dtc.db` is a fixed source.
* Australian dates on screen (DD/MM/YYYY). Australian spelling.

## Commands

Python: `%LOCALAPPDATA%\Programs\Python\Python312\python.exe -X utf8`

    python -m falconoath setup      init + import-dtc + build
    python -m falconoath serve      listener (FalconOath.bat starts it and opens the app)
    python -m falconoath pair       six-digit code for a phone or browser
    python -m falconoath devices / unpair ID / status
    python -m tests.run_all         every check (~5 s; --quick skips headless Chrome)
    python tools/make_icons.py      redraw the icons (Pillow)

Tests set FALCONOATH_HOME to `tests/synthetic/<suite>` and never touch the
real data.

Git: `git -c user.email=lukejulius607@gmail.com commit ...`. Push only when
asked (there is no remote).
