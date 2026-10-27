# FalconOath

An offline app for BA, BF, FG and FG X Falcons, on the laptop and the phone:
fault code lookup, FORScan fault scans explained per car, and your own PDF
manuals searchable page by page. The laptop keeps the data; the phone syncs
over Tailscale and works with no signal. See PLAN.md for what comes next.

The app ships code only: the fault code list, scans and manuals are your own
files on your own laptop, never in this repo.

## First run (laptop)

Needs Python 3.12 and pypdf. Python isn't on PATH, so from the falcon-app
folder, in PowerShell:

    & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m pip install -r requirements.txt

(in cmd: `"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -m pip install -r requirements.txt`)

    cd falcon-app
    python -X utf8 -m falconoath setup        # builds data/falcon.db and the data copy
    tailscale serve --bg --https=8443 8767    # once; leaves VPA's 443 alone
    Setup FalconOath.bat                      # builds FalconOath.exe; icon on the Desktop and Start menu

Then double-click **FalconOath** on the Desktop (it's `dist\FalconOath\FalconOath.exe`).
It opens FalconOath in its own window, and starts the listener out of sight
if it isn't running yet. The window pairs itself the first time: nothing to
type on the laptop. Closing the window leaves FalconOath running, so phones
keep syncing and new FORScan scans still open by themselves; **Settings →
This laptop → Stop FalconOath** stops it. What it would have printed goes to
`data\falconoath.log`.

Changes to the screens (`falconoath\app\`) show without rebuilding. After a
change to the Python, run `Setup FalconOath.bat` again (about a minute).
Without the .exe, `FalconOath.bat` does the same with Python itself.

## Pair a phone

On the laptop, FalconOath → **Settings → This laptop → Show a pairing code**.
On the phone, open `https://<laptop>.<tailnet>.ts.net:8443` with Tailscale on,
Settings → type the code, then Firefox's ⋮ menu → Add app to Home screen.
The same card lists paired devices (Remove), opens the manuals and FORScan
folders, and turns "open new FORScan scans by themselves" on or off.

From a command line (python isn't on PATH, so the full path):

    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -X utf8 -m falconoath pair

## FORScan fault scans

Easiest: just save it from FORScan's DTC tab into FORScan's own folder on
the laptop (`OneDrive\Documents\FORScan`). About five seconds later it's
read, and FalconOath opens it: on any device with the app open, and on the
laptop in FalconOath's window even if it was closed (Settings → This laptop
turns that off). Choose its car at the top. Saved logs (below) arrive the
same way.

Or in the app: Upload → choose the .txt → pick or make the car → Save. On
the laptop you can also run:

    python -X utf8 -m falconoath import-scan "Fg faults 2809.txt" --new-car "My FG" --model FG

## Live data (FORScan logs)

In FORScan's **Live data** tab, record, then save the log (a .csv). Either
add it in the app (Upload, the same place as fault scans, and choose the
car), or just leave it in FORScan's folder on the laptop
(`OneDrive\Documents\FORScan`): FalconOath picks up new logs there by
itself within seconds and opens them, and they wait under **Cars → Without
a car yet** until you choose the car. `python -m falconoath logs-folder PATH` watches a different folder
(`--off` stops it). The folder is only ever read.

Every log is copied to your phone, so they all open with no signal. A log
shows **health checks** first (fuel trims, O2 sensors and the cat, coolant
temperature, charging, idle), then a chart: tap PIDs to show them, drag
to move, pinch or +/- to zoom, tap for the values at that moment, and
**Compare with** another log (before and after a fix, or a mate's car). A
fault in a scan says which PIDs to log for it, and opens this car's log at
those PIDs when there is one.

## Prices (from VPA)

If VPA (the price tracker) sits beside this folder, FalconOath reads its
Falcon listings, read-only, and works out overall averages: for BA, BF, FG
and FG X, then by series and trim, the median asking price, the typical
range (the middle half), median km and how many cars. One price per car
(its latest), used cars only. **Prices** on Home shows them; each car's
page shows what its model is asking. They refresh by themselves a minute
after VPA saves new listings, or run `python -m falconoath prices`.

## Trims and options (from your brochures)

Put sales brochures in the model's **Brochures** folder (`manuals\FG\Brochures`
and so on), or send one from the phone with **It's a sales brochure** ticked.
**Browse** on Home lists them. Open one: each page shows beside what
FalconOath found on it (trim names, engines, kW and Nm, gearboxes, fuel use,
wheels and tyres, sizes and weights, towing, colours, standard gear and
options). Tick what's right, correct anything, choose the trim (or the whole
series, for colours) and save. Nothing is pre-filled and nothing is kept
that you didn't tick; every fact links back to its brochure page. Browse then
shows each trim with its power, gearbox, standard gear, options and colours.
`python -m falconoath trims` lists them on the laptop.

## Built in, from your manuals

FalconOath comes with what was read out of your own manuals and brochures,
so there's nothing to tick first:

* **Build plate codes** for the BA, BF (and BF FPV) and FG: body, model,
  paint, interior trim, engine (H, Z, Y, S) and gearbox (K, H, W) codes,
  from each workshop manual's 100-01 Identification Codes.
* **FG X trims** (Falcon, XR6, XR6 Turbo, XR8, G6E, G6E Turbo) from the
  June 2015 brochure: engines, power and torque, gearboxes, fuel use,
  towing, wheels and tyres, standard gear, options, colours, seats.
* **Service specs** per model: engine oil and capacity, plugs, firing
  order, coolant, transmission fluids, diff oil, wheel nut torque, A/C gas,
  battery, and the FG X tyre pressures (Browse → a model → Service specs).

Every entry links to its page. A few things your manuals don't cover are
**research** notes (marked, never called factory), e.g. paint OT = Octane
and the FG MkII model code 18235. The reference lives in
`data\sources\reference.json` on the laptop, never on GitHub;
`python -m falconoath reference` lists it.

## Factory check (build plate codes)

On any car's page, **Factory check**: choose its trim and type the codes
off its plates (engine bay or driver's A-pillar), the build month and the
VIN. Each code says what it means, with its manual page, and whether it
fits the trim: **Factory**, **Check** (e.g. a turbo engine code on a
non-turbo trim, or a colour that series didn't come in), **Doesn't fit**
(a ute body code on a sedan, or a VIN whose body letters aren't the
plate's), **Noted** (explained but not judged, or research) or **Unknown**
(in no table, never guessed). The VIN gives the body, the plant and, as
research, the build year and month letters, checked against the build date.

Below it, the car's **Service sheet**: its model's specs, with the ones for
other engines or gearboxes dimmed once its engine code or trim is known.

More codes can still be ticked from any manual page: open it and press
**Read for codes** (or Browse → Codes).

## Manuals (your own PDFs)

`setup` (and the listener) make a folder per model:

    manuals\BA  manuals\BF  manuals\FG  manuals\FGX  manuals\General
    (each model also has a Brochures folder, for sales brochures)

Copy PDFs in (subfolders are fine; press **M** in the listener window to open
the folder). Within a few seconds the listener reads their text, and the
**Manuals** tab can search every page, on the laptop and on the phone, with
no signal. Fault code pages and searches show "In your manuals" too. Tap a
result to open the PDF at that page. **Keep on this phone** stores a manual
on the phone for reading with no signal; otherwise it streams from the
laptop over Tailscale. **+ Add** on the phone sends a PDF to the laptop's
folder (in pieces, carrying on if the connection drops).

The PDFs never leave your laptop except to your own paired devices, and are
gitignored. Scanned PDFs (pictures of pages) open but can't be searched yet.

## Tests

    python -X utf8 -m tests.run_all
