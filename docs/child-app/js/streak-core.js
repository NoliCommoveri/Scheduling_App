// streak-core.js — pure logic for Streak (Module 7), TDS_Slice_M2 §5.
// No IndexedDB access here — same discipline as the other -core.js modules.

(function (g) {
  "use strict";

  var P = g.PlannerCore; // reuse effectiveDueDate — TDS §5 "reused from M1"

  // Required items (activities+chores) whose *effective* due date equals `date`.
  // An item rescheduled away from `date` has already moved its effective date
  // elsewhere, so it simply never appears here for its old date — this is what
  // makes reschedule-away count as resolved without a separate check (TDS §5).
  function requiredDueOn(activities, chores, meta, date) {
    return activities.concat(chores).filter(function (item) {
      return item.required === true && P.effectiveDueDate(item, meta) === date;
    });
  }

  // 'neutral' | 'resolved' | 'breaking' for a given device-local date.
  // resolved: a plain { activityId: true } lookup built from activityRecords.
  function dayStatus(activities, chores, meta, resolved, date) {
    var due = requiredDueOn(activities, chores, meta, date);
    if (due.length === 0) return "neutral";
    var allResolved = due.every(function (item) { return !!resolved[item.id]; });
    return allResolved ? "resolved" : "breaking";
  }

  g.StreakCore = { requiredDueOn: requiredDueOn, dayStatus: dayStatus };
})(typeof window !== "undefined" ? window : globalThis);
