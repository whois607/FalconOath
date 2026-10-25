# FalconOath: PLAN

## Context

Luke wants an offline Falcon app (FG X, FG, BF, BA) that works on the laptop and the phone (an Android phone, Firefox for Android). Data is built on the laptop. The front end runs fully offline on both devices and syncs over Tailscale, using the VPA pattern in `falcon-mobile-sync.md`. The car is the central record. The overall plan is in the drawio: Homepage → Browse / Search / Upload; codes DB, VPA prices, trim info from brochures/manuals; a factory checker; FORScan uploads.

Starting state found (15/10/2026). `docs/`, `data/`, `tools/` and `samples/` don't exist yet. The sources are:
- `Downloads/Falc application(1).drawio` (newer; adds "Fed by sales brochures, official service manuals").
- `DTC/dtc.db`: table `dtc` has 1,195 rows (BA 246, BF 397, FG 552), with columns model, dtc, description, mechanical, sensor, electrical, other, first_seen. There are no FG X rows. A few codes are messy (`P0355 -`, `P1709KOEO`) and some are duplicated per model (U0073, U1900 in FG). `DTC/dtc_archive.py` is the forum scraper that built the database.
- `Documents/FORScan/`: 4 fault TXTs (`===MOD DTC CODE:FTB-ST===` blocks, `Status (-xx)`, symptom lines, optional "details" text; **no VIN**) and 8 live-data CSVs (`;`-separated, `time(ms)` plus PID(unit) columns, `-` for missing values, up to 21k rows).
- Tailscale: the laptop already runs `serve` on 443 → 127.0.0.1:8766 (VPA). Funnel is off. The phone is on the same tailnet.

Decisions confirmed by Luke:
- New `falcon-app/` with copies of the sources; the originals stay untouched.
- Local git only; data and samples are gitignored from day one.
- The phone can add things (cars, notes, imports). They queue to the laptop, which owns the DB and applies them. Step 1 is still read-only, but IDs and tables are designed for this now.
- FG X uses the FG DTC rows, clearly labelled "from FG data".


---

## 1. Architecture

```
 LAPTOP (owns all data)                                  PHONE / LAPTOP BROWSER
 ┌──────────────────────────────────────────┐            ┌───────────────────────────┐
 │ sources (read-only): data/sources/dtc.db │            │ PWA (one codebase)        │
 │   later: PDFs (own paths), FORScan files,│            │  IndexedDB: snapshot,     │
 │   VPA vpa.db (ro, short reads)           │            │   later library blobs,    │
 │        │ import (backup first, logged)   │            │   outbox (phone writes)   │
 │        ▼                                 │            │  CacheStorage: shell      │
 │ data/falcon.db  (SQLite, the master)     │            │  localStorage: token,     │
 │        │ build (ro, hash-versioned)      │  Tailscale │   prefs                   │
 │        ▼                                 │   HTTPS    │                           │
 │ output/phone/snapshot-<v>.json.gz + meta ├──:8443────►│ sync(): meta → snapshot   │
 │        ▲                                 │            │  → verify → swap          │
 │ falconoath/srv.py listener 127.0.0.1:8767│◄───────────┤ outbox POST (step 2+)     │
 │  (cannot import sqlite/db code)          │            └───────────────────────────┘
 │  inbox/ files → `falcon apply` → DB      │
 └──────────────────────────────────────────┘
```

Rules:
- **Python never renders screens.** It imports, builds data and serves files. All UI and lookup logic (DTC search, later VIN decode, factory checks, status-byte decode) is written once in JS. This means no Python/JS parity tests, which were VPA's biggest cost.
- **One front end.** The laptop uses the same PWA at `https://<laptop>.<tailnet>.ts.net:8443` (or `http://localhost:8767`, which also counts as a secure origin).
- **falcon.db is the only thing written.** Source files (`dtc.db`, PDFs, FORScan files, `vpa.db`) are opened read-only. VPA is read with `mode=ro`, through short reads or the backup API, as `INTEGRATION.md` describes.
- **Data safety.** Every DB write command first backs up `falcon.db` (SQLite backup API → `data/backups/falcon-<ts>.db`, newest 10 kept), runs in one transaction, and writes `change_log` rows. Imports are idempotent and keyed by the file's sha256.
- **Phone writes (from step 2).** The phone creates records with a UUID made on the device, so IDs never collide. They go to an IndexedDB outbox, then `POST /api/inbox`. The listener only writes a JSON file to `data/inbox/` (size-capped). The laptop app or `python -m falconoath apply` validates and applies them with a backup. The phone keeps showing its local pending items, marked "not yet on laptop", until they appear in a snapshot.
- **Large content is synced per item.** The PDF library (step 3) uses a manifest of sha256 entries, with per-file download, Range/resume and persistent storage. The data snapshot stays one small blob (~250 KB for step 1).
- **Ports.** Falcon uses listener 8767 and Tailscale HTTPS 8443. VPA's 8766 and 443 are never touched.
- **Manuals and brochures** stay where Luke keeps them. Settings store only their folder paths. They never go into git or the app bundle.
- **dtc_archive.py** is kept in `tools/` for reference only. The app never runs it, per the no-scraping rule. `dtc.db` is treated as a fixed source.

