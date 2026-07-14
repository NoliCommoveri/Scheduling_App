// deferment.js — Deferment / Waive (Module 5), wired to IndexedDB. TDS_Slice_M2 §6/§9.
// Mirrors completion.js's split: this file owns DB access, PIN check, and the
// cross-module trigger point; deferment-core.js owns the pure record/validation math.

(function (g) {
  "use strict";

  var C = g.DefermentCore;

  // TDS §9/§5: both Reschedule and Waive resolve the item's original date, so a
  // day rescued by either can still qualify for the streak's live path. Streak
  // (Module 7) is a later build phase; until it defines Streak.recheckToday,
  // this is a no-op — this module never has to change when Module 7 lands.
  // Always returns a promise so the caller doesn't resolve before the streak
  // recheck has actually finished (same reasoning as completion.js).
  function notifyStreak() {
    if (g.Streak && typeof g.Streak.recheckToday === "function") return g.Streak.recheckToday();
    return Promise.resolve();
  }

  // FR-1: PIN required before either operation, with no partial write on a
  // wrong PIN. Checked first, before any other validation or write.
  function withPin(enteredPin, fn) {
    return g.DB.getSingleton("child").then(function (child) {
      if (!C.checkPin(enteredPin, child && child.pin)) return { ok: false, pinError: true };
      return fn();
    });
  }

  // Eligible targets are required, not-yet-resolved items (SRS §5) — enforced
  // here as a defensive re-check, the same idempotency guard pattern as
  // completion.js, in case the UI's own filtering is ever bypassed.
  function reschedule(item, newDate, enteredPin) {
    return withPin(enteredPin, function () {
      return g.DB.get("activityRecords", item.id).then(function (existing) {
        if (existing) return { ok: false, alreadyResolved: true };
        var dateCheck = C.validateRescheduleDate(newDate, g.DateUtil.today());
        if (!dateCheck.ok) return { ok: false, dateError: dateCheck.message };
        return g.DB.setMeta(item.id, C.buildReschedulePatch(newDate))
          .then(notifyStreak)
          .then(function () { return { ok: true }; });
      });
    });
  }

  function waive(item, enteredPin) {
    return withPin(enteredPin, function () {
      return g.DB.get("activityRecords", item.id).then(function (existing) {
        if (existing) return { ok: false, alreadyResolved: true };
        var record = C.buildWaiveRecord(item.id, g.DateUtil.today());
        return g.DB.put("activityRecords", record)
          .then(notifyStreak)
          .then(function () { return { ok: true }; });
      });
    });
  }

  g.Deferment = { reschedule: reschedule, waive: waive };
})(typeof window !== "undefined" ? window : globalThis);
