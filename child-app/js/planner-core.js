// planner-core.js — the Daily Planner's read-time derivation (Module 3).
// The Daily Plan is never persisted (Domain Model §3.4): every view here is
// assembled from stored rows + the effective date, on demand.
// Pure functions, so the ordering rules can be tested directly against rows.
//
// **Online Revamp §14, shim collapse — phase 1.** This file used to take the
// pre-revamp pair `(item, meta)`: an item carrying the parent's values and a
// separate `plannerMeta` map carrying the child's overrides, looked up by id on
// every comparison. Both halves now live on one `assignments` row as disjoint
// parent-owned and child-owned columns (§3.3), which is the whole point of the
// shared table — so the derivation reads them off the row and the `meta`
// parameter is gone.
//
// The three-way `{ activities, chores, events }` split is gone with it. A view
// takes the flat row array and selects on `kind`, because that is what the row
// actually carries; nothing upstream has to pre-sort rows into buckets to ask
// what is due today.
//
// Two fields read here are *not* columns, because §3.3 gives them none — they
// are promoted out of `payload` by assignment-core's decoration (§8.2):
//   - `required`    — drives the overdue roll-forward below.
//   - `startDate` / `endDate` — a family event's true span. The row's own `date`
//     is a single in-range day, so the span cannot come from the column.
// Phase 2 deleted the camelCase column aliases and these two stayed, which is
// the distinction they were named here to make: they are payload fields with no
// column, not second names for one.
//
// Everything else is read by its column name, including the one shape this file
// synthesizes — subjectsView's groups are keyed `course_name`, because the value
// is the column and inventing a second spelling for it is the thing §14 is
// removing.

