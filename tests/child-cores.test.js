// Tests for the Child App's pure cores.
//
// These files were deliberately written with no fetch, no IndexedDB and no DOM
// "so the shapes can be exercised directly" — this is the thing that exercises
// them. They are plain scripts that attach to the global object, not modules, so
// they are evaluated into this context rather than imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// completion-core.js first: reward-core.js and settings-core.js build their
// ledger entries through CompletionCore.buildEntry, the same order the app
// shell loads them in.
// planner-core.js before streak-core.js: streak-core binds `g.PlannerCore` at
// load time, the same order the app shell loads them in.
const repo = new URL('../', import.meta.url);
for (const file of [
  'outbox-core.js', 'planner-core.js', 'assignment-core.js', 'streak-core.js',
  'completion-core.js', 'reward-core.js', 'settings-core.js', 'grading-core.js',
]) {
  vm.runInThisContext(readFileSync(new URL(`child-app/js/${file}`, repo), 'utf8'), { filename: file });
}
const {
  OutboxCore, PlannerCore, AssignmentCore, StreakCore,
  CompletionCore, RewardCore, SettingsCore, GradingCore,
} = globalThis;

// A row as /api/plan returns it (§3.3, snake_case).
function row(overrides = {}) {
  return {
    id: 'a1', child_id: 'CH-1', date: '2026-08-11', kind: 'activity', batch_id: 'b1',
    source_id: 'ACT-1', title: 'Read chapter 4', course_name: 'History',
    activity_type: 'Reading', payload: null,
    expected_duration_min: 20, reward_amount: null, reward_category: 'RC-1',
    block_hint: 'Morning', sort_order: 3, rescinded_at: null,
    status: 'pending', completed_at: null, grade: null, deferred_to: null,
    child_block_hint: null, child_sort_order: null,
    assigned_at: 1, updated_at: 1, updated_by: 'parent',
    ...overrides,
  };
}

// ===========================================================  outbox-core

test('sanitizeFields keeps only child-owned columns', () => {
  // §4.2: the Worker rejects a write to a parent-owned column. This is the
  // client half of that contract — a rejected row would be a lost write.
  const out = OutboxCore.sanitizeFields({
    status: 'complete', grade: 90, childSortOrder: 2,
    title: 'hacked', rewardAmount: 999, rescinded_at: 1,
  });
  assert.deepEqual(out, { status: 'complete', grade: 90, childSortOrder: 2 });
});

test('sanitizeFields keeps completionNote (Child Feedback Loop §5.3)', () => {
  const out = OutboxCore.sanitizeFields({ completionNote: 'skipped #11', title: 'hacked' });
  assert.deepEqual(out, { completionNote: 'skipped #11' });
});

test('sanitizeFields drops undefined but keeps null', () => {
  // Clearing a deferment is a real write of NULL, not an absence.
  const out = OutboxCore.sanitizeFields({ deferredTo: null, grade: undefined, status: 'complete' });
  assert.deepEqual(out, { deferredTo: null, status: 'complete' });
});

test('completionFieldsFromOverride renames a planner-column patch to the wire vocabulary', () => {
  // §14: plannerMeta is folded away, so the patch a caller writes onto the
  // cached row is already in column vocabulary — this only has to rename it
  // for the request body, not translate a third, pre-revamp shape.
  assert.deepEqual(
    OutboxCore.completionFieldsFromOverride({ deferred_to: '2026-08-14', child_block_hint: 'Afternoon', child_sort_order: 5 }),
    { deferredTo: '2026-08-14', childBlockHint: 'Afternoon', childSortOrder: 5 }
  );
  assert.deepEqual(OutboxCore.completionFieldsFromOverride({ unknownKey: 1 }), {});
});

test('columnsFromCompletionFields is completionFieldsFromOverride in reverse', () => {
  // db.js's applyPlan uses this to reapply a still-queued local write onto an
  // incoming /api/plan row, so it must exactly undo the outgoing rename.
  const fields = { deferredTo: '2026-08-14', childBlockHint: 'night', childSortOrder: 5, status: 'complete' };
  assert.deepEqual(
    OutboxCore.columnsFromCompletionFields(fields),
    { deferred_to: '2026-08-14', child_block_hint: 'night', child_sort_order: 5 }
  );
  // status/completedAt/grade are not planner columns on the cached row —
  // completion state lives in activityRecords — so they must not come back.
  assert.ok(!('status' in OutboxCore.columnsFromCompletionFields(fields)));
});

test('columnsFromCompletionFields drops an explicit undefined', () => {
  assert.deepEqual(OutboxCore.columnsFromCompletionFields({ deferredTo: undefined }), {});
});

test('buildCompletionOp refuses an op with nothing writable in it', () => {
  assert.equal(OutboxCore.buildCompletionOp('a1', { title: 'nope' }, 1), null);
  assert.equal(OutboxCore.buildCompletionOp('', { status: 'complete' }, 1), null);
  assert.deepEqual(OutboxCore.buildCompletionOp('a1', { status: 'complete' }, 7), {
    kind: 'completion', assignmentId: 'a1', fields: { status: 'complete' }, queuedAt: 7,
  });
});

test('buildRewardOp requires an id, a category and a finite amount', () => {
  assert.equal(OutboxCore.buildRewardOp({ category: 'RC-1', amount: 1 }, 1), null);
  assert.equal(OutboxCore.buildRewardOp({ id: 'r1', amount: 1 }, 1), null);
  assert.equal(OutboxCore.buildRewardOp({ id: 'r1', category: 'RC-1', amount: NaN }, 1), null);
  const op = OutboxCore.buildRewardOp({ id: 'r1', category: 'RC-1', amount: 1, reason: 'nonsense' }, 9);
  assert.equal(op.entry.reason, 'earned', 'an unknown reason falls back to earned');
  assert.equal(op.entry.earnedAt, 9);
});

