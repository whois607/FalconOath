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
- Local git only; data and samples are gitignored from day one. (25/10/2026: now also on GitHub, public, code only.)
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
- **Large content is synced per item.** The manuals' page text is its own copy (`library-<v>.json.gz`), apart from the data snapshot, so a new scan never re-downloads it. PDFs themselves are fetched per file, in byte ranges, and kept on the phone only when asked.
- **Ports.** Falcon uses listener 8767 and Tailscale HTTPS 8443. VPA's 8766 and 443 are never touched.
- **Manuals and brochures** stay on the laptop, in `manuals/<model>/` (gitignored). They never go into git or the app bundle.
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
    inbox.py  apply.py           device writes: inbox files, then applied (step 2; PDF uploads step 3)
    library.py                   manuals/ → data/library.db (page text) → library copy (step 3)
    livelog.py  vpa_prices.py    ← later steps
    app/                         THE front end
      index.html  app.css  sw.js  manifest.webmanifest  icons/ (192, 512, maskable)
      app.js                     router (#/), screens, sync, pairing
      garage.js  manuals.js      cars and scans (step 2); manuals, viewer, uploads (step 3)
      lib/idb.js  lib/dtc.js  lib/forscan.js  lib/manuals.js     pure functions, testable under node
      vendor/pdfjs/              pdf.js 4.10.38 (Apache-2.0)
  manuals/       (gitignored)  BA/ BF/ FG/ FGX/ General/ - your own PDFs
  data/          (gitignored)  falcon.db, library.db, settings.json, backups/, inbox/ (+ uploads/), sources/dtc.db
  output/phone/  (gitignored)  snapshot-<v>.json.gz, meta.json, library-<v>.json.gz, library-files.json, library-meta.json
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
| `scans` [2] | one FORScan TXT, **kept whole** | id (UUID), car_id NULL, file_name, sha256 UNIQUE (of the normalised text, worked out on the laptop), raw_text, scanned_on, note, imported_at, origin |
| `logs` [4] | one live-data CSV | id, car_id, file_name, sha256 UNIQUE, rows, columns JSON, duration_s, stored as `data/logs/<sha>.csv.gz` + downsampled series in the snapshot |
| `ads` [5] | a car seen for sale | id, car_id, source, listing_id, url, vpa_key, price, seen_at |
| `vpa_prices` [5] | precomputed ranges | model, trim, year, n, p10, median, p90, built_at |
| (library.db) [3] | the manuals' text index, **not in falcon.db** | `docs`(sha, pages, text_pages, error), `files`(path → sha, size, mtime), `pages`(sha, page, text). Rebuilt from the PDFs, so no backups; only `library.py` writes it |
| `trims`, `options`, `trim_options` [6] | from brochures | (designed in step 6) |
| `inbox_applied` [2] | what became of each device item | item_id (UUID) PK, device, kind, received_at, applied_at, result (applied / updated / duplicate / rejected), detail, target_id |

Built in step 2: there are no `scan_modules` / `scan_faults` tables. A scan is
stored as FORScan wrote it, and the one parser (`app/lib/forscan.js`) reads it
when it's shown. Nothing derived is stored, so a better parser later improves
every old scan, and there's no second (Python) parser to keep in step.

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
3. **Manual library** (built, see Status): `manuals/<model>/` folders, pypdf text per page into `data/library.db`, the text synced so search works offline, a bundled pdf.js viewer that streams byte ranges and opens at the matched page, "Keep on this phone", and PDFs sent from the phone in pieces. Still to come: OCR for scanned PDFs (Tesseract).
4. **Live data logs** (decided 25/10/2026, see "Step 4 design" below).

### Step 4 design: live data logs

What the logs are (all 8 samples): FORScan's CSV, `;`-separated, UTF-8,
CRLF; `time(ms)` then one column per PID as `NAME(unit)` (`ECT(°C)`,
`INST_LITRE_HR( )`, `CRUISE`). `-` means no value yet (only the first rows);
after that every row repeats each PID's latest value, a row every ~30 ms.
Some PIDs are text (`CRUISE` On/Off, `FAN_F` "No Fault"). 9 s to 10 min,
8 KB to 1.3 MB (21,598 rows).

Decisions (Luke): logs come in through the app (phone or laptop browser,
choosing the car) **and** by watching FORScan's own folder on the laptop;
**every** log is on the phone for no-signal use; the viewer adds health
checks, comparing two logs, and links to fault scans.

* **Stored in falcon.db** (`logs`, migration 3): the CSV, normalised, as a
  gzip BLOB (~1/5 the size), with its SHA-256 (same log twice = one log),
  rows, duration, PID headers, car (NULL until assigned), recorded date,
  note, origin. Recorded data, so it gets the backups and change_log like
  everything else. `watched` remembers which folder files were seen.
* **Watching FORScan's folder** (`OneDrive\Documents\FORScan` by default;
  `logs-folder` to change or turn off): read only, never written. A CSV is
  imported once it has stopped changing for 10 s (FORScan may still be
  writing it). They arrive with no car; the app assigns one (a new outbox
  item, `attach`, which can also move a scan to another car).
