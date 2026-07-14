// wipe.js — Wipe (Module 9), wired to IndexedDB. TDS_Slice_M2 §8.
// Runs as a single transaction opened against exactly these four stores —
// rewardLedgerSnapshot/rewardLedgerTail/streak are never named here, which is
// what makes FR-6's "never touches either, under any circumstance" a
// structural guarantee rather than a discipline the code has to remember
// (inspectable directly from WIPE_STORES below, per the TDS's own acceptance check).

(function (g) {
  "use strict";

  var C = g.WipeCore;
  var WIPE_STORES = ["activityRecords", "activities", "chores", "events"];

  function runWipe() {
    var today = g.DateUtil.today();
    return g.DB.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(WIPE_STORES, "readwrite");
        var clearedRecords = 0;
        var clearedEvents = 0;

        // FR-2/FR-3: cursor over activityRecords; each exported record and its
        // paired as-received Activity/Chore entry are cleared together, never
        // independently. activityId belongs to exactly one of activities/chores,
        // never both (Interchange Contract §0 — same invariant Module 8 relies on).
        tx.objectStore("activityRecords").openCursor().onsuccess = function (ev) {
          var cursor = ev.target.result;
          if (!cursor) return;
          var rec = cursor.value;
          if (!C.isClearable(rec)) { cursor.continue(); return; }
          var activitiesStore = tx.objectStore("activities");
          activitiesStore.get(rec.activityId).onsuccess = function (getEv) {
            if (getEv.target.result) activitiesStore.delete(rec.activityId);
            else tx.objectStore("chores").delete(rec.activityId);
            cursor.delete();
            clearedRecords++;
            cursor.continue();
          };
        };

        // FR-4: cursor over events; clear only those strictly in the past.
        tx.objectStore("events").openCursor().onsuccess = function (ev) {
          var cursor = ev.target.result;
          if (!cursor) return;
          if (C.isPastEvent(cursor.value, today)) { cursor.delete(); clearedEvents++; }
          cursor.continue();
        };

        tx.oncomplete = function () { resolve({ ok: true, clearedRecords: clearedRecords, clearedEvents: clearedEvents }); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  g.Wipe = { runWipe: runWipe, WIPE_STORES: WIPE_STORES };
})(typeof window !== "undefined" ? window : globalThis);
