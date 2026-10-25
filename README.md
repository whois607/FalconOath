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
    Setup FalconOath.bat                      # once: a FalconOath icon on the Desktop and Start menu

Then double-click **FalconOath** on the Desktop. It starts the listener in
its own window if it isn't running yet, and opens http://localhost:8767.
Clicking it again just reopens the app. `FalconOath.bat` does the same.
Run the setup again only if you move this folder or reinstall Python.

## Pair a phone or browser

In the **FalconOath listener** window (the one the icon opens), press
**P** for a six-digit code. Or double-click `Pair.bat`. Then in the app go
to Settings → Pair this device and type it. The listener window doesn't take
typed commands; it only answers keys: **P** pair, **D** devices, **S**
Tailscale status, **Q** stop.

In any other cmd window, `python` isn't on PATH. Use the full path, from
the falcon-app folder:

    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -X utf8 -m falconoath pair

`Devices.bat` lists paired devices. On the phone, open
`https://<laptop>.<tailnet>.ts.net:8443` with Tailscale on, pair, then use
Firefox's ⋮ menu → Add app to Home screen.

## FORScan fault scans

In the app: Upload → choose the .txt FORScan saved from its DTC tab → pick
or make the car → Save. On the laptop you can also run:

    python -X utf8 -m falconoath import-scan "Fg faults 2809.txt" --new-car "My FG" --model FG

## Live data (FORScan logs)

In FORScan's **Live data** tab, record, then save the log (a .csv). Either
add it in the app (Upload, the same place as fault scans, and choose the
car), or just leave it in FORScan's folder on the laptop
(`OneDrive\Documents\FORScan`): FalconOath picks up new logs there by
itself, and they wait under **Cars → Without a car yet** for you to choose
the car. `python -m falconoath logs-folder PATH` watches a different folder
(`--off` stops it). The folder is only ever read.

Every log is copied to your phone, so they all open with no signal. A log
shows **health checks** first (fuel trims, O2 sensors and the cat, coolant
temperature, charging, idle), then a chart: tap PIDs to show them, drag
to move, pinch or +/- to zoom, tap for the values at that moment, and
**Compare with** another log (before and after a fix, or a mate's car). A
fault in a scan says which PIDs to log for it, and opens this car's log at
those PIDs when there is one.

## Manuals (your own PDFs)

`setup` (and the listener) make a folder per model:

    manuals\BA  manuals\BF  manuals\FG  manuals\FGX  manuals\General

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
