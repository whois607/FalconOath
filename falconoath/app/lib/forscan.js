/* FalconOath - FORScan DTC reports (the TXT FORScan saves from its DTC tab).

   Pure functions, no DOM: the app uses them in the browser and
   tests/js_check.js checks them against real reports under node. This is
   the only parser: the laptop stores each report whole, and the app parses
   it when it shows it.

   A report is a run of blocks, one per fault (or one "None" per module
   that read clean):

     ===ABS DTC U0401:00-28===          module ABS, code U0401, symptom 00, status 28
     Code: U0401 - Invalid Data Received From ECM/PCM 'A'
     Additional Fault Symptom (:87):    (only when there is one)
      - Missing Message
     Status (-28):
      - Previously Set DTC - Not Present at Time of Request
      - Malfunction Indicator Lamp is Off for this DTC
     Module: Antilock braking system
     ...FORScan's own notes, sometimes...
     ===END ABS DTC U0401:00-28===

   Two header forms, worked out from real FG and BA reports (NOTES.md):
   * CODE:SS-ST  (newer modules, UDS): SS is the symptom byte (FTB) and ST
     the ISO 14229 status byte, printed by FORScan unchanged.
   * CODE-XY     (older modules): one byte holding both - the high half is
     the status (FORScan prints XY with the low half zeroed: 63 -> -60) and
     the low half is the symptom (3 -> FORScan's ":03"; F = none given).

   parse(text)   -> {modules, faults, counts, unparsed}
   decode(fault) -> what the status byte says, checked against FORScan's
                    own words, which win if they ever disagree */
