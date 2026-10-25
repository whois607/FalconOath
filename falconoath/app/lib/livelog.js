/* FalconOath - FORScan live-data logs (step 4), pure functions. The only
   parser for them: the laptop just stores the CSV.

   A log: `time(ms);NAME(unit);...`, `;`-separated, `-` until a PID first
   reads, then every row repeats each PID's latest value (a row every ~30 ms,
   PIDs update slower). Some PIDs are words (CRUISE On/Off, FAN_F "No Fault").

   parse(text)      -> {t (s), cols: [{name, base, unit, label, num, v | s, states}], rows, duration}
   stats(col, i0, i1) min / average / max of a stretch
   span(L, t0, t1)  the row range of a time window (binary search)
   envelope(...)    min/max per pixel column, for drawing thousands of rows fast
   checks(L)        plain-word health checks, where the PIDs allow
   suggest(code)    which PIDs to log for a fault code
   has(L, base)     the column for a PID (TP matches TP1 and TP.OBDII) */
(function (root) {
  "use strict";

  /* plain names for the PIDs seen on BA-FG X logs */
  const NAMES = {
    RPM: "Engine speed", DSDRPM: "Desired idle speed", VSS: "Road speed", TP: "Throttle", TP1: "Throttle",
    "TP.OBDII": "Throttle", ECT: "Coolant temp", IAT: "Intake air temp", IAT_V: "Intake air sensor", MAF: "Air flow (MAF)",
    LOAD: "Engine load", SPARKADV: "Spark advance", SHRTFT1: "Short-term fuel trim, bank 1", SHRTFT2: "Short-term fuel trim, bank 2",
    LONGFT1: "Long-term fuel trim, bank 1", LONGFT2: "Long-term fuel trim, bank 2",
    O2S11: "O2 sensor, bank 1 upstream", O2S12: "O2 sensor, bank 1 downstream",
    O2S21: "O2 sensor, bank 2 upstream", O2S22: "O2 sensor, bank 2 downstream",
    "B+": "Battery voltage", VPWR: "Module voltage", INST_LITRE_HR: "Fuel use now", FUEL_ECON: "Fuel economy",
    RN_AVG_FUL_CONS: "Average fuel use", ODO_TRIP_A: "Trip A", FLI: "Fuel level", RUNTM: "Engine run time",
    CRUISE: "Cruise control", BLOWAP: "Blower (actual)", BLOWTP: "Blower (target)", ETSFD: "Evaporator temp",
    EXT_TEMP: "Outside temp", RIGHTOT: "Right vent temp", LEFTOT: "Left vent temp", FAN_F: "Fan fault",
    ACP: "A/C pressure sensor", ACP_PSI: "A/C pressure", TFT: "Transmission fluid temp", TFT_F: "Trans temp sensor fault",
    GEAR: "Gear", FRP: "Fuel rail pressure", BARO: "Barometric pressure", MAP: "Manifold pressure",
  };

  function splitName(h) {
    const m = /^(.*?)\((.*)\)\s*$/.exec(h.trim());
    const base = (m ? m[1] : h).trim(), unit = m ? m[2].trim() : "";
    return { name: h.trim(), base, unit, label: NAMES[base] || base };
  }

  function parse(text) {
    const lines = String(text || "").split("\n");
    const head = (lines[0] || "").replace(/\r$/, "").split(";");
    if (!/^time\(ms\)$/i.test((head[0] || "").trim()) || head.length < 2) return null;
    const rows = [];
    for (let i = 1; i < lines.length; i++) if (lines[i].trim()) rows.push(lines[i].replace(/\r$/, ""));
    const n = rows.length, t = new Float64Array(n), cols = head.slice(1).map(splitName);
    const raw = cols.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      const p = rows[i].split(";");
      t[i] = (+p[0] || 0) / 1000;
      for (let j = 0; j < cols.length; j++) { const v = p[j + 1]; raw[j][i] = v == null || v === "-" || v === "" ? null : v; }
    }
    cols.forEach((c, j) => {
      const r = raw[j];
      c.num = r.every(v => v === null || isFinite(+v));
      if (c.num) { c.v = new Float32Array(n); for (let i = 0; i < n; i++) c.v[i] = r[i] === null ? NaN : +r[i]; }
      else { c.s = r; c.states = Array.from(new Set(r.filter(v => v !== null))); }
      c.count = r.reduce((a, v) => a + (v === null ? 0 : 1), 0);
    });
    return { t, cols, rows: n, duration: n ? t[n - 1] - t[0] : 0 };
  }

  function has(L, base) {
    if (!L) return null;
    return L.cols.find(c => c.base === base) || L.cols.find(c => c.base.startsWith(base) && /^[\d.]/.test(c.base.slice(base.length))) || null;
  }

  /* the first row at or after time x */
  function at(t, x) {
    let lo = 0, hi = t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }
  function span(L, t0, t1) { return [at(L.t, t0), Math.min(L.rows, at(L.t, t1) + 1)]; }

  function stats(c, i0, i1, mask) {
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
    if (!c.num) return null;
    for (let i = i0 || 0; i < (i1 == null ? c.v.length : i1); i++) {
      const v = c.v[i];
      if (v !== v || (mask && !mask[i])) continue;
      if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++;
    }
    return n ? { min: mn, max: mx, avg: sum / n, n } : null;
  }

  /* min and max of each of `px` slices of [i0, i1): enough to draw any
     number of rows as a line with its spikes kept */
  function envelope(t, v, i0, i1, t0, t1, px) {
    const lo = new Float32Array(px).fill(NaN), hi = new Float32Array(px).fill(NaN), w = (t1 - t0) / px;
    for (let i = i0; i < i1; i++) {
      const y = v[i];
      if (y !== y) continue;
      const k = Math.min(px - 1, Math.max(0, Math.floor((t[i] - t0) / w)));
      if (!(lo[k] <= y)) lo[k] = y;
      if (!(hi[k] >= y)) hi[k] = y;
    }
    return { lo, hi };
  }

  /* ---- health checks: [{id, title, verdict good|warn|bad|info, value, explain}]
     Careful not to cry wolf: a check only judges what the log can show
     (engine running, warm, in closed loop, throttle closed for idle). */
  const sign = x => (x > 0 ? "+" : "") + x.toFixed(1);
  const and = (a, b) => (a && b ? a.map((x, i) => x && b[i]) : a || b);
  function running(L) {
    const rpm = has(L, "RPM");
    return rpm && rpm.num ? Array.from(rpm.v, v => v > 400) : null;
  }
  function warm(L) {
    const ect = has(L, "ECT");
    return ect && ect.num ? Array.from(ect.v, v => v >= 70) : null;
  }
  function crossings(c, t, mask, level) {
    let n = 0, prev = null, secs = 0, last = null;
    for (let i = 0; i < c.v.length; i++) {
      const v = c.v[i];
      if (v !== v || (mask && !mask[i])) { prev = null; last = null; continue; }
      if (last !== null) secs += t[i] - last;
      last = t[i];
      const side = v > level;
      if (prev !== null && side !== prev) n++;
      prev = side;
    }
    return { n, secs, hz: secs > 0 ? n / 2 / secs : 0 };
  }
  /* trims stuck at exactly 0 = open loop (cold, wide open, or no O2 feedback) */
  function openLoop(L, mask) {
    const ts = L.cols.filter(c => c.num && /^(SHRTFT|LONGFT)\d$/.test(c.base));
    if (!ts.length) return null;
    return ts.every(c => { const s = stats(c, 0, L.rows, mask); return s && Math.abs(s.avg) < 0.15 && s.max - s.min < 0.2; });
  }
  /* settled idle: running, not moving, throttle at its closed position, for
     at least 3 s, leaving out the first 1.5 s after the throttle closes */
  function idleMask(L) {
    const rpm = has(L, "RPM"), vss = has(L, "VSS"), tp = has(L, "TP");
    if (!rpm || !rpm.num) return null;
    const tps = tp && tp.num ? stats(tp, 0, L.rows) : null, tol = tp ? (/^v$/i.test(tp.unit) ? 0.12 : 2.5) : 0;
    const raw = Array.from(rpm.v, (v, i) => v > 400 && v < 1200 && (!vss || !vss.num || vss.v[i] === 0)
      && (!tps || tp.v[i] <= tps.min + tol));
    const out = new Array(L.rows).fill(false);
    for (let i = 0; i < L.rows;) {
      if (!raw[i]) { i++; continue; }
      let j = i;
      while (j < L.rows && raw[j]) j++;
      const t0 = L.t[i] + 1.5;
      if (L.t[j - 1] - t0 >= 3) for (let k = i; k < j; k++) if (L.t[k] >= t0) out[k] = true;
      i = j;
    }
    return out;
  }
  function checks(L) {
    if (!L) return [];
    const out = [], run = running(L), hot = and(run, warm(L)), ol = openLoop(L, hot || run);
    // fuel trims, per bank
    for (const b of [1, 2]) {
      const lt = has(L, "LONGFT" + b), st = has(L, "SHRTFT" + b);
      const l = lt && lt.num && stats(lt, 0, L.rows, hot || run), s = st && st.num && stats(st, 0, L.rows, hot || run);
      if (!l && !s) continue;
      if (ol) {
        out.push({ id: "trim" + b, title: `Fuel trim, bank ${b}`, verdict: "info", value: "0% the whole time",
          explain: "The engine stayed in open loop (not using the O2 sensors), so the trims can't be judged: it may not have been warm enough." });
        continue;
      }
      const total = (l ? l.avg : 0) + (s ? s.avg : 0), worst = Math.max(Math.abs(l ? l.avg : 0), Math.abs(total));
      const verdict = worst <= 10 ? "good" : worst <= 20 ? "warn" : "bad";
      out.push({ id: "trim" + b, title: `Fuel trim, bank ${b}`, verdict,
        value: [l ? `long ${sign(l.avg)}%` : "", s ? `short ${sign(s.avg)}%` : ""].filter(Boolean).join(", "),
        explain: verdict === "good" ? "Within ±10%: the engine is getting the mixture it expects."
          : total > 0 ? "Adding fuel: it's running lean. Look for air leaks after the MAF, a dirty MAF, or weak fuel pressure."
          : "Taking fuel away: it's running rich. Look for leaking injectors, high fuel pressure, or a sticking purge valve." });
    }
    // upstream O2 sensors switching; downstream steady (the cat)
    for (const b of [1, 2]) {
      const up = has(L, `O2S${b}1`), dn = has(L, `O2S${b}2`);
      if (!up || !up.num || !/^v$/i.test(up.unit)) continue;
      const m = hot || run, s = stats(up, 0, L.rows, m);
      if (!s) continue;
      const x = crossings(up, L.t, m, 0.45), range = `${s.min.toFixed(2)}–${s.max.toFixed(2)} V`;
      if (s.max < 0.1) {
        out.push({ id: "o2up" + b, title: `O2 sensor, bank ${b} upstream`, verdict: "info", value: `${range}, no signal`,
          explain: b === 2 ? "Reads about 0 V the whole time: on an I6 there is no bank 2, so this is normal. On a V8, the sensor or its heater isn't working."
            : ol ? "No signal, and the engine stayed in open loop: it may not have warmed up, or the sensor's heater isn't working."
            : "No signal while the engine runs: the sensor, its heater, or its wiring." });
        continue;
      }
      let verdict = "good", explain = "Swinging rich and lean as it should: the engine is in closed loop.";
      if (ol) { verdict = "info"; explain = "The engine stayed in open loop, so the switching can't be judged."; }
      else if (s.max < 0.45) { verdict = "warn"; explain = "Stays low (lean) the whole time: a lean engine, an air leak near the sensor, or a lazy sensor."; }
      else if (s.min > 0.45) { verdict = "warn"; explain = "Stays high (rich) the whole time: a rich engine, or a sensor stuck high."; }
      else if (x.hz < 0.3 && s.min < 0.2 && s.max > 0.7) {
        verdict = "info";
        explain = `Swings the full range (a working sensor), but slowly: about once every ${Math.round(1 / Math.max(x.hz, 0.01))} s. That's common at idle; to judge it, log it at a steady 2,500 rpm, where a good one switches at least every 2-3 s.`;
      } else if (x.hz < 0.3) { verdict = "warn"; explain = "Switching slowly and not across the full range: a lazy (old) sensor, or not warm and in closed loop for long enough in this log."; }
      const every = x.hz > 0 && x.hz < 1 ? `about every ${(1 / x.hz).toFixed(x.hz < 0.2 ? 0 : 1)} s` : `${x.hz.toFixed(1)} times a second`;
      out.push({ id: "o2up" + b, title: `O2 sensor, bank ${b} upstream`, verdict, value: `${range}, switching ${every}`, explain });
      if (verdict === "good" && dn && dn.num) {
        const d = stats(dn, 0, L.rows, m);
        if (!d) continue;
        const ratio = x.hz > 0 ? crossings(dn, L.t, m, 0.45).hz / x.hz : 0, v2 = ratio >= 0.7 ? "warn" : "good";
        out.push({ id: "cat" + b, title: `Catalytic converter, bank ${b}`, verdict: v2,
          value: `downstream ${d.min.toFixed(2)}–${d.max.toFixed(2)} V, ${Math.round(ratio * 100)}% of upstream's switching`,
          explain: v2 === "good" ? "The downstream sensor stays steady while the upstream one swings: the cat is storing oxygen."
            : "The downstream sensor swings almost as much as the upstream one: the cat may be worn (see P0420/P0430)." });
      }
    }
    // coolant
    const ect = has(L, "ECT");
    if (ect && ect.num) {
      const s = stats(ect, 0, L.rows);
      if (s) {
        let verdict = "good", explain = "Reached normal running temperature.";
        if (s.max > 110) { verdict = "bad"; explain = "Too hot: check the coolant level, the fan and the radiator."; }
        else if (s.max < 75 && L.duration >= 600) { verdict = "warn"; explain = "Didn't warm up in 10+ minutes of running: the thermostat may be stuck open (P0128)."; }
        else if (s.max < 75) { verdict = "info"; explain = `Not warm yet in this log (only ${Math.max(1, Math.round(L.duration / 60))} min).`; }
        out.push({ id: "ect", title: "Coolant temperature", verdict, value: `${Math.round(s.min)} → ${Math.round(s.max)} ${ect.unit || "°C"}`, explain });
      }
    }
    // charging
    const bat = has(L, "B+") || has(L, "VPWR");
    if (bat && bat.num) {
      const r = run && run.some(Boolean), s = stats(bat, 0, L.rows, r ? run : null);
      if (s) {
        let verdict, explain;
        if (r) {
          verdict = s.avg > 15 ? "bad" : s.avg >= 13.5 ? "good" : s.avg >= 12.8 ? "warn" : "bad";
          explain = verdict === "good" ? "Charging normally." : s.avg > 15 ? "Too high: the alternator's regulator may be overcharging."
            : "Low while running: the alternator isn't charging well (belt, alternator, wiring or earths).";
        } else {
          verdict = s.avg >= 12.4 ? "good" : "warn";
          explain = verdict === "good" ? "Engine off: the battery is well charged." : "Engine off and below 12.4 V: the battery is low.";
        }
        out.push({ id: "bat", title: r ? "Charging" : "Battery", verdict, value: `${s.avg.toFixed(1)} V (${s.min.toFixed(1)}–${s.max.toFixed(1)})`, explain });
      }
    }
    // idle
    const rpm = has(L, "RPM"), want = has(L, "DSDRPM"), idle = idleMask(L);
    if (idle && idle.some(Boolean)) {
      let secs = 0;
      for (let i = 1; i < L.rows; i++) if (idle[i] && idle[i - 1]) secs += L.t[i] - L.t[i - 1];
      const s = stats(rpm, 0, L.rows, idle);
      if (s && secs >= 3) {
        let ss = 0;
        for (let i = 0; i < L.rows; i++) if (idle[i] && rpm.v[i] === rpm.v[i]) ss += (rpm.v[i] - s.avg) ** 2;
        const sd = Math.sqrt(ss / s.n);
        const w = want && want.num ? stats(want, 0, L.rows, Array.from(want.v, (v, i) => idle[i] && v > 0)) : null;
        const off = w ? s.avg - w.avg : 0;
        const verdict = sd > 60 || Math.abs(off) > 150 ? "bad" : sd > 30 || Math.abs(off) > 75 ? "warn" : "good";
        out.push({ id: "idle", title: "Idle", verdict,
          value: `${Math.round(s.avg)} rpm ±${Math.round(sd)}${w ? ` (wants ${Math.round(w.avg)})` : ""}, ${Math.round(secs)} s settled`,
          explain: verdict === "good" ? (w ? "Steady, and where the PCM wants it." : "Steady.")
            : sd > 30 ? "Hunting up and down: look for air leaks, a dirty throttle body or idle air control."
            : "Steady but away from where the PCM wants it: check the throttle body and for air leaks." });
      }
    }
    return out;
  }

  /* which PIDs show a fault best; matched by has() */
  const SUGGEST = [
    [/^P03(2[5-9]|3[0-4])$/, ["RPM", "TP", "ECT", "SPARKADV", "LOAD"], "Knock: log under load (a firm run up through the gears) and watch the spark advance pull back."],
    [/^P01(7[1-5])$/, ["SHRTFT", "LONGFT", "MAF", "O2S", "RPM"], "Mixture: the fuel trims show how much fuel the PCM is adding or taking away, at idle and at 2,500 rpm."],
    [/^P010[0-4]$/, ["MAF", "TP", "RPM", "IAT"], "Air flow: MAF should rise smoothly with RPM and throttle; about 2-4 g/s at a warm idle."],
    [/^P011[0-4]$/, ["IAT", "ECT"], "Intake air temp: on a cold engine it should read close to the coolant temp and the outside air."],
    [/^P01(1[5-9]|2[58])$/, ["ECT", "IAT", "RPM"], "Coolant temp: log from a cold start for 10+ minutes; it should climb steadily to about 90 °C and stay."],
    [/^P0(12[0-4]|22[0-9])$/, ["TP", "RPM"], "Throttle: open it slowly by hand; the reading should rise smoothly with no drop-outs."],
    [/^P01([3-5][0-9]|6[0-7])$/, ["O2S", "SHRTFT", "LONGFT", "RPM"], "O2 sensors: warm the engine; upstream should swing 0.1-0.9 V, downstream stay fairly steady."],
    [/^P03(0[0-9]|1[0-2])$/, ["RPM", "LOAD", "SHRTFT", "LONGFT", "MAF", "ECT"], "Misfire: log at idle and under load; trims and a rough RPM trace point to the cause."],
    [/^P04[23]0$/, ["O2S", "ECT", "RPM"], "Catalyst: on a warm engine at a steady 2,500 rpm, the downstream O2 should stay much steadier than the upstream."],
    [/^P050[0-3]$/, ["VSS", "RPM"], "Road speed: drive; VSS should follow the speedo with no drop-outs."],
    [/^P050[5-7]$/, ["RPM", "DSDRPM", "TP", "ECT"], "Idle: log a warm idle with the A/C off and on; RPM should sit on the desired idle speed."],
    [/^P0(56[0-3]|62[0-5])$/, ["B+", "VPWR", "RPM"], "Charging: log with the engine running and loads on (lights, fan, A/C); it should hold 13.5-14.8 V."],
    [/^P07[0-9][0-9]$/, ["TFT", "VSS", "RPM", "TP", "GEAR"], "Transmission: log a drive through all gears and watch the fluid temp and shifts."],
    [/^P0(53[0-4]|64[5-7])$/, ["ACP", "RPM", "ECT"], "A/C: log with the A/C on; the pressure should cycle within range as the compressor runs."],
  ];
  function suggest(code) {
    const c = String(code || "").toUpperCase();
    for (const [re, pids, why] of SUGGEST) if (re.test(c)) return { pids, why };
    return null;
  }
  /* the columns of a log that a suggestion covers */
  function covered(L, pids) {
    if (!L || !pids) return [];
    const out = [];
    for (const p of pids) L.cols.forEach(c => {
      if ((c.base === p || (c.base.startsWith(p) && /^[\d.]/.test(c.base.slice(p.length)))) && !out.includes(c)) out.push(c);
    });
    return out;
  }
  /* the same, from just the header names (no need to read the log) */
  function coveredNames(names, pids) {
    const bases = (names || []).map(h => splitName(h).base);
    return (pids || []).filter(p => bases.some(b => b === p || (b.startsWith(p) && /^[\d.]/.test(b.slice(p.length)))));
  }

  /* the same normal form as the laptop's livelogs.norm (for spotting a log
     that's already in by its SHA-256) */
  const norm = text => String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "") + "\n";

  const api = { NAMES, norm, splitName, parse, has, at, span, stats, envelope, checks, suggest, covered, coveredNames };
  root.FO_LOG = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