(function (g) {
  "use strict";

  var CANON_BLOCKS = ["morning", "afternoon", "evening", "night"];
  var CANON_SET = { morning: 1, afternoon: 1, evening: 1, night: 1 };

  function canonicalBlock(v) { return v && CANON_SET[v] ? v : null; }

  function ofKind(rows, kind) {
    return (rows || []).filter(function (r) { return r.kind === kind; });
  }

  // Effective due date: the child's deferral when present, else the assigned
  // date. §6.5 — `date` is left intact by a deferment precisely so reporting can
  // still tell "assigned Monday" from "done Tuesday".
  function effectiveDueDate(row) {
    return row.deferred_to || row.date;
  }

  // Effective block: the child's override wins; else the parent's hint if
  // canonical; else morning (used identically for absent and out-of-set values).
  function effectiveBlock(row) {
    return canonicalBlock(row.child_block_hint) || canonicalBlock(row.block_hint) || "morning";
  }

  // Effective sort key: §3.3.3's COALESCE(child_sort_order, sort_order), read
  // from the child's side. Absent on both sides sorts as 0, so a row the parent
  // committed without an order still lands somewhere deterministic.
  function effectiveSortKey(row) {
    if (typeof row.child_sort_order === "number") return row.child_sort_order;
    return typeof row.sort_order === "number" ? row.sort_order : 0;
  }

  // Position sort within a block+category group: key ascending, id as tie-break.
  function byPosition() {
    return function (x, y) {
      var kx = effectiveSortKey(x), ky = effectiveSortKey(y);
      if (kx !== ky) return kx - ky;
      return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
    };
  }

  // Lesson-order sort within a course group: sequence_no ascending, id as tie-break.
  function bySequenceNo(x, y) {
    if (x.sequence_no !== y.sequence_no) return x.sequence_no - y.sequence_no;
    return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
  }

  // Child Feedback Loop §4.2 — School's three-pass sort, passes 2 and 3.
  // `items` is already restricted to one kind and one block. Groups by
  // course_name, in first-appearance order (same convention subjectsView
  // already uses); course-less items fall into one unlabeled group, forced
  // last so they never vanish from the list. Within a group, sorts by
  // sequence_no when every item in it has one, else falls back to position.
  function byCourseThenLesson(items) {
    var pos = byPosition();
    var groups = [];
    var index = Object.create(null);
    var noCourse = null;
    items.forEach(function (r) {
      var name = r.course_name;
      if (!name) {
        if (!noCourse) noCourse = { course_name: null, items: [] };
        noCourse.items.push(r);
        return;
      }
      if (!(name in index)) {
        index[name] = { course_name: name, items: [] };
        groups.push(index[name]);
      }
      index[name].items.push(r);
    });
    if (noCourse) groups.push(noCourse);

    var out = [];
    groups.forEach(function (grp) {
      var everySequenced = grp.items.every(function (r) { return typeof r.sequence_no === "number"; });
      grp.items.sort(everySequenced ? bySequenceNo : pos);
      out = out.concat(grp.items);
    });
    return out;
  }

  // Child Feedback Loop §4.3, decided — may the child hand-reorder this row?
  //
  // No, if it carries a `sequence_no`. That is parent-authored curriculum order
  // (Lesson 1, 2, 3…), and a child arrow fighting it is the wrong shape of
  // control. It is also the case where the arrow does not work: byCourseThenLesson
  // sorts a fully-sequenced course group with bySequenceNo, which ignores
  // child_sort_order outright — so before this rule the arrow wrote a value,
  // queued an outbox op, re-rendered, and moved nothing.
  //
  // Course-less and sequence_no-less rows keep their arrows: nothing
  // authoritative is being overridden, and their group still sorts by position.
  function canReorder(row) {
    return typeof row.sequence_no !== "number";
  }

  // Child Feedback Loop §4.3, decided — the rows a reorder may move `row` among.
  //
  // Before §4.2 the arrows ranged over whatever list the view had rendered:
  // a whole block+category group on Today, and every block at once in the
  // filter views. Course grouping made that actively wrong — an interpolated
  // key computed against a neighbour in a *different* course cannot move the
  // row there, because byCourseThenLesson groups before it sorts, so the write
  // either did nothing or landed the row somewhere unrelated inside its own
  // course.
  //
  // Peers are therefore the rows sharing this row's block *and* course, which
  // is exactly the set byCourseThenLesson sorts as a unit. Chores have no
  // course concept (§4.4), so for them it narrows to the block only — which
  // still fixes the cross-block reach the filter views always had.
  //
  // Returns { peers, index }; index is -1 if `row` is not in `list`.
  function reorderPeers(list, row) {
    var block = effectiveBlock(row);
    var byCourse = row.kind !== "chore";
    var course = row.course_name || null;
    var peers = (list || []).filter(function (r) {
      if (r.kind !== row.kind) return false;
      if (effectiveBlock(r) !== block) return false;
      return byCourse ? (r.course_name || null) === course : true;
    });
    return { peers: peers, index: peers.indexOf(row) };
  }

  // Is this actionable row on the Today list for `today`?
  //  - due today (effective date == today), or
  //  - overdue: still-pending, required, effective date before today (roll-forward).
  // isResolved is real as of Module 4/5 — a completed or waived row drops off.
  function onToday(row, today, isResolved) {
    if (isResolved(row.id)) return false;
    var due = effectiveDueDate(row);
    if (due === today) return true;
    return due < today && row.required === true; // overdue rollup (§2.1)
  }

  function eventTouches(row, today) {
    var start = row.startDate || row.date;
    var end = row.endDate || row.date;
    return start <= today && today <= end;
  }

  // A multi-day event is committed as one row per in-range day (§8.2), each
  // carrying the same span, so every one of those rows matches the same `today`.
  // Collapse them onto the proposal row they came from; `source_id` is the
  // parent's event id, and only falls back to the row id for a single-day event
  // committed without one.
  function eventKey(row) {
    return row.source_id || row.id;
  }

  function eventsOn(rows, today) {
    var seen = Object.create(null);
    return ofKind(rows, "event").filter(function (ev) {
      if (!eventTouches(ev, today)) return false;
      var key = eventKey(ev);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  // Assemble the Today view. rows = a flat array of assignment rows.
  // Returns { blocks:[{name, school:[], chores:[]}], events:[] } — empty blocks omitted.
  function assembleToday(rows, today, isResolved) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition();

    var due = function (r) { return onToday(r, today, isResolved); };
    var actionableA = ofKind(rows, "activity").filter(due);
    var actionableC = ofKind(rows, "chore").filter(due);

    var blocks = [];
    CANON_BLOCKS.forEach(function (blockName) {
      var inBlock = function (r) { return effectiveBlock(r) === blockName; };
      // School: block, then course, then lesson order (§4.2). Chores have no
      // course concept, so they keep the plain position sort.
      var school = byCourseThenLesson(actionableA.filter(inBlock));
      var chores = actionableC.filter(inBlock).sort(pos);
      if (school.length || chores.length) {
        blocks.push({ name: blockName, school: school, chores: chores });
      }
    });

    var events = eventsOn(rows, today)
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; });

    return { blocks: blocks, events: events };
  }

  // Flat, ordered list of one category from the Today set (School / Chores
  // filter views). Chores: block, then position — unchanged (§4.4, chores
  // have no course concept). School: block, then course, then lesson order
  // (§4.2) — each block's items run through byCourseThenLesson.
  function filterView(rows, today, isResolved, category) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition();
    var items = ofKind(rows, category === "chores" ? "chore" : "activity")
      .filter(function (r) { return onToday(r, today, isResolved); });

    if (category === "chores") {
      return items.sort(function (a, b) {
        var ba = CANON_BLOCKS.indexOf(effectiveBlock(a));
        var bb = CANON_BLOCKS.indexOf(effectiveBlock(b));
        if (ba !== bb) return ba - bb;
        return pos(a, b);
      });
    }

    var out = [];
    CANON_BLOCKS.forEach(function (blockName) {
      var inBlock = items.filter(function (r) { return effectiveBlock(r) === blockName; });
      if (inBlock.length) out = out.concat(byCourseThenLesson(inBlock));
    });
    return out;
  }

  function eventsView(rows, today) {
    return eventsOn(rows, today).sort(function (a, b) {
      var sa = a.startDate || a.date;
      var sb = b.startDate || b.date;
      return sa < sb ? -1 : 1;
    });
  }

  // Subjects view: School rows from the Today set, grouped by course.
  // Known, accepted limitation: grouping is by exact string, no normalization (§2.2).
  function subjectsView(rows, today, isResolved) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition();
    var groups = [];
    var index = Object.create(null);
    ofKind(rows, "activity")
      .filter(function (r) { return onToday(r, today, isResolved); })
      .forEach(function (r) {
        var name = r.course_name;
        if (!(name in index)) {
          index[name] = { course_name: name, items: [] };
          groups.push(index[name]);
        }
        index[name].items.push(r);
      });
    groups.forEach(function (grp) { grp.items.sort(pos); });
    return groups;
  }

  g.PlannerCore = {
    CANON_BLOCKS: CANON_BLOCKS,
    CANON_SET: CANON_SET,
    effectiveDueDate: effectiveDueDate,
    effectiveBlock: effectiveBlock,
    effectiveSortKey: effectiveSortKey,
    byPosition: byPosition,
    onToday: onToday,
    eventKey: eventKey,
    assembleToday: assembleToday,
    filterView: filterView,
    eventsView: eventsView,
    subjectsView: subjectsView,
    canReorder: canReorder,
    reorderPeers: reorderPeers
  };
})(typeof window !== "undefined" ? window : globalThis);