## 2. Folder structure

```
falcon-app/
  PLAN.md  CLAUDE.md  NOTES.md  README.md  .gitignore
  FalconOath.bat                 start listener + open app (step 1: manual start)
  falconoath/                    Python package (stdlib only for step 1)
    __main__.py  cli.py          python -m falconoath <init|import-dtc|build|serve|pair|status|apply>
    paths.py                     all paths in one place
    db.py                        connect, migrations (schema_version), backup, change_log
    dtc_import.py                data/sources/dtc.db → falcon.db (normalise codes)
    build.py                     snapshot builder (ro; version = sha256(data, format, builder code))
    cfg.py                       settings/pairing/tokens, stdlib, locked atomic writes (from vpa/phonecfg.py)
    srv.py                       listener (from vpa/phonesrv.py; imports cfg only)
    tailnet.py                   reads tailscale status (copied from vpa/tailnet.py; read-only)
    forscan.py  library.py  livelog.py  vpa_prices.py  inbox.py     ← later steps
    app/                         THE front end
      index.html  app.css  sw.js  manifest.webmanifest  icons/ (192, 512, maskable)
      app.js                     router (#/), screens, sync, pairing
      lib/idb.js  lib/dtc.js     pure functions, testable under node
      vendor/                    pdf.js later (step 3)
  data/          (gitignored)  falcon.db, settings.json, backups/, inbox/, sources/dtc.db
  output/phone/  (gitignored)  snapshot-<v>.json.gz, meta.json
  docs/          Falc_application.drawio
  tools/         dtc_archive.py (reference only, gitignored as it names the site)
  samples/       (gitignored)  forscan/*.txt, *.csv  (copied from Documents/FORScan)
  tests/         run_all.py, check_*.py, js_check.js (node), fixtures/ (synthetic, anonymised)
```

Reused from VPA (copied and adapted, not imported): `vpa/phonecfg.py` (pairing, tokens, locked atomic writes, OneDrive retry), `vpa/phonesrv.py` (`allowed_ip`, lockout, ETag/304, `__BUILD__` stamping, manifest), `vpa/tailnet.py`, `vpa/phonebuild.py` (`_private_copy`, keep-newest-two, meta-last), `vpa/phone_app/sw.js` and the `sync()`/IndexedDB parts of `vpa/phone_app/app.js`, and `tests/phone_js_check.js`.

## 3. Database (`data/falcon.db`)

Each step adds tables through a numbered migration. Step 1 creates only those marked **[1]**.