* **To devices:** the snapshot lists the logs (no data); `build` writes each
  log's gzip to `output/phone/logs/<sha>.csv.gz`, served by
  `GET /api/log/<sha>`. Devices download every log they lack after each sync
  and keep it gzipped in IndexedDB.
* **From devices:** the app gzips the CSV (CompressionStream) and sends it in
  pieces (`/api/upload`, as manuals), then a `log` outbox item.
* **One parser, in JS** (`lib/livelog.js`): columns and units, plain names
  for common PIDs, min/average/max, downsampling for drawing, the health
  checks, and the PIDs worth logging for a fault code. Python only checks a
  file is a FORScan log (header, rows, duration).
* **Viewer** (`#/log/<id>`): health-check tiles first; PID chips; one lane
  per PID on a canvas sharing the time axis; drag to pan, pinch or buttons
  to zoom, tap for a cursor with every lane's value; min/avg/max of what's
  on screen; compare: another log's same PIDs overlaid from the start.
* **Health checks** (only when the PIDs are there): fuel trims (long-term
  within ±10%), upstream O2 sensors switching and downstream steady (cat),
  coolant reaching temperature, charging voltage, idle steadiness.
* **Fault links:** a fault row and its code page say which PIDs to log for
  it, and link to this car's logs that have them.

Excludes: editing or deleting logs in the app; FORScan `.fsl` sessions;
TXT scans from the watched folder (a follow-up); unit conversions.
5. **VPA prices** (decided 25/10/2026: overall averages only, see "Step 5 design").

### Step 5 design: VPA prices (overall averages)

VPA has Falcons of every generation, all used; FalconOath counts BA to FG X.
(The figures themselves stay in VPA and the app: none in this public repo.)

* **Read** with VPA's own `read_frame` (opens vpa.db `mode=ro`, ~1 s), as
  VPA's INTEGRATION.md asks, in a child process (`python -m falconoath
  prices`), which closes it straight away. Nothing is ever written to VPA.
  The listener only stats vpa.db's size and date (never opens it) and
  refreshes once they've been still for 60 s (VPA's import finished).
* **Counted:** Ford Falcon, generations BA, BA MkII, BF, BF MkII, BF MkIII,
  FG, FG MkII, FG X; one price per car, its latest asking price; used only
  (condition new / new to order / demo left out); under $500 left out.
* **Per group** (model; series within it; trim within a model): cars, the
  median asking price (the headline "average"), the mean, the middle half
  (25th-75th percentile), median km, and how many were seen in the last 14
  days of captures.
* **Derived, not recorded:** kept in `data/prices.json` (rebuilt from VPA
  whenever it changes, so no backups), and put in the snapshot.
* **In the app:** a Prices screen (by model, then series and trims), and a
  one-line market figure on each car's page.

Excludes: per-ad tracking and linking ads to cars, price trends over time,
year or km adjustments, older Falcons.

### Step 6 design: trims and options, from your brochures only (25/10/2026)

Luke's choices: facts come **only from his own brochures** (nothing
pre-filled); brochures go in a **Brochures folder per model**; each trim
carries engines, gearboxes and power, standard gear and options, paint
colours, and wheels, tyres and dimensions.

* **Brochures:** `manuals/<model>/Brochures/` (made with the other folders;
  any folder named Brochures counts). They are manuals like any other
  (searched, viewed, kept on the phone); the library copy marks them
  `brochure: true`. A PDF sent from the phone can be marked "sales
  brochure" and is filed there.
* **Suggested, then confirmed:** `lib/brochure.js` reads a page's text and
  suggests facts: trim names it recognises, engine sizes, kW/Nm with rpm,
  gearboxes, L/100 km, wheel and tyre sizes, dimensions and weights,
  towing, colour lists, bullet points (standard gear or options). The
  matching words only help find things on a page; nothing is ever saved
  until Luke ticks it. The brochure page (`#/brochure/<sha>?p=`) shows
  the page beside its suggestions: tick, correct, choose the trim (or
  "the whole series", e.g. its colours), save. Anything can be typed in
  too (a scanned brochure has no text: type what you see).
