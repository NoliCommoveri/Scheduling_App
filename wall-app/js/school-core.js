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

  // §16 Phase 8 (week view) — the School sheet's per-course breakdown.
  // Distinct from courseRollup (§5.3's checked/resolved rollup): this counts
  // by `activity_type` label (the same denormalized text packet.js:522
  // snapshots), not by completion. Order follows first appearance in `rows`
  // — the week view's own spec says order doesn't matter here.
  function activityTypeCounts(rows, childId, courseName, date) {
    var counts = Object.create(null);
    var order = [];
    (rows || []).forEach(function (row) {
      if (row.kind !== "activity" || row.child_id !== childId || row.course_name !== courseName ||
          row.date !== date || row.rescinded_at != null) return;
      var type = row.activity_type || "Other";
      if (!(type in counts)) { counts[type] = 0; order.push(type); }
      counts[type] += 1;
    });
    return order.map(function (type) { return { type: type, count: counts[type] }; });
  }

  // One entry per course with activities that date, each carrying its type
  // breakdown — what the School sheet renders once a child is picked.
  function coursesWithTypeCounts(rows, childId, date) {
    return coursesWithActivities(rows, childId, date).map(function (courseName) {
      return { courseName: courseName, typeCounts: activityTypeCounts(rows, childId, courseName, date) };
    });
  }

  // ==========================================================================
  // Placement Scopes §2.2/§2.2.1 (Phase 3) — a block's PLACEMENT, beside the
  // completion rollups above. Everything below answers "does this block
  // happen on this date, and when", and nothing below reads an activity row.
  //
  // The chore side's chain (slots-core.js) and this one look alike and are
  // NOT the same: a chore's weekday row answers only *when*, because a
  // chore's existence is the assignment row's fact. A block has no assignment
  // row, so its weekday list carries EXISTENCE as well as time — the weekday
  // list IS the schedule, which is what stops a block rendering on Saturday
  // (§0.1). Mirroring is not sharing (CLAUDE.md §I.A); this file states its
  // own rules.
  // ==========================================================================

  var NUL = "\u0000"; // same reasoning as slots-core.js's: never inside a real id

  function blockWeekdayKey(blockId, weekday) { return blockId + NUL + weekday; }
  function blockDateKey(blockId, date) { return blockId + NUL + date; }

  // `GET /api/wall/school-blocks`'s `blockWeekdays` / `blockDates` arrays,
  // indexed for O(1) lookup per block per rendered date.
  function indexBlockWeekdays(rows) {
    var idx = Object.create(null);
    (rows || []).forEach(function (r) { idx[blockWeekdayKey(r.block_id, r.weekday)] = r; });
    return idx;
  }

  function indexBlockDates(rows) {
    var idx = Object.create(null);
    (rows || []).forEach(function (r) { idx[blockDateKey(r.block_id, r.date)] = r; });
    return idx;
  }

  function weekdayRowFor(weekdaysIndex, blockId, weekday) {
    return weekdaysIndex[blockWeekdayKey(blockId, weekday)] || null;
  }

  // §2.2.1 — the row that decides one date outright, if there is one. Exposed
  // on its own because §6.2's sheet needs to show the exception as a banner,
  // not merely obey it.
  function dateExceptionFor(datesIndex, blockId, date) {
    return datesIndex[blockDateKey(blockId, date)] || null;
  }

  // §2.2/§2.2.1 — does this block happen on this date?
  //
  // THE PRECEDENCE IS THE POINT, and it runs date-first. A date row decides
  // its own date in BOTH directions: `occurs = 0` skips a scheduled day (a
  // field trip), `occurs = 1` adds an unscheduled one (Ray's backup Sunday).
  // Only when no date row exists does the weekday list decide. Getting this
  // backwards would make a skip appear to work on scheduled days and fail
  // silently on backup ones — the subtle direction — which is why §8 pins
  // both directions separately (tests 5 and 5a).
  //
  // `weekday` is the NUMBER, derived once per render by TimeCore.weekdayOf;
  // this file never converts a date itself (§2.3).
  //
  // A block with no weekday rows at all happens on NO day. That is the whole
  // of §0.1's fix, and it is why `POST /api/wall/school-blocks` applies the
  // Mon-Fri default server-side (worker §4.2) — otherwise creating a block
  // would mint an invisible one.
  function blockOccursOn(weekdaysIndex, datesIndex, blockId, date, weekday) {
    var dateRow = dateExceptionFor(datesIndex, blockId, date);
    if (dateRow) return dateRow.occurs === 1;
    return !!weekdayRowFor(weekdaysIndex, blockId, weekday);
  }

  // §2.2 — the span to draw, resolved as a PAIR at every level: a level
  // either supplies both ends or neither. `start_min`/`end_min` are two ends
  // of one span, not two independent facts the way a chore's start and
  // duration are, so mixing halves across levels (which could compose
  // `end <= start`) is unrepresentable rather than merely validated against.
  //
  // `scope` is 'date' | 'weekday' | 'block'. Deliberately not the chore
  // side's 'day'/'weekday'/'standing': a block's base level is the block row
  // itself rather than a placement row, and §2.2.1 calls the exception level
  // "the date row". Two vocabularies for two tables, named after what they
  // actually are.
  //
  // Note what falls out for a backup Sunday with no span of its own: there is
  // no weekday row for Sunday to read, so it takes the BLOCK's span. Pinned
  // by test 5a, because it is the case a reader assumes must be special.
  function hasSpan(row) {
    return !!(row && row.start_min != null && row.end_min != null);
  }

  function resolveBlockSpan(block, weekdayRow, dateRow) {
    if (hasSpan(dateRow)) return { startMin: dateRow.start_min, endMin: dateRow.end_min, scope: "date" };
    if (hasSpan(weekdayRow)) return { startMin: weekdayRow.start_min, endMin: weekdayRow.end_min, scope: "weekday" };
    return { startMin: block.start_min, endMin: block.end_min, scope: "block" };
  }

  // §6.2's checklist: which weekdays this block is scheduled on, ascending.
  // Sunday-first numbering throughout, so the number is the column.
  function scheduledWeekdays(weekdaysIndex, blockId) {
    var out = [];
    for (var w = 0; w <= 6; w++) {
      if (weekdayRowFor(weekdaysIndex, blockId, w)) out.push(w);
    }
    return out;
  }

  // The whole placement read for one block on one date, in one call — what
  // day-ui.js's blocksForChildOn/blockEntry need and the only shape that
  // guarantees the span comes from the same two rows the occurrence did.
  function resolvePlacement(weekdaysIndex, datesIndex, block, date, weekday) {
    var dateRow = dateExceptionFor(datesIndex, block.id, date);
    var weekdayRow = weekdayRowFor(weekdaysIndex, block.id, weekday);
    var occurs = dateRow ? dateRow.occurs === 1 : !!weekdayRow;
    var span = resolveBlockSpan(block, weekdayRow, dateRow);
    return { occurs: occurs, startMin: span.startMin, endMin: span.endMin, spanScope: span.scope };
  }

  // §5.3 — the rollups a renderer should actually draw. A member whose
  // activities are absent that date has `checked: null` and, per §5.2,
  // "simply disappears from that block's row list on the next render" — it
  // has nothing to show. The renderer used to draw an <li> for it anyway,
  // a phantom course with no count; filtering here rather than at the render
  // boundary keeps it testable (§8, test 10), since the renderer is not pure.
  //
  // A block whose members ALL have nothing that day then correctly reads as
  // the empty "No courses yet" shell. That case matters more now than it did:
  // §2.2 means a block only renders on a scheduled day at all, so an empty
  // shell should look deliberate rather than broken.
  function renderableRollups(rollups) {
    return (rollups || []).filter(function (r) { return r.checked !== null; });
  }

  g.SchoolCore = {
    courseRollup: courseRollup,
    memberRollups: memberRollups,
    isCollapsed: isCollapsed,
    coursesWithActivities: coursesWithActivities,
    activityTypeCounts: activityTypeCounts,
    coursesWithTypeCounts: coursesWithTypeCounts,
    indexBlockWeekdays: indexBlockWeekdays,
    indexBlockDates: indexBlockDates,
    weekdayRowFor: weekdayRowFor,
    dateExceptionFor: dateExceptionFor,
    blockOccursOn: blockOccursOn,
    resolveBlockSpan: resolveBlockSpan,
    scheduledWeekdays: scheduledWeekdays,
    resolvePlacement: resolvePlacement,
    renderableRollups: renderableRollups,
  };
})(typeof window !== "undefined" ? window : globalThis);