| table | purpose | key columns |
|---|---|---|
| `meta` **[1]** | schema version, settings | key, value |
| `models` **[1]** | BA, BF, FG, FGX | code PK, name, year_from, year_to, `dtc_model` (FGX→FG) |
| `dtc_sources` **[1]** | each imported DTC file | id, file, sha256 UNIQUE, imported_at, rows |
| `dtc` **[1]** | fault code rows | id, model, `code` (normalised, e.g. P0355), `code_raw`, `qualifier` (e.g. KOEO), description, mechanical, sensor, electrical, other, source_id; UNIQUE(model, code_raw, description, …); index(code, model) |
| `change_log` **[1]** | audit/undo of every write | id, at, origin (laptop/phone:<device>), table, row_id, action, before, after (JSON) |
| `cars` [2] | **the central record** | id (UUID), vin NULL (unique when set), model, year, build_date, trim, engine, colour, nickname, `kind` (mine / other / ad), notes, created_at, created_on, updated_at |
| `car_labels` [6/7] | build-plate / ID-label codes | id, car_id, label, field, value, source |
| `scans` [2] | one FORScan TXT | id, car_id NULL, file_name, sha256 UNIQUE, scanned_at, imported_at, origin |
| `scan_modules` [2] | per-module result | scan_id, module, module_name, result (ok / faults) |
| `scan_faults` [2] | per-fault | id, scan_id, module, code, ftb (e.g. 87), status_byte (e.g. 0x28), forscan_title, symptom_text, status_lines, details |
| `logs` [4] | one live-data CSV | id, car_id, file_name, sha256 UNIQUE, rows, columns JSON, duration_s, stored as `data/logs/<sha>.csv.gz` + downsampled series in the snapshot |
| `ads` [5] | a car seen for sale | id, car_id, source, listing_id, url, vpa_key, price, seen_at |
| `vpa_prices` [5] | precomputed ranges | model, trim, year, n, p10, median, p90, built_at |
| `library_files` [3] | user's PDFs | sha256 PK, path, title, kind, models, pages, size, indexed_at, ocr |
| `library_pages` + FTS5 [3] | page text index | sha256, page, text |
| `trims`, `options`, `trim_options` [6] | from brochures | (designed in step 6) |
| `inbox_applied` [2] | phone items applied | item_id (phone UUID) PK, device, kind, applied_at, result |

