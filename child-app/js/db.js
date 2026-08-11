// db.js — IndexedDB access for the Child App. childAppDB, version 3
// (TDS_Slice_M1 §4, TDS_Slice_M2 §2, TDS_Slice_Online_Revamp.md §8.1).
// M1 stores (version 1), unchanged since:
//   singletons: child, semester, themeSettings  (fixed out-of-line keys)
//   received:   activities, chores, events       (keyPath "id")
//   overrides:  plannerMeta                       (keyPath "id")
// M2 stores, added additively at version 2 (TDS_Slice_M2 §2):
//   singleton:    streak                          (fixed out-of-line key, same pattern as child/semester/themeSettings)
//   keyed:        activityRecords (keyPath "activityId"), and the two-store reward
//                 ledger — rewardLedgerSnapshot/rewardLedgerTail — both dropped at
//                 version 7 below.
// Online Revamp Phase 2 (§12) adds one more singleton at version 3:
//   singleton:    syncMeta (device token, childId, childName — §4.3 step 5)
// Online Revamp Phase 3B adds the read side of §8.1 at version 4:
//   keyed:        assignments (keyPath "id") — the /api/plan cache
// Online Revamp Phase 4 adds the write side at version 5:
//   keyed:        outbox (keyPath "seq", autoIncrement) — queued uploads
// Version 6 adds `rejections` (§5.6).
// Version 7 completes the ledger half of §8.1: rewardLedgerSnapshot and
//   rewardLedgerTail are migrated into a single append-only `rewardEntries`
//   store (keyPath "id") and then deleted. See migrateLedgerToEntries below;
//   the balance math that used to fold them lives in completion-core.js.
//
// Phase 5 deleted the packet import (§11), so nothing writes activities/chores/
// events any more. They are still not dropped: they belong to the §8.2 planner
// collapse, which §12 gates on phases 3-4 having carried live days, and that
// gate is not met yet. plannerMeta is a different case and is still live — it is
// where this device's own overrides are written, and the outbox uploads a copy
// rather than replacing it.
// No dailyPlan store — the day is derived at render time and never persisted.

