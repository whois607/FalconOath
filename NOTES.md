# FalconOath notes

## History

* **15/10/2026** Plan written (PLAN.md). Decisions: a new `falcon-app/` with
  copies of the sources; local git only; the phone may add things later
  (queued to the laptop); FG X reads FG's DTC rows, labelled.
* **25/10/2026** Step 1 built. App named **FalconOath**. The package is
  `falconoath`, not `falcon`, which clashes with a well-known Python web
  library.
  * Sources copied into the project and checked by SHA-256: the drawio
    (newer copy) to `docs/`, `dtc.db` to `data/sources/`, `dtc_archive.py`
    to `tools/`, and the 5 FORScan TXTs and 8 CSVs to `samples/forscan/`.
    Originals untouched.
  * `falcon.db` schema 1: meta, models, dtc_sources, dtc, change_log.
    1,195 rows (BA 246, BF 397, FG 552), 578 distinct codes.
  * The data copy is ~30 KB gzipped. Its version hashes the content, the
    format and the builder's code (build.py). The front end has its own
    BUILD stamp, so a CSS change doesn't re-download data.
  * Tests: 5 suites, all passing (`python -m tests.run_all`, ~5 s),
    including a headless Chrome reopen with the listener stopped.
  * Checked in the built-in browser on a scratch copy (port 8777): pair,
    sync, search, code pages, FG X badge, phone width, an app update
    replacing the old shell cache, and reopening offline.

* **25/10/2026** Luke couldn't pair: the listener window doesn't take typed
  commands, and a plain cmd window has no `python` on PATH. Fixed: the
  listener window now answers keys (**P** pairing code, **D** devices,
  **S** Tailscale status, **Q** stop), plus double-clickable `Pair.bat`
  and `Devices.bat`, and the messages in the app say so.

* **25/10/2026** Step 2 built: cars and FORScan fault scans.
  * Schema 2: `cars`, `scans` (the report kept whole) and `inbox_applied`.
    Your falcon.db is migrated the first time `serve` starts (backup first),
    or by `python -m falconoath init`.
  * Devices keep new cars and scans in an outbox (IndexedDB) and send them
    to `POST /api/inbox`. The listener only writes `data/inbox/*.json`.
    `serve` then applies them in a child process (checks, backup, one
    transaction, change_log), rebuilds the data copy, and moves the file to
    `inbox/done/`. Results go back in the copy (`applied`) and clear the
    outbox. Refused items stay on the device with the reason until dismissed.
    About 5 s end to end.
  * Laptop imports: `python -m falconoath import-scan FILE... --new-car NAME
    --model FG` (or `--car ID`). `python -m falconoath cars` lists them.
  * The parser is in JS only (`app/lib/forscan.js`). All 5 real reports
    parse completely (104 blocks, 78 faults).

* **25/10/2026** After Luke's first phone test: the status wasn't clear
  enough. Each fault now says in plain words what its status means (active,
  pending, or stored), what else the flags add, and a sensible next step.
  "How this was worked out" explains the status byte: all 8 flags as
  yes/no, or the older modules' status + symptom split. The scan page is
  grouped by status (Active → Pending → Stored → Not understood), with a
  By module toggle kept on the device.
* **25/10/2026** Too wordy for checking a car in the yard. The scan page
  now opens with big counts (Active / Pending / Stored / Clean modules; tap
  one to jump to it), and each fault is a short row: code, module, a lamp
  icon if the lamp is on, and FORScan's title. Tap a row for the rest:
  short status tags (Confirmed, Lamp on, ...), the symptom, a one-line next
  step, the fault list's explanation, notes and the status byte. On a
  laptop the page goes up to 1240 px wide with rows in columns.
* **25/10/2026** A desktop icon, like VPA's: `Setup FalconOath.bat`
  (tools/make_launcher.py) draws assets/falconoath.ico from the phone icon
  and makes "FalconOath" shortcuts (Desktop, Start menu, this folder) to
  `pythonw -m falconoath open`. That pings /ping; if nothing answers it
  starts `serve` in its own console (the keys need one), waits for it, then
  opens the browser. Unlike VPA, the listener keeps its window: P/D/S/Q.
