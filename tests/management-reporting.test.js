// Tests for the Management App's report arithmetic (reporting.js) and the
// Assignments view's pure helpers (assignments.js).
//
// Both are browser scripts that define a top-level `const`, so they are
// evaluated with a trailing export line rather than imported. Only the functions
// that touch neither the DOM nor the network are exercised; rendering is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const Reporting = loadModule('management-app/js/reporting.js', 'Reporting');
const Assignments = loadModule('management-app/js/assignments.js', 'Assignments');

function row(overrides = {}) {
  return {
    id: 'a1', date: '2026-08-11', kind: 'activity', batch_id: 'B1',
    title: 'Read chapter 4', course_name: 'History', status: 'pending',
    completed_at: null, grade: null, deferred_to: null, rescinded_at: null,
    sort_order: 0, assigned_at: 1000,
    ...overrides,
  };
}

// ==========================================================  summarize

test('summarize counts each outcome once', () => {
  const t = Reporting.summarize([
    row({ id: '1', status: 'complete' }),
    row({ id: '2', status: 'waived' }),
    row({ id: '3', status: 'pending' }),
  ]);
  assert.equal(t.assigned, 3);
  assert.equal(t.complete, 1);
  assert.equal(t.waived, 1);
  assert.equal(t.pending, 1);
  assert.equal(t.completionRate, 1 / 3);
});

test('summarize counts a rescinded row separately and not as unfinished', () => {
  const t = Reporting.summarize([
    row({ id: '1', status: 'complete' }),
    row({ id: '2', rescinded_at: 5 }),
  ]);
  assert.equal(t.rescinded, 1);
  assert.equal(t.assigned, 1, 'a pulled row was not assigned work in the end');
  assert.equal(t.completionRate, 1, 'and must not drag the rate down');
});

test('§6.4: a rescinded row the child completed counts as completed', () => {
  // The work happened and the reward stands; only the parent\'s pull is extra.
  const t = Reporting.summarize([row({ status: 'complete', rescinded_at: 5 })]);
  assert.equal(t.complete, 1);
  assert.equal(t.rescinded, 0);
});

test('events are never scored — a holiday must not make a kid look behind', () => {
  const t = Reporting.summarize([
    row({ id: '1', kind: 'activity', status: 'complete' }),
    row({ id: '2', kind: 'event' }),
  ]);
  assert.equal(t.events, 1);
  assert.equal(t.scorable, 1);
  assert.equal(t.completionRate, 1, 'the event is outside the denominator');
});

test('a range with only events has no completion rate at all', () => {
  const t = Reporting.summarize([row({ kind: 'event' })]);
  assert.equal(t.completionRate, null, 'null, not 0 — there was nothing to do');
});

test('summarize averages only graded rows', () => {
  const t = Reporting.summarize([
    row({ id: '1', status: 'complete', grade: 90 }),
    row({ id: '2', status: 'complete', grade: 80 }),
    row({ id: '3', status: 'complete' }),
  ]);
  assert.equal(t.graded, 2);
  assert.equal(t.averageGrade, 85);
});

test('summarize reports a zero grade rather than treating it as missing', () => {
  const t = Reporting.summarize([row({ status: 'complete', grade: 0 })]);
  assert.equal(t.graded, 1);
  assert.equal(t.averageGrade, 0);
});

test('summarize of nothing is all zeroes and no rates', () => {
  const t = Reporting.summarize([]);
  assert.equal(t.assigned, 0);
  assert.equal(t.completionRate, null);
  assert.equal(t.averageGrade, null);
});

test('summarize counts child deferments', () => {
  const t = Reporting.summarize([row({ deferred_to: '2026-08-14' })]);
  assert.equal(t.deferred, 1);
});

// ===================================================  Shared Chores §9

