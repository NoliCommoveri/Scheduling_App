// completed-core.js — PURE. Selection, sort and time-bucketing for the Done
// Today screen (TDS_Slice_Wall_Display_App.md §6.7). Mirrors the Child App's
// own Completed view selection, re-implemented per CLAUDE.md §I.A.
//
// Selection is exactly `chores-core.js`'s "on today, complete" set — the
// same rows that already feed the tile's `m` denominator (§5.2.1: "today's
// complete rows... kept... for the m denominator and for Undo"). Reusing
// `ChoresCore.onToday` rather than a second, completed_at-based day test is
// what makes the null-`completed_at` case (§6.7 — "renders as earlier today
// rather than being hidden") fall out for free: selection never looks at
// `completed_at` at all, only the render label does. Depends on
// `chores-core.js`, loaded first (index.html) — both are wall-app-internal,
// which §I.A permits; nothing here crosses an app boundary.

(function (g) {
  "use strict";

  // One row per chore completed "today" (§5.1.1's on-today rule), across all
  // active children, newest first. A row with no `completed_at` sorts to the
  // end and is labelled by the caller as "earlier today" rather than hidden.
  function doneToday(rows, today, childrenById) {
    childrenById = childrenById || {};
    var out = (rows || [])
      .filter(function (row) {
        return row.kind === "chore" && row.status === "complete" &&
          row.rescinded_at == null && g.ChoresCore.onToday(row, today);
      })
      .map(function (row) {
        var child = childrenById[row.child_id];
        return {
          id: row.id,
          title: row.title,
          childId: row.child_id,
          childName: child ? child.name : "",
          completedAt: row.completed_at != null ? row.completed_at : null,
        };
      });

    out.sort(function (a, b) {
      if (a.completedAt == null && b.completedAt == null) return 0;
      if (a.completedAt == null) return 1;  // unknown time sorts last
      if (b.completedAt == null) return -1;
      return b.completedAt - a.completedAt; // newest first
    });
    return out;
  }

  g.CompletedCore = { doneToday: doneToday };
})(typeof window !== "undefined" ? window : globalThis);
