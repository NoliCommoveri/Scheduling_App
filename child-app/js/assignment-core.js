// assignment-core.js — the §8.2 compatibility shim, as pure functions.
// TDS_Slice_Online_Revamp.md §3.3 (the shared row), §6.4 (visibility), §8.2.
//
// The online model stores one flat `assignments` row per thing to do. Every
// planner file in this app — planner-core.js, planner-ui.js, streak.js — is
// built on the pre-revamp shape instead: three arrays of packet-shaped records
// plus a plannerMeta map. This file turns the former into the latter.
//
// §8.2 is explicit that this is scaffolding with a stated lifespan: it exists so
// the largest file in the Child App does not have to be rewritten in the same
// change that replaces the data layer. Phase 5 collapses it. Recording that here
// so a later session recognises it as a shim rather than design.
//
// Pure — no fetch, no IndexedDB, no DOM — so the mapping can be exercised
// directly against rows, the same split as import-core/importer.

(function (g) {
  "use strict";

  // `payload` is a TEXT column holding JSON (§3.3). D1 hands it back as a
  // string; a caller that has already parsed it is accepted too.
  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // Fields the Management App tucks inside `payload` because §3.3 has no column
  // for them (packet.js's assignmentFrom* projections). They are promoted onto
  // the item here, so they must not also be left in the payload object the
  // planner renders from.
  var PROMOTED = ["required", "capturesGrade", "difficultyTier", "lessonTitle", "instructions"];

  function payloadOnly(p) {
    var out = {};
    Object.keys(p).forEach(function (k) {
      if (PROMOTED.indexOf(k) === -1) out[k] = p[k];
    });
    return out;
  }

  // §6.4's visibility rule, read from the child's side. An assignment is part of
  // the plan while it is still pending and not rescinded:
  //   - rescinded + pending  → the parent pulled it; it leaves planning.
  //   - rescinded + complete → the work was genuinely done. It stays off the
  //     plan (it is resolved) and its reward stands, per §6.3.
  //   - complete/waived      → resolved; the planner drops resolved items anyway.
  // Nothing writes the server-side status in Phase 3 — completions are local
  // until Phase 4 — but honouring it costs one comparison and makes the shim
  // correct the day the upload path lands.
  function isPlannable(row) {
    return (row.status || "pending") === "pending" && row.rescinded_at == null;
  }

  // `receiptIndex` is what planner-core falls back to when the child has set no
  // sortOrder of their own, so the parent's `sort_order` lands there. That is
  // the read half of §3.3.3's COALESCE(child_sort_order, sort_order) — the
  // child half arrives as plannerMeta, which planner-core already prefers.
  function receiptIndexOf(row) {
    return typeof row.sort_order === "number" ? row.sort_order : 0;
  }

  function activityFrom(row, p) {
    var item = {
      id: row.id,
      date: row.date,
      title: row.title,
      payload: payloadOnly(p),
      required: !!p.required,
      capturesGrade: !!p.capturesGrade,
      difficultyTier: p.difficultyTier,
      rewardCategoryId: row.reward_category,
      receiptIndex: receiptIndexOf(row)
    };
    // Optional fields are set only when present, never as empty strings: several
    // planner-ui branches key off presence (FR-8/FR-10/FR-12) and would render
    // an empty element for "".
    if (row.activity_type) item.activityType = row.activity_type;
    if (row.course_name) item.courseName = row.course_name;
    if (row.sequence_no != null) item.sequenceNumber = row.sequence_no;
    if (row.expected_duration_min != null) item.expectedDurationMin = row.expected_duration_min;
    if (row.block_hint) item.blockHint = row.block_hint;
    if (p.lessonTitle) item.lessonTitle = p.lessonTitle;
    if (p.instructions) item.instructions = p.instructions;
    return item;
  }

  function choreFrom(row, p) {
    var item = {
      id: row.id,
      date: row.date,
      title: row.title,
      choreType: p.choreType,
      difficultyTier: p.difficultyTier,
      // Chores are always required (packet.js pins it true); absent means true
      // rather than false, so an older row never loses its Reschedule/Waive
      // controls, which planner-ui gates on `required`.
      required: p.required !== false,
      rewardCategoryId: row.reward_category,
      receiptIndex: receiptIndexOf(row)
    };
    if (p.notes) item.notes = p.notes;
    if (row.block_hint) item.blockHint = row.block_hint;
    return item;
  }

  // A multi-day family event is committed as one row per in-range day, each
  // carrying the true span in its payload (packet.js assignmentFromEvent).
  // planner-core matches an event on startDate <= today <= endDate, so every one
  // of those rows would match the same day and the event would render once per
  // day of its span. Keyed on source_id and de-duplicated in toState() below,
  // one row is enough and the span survives intact.
  function eventFrom(row, p) {
    var item = {
      id: row.source_id || row.id,
      title: row.title,
      startDate: p.startDate || row.date,
      endDate: p.endDate || row.date
    };
    if (p.notes) item.notes = p.notes;
    if (p.time) item.time = p.time;
    return item;
  }

  // §8.2's "meta synthesized from the child-owned columns". Returns null when
  // the row carries no child-side override, so the meta map stays sparse and
  // planner-core's `meta[id] || null` lookups behave exactly as before.
  function metaFrom(row) {
    var m = null;
    if (row.deferred_to) (m = m || {}).deferredDate = row.deferred_to;
    if (row.child_block_hint) (m = m || {}).blockHint = row.child_block_hint;
    if (typeof row.child_sort_order === "number") (m = m || {}).sortOrder = row.child_sort_order;
    return m;
  }

  // rows: assignment rows as `/api/plan` returns them (snake_case, §3.3).
  // Returns the pre-revamp planner shape: { activities, chores, events, meta }.
  function toState(rows) {
    var activities = [];
    var chores = [];
    var events = [];
    var meta = Object.create(null);
    var seenEvents = Object.create(null);

    (rows || []).forEach(function (row) {
      if (!row || !row.id || !isPlannable(row)) return;
      var p = parsePayload(row.payload);

      if (row.kind === "event") {
        var ev = eventFrom(row, p);
        if (seenEvents[ev.id]) return;
        seenEvents[ev.id] = true;
        events.push(ev);
        return; // events have no completion lifecycle and no child-owned columns
      }

      if (row.kind === "activity") activities.push(activityFrom(row, p));
      else if (row.kind === "chore") chores.push(choreFrom(row, p));
      else return; // unknown kind — a newer parent build; ignore rather than crash

      var m = metaFrom(row);
      if (m) { m.id = row.id; meta[row.id] = m; }
    });

    return { activities: activities, chores: chores, events: events, meta: meta };
  }

  g.AssignmentCore = {
    toState: toState,
    isPlannable: isPlannable,
    parsePayload: parsePayload
  };
})(typeof window !== "undefined" ? window : globalThis);
