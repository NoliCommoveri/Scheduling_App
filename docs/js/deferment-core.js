// deferment-core.js — pure logic for Deferment / Waive (Module 5), TDS_Slice_M2 §6.
// No IndexedDB access here — same discipline as merge-core.js/completion-core.js.

(function (g) {
  "use strict";

  // Reschedule date must be device-local today or later (§2.2 — no upper bound,
  // since import is pure-additive and there's no single "current packet" range).
  function validateRescheduleDate(newDate, today) {
    if (typeof newDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return { ok: false, message: "Pick a date." };
    }
    if (newDate < today) {
      return { ok: false, message: "Pick today or a later date." };
    }
    return { ok: true };
  }

  // Plaintext equality — matches the PIN captured at Startup Wizard (Module 1).
  function checkPin(enteredPin, storedPin) {
    return typeof enteredPin === "string" && enteredPin.length > 0 && enteredPin === storedPin;
  }

  // TDS §6: Reschedule writes only { deferredDate } — merged into the item's
  // existing plannerMeta record by the caller (DB.setMeta already does the
  // read-merge-write upsert, TDS_Slice_M1 §4), so sortOrder/blockHint survive.
  function buildReschedulePatch(newDate) {
    return { deferredDate: newDate };
  }

  // TDS §6: Waive — same store/shape as Module 4's completion, status 'waived',
  // never a grade (a waive is never a completion, and Chores never capture one).
  function buildWaiveRecord(activityId, today) {
    return { activityId: activityId, date: today, status: "waived", exported: false };
  }

  g.DefermentCore = {
    validateRescheduleDate: validateRescheduleDate,
    checkPin: checkPin,
    buildReschedulePatch: buildReschedulePatch,
    buildWaiveRecord: buildWaiveRecord
  };
})(typeof window !== "undefined" ? window : globalThis);
