// wipe-core.js — pure predicates for Wipe (Module 9), TDS_Slice_M2 §8.
// No IndexedDB access here — same discipline as the other -core.js modules.

(function (g) {
  "use strict";

  // FR-2: an Activity Record is cleared iff it has been exported (its status
  // is necessarily 'complete' or 'waived' already, by construction — nothing
  // else is ever written to activityRecords).
  function isClearable(record) {
    return record.exported === true;
  }

  // FR-4: a Family Event clears once its effective date — endDate, or
  // startDate if no endDate (the same field the Daily Planner reads for a
  // Family Event's date, M1 §2/§4) — is strictly before device-local today.
  function isPastEvent(event, today) {
    var effectiveDate = event.endDate || event.startDate;
    return effectiveDate < today;
  }

  g.WipeCore = { isClearable: isClearable, isPastEvent: isPastEvent };
})(typeof window !== "undefined" ? window : globalThis);
