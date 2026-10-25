/* FalconOath - IndexedDB key/value store ("falconoath" db, store "kv").
   Holds the data copy ("snap"), the manuals' copy ("lib"), the outbox
   ("outbox"), PDFs and logs waiting to go to the laptop ("upl:<upload id>"),
   and every live-data log, gzipped ("logcsv:<sha256>").
   Kept PDFs live in the Cache API instead (manuals.js). */
(function (root) {
  "use strict";
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((ok, no) => {
      const r = indexedDB.open("falconoath", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => { dbp = null; no(r.error); };
    });
    return dbp;
  }
  async function get(k) {
    const db = await open();
    return new Promise((ok, no) => {
      const q = db.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
    });
  }
  async function put(k, v) {
    const db = await open();
    return new Promise((ok, no) => {
      const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k);
      t.oncomplete = () => ok(); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
    });
  }
  async function del(k) {
    const db = await open();
    return new Promise((ok, no) => {
      const t = db.transaction("kv", "readwrite"); t.objectStore("kv").delete(k);
      t.oncomplete = () => ok(); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
    });
  }
  async function keys() {
    const db = await open();
    return new Promise((ok, no) => {
      const q = db.transaction("kv").objectStore("kv").getAllKeys();
      q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
    });
  }
  root.FO_IDB = { get, put, del, keys };
})(self);
