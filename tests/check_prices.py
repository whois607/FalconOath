"""Step 5: VPA prices, overall averages. The rules on a made-up frame (one
price per car, its latest; used only; under $500 out; BA-FG X only, grouped
by model, series and trim), the snapshot carrying them, and, if VPA is
beside this project, one real read that must leave vpa.db untouched."""
import gzip
import json
import os

from tests import _home as T

H = T.home("check_prices")
T.copy_real_dtc(H)

import pandas as pd  # noqa: E402

from falconoath import build, dtc_import, db, paths, vpa_prices  # noqa: E402

T.ok(vpa_prices.vpa_dir() is None and vpa_prices.signature() is None, "a test home doesn't read the real VPA unless named")

rows = []
def car(key, gen, trim, *sightings, cond="used", km=150000):
    for date, price in sightings:
        rows.append({"key": key, "make": "Ford", "model": "Falcon", "generation": gen, "trim_base": trim, "condition": cond,
                     "capture_date": pd.Timestamp(date), "price_aud": price, "odometer_km": km})
car("a", "FG", "XR6", ("2026-06-01", 20000), ("2026-07-01", 18000))       # dropped its price: 18,000 counts
car("b", "FG MkII", "XR6", ("2026-10-20", 22000), km=100000)
car("c", "FG MkII", "XR6 Turbo", ("2026-10-25", 30000), km=90000)
car("d", "FG", "XR6", ("2026-08-01", 12000))
car("e", "FG", "XR6", ("2026-08-01", 300))                                  # a placeholder price: out
car("f", "FG X", "XR8", ("2026-10-01", 60000), cond="demo")                 # demo: out
car("g", "FG X", "XR8", ("2026-10-01", 56000), cond=None, km=40000)         # blank condition = used
car("h", "AU", "XR8", ("2026-10-01", 15000))                                # older Falcon: out
car("i", "BA MkII", "", ("2026-09-01", 9000))                               # no trim: "Other"
df = pd.DataFrame(rows)
df.loc[len(df)] = {"key": "z", "make": "Holden", "model": "Commodore", "generation": "FG", "trim_base": "SS", "condition": "used",
                   "capture_date": pd.Timestamp("2026-10-01"), "price_aud": 1, "odometer_km": 1}
s = vpa_prices.summarise(df[df.make == "Ford"])
T.ok(s["cars"] == 6 and set(s["models"]) == {"FG", "FGX", "BA"}, "6 cars: one per car, used, $500+, BA-FG X only", s["cars"])
fg = s["models"]["FG"]
T.ok(fg["cars"] == 4 and fg["median"] == 20000 and fg["mean"] == 20500, "FG: 4 cars, median 20,000 (latest prices 18k, 22k, 30k, 12k)", fg)
T.ok(fg["p25"] == 16500 and fg["p75"] == 24000, "the middle half", (fg["p25"], fg["p75"]))
T.ok([x["name"] for x in fg["series"]] == ["FG", "FG MkII"] and fg["series"][0]["cars"] == 2, "series in order, FG then FG MkII")
T.ok([(t["name"], t["cars"]) for t in fg["trims"]] == [("XR6", 3), ("XR6 Turbo", 1)], "trims, most cars first")
T.ok(fg["km"] == 125000 and fg["recent"] == 2,"median km; 2 seen in the last 14 days", (fg["km"], fg["recent"]))
T.ok(s["models"]["FGX"]["cars"] == 1 and s["models"]["FGX"]["median"] == 56000, "FG X: the demo left out, the blank-condition car in")
T.ok(s["models"]["BA"]["trims"][0]["name"] == "Other", "a car with no trim counts under Other")
T.ok(s["first"] == "2026-06-01" and s["last"] == "2026-10-25", "the capture dates covered")
T.ok(vpa_prices.summarise(df.iloc[0:0])["cars"] == 0, "nothing to count: an empty summary, no error")

# into the snapshot
dtc_import.import_dtc()
db.init()
(paths.DATA / "prices.json").write_text(json.dumps(s), encoding="utf-8")
r = build.build()
snap = json.loads(gzip.decompress((paths.OUT / r["file"]).read_bytes()))
T.ok(snap["format"] == "falconoath-snap/4" and snap["prices"]["models"]["FG"]["median"] == 20000, "the snapshot carries the averages")
(paths.DATA / "prices.json").write_text('{"format": "something-else"}', encoding="utf-8")
T.ok(json.loads(gzip.decompress((paths.OUT / build.build()["file"]).read_bytes()))["prices"] is None, "a prices file it doesn't know is ignored")

# the real VPA, read-only
real = T.ROOT.parent / "vehicle-price-analysis"
if (real / "data" / "vpa.db").is_file():
    os.environ["FALCONOATH_VPA"] = str(real)
    vdb = real / "data" / "vpa.db"
    before = (vdb.stat().st_size, vdb.stat().st_mtime, T.sha(vdb))
    s = vpa_prices.build()
    after = (vdb.stat().st_size, vdb.stat().st_mtime, T.sha(vdb))
    T.ok(before == after and not (real / "data" / "vpa.db-journal").exists(), "the real vpa.db is untouched by a read (size, date, SHA-256)")
    T.ok(s["cars"] > 100 and set(s["models"]) <= {"BA", "BF", "FG", "FGX"}
         and all(d["p25"] <= d["median"] <= d["p75"] for d in s["models"].values()), f"real averages: {s['cars']:,} Falcons, sensible", s["models"].keys())
    T.ok(json.loads((paths.DATA / "prices.json").read_text(encoding="utf-8"))["cars"] == s["cars"], "written to data/prices.json")
else:
    print("  (no VPA beside this project: real read skipped)")
T.done()
