// Run by tests/check_offline.py:
//   node offline_check.js <devtools port> <app url> <token> <listener pid>
// Drives headless Chrome over the DevTools protocol (node's own WebSocket):
// open the app with a paired token, wait for the data and the offline
// worker, stop the listener, reload, and check it still opens and searches.
// Prints one JSON object of results.
"use strict";
const [dtPort, appUrl, token, pid] = process.argv.slice(2);
const out = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${dtPort}/json/list`)).json(); } catch (e) { await sleep(200); }
  }
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const wait = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; };

  await send("Page.enable");
  await send("Page.navigate", { url: appUrl });
  await until("document.readyState === 'complete'", 10000);
  await ev(`localStorage.setItem("falconoath.token", ${JSON.stringify(token)}); location.reload(); 1`);
  await sleep(500);
  out.synced = await until("!!(self.FO && FO.DB && FO.DB.snap.counts.dtc === 1195)", 15000);
  out.worker = await until("navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))", 15000);
  await ev("location.reload(); 1");                       // now under the worker's control
  await sleep(500);
  out.controlled = await until("!!navigator.serviceWorker.controller", 10000);

  process.kill(Number(pid));                              // the laptop goes away
  await sleep(800);
  out.listenerGone = await ev("fetch('/ping', {cache: 'no-store'}).then(() => false, () => true)");
  await send("Page.navigate", { url: "about:blank" });     // a real reopen, not a hash change
  await sleep(500);
  await send("Page.navigate", { url: appUrl.replace(/\/$/, "") + "/#/search?q=P0325" });
  await sleep(500);
  out.offlineOpens = await until("document.readyState === 'complete' && !!document.getElementById('main')", 10000);
  out.offlineData = await until("!!(self.FO && FO.DB) && document.getElementById('res') && document.getElementById('res').innerText.includes('P0325')", 10000);
  out.pill = await ev("document.querySelector('#pill span').textContent");
  ws.close();
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.log(JSON.stringify(Object.assign(out, { error: String(e) }))); process.exit(0); });
