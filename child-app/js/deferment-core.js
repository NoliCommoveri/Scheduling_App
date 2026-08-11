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

  // TDS §6: Reschedule writes only `deferred_to` — merged onto the item's
  // cached `assignments` row by the caller (DB.setAssignmentFields does the
  // read-merge-write, Online Revamp §14), so child_block_hint/child_sort_order
  // survive untouched.
  function buildReschedulePatch(newDate) {
    return { deferred_to: newDate };
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