* **Every fact cites its page** (brochure SHA-256 + page), checked on the
  laptop against the library; the trim page links each fact back to it.
* **Tables (migration 4):** `trims` (id, model, series, name, body, years,
  notes, doc_sha, page) and `trim_facts` (id, model, series, trim_id
  NULL = whole series, kind, label, value, code, doc_sha, page). Kinds:
  engine, power, torque, gearbox, fuel, standard, option, colour, wheels,
  tyres, dimension, weight, towing, other. `code` holds a paint or option
  code when the brochure prints one (for step 7).
* **From the devices:** outbox kinds `trim` and `fact` (op put / delete),
  applied after cars and before scans' attachments; every change in
  change_log; deleting a trim deletes its facts (each logged). Snapshot
  format /5 carries both tables.
* **In the app:** Browse (Home tile): model, then series, then a tile per
  trim (body, power, gearbox); each brochure with how far it's been read.
  A trim page: big power/torque/engine/gearbox/fuel tiles, standard gear,
  options, colours as chips, wheels/tyres and dimensions, each with its
  page link; the VPA price for that trim when VPA has one.

Excludes: reading brochures with no text (OCR), comparing trims side by
side, a car's own trim (step 7 links a car to its trim through the build
plate).

### Step 7 design: the factory checker, by plate codes (25/10/2026)

Luke's choices: **plate codes only** (no walk-around checklist); code
meanings come **from his manuals, ticked like brochure facts**; a car
remembers **its trim and its plate codes**.

* **Code tables are facts** (step 6's `trim_facts`), new kinds: paintcode,
  trimcode (interior), bodycode, modelcode. `code` holds the code, `value`
  what it means (Winter White; XR Sedan; Sedan XR), `label` anything else
  printed (Ford's four-character colour number). Usually for the whole model (series
  left blank). A brochure colour with a code counts as a paint code too.
* **Read from any manual:** the reader (`#/brochure/<sha>`) opens any PDF
  in the library ("Read for codes" in the viewer). `lib/brochure.js` also
  suggests code tables: under a "Body Style Code", "Model Code", "Paint
  Colour and Code" or "Trim Colour and Code" heading, a line ending in a
  code, and "Name (Q1) 6XXX" anywhere. Nothing is kept until ticked.
* Found on 25/10/2026: the BF manual's 100-01 has body, model, paint and
  trim codes as text; the VIN layout and plate pictures are images (no
  text, so no VIN decoding). The FG manual's 100-01 is the BF section
  with an FG header (same text, BF colours), so codes ticked from it
  would be BF's.
* **The car** (migration 5): `trim_id`, `paint_code`, `trim_code`,
  `body_code`, `model_code`, `build_date` (YYYY-MM) on `cars`. A trim must
  be the car's model. Deleting a trim clears it from its cars (logged).
  A device that doesn't send these fields leaves them as they were.
* **The check** (`lib/checker.js`, pure): each code looked up in the code
  tables of the car's model (its series, or the whole model; the nearest
  other model only as a hint, said so) and set against the trim: paint
  offered for that series/trim (when its colours are known), body and
  model code agree with the trim's body and name, build date within the
  trim's years and the model's run, the trim is the car's model. Each is
  good / check / problem / unknown (not in your code tables), with the
  page it came from.