(function (g) {
  "use strict";

  var DB_NAME = "childAppDB";
  var DB_VERSION = 7;
  var SINGLETONS = ["child", "semester", "themeSettings", "streak", "syncMeta"];
  var KEYED = ["activities", "chores", "events", "plannerMeta", "assignments"];
  var KEYED_CUSTOM = [
    { name: "activityRecords", keyPath: "activityId" },
    // §3.4/§8.1's append-only ledger. Keyed on the client-minted entry id, which
    // is the same id the outbox uploads — so the local row and the server row
    // are one row, and a replayed append collides on the primary key at both
    // ends. Never updated, never deleted; a correction is a compensating entry.
    { name: "rewardEntries", keyPath: "id" },
    // In-line autoIncrement: the generated key is written back onto the stored
    // row, so a drained row carries the `seq` the drain has to delete without a
    // second lookup.
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

  // Local midnight for a YYYY-MM-DD string, as ms. Used only to give a migrated
  // ledger entry an `earnedAt` — the old rows carry a calendar date and an
  // autoincrement key, never a clock reading.
  function dayStartMs(dateStr) {
    if (!dateStr) return 0;
    var p = String(dateStr).split("-").map(Number);
    if (p.length !== 3 || p.some(isNaN)) return 0;
    return new Date(p[0], p[1] - 1, p[2]).getTime();
  }

  // v7 (§8.1): fold the two-store ledger into `rewardEntries` and drop it.
  //
  // Runs inside the versionchange transaction, so the old stores are deleted
  // only after their contents have been rewritten — if anything throws, the
  // whole upgrade aborts and the next open retries it against untouched data.
  // That matters more here than anywhere else in this file: this is a child's
  // reward balance, and §3.4's ledger is append-only precisely because a lost
  // balance is not something a parent can reconstruct.
  //
  // Migrated rows are written locally and never enqueued. Entries appended
  // before Phase 4 were never uploaded, and entries appended after it were
  // uploaded already under a different minted id; enqueueing either now would
  // double-count against an append-only server ledger. They carry `migrated:
  // true` so a reader can tell them from rows whose id the server also knows.
  function migrateLedgerToEntries(db, upgradeTx) {
    var hasSnapshot = db.objectStoreNames.contains("rewardLedgerSnapshot");
    var hasTail = db.objectStoreNames.contains("rewardLedgerTail");
    if (!hasSnapshot && !hasTail) return;

    var target = upgradeTx.objectStore("rewardEntries");
    var snapshotReq = hasSnapshot ? upgradeTx.objectStore("rewardLedgerSnapshot").getAll() : null;
    var tailReq = hasTail ? upgradeTx.objectStore("rewardLedgerTail").getAll() : null;

    // Requests on one transaction complete in the order they were issued, so
    // waiting on the later of the two is enough to have both results.
    var last = tailReq || snapshotReq;
    last.onsuccess = function () {
      var snapshots = (snapshotReq && snapshotReq.result) || [];
      var tail = ((tailReq && tailReq.result) || []).slice()
        .sort(function (a, b) { return a.id - b.id; });

      // A snapshot is every folded entry for its category collapsed into one
      // number, with no way back to the rows it folded. It migrates as a single
      // opening entry at the epoch — earlier than any real entry, which is the
      // ordering the fold already gave it.
      snapshots.forEach(function (s) {
        if (!s || !s.categoryId) return;
        target.put({
          id: "migrated-opening-" + s.categoryId,
          assignmentId: null,
          category: s.categoryId,
          amount: typeof s.balance === "number" ? s.balance : 0,
          reason: "adjustment",
          earnedAt: 0,
          date: s.asOfDate || null,
          migrated: true
        });
      });

      tail.forEach(function (e) {
        if (!e || !e.categoryId) return;
        target.put({
          id: "migrated-" + e.id,
          assignmentId: e.sourceId || null,
          category: e.categoryId,
          // The old shape carried the sign in `type`; the new one carries it in
          // `amount`. 'earn' and 'adjust' were already stored signed as intended.
          amount: e.type === "spend" ? -e.amount : e.amount,
          reason: e.type === "spend" ? "spend" : (e.type === "adjust" ? "adjustment" : "earned"),
          // Ordering, not a real timestamp. Local midnight plus the old
          // autoincrement key preserves the exact fold order these rows had
          // without inventing precision the data never carried.
          earnedAt: dayStartMs(e.date) + e.id,
          date: e.date || null,
          migrated: true
        });
      });

      if (hasTail) db.deleteObjectStore("rewardLedgerTail");
      if (hasSnapshot) db.deleteObjectStore("rewardLedgerSnapshot");
    };
  }

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
        // After the creates: the migration writes into `rewardEntries`, which
        // the loop above has just made on any database old enough to need it.
        migrateLedgerToEntries(db, req.transaction);
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
  // Online Revamp §8.2/§14: the planner now works from `rows` — decorated
  // `assignments` rows, each carrying its own overrides. This device's unflushed
  // overrides are overlaid first, as the child-owned columns they are on their
  // way to becoming, so nothing downstream has to consult a second object to
  // know when an item is due or where it sits. The `activities` / `chores` /
  // `events` / `meta` keys come back alongside because CLAUDE.md §IV.B pins this
  // shape until the collapse finishes; streak.js is the only remaining consumer
  // of any of them.
  //
  // `assignments` is the one source: Phase 5 deleted the packet import that used
  // to fill the legacy activities/chores/events stores locally, and nothing has
  // written them since. Dropping those stores is a schema change (§8.1) and
  // belongs with the rest of the collapse, not here.
  function loadState() {
    return Promise.all([getAll("plannerMeta"), getAll("assignments")]).then(function (r) {
      return g.AssignmentCore.toState(g.AssignmentCore.applyLocalMeta(r[1], r[0]));
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


