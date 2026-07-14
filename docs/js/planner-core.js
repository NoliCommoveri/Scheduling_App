// planner-core.js — the Daily Planner's read-time derivation (Module 3).
// The Daily Plan is never persisted (Domain Model §3.4): every view here is
// assembled from stored records + plannerMeta + the effective date, on demand.
// Pure functions, so the ordering rules can be tested directly against fixtures.

(function (g) {
  "use strict";

  var CANON_BLOCKS = ["morning", "afternoon", "evening", "night"];
  var CANON_SET = { morning: 1, afternoon: 1, evening: 1, night: 1 };

  function metaFor(meta, id) { return meta[id] || null; }

  // Effective due date: deferred date when present, else the received date.
  // (Nothing writes deferredDate until M2, but the read-side resolution is here now.)
  function effectiveDueDate(item, meta) {
    var m = metaFor(meta, item.id);
    return (m && m.deferredDate) || item.date;
  }

  // Effective block: child override wins; else the packet blockHint if canonical;
  // else morning (used identically for absent and out-of-set values).
  function effectiveBlock(item, meta) {
    var m = metaFor(meta, item.id);
    if (m && m.blockHint && CANON_SET[m.blockHint]) return m.blockHint;
    if (item.blockHint && CANON_SET[item.blockHint]) return item.blockHint;
    return "morning";
  }

  // Effective sort key: child sortOrder when set, else receipt order.
  function effectiveSortKey(item, meta) {
    var m = metaFor(meta, item.id);
    if (m && typeof m.sortOrder === "number") return m.sortOrder;
    return typeof item.receiptIndex === "number" ? item.receiptIndex : 0;
  }

  // Position sort within a block+category group: key ascending, id as tie-break.
  function byPosition(meta) {
    return function (x, y) {
      var kx = effectiveSortKey(x, meta), ky = effectiveSortKey(y, meta);
      if (kx !== ky) return kx - ky;
      return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
    };
  }

  // Is this actionable item on the Today list for `today`?
  //  - due today (effective date == today), or
  //  - overdue: still-pending, required, effective date before today (roll-forward).
  // isResolved is real as of Module 4/5 — a completed or waived item drops off.
  function onToday(item, meta, today, isResolved) {
    if (isResolved(item.id)) return false;
    var due = effectiveDueDate(item, meta);
    if (due === today) return true;
    return due < today && item.required === true; // overdue rollup (§2.1)
  }

  function eventTouches(ev, today) {
    return ev.startDate <= today && today <= ev.endDate;
  }

  // Assemble the Today view. state = { activities, chores, events } as arrays.
  // Returns { blocks:[{name, school:[], chores:[]}], events:[] } — empty blocks omitted.
  function assembleToday(state, meta, today, isResolved) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition(meta);

    var actionableA = state.activities.filter(function (a) { return onToday(a, meta, today, isResolved); });
    var actionableC = state.chores.filter(function (c) { return onToday(c, meta, today, isResolved); });

    var blocks = [];
    CANON_BLOCKS.forEach(function (blockName) {
      var school = actionableA
        .filter(function (a) { return effectiveBlock(a, meta) === blockName; })
        .sort(pos);
      var chores = actionableC
        .filter(function (c) { return effectiveBlock(c, meta) === blockName; })
        .sort(pos);
      if (school.length || chores.length) {
        blocks.push({ name: blockName, school: school, chores: chores });
      }
    });

    var events = state.events
      .filter(function (e) { return eventTouches(e, today); })
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; });

    return { blocks: blocks, events: events };
  }

  // Flat, position-ordered list of one category from the Today set (School / Chores filter views).
  function filterView(state, meta, today, isResolved, category) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition(meta);
    var src = category === "chores" ? state.chores : state.activities;
    return src
      .filter(function (i) { return onToday(i, meta, today, isResolved); })
      .sort(function (a, b) {
        var ba = CANON_BLOCKS.indexOf(effectiveBlock(a, meta));
        var bb = CANON_BLOCKS.indexOf(effectiveBlock(b, meta));
        if (ba !== bb) return ba - bb;
        return pos(a, b);
      });
  }

  function eventsView(state, today) {
    return state.events.filter(function (e) { return eventTouches(e, today); })
      .sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
  }

  // Subjects view: School activities from the Today set, grouped by courseName.
  // Known, accepted limitation: grouping is by exact string, no normalization (§2.2).
  function subjectsView(state, meta, today, isResolved) {
    isResolved = isResolved || function () { return false; };
    var pos = byPosition(meta);
    var groups = [];
    var index = Object.create(null);
    state.activities
      .filter(function (a) { return onToday(a, meta, today, isResolved); })
      .forEach(function (a) {
        if (!(a.courseName in index)) {
          index[a.courseName] = { courseName: a.courseName, items: [] };
          groups.push(index[a.courseName]);
        }
        index[a.courseName].items.push(a);
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
    assembleToday: assembleToday,
    filterView: filterView,
    eventsView: eventsView,
    subjectsView: subjectsView
  };
})(typeof window !== "undefined" ? window : globalThis);


