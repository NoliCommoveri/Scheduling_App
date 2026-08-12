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
// Version 8 is phase 3 of the §8.2 planner shim collapse (§14): `activities`,
//   `chores` and `events` are dropped. Phase 5 had already deleted the packet
//   import that used to fill them, and phase 2 removed their last reader —
//   `decorate()` works from the assignment row alone — so nothing in the app
//   consulted them going into this upgrade. Nothing is migrated out of them:
//   an upgrading device drops them empty.
// Version 9 folds `plannerMeta` into the assignment row's own columns (§14,
//   split out of the §8.2 collapse as its own write-path item): any override
//   this device wrote but had not yet drained is carried onto the `assignments`
//   row it overrides, and the store is dropped. See foldPlannerMetaIntoAssignments
//   below. Local writes now go straight onto the cached row (setAssignmentFields)
//   instead of a separate keyed store.
// No dailyPlan store — the day is derived at render time and never persisted.

(function (g) {
  "use strict";

  var DB_NAME = "childAppDB";
  var DB_VERSION = 9;
  var SINGLETONS = ["child", "semester", "themeSettings", "streak", "syncMeta"];
  var KEYED = ["assignments"];
  // Stores dropped at version 8 (§14 phase 3). Deleted only if present, so a
  // fresh install (which never created them) upgrades through this step as a
  // no-op.
  var DROPPED_V8 = ["activities", "chores", "events"];
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

  // v9 (§14): fold `plannerMeta` into the `assignments` row's own columns and
  // drop the store. An override this device wrote but has not yet drained is
  // still live in `plannerMeta` on any device reaching this upgrade — it is
  // carried onto the row it overrides before the store goes away, so a
  // pending deferral or reorder is not silently lost the moment the upgrade
  // runs. An override with no matching row (the assignment already fell out
  // of the cache) is dropped along with it: nothing would ever have read it
  // again either way, same as pruneMeta used to do at runtime.
  //
  // Runs inside the versionchange transaction, same discipline as
  // migrateLedgerToEntries: the store is deleted only after every fold-in
  // read/write against it has resolved, so an interrupted upgrade retries
  // against untouched data rather than losing an override partway through.
  function foldPlannerMetaIntoAssignments(db, upgradeTx) {
    if (!db.objectStoreNames.contains("plannerMeta")) return;
    var metaStore = upgradeTx.objectStore("plannerMeta");
    var rowStore = upgradeTx.objectStore("assignments");

    var metaReq = metaStore.getAll();
    metaReq.onsuccess = function () {
      var overrides = (metaReq.result || []).filter(function (m) { return m && m.id; });
      if (overrides.length === 0) { db.deleteObjectStore("plannerMeta"); return; }

      var remaining = overrides.length;
      overrides.forEach(function (m) {
        var patch = {};
        if (m.deferredDate != null) patch.deferred_to = m.deferredDate;
        if (m.blockHint != null) patch.child_block_hint = m.blockHint;
        if (m.sortOrder != null) patch.child_sort_order = m.sortOrder;

        var rowReq = rowStore.get(m.id);
        rowReq.onsuccess = function () {
          var row = rowReq.result;
          if (row && Object.keys(patch).length) rowStore.put(Object.assign({}, row, patch));
          if (--remaining === 0) db.deleteObjectStore("plannerMeta");
        };
      });
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
        // v8 (§14 phase 3): drop the stores nothing has written to since Phase 5.
        DROPPED_V8.forEach(function (name) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        });
        // v9 (§14): fold plannerMeta onto the assignments rows it overrides,
        // then drop it. Must run after the KEYED loop above has ensured
        // `assignments` exists.
        foldPlannerMetaIntoAssignments(db, req.transaction);
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
  //
  // Before a row is stored, any of this device's own planner-column writes
  // still sitting in the outbox are reapplied on top of it (§14 — folding
  // plannerMeta into the row means the row itself is now the only place those
  // overrides live). The outbox is the ground truth for what has not reached
  // the server yet; a plan fetched before the drain caught up must not
  // silently revert a deferral or reorder the child made moments ago.
  function applyPlan(puts, deleteIds) {
    if (!puts.length && !deleteIds.length) return Promise.resolve();
    return tx(["assignments", "outbox"], "readwrite").then(function (t) {
      var store = t.objectStore("assignments");
      return reqToPromise(t.objectStore("outbox").getAll()).then(function (queued) {
        var pendingById = Object.create(null);
        (queued || []).forEach(function (op) {
          if (!op || op.kind !== "completion" || !op.assignmentId) return;
          var patch = g.OutboxCore.columnsFromCompletionFields(op.fields);
          if (Object.keys(patch).length === 0) return;
          pendingById[op.assignmentId] = Object.assign(pendingById[op.assignmentId] || {}, patch);
        });

        puts.forEach(function (row) {
          var patch = pendingById[row.id];
          store.put(patch ? Object.assign({}, row, patch) : row);
        });
        deleteIds.forEach(function (id) { store.delete(id); });
        return txDone(t);
      });
    });
  }

  // Load everything the planner needs in one shot.
  //
  // Online Revamp §8.2/§14: the planner works from `rows` — decorated
  // `assignments` rows, each carrying its own overrides. §14 folded
  // `plannerMeta` into the row's own child-owned columns, so `assignments` is
  // now the only store this reads: a local override is just a column value,
  // not a second object merged in at read time.
  function loadState() {
    return getAll("assignments").then(function (rows) {
      return g.AssignmentCore.toState(rows);
    });
  }

  // The same cache, indexed by id and unfiltered — what a completion record has
  // to be joined against to render at all. Deliberately a second read rather
  // than a second key on loadState(): §IV.B of CLAUDE.md pins that function's
  // shape at `{ rows }`, and `rows` means the plan. See decorateById.
  function loadAssignmentIndex() {
    return getAll("assignments").then(function (rows) {
      return g.AssignmentCore.decorateById(rows);
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

  // Merge a patch of child-owned columns directly onto the cached `assignments`
  // row (§14 — plannerMeta folded into the row it used to stage ahead of).
  // Read-modify-write, so a block/order/deferral override lands next to
  // whatever the server last sent for every other column. A no-op when the
  // row is not cached: there is nothing yet for the child to have overridden,
  // and nothing this device could be pruning either — an override now lives
  // and dies with the row it is on, so there is no separate orphan to prune.
  function setAssignmentFields(id, patch) {
    return get("assignments", id).then(function (existing) {
      if (!existing) return;
      return put("assignments", Object.assign({}, existing, patch));
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
    loadState: loadState,
    loadAssignmentIndex: loadAssignmentIndex,
    setAssignmentFields: setAssignmentFields,
    devWipeAll: devWipeAll
  };
})(typeof window !== "undefined" ? window : globalThis);