test('plan coalesces repeated completions field-by-field, last write winning', () => {
  // A kid who reorders their day four times has queued four rows for one
  // assignment; the server only needs the last value of each field.
  const requests = OutboxCore.plan([
    { seq: 1, kind: 'completion', assignmentId: 'a1', fields: { childSortOrder: 1 } },
    { seq: 2, kind: 'completion', assignmentId: 'a1', fields: { childSortOrder: 2 } },
    { seq: 3, kind: 'completion', assignmentId: 'a1', fields: { status: 'complete' } },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.completions, [{ id: 'a1', childSortOrder: 2, status: 'complete' }]);
  assert.deepEqual(requests[0].seqs, [1, 2, 3], 'every consumed seq must be reported');
});

test('plan orders completions ahead of the reward entries that reference them', () => {
  const requests = OutboxCore.plan([
    { seq: 2, kind: 'reward', entry: { id: 'r1', category: 'RC-1', amount: 1 } },
    { seq: 1, kind: 'completion', assignmentId: 'a1', fields: { status: 'complete' } },
  ]);
  assert.deepEqual(requests.map((r) => r.path), ['/api/completions', '/api/rewards/entries']);
});

test('plan deduplicates reward entries by id rather than merging them', () => {
  // reward_entries is append-only (§3.4): two rows with the same id are the
  // same append queued twice, never two different amounts.
  const requests = OutboxCore.plan([
    { seq: 1, kind: 'reward', entry: { id: 'r1', category: 'RC-1', amount: 1 } },
    { seq: 2, kind: 'reward', entry: { id: 'r1', category: 'RC-1', amount: 1 } },
  ]);
  assert.equal(requests[0].body.entries.length, 1);
  assert.deepEqual(requests[0].seqs, [1, 2], 'both queue rows are still cleared');
});

test('plan sends only the latest streak', () => {
  const requests = OutboxCore.plan([
    { seq: 1, kind: 'streak', streak: { currentStreak: 1 } },
    { seq: 2, kind: 'streak', streak: { currentStreak: 2 } },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { currentStreak: 2 });
  assert.deepEqual(requests[0].seqs, [1, 2]);
});

test('plan chunks at the Worker MAX_BATCH so no request can 413', () => {
  const rows = Array.from({ length: OutboxCore.MAX_BATCH + 1 }, (_, i) => (
    { seq: i, kind: 'completion', assignmentId: `a${i}`, fields: { status: 'complete' } }
  ));
  const requests = OutboxCore.plan(rows);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.completions.length, OutboxCore.MAX_BATCH);
  assert.equal(requests[1].body.completions.length, 1);
});

test('plan sorts by seq, so queue order decides regardless of read order', () => {
  const requests = OutboxCore.plan([
    { seq: 5, kind: 'completion', assignmentId: 'a1', fields: { childSortOrder: 5 } },
    { seq: 1, kind: 'completion', assignmentId: 'a1', fields: { childSortOrder: 1 } },
  ]);
  assert.equal(requests[0].body.completions[0].childSortOrder, 5);
});

test('plan of an empty queue produces no requests', () => {
  assert.deepEqual(OutboxCore.plan([]), []);
  assert.deepEqual(OutboxCore.plan(null), []);
});

// Child Feedback Loop §11.7 — a deferral names row ids, so the drain needs a
// way back from an id to the queue rows it consumed. Without this map it can
// only keep the whole request or none of it.
test('plan maps every id back to the seqs it consumed', () => {
  const requests = OutboxCore.plan([
    { seq: 1, kind: 'completion', assignmentId: 'a1', fields: { childSortOrder: 1 } },
    { seq: 2, kind: 'completion', assignmentId: 'a1', fields: { status: 'complete' } },
    { seq: 3, kind: 'completion', assignmentId: 'a2', fields: { status: 'complete' } },
  ]);
  // A null-prototype map: ids are server/client-minted strings and must not be
  // able to collide with Object.prototype keys.
  assert.deepEqual({ ...requests[0].seqsById }, { a1: [1, 2], a2: [3] });
  assert.deepEqual(
    requests[0].seqs.slice().sort((x, y) => x - y),
    [1, 2, 3],
    'seqsById partitions seqs — it does not replace them'
  );
});

test('plan maps reward entry ids to seqs too, deduplication included', () => {
  const requests = OutboxCore.plan([
    { seq: 1, kind: 'reward', entry: { id: 'r1', category: 'RC-1', amount: 1 } },
    { seq: 2, kind: 'reward', entry: { id: 'r1', category: 'RC-1', amount: 1 } },
    { seq: 3, kind: 'reward', entry: { id: 'r2', category: 'RC-1', amount: 2 } },
  ]);
  assert.deepEqual({ ...requests[0].seqsById }, { r1: [1, 2], r2: [3] });
});

// =======================================================  assignment-core

test('isPlannable keeps only live pending work', () => {
  assert.equal(AssignmentCore.isPlannable(row()), true);
  assert.equal(AssignmentCore.isPlannable(row({ status: 'complete' })), false);
  assert.equal(AssignmentCore.isPlannable(row({ rescinded_at: 123 })), false);
});

test('§6.4: a rescinded row the child completed stays off the plan', () => {
  // Both facts are recorded and neither overwrote the other; the planner just
  // does not re-offer resolved work.
  assert.equal(AssignmentCore.isPlannable(row({ rescinded_at: 123, status: 'complete' })), false);
});

// Shared Chores §6.3 — a claim_group row is planned or dropped by identity
// against selfChildId, not by mere presence of claimed_by.
test('Shared Chores §6.3: a row claimed by self stays plannable', () => {
  const claimed = row({ claim_group: 'GRP-1', claimed_by: 'CH-1' });
  assert.equal(AssignmentCore.isPlannable(claimed, 'CH-1'), true);
});

test('Shared Chores §6.3: a row claimed by a sibling is dropped', () => {
  const claimed = row({ claim_group: 'GRP-1', claimed_by: 'CH-2' });
  assert.equal(AssignmentCore.isPlannable(claimed, 'CH-1'), false);
});

test('Shared Chores §6.3/§5.4: a held claim still pending stays on the holder\'s plan', () => {
  // The §5.4 window: claimed_by is set but the completion hasn't landed yet
  // (status is still 'pending'). A row-only rule ("claimed_by != null") would
  // wrongly drop this from the winner's own plan; the identity test does not.
  const held = row({ claim_group: 'GRP-1', claimed_by: 'CH-1', status: 'pending' });
  assert.equal(AssignmentCore.isPlannable(held, 'CH-1'), true);
});

test('Shared Chores §6.3: an unclaimed shared row is plannable for every participant', () => {
  const unclaimed = row({ claim_group: 'GRP-1', claimed_by: null });
  assert.equal(AssignmentCore.isPlannable(unclaimed, 'CH-1'), true);
  assert.equal(AssignmentCore.isPlannable(unclaimed, 'CH-2'), true);
});

test('toState returns only the decorated rows', () => {
  // §14 phase 3: the pre-revamp activities/chores/events/meta keys are gone —
  // `rows` is the only thing any consumer has read since phase 2.
  const state = AssignmentCore.toState([
    row({ id: 'a1', kind: 'activity' }),
    row({ id: 'c1', kind: 'chore', title: 'Dishes' }),
    row({ id: 'e1', kind: 'event', title: 'Dentist', source_id: 'EV-1' }),
  ]);
  assert.deepEqual(Object.keys(state), ['rows']);
  assert.equal(state.rows.length, 3);
});

test('Shared Chores §6.3: toState drops a sibling-claimed row but keeps a self-held one', () => {
  const state = AssignmentCore.toState([
    row({ id: 'a1', claim_group: 'GRP-1', claimed_by: 'CH-2' }), // sibling won
    row({ id: 'a2', claim_group: 'GRP-1', claimed_by: 'CH-1' }), // self holds it, still pending
    row({ id: 'a3' }), // ordinary row, unaffected
  ], 'CH-1');
  assert.deepEqual(state.rows.map((r) => r.id).sort(), ['a2', 'a3']);
});

test('decorateById indexes rows toState drops, which is the whole point of it', () => {
  // The Completed view's join source. A completed assignment is never in
  // toState's output (§6.4), so joining a completion record against `rows` finds
  // nothing the moment the server echoes the completion back — that is the bug
  // this function exists to close.
  const rows = [
    row({ id: 'a1', status: 'complete' }),
    row({ id: 'a2', status: 'waived' }),
    row({ id: 'a3', status: 'complete', rescinded_at: 123 }),
    row({ id: 'a4' }),
  ];
  assert.equal(AssignmentCore.toState(rows).rows.length, 1);

  const byId = AssignmentCore.decorateById(rows);
  assert.deepEqual(Object.keys(byId).sort(), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(byId.a1.status, 'complete');
});

test('decorateById decorates each row exactly as the planner does', () => {
  const source = row({ id: 'a1', status: 'complete', course_name: 'Math' });
  const byId = AssignmentCore.decorateById([source]);
  assert.deepEqual(byId.a1, AssignmentCore.decorate(source));
  assert.notEqual(byId.a1, source); // copied, never the stored row itself
});

test('decorateById skips an unknown kind and an id-less row, same as toState', () => {
  const byId = AssignmentCore.decorateById([
    row({ id: 'x1', kind: 'somethingNew' }),
    row({ id: undefined }),
    null,
    row({ id: 'a1' }),
  ]);
  assert.deepEqual(Object.keys(byId), ['a1']);
});

test('decorate keeps the row it was given, and does not mutate it', () => {
  // One object per assignment is the point of the phase — the planning columns
  // have to survive decoration or planner-core has nothing to read.
  const source = row({ sort_order: 3, child_sort_order: 9, deferred_to: '2026-08-14' });
  const item = AssignmentCore.decorate(source);
  assert.equal(item.sort_order, 3);
  assert.equal(item.child_sort_order, 9);
  assert.equal(item.deferred_to, '2026-08-14');
  assert.equal(item.kind, 'activity');
  assert.ok(!('content' in source), 'decoration lands on the copy, not the row');
});

test('decorate passes the payload column through untouched', () => {
  // §14 phase 2: it used to overwrite `payload` with a parsed, stripped object,
  // so the copy was not the row it claimed to be. What was parsed out of it is
  // now added under its own names.
  const raw = JSON.stringify({ kind: 'reference', reference: 'p. 40', lessonTitle: 'Rivers' });
  const item = AssignmentCore.decorate(row({ payload: raw }));
  assert.equal(item.payload, raw);
  assert.equal(item.lessonTitle, 'Rivers');
  assert.deepEqual(item.content, { kind: 'reference', reference: 'p. 40' });
});

test('toState ignores an unknown kind rather than crashing', () => {
  const state = AssignmentCore.toState([row({ id: 'x1', kind: 'somethingNew' })]);
  assert.equal(state.rows.length, 0);
});

test('toState promotes payload fields and leaves them out of the content', () => {
  const state = AssignmentCore.toState([row({
    payload: JSON.stringify({
      kind: 'pageRange', pageRangeStart: 10, pageRangeEnd: 20,
      required: true, capturesGrade: true, difficultyTier: 'T2', instructions: 'Skim it',
    }),
  })]);
  const item = state.rows[0];
  assert.equal(item.required, true);
  assert.equal(item.capturesGrade, true);
  assert.equal(item.difficultyTier, 'T2');
  assert.equal(item.instructions, 'Skim it');
  assert.equal(item.content.pageRangeStart, 10);
  assert.ok(!('required' in item.content), 'promoted fields must not be duplicated in content');
  assert.ok(!('instructions' in item.content));
});

test('only an activity gets a content descriptor', () => {
  // A chore's payload is a chore type and a flag; an event's is a span. Neither
  // has a "what the work is" descriptor for planner-ui to render.
  const [chore, event] = AssignmentCore.toState([
    row({ id: 'c1', kind: 'chore', payload: JSON.stringify({ choreType: 'Daily' }) }),
    row({ id: 'e1', kind: 'event', payload: JSON.stringify({ time: '18:00' }) }),
  ]).rows;
  assert.ok(!('content' in chore));
  assert.ok(!('content' in event));
  assert.equal(chore.choreType, 'Daily');
  assert.equal(event.time, '18:00');
});

test('toState treats an absent chore `required` as true', () => {
  // Chores are always required; absent must not read as false, or the child
  // loses their Reschedule/Waive controls on an older row.
  const state = AssignmentCore.toState([row({ id: 'c1', kind: 'chore', payload: JSON.stringify({}) })]);
  assert.equal(state.rows[0].required, true);
});

test('toState no longer mints a second name for any column', () => {
  // §14 phases 1–2. receiptIndex and blockHint existed to feed planner-core; the
  // six camelCase aliases existed to feed planner-ui and completion.js. All of
  // them now read the column. Re-adding any would put the double representation
  // the collapse removed straight back.
  const item = AssignmentCore.toState([row({
    sort_order: 4, block_hint: 'morning',
    reward_amount: 5, expected_duration_min: 20,
  })]).rows[0];
  for (const alias of [
    'receiptIndex', 'blockHint', 'courseName', 'sequenceNumber', 'activityType',
    'rewardCategoryId', 'rewardAmount', 'expectedDurationMin',
  ]) {
    assert.ok(!(alias in item), `${alias} must not be minted alongside its column`);
  }
  assert.equal(item.sort_order, 4);
  assert.equal(item.block_hint, 'morning');
  assert.equal(item.course_name, 'History');
  assert.equal(item.activity_type, 'Reading');
  assert.equal(item.reward_category, 'RC-1');
  assert.equal(item.reward_amount, 5);
  assert.equal(item.expected_duration_min, 20);
});

test('parsePayload survives null, objects and malformed JSON', () => {
  assert.deepEqual(AssignmentCore.parsePayload(null), {});
  assert.deepEqual(AssignmentCore.parsePayload('{"a":1}'), { a: 1 });
  assert.deepEqual(AssignmentCore.parsePayload({ a: 1 }), { a: 1 });
  assert.deepEqual(AssignmentCore.parsePayload('{not json'), {});
});

// ==========================================================  planner-core
//
// §14 phase 1: these all take assignment rows and no `meta` map. Rows go
// through AssignmentCore.decorate first, exactly as DB.loadState() feeds them,
// because `required` and an event's span are promoted out of payload.

const TODAY = '2026-08-11';
const plan = (...rows) => rows.map(AssignmentCore.decorate);
const ids = (list) => list.map((r) => r.id);
const nothingResolved = () => false;

test('effectiveDueDate prefers the child deferral over the assigned date', () => {
  assert.equal(PlannerCore.effectiveDueDate(row()), '2026-08-11');
  assert.equal(PlannerCore.effectiveDueDate(row({ deferred_to: '2026-08-14' })), '2026-08-14');
});

test('effectiveBlock: child override, then parent hint, then morning', () => {
  assert.equal(PlannerCore.effectiveBlock(row({ block_hint: 'evening' })), 'evening');
  assert.equal(PlannerCore.effectiveBlock(row({ block_hint: 'evening', child_block_hint: 'night' })), 'night');
  assert.equal(PlannerCore.effectiveBlock(row({ block_hint: null })), 'morning');
  // Out-of-set values fall back the same way an absent one does, on both sides.
  assert.equal(PlannerCore.effectiveBlock(row({ block_hint: 'Morning' })), 'morning');
  assert.equal(PlannerCore.effectiveBlock(row({ block_hint: 'evening', child_block_hint: 'brunch' })), 'evening');
});

test('effectiveSortKey is COALESCE(child_sort_order, sort_order) (§3.3.3)', () => {
  assert.equal(PlannerCore.effectiveSortKey(row({ sort_order: 4 })), 4);
  assert.equal(PlannerCore.effectiveSortKey(row({ sort_order: 4, child_sort_order: 1 })), 1);
  assert.equal(PlannerCore.effectiveSortKey(row({ sort_order: null })), 0);
  // 0 is a real key on either side, not an absence.
  assert.equal(PlannerCore.effectiveSortKey(row({ sort_order: 4, child_sort_order: 0 })), 0);
});

test('onToday: due today, or overdue and required (§2.1 roll-forward)', () => {
  const due = AssignmentCore.decorate(row({ payload: JSON.stringify({ required: true }) }));
  assert.equal(PlannerCore.onToday(due, TODAY, nothingResolved), true);

  const overdueRequired = AssignmentCore.decorate(
    row({ date: '2026-08-09', payload: JSON.stringify({ required: true }) })
  );
  assert.equal(PlannerCore.onToday(overdueRequired, TODAY, nothingResolved), true);

  const overdueOptional = AssignmentCore.decorate(row({ date: '2026-08-09' }));
  assert.equal(PlannerCore.onToday(overdueOptional, TODAY, nothingResolved), false);

  const future = AssignmentCore.decorate(row({ date: '2026-08-20' }));
  assert.equal(PlannerCore.onToday(future, TODAY, nothingResolved), false);
});

test('unrecordedOverdue: past school work with nothing recorded (Ray, 2026-09-01)', () => {
  const d = (o) => AssignmentCore.decorate(row(o));

  // The whole point of the rule: a deferral is an answer, an absence is not.
  const ignored = d({ id: 'x1', date: '2026-08-09' });
  const deferred = d({ id: 'x2', date: '2026-08-09', deferred_to: '2026-08-14' });
  assert.deepEqual(
    PlannerCore.unrecordedOverdue([ignored, deferred], TODAY, nothingResolved).map((r) => r.id),
    ['x1']
  );

  // Unlike onToday, `required` is not a gate — an optional activity never rolls
  // forward, so it is exactly the work this prompt exists to surface.
  const optional = d({ id: 'x3', date: '2026-08-09' });
  const required = d({ id: 'x4', date: '2026-08-09', payload: JSON.stringify({ required: true }) });
  assert.equal(PlannerCore.unrecordedOverdue([optional, required], TODAY, nothingResolved).length, 2);

  // Today and the future are not overdue; a resolved row is answered.
  const todayRow = d({ id: 'x5', date: TODAY });
  const future = d({ id: 'x6', date: '2026-08-20' });
  assert.equal(PlannerCore.unrecordedOverdue([todayRow, future], TODAY, nothingResolved).length, 0);
  assert.equal(PlannerCore.unrecordedOverdue([ignored], TODAY, (id) => id === 'x1').length, 0);

  // Activities only — a missed chore day is spent, not revisited.
  const chore = d({ id: 'x7', date: '2026-08-09', kind: 'chore' });
  const event = d({ id: 'x8', date: '2026-08-09', kind: 'event' });
  assert.equal(PlannerCore.unrecordedOverdue([chore, event], TODAY, nothingResolved).length, 0);
});

test('earliestUnrecordedDate returns the oldest unanswered day, else null', () => {
  const d = (o) => AssignmentCore.decorate(row(o));
  const rows = [
    d({ id: 'x1', date: '2026-08-10' }),
    d({ id: 'x2', date: '2026-08-07' }),
    d({ id: 'x3', date: '2026-08-09' }),
  ];
  assert.equal(PlannerCore.earliestUnrecordedDate(rows, TODAY, nothingResolved), '2026-08-07');

  // Resolving the earliest day walks the prompt forward to the next one.
  assert.equal(PlannerCore.earliestUnrecordedDate(rows, TODAY, (id) => id === 'x2'), '2026-08-09');
  assert.equal(PlannerCore.earliestUnrecordedDate([], TODAY, nothingResolved), null);
});

test('onToday drops a resolved row, and follows a deferral off the day', () => {
  const item = AssignmentCore.decorate(row());
  assert.equal(PlannerCore.onToday(item, TODAY, (id) => id === 'a1'), false);

  const moved = AssignmentCore.decorate(row({ deferred_to: '2026-08-14' }));
  assert.equal(PlannerCore.onToday(moved, TODAY, nothingResolved), false);
  assert.equal(PlannerCore.onToday(moved, '2026-08-14', nothingResolved), true);
});

test('assembleToday groups by effective block, in canonical order', () => {
  const today = PlannerCore.assembleToday(plan(
    row({ id: 'a1', block_hint: 'evening' }),
    row({ id: 'a2', block_hint: 'morning' }),
    row({ id: 'c1', kind: 'chore', block_hint: 'evening' })
  ), TODAY, nothingResolved);

  assert.deepEqual(today.blocks.map((b) => b.name), ['morning', 'evening'], 'empty blocks omitted');
  assert.deepEqual(ids(today.blocks[0].school), ['a2']);
  assert.deepEqual(ids(today.blocks[1].school), ['a1']);
  assert.deepEqual(ids(today.blocks[1].chores), ['c1']);
});

test('assembleToday sorts within a block by effective key, then id', () => {
  const today = PlannerCore.assembleToday(plan(
    row({ id: 'a3', sort_order: 2 }),
    row({ id: 'a1', sort_order: 9, child_sort_order: 0 }), // child override wins
    row({ id: 'a2', sort_order: 2 })                       // ties break on id
  ), TODAY, nothingResolved);
  assert.deepEqual(ids(today.blocks[0].school), ['a1', 'a2', 'a3']);
});

test('a multi-day event renders once, however many rows carry it', () => {
  // It is committed as one row per in-range day, each with the same span, so
  // every one of them matches the same `today`.
  const payload = JSON.stringify({ startDate: '2026-08-10', endDate: '2026-08-13' });
  const rows = plan(
    row({ id: 'e1', kind: 'event', source_id: 'EV-1', date: '2026-08-10', payload }),
    row({ id: 'e2', kind: 'event', source_id: 'EV-1', date: '2026-08-11', payload }),
    row({ id: 'e3', kind: 'event', source_id: 'EV-1', date: '2026-08-12', payload })
  );
  assert.equal(PlannerCore.assembleToday(rows, TODAY, nothingResolved).events.length, 1);
  assert.equal(PlannerCore.eventsView(rows, TODAY).length, 1);
});

test('an event out of span does not reach the day, and one without a source_id still shows', () => {
  const rows = plan(
    row({
      id: 'e1', kind: 'event', source_id: 'EV-1',
      payload: JSON.stringify({ startDate: '2026-08-01', endDate: '2026-08-03' }),
    }),
    row({ id: 'e2', kind: 'event', source_id: null, date: TODAY, payload: null })
  );
  assert.deepEqual(ids(PlannerCore.eventsView(rows, TODAY)), ['e2']);
});

test('filterView selects one kind, ordered by block then position', () => {
  const rows = plan(
    row({ id: 'a1', block_hint: 'evening', sort_order: 1 }),
    row({ id: 'a2', block_hint: 'morning', sort_order: 5 }),
    row({ id: 'c1', kind: 'chore', block_hint: 'morning' })
  );
  assert.deepEqual(ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'school')), ['a2', 'a1']);
  assert.deepEqual(ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'chores')), ['c1']);
});

