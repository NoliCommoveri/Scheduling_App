// streak-core.js — pure logic for Streak (Module 7), TDS_Slice_M2 §5.
// No IndexedDB access here — same discipline as the other -core.js modules.

(function (g) {
  "use strict";

  var P = g.PlannerCore; // reuse effectiveDueDate — TDS §5 "reused from M1"

  // Required rows whose *effective* due date equals `date`. Events are skipped:
  // they carry no `required` flag and nothing about them can be resolved.
  //
  // A row rescheduled away from `date` has already moved its effective due date
  // elsewhere, so it simply never appears here for its old date — this is what
  // makes reschedule-away count as resolved without a separate check (TDS §5).
  //
  // Online Revamp §14, shim collapse — phase 1: the deferral is a column on the
  // row now (`deferred_to`), so the `meta` map this used to be handed is gone.
  function requiredDueOn(rows, date) {
    return (rows || []).filter(function (row) {
      return row.required === true && P.effectiveDueDate(row) === date;
    });
  }

  // 'neutral' | 'resolved' | 'breaking' for a given device-local date.
  // resolved: a plain { activityId: true } lookup built from activityRecords.
  function dayStatus(rows, resolved, date) {
    var due = requiredDueOn(rows, date);
    if (due.length === 0) return "neutral";
    var allResolved = due.every(function (item) { return !!resolved[item.id]; });
    return allResolved ? "resolved" : "breaking";
  }

  g.StreakCore = { requiredDueOn: requiredDueOn, dayStatus: dayStatus };
})(typeof window !== "undefined" ? window : globalThis);