test('isClaimedElsewhere needs no child id passed in — the row answers itself', () => {
  const won = row({ id: '1', child_id: 'CH-1', claim_group: 'G1', claimed_by: 'CH-1' });
  const lost = row({ id: '2', child_id: 'CH-2', claim_group: 'G1', claimed_by: 'CH-1' });
  const unclaimed = row({ id: '3', child_id: 'CH-1', claim_group: 'G1', claimed_by: null });
  const notShared = row({ id: '4', child_id: 'CH-1' });
  assert.equal(Reporting.isClaimedElsewhere(won), false);
  assert.equal(Reporting.isClaimedElsewhere(lost), true);
  assert.equal(Reporting.isClaimedElsewhere(unclaimed), false);
  assert.equal(Reporting.isClaimedElsewhere(notShared), false);
});

test('summarize counts a lost claim as assigned but neither pending nor missed', () => {
  const t = Reporting.summarize([
    row({ id: '1', child_id: 'CH-1', status: 'complete' }),
    row({ id: '2', child_id: 'CH-2', claim_group: 'G1', claimed_by: 'CH-1' }),
  ]);
  assert.equal(t.assigned, 2, 'still counted — it was assigned once');
  assert.equal(t.claimedBySibling, 1);
  assert.equal(t.pending, 0, 'not counted as outstanding work the loser owes');
  assert.equal(t.scorable, 1, 'excluded from the denominator, same treatment as events');
  assert.equal(t.completionRate, 1, 'the loser is not penalized for a chore they never had a chance to do');
});

// ===========================================================  byCourse

test('byCourse groups activities by course and buckets the rest', () => {
  const groups = Reporting.byCourse([
    row({ id: '1', kind: 'activity', course_name: 'History', status: 'complete' }),
    row({ id: '2', kind: 'activity', course_name: 'Maths' }),
    row({ id: '3', kind: 'chore', course_name: null }),
    row({ id: '4', kind: 'event', course_name: null }),
  ]);
  const names = groups.map((g) => g.name);
  assert.deepEqual(names, ['(chores)', '(events)', 'History', 'Maths']);
  assert.equal(groups.find((g) => g.name === 'History').completionRate, 1);
});

test('byCourse labels an activity with no course rather than dropping it', () => {
  const groups = Reporting.byCourse([row({ course_name: null })]);
  assert.deepEqual(groups.map((g) => g.name), ['(no course)']);
});

test('byCourse leaves rescinded rows out entirely', () => {
  const groups = Reporting.byCourse([row({ rescinded_at: 5 })]);
  assert.equal(groups.length, 0);
});

test('byCourse gives the events bucket no completion rate', () => {
  const groups = Reporting.byCourse([row({ kind: 'event' })]);
  assert.equal(groups[0].completionRate, null);
});

test('byCourse excludes a lost claim from its group\'s completion rate denominator', () => {
  const groups = Reporting.byCourse([
    row({ id: '1', kind: 'chore', course_name: null, child_id: 'CH-1', status: 'complete' }),
    row({ id: '2', kind: 'chore', course_name: null, child_id: 'CH-2', claim_group: 'G1', claimed_by: 'CH-1' }),
  ]);
  const chores = groups.find((g) => g.name === '(chores)');
  assert.equal(chores.assigned, 2);
  assert.equal(chores.claimedBySibling, 1);
  assert.equal(chores.pending, 0);
  assert.equal(chores.completionRate, 1);
});

// ================================================================  CSV

test('toCsv quotes cells containing commas, quotes or newlines', () => {
  const csv = Reporting.toCsv([row({ title: 'Read "Ch 4", then rest' })]);
  const [header, line] = csv.split('\n');
  assert.ok(header.startsWith('date,kind,title'));
  assert.ok(line.includes('"Read ""Ch 4"", then rest"'));
});

test('toCsv reports a rescinded row as rescinded rather than pending', () => {
  const csv = Reporting.toCsv([row({ rescinded_at: 5 })]);
  assert.ok(csv.split('\n')[1].includes('rescinded'));
});

test('toCsv reports a lost claim as claimed-by-sibling rather than pending', () => {
  const csv = Reporting.toCsv([row({ child_id: 'CH-2', claim_group: 'G1', claimed_by: 'CH-1' })]);
  assert.ok(csv.split('\n')[1].includes('claimed-by-sibling'));
});