* **In the app:** a "Factory check" card on each car: what it should be
  (its trim, with power, engine and gearbox, and a link to the trim page),
  the plate codes to type in (results update as you type), and a tile per
  check. Browse gets a Codes page per model (every code and its page).

Excludes: VIN decoding (no text source for the layout), a walk-around
checklist, compliance plate dates beyond build month, OCR of plate photos.
6–8. Trims/options from brochures, the factory checker (JS rules over label codes), then extras (news, quiz, oscilloscope CSVs, dash themes, autostart listener).

## Status
* 15/10/2026: plan written.
* 25/10/2026: **step 1 built** as FalconOath (package `falconoath`). All automated checks pass. Next: the 12-point phone checklist (section 5, also in NOTES.md) on the phone. Then step 2.
* 25/10/2026: **step 2 built**: cars, FORScan fault scans (upload on any device, or `import-scan` on the laptop), each fault explained from the DTC list with its status byte decoded and checked against FORScan's words, and the device outbox → laptop inbox. All automated checks pass (7 suites). Next: the step 2 phone checks in NOTES.md, then step 3.
* 25/10/2026: **step 3 built**: the manual library. `manuals/BA, BF, FG, FGX, General` (made by setup and by serve, with a README); serve reads new or changed PDFs in a background child (pypdf, ~17 ms a page) into `data/library.db` and writes the library copy; the Manuals tab lists and searches every page (offline), the search and code pages show "In your manuals", the pdf.js viewer streams byte ranges from `/api/manual/<sha>` and opens at the page; "Keep on this phone" stores the PDF in its own cache, which the service worker serves with ranges; a PDF picked on the phone goes up in 2 MB pieces (`PUT /api/upload/<id>`, resumable), then a `manual` outbox item files it into `manuals/<folder>/` (duplicates by SHA-256). All automated checks pass (8 suites). Next: the step 3 phone checks in NOTES.md.
* 25/10/2026: **step 4 built**: live-data logs, as designed above ("Step 4 design"). Schema 3; app upload and FORScan's folder watched; every log on the device; the canvas viewer with health checks, compare, and links from faults. Checked in the browser on copies of the 8 sample logs. All automated checks pass (9 suites). Next: the step 4 phone checks in NOTES.md, then step 5 (VPA prices).
* 25/10/2026: **step 5 built**: VPA prices, overall averages ("Step 5 design"). `prices` reads VPA read-only (~1-2 s, vpa.db proven untouched in the tests), `data/prices.json`, snapshot format /4; a Prices screen (model, series, trims, with range bars), a market line on each car, a Prices tile on Home (Browse comes back in step 6). All automated checks pass (10 suites). Next: step 6 (trims and options from brochures).
* 25/10/2026: **step 6 built**: trims and options from your own brochures ("Step 6 design"). `manuals/<model>/Brochures`, schema 4 (`trims`, `trim_facts`), outbox kinds `trim`/`fact`, snapshot format /5; the brochure reader (page beside its suggestions; tick, choose the trim, save), Browse, trim and series pages, deletes. Checked in the browser on a made-up brochure (scratch home). All automated checks pass (11 suites). Next: the step 6 phone checks in NOTES.md with a real brochure, then step 7 (the factory checker).
* 25/10/2026: **step 7 built**: the factory checker, by plate codes ("Step 7 design"). Code tables (paint, interior trim, body, model codes) ticked from any manual page with the reader; schema 5 (a car's trim and plate codes); a car change is an item naming its car; `lib/checker.js` checks each code against the tables and the trim (good / check / doesn't fit / unknown, each with its page); a Factory check card on every car and a Codes page per model. Checked in the browser on a made-up FG codes page (scratch home), and the code suggestions on the real BF 100-01 pages (read only, nothing saved). All automated checks pass (12 suites). Next: the step 7 phone checks in NOTES.md, then step 8 (extras).
* 25/10/2026: **FORScan's folder, straight away**: fault scans (.txt) as well as logs are picked up within ~3 s of FORScan saving them; `/api/wait` lets open apps sync at once; the app opens the new scan or log, and the laptop's browser does if the app isn't open there (O turns it off). All automated checks pass (12 suites).
