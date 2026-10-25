"""Every path FalconOath uses, in one place.

Standard library only: the listener (srv.py) imports this, and it must not be
able to reach a database.

FALCONOATH_HOME moves data/ and output/ elsewhere (the tests use it so they
never touch the real data). The app code always comes from this package.
"""
from __future__ import annotations

import os
from pathlib import Path

CODE = Path(__file__).resolve().parent             # falconoath/
ROOT = CODE.parent                                 # falcon-app/
HOME = Path(os.environ.get("FALCONOATH_HOME") or ROOT)

DATA = HOME / "data"
SOURCES = DATA / "sources"
DTC_SOURCE = SOURCES / "dtc.db"                    # read-only, never written
DB = DATA / "falcon.db"                            # the master; only db.py writes it
BACKUPS = DATA / "backups"
SETTINGS = DATA / "settings.json"                  # pairing, devices (cfg.py)
OUT = HOME / "output" / "phone"                    # snapshot-<v>.json.gz + meta.json
APP = CODE / "app"                                 # the front end
MANUALS = HOME / "manuals"                         # your own PDFs, one folder per model (library.py)
MANUAL_FOLDERS = ("BA", "BF", "FG", "FGX", "General")
BROCHURES = "Brochures"                            # manuals/<model>/Brochures/: sales brochures (step 6)
LIBRARY = DATA / "library.db"                      # the manuals' text index: rebuilt from the PDFs, so no backups
UPLOADS = DATA / "inbox" / "uploads"               # PDFs arriving from a device, in pieces

PORT = 8767            # the listener. VPA owns 8766; never reuse it
HTTPS_PORT = 8443      # tailscale serve --bg --https=8443 8767  (VPA owns 443)
