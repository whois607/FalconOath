/* FalconOath - IndexedDB key/value store ("falconoath" db, store "kv").
   Holds the data copy (key "snap"); later the manual library and the
   outbox get stores of their own. */
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
  root.FO_IDB = { get, put };
})(self);
