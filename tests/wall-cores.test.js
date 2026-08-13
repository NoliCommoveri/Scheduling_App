// Tests for the Wall App's pure cores (TDS_Slice_Wall_Display_App.md §12).
// Phase 2 landed pin-core.js only; Phase 3 adds events-core.js,
// chores-core.js (which completed-core.js depends on) and completed-core.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
for (const file of ['pin-core.js', 'events-core.js', 'chores-core.js', 'completed-core.js']) {
  vm.runInThisContext(readFileSync(new URL(`wall-app/js/${file}`, repo), 'utf8'), { filename: file });
}
const { PinCore, EventsCore, ChoresCore, CompletedCore } = globalThis;

// ===========================================================  hashing (§12.8)

test('createPinRecord + verifyPin round-trips', async () => {
  const record = await PinCore.createPinRecord('4242');
  assert.equal(await PinCore.verifyPin('4242', record), true);
  assert.equal(await PinCore.verifyPin('9999', record), false);
});

test('the same PIN with a different salt hashes differently', async () => {
  const a = await PinCore.createPinRecord('1234');
  const b = await PinCore.createPinRecord('1234');
  assert.notEqual(a.pinSalt, b.pinSalt);
  assert.notEqual(a.pinHash, b.pinHash);
});

test('a child with no PIN row is gated-but-unopenable, never "no PIN required" (§4.6)', async () => {
  assert.equal(PinCore.hasPin(null), false);
  assert.equal(PinCore.hasPin({ childId: 'c1' }), false);
  const record = await PinCore.createPinRecord('1234');
  assert.equal(PinCore.hasPin(record), true);
  // A record with no PIN set never verifies open, whatever is typed.
  assert.equal(await PinCore.verifyPin('1234', { childId: 'c1' }), false);
});

// ===========================================================  lockout (§12.7)

test('five failures locks the tile for 60s; a sixth extends nothing new', () => {
  const now = 1_000_000;
  let record = { childId: 'c1', failCount: 0, lockedUntil: null };
  for (let i = 0; i < 4; i++) {
    record = PinCore.recordFailure(record, now);
    assert.equal(PinCore.isLocked(record, now), false);
  }
  record = PinCore.recordFailure(record, now); // 5th failure
  assert.equal(record.failCount, 5);
  assert.equal(PinCore.isLocked(record, now), true);
  assert.equal(PinCore.isLocked(record, now + PinCore.LOCKOUT_MS - 1), true);
  assert.equal(PinCore.isLocked(record, now + PinCore.LOCKOUT_MS), false);
});

test('expiry unlocks; a correct PIN resets the counter', () => {
  const now = 1_000_000;
  let record = { childId: 'c1', failCount: 5, lockedUntil: now + PinCore.LOCKOUT_MS };
  assert.equal(PinCore.isLocked(record, now + PinCore.LOCKOUT_MS + 1), false);
  record = PinCore.recordSuccess(record);
  assert.equal(record.failCount, 0);
  assert.equal(record.lockedUntil, null);
});

// ===========================================================  events-core (§7)

test('an event assigned to three children unions to one line per date', () => {
  const rows = ['a', 'b', 'c'].map((cid) => ({
    id: 'row-' + cid, child_id: cid, kind: 'event', date: '2026-08-13',
    source_id: 'evt-1', title: 'Family movie night', payload: '{}',
  }));
  const events = EventsCore.eventsOn(rows, '2026-08-13');
  assert.equal(events.length, 1);
});

test('a multi-day event appears on every day it spans, with the right Day N of M', () => {
  const row = {
    id: 'r1', child_id: 'a', kind: 'event', date: '2026-08-14', source_id: 'evt-2',
    title: 'Grandma visiting', payload: JSON.stringify({ startDate: '2026-08-13', endDate: '2026-08-16' }),
  };
  assert.equal(EventsCore.eventTouches(row, '2026-08-12'), false);
  assert.equal(EventsCore.eventTouches(row, '2026-08-13'), true);
  assert.equal(EventsCore.eventTouches(row, '2026-08-16'), true);
  assert.equal(EventsCore.eventTouches(row, '2026-08-17'), false);
  assert.equal(EventsCore.spanLabel(row, '2026-08-14'), 'Day 2 of 4');
});

test('a single-day event has no span label', () => {
  const row = { id: 'r1', kind: 'event', date: '2026-08-13', source_id: 'evt-3', payload: '{}' };
  assert.equal(EventsCore.spanLabel(row, '2026-08-13'), null);
});

test('an event assigned only to an archived child is absent once its rows drop out of the map', () => {
  // The wall's day map only ever holds active children's rows (§7) — an
  // archived child's rows simply never arrive, so the union sees nothing.
  const rows = [];
  assert.deepEqual(EventsCore.eventsOn(rows, '2026-08-13'), []);
});

test('timed events sort before untimed ones', () => {
  const rows = [
    { id: 'r1', kind: 'event', date: '2026-08-13', source_id: 'e1', title: 'No time', payload: '{}' },
    { id: 'r2', kind: 'event', date: '2026-08-13', source_id: 'e2', title: 'Has time', payload: JSON.stringify({ time: '3:00 PM' }) },
  ];
  const sorted = EventsCore.eventsOn(rows, '2026-08-13');
  assert.equal(sorted[0].source_id, 'e2');
  assert.equal(sorted[1].source_id, 'e1');
});

