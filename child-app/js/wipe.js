// wipe.js — Wipe (Module 9), wired to IndexedDB. TDS_Slice_M2 §8.
// Runs as a single transaction opened against exactly this store —
// rewardEntries and streak are never named here, which is what makes FR-6's
// "never touches either, under any circumstance" a structural guarantee rather
// than a discipline the code has to remember (inspectable directly from
// WIPE_STORES below, per the TDS's own acceptance check). The ledger store was
// renamed by the §8.1 collapse; the guarantee is unchanged, and a store that is
// not in this list cannot be reached by this transaction at all.
//
// §14 phase 3: FR-3's paired Activity/Chore delete and FR-4's past-event clear
// read `activities`/`chores`/`events`, which this upgrade drops. Neither one
// had anything to do since Phase 5 deleted the packet import that used to fill
// them — a completion since Phase 3B has no row in either store, so the old
// pairing lookup always fell through to a no-op `chores` delete, and nothing
// has written `events` at all. What is left is what was actually live: FR-2,
// clearing an exported activityRecords row.

(function (g) {
  "use strict";

  var C = g.WipeCore;
  var WIPE_STORES = ["activityRecords"];

  function runWipe() {
    return g.DB.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(WIPE_STORES, "readwrite");
        var clearedRecords = 0;

        // FR-2: cursor over activityRecords; clear each exported record.
        tx.objectStore("activityRecords").openCursor().onsuccess = function (ev) {
          var cursor = ev.target.result;
          if (!cursor) return;
          if (C.isClearable(cursor.value)) { cursor.delete(); clearedRecords++; }
          cursor.continue();
        };

        tx.oncomplete = function () { resolve({ ok: true, clearedRecords: clearedRecords }); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  g.Wipe = { runWipe: runWipe, WIPE_STORES: WIPE_STORES };
})(typeof window !== "undefined" ? window : globalThis);