(function (root) {
  "use strict";
  const BLOCK = /^===(\S+) DTC (.+?)===\n([\s\S]*?)^===END \1 DTC \2===[ \t]*$/gm;
  const HEAD = /^([PBCU][0-9A-F]{4})(?::([0-9A-F]{2}))?-([0-9A-F]{2})$/;
  const hex2 = n => n.toString(16).toUpperCase().padStart(2, "0");

  function norm(text) { return String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n"); }

  /* " - a\n - b" lines after a heading like "Status (-28):" */
  function section(body, label) {
    const re = new RegExp("^" + label + " \\((-?:?[0-9A-F]+)\\):\\n((?:[ \\t]*- .*(?:\\n|$))+)", "m");
    const m = re.exec(body);
    if (!m) return null;
    return { value: m[1].replace(/^[-:]+/, ""), lines: m[2].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
             start: m.index, end: m.index + m[0].length };
  }

  function parseBlock(mod, head, body) {
    const nameM = /^Module: (.+)$/m.exec(body);
    const moduleName = nameM ? nameM[1].trim() : "";
    if (head === "None") {
      const first = body.split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
      return { module: mod, moduleName, none: true, message: first };
    }
    const f = { module: mod, moduleName, raw: head };
    const h = HEAD.exec(head);
    if (!h) { f.unparsed = true; f.code = head; f.body = body.trim(); return f; }
    f.code = h[1];
    f.format = h[2] != null ? "uds" : "packed";
    f.byte = parseInt(h[3], 16);
    f.ftb = h[2] != null ? h[2] : null;
    const title = /^Code: (\S+) - (.*)$/m.exec(body);
    f.title = title ? title[2].trim() : "";
    const sym = section(body, "Additional Fault Symptom");
    f.symptom = sym ? { code: sym.value, text: sym.lines.join("; ") } : null;
    const st = section(body, "Status");
    f.printedStatus = st ? st.value : null;
    f.statusLines = st ? st.lines : [];
    // whatever else FORScan wrote (its notes): the body minus the parts above
    let rest = body;
    [st, sym].filter(Boolean).sort((a, b) => b.start - a.start).forEach(s => { rest = rest.slice(0, s.start) + rest.slice(s.end); });
    rest = rest.replace(/^Code: .*$/m, "").replace(/^Module: .*$/m, "");
    f.notes = rest.split("\n").map(s => s.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return f;
  }

  function parse(text) {
    const t = norm(text), modules = [], byMod = new Map(), faults = [], unparsed = [];
    let m;
    BLOCK.lastIndex = 0;
    while ((m = BLOCK.exec(t))) {
      const b = parseBlock(m[1], m[2], m[3]);
      let mod = byMod.get(b.module);
      if (!mod) { mod = { module: b.module, name: b.moduleName, faults: [], clean: false, message: "" }; byMod.set(b.module, mod); modules.push(mod); }
      if (!mod.name && b.moduleName) mod.name = b.moduleName;
      if (b.none) { mod.clean = true; mod.message = b.message; continue; }
      if (b.unparsed) unparsed.push(b);
      else { b.decoded = decode(b); faults.push(b); }
      mod.faults.push(b);
    }
    modules.forEach(x => { if (x.faults.length) x.clean = false; });
    const counts = {
      modules: modules.length, clean: modules.filter(x => x.clean).length,
      faults: faults.length, active: faults.filter(f => f.decoded.state === "active").length,
      stored: faults.filter(f => f.decoded.state !== "active").length, unparsed: unparsed.length,
    };
    return { modules, faults, counts, unparsed, blocks: modules.length ? true : false };
  }

  /* ---- the status byte */
  const UDS_BITS = [
    [0x01, "testFailed", "failing at the moment of the scan"],
    [0x02, "testFailedThisOperationCycle", "failed during this drive cycle"],
    [0x04, "pendingDTC", "pending: seen, not yet confirmed"],
    [0x08, "confirmedDTC", "confirmed and stored"],
    [0x10, "testNotCompletedSinceLastClear", "its self-test hasn't finished since codes were last cleared"],
    [0x20, "testFailedSinceLastClear", "has failed since codes were last cleared"],
    [0x40, "testNotCompletedThisOperationCycle", "its self-test hasn't finished this drive cycle"],
    [0x80, "warningIndicatorRequested", "asking for the warning lamp"],
  ];
  // the older modules' status half; only 0x20 and 0x40 have been seen in real reports
  const PACKED_BITS = [
    [0x10, "unknown (not yet seen in a report)", false],
    [0x20, "stored: set at some point", true],
    [0x40, "present at the moment of the scan", true],
    [0x80, "probably asking for the warning lamp (not yet seen in a report)", false],
  ];

  /* what FORScan's own lines say: true / false / null (not said) */
  function forscanSays(lines) {
    const s = lines.join("\n");
    return {
      present: /Not Present at Time of Request/i.test(s) ? false : /Present at Time of Request/i.test(s) ? true : null,
      lamp: /Lamp is Off/i.test(s) ? false : /Lamp is On|Lamp Requested|Lamp On/i.test(s) ? true : null,
      incomplete: /Test not complete/i.test(s) || null,
      pending: /Pending/i.test(s) || null,
    };
  }

  function decode(f) {
    const b = f.byte, out = { byte: b, hex: hex2(b), format: f.format, bits: [] };
    if (f.format === "uds") {
      out.status = b;
      UDS_BITS.forEach(([bit, name, says]) => { if (b & bit) out.bits.push({ bit: hex2(bit), name, says, seen: true }); });
      out.present = !!(b & 0x01);
      out.lamp = !!(b & 0x80);
      out.pending = !!(b & 0x04);
      out.confirmed = !!(b & 0x08);
      out.incomplete = !!(b & 0x50);
      out.symptomCode = f.ftb;
      out.printedOk = f.printedStatus == null || parseInt(f.printedStatus, 16) === b;
    } else {
      out.status = b & 0xF0;
      PACKED_BITS.forEach(([bit, says, seen]) => { if (b & bit) out.bits.push({ bit: hex2(bit), name: "", says, seen }); });
      out.present = !!(b & 0x40);
      out.lamp = !!(b & 0x80);
      out.pending = false;
      out.confirmed = !!(b & 0x20);
      out.incomplete = false;
      const n = b & 0x0F;
      out.symptomCode = n === 0 ? null : n === 0xF ? null : hex2(n);
      out.symptomNone = n === 0xF ? "none given" : null;
      out.printedOk = f.printedStatus == null || parseInt(f.printedStatus, 16) === (b & 0xF0);
    }
    // FORScan's own words are the authority; say so if the byte disagrees
    const fs = forscanSays(f.statusLines || []);
    out.forscan = fs;
    out.agrees = (fs.present == null || fs.present === out.present) && (fs.lamp == null || fs.lamp === out.lamp)
      && out.printedOk && (f.format !== "packed" || !f.symptom || f.symptom.code === out.symptomCode);
    const present = fs.present != null ? fs.present : out.present;
    const lamp = fs.lamp != null ? fs.lamp : out.lamp;
    out.state = present ? "active" : out.pending && !out.confirmed ? "pending" : "stored";
    out.lampOn = lamp;
    out.testIncomplete = !!(fs.incomplete || out.incomplete);
    return out;
  }

  /* the same report, compared as the laptop compares it */
  function sameReport(a, b) { return norm(a).trim() === norm(b).trim(); }

  const api = { parse, decode, norm, sameReport, UDS_BITS, PACKED_BITS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FO_FORSCAN = api;
})(typeof self !== "undefined" ? self : this);