test('toCsv emits a header even with no rows', () => {
  assert.equal(Reporting.toCsv([]).split('\n').length, 1);
});

// Child Feedback Loop §5.4 — the same read-only surface as grade.
test('toCsv includes completion_note alongside grade', () => {
  const csv = Reporting.toCsv([row({ status: 'complete', grade: 90, completion_note: 'skipped #11' })]);
  const [header, line] = csv.split('\n');
  assert.ok(header.includes('grade'));
  assert.ok(header.includes('completion_note'));
  assert.ok(line.includes('skipped #11'));
});

// =================================================  Assignments helpers

test('a row is editable only while pending and not rescinded', () => {
  assert.equal(Assignments.isEditable(row()), true);
  assert.equal(Assignments.isEditable(row({ status: 'complete' })), false);
  assert.equal(Assignments.isEditable(row({ status: 'waived' })), false);
  assert.equal(Assignments.isEditable(row({ rescinded_at: 5 })), false);
});

test('rescindable matches the server\'s own guard', () => {
  // §6.3's SQL re-checks `rescinded_at IS NULL AND status = 'pending'`, so a
  // stale screen can only ever under-act.
  assert.equal(Assignments.isRescindable(row()), true);
  assert.equal(Assignments.isRescindable(row({ status: 'complete' })), false);
  assert.equal(Assignments.isRescindable(row({ rescinded_at: 5 })), false);
});

// §3.5: the row already carries the fact — `claimed_by` is written to every
// live row in the group the instant the claim is arbitrated. This view was the
// last consumer that never read it.
test('a sibling-claimed row is claimed-elsewhere; the winner\'s own row is not', () => {
  assert.equal(
    Assignments.isClaimedElsewhere(row({ child_id: 'CH-2', claimed_by: 'CH-1' })),
    true
  );
  assert.equal(
    Assignments.isClaimedElsewhere(row({ child_id: 'CH-1', claimed_by: 'CH-1' })),
    false
  );
  // Nobody claimed it: a shared chore neither child did is still outstanding
  // on both rows (§7.8).
  assert.equal(Assignments.isClaimedElsewhere(row({ child_id: 'CH-2' })), false);
});

test('a sibling-claimed row is neither editable nor rescindable', () => {
  // There is nothing left to edit or pull back on work a sibling already did —
  // and since §3.5a the server refuses it too, so the button count and the
  // `Rescinded N` response agree.
  const lost = row({ child_id: 'CH-2', claimed_by: 'CH-1', status: 'pending' });
  assert.equal(Assignments.isEditable(lost), false);
  assert.equal(Assignments.isRescindable(lost), false);
});

test('an unclaimed shared chore stays editable and rescindable', () => {
  const open = row({ child_id: 'CH-2', claimed_by: null, status: 'pending' });
  assert.equal(Assignments.isEditable(open), true);
  assert.equal(Assignments.isRescindable(open), true);
});

test('groupByBatch orders batches newest first', () => {
  const groups = Assignments.groupByBatch([
    row({ id: '1', batch_id: 'old', assigned_at: 1000 }),
    row({ id: '2', batch_id: 'new', assigned_at: 5000 }),
    row({ id: '3', batch_id: 'new', assigned_at: 5000 }),
  ]);
  assert.deepEqual(groups.map((g) => g.batchId), ['new', 'old']);
  assert.equal(groups[0].rows.length, 2);
});

test('groupByBatch takes a batch\'s time from its earliest row', () => {
  const groups = Assignments.groupByBatch([
    row({ id: '1', batch_id: 'B1', assigned_at: 9000 }),
    row({ id: '2', batch_id: 'B1', assigned_at: 3000 }),
  ]);
  assert.equal(groups[0].assignedAt, 3000);
});

test('groupByBatch keeps rows with no batch together', () => {
  const groups = Assignments.groupByBatch([row({ batch_id: null })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].batchId, null);
});
