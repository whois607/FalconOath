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
