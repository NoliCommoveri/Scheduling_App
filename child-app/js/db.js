// db.js — IndexedDB access for the Child App. childAppDB, version 3
// (TDS_Slice_M1 §4, TDS_Slice_M2 §2, TDS_Slice_Online_Revamp.md §8.1).
// M1 stores (version 1), unchanged since:
//   singletons: child, semester, themeSettings  (fixed out-of-line keys)
//   received:   activities, chores, events       (keyPath "id")
//   overrides:  plannerMeta                       (keyPath "id")
// M2 stores, added additively at version 2 (TDS_Slice_M2 §2):
//   singleton:    streak                          (fixed out-of-line key, same pattern as child/semester/themeSettings)
//   keyed:        activityRecords (keyPath "activityId"), rewardLedgerSnapshot (keyPath "categoryId"),
//                 rewardLedgerTail (keyPath "id", autoIncrement — in-line, so the generated key is
//                 written back onto the stored row itself, per TDS §2's `{ id, type, categoryId, ... }` shape)
// Online Revamp Phase 2 (§12) adds one more singleton at version 3:
//   singleton:    syncMeta (device token, childId, childName — §4.3 step 5)
// Online Revamp Phase 3B adds the read side of §8.1 at version 4:
//   keyed:        assignments (keyPath "id") — the /api/plan cache
// The M1 stores it supersedes (activities/chores/events/plannerMeta) are NOT
// dropped: §12 keeps file import as a fallback through Phase 4, and plannerMeta
// is still where this device's own overrides live until the outbox exists.
// `outbox` is deliberately absent — it belongs to Phase 4, which is the first
// phase with anything to put in it; an empty store now would be dead schema.
// No dailyPlan store — the day is derived at render time and never persisted.

(function (g) {
  "use strict";

  var DB_NAME = "childAppDB";
  var DB_VERSION = 4;
  var SINGLETONS = ["child", "semester", "themeSettings", "streak", "syncMeta"];
  var KEYED = ["activities", "chores", "events", "plannerMeta", "assignments"];
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

  // Ingest a /api/plan response in one transaction (Online Revamp §5.5).
  // Upserts the rows that are still part of the plan and drops the ones the
  // Worker sent purely so the client could remove them. plan-sync.js decides
  // which is which; this is the atomic write.
  function applyPlan(puts, deleteIds) {
    if (!puts.length && !deleteIds.length) return Promise.resolve();
    return tx(["assignments"], "readwrite").then(function (t) {
      var store = t.objectStore("assignments");
      puts.forEach(function (row) { store.put(row); });
      deleteIds.forEach(function (id) { store.delete(id); });
      return txDone(t);
    });
  }

  // The pre-revamp local stores on their own — what a hand-imported packet file
  // left behind. Packet Import merges against exactly this and must not see
  // server assignments: they are not packet items, they were never in a packet,
  // and letting them seed the merge's receipt counter would muddle the ordering
  // of both paths for no gain.
  function loadLocalState() {
    return Promise.all([getAll("activities"), getAll("chores"), getAll("events"), getAll("plannerMeta")])
      .then(function (r) {
        var metaMap = Object.create(null);
        r[3].forEach(function (m) { metaMap[m.id] = m; });
        return { activities: r[0], chores: r[1], events: r[2], meta: metaMap };
      });
  }

  // Load everything the planner needs in one shot.
  //
  // Online Revamp §8.2: this still returns { activities, chores, events, meta },
  // because effectively all of planner-ui.js is built on that shape. What
  // changed underneath is where it comes from — `assignments` rows fetched from
  // /api/plan, reassembled by assignment-core.js, unioned with whatever the
  // retained file-import fallback (§12, Phase 3) has left in the local stores.
  // An explicit shim with a stated lifespan; Phase 5 collapses it.
  //
  // Ids cannot collide across the two sources: server rows carry server-minted
  // UUIDs (§3.3.1) and packet ids are the four-segment / CHR- / EVT- forms the
  // packet schema pins. Where a row does appear in both meta maps, the local
  // one wins field-by-field: until Phase 4 uploads this device's overrides, the
  // local plannerMeta entry is the newer of the two by construction.
  function loadState() {
    return Promise.all([loadLocalState(), getAll("assignments")]).then(function (r) {
      var local = r[0];
      var server = g.AssignmentCore.toState(r[1]);

      var meta = Object.create(null);
      Object.keys(server.meta).forEach(function (id) { meta[id] = server.meta[id]; });
      Object.keys(local.meta).forEach(function (id) {
        meta[id] = meta[id] ? Object.assign({}, meta[id], local.meta[id]) : local.meta[id];
      });

      return {
        activities: server.activities.concat(local.activities),
        chores: server.chores.concat(local.chores),
        events: server.events.concat(local.events),
        meta: meta
      };
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
    applyPlan: applyPlan,
    loadState: loadState,
    loadLocalState: loadLocalState,
    setMeta: setMeta,
    devWipeAll: devWipeAll
  };
})(typeof window !== "undefined" ? window : globalThis);