test('upcoming groups by day and omits days with nothing on them', () => {
  const rows = [
    { id: 'r1', kind: 'event', date: '2026-08-15', source_id: 'e1', title: 'Dentist', payload: '{}' },
  ];
  const days = EventsCore.upcoming(rows, ['2026-08-14', '2026-08-15', '2026-08-16']);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-08-15');
});

// ===========================================================  chores-core (§5.1.1)

test('a chore deferred to tomorrow is off today\'s list; one pending from yesterday rolls forward', () => {
  const deferred = { id: 'd1', child_id: 'c1', kind: 'chore', date: '2026-08-13', deferred_to: '2026-08-14', status: 'pending', payload: '{}' };
  const overdue = { id: 'o1', child_id: 'c1', kind: 'chore', date: '2026-08-12', status: 'pending', payload: '{}' };
  assert.equal(ChoresCore.onToday(deferred, '2026-08-13'), false);
  assert.equal(ChoresCore.onToday(overdue, '2026-08-13'), true);
});

test('a completed overdue chore does not keep rolling forward once it is done', () => {
  const row = { id: 'o1', child_id: 'c1', kind: 'chore', date: '2026-08-10', status: 'complete', payload: '{}' };
  assert.equal(ChoresCore.onToday(row, '2026-08-13'), false);
});

test('a chore due exactly today counts whether pending or complete', () => {
  const pending = { id: 'p1', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' };
  const complete = { id: 'c1x', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', payload: '{}' };
  assert.equal(ChoresCore.onToday(pending, '2026-08-13'), true);
  assert.equal(ChoresCore.onToday(complete, '2026-08-13'), true);
});

test('todayForChild counts n (pending) and m (pending + complete) for one child only', () => {
  const rows = [
    { id: 'p1', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' },
    { id: 'p2', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', payload: '{}' },
    { id: 'p3', child_id: 'c2', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' }, // other child
    { id: 'p4', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', rescinded_at: 1, payload: '{}' },
    { id: 'p5', child_id: 'c1', kind: 'activity', date: '2026-08-13', status: 'pending', payload: '{}' }, // not a chore
  ];
  const counts = ChoresCore.todayForChild(rows, 'c1', '2026-08-13');
  assert.equal(counts.n, 1);
  assert.equal(counts.m, 2);
});

test('claimState: open, mine, and claimed-by-sibling', () => {
  const open = { claimed_by: null };
  const mine = { claimed_by: 'c1' };
  const sibling = { claimed_by: 'c2' };
  assert.equal(ChoresCore.claimState(open, 'c1'), 'open');
  assert.equal(ChoresCore.claimState(mine, 'c1'), 'mine');
  assert.equal(ChoresCore.claimState(sibling, 'c1'), 'claimed-by-sibling');
});

// ===========================================================  completed-core (§6.7)

test('Done Today lists complete chores across children, newest first', () => {
  const rows = [
    { id: 'a', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', completed_at: 1000, title: 'Feed the cat', payload: '{}' },
    { id: 'b', child_id: 'c2', kind: 'chore', date: '2026-08-13', status: 'complete', completed_at: 2000, title: 'Take bins out', payload: '{}' },
  ];
  const byId = { c1: { id: 'c1', name: 'Talia' }, c2: { id: 'c2', name: 'Ellie' } };
  const done = CompletedCore.doneToday(rows, '2026-08-13', byId);
  assert.deepEqual(done.map((r) => r.id), ['b', 'a']);
  assert.equal(done[0].childName, 'Ellie');
});

test('a complete row with no completed_at is included, not hidden, and sorts last', () => {
  const rows = [
    { id: 'a', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', completed_at: 1000, title: 'Feed the cat', payload: '{}' },
    { id: 'b', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', completed_at: null, title: 'Mystery chore', payload: '{}' },
  ];
  const done = CompletedCore.doneToday(rows, '2026-08-13', {});
  assert.equal(done.length, 2);
  assert.equal(done[1].id, 'b');
  assert.equal(done[1].completedAt, null);
});

test('Done Today excludes activities, events, rescinded rows, and chores not due today', () => {
  const rows = [
    { id: 'act', child_id: 'c1', kind: 'activity', date: '2026-08-13', status: 'complete', completed_at: 1, title: 'Math', payload: '{}' },
    { id: 'evt', child_id: 'c1', kind: 'event', date: '2026-08-13', status: 'complete', completed_at: 1, title: 'Party', payload: '{}' },
    { id: 'resc', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', completed_at: 1, rescinded_at: 2, title: 'Old', payload: '{}' },
    { id: 'stale', child_id: 'c1', kind: 'chore', date: '2026-08-01', status: 'complete', completed_at: 1, title: 'Long done', payload: '{}' },
  ];
  const done = CompletedCore.doneToday(rows, '2026-08-13', {});
  assert.deepEqual(done, []);
});
