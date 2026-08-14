// chores-core.js — PURE. The on-day rule and shared/claimed classification
// (TDS_Slice_Wall_Display_App.md §5.1.1, generalized past "today" by
// TDS_Slice_Wall_Calendar_Redesign.md §4.5). Mirrors `planner-core.js:48`
// (`effectiveDueDate`) and `:179` (`onToday`) — re-implemented, not shared,
// per CLAUDE.md §I.A.
//
// The wall's rule deliberately does NOT carry planner-core's `isResolved`
// early-exit: a completed row must still count as "on this day" so §8.4's
// done-in-place chip has a day to render on. Dropping the overdue
// *roll-forward* once a row is no longer `pending` is kept, though — a
// stale completed chore from a past due date must not go on counting itself
// forever. The bound that keeps this from actually being "forever" is the
// 7-day-back fetch window (poll.js): a row due more than a week ago simply
// isn't in `rows` any more.

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

  // §4.5 — generalized past "today": `date` is the day being rendered,
  // `today` is the actual current day. The overdue roll-forward only fires
  // when the two coincide — rendering a PAST day must show exactly what was
  // due that day, not everything still outstanding before it (otherwise
  // scrolling back through the week would show the same overdue chore on
  // every day at once), and rendering a future day never rolls anything
  // forward onto it either.
  function onDate(row, date, today) {
    var due = effectiveDueDate(row);
    if (due === date) return true;
    if (date !== today) return false;
    return due < date && isRequired(row) && row.status === "pending";
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

  // One child's chore rows on one rendered date — the day view's raw
  // material before slots-core.js splits it into placed vs. the unscheduled
  // tray (§3.4). Complete rows are included, not dropped: §8.4 keeps a
  // finished chore visible in its slot rather than removing it.
  function choresForChild(rows, childId, date, today) {
    return (rows || []).filter(function (row) {
      if (row.kind !== "chore" || row.child_id !== childId) return false;
      if (row.rescinded_at != null) return false;
      return onDate(row, date, today);
    });
  }

  g.ChoresCore = {
    effectiveDueDate: effectiveDueDate,
    isRequired: isRequired,
    onDate: onDate,
    claimState: claimState,
    choresForChild: choresForChild,
  };
})(typeof window !== "undefined" ? window : globalThis);
