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
  (logs) and DTC report .txts (scans) from it (no car) and remembers them
  in `watched`; it never writes there. The listener checks it every second;
  open apps hear through `/api/wait` and open the new item themselves.
  A test or scratch home (FALCONOATH_HOME) never watches the real one.
  Logs are kept whole in falcon.db; `app/lib/livelog.js` is their only parser.
* **VPA is only read.** `vpa_prices.read` uses VPA's own `read_frame`
  (mode=ro) in a child process; the listener only stats vpa.db. Never
  write to, copy, or hold open `vehicle-price-analysis/data/vpa.db` (its
  INTEGRATION.md). A test or scratch home reads VPA only if FALCONOATH_VPA
  names it. `data/prices.json` is derived (no backups).
* **What the app knows comes from your own manuals and brochures.** Two
  ways in, and every entry cites a PDF page:
  * **Built in**: `data/sources/reference.json`, read by hand from the PDFs
    in `manuals/` (its maker, `data/sources/make_reference.py`, finds each
    page by a phrase from it). Code tables (paint, interior trim, body,
    model, engine and gearbox codes), FG X trims and their facts, service
    specs. `reference.py` checks it and links each citation through the
    library index (read-only); the snapshot carries it as `ref`. It is Ford
    content: it lives in data/ and never goes in git (tests use the invented
    `tests/fixtures/reference_fixture.json`). A **research** entry (from
    outside your manuals, e.g. paint OT = Octane) carries a `research` note
    instead of a page: the app marks it, and `app/lib/checker.js` only ever
    "notes" it, never calls it factory. Never add a code or figure that
    isn't on a page of Luke's PDFs, except as research, saying why.
  * **Ticked**: trims and facts saved from a page with the brochure reader;
    `trims.py` refuses one that doesn't cite a page in the library.
    `app/lib/brochure.js` only suggests; its trim names are search words.
  A plate code in neither is "unknown", never guessed. Built-in rows can't
  be edited or deleted in the app; a ticked fact the same as a built-in one
  shows once (the ticked one).
* **FalconOath.exe** (PyInstaller, onedir, `dist/`, gitignored) finds the
  project by walking up from itself (`paths.FROZEN`) and serves the screens
  from `falconoath/app/` in the project, so screens change without a rebuild;
  Python changes need `tools/build_exe.py`. Children are `cli.self_cmd(...)`
  (the .exe with a command when frozen). The window pairs itself with a
  one-time code (`cfg.start_launch`, in its URL) as "This laptop"
  (`laptop: true`); only that device may use `POST /api/laptop`, and the
  listener only queues folder/stop requests (`srv.ACTIONS`) for cli's loop.
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
    python -m falconoath app        what FalconOath.exe does: serve --hidden if needed, then its window (also: open)
    python -m falconoath window     just the window (pywebview / WebView2), --at "#/scan/ID"
    python tools/build_exe.py       (Setup FalconOath.bat) builds dist/FalconOath/FalconOath.exe, then the shortcuts
    python tools/make_launcher.py   only the shortcuts (to the .exe if built)
    python -m falconoath pair       six-digit code (or P in the listener window, or Pair.bat)
    python -m falconoath devices / unpair ID / status
    python -m falconoath import-scan FILE... --new-car NAME --model FG   (or --car ID)
    python -m falconoath cars       cars and their scans
    python -m falconoath trims      trims and facts read from your brochures (manuals/<model>/Brochures)
    python -m falconoath reference  what's built in (data/sources/reference.json), and any page it can't link
    python data/sources/make_reference.py   rewrite reference.json (edit the entries in it first)
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
