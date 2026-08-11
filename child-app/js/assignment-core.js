// assignment-core.js — the §8.2 compatibility shim, as pure functions.
// TDS_Slice_Online_Revamp.md §3.3 (the shared row), §6.4 (visibility), §8.2.
//
// **Online Revamp §14, shim collapse — phase 1.** This file used to build a
// second object per assignment: it read a flat `assignments` row and emitted a
// packet-shaped record, plus a parallel `meta` map holding the child-owned
// values under different names. Every planning decision then had to consult two
// objects and a lookup to answer a question one row already answered.
//
// That half is gone. `decorate()` now *returns the row*, with camelCase aliases
// and the payload's promoted fields added alongside the columns — one object per
// assignment, carrying its own overrides. planner-core.js reads the columns
// directly (`deferred_to`, `child_sort_order`, `child_block_hint`) and no longer
// takes a `meta` argument at all.
//
// What is left of the shim, and what phase 2 deletes:
//   - the camelCase aliases below, which exist only because planner-ui.js is
//     written against the pre-revamp field names;
//   - `payload` handed back parsed and stripped, because planner-ui renders it;
//   - `toState`'s `activities` / `chores` / `events` / `meta` keys, which now
//     have exactly one consumer between them (streak.js reads the first two)
//     and are otherwise kept because CLAUDE.md §IV.B pins `DB.loadState()`'s
//     shape until the collapse finishes.
// Recording that here so a later session recognises it as scaffolding rather
// than design.
//
// Pure — no fetch, no IndexedDB, no DOM — so the mapping can be exercised
// directly against rows.

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
  // the row here, so they must not also be left in the payload object the
  // planner renders from.
  var PROMOTED = [
    "required", "capturesGrade", "difficultyTier", "lessonTitle", "instructions",
    "choreType", "notes", "time", "startDate", "endDate"
  ];

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
  function isPlannable(row) {
    return (row.status || "pending") === "pending" && row.rescinded_at == null;
  }

  // Set a field only when the value is present, never as an empty string:
  // several planner-ui branches key off presence (FR-8/FR-10/FR-12) and would
  // render an empty element for "".
  function setIf(obj, key, value) {
    if (value != null && value !== "") obj[key] = value;
  }

  // One assignment, one object: the row plus the names planner-ui still uses.
  // The row is copied, never mutated — the cached row keeps its raw `payload`.
  function decorate(row) {
    var p = parsePayload(row.payload);
    var item = Object.assign({}, row);

    // The payload the planner renders: parsed, minus everything promoted out of
    // it below. Replaces the raw JSON string on the copy only.
    item.payload = payloadOnly(p);

    // Promoted payload fields — these have no column, so they exist nowhere else.
    // §7: the earned amount is the one snapshotted on the row, so a later edit to
    // a tier never changes what was already earned. NULL today (packet.js has no
    // per-tier amount to snapshot), which completion-core reads as the flat 1 the
    // Child App has always used.
    setIf(item, "difficultyTier", p.difficultyTier);
    setIf(item, "lessonTitle", p.lessonTitle);
    setIf(item, "instructions", p.instructions);
    setIf(item, "choreType", p.choreType);
    setIf(item, "notes", p.notes);
    setIf(item, "time", p.time);

    if (row.kind === "chore") {
      // Chores are always required (packet.js pins it true); absent means true
      // rather than false, so an older row never loses its Reschedule/Waive
      // controls, which planner-ui gates on `required`.
      item.required = p.required !== false;
    } else if (row.kind === "activity") {
      item.required = !!p.required;
      item.capturesGrade = !!p.capturesGrade;
    } else if (row.kind === "event") {
      // An event is left without `required` deliberately: it has no completion
      // lifecycle, and StreakCore.requiredDueOn walks every row now rather than
      // a pre-filtered activities+chores pair.
      //
      // A multi-day event is committed as one row per in-range day, each
      // carrying the true span (packet.js assignmentFromEvent). The row's `date`
      // is one of those days, so the span has to come from the payload; the
      // per-day duplicates are collapsed by PlannerCore.eventKey.
      item.startDate = p.startDate || row.date;
      item.endDate = p.endDate || row.date;
    }

    // Column aliases — same value, pre-revamp name.
    item.rewardCategoryId = row.reward_category;
    if (row.reward_amount != null) item.rewardAmount = row.reward_amount;
    setIf(item, "activityType", row.activity_type);
    setIf(item, "courseName", row.course_name);
    if (row.sequence_no != null) item.sequenceNumber = row.sequence_no;
    if (row.expected_duration_min != null) item.expectedDurationMin = row.expected_duration_min;

    return item;
  }

  // `plannerMeta` is the store where this device's own overrides are written
  // ahead of the outbox uploading a copy, in the pre-revamp vocabulary. Each
  // field is the child-owned column it is on its way to becoming (§3.3), so the
  // overlay below writes it as that column rather than keeping a second name for
  // it alive through the planner. outbox-core.js holds the same translation in
  // the API's vocabulary (`deferredTo`, `childSortOrder`); both die with the
  // store, in the phase that folds plannerMeta into the columns (§8.1).
  var META_TO_COLUMN = {
    deferredDate: "deferred_to",
    blockHint: "child_block_hint",
    sortOrder: "child_sort_order"
  };

  // A pending override is by construction newer than the column it has not yet
  // been flushed to, so the local value wins field by field. Rows are copied,
  // never mutated: the cache still holds what the server last said.
  function applyLocalMeta(rows, local) {
    var byId = Object.create(null);
    (local || []).forEach(function (m) { if (m && m.id) byId[m.id] = m; });

    return (rows || []).map(function (row) {
      var m = byId[row && row.id];
      if (!m) return row;
      var merged = Object.assign({}, row);
      Object.keys(META_TO_COLUMN).forEach(function (field) {
        if (m[field] != null) merged[META_TO_COLUMN[field]] = m[field];
      });
      return merged;
    });
  }

  // §8.2's "meta synthesized from the child-owned columns". Returns null when
  // the row carries no child-side override, so the meta map stays sparse and any
  // remaining `meta[id] || null` lookup behaves as before.
  function metaFrom(row) {
    var m = null;
    if (row.deferred_to) (m = m || {}).deferredDate = row.deferred_to;
    if (row.child_block_hint) (m = m || {}).blockHint = row.child_block_hint;
    if (typeof row.child_sort_order === "number") (m = m || {}).sortOrder = row.child_sort_order;
    return m;
  }

  // rows: assignment rows as `/api/plan` returns them (snake_case, §3.3).
  // Returns { rows, activities, chores, events, meta } — `rows` is the decorated
  // set the planner now works from; the rest is the pre-revamp shape, kept per
  // the note at the head of this file.
  function toState(rows) {
    var out = [];
    var activities = [];
    var chores = [];
    var events = [];
    var meta = Object.create(null);

    (rows || []).forEach(function (row) {
      if (!row || !row.id || !isPlannable(row)) return;
      // An unknown kind is a newer parent build; ignore it rather than crash.
      if (row.kind !== "activity" && row.kind !== "chore" && row.kind !== "event") return;

      var item = decorate(row);
      out.push(item);

      if (row.kind === "activity") activities.push(item);
      else if (row.kind === "chore") chores.push(item);
      else events.push(item);

      // Events have no completion lifecycle and no child-owned columns.
      if (row.kind === "event") return;
      var m = metaFrom(row);
      if (m) { m.id = row.id; meta[row.id] = m; }
    });

    return { rows: out, activities: activities, chores: chores, events: events, meta: meta };
  }

  g.AssignmentCore = {
    toState: toState,
    decorate: decorate,
    applyLocalMeta: applyLocalMeta,
    isPlannable: isPlannable,
    parsePayload: parsePayload
  };
})(typeof window !== "undefined" ? window : globalThis);
