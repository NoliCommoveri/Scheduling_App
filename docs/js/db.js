// db.js — IndexedDB access for the Child App. childAppDB, version 2 (TDS_Slice_M1 §4, TDS_Slice_M2 §2).
// M1 stores (version 1), unchanged by the version 2 upgrade:
//   singletons: child, semester, themeSettings  (fixed out-of-line keys)
//   received:   activities, chores, events       (keyPath "id")
//   overrides:  plannerMeta                       (keyPath "id")
// M2 stores, added additively at version 2 (TDS_Slice_M2 §2):
//   singleton:    streak                          (fixed out-of-line key, same pattern as child/semester/themeSettings)
//   keyed:        activityRecords (keyPath "activityId"), rewardLedgerSnapshot (keyPath "categoryId"),
//                 rewardLedgerTail (keyPath "id", autoIncrement — in-line, so the generated key is
//                 written back onto the stored row itself, per TDS §2's `{ id, type, categoryId, ... }` shape)
// No dailyPlan store — the day is derived at render time and never persisted.

(function (g) {
  "use strict";

  var DB_NAME = "childAppDB";
  var DB_VERSION = 2;
  var SINGLETONS = ["child", "semester", "themeSettings", "streak"];
  var KEYED = ["activities", "chores", "events", "plannerMeta"];
  var KEYED_CUSTOM = [
    { name: "activityRecords", keyPath: "activityId" },
    { name: "rewardLedgerSnapshot", keyPath: "categoryId" },
    { name: "rewardLedgerTail", keyPath: "id", autoIncrement: true }
  ];

  var _db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        SINGLETONS.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        });
        KEYED.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        });
        KEYED_CUSTOM.forEach(function (spec) {
          if (!db.objectStoreNames.contains(spec.name)) {
            db.createObjectStore(spec.name, { keyPath: spec.keyPath, autoIncrement: !!spec.autoIncrement });
          }
        });
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(stores, mode) {
    return open().then(function (db) { return db.transaction(stores, mode); });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // Singleton get/put use the store name as the fixed key.
  function getSingleton(store) {
    return tx([store], "readonly").then(function (t) { return reqToPromise(t.objectStore(store).get(store)); });
  }
  function putSingleton(store, value) {
    return tx([store], "readwrite").then(function (t) {
      var p = reqToPromise(t.objectStore(store).put(value, store));
      return p.then(function () { return txDone(t); });
    });
  }

  function getAll(store) {
    return tx([store], "readonly").then(function (t) { return reqToPromise(t.objectStore(store).getAll()); });
  }
  function get(store, key) {
    return tx([store], "readonly").then(function (t) { return reqToPromise(t.objectStore(store).get(key)); });
  }
  function put(store, value) {
    return tx([store], "readwrite").then(function (t) {
      var p = reqToPromise(t.objectStore(store).put(value));
      return p.then(function () { return txDone(t); });
    });
  }
  function del(store, key) {
    return tx([store], "readwrite").then(function (t) {
      var p = reqToPromise(t.objectStore(store).delete(key));
      return p.then(function () { return txDone(t); });
    });
  }
  // Put several values into one store in a single transaction (e.g. Module 8
  // flipping every exported record's flag in one atomic pass, TDS_Slice_M2 §7).
  function putMany(store, values) {
    if (!values.length) return Promise.resolve();
    return tx([store], "readwrite").then(function (t) {
      values.forEach(function (v) { t.objectStore(store).put(v); });
      return txDone(t);
    });
  }
  // Delete several keys from one store in a single transaction (e.g. a Reward
  // Ledger fold's folded tail rows, TDS_Slice_M2 §4).
  function delMany(store, keys) {
    if (!keys.length) return Promise.resolve();
    return tx([store], "readwrite").then(function (t) {
      keys.forEach(function (k) { t.objectStore(store).delete(k); });
      return txDone(t);
    });
  }

  function txDone(t) {
    return new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  // Apply a merge result (arrays of full records) atomically to activities/chores/events.
  function applyMerge(mergeResult) {
    return tx(["activities", "chores", "events"], "readwrite").then(function (t) {
      mergeResult.activityPuts.forEach(function (r) { t.objectStore("activities").put(r); });
      mergeResult.chorePuts.forEach(function (r) { t.objectStore("chores").put(r); });
      mergeResult.eventPuts.forEach(function (r) { t.objectStore("events").put(r); });
      return txDone(t);
    });
  }

  // Load everything the planner needs in one shot.
  function loadState() {
    return Promise.all([getAll("activities"), getAll("chores"), getAll("events"), getAll("plannerMeta")])
      .then(function (r) {
        var metaMap = Object.create(null);
        r[3].forEach(function (m) { metaMap[m.id] = m; });
        return { activities: r[0], chores: r[1], events: r[2], meta: metaMap };
      });
  }

  // Read/merge/write a single plannerMeta field, leaving other fields intact.
  function setMeta(id, patch) {
    return get("plannerMeta", id).then(function (existing) {
      var rec = Object.assign({ id: id }, existing || {}, patch);
      return put("plannerMeta", rec);
    });
  }

  // DEV-ONLY: not part of any SRS module. Clears every row from every store
  // (rather than deleting the whole database) so a fresh reload re-enters
  // the Startup Wizard as if the app were never set up. Not the spec'd
  // Module 9 Wipe — this clears Child/Semester/Theme too, which Module 9
  // never touches. Uses store.clear() instead of indexedDB.deleteDatabase()
  // because deleteDatabase + an immediate reload races the browser's actual
  // teardown of the database file, which can leave the next open() failing.
  function devWipeAll() {
    var allStores = SINGLETONS.concat(KEYED)
      .concat(KEYED_CUSTOM.map(function (spec) { return spec.name; }));
    return tx(allStores, "readwrite").then(function (t) {
      allStores.forEach(function (name) { t.objectStore(name).clear(); });
      return txDone(t);
    });
  }

  g.DB = {
    open: open,
    getSingleton: getSingleton,
    putSingleton: putSingleton,
    getAll: getAll,
    get: get,
    put: put,
    del: del,
    delMany: delMany,
    putMany: putMany,
    applyMerge: applyMerge,
    loadState: loadState,
    setMeta: setMeta,
    devWipeAll: devWipeAll
  };
})(typeof window !== "undefined" ? window : globalThis);