* **25/10/2026** Step 3 built: the manual library (see PLAN.md, Status).
  * Folders: `manuals/BA, BF, FG, FGX, General` + README.txt, made by
    `setup` and by `serve`. Press M in the listener window to open them.
  * Reading: pypdf (`requirements.txt`), page by page, in a child process
    so the listener keeps serving; again only when a file's size or date
    changes; renamed/moved/copied files are recognised by SHA-256. A real
    145-page PDF took 2.5 s. Scanned pages have no text (counted, and
    the app says "scanned: no text to search yet").
  * `data/library.db` is an index, not recorded data: rebuilt from the
    PDFs, no backups. Only the manuals' *text* goes to devices
    (`library-<v>.json.gz`, separate from the snapshot).
  * Viewer: pdf.js 4.10.38 vendored (`app/vendor/pdfjs`, Apache-2.0).
    It streams 1 MB byte ranges (files over 2 MB), renders pages near
    the screen only, and drops far ones. Checked: a 9.7 MB, 1,500-page
    test PDF opened at page 1,235 with range requests.
  * Keep on this phone: the PDF in Cache Storage (`falconoath-manuals`),
    downloaded in 4 MB ranges; the service worker answers
    `/api/manual/<sha>` from it, ranges included. Checked with the
    listener stopped: the kept manual opened, search worked, an unkept
    one said why it couldn't open.
  * From the phone: the PDF waits in IndexedDB (`upl:<id>`), goes up in
    2 MB pieces (`PUT /api/upload/<id>?offset=`, a resent piece is
    refused so it can't double up; resumes from what the laptop has),
    then a `manual` item is applied: size and %PDF checked, filed into
    `manuals/<folder>/` under a safe name (never over a file), logged in
    change_log, a duplicate (same SHA-256) deleted. Checked in the
    browser: 5 MB up, filed, read and searchable in ~10 s.

## FORScan status bytes (worked out from the real reports, 25/10/2026)

Two header forms:

* `U0140:87-28` (newer modules: ABS, IPC): `87` is the symptom byte (FTB),
  and `28` is a standard ISO 14229 status byte, which FORScan prints
  unchanged (`Status (-28)`). Bits: 01 failing now, 02 failed this drive
  cycle, 04 pending, 08 confirmed, 10 self-test not finished since clear,
  20 failed since clear, 40 self-test not finished this cycle, 80 lamp.
  Seen: 28, 48, 68.
* `B1267-2F` (older modules: PCM, HIM, FDIM, PAM, ACM, BEM, IC, and the
  BA's PCM): one byte, two halves. The high half is the status, which is
  what FORScan prints (`2F` → `Status (-20)`, `63` → `-60`). The low half
  is the symptom: `63` → FORScan's `:03`, `22` → `:02`, `24` → `:04`,
  `28` → `:08`; `F` means none given. Seen: 20 = stored, not present now;
  60 = present at the scan. 10 and 80 haven't been seen yet, so the app
  says so when it meets them.

On every one of the 78 faults the decoded byte agrees with FORScan's
printed words. If a byte ever disagrees, the app shows FORScan's words and
says it disagreed.

## Things noticed in the DTC data (shown as they are, not changed)

* `P0355 -` (FG) and `P1709KOEO` (BA) are normalised for lookup. The raw
  form is kept in `code_raw`.
* Some codes have two entries for one model (FG U0073 and U1900). Both are
  shown as "Entry 1 of 2" and "Entry 2 of 2".
* BF U0073's second entry describes a torque converter solenoid, which
  looks like a mix-up in the source. It's shown as found.

## Phone checklist for step 1 (Android, Firefox, Tailscale)

Step 1 is done when all of these pass on the real phone:

1. Laptop: start `FalconOath.bat`. Once, run `tailscale serve --bg --https=8443 8767`.
   `python -m falconoath status` should say Ready on :8443, show VPA's 443
   route untouched, and show no Funnel.
2. Phone with Tailscale on: Firefox → `https://<laptop>.<tailnet>.ts.net:8443`.
   The home page loads.
3. Laptop: press **P** in the FalconOath listener window (or double-click
   `Pair.bat`). Phone: Settings → type the code.
   It syncs: 1,195 entries, today's date as DD/MM/YYYY.
4. ⋮ → Add app to Home screen. The shield icon appears.
5. Search P0325 with BA chosen: the knock sensor entry. Choose FG X and
   open U0140: the "from FG data" badge shows.
6. Offline: aeroplane mode, swipe Firefox away, open from the icon. The
   app opens, search works, and the pill says "Offline · <date>".
7. Unreachable: aeroplane mode off, Tailscale off. Settings shows "Can't
   reach the laptop" and an Open Tailscale button. Turn Tailscale on and
   come back; it syncs within about 5 s.
8. App update: change something in `app.css` and reopen on the phone. It
   reloads once and Settings → About shows a new app build.
9. No-change sync: reopen. The listener window logs no `/api/snapshot`
   (run `serve --log-meta` to see the meta checks too).
10. Settings: "Storage kept safe" is Yes (tap Keep data safe if not), and
    usage is shown.
11. Laptop browser at the same :8443 address (or localhost:8767): pair and
    it works the same.
12. VPA's phone app still syncs as before.

## Phone checks for step 2

1. Start `FalconOath.bat`. The window says falcon.db went to schema 2 (first
   time only), and the listener starts.
2. Phone: Upload → choose a FORScan .txt (from Files or Drive) → it shows
   the modules read and the active and stored counts.
3. Pick "+ A new car", name it, choose FG, save. The scan opens straight
   away, marked "Not on the laptop yet", then "Sent".
4. Within about 10 s the listener window says "from a device: car applied"
   and "scan applied", and the phone drops the badge.
5. Open a fault: the explanation from the FG list, the symptom, and
   "Status byte" → "The byte agrees".
6. Aeroplane mode: add another scan. It's saved and shown. Back online, it
   sends on the next sync.
7. The same .txt again: the upload page says it's already in FalconOath.
8. Laptop: `python -m falconoath cars` lists the new car and its scans.

* **25/10/2026** Step 4 built: live-data logs (PLAN.md, "Step 4 design").
  * What the logs are: see PLAN.md. Parsing all 8 samples in JS takes
    1-57 ms (the 21,598-row fuel run is the 57). A 21,598-row lane draws in
    ~2 ms (min/max per pixel column).
  * Stored in falcon.db gzipped (~1/5). Schema 3; the real falcon.db
    migrates the first time serve starts (backup first).
  * FORScan's folder: `OneDrive\Documents\FORScan` by default (8 CSV, 8
    .fsl, 5 TXT found 25/10/2026). Only CSVs, only once settled for 10 s,
    no car until chosen in the app ("attach", which can also move a scan).
  * Health checks were tuned on the real samples so they don't cry wolf:
    trims flat near 0 = open loop (a friend's BA), so trims and O2 are noted,
    not judged; O2 bank 2 at ~0 V = "not fitted on an I6" (the FPV logs);
    an O2 swinging the full range but slowly (once every ~8 s at idle, the
    FPV) is a note with advice to check at 2,500 rpm, not a fault; idle
    means throttle closed and settled 3 s+, so free-revving logs don't
    read as hunting. That BA's idle (544 rpm, wants 656, ±52) is a Check.
  * Checked in the browser on copies of the samples (scratch home): the
    watcher took all 8, the device downloaded and hash-checked all 8,
    choosing a car went to the laptop and back, the viewer, zoom, drag,
    cursor, compare and the cruise On/Off lane, and P0325 on that BA's scan
    links to his log at RPM, throttle and coolant.

* **25/10/2026** Step 5 built: VPA prices, overall averages only (PLAN.md,
  "Step 5 design"). Checked against the real VPA on 25/10/2026 (the
  figures stay out of this public repo). read_frame takes ~1-2 s; check_prices reads the real VPA
  once and proves vpa.db's size, date and SHA-256 unchanged. The
  listener's PriceWatcher only stats vpa.db and waits for it to be still
  60 s before a child re-reads it.

* **25/10/2026** Step 6 built: trims and options, only from your own
  brochures (PLAN.md, "Step 6 design"). No brochures were on the laptop
  yet (only workshop manuals and the FG X handbook), so it was checked on
  a made-up FG brochure in a scratch home: three pages read, an XR6 Turbo
  and an XR8 made from their pages, the colours saved for the whole
  series, a fact deleted, each applied on the laptop within seconds. A
  page that names a trim now saves to it ahead of the last one used.
  Also fixed: Prices' "All" button snapped back to the chosen model.

* **25/10/2026** Step 7 built: the factory checker by plate codes (PLAN.md,
  "Step 7 design"). Found in the manuals: the BF workshop manual's 100-01
  Identification Codes has body, model, paint and interior trim codes as
  text (the VIN layout and plate pictures are images, so no VIN decoding);
  the FG manual's 100-01 is the BF section with an FG header (same text,
  BF colours), so codes ticked from it would really be BF's. The code
  suggestions were tried on the real BF pages (read only, nothing saved):
  every body, model, paint and trim code found, including colours printed
  with the month they were introduced. Checked in the browser
  on a made-up FG codes page: 11 codes saved for every FG, a car given
  its trim and codes, an XR8 model code on an XR6 Turbo flagged "Check",
  the rest "Factory", saved to the laptop and back. Also: a car can now
  be changed after it's made (an item naming the car), and trims are
  applied before cars so a car can name a trim sent with it.
  (A browser-pane tab opened on the wrong port showed a stuck service
  worker; on the right port the update came through, and a forced app
  update was checked to land.)

* **25/10/2026** FORScan's folder, straight away (Luke: "have the data all
  ready to go straight away... pull it up immediately"). The watcher now
  takes fault scans (DTC report .txt) as well as logs, checks every second,
  and reads a file 3 s after FORScan stops writing it (was 10 s + 11 s on
  a 4 s tick). The listener rebuilds at once and says "ready to look at".
  Open apps hold one request open (`/api/wait`, 25 s at a time) and sync
  the moment the copy changes, then open the new scan or log, unless
  something is being typed or a form is open (then a message). On the
  laptop, if the app isn't open in a browser there, the listener opens it
  at the new item (O in the listener window turns that off). Only files
  FORScan saved today or yesterday pop up (old ones found the first time
  just appear under Cars). Checked: about 5-6 s from FORScan saving to the
  app showing it (scratch copy and check_inbox_e2e).

* **26/10/2026** FalconOath.exe and its own window (Luke: "why does the
  laptop one act like the phone one... make it a standalone .exe"). Built
  with PyInstaller (onedir, 16 MB exe + 152 MB _internal: Python, pandas for
  VPA's prices, pywebview); the window is WebView2 (Edge itself has been
  removed from this laptop, its WebView2 runtime is there). The listener
  runs out of sight (serve --hidden, data/falconoath.log); Settings → This
  laptop has what the black window's keys did. The window pairs itself
  with a one-time code; on the laptop the app says "FalconOath stopped",
  never "can't reach the laptop". Checked on the scratch copy: the .exe
  started the listener and the window, the window paired and synced,
  Remove, the device-limit message, and Stop. (Screen captures of a
  WebView2 window are black unless it's started with
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu: a capture quirk,
  not the app.) Also: two old check_srv checks were flaky on Windows when
  the listener refuses a big body before reading it; they now accept the
  closed connection.

## Laptop checks for FalconOath.exe

1. Stop any old FalconOath listener window (Q). Double-click FalconOath on
   the Desktop: one window opens, already paired, data there.
2. Settings → This laptop: the phone's address, Show a pairing code (pair
   the phone with it), devices, Manuals / FORScan's folder open.
3. Close the window; save a scan in FORScan: the window opens at it.
4. Stop FalconOath: the window says it has stopped; the icon starts it again.

## Phone checks for the FORScan folder

1. Laptop: FalconOath running, the app open on the phone (any screen).
2. Save a DTC report in FORScan (its usual folder). Within about 6 s the
   phone shows that scan, "Which car is this from?" on top.
3. Close the app on the laptop's browser; save another: the browser opens
   at it by itself. Press O in the listener window to stop that.
4. Typing in a form when one arrives: a message instead of a jump.

## Phone checks for step 7

1. Manuals: open the BF workshop manual's 100-01 Identification Codes →
   Read for codes (or Browse → BF → Codes). Page 4: body and model codes;
   Tick all, Save (series blank = every BF). Page 5: paint and trim codes;
   a code the manual prints with a zero where the plate has the letter O
   still matches (and says so).
2. Browse → BF → Codes: every code with its page.
3. A BF car's page → Factory check: choose its trim, type the plate codes
   off the car (engine bay plate and A-pillar), the build month. Tiles
   update as you type; Save to this car. Seconds later it's on the laptop.
4. A code not in your tables says "Unknown"; one from another model's
   tables says so ("Only in the BF tables").

## Known limits (step 7)

* No VIN decoding: the manuals' VIN layout is a picture.
* Paint is "offered" only when that series' colours were ticked from a
  brochure; otherwise it's explained but not judged.
* Model codes are matched to trim names loosely (FMT = Fairmont, XR = any
  XR): "Check" means look, not wrong.

## Phone checks for step 6

1. Laptop: put a brochure PDF in `manuals\FG\Brochures` (M in the
   FalconOath window opens manuals). The window says it was read.
2. Phone: Home → Browse → FG: the brochure is listed, "Not read yet".
3. Open it: the page on top, "Found on this page" below. Tick the right
   ones, check "Saving to" (a trim named on the page is chosen, or a new
   one with its name), Save. They're under "Saved from this page" and,
   seconds later, on the laptop (`python -m falconoath trims`).
4. The colours page: choose "The whole series", Tick all, Save.
5. Browse → FG: a tile per trim; tap one: power, gearbox, standard gear,
   options, colours, each with its page (tap "p 3" to open the page).
6. Edit on a trim page: × deletes a fact (after asking).
7. Manuals → + Add on the phone with "It's a sales brochure": it lands in
   the model's Brochures folder.

## Known limits (step 6)

* A scanned brochure (pictures of pages) has no text, so nothing is
  suggested: type what the page says with + Add.
* Suggestions are only as good as the PDF's text: tables that come out
  jumbled need their figures typed or corrected before saving.
* No side-by-side comparison of trims yet; a car isn't linked to its trim
  until step 7 (the build plate).

## Phone checks for step 5

1. Laptop: start FalconOath; the window says "Prices from VPA: ... Falcons".
2. Phone: Home → Prices: every model's median and range; tap FG: the
   series and trims with their bars.
3. A car's page: "FGs for sale $..." under its details.
4. VPA saves new listings: about a minute later the prices refresh.

## Phone checks for step 4

1. Laptop: start FalconOath. The window says falcon.db went to schema 3
   (first time), then "new log from FORScan's folder: ..." for each CSV in
   FORScan's folder.
2. Phone: Cars → "Without a car yet" lists them. Choose a car for one.
3. Open it: health tiles, then the chart. Tap a tile; drag; pinch; tap.
4. Compare with another log.
5. Upload → pick a .csv from the phone → choose the car → Save log. It
   reaches the laptop and shows on the car.
6. Aeroplane mode: every log still opens.
7. A scan's fault (e.g. P0325) shows "Check it with live data", and opens
   the car's log at the right PIDs.

## Known limits (step 4)

* Logs can't be renamed, re-dated or deleted from the app yet.
* Compare lines logs up at their starts; there's no slider to shift one.
* TXT scans in FORScan's folder aren't picked up (only logs).

## Phone checks for step 3

1. Laptop: `python -m pip install -r requirements.txt` once, then start
   FalconOath. Press M: the manuals folder opens. Copy a PDF into FG.
   Within a few seconds the window says "reading FG/... N pages".
2. Phone: Manuals tab → the PDF is listed. Search a word from it: the
   page is listed with the words marked. Tap it: it opens at that page.
3. Search P0325 (or any code in the PDF) on the Search tab: "In your
   manuals" shows the page.
4. Open a manual → Keep on this phone → "On this phone ✓".
5. Aeroplane mode: search still works; the kept manual opens; another one
   says it isn't on this phone.
6. + Add → pick a PDF from Files → choose a model → Send. "Sending to the
   laptop" counts up; within ~10 s of finishing it's in the list.
7. The same PDF again: "already in the library".

## Known limits (step 3)

* Scanned PDFs can be opened but not searched (no OCR yet).
* Manuals can't be renamed or deleted from the app; do it in the folder on
  the laptop (the library follows within seconds).
* A kept manual stays on the phone until removed there ("On this phone ✓"
  → remove); it isn't updated if the laptop's copy changes (it's a new
  manual then, by SHA-256).

## Known limits (step 2)

* Cars and scans can't be edited or deleted in the app yet; the laptop
  keeps everything (data safety). A car edit screen and VIN merging come
  later.
* The FORScan date isn't in the TXT. The scan date is the file's date,
  which can be changed at upload.

## Known limits (step 1)

* The listener runs only while FalconOath.bat's window is open. A Windows
  start-up listener is a later extra.
* Code changes to the listener need a restart. App file changes don't: they
  reach devices through the BUILD stamp.
* Pairing codes come from the listener window (P) or Pair.bat. There's no
  laptop pairing screen yet; the laptop pairs like any other browser.