Car linking: FORScan TXTs have no VIN, so a scan is attached to a car by choosing one (or "new car") at import. A car without a VIN (another person's ad) is allowed. If a VIN is added later and matches an existing car, the app offers a merge, recorded in `change_log`.

## 4. Step 1: exactly what's in and out

**Includes**
1. Create `falcon-app/`, `git init` (local), `.gitignore` (data/, output/, samples/, tools/dtc_archive.py, `*.db`), CLAUDE.md (rules: data safety, ports, no scraping), NOTES.md. Copy the drawio, `dtc.db`, `dtc_archive.py` and the FORScan samples in. Originals are untouched; sha256 is checked after copying.
2. `python -m falconoath init` creates `falcon.db` with migration 1 and seeds `models`.
3. `python -m falconoath import-dtc` reads `data/sources/dtc.db` read-only, normalises codes (trims ` -`, splits `P1709KOEO` → P1709 + KOEO), keeps duplicates as separate rows, and skips the import if the sha256 is already present. It backs up first.
4. `python -m falconoath build` writes `output/phone/snapshot-<v>.json.gz` (`format: "falconoath-snap/1"`, version, built_at, counts, models, dtc rows as arrays) and then `meta.json`. It keeps the newest two and writes nothing if unchanged.
5. `python -m falconoath serve`: listener on 127.0.0.1:8767 with routes `/ping`, `POST /api/pair`, `/api/meta`, `/api/snapshot` (ETag/304) and the app files with BUILD stamped into `sw.js`. It allows only loopback, private and 100.64/10 clients, and **every /api route needs a token, even from loopback** (Tailscale serve proxies from 127.0.0.1, so loopback proves nothing). It rebuilds the snapshot on start if stale. `python -m falconoath pair` prints a 6-digit code (10 min, 5 tries) and the laptop pairs the same way. `python -m falconoath status` shows the tailscale serve/funnel state, read-only.
6. PWA:
   - **Home**: Browse / Search / Upload tiles. Search works; Browse and Upload show "coming in step N". The header shows the model chooser (BA, BF, FG, FG X; remembered) and the sync status line.
   - **DTC Search**: type `P0325`, `p325`, `0325` or words ("knock"). Code matches come first, then text matches, filtered to the chosen model or "All". FG X shows FG rows with a "from FG data" badge.
   - **Code detail**: description, then Mechanical / Sensor / Electrical / Other sections, hiding empty ones. Other models' rows for the same code sit in a collapsed block.
   - **Settings**: pair/unpair, last sync (DD/MM/YYYY HH:MM), data version and counts, `storage.estimate()` and persisted yes/no, light/dark, app build.
   - Offline vs unreachable status. When unreachable, an "Open Tailscale" intent button.
   - Service worker with a cache-first shell that never caches `/api/`. Manifest with 192/512 PNG icons (any + maskable separately), standalone. `navigator.storage.persist()` on first run.
7. Tests (`python -m tests.run_all`, also runs node): see section 5.
8. `FalconOath.bat`: starts the listener and opens the browser.

**Excludes (later steps)**: cars and the VIN screen; FORScan import and status decode (step 2); the phone outbox/inbox (step 2, when the first phone write exists); PDFs (3); live data (4); VPA (5); trims/factory checks (6–7); dash themes beyond light/dark (an extra); a background listener at Windows startup (an extra; step 1 is a manual start); editing DTC data; running the scraper.

## 5. Testing

**Automated (laptop)**
- `check_dtc_import`: 1,195 rows in; per-model counts 246/397/552; `P0355 -` → P0355; `P1709KOEO` → P1709 + KOEO; a re-run adds 0; the source file's sha256 is unchanged; a backup is created.
- `check_build`: a rebuild with no changes writes nothing; `meta.json` never names a missing file; the version changes when the data or the builder's code changes (app files have their own BUILD stamp); counts match the DB.
- `check_srv`: walking the imports finds no `sqlite3`, `db` or `build` in `srv`/`cfg`; `allowed_ip` cases; pairing expiry, 5-try limit, token stored hashed, removal locks out; loopback without a token gets 401; ETag/304; a body cap.
- `js_check.js` (node): `lib/dtc.js` search cases (P0325 BA, `0325`, "knock", FG X → FG with badge, U0073 FG shows both rows); every screen renders the real snapshot with no `undefined` or `NaN`.
- Offline smoke test in headless Chrome (short `--user-data-dir`): load, kill the listener, reload, and the app renders from cache.

**On Luke's real phone** (Android, Firefox, Tailscale). Step 1 is done when all of these pass:
1. Laptop: `python -m falconoath serve`. Once, Luke runs `tailscale serve --bg --https=8443 8767`. `python -m falconoath status` shows `:8443 → 8767`, VPA's `443 → 8766` still present, and Funnel off.
2. Phone with Tailscale on: Firefox → `https://<laptop>.<tailnet>.ts.net:8443`. The home page loads.
3. Settings → Pair → enter the code from `python -m falconoath pair`. Sync completes and shows 1,195 codes and today's date in DD/MM/YYYY.
4. Firefox menu → Install / Add to home screen. The Falcon icon appears (not a blank or default icon).
5. Search `P0325` with BA selected and see the knock sensor row. Choose FG X, search a U-code, and the "from FG data" badge shows.
6. **Offline**: aeroplane mode on, swipe Firefox away, open from the home-screen icon. The app opens, search works, and the status says "Offline – data from dd/mm/yyyy".
7. **Unreachable**: aeroplane mode off, Tailscale off. The status says "Laptop unreachable" with the Open Tailscale button, which opens Tailscale. Turn it on, return, and it syncs within ~5 s.
8. **App update**: change a line of CSS on the laptop and reopen the phone app. It reloads once onto the new build (Settings shows the new build).
9. **No-change sync**: reopen. The phone fetches meta only, with no snapshot download (visible in the listener log).
10. Settings shows persisted storage = yes (or Luke accepts Firefox's prompt) and a usage figure.
11. The laptop browser at the same 8443 address works identically after pairing.
12. VPA's phone app still syncs as before (no interference).

## 6. Later steps (outline only)

2. **FORScan TXT import**: laptop drag-in and phone file-picker (outbox). The parser lives in JS (shared) and the laptop applies results. Each fault shows FORScan's own text, the dtc.db explanation for the car's model, and the decoded FTB and status byte. The status byte is decoded from the bits (UDS bits: testFailed, pending, confirmed, MIL…), checked against FORScan's printed status lines across all 4 samples. Header/status mismatches (e.g. HIM header `-2F` vs `Status (-20)`) are investigated first. Each scan is attached to a car; this introduces `cars`.
3. **Manual library**: laptop folder settings, PyMuPDF text extraction plus optional Tesseract OCR, FTS index, a per-file manifest, on-demand phone downloads, and a bundled pdf.js viewer that opens at the matched page.
4. **Live data CSVs**: parse `;` CSVs with `-` for missing values, store gzipped, downsample for the phone, and chart in SVG with the PID picker (reusing fg-cruise-efficiency's knowledge of these logs).
5. **VPA prices**: `read_frame` (ro), Falcon rows only, excluding new/demo, giving per model/trim/year ranges. Ads link to cars by `listing_id`.
6–8. Trims/options from brochures, the factory checker (JS rules over label codes), then extras (news, quiz, oscilloscope CSVs, dash themes, autostart listener).

## Status
* 15/10/2026: plan written.
* 25/10/2026: **step 1 built** as FalconOath (package `falconoath`). All automated checks pass. Next: the 12-point phone checklist (section 5, also in NOTES.md) on the phone. Then step 2.
