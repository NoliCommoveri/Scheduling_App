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
// Online Revamp Phase 4 adds the write side at version 5:
//   keyed:        outbox (keyPath "seq", autoIncrement) — queued uploads
// Phase 5 deleted the packet import (§11), so nothing writes activities/chores/
// events any more. They are not dropped here: removing an object store is a
// DB_VERSION bump with an upgrade path, and it belongs with the rest of the
// §8.1/§8.2 collapse rather than bolted onto a deletion commit. plannerMeta is
// a different case and is still live — it is where this device's own overrides
// are written, and the outbox uploads a copy rather than replacing it.
// No dailyPlan store — the day is derived at render time and never persisted.
//
// §8.1 also names a `rewardEntries` store replacing rewardLedgerSnapshot/Tail.
// That is a Phase 5 collapse, not Phase 4 work: the local ledger is read by
// reward.js, export.js, settings.js and wipe.js, and swapping its shape in the
// same change that adds the upload path would put two unrelated risks in one
// commit. Phase 4 uploads from the existing ledger's write sites instead — see
// outbox.js's enqueueReward.

(function (g) {
  "use strict";

  var DB_NAME = "childAppDB";
  var DB_VERSION = 6;
  var SINGLETONS = ["child", "semester", "themeSettings", "streak", "syncMeta"];
  var KEYED = ["activities", "chores", "events", "plannerMeta", "assignments"];
  var KEYED_CUSTOM = [
    { name: "activityRecords", keyPath: "activityId" },
    { name: "rewardLedgerSnapshot", keyPath: "categoryId" },
    { name: "rewardLedgerTail", keyPath: "id", autoIncrement: true },
    // In-line autoIncrement, same pattern as rewardLedgerTail: the generated
    // key is written back onto the stored row, so a drained row carries the
    // `seq` the drain has to delete without a second lookup.
    { name: "outbox", keyPath: "seq", autoIncrement: true },
    // Rows the server accepted the request for but refused (§5.6's per-row
    // `rejected` array). Its own store rather than a field on syncMeta, for the
    // reason outbox.js records at length: plan-sync.js does a read-modify-write
    // on that singleton around every poll, and a second writer would eventually
    // clobber the device token. Durable rather than in-memory because unlike the
    // rest of the upload bookkeeping this is a lost write, and a counter that
    // resets on reload is how it stays lost.
    { name: "rejections", keyPath: "seq", autoIncrement: true }
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

  // Load everything the planner needs in one shot.
  //
  // Online Revamp §8.2: this still returns { activities, chores, events, meta },
  // because effectively all of planner-ui.js is built on that shape. The rows
  // now come from one source — `assignments`, fetched from /api/plan and
  // partitioned by kind — since Phase 5 deleted the packet import that used to
  // fill activities/chores/events locally. Those three stores still exist and
  // are read here only in the sense that nothing writes them any more; dropping
  // them is a schema change (§8.1) and belongs with the rest of the shim
  // collapse, not here.
  //
  // plannerMeta is NOT vestigial and is still overlaid: it is where this
  // device's own overrides (sortOrder, deferrals) are written, ahead of the
  // outbox uploading a copy. The local entry wins field-by-field over the
  // server's — a pending override is by construction newer than the columns it
  // has not yet been flushed to.
  function loadState() {
    return Promise.all([getAll("plannerMeta"), getAll("assignments")]).then(function (r) {
      var server = g.AssignmentCore.toState(r[1]);

      var meta = Object.create(null);
      Object.keys(server.meta).forEach(function (id) { meta[id] = server.meta[id]; });
      r[0].forEach(function (local) {
        meta[local.id] = meta[local.id] ? Object.assign({}, meta[local.id], local) : local;
      });

      return {
        activities: server.activities,
        chores: server.chores,
        events: server.events,
        meta: meta
      };
    });
  }

  // ---- outbox (§8.1, §8.4) ----
  //
  // The queue that makes a completion survive a dead network. A write commits
  // locally and appends here in the caller's own promise chain; outbox.js
  // drains it later. Nothing in the app awaits the drain — §III.A of CLAUDE.md:
  // "Local writes never block on the network."

  function outboxAdd(op) {
    return tx(["outbox"], "readwrite").then(function (t) {
      t.objectStore("outbox").add(op);
      return txDone(t);
    });
  }

  function outboxAll() {
    return getAll("outbox");
  }

  function outboxCount() {
    return tx(["outbox"], "readonly").then(function (t) {
      return reqToPromise(t.objectStore("outbox").count());
    });
  }

  // Delete only the rows a request actually carried, and only after a 2xx.
  // A dropped response replays them, which every §5.5 write is idempotent
  // against — that is the whole reason the ids are minted before the send.
  function outboxDelete(seqs) {
    return delMany("outbox", seqs);
  }

  // ---- rejections (§5.6) ----
  //
  // A write the server took the request for and then refused. There is nothing
  // the device can do about it on its own — a rejected row is rejected for a
  // permanent reason (a column the credential does not own, a value outside its
  // domain, an assignment belonging to someone else) — so these are kept to be
  // shown, not retried.

  function rejectionAddMany(rows) {
    if (!rows.length) return Promise.resolve();
    return tx(["rejections"], "readwrite").then(function (t) {
      rows.forEach(function (row) { t.objectStore("rejections").add(row); });
      return txDone(t);
    });
  }

  function rejectionAll() {
    return getAll("rejections");
  }

  function rejectionCount() {
    return tx(["rejections"], "readonly").then(function (t) {
      return reqToPromise(t.objectStore("rejections").count());
    });
  }

  function rejectionClear() {
    return tx(["rejections"], "readwrite").then(function (t) {
      t.objectStore("rejections").clear();
      return txDone(t);
    });
  }

  // Drop the plannerMeta override for assignments the cache no longer holds.
  // plan-sync prunes rows that were rescinded or that fell out of the window,
  // and without this their overrides accumulate in a store nothing ever reads
  // again — loadState() merges plannerMeta over the server rows by id, so an
  // orphan is invisible and permanent.
  function pruneMeta(liveIds) {
    return getAll("plannerMeta").then(function (all) {
      var dead = all
        .filter(function (m) { return !liveIds[m.id]; })
        .map(function (m) { return m.id; });
      return dead.length ? delMany("plannerMeta", dead).then(function () { return dead.length; }) : 0;
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
    applyPlan: applyPlan,
    outboxAdd: outboxAdd,
    outboxAll: outboxAll,
    outboxCount: outboxCount,
    outboxDelete: outboxDelete,
    rejectionAddMany: rejectionAddMany,
    rejectionAll: rejectionAll,
    rejectionCount: rejectionCount,
    rejectionClear: rejectionClear,
    pruneMeta: pruneMeta,
    loadState: loadState,
    setMeta: setMeta,
    devWipeAll: devWipeAll
  };
})(typeof window !== "undefined" ? window : globalThis);


