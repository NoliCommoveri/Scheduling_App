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
// They are named here so a later session collapsing the rest of the shim knows
// these two do not simply fall out when the camelCase aliases go.

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
      var school = actionableA.filter(inBlock).sort(pos);
      var chores = actionableC.filter(inBlock).sort(pos);
      if (school.length || chores.length) {
        blocks.push({ name: blockName, school: school, chores: chores });
      }
    });

    var events = eventsOn(rows, today)
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; });

    return { blocks: blocks, events: events };
  }

  // Flat, position-ordered list of one category from the Today set (School / Chores filter views).
  function filterView(rows, today, isResolved, category) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition();
    return ofKind(rows, category === "chores" ? "chore" : "activity")
      .filter(function (r) { return onToday(r, today, isResolved); })
      .sort(function (a, b) {
        var ba = CANON_BLOCKS.indexOf(effectiveBlock(a));
        var bb = CANON_BLOCKS.indexOf(effectiveBlock(b));
        if (ba !== bb) return ba - bb;
        return pos(a, b);
      });
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
          index[name] = { courseName: name, items: [] };
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
    subjectsView: subjectsView
  };
})(typeof window !== "undefined" ? window : globalThis);
