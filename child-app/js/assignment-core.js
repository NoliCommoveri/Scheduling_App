// assignment-core.js — decoration of an `assignments` row for the planner.
// TDS_Slice_Online_Revamp.md §3.3 (the shared row), §6.4 (visibility), §8.2.
//
// **Online Revamp §14, shim collapse — done here.**
//
// Phase 1 removed the second object. This file used to read a flat `assignments`
// row and emit a packet-shaped record, plus a parallel `meta` map holding the
// child-owned values under different names, so every planning decision consulted
// two objects and a lookup to answer a question one row already answered.
//
// Phase 2 removed the second *vocabulary*. `decorate()` used to add a camelCase
// alias for six columns — `courseName`, `sequenceNumber`, `activityType`,
// `rewardCategoryId`, `rewardAmount`, `expectedDurationMin` — and to overwrite
// the `payload` column with a parsed, stripped object, so a row answered to two
// names for one value and misreported one of its own columns. Its readers
// (planner-ui.js, completion.js) now read the columns §3.3 defines, and the
// aliases are gone.
//
// Phase 3 dropped `toState`'s `activities` / `chores` / `events` / `meta` keys
// along with the IndexedDB stores the first three mirrored. Nothing had read
// any of them since phase 2 — they were kept only because CLAUDE.md §IV.B
// pinned `DB.loadState()`'s shape until the store drop landed.
//
// What `decorate()` does is exactly one thing: **the row, plus the fields
// §3.3 gives no column.** Every one of those comes out of `payload`, which is
// where the Management App puts what has nowhere else to go (packet.js's
// assignmentFrom* projections):
//   - promoted scalars — `required`, `capturesGrade`, `difficultyTier`,
//     `lessonTitle`, `instructions`, `choreType`, `notes`, `time`;
//   - a family event's true `startDate` / `endDate` span;
//   - `content`, an activity's kind-specific descriptor (pageRange / reference /
//     freeText / none) — named for what it is rather than shadowing the column
//     it was parsed out of. The `payload` column itself is passed through
//     untouched, so the copy is still the row.
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
  // the row here, so they must not also be left in the `content` descriptor the
  // planner renders from.
  var PROMOTED = [
    "required", "capturesGrade", "difficultyTier", "lessonTitle", "instructions",
    "choreType", "notes", "time", "startDate", "endDate"
  ];

  // What is left of an activity's payload once the promoted fields are lifted
  // out: `{ kind, …kind-specific }` — the descriptor of what the work actually
  // is. Chores and events carry no such thing, so only the activity branch of
  // decorate() sets it.
  function contentOnly(p) {
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
  //
  // Shared Chores §6.3 adds one clause: a row a sibling has claimed is not
  // this device's to plan. Comparing against `selfChildId` rather than
  // testing `claimed_by != null` is deliberate — a winner's own row also
  // carries `claimed_by`, and the row-only rule would wrongly drop it. It
  // also covers the §5.4 window where a claim is held but the completion
  // has not landed yet: `status` is still `pending` there, so the identity
  // test is what keeps a held claim on the winner's own plan.
  function isPlannable(row, selfChildId) {
    if (row.claimed_by != null && row.claimed_by !== selfChildId) return false;
    return (row.status || "pending") === "pending" && row.rescinded_at == null;
  }

  // Set a promoted field only when the value is present, never as an empty
  // string: several planner-ui branches key off presence (FR-8/FR-9) and would
  // render an empty element for "". A column needs no such care — it is either
  // on the row or NULL, and both are falsy.
  function setIf(obj, key, value) {
    if (value != null && value !== "") obj[key] = value;
  }

  // One assignment, one object: the row, plus the fields §3.3 gives no column.
  // The row is copied, never mutated, and every column on the copy — `payload`
  // included — is still the column.
  function decorate(row) {
    var p = parsePayload(row.payload);
    var item = Object.assign({}, row);

    // Promoted payload fields — these have no column, so they exist nowhere else.
    // `difficultyTier` is carried rather than read: nothing renders it today, but
    // it has to come out of `content` either way, and it is what a per-tier
    // reward amount (§14) would be looked up by.
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
      // What the work is, as packet.js's projectPayload wrote it. Only an
      // activity has one — a chore is its title and a chore type, an event is
      // its title and a span.
      item.content = contentOnly(p);
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

    return item;
  }

  // rows: assignment rows as `/api/plan` returns them (snake_case, §3.3).
  // selfChildId: this device's own child id (Shared Chores §6.3), threaded
  // into isPlannable so a sibling's claimed row never reaches the planner.
  // Returns { rows } — the decorated, plannable set the planner works from.
  function toState(rows, selfChildId) {
    var out = [];

    (rows || []).forEach(function (row) {
      if (!row || !row.id || !isPlannable(row, selfChildId)) return;
      // An unknown kind is a newer parent build; ignore it rather than crash.
      if (row.kind !== "activity" && row.kind !== "chore" && row.kind !== "event") return;

      out.push(decorate(row));
    });

    return { rows: out };
  }

  // Every cached row, decorated, indexed by id — with **no visibility filter**.
  //
  // `toState` answers one question: what is still part of the plan. §6.4 says a
  // resolved or rescinded row is not, so it drops one, and every planner view
  // is built on that. But two surfaces join a *record* back to the assignment it
  // resolved — the Completed view (Child Feedback Loop §3.2) and the CSV export
  // — and for those, "the row has left the plan" is the normal case, not a
  // reason to skip it. Joining either against `toState`'s output means the row
  // is present only until the completion reaches the server and comes back down
  // as `status: 'complete'`, at which point the join silently finds nothing.
  //
  // A caller here already holds a record naming the row, so it is not asking
  // whether the row is plannable; it is asking what the row said.
  function decorateById(rows) {
    var byId = Object.create(null);
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      // Same guard as toState — an unknown kind is a newer parent build, and
      // decorate() would hand back a row no renderer here knows how to draw.
      if (row.kind !== "activity" && row.kind !== "chore" && row.kind !== "event") return;
      byId[row.id] = decorate(row);
    });
    return byId;
  }

  g.AssignmentCore = {
    toState: toState,
    decorateById: decorateById,
    decorate: decorate,
    isPlannable: isPlannable,
    parsePayload: parsePayload
  };
})(typeof window !== "undefined" ? window : globalThis);
