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
3. Laptop: `python -m falconoath pair`. Phone: Settings → type the code.
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

## Known limits (step 1)

* The listener runs only while FalconOath.bat's window is open. A Windows
  start-up listener is a later extra.
* Code changes to the listener need a restart. App file changes don't: they
  reach devices through the BUILD stamp.
* Pairing is from the command line. There's no laptop pairing screen yet;
  the laptop pairs like any other browser.
