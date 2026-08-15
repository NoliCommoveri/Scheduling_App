// school-core.js — PURE. Course grouping and the per-course completion
// rollup for a school block (§5, revised 2026-08-15 — a block is a span
// holding several member courses, not one block per course; §20).
//
// Reads activity rows (`kind: 'activity'`) already in `poll.js`'s state —
// the plan window already returns them and the wall was previously
// discarding them entirely (§5.3). "Resolved" mirrors the rest of the
// codebase's own rule for what counts as done (child-app/js/planner-core.js
// isResolved, management-app/js/export-core.js's FR-1): complete OR waived,
// never pending. Re-implemented, not shared, per CLAUDE.md §I.A.
//
// No file is shared with the Worker or the Management App.

(function (g) {
  "use strict";

  function isResolved(row) {
    return row.status === "complete" || row.status === "waived";
  }

  // §5.3 — every non-rescinded activity row for one child, one course, one
  // date. `total === 0` is the rare case §5.2 keeps out of the picker in the
  // first place: a course added to a block whose activities were later
  // rescinded to zero.
  function courseRollup(rows, childId, courseName, date) {
    var matching = (rows || []).filter(function (row) {
      return row.kind === "activity" && row.child_id === childId &&
        row.course_name === courseName && row.date === date && row.rescinded_at == null;
    });
    var total = matching.length;
    var resolved = matching.filter(isResolved).length;
    return {
      courseName: courseName,
      total: total,
      resolved: resolved,
      // null = neither checked nor unchecked — nothing to show that date.
      checked: total === 0 ? null : resolved === total,
    };
  }

  // One rollup per member course, in the block's own membership order.
  function memberRollups(rows, childId, date, courseNames) {
    return (courseNames || []).map(function (name) {
      return courseRollup(rows, childId, name, date);
    });
  }

  // §5.3 — collapses only when EVERY member is checked. A block with no
  // members, or whose members all have zero activities that day (checked
  // === null for every one of them), never collapses — an empty set is not
  // an achievement, and a null does not satisfy "checked".
  function isCollapsed(rollups) {
    return (rollups || []).length > 0 && rollups.every(function (r) { return r.checked === true; });
  }

  // §5.2's picker: that child's courses with at least one non-rescinded
  // activity on the rendered date. Alphabetical, for a stable list a family
  // can find a course in without it reordering itself.
  function coursesWithActivities(rows, childId, date) {
    var seen = Object.create(null);
    (rows || []).forEach(function (row) {
      if (row.kind === "activity" && row.child_id === childId && row.date === date &&
          row.rescinded_at == null && row.course_name) {
        seen[row.course_name] = true;
      }
    });
    return Object.keys(seen).sort();
  }

  g.SchoolCore = {
    courseRollup: courseRollup,
    memberRollups: memberRollups,
    isCollapsed: isCollapsed,
    coursesWithActivities: coursesWithActivities,
  };
})(typeof window !== "undefined" ? window : globalThis);