// Child Feedback Loop §4.2, reworked by the Lesson Recipe slice §9.2 —
// filterView("school") groups by block, then course, then lesson, then
// effectiveSortKey. `sequence_no` is gone; a lesson group's order comes
// entirely from sort_order/child_sort_order now.
test('filterView (school) groups by block, then course, then lesson, then effective key', () => {
  const rows = plan(
    row({ id: 'a1', course_name: 'History', payload: JSON.stringify({ lessonTitle: 'Rivers' }), sort_order: 9 }),
    row({ id: 'a2', course_name: 'History', payload: JSON.stringify({ lessonTitle: 'Rivers' }), sort_order: 0 }),
    row({ id: 'a3', course_name: 'Maths', sort_order: 1 }),
    row({ id: 'a4', course_name: null, sort_order: 0 })
  );
  // First-seen course order (History, then Maths); within History, the one
  // lesson group sorts by effectiveSortKey; the course-less item falls into
  // its own unlabeled group, forced last regardless of §4.2.
  assert.deepEqual(
    ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'school')),
    ['a2', 'a1', 'a3', 'a4']
  );
});

// Subject Order slice §2.7 — this case used to assert that the *array* order
// decided which lesson group came first. It now asserts the replacement rule:
// the input is sorted by effective key before grouping, so a group's position
// is its lowest key. a3 is a Rivers row the child dragged to -1, which is
// exactly the drift the §2.7 [DECISION] accepts: pulling a card to the front
// of its run can pull the run's group earlier too.
test('filterView (school) orders lesson groups by their lowest effective key, each sorted on its own', () => {
  const lessonA = JSON.stringify({ lessonTitle: 'Rivers' });
  const lessonB = JSON.stringify({ lessonTitle: 'Mountains' });
  const rows = plan(
    row({ id: 'a1', course_name: 'History', payload: lessonB, sort_order: 0 }), // Mountains seen first
    row({ id: 'a2', course_name: 'History', payload: lessonA, sort_order: 0 }), // Rivers seen second
    row({ id: 'a3', course_name: 'History', payload: lessonA, sort_order: 0, child_sort_order: -1 }), // Rivers, reordered ahead
    row({ id: 'a4', course_name: 'History', payload: null, sort_order: 1 }) // no lesson — its own trailing group
  );
  assert.deepEqual(
    ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'school')),
    ['a3', 'a2', 'a1', 'a4'],
    'Rivers first because a3 holds the lowest key, its own run sorted within, Mountains after, lesson-less items trail'
  );
});

