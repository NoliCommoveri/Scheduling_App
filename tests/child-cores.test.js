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
const repo = new URL('../', import.meta.url);
for (const file of ['outbox-core.js', 'assignment-core.js', 'completion-core.js', 'reward-core.js', 'settings-core.js']) {
  vm.runInThisContext(readFileSync(new URL(`child-app/js/${file}`, repo), 'utf8'), { filename: file });
}
const { OutboxCore, AssignmentCore, CompletionCore, RewardCore, SettingsCore } = globalThis;

// A row as /api/plan returns it (§3.3, snake_case).
function row(overrides = {}) {
  return {
    id: 'a1', child_id: 'CH-1', date: '2026-08-11', kind: 'activity', batch_id: 'b1',
    source_id: 'ACT-1', title: 'Read chapter 4', course_name: 'History',
    activity_type: 'Reading', sequence_no: null, payload: null,
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

test('sanitizeFields drops undefined but keeps null', () => {
  // Clearing a deferment is a real write of NULL, not an absence.
  const out = OutboxCore.sanitizeFields({ deferredTo: null, grade: undefined, status: 'complete' });
  assert.deepEqual(out, { deferredTo: null, status: 'complete' });
});

test('completionFieldsFromMeta renames plannerMeta to the column vocabulary', () => {
  assert.deepEqual(
    OutboxCore.completionFieldsFromMeta({ deferredDate: '2026-08-14', blockHint: 'Afternoon', sortOrder: 5 }),
    { deferredTo: '2026-08-14', childBlockHint: 'Afternoon', childSortOrder: 5 }
  );
  assert.deepEqual(OutboxCore.completionFieldsFromMeta({ unknownKey: 1 }), {});
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

test('toState partitions rows by kind into the pre-revamp shape', () => {
  const state = AssignmentCore.toState([
    row({ id: 'a1', kind: 'activity' }),
    row({ id: 'c1', kind: 'chore', title: 'Dishes' }),
    row({ id: 'e1', kind: 'event', title: 'Dentist', source_id: 'EV-1' }),
  ]);
  assert.deepEqual(Object.keys(state).sort(), ['activities', 'chores', 'events', 'meta']);
  assert.equal(state.activities.length, 1);
  assert.equal(state.chores.length, 1);
  assert.equal(state.events.length, 1);
});

test('toState de-duplicates a multi-day event to one entry', () => {
  // A multi-day event is committed as one row per in-range day; planner-core
  // matches on the span, so all of them would render the event once per day.
  const payload = JSON.stringify({ startDate: '2026-08-11', endDate: '2026-08-13' });
  const state = AssignmentCore.toState([
    row({ id: 'e1', kind: 'event', source_id: 'EV-1', date: '2026-08-11', payload }),
    row({ id: 'e2', kind: 'event', source_id: 'EV-1', date: '2026-08-12', payload }),
    row({ id: 'e3', kind: 'event', source_id: 'EV-1', date: '2026-08-13', payload }),
  ]);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].startDate, '2026-08-11');
  assert.equal(state.events[0].endDate, '2026-08-13');
});

test('toState ignores an unknown kind rather than crashing', () => {
  const state = AssignmentCore.toState([row({ id: 'x1', kind: 'somethingNew' })]);
  assert.equal(state.activities.length + state.chores.length + state.events.length, 0);
});

test('toState promotes payload fields and leaves them out of the payload', () => {
  const state = AssignmentCore.toState([row({
    payload: JSON.stringify({
      kind: 'pageRange', pageRangeStart: 10, pageRangeEnd: 20,
      required: true, capturesGrade: true, difficultyTier: 'T2', instructions: 'Skim it',
    }),
  })]);
  const item = state.activities[0];
  assert.equal(item.required, true);
  assert.equal(item.capturesGrade, true);
  assert.equal(item.difficultyTier, 'T2');
  assert.equal(item.instructions, 'Skim it');
  assert.equal(item.payload.pageRangeStart, 10);
  assert.ok(!('required' in item.payload), 'promoted fields must not be duplicated in payload');
  assert.ok(!('instructions' in item.payload));
});

test('toState treats an absent chore `required` as true', () => {
  // Chores are always required; absent must not read as false, or the child
  // loses their Reschedule/Waive controls on an older row.
  const state = AssignmentCore.toState([row({ id: 'c1', kind: 'chore', payload: JSON.stringify({}) })]);
  assert.equal(state.chores[0].required, true);
});

test('toState synthesises meta only from child-owned columns, and stays sparse', () => {
  const bare = AssignmentCore.toState([row()]);
  assert.deepEqual(bare.meta, Object.create(null), 'no override means no meta entry');

  const overridden = AssignmentCore.toState([row({
    deferred_to: '2026-08-14', child_block_hint: 'Afternoon', child_sort_order: 9,
  })]);
  assert.deepEqual(overridden.meta.a1, {
    deferredDate: '2026-08-14', blockHint: 'Afternoon', sortOrder: 9, id: 'a1',
  });
});

test('toState maps sort_order into receiptIndex (§3.3.3 read half)', () => {
  assert.equal(AssignmentCore.toState([row({ sort_order: 4 })]).activities[0].receiptIndex, 4);
  assert.equal(AssignmentCore.toState([row({ sort_order: null })]).activities[0].receiptIndex, 0);
});

test('toState omits optional fields rather than setting them empty', () => {
  // Several planner-ui branches key off presence and would render an empty
  // element for "".
  const item = AssignmentCore.toState([row({ course_name: null, activity_type: null, block_hint: null })]).activities[0];
  assert.ok(!('courseName' in item));
  assert.ok(!('activityType' in item));
  assert.ok(!('blockHint' in item));
});

test('parsePayload survives null, objects and malformed JSON', () => {
  assert.deepEqual(AssignmentCore.parsePayload(null), {});
  assert.deepEqual(AssignmentCore.parsePayload('{"a":1}'), { a: 1 });
  assert.deepEqual(AssignmentCore.parsePayload({ a: 1 }), { a: 1 });
  assert.deepEqual(AssignmentCore.parsePayload('{not json'), {});
});

// =======================================================  completion-core

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
