"""Writes tests/fixtures/forscan_log_fixture.csv: a made-up 60 s FORScan
live-data log in FORScan's exact format (`;`, CRLF, `-` until a PID first
reads, then every row repeats each PID's latest value, a row every ~30 ms).
Known, healthy values so the health checks have answers to test:
idle 20 s at ~700 rpm (desired 700), then a drive to 80 km/h; coolant
warming 78 -> 91 °C; long-term trim +4 %; short-term trim swinging ±5 %;
upstream O2 switching about once a second, downstream steady ~0.65 V;
battery 14.2 V; cruise On for the last 15 s.

    python tests/make_log_fixture.py      (only to change the fixture)
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures" / "forscan_log_fixture.csv"
COLS = ["DSDRPM(1/min)", "RPM(1/min)", "VSS(km/h)", "TP1(V)", "ECT(°C)", "SHRTFT1(%)", "LONGFT1(%)",
        "O2S11(V)", "O2S12(V)", "B+(V)", "CRUISE"]
# each PID updates at its own rate (ms); FORScan repeats the last value between
RATE = {"DSDRPM(1/min)": 300, "RPM(1/min)": 90, "VSS(km/h)": 150, "TP1(V)": 90, "ECT(°C)": 600,
        "SHRTFT1(%)": 120, "LONGFT1(%)": 900, "O2S11(V)": 60, "O2S12(V)": 240, "B+(V)": 450, "CRUISE": 300}


def value(col, t):
    s = t / 1000
    drive = max(0.0, min(1.0, (s - 20) / 15))          # 0 at idle, 1 from 35 s
    if col == "DSDRPM(1/min)":
        return f"{700 if s < 20 else 0}"
    if col == "RPM(1/min)":
        return f"{round(700 + 8 * math.sin(s * 3.1) + drive * 1300 + (60 * math.sin(s) if s >= 20 else 0))}"
    if col == "VSS(km/h)":
        return f"{round(drive * 80)}"
    if col == "TP1(V)":
        return f"{0.78 + drive * 0.9 + (0.25 if 20 <= s < 35 else 0):.2f}"
    if col == "ECT(°C)":
        return f"{round(78 + 13 * min(1, s / 50))}"
    if col == "SHRTFT1(%)":
        return f"{5 * math.sin(s * 2 * math.pi * 0.5):.1f}"
    if col == "LONGFT1(%)":
        return "4.0"
    if col == "O2S11(V)":
        return f"{0.45 + 0.38 * math.sin(s * 2 * math.pi * 1.1):.2f}"
    if col == "O2S12(V)":
        return f"{0.65 + 0.02 * math.sin(s * 0.7):.2f}"
    if col == "B+(V)":
        return f"{14.2 + 0.05 * math.sin(s):.2f}"
    if col == "CRUISE":
        return "On" if s >= 45 else "Off"


def make() -> str:
    lines = ["time(ms);" + ";".join(COLS)]
    last = {c: "-" for c in COLS}
    for i in range(2001):
        t = 0 if i < 3 else (i - 2) * 30
        for k, c in enumerate(COLS):
            if i == k // 4 or (i > 2 and t % RATE[c] == 0 and last[c] != "-") or (i == 2 and last[c] == "-"):
                last[c] = value(c, t)
        lines.append(f"{t};" + ";".join(last[c] for c in COLS))
    return "\r\n".join(lines) + "\r\n"


if __name__ == "__main__":
    OUT.write_bytes(make().encode("utf-8"))
    print(OUT, OUT.stat().st_size, "bytes")
