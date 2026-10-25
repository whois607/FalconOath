# FalconOath

An offline app for BA, BF, FG and FG X Falcons, on the laptop and the phone.
Step 1 is fault code lookup (DTC). See PLAN.md for what comes next.

## First run (laptop)

    cd falcon-app
    python -X utf8 -m falconoath setup        # builds data/falcon.db and the data copy
    tailscale serve --bg --https=8443 8767    # once; leaves VPA's 443 alone
    FalconOath.bat                            # listener + opens http://localhost:8767

## Pair a phone or browser

In the **FalconOath listener** window (the one FalconOath.bat opens), press
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

## Tests

    python -X utf8 -m tests.run_all
