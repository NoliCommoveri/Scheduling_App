// wipe-core.js — pure predicates for Wipe (Module 9), TDS_Slice_M2 §8.
// No IndexedDB access here — same discipline as the other -core.js modules.
//
// §14 phase 3 dropped `isPastEvent` (FR-4): it read the `events` store, which
// this upgrade drops, and had nothing to clear since Phase 5 deleted the
// packet import that used to fill it.

(function (g) {
  "use strict";

  // FR-2: an Activity Record is cleared iff it has been exported (its status
  // is necessarily 'complete' or 'waived' already, by construction — nothing
  // else is ever written to activityRecords).
  function isClearable(record) {
    return record.exported === true;
  }

  g.WipeCore = { isClearable: isClearable };
})(typeof window !== "undefined" ? window : globalThis);