test('filterView (chores) stays block-then-position only — course_name has no effect', () => {
  const rows = plan(
    row({ id: 'c1', kind: 'chore', course_name: 'Zzz', sort_order: 1 }),
    row({ id: 'c2', kind: 'chore', course_name: 'Aaa', sort_order: 0 })
  );
  assert.deepEqual(ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'chores')), ['c2', 'c1']);
});

// Module 3 FR-13 — the course collapse's grouping. The Today view feeds it a
// byCourseThenLesson list and the Completed view feeds it an unordered one;
// both have to come out one group per course.
test('groupByCourse gathers one group per course, in first-appearance order', () => {
  const items = [
    row({ id: 'a1', course_name: 'History' }),
    row({ id: 'a2', course_name: 'Maths' }),
    row({ id: 'a3', course_name: 'History' })
  ];
  const groups = PlannerCore.groupByCourse(items);
  assert.deepEqual(groups.map((grp) => grp.course_name), ['History', 'Maths']);
  assert.deepEqual(groups.map((grp) => ids(grp.items)), [['a1', 'a3'], ['a2']]);
});

test('groupByCourse keeps the order it was handed inside each group', () => {
  const rivers = JSON.stringify({ lessonTitle: 'Rivers' });
  const rows = plan(
    row({ id: 'a1', course_name: 'History', payload: rivers, sort_order: 9 }),
    row({ id: 'a2', course_name: 'History', payload: rivers, sort_order: 0 }),
    row({ id: 'a3', course_name: 'Maths', sort_order: 1 })
  );
  // The lesson sort byCourseThenLesson applied (a2 before a1) survives the
  // grouping — the collapse wraps the cards, it does not resequence them.
  const sorted = PlannerCore.filterView(rows, TODAY, nothingResolved, 'school');
  const groups = PlannerCore.groupByCourse(sorted);
  assert.deepEqual(groups.map((grp) => ids(grp.items)), [['a2', 'a1'], ['a3']]);
});

