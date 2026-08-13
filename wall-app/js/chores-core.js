// chores-core.js — PURE. The on-today rule, tile counts, and shared/claimed
// classification (TDS_Slice_Wall_Display_App.md §5.1.1). Mirrors
// `planner-core.js:48` (`effectiveDueDate`) and `:154` (`onToday`) —
// re-implemented, not shared, per CLAUDE.md §I.A.
//
// The wall's `onToday` deliberately does NOT carry planner-core's
// `isResolved` early-exit: §5.1's table needs `status='complete'` rows to
// still count as "on today" (they're the `m` denominator and the undoable
// set), where the child app's own Today list drops a resolved row instantly,
// on any date. Dropping the overdue *roll-forward* once a row is no longer
// `pending` is kept, though — a stale completed chore from a past due date
// must not go on counting itself forever. The bound that keeps this from
// actually being "forever" is the 7-day-back fetch window (§5.1.1): a row
// due more than a week ago simply isn't in `rows` any more.

(function (g) {
  "use strict";

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // planner-core.js:48 — the child's deferral wins when present.
  function effectiveDueDate(row) {
    return row.deferred_to || row.date;
  }

  // Chores are always required (packet.js pins it true; assignment-core.js's
  // decorate() reads the same payload flag with the same `!== false`
  // fallback so an older row missing the key still rolls forward).
  function isRequired(row) {
    return parsePayload(row.payload).required !== false;
  }

  // planner-core.js:154, minus the isResolved gate (see file header). Due
  // today, whatever status — or still pending and overdue.
  function onToday(row, today) {
    var due = effectiveDueDate(row);
    if (due === today) return true;
    return due < today && isRequired(row) && row.status === "pending";
  }

  // Rendering class for a chore row in this child's list (§5.1, last
  // paragraph). A shared chore already claimed by a sibling is visible but
  // not tappable — never hidden, which is the one place this file does NOT
  // mirror the child app's `isPlannable` (assignment-core.js:85-88), which
  // hides such a row outright. The wall shows it on purpose.
  function claimState(row, childId) {
    if (row.claimed_by == null) return "open";
    return row.claimed_by === childId ? "mine" : "claimed-by-sibling";
  }

  // Today's chores for one child: the pending list (chore list order —
  // Phase 4a) and the `n of m` tile count. `n` = still pending; `m` = n plus
  // however many are already done today.
  function todayForChild(rows, childId, today) {
    var pending = [];
    var completeCount = 0;
    (rows || []).forEach(function (row) {
      if (row.kind !== "chore" || row.child_id !== childId) return;
      if (row.rescinded_at != null) return;
      if (!onToday(row, today)) return;
      if (row.status === "complete") { completeCount++; return; }
      if (row.status !== "pending") return; // any other status — not counted either side
      pending.push(row);
    });
    return { pending: pending, n: pending.length, m: pending.length + completeCount };
  }

  g.ChoresCore = {
    effectiveDueDate: effectiveDueDate,
    isRequired: isRequired,
    onToday: onToday,
    claimState: claimState,
    todayForChild: todayForChild,
  };
})(typeof window !== "undefined" ? window : globalThis);
