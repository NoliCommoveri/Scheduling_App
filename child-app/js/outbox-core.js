// outbox-core.js — pure logic for the Child App's write path.
// TDS_Slice_Online_Revamp.md §4.2 (column ownership), §5.5 (routes), §8.4.
//
// Phase 4 is the first phase in which this device sends anything. Everything a
// child produces — a completion, a waive, a reschedule, a block or order
// override, a reward entry, a streak — becomes an outbox row here and a request
// body below. No IndexedDB, no fetch, no DOM: same discipline as
// merge-core.js/assignment-core.js, so the shapes can be exercised directly.
//
// Two invariants this file exists to hold:
//
//   1. Only child-owned columns are ever sent. §4.2 has the Worker reject a
//      write to a parent-owned column with 400, and a rejected row would stall
//      the queue behind it. CHILD_FIELDS is this side of that contract.
//   2. Every id is minted before the first send attempt and reused on replay.
//      §5.5's idempotency is keyed on those ids: a reward entry's client-minted
//      primary key, and an assignment's server-minted id. Minting at send time
//      would turn one retry into two ledger rows.

(function (g) {
  "use strict";

  // The Worker's MAX_BATCH (§5.6). Anything larger is a 413.
  var MAX_BATCH = 500;

  // §3.3's child-owned columns, in the camelCase the Worker's
  // ASSIGNMENT_COMPLETION_FIELDS map accepts. Anything not in here is either
  // parent-owned or bookkeeping, and must never appear in a request body.
  var CHILD_FIELDS = [
    "status", "completedAt", "grade", "deferredTo", "childBlockHint", "childSortOrder"
  ];

  // plannerMeta is the pre-revamp local shape for the child's own overrides
  // (deferment-core's { deferredDate }, planner-ui's { blockHint, sortOrder }).
  // §3.3.3 gives each of the latter two its own column precisely so the
  // parent's intent and the child's adjustment never contend. This is the
  // rename between the two vocabularies, kept in one place so deferment.js and
  // planner-ui.js cannot drift apart on it.
  var META_TO_COLUMN = {
    deferredDate: "deferredTo",
    blockHint: "childBlockHint",
    sortOrder: "childSortOrder"
  };

  function completionFieldsFromMeta(patch) {
    var fields = {};
    Object.keys(patch || {}).forEach(function (key) {
      var column = META_TO_COLUMN[key];
      if (column) fields[column] = patch[key];
    });
    return fields;
  }

  // Drops anything outside CHILD_FIELDS and anything undefined. `null` is kept
  // deliberately: clearing a deferment is a real write of NULL, not an absence.
  function sanitizeFields(fields) {
    var out = {};
    Object.keys(fields || {}).forEach(function (key) {
      if (CHILD_FIELDS.indexOf(key) === -1) return;
      if (fields[key] === undefined) return;
      out[key] = fields[key];
    });
    return out;
  }

  function buildCompletionOp(assignmentId, fields, now) {
    var clean = sanitizeFields(fields);
    if (!assignmentId || Object.keys(clean).length === 0) return null;
    return { kind: "completion", assignmentId: assignmentId, fields: clean, queuedAt: now };
  }

  // `id` is the client-minted UUID that makes the append idempotent (§5.5).
  // The caller mints it so it lands in IndexedDB before the first send.
  function buildRewardOp(entry, now) {
    if (!entry || !entry.id || !entry.category) return null;
    if (typeof entry.amount !== "number" || !isFinite(entry.amount)) return null;
    return {
      kind: "reward",
      entry: {
        id: entry.id,
        assignmentId: entry.assignmentId || null,
        category: entry.category,
        amount: entry.amount,
        reason: ["earned", "adjustment", "spend"].indexOf(entry.reason) === -1 ? "earned" : entry.reason,
        earnedAt: typeof entry.earnedAt === "number" ? entry.earnedAt : now
      },
      queuedAt: now
    };
  }

  // §3.5's row. The local `streak` singleton is Module 7's shape
  // ({ currentStreak, lastQualifyingDate }); this is the server's.
  function buildStreakOp(streak, now) {
    if (!streak) return null;
    return {
      kind: "streak",
      streak: {
        currentStreak: Math.max(0, Math.trunc(streak.currentStreak || 0)),
        longestStreak: Math.max(0, Math.trunc(streak.longestStreak || streak.currentStreak || 0)),
        lastQualifiedDate: streak.lastQualifyingDate || streak.lastQualifiedDate || null
      },
      queuedAt: now
    };
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  // Turn drained rows into the smallest set of requests that carries them.
  //
  // Coalescing is what keeps a busy morning cheap: a kid who reorders their day
  // four times has queued four rows for one assignment, and the server only
  // needs the last value of each field. Rows are folded in queue order, so a
  // later write wins field-by-field — which is also why an earlier row's other
  // fields survive rather than being clobbered by the merge.
  //
  // Every request carries the `seqs` it consumed, so the drain deletes exactly
  // what a 2xx covered and a partial run leaves the rest queued.
  function plan(rows) {
    var ordered = (rows || []).slice().sort(function (a, b) { return a.seq - b.seq; });

    var completionOrder = [];
    var completions = Object.create(null);
    var rewardOrder = [];
    var rewards = Object.create(null);
    var streak = null;
    var streakSeqs = [];

    ordered.forEach(function (row) {
      if (row.kind === "completion") {
        var id = row.assignmentId;
        if (!completions[id]) { completions[id] = { id: id, fields: {}, seqs: [] }; completionOrder.push(id); }
        Object.assign(completions[id].fields, row.fields);
        completions[id].seqs.push(row.seq);
      } else if (row.kind === "reward") {
        // Deduplicated on the entry id, not merged: reward_entries is
        // append-only (§3.4) and two rows with the same id are the same append
        // queued twice, never two different amounts.
        var key = row.entry.id;
        if (!rewards[key]) { rewards[key] = { entry: row.entry, seqs: [] }; rewardOrder.push(key); }
        rewards[key].seqs.push(row.seq);
      } else if (row.kind === "streak") {
        // Last one wins: §3.5 is a single upserted row per child, so sending
        // an earlier count and then the current one is pure waste.
        streak = row.streak;
        streakSeqs.push(row.seq);
      }
    });

    var requests = [];

    // Completions first. A reward entry references an assignment_id, and
    // sending the completion that justifies it first keeps the two tables
    // telling the same story at every point a drain can be interrupted.
    chunk(completionOrder, MAX_BATCH).forEach(function (ids) {
      var seqs = [];
      var body = ids.map(function (id) {
        seqs = seqs.concat(completions[id].seqs);
        return Object.assign({ id: id }, completions[id].fields);
      });
      requests.push({ path: "/api/completions", method: "POST", body: { completions: body }, seqs: seqs });
    });

    chunk(rewardOrder, MAX_BATCH).forEach(function (keys) {
      var seqs = [];
      var body = keys.map(function (key) {
        seqs = seqs.concat(rewards[key].seqs);
        return rewards[key].entry;
      });
      requests.push({ path: "/api/rewards/entries", method: "POST", body: { entries: body }, seqs: seqs });
    });

    if (streak) {
      requests.push({ path: "/api/streak", method: "PUT", body: streak, seqs: streakSeqs });
    }

    return requests;
  }

  g.OutboxCore = {
    MAX_BATCH: MAX_BATCH,
    CHILD_FIELDS: CHILD_FIELDS,
    completionFieldsFromMeta: completionFieldsFromMeta,
    sanitizeFields: sanitizeFields,
    buildCompletionOp: buildCompletionOp,
    buildRewardOp: buildRewardOp,
    buildStreakOp: buildStreakOp,
    plan: plan
  };
})(typeof window !== "undefined" ? window : globalThis);