test('groupByCourse puts course-less rows in one trailing null group', () => {
  const groups = PlannerCore.groupByCourse([
    row({ id: 'a1', course_name: null }),
    row({ id: 'a2', course_name: 'Maths' }),
    row({ id: 'a3', course_name: undefined }),
    row({ id: 'a4', course_name: '' })
  ]);
  assert.deepEqual(groups.map((grp) => grp.course_name), ['Maths', null],
    'the unlabeled group is last however early its first row appeared, and the core names it null rather than inventing a display string');
  assert.deepEqual(ids(groups[1].items), ['a1', 'a3', 'a4']);
});

test('groupByCourse survives an empty list and a missing one', () => {
  assert.deepEqual(PlannerCore.groupByCourse([]), []);
  assert.deepEqual(PlannerCore.groupByCourse(), []);
});

// Child Feedback Loop §4.3, widened by the Lesson Recipe slice §9.2 — every
// row is reorderable now that `sequence_no` (parent-authored lesson order) is
// gone with the column, and the peer scope narrows one level further, to the
// lesson.
test('reorderPeers narrows an activity to its own block, course, and lesson', () => {
  const rivers = JSON.stringify({ lessonTitle: 'Rivers' });
  const mountains = JSON.stringify({ lessonTitle: 'Mountains' });
  const rows = plan(
    row({ id: 'a1', course_name: 'History', block_hint: 'morning', payload: rivers }),
    row({ id: 'a2', course_name: 'History', block_hint: 'morning', payload: rivers }),
    row({ id: 'a3', course_name: 'History', block_hint: 'morning', payload: mountains }),
    row({ id: 'a4', course_name: 'Maths', block_hint: 'morning', payload: rivers }),
    row({ id: 'a5', course_name: 'History', block_hint: 'afternoon', payload: rivers })
  );
  const scope = PlannerCore.reorderPeers(rows, rows[1]);
  assert.deepEqual(
    ids(scope.peers), ['a1', 'a2'],
    'a different lesson, a different course, and a different block are all out of reach'
  );
  assert.equal(scope.index, 1);
});

test('reorderPeers keeps lesson-less activities of a course together, apart from its lessons', () => {
  const rows = plan(
    row({ id: 'a1', course_name: 'History', block_hint: 'morning', payload: null }),
    row({ id: 'a2', course_name: 'History', block_hint: 'morning', payload: JSON.stringify({ lessonTitle: 'Rivers' }) }),
    row({ id: 'a3', course_name: 'History', block_hint: 'morning', payload: null })
  );
  assert.deepEqual(ids(PlannerCore.reorderPeers(rows, rows[0]).peers), ['a1', 'a3']);
});

test('reorderPeers keeps course-less activities together, apart from the courses', () => {
  const rows = plan(
    row({ id: 'a1', course_name: null, block_hint: 'morning' }),
    row({ id: 'a2', course_name: 'History', block_hint: 'morning' }),
    row({ id: 'a3', course_name: null, block_hint: 'morning' })
  );
  assert.deepEqual(ids(PlannerCore.reorderPeers(rows, rows[0]).peers), ['a1', 'a3']);
});

test('reorderPeers narrows a chore to its block only — chores have no course', () => {
  const rows = plan(
    row({ id: 'c1', kind: 'chore', course_name: 'Zzz', block_hint: 'morning' }),
    row({ id: 'c2', kind: 'chore', course_name: 'Aaa', block_hint: 'morning' }),
    row({ id: 'c3', kind: 'chore', course_name: null, block_hint: 'evening' }),
    row({ id: 'a1', kind: 'activity', block_hint: 'morning' })
  );
  const scope = PlannerCore.reorderPeers(rows, rows[0]);
  assert.deepEqual(ids(scope.peers), ['c1', 'c2'], 'course_name is ignored, the other block and the activity are not peers');
  assert.equal(scope.index, 0);
});

test('reorderPeers respects a child block override, not just the parent hint', () => {
  const rows = plan(
    row({ id: 'a1', course_name: 'History', block_hint: 'morning' }),
    row({ id: 'a2', course_name: 'History', block_hint: 'afternoon', child_sort_order: null })
  );
  rows[1].child_block_hint = 'morning';
  assert.deepEqual(
    ids(PlannerCore.reorderPeers(rows, rows[0]).peers),
    ['a1', 'a2'],
    'a2 was moved into morning by the child, so it is a peer there'
  );
});

test('reorderPeers reports index -1 for a row outside the list', () => {
  const rows = plan(row({ id: 'a1', course_name: 'History' }));
  const stranger = plan(row({ id: 'a9', course_name: 'History' }))[0];
  assert.equal(PlannerCore.reorderPeers(rows, stranger).index, -1);
});

test('assembleToday groups School by course within each block; Chores stay position-only', () => {
  const today = PlannerCore.assembleToday(plan(
    row({ id: 'a1', course_name: 'Maths', sort_order: 5 }),
    row({ id: 'a2', course_name: 'History', sort_order: 0 }),
    row({ id: 'c1', kind: 'chore', course_name: 'Zzz', sort_order: 1 }),
    row({ id: 'c2', kind: 'chore', course_name: 'Aaa', sort_order: 0 })
  ), TODAY, nothingResolved);

  // Subject Order slice §2.7 — was 'first-seen, not position'. The course
  // headings now follow position too, which is what carries the parent's
  // standing subject order onto the child's screen: History (0) before
  // Maths (5), whatever order IndexedDB handed the rows over in.
  assert.deepEqual(ids(today.blocks[0].school), ['a2', 'a1'], 'course group order follows effective key');
  assert.deepEqual(ids(today.blocks[0].chores), ['c2', 'c1'], 'chores keep plain position order');
});

// Subject Order slice §2.7, Phase 4 — the two cases the slice asks for. The
// bug they pin: `DB.loadState()` is `getAll("assignments")`, which returns
// rows in opaque-UUID key order (CLAUDE.md §III.B), so a course's heading
// position used to be decided by a UUID. Both fixtures are therefore written
// with ids that sort *against* the plan order.
test('filterView (school) orders course groups by lowest effective key, not by array order', () => {
  // byCourseThenLesson is internal; filterView is how the rest of this file
  // reaches it.
  const rows = plan(
    row({ id: 'a1', course_name: 'Maths', sort_order: 20 }),
    row({ id: 'a2', course_name: 'History', sort_order: 10 }),
    row({ id: 'a3', course_name: 'Maths', sort_order: 21 }),
    row({ id: 'a4', course_name: 'History', sort_order: 11 })
  );
  const frozen = ids(rows);
  assert.deepEqual(
    ids(PlannerCore.filterView(rows, TODAY, nothingResolved, 'school')),
    ['a2', 'a4', 'a1', 'a3'],
    'History (10) leads Maths (20) although Maths appeared first in the array'
  );
  assert.deepEqual(ids(rows), frozen, 'the caller\'s array is not reordered under it');
});

test('subjectsView orders its course groups by lowest effective key too', () => {
  const groups = PlannerCore.subjectsView(plan(
    row({ id: 'a1', course_name: 'Maths', sort_order: 20 }),
    row({ id: 'a2', course_name: 'History', sort_order: 10 }),
    row({ id: 'a3', course_name: 'Science', sort_order: 15 })
  ), TODAY, nothingResolved);

  assert.deepEqual(groups.map((g) => g.course_name), ['History', 'Science', 'Maths']);
});

// Lesson Recipe slice §9.2 — byCourseThenLesson sub-groups each course by
// lessonTitle before it sorts, replacing the old sequence_no/position choice
// with one sort (effectiveSortKey) applied inside every lesson group.
test('assembleToday sub-groups a course by lesson, in first-seen order, sorted within by effective key', () => {
  const rivers = JSON.stringify({ lessonTitle: 'Rivers' });
  const mountains = JSON.stringify({ lessonTitle: 'Mountains' });
  const today = PlannerCore.assembleToday(plan(
    row({ id: 'a1', course_name: 'History', payload: mountains, sort_order: 0 }), // Mountains seen first
    row({ id: 'a2', course_name: 'History', payload: rivers, sort_order: 9 }),
    row({ id: 'a3', course_name: 'History', payload: rivers, sort_order: 0 }),
    row({ id: 'a4', course_name: 'History', payload: null, sort_order: 0 }) // no lesson — trailing group
  ), TODAY, nothingResolved);

  assert.deepEqual(
    ids(today.blocks[0].school), ['a1', 'a3', 'a2', 'a4'],
    'Mountains group first, Rivers group sorted by effective key within itself, lesson-less items trail'
  );
});

test('subjectsView groups activities by course_name, in first-seen order', () => {
  const groups = PlannerCore.subjectsView(plan(
    row({ id: 'a1', course_name: 'History', sort_order: 2 }),
    row({ id: 'a2', course_name: 'Maths' }),
    row({ id: 'a3', course_name: 'History', sort_order: 1 }),
    row({ id: 'c1', kind: 'chore', course_name: 'History' })
  ), TODAY, nothingResolved);

  assert.deepEqual(groups.map((g) => g.course_name), ['History', 'Maths']);
  assert.deepEqual(ids(groups[0].items), ['a3', 'a1'], 'grouped items keep position order');
  assert.deepEqual(ids(groups[1].items), ['a2']);
});

// ===========================================================  streak-core

test('requiredDueOn takes only required rows, on their effective date', () => {
  const required = JSON.stringify({ required: true });
  const rows = plan(
    row({ id: 'a1', payload: required }),
    row({ id: 'a2' }),                                            // not required
    row({ id: 'a3', payload: required, deferred_to: '2026-08-14' }), // moved away
    row({ id: 'c1', kind: 'chore' })                              // chores default to required
  );
  assert.deepEqual(ids(StreakCore.requiredDueOn(rows, TODAY)), ['a1', 'c1']);
  assert.deepEqual(ids(StreakCore.requiredDueOn(rows, '2026-08-14')), ['a3']);
});

test('an event never counts toward the streak', () => {
  // It carries no `required` flag and there is nothing about it to resolve.
  const rows = plan(row({ id: 'e1', kind: 'event', date: TODAY, payload: null }));
  assert.deepEqual(StreakCore.requiredDueOn(rows, TODAY), []);
  assert.equal(StreakCore.dayStatus(rows, {}, TODAY), 'neutral');
});

test('dayStatus: neutral with nothing due, resolved only when all are', () => {
  const required = JSON.stringify({ required: true });
  const rows = plan(row({ id: 'a1', payload: required }), row({ id: 'a2', payload: required }));

  assert.equal(StreakCore.dayStatus([], {}, TODAY), 'neutral');
  assert.equal(StreakCore.dayStatus(rows, {}, TODAY), 'breaking');
  assert.equal(StreakCore.dayStatus(rows, { a1: true }, TODAY), 'breaking');
  assert.equal(StreakCore.dayStatus(rows, { a1: true, a2: true }, TODAY), 'resolved');
});

// =======================================================  completion-core

test('validateGrade accepts a whole 0-100, or blank/absent', () => {
  assert.deepEqual(CompletionCore.validateGrade(undefined), { ok: true, grade: undefined });
  assert.deepEqual(CompletionCore.validateGrade(''), { ok: true, grade: undefined });
  assert.deepEqual(CompletionCore.validateGrade('87'), { ok: true, grade: 87 });
  assert.equal(CompletionCore.validateGrade('101').ok, false);
  assert.equal(CompletionCore.validateGrade('A+').ok, false);
});

// Child Feedback Loop §5.2/§5.3 — mirrors the Worker's own MAX_NOTE_LEN rule.
test('validateNote accepts a trimmed string under the cap, or blank/absent', () => {
  assert.deepEqual(CompletionCore.validateNote(undefined), { ok: true, note: undefined });
  assert.deepEqual(CompletionCore.validateNote(null), { ok: true, note: undefined });
  assert.deepEqual(CompletionCore.validateNote('   '), { ok: true, note: undefined }, 'whitespace-only is "nothing to say"');
  assert.deepEqual(CompletionCore.validateNote('  skipped #11  '), { ok: true, note: 'skipped #11' });
});

test('validateNote rejects a note over MAX_NOTE_LEN', () => {
  const tooLong = 'x'.repeat(CompletionCore.MAX_NOTE_LEN + 1);
  const result = CompletionCore.validateNote(tooLong);
  assert.equal(result.ok, false);
  assert.match(result.message, /1000/);
  assert.equal(CompletionCore.validateNote('x'.repeat(CompletionCore.MAX_NOTE_LEN)).ok, true);
});

test('buildActivityRecord includes grade/note only when provided, never a blank placeholder', () => {
  assert.deepEqual(CompletionCore.buildActivityRecord('a1', '2026-08-11'), {
    activityId: 'a1', date: '2026-08-11', status: 'complete', exported: false,
  });
  assert.deepEqual(CompletionCore.buildActivityRecord('a1', '2026-08-11', 90, 'nice work'), {
    activityId: 'a1', date: '2026-08-11', status: 'complete', exported: false,
    grade: 90, note: 'nice work',
  });
});

test('buildEarnEntry uses the snapshotted amount when there is one', () => {
  // §7: the amount comes from the assignment row, so a later edit to a tier
  // never changes what was already earned.
  assert.equal(CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', 5, 100).amount, 5);
  assert.equal(CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', 0, 100).amount, 0);
});

test('buildEarnEntry falls back to the flat 1 when no amount is snapshotted', () => {
  // reward_amount is NULL on every row today — tiers carry no number. See the
  // deferred item in Revamp §14.
  assert.equal(CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', undefined, 100).amount, 1);
  assert.equal(CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', null, 100).amount, 1);
  assert.equal(CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', NaN, 100).amount, 1);
});

// ---- the §8.1 ledger: one append-only store, balance as a fold ----

test('an earn entry is stored in the shape the server ledger uses', () => {
  // §3.4/§8.1: the local row and the uploaded row are the same row, so the
  // stored shape has to be the one buildRewardOp accepts — signed `amount`,
  // `reason` from the server enum, and the id the caller minted.
  const earn = CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-11', 'a1', 3, 1700);
  assert.deepEqual(earn, {
    id: 'e1', assignmentId: 'a1', category: 'RC-1', amount: 3,
    reason: 'earned', earnedAt: 1700, date: '2026-08-11',
  });
  // The round trip that matters: it survives buildRewardOp without translation.
  const op = OutboxCore.buildRewardOp(earn, 9999);
  assert.equal(op.entry.id, 'e1');
  assert.equal(op.entry.amount, 3);
  assert.equal(op.entry.reason, 'earned');
  assert.equal(op.entry.earnedAt, 1700);
});

test('a spend is a negative entry, not a subtraction', () => {
  // §3.4: nothing is ever decremented at either end. validateSpendAmount hands
  // over a positive number and the sign is applied exactly once.
  const spend = RewardCore.buildSpendEntry('e2', 'RC-1', 5, '2026-08-11', 1800);
  assert.equal(spend.amount, -5);
  assert.equal(spend.reason, 'spend');
  assert.equal(spend.assignmentId, null);
  assert.equal(OutboxCore.buildRewardOp(spend, 0).entry.reason, 'spend');
});

test('a repair adjustment keeps the sign it was given', () => {
  // Module 11 FR-7a: a correction may go either way, and is uploaded under
  // 'adjustment' so a parent can tell it from work the child did.
  assert.equal(SettingsCore.buildAdjustEntry('e3', 'RC-1', -12, '2026-08-11', 1900).amount, -12);
  assert.equal(SettingsCore.buildAdjustEntry('e4', 'RC-1', 12, '2026-08-11', 1900).amount, 12);
  assert.equal(SettingsCore.buildAdjustEntry('e3', 'RC-1', -12, '2026-08-11', 1900).reason, 'adjustment');
});

test('balanceOf sums the entries in earnedAt order', () => {
  const entries = [
    CompletionCore.buildEarnEntry('e2', 'RC-1', '2026-08-11', 'a2', 3, 200),
    CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-10', 'a1', 4, 100),
  ];
  assert.equal(CompletionCore.balanceOf(entries), 7);
  assert.equal(CompletionCore.balanceOf([]), 0);
});

test('balanceOf floors per step, not at the end', () => {
  // The behaviour the old two-store fold had, preserved exactly: 30, then a -50
  // adjustment (floors to 0), then a +10 earn gives 10 — not 0, which a
  // max(0, sum) would give, and not -10, which a plain sum would.
  const entries = [
    CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-10', 'a1', 30, 100),
    SettingsCore.buildAdjustEntry('e2', 'RC-1', -50, '2026-08-11', 200),
    CompletionCore.buildEarnEntry('e3', 'RC-1', '2026-08-12', 'a2', 10, 300),
  ];
  assert.equal(CompletionCore.balanceOf(entries), 10);
});

test('balanceOf order does not depend on the order rows come out of the store', () => {
  // IndexedDB returns getAll() in key order, and the key is now a random UUID —
  // so the fold has to sort, where the old autoincrement key sorted for free.
  const build = () => [
    CompletionCore.buildEarnEntry('zzz', 'RC-1', '2026-08-10', 'a1', 30, 100),
    SettingsCore.buildAdjustEntry('aaa', 'RC-1', -50, '2026-08-11', 200),
    CompletionCore.buildEarnEntry('mmm', 'RC-1', '2026-08-12', 'a2', 10, 300),
  ];
  const inOrder = build();
  const shuffled = [build()[1], build()[2], build()[0]];
  assert.equal(CompletionCore.balanceOf(inOrder), CompletionCore.balanceOf(shuffled));
});

test('entries written in the same millisecond fold deterministically', () => {
  // Two completions tapped together share an earnedAt; the id breaks the tie so
  // the balance is the same on every read rather than depending on store order.
  const a = SettingsCore.buildAdjustEntry('aaa', 'RC-1', -5, '2026-08-11', 500);
  const b = CompletionCore.buildEarnEntry('bbb', 'RC-1', '2026-08-11', 'a1', 5, 500);
  assert.equal(CompletionCore.balanceOf([a, b]), CompletionCore.balanceOf([b, a]));
  // 'aaa' sorts first: -5 floors to 0, then +5 -> 5. Not 0, which is what the
  // opposite order would give.
  assert.equal(CompletionCore.balanceOf([b, a]), 5);
});

test('balancesByCategory keeps categories independent', () => {
  const entries = [
    CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-10', 'a1', 4, 100),
    CompletionCore.buildEarnEntry('e2', 'RC-2', '2026-08-10', 'a2', 6, 200),
    RewardCore.buildSpendEntry('e3', 'RC-1', 1, '2026-08-11', 300),
  ];
  const balances = CompletionCore.balancesByCategory(entries);
  assert.equal(balances['RC-1'], 3);
  assert.equal(balances['RC-2'], 6);
  assert.deepEqual(Object.keys(balances).sort(), ['RC-1', 'RC-2']);
});

test('balancesByCategory ignores entries with no category', () => {
  // A category is the only thing that makes an entry mean anything, and
  // enqueueReward already refuses to upload one without it.
  const balances = CompletionCore.balancesByCategory([
    { id: 'x', amount: 5, earnedAt: 1 },
    CompletionCore.buildEarnEntry('e1', 'RC-1', '2026-08-10', 'a1', 2, 100),
  ]);
  assert.deepEqual(Object.keys(balances), ['RC-1']);
  assert.equal(balances['RC-1'], 2);
});

test('mintEntryId returns something unique enough to be a primary key', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(CompletionCore.mintEntryId());
  assert.equal(seen.size, 500);
});

// ===========================================================  pairing

// pairing.js is not a `*-core.js` file — it owns fetch and IndexedDB — but its
// code normalizer is pure, and it is the one thing standing between a kid
// mistyping the separators they used to keep their place and a `409 Unknown
// pairing code`. Evaluated the same way as the cores; nothing in the IIFE
// touches the network at load time.
vm.runInThisContext(readFileSync(new URL('child-app/js/pairing.js', repo), 'utf8'), { filename: 'pairing.js' });
const { Pairing } = globalThis;

test('normalizeCode strips the separators a person adds while typing', () => {
  // The Worker trims and uppercases (§5.4) but does not strip inner
  // separators, so a code read off one screen as "AB2C-3D4E" has to be
  // repaired here or it matches no row.
  assert.equal(Pairing.normalizeCode('ab2c-3d4e'), 'AB2C3D4E');
  assert.equal(Pairing.normalizeCode(' AB2C 3D4E '), 'AB2C3D4E');
  assert.equal(Pairing.normalizeCode('AB2C3D4E'), 'AB2C3D4E');
});

test('normalizeCode treats an absent or blank code as empty', () => {
  // redeem() short-circuits on the empty string rather than spending a
  // request, so this is the check that keeps it from firing on whitespace.
  assert.equal(Pairing.normalizeCode(''), '');
  assert.equal(Pairing.normalizeCode('   '), '');
  assert.equal(Pairing.normalizeCode(null), '');
  assert.equal(Pairing.normalizeCode(undefined), '');
});

// ===========================================================  export/wipe

// export-core.js and wipe-core.js are not in the initial load batch — nothing
// else here depends on them — but §14 phase 3 changed both against the
// dropped activities/chores/events stores, so they are exercised the same way
// pairing.js is above.
vm.runInThisContext(readFileSync(new URL('child-app/js/export-core.js', repo), 'utf8'), { filename: 'export-core.js' });
vm.runInThisContext(readFileSync(new URL('child-app/js/wipe-core.js', repo), 'utf8'), { filename: 'wipe-core.js' });
const { ExportCore, WipeCore } = globalThis;

test('isEligible: resolved and not yet exported', () => {
  assert.equal(ExportCore.isEligible({ status: 'complete', exported: false }), true);
  assert.equal(ExportCore.isEligible({ status: 'waived', exported: false }), true);
  assert.equal(ExportCore.isEligible({ status: 'complete', exported: true }), false);
  assert.equal(ExportCore.isEligible({ status: 'pending', exported: false }), false);
});

test('buildRow sources course and activity type from an activity row; sequenceNumber emits its title', () => {
  // §14 phase 3: the source used to be the received Activity, read out of the
  // now-dropped `activities` store. It is the decorated `assignments` row now.
  //
  // Lesson Recipe slice §9.3: `sequence_no` is gone with the column — the
  // ordinal it used to hold now lives in the title, so the column named
  // `sequenceNumber` emits the title instead.
  const assignmentRow = {
    kind: 'activity', title: 'Level 3', course_name: 'History',
    activity_type: 'Reading', block_hint: 'Morning',
  };
  const record = { activityId: 'a1', date: '2026-08-11', status: 'complete', grade: 90 };
  const out = ExportCore.buildRow(record, assignmentRow, 'Sam', 'Fall 2026');
  assert.deepEqual(out, {
    activityId: 'a1', date: '2026-08-11', course: 'History', activity: 'Level 3',
    activityType: 'Reading', plannedBlock: 'Morning', status: 'complete', grade: 90,
    childName: 'Sam', semesterLabel: 'Fall 2026', sequenceNumber: 'Level 3',
  });
});

test('buildRow blanks course and sequence for a chore, and reads its type off `choreType`', () => {
  // A chore has neither a course nor a sequence — §3 — and its type comes from
  // the decorated row's promoted `choreType`, not the §3.3 `activity_type` column.
  const assignmentRow = {
    kind: 'chore', title: 'Dishes', choreType: 'Daily', block_hint: 'Evening',
    course_name: null, activity_type: null,
  };
  const record = { activityId: 'c1', date: '2026-08-11', status: 'waived', grade: null };
  const out = ExportCore.buildRow(record, assignmentRow, 'Sam', 'Fall 2026');
  assert.equal(out.course, '');
  assert.equal(out.sequenceNumber, '');
  assert.equal(out.activityType, 'Daily');
  assert.equal(out.grade, '', 'no grade is reported as blank, not null');
});

test('WipeCore.isClearable: exported records only', () => {
  assert.equal(WipeCore.isClearable({ exported: true }), true);
  assert.equal(WipeCore.isClearable({ exported: false }), false);
  assert.equal(WipeCore.isClearable({}), false);
});

// ===========================================================  grading-core

test('isGradableActivity: only a lesson activity, mirroring the Worker\'s own gate', () => {
  // resolveGradingContext 400s on anything but kind === 'activity' — the
  // button must agree, or a tap would always round-trip to an error.
  assert.equal(GradingCore.isGradableActivity({ kind: 'activity' }), true);
  assert.equal(GradingCore.isGradableActivity({ kind: 'chore' }), false);
  assert.equal(GradingCore.isGradableActivity(null), false);
});

test('outOfFromItems counts only CORRECT/PARTIAL/INCORRECT, mirroring normalizeScore', () => {
  const items = [
    { verdict: 'CORRECT' }, { verdict: 'PARTIAL' }, { verdict: 'INCORRECT' },
    { verdict: 'BLANK' }, { verdict: 'UNSURE' },
  ];
  assert.equal(GradingCore.outOfFromItems(items), 3);
  assert.equal(GradingCore.outOfFromItems([]), 0);
  assert.equal(GradingCore.outOfFromItems(null), 0);
});

test('percentOf: null on an empty denominator, rounded otherwise', () => {
  assert.equal(GradingCore.percentOf(7, 10), 70);
  assert.equal(GradingCore.percentOf(1, 3), 33);
  assert.equal(GradingCore.percentOf(0, 0), null);
  assert.equal(GradingCore.percentOf(null, 10), null);
});

test('formatProposal reads the POST /api/grading/page shape (score/outOf given directly)', () => {
  const out = GradingCore.formatProposal({
    state: 'proposed', score: 8, outOf: 10, feedback: 'Nice work on the fractions!',
  });
  assert.equal(out.state, 'proposed');
  assert.equal(out.label, 'Submitted — waiting for a parent to check it.');
  assert.equal(out.scoreText, '8 out of 10 (80%)');
  assert.equal(out.feedback, 'Nice work on the fractions!');
});

test('formatProposal reads the GET /api/grading/review shape, recomputing outOf from items', () => {
  // §1.1: the stored row has no `outOf` column — only `items`, from which
  // the denominator has to be rebuilt the same way the Worker built it once.
  const out = GradingCore.formatProposal({
    state: 'accepted', proposedScore: 2,
    items: [{ verdict: 'CORRECT' }, { verdict: 'INCORRECT' }, { verdict: 'UNSURE' }],
  });
  assert.equal(out.label, 'Your parent confirmed this grade.');
  assert.equal(out.scoreText, '2 out of 2 (100%)');
});

test('formatProposal: null in, null out — no proposal to show', () => {
  assert.equal(GradingCore.formatProposal(null), null);
});

test('formatProposal: an unrecognised state still gets a label rather than showing nothing', () => {
  const out = GradingCore.formatProposal({ state: 'overridden', score: 5, outOf: 10 });
  assert.equal(out.label, 'Your parent looked at this and changed the grade.');
});

test('errorMessage: a 422 passes the server\'s own wording through (already worded for a parent)', () => {
  assert.equal(
    GradingCore.errorMessage(422, 'No answer key has been uploaded for this lesson yet. Ask a parent to add one.'),
    'No answer key has been uploaded for this lesson yet. Ask a parent to add one.'
  );
});

test('errorMessage: everything else gets kid-facing copy, not a raw status code', () => {
  assert.equal(GradingCore.errorMessage(413), "That photo is too big. Try again with a smaller picture.");
  assert.equal(GradingCore.errorMessage(404), "Couldn't find that assignment to grade.");
  assert.equal(GradingCore.errorMessage(401), "This device needs to be paired again — ask a parent.");
  assert.equal(GradingCore.errorMessage(502), "Couldn't grade that right now. Try again in a bit.");
});

test('errorMessage: §12.6\'s combined-request 413 passes the server\'s "which side is over" wording through, same as 422', () => {
  assert.equal(
    GradingCore.errorMessage(413, 'Grading request too large: answer key is 9000000 bytes, photographed pages total ' +
      '15000000 bytes, combined limit is 20000000 bytes. The photographed pages are the larger contributor — retake with fewer or smaller pages.'),
    'Grading request too large: answer key is 9000000 bytes, photographed pages total ' +
      '15000000 bytes, combined limit is 20000000 bytes. The photographed pages are the larger contributor — retake with fewer or smaller pages.'
  );
});

test('MAX_GRADING_PAGES mirrors the Worker\'s per-assignment page cap (§12.6)', () => {
  assert.equal(GradingCore.MAX_GRADING_PAGES, 12);
});
