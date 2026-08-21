// Tests for the Wall App's pure cores. Phase 2 (TDS_Slice_Wall_Display_App.md
// §12) landed pin-core.js only. Wall Calendar Redesign §14 Phase 3 adds
// events-core.js, chores-core.js (generalized past "today", §4.5),
// slots-core.js (§3.1/§3.5.1) and time-core.js (§11.3), and retires
// completed-core.js — the Done Today board it backed is repealed (§8.4).
// §16 Phase 4 adds chores-core.js's block classification (§4.4). §16 Phase 5
// adds slots-core.js's collision check (§9) — the write path itself (the
// drag/tap gestures, the API calls) lives in day-ui.js/api.js, which do DOM
// and network IO and so are exercised manually (§13's acceptance checks),
// not here. §16 Phase 5b adds slots-core.js's assignedDurationMin and
// time-core.js's formatDurationMin — the duration-adjust sheet's own DOM
// wiring stays in day-ui.js, exercised manually alongside Phase 5's.
// §16 Phase 8 adds month-core.js (§7.1's grid shape, its 42-day fetch
// window, and the per-cell overflow split). §14.7's "events dedupe,
// unchanged behaviour, re-asserted against the new month window" is
// asserted through it rather than beside it: the month grid calls
// EventsCore.eventsOn once per cell and carries no dedupe of its own, so
// the month-window assertions below exercise that same function.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
for (const file of ['pin-core.js', 'events-core.js', 'chores-core.js', 'slots-core.js', 'school-core.js', 'time-core.js', 'remind-core.js', 'month-core.js']) {
  vm.runInThisContext(readFileSync(new URL(`wall-app/js/${file}`, repo), 'utf8'), { filename: file });
}
const { PinCore, EventsCore, ChoresCore, SlotsCore, SchoolCore, TimeCore, RemindCore, MonthCore } = globalThis;

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

// ===========================================================  chores-core (§4.5)

test('a chore deferred to tomorrow is off today\'s list; one pending from yesterday rolls forward onto today', () => {
  const deferred = { id: 'd1', child_id: 'c1', kind: 'chore', date: '2026-08-13', deferred_to: '2026-08-14', status: 'pending', payload: '{}' };
  const overdue = { id: 'o1', child_id: 'c1', kind: 'chore', date: '2026-08-12', status: 'pending', payload: '{}' };
  assert.equal(ChoresCore.onDate(deferred, '2026-08-13', '2026-08-13'), false);
  assert.equal(ChoresCore.onDate(overdue, '2026-08-13', '2026-08-13'), true);
});

test('a completed overdue chore does not keep rolling forward once it is done', () => {
  const row = { id: 'o1', child_id: 'c1', kind: 'chore', date: '2026-08-10', status: 'complete', payload: '{}' };
  assert.equal(ChoresCore.onDate(row, '2026-08-13', '2026-08-13'), false);
});

test('a chore due exactly on the rendered date counts whether pending or complete', () => {
  const pending = { id: 'p1', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' };
  const complete = { id: 'c1x', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', payload: '{}' };
  assert.equal(ChoresCore.onDate(pending, '2026-08-13', '2026-08-13'), true);
  assert.equal(ChoresCore.onDate(complete, '2026-08-13', '2026-08-13'), true);
});

test('§4.5 — no roll-forward when the rendered date is in the past, even though today would show it', () => {
  // A chore due 2026-08-10, still pending, actual today is 2026-08-13. It IS
  // on today's board (roll-forward), but rendering *last Tuesday* (08-11)
  // must not show it — otherwise scrolling back through the week would show
  // the same overdue chore on every day at once.
  const row = { id: 'o1', child_id: 'c1', kind: 'chore', date: '2026-08-10', status: 'pending', payload: '{}' };
  assert.equal(ChoresCore.onDate(row, '2026-08-13', '2026-08-13'), true);
  assert.equal(ChoresCore.onDate(row, '2026-08-11', '2026-08-13'), false);
  assert.equal(ChoresCore.onDate(row, '2026-08-10', '2026-08-13'), true); // its own due date, any day
});

test('choresForChild filters to one child\'s non-rescinded chores on the rendered date, complete included', () => {
  const rows = [
    { id: 'p1', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' },
    { id: 'p2', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'complete', payload: '{}' },
    { id: 'p3', child_id: 'c2', kind: 'chore', date: '2026-08-13', status: 'pending', payload: '{}' }, // other child
    { id: 'p4', child_id: 'c1', kind: 'chore', date: '2026-08-13', status: 'pending', rescinded_at: 1, payload: '{}' },
    { id: 'p5', child_id: 'c1', kind: 'activity', date: '2026-08-13', status: 'pending', payload: '{}' }, // not a chore
  ];
  const list = ChoresCore.choresForChild(rows, 'c1', '2026-08-13', '2026-08-13');
  assert.deepEqual(list.map((r) => r.id), ['p1', 'p2']);
});

test('claimState: open, mine, and claimed-by-sibling', () => {
  const open = { claimed_by: null };
  const mine = { claimed_by: 'c1' };
  const sibling = { claimed_by: 'c2' };
  assert.equal(ChoresCore.claimState(open, 'c1'), 'open');
  assert.equal(ChoresCore.claimState(mine, 'c1'), 'mine');
  assert.equal(ChoresCore.claimState(sibling, 'c1'), 'claimed-by-sibling');
});

// ===========================================================  chores-core: block mode (§4.4)

test('effectiveBlockHint mirrors planner-core.js:54-56: child_block_hint wins, then block_hint, then morning', () => {
  assert.equal(ChoresCore.effectiveBlockHint({ child_block_hint: 'evening', block_hint: 'morning' }), 'evening');
  assert.equal(ChoresCore.effectiveBlockHint({ block_hint: 'afternoon' }), 'afternoon');
  assert.equal(ChoresCore.effectiveBlockHint({}), 'morning');
  assert.equal(ChoresCore.effectiveBlockHint({ child_block_hint: 'bogus', block_hint: 'night' }), 'night'); // an invalid hint is not canonical
});

test('blockFromStartMin classifies every boundary hour in the §4.4 table, including the night wrap', () => {
  assert.equal(ChoresCore.blockFromStartMin(5 * 60 + 59), 'night');   // 05:59
  assert.equal(ChoresCore.blockFromStartMin(6 * 60), 'morning');       // 06:00
  assert.equal(ChoresCore.blockFromStartMin(11 * 60 + 59), 'morning'); // 11:59
  assert.equal(ChoresCore.blockFromStartMin(12 * 60), 'afternoon');    // 12:00
  assert.equal(ChoresCore.blockFromStartMin(16 * 60 + 59), 'afternoon');
  assert.equal(ChoresCore.blockFromStartMin(17 * 60), 'evening');      // 17:00
  assert.equal(ChoresCore.blockFromStartMin(20 * 60 + 59), 'evening');
  assert.equal(ChoresCore.blockFromStartMin(21 * 60), 'night');        // 21:00
  assert.equal(ChoresCore.blockFromStartMin(23 * 60 + 59), 'night');
  assert.equal(ChoresCore.blockFromStartMin(0), 'night');              // 00:00 — the wrap
});

test('blockForChip: the placement wins over the hint for a placed chip; the hint decides an unplaced one (§4.4)', () => {
  const row = { block_hint: 'morning' };
  const placed = { startMin: 18 * 60, durationMin: 15, overridden: false }; // 18:00 -> evening
  const unplaced = { startMin: null, durationMin: 15, overridden: false };
  assert.equal(ChoresCore.blockForChip(row, placed), 'evening');
  assert.equal(ChoresCore.blockForChip(row, unplaced), 'morning');
});

test('blockVirtualMin maps a real clock minute into a block\'s own coordinate space, wrapping only for night', () => {
  assert.equal(ChoresCore.blockVirtualMin(9 * 60, 'morning'), 9 * 60); // no wrap needed, passes through
  assert.equal(ChoresCore.blockVirtualMin(21 * 60 + 30, 'night'), 21 * 60 + 30); // already >= night's start
  assert.equal(ChoresCore.blockVirtualMin(5 * 60 + 30, 'night'), 5 * 60 + 30 + 1440); // wraps past midnight
  // The wrap keeps ordering correct: a chip placed just after midnight sorts
  // later in the night block's own axis than one placed just before it.
  const justBefore = ChoresCore.blockVirtualMin(23 * 60, 'night');
  const justAfter = ChoresCore.blockVirtualMin(0, 'night');
  assert.ok(justAfter > justBefore);
});

// ===========================================================  slots-core (§3.1, §3.5.1)

test('a chore matches its placement on source_id + instance_key; an unmatched chore is unplaced', () => {
  const slots = [
    { child_id: 'c1', subject_kind: 'chore', subject_key: 'chore-1', instance_key: '', start_min: 480, duration_min: null },
  ];
  const idx = SlotsCore.indexSlots(slots);
  const placed = { child_id: 'c1', source_id: 'chore-1', instance_key: '' };
  const unplaced = { child_id: 'c1', source_id: 'chore-2', instance_key: '' };
  assert.equal(SlotsCore.placementFor(idx, placed).start_min, 480);
  assert.equal(SlotsCore.placementFor(idx, unplaced), null);
});

test('three instances of one chore hold three distinct placements; two sharing a label still resolve separately (§3.1.1)', () => {
  const slots = [
    { child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: 'brk', start_min: 480, duration_min: null },
    { child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: 'lun', start_min: 720, duration_min: null },
    { child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: 'din', start_min: 1080, duration_min: null },
  ];
  const idx = SlotsCore.indexSlots(slots);
  const brk = SlotsCore.placementFor(idx, { child_id: 'c1', source_id: 'dishes', instance_key: 'brk' });
  const lun = SlotsCore.placementFor(idx, { child_id: 'c1', source_id: 'dishes', instance_key: 'lun' });
  assert.equal(brk.start_min, 480);
  assert.equal(lun.start_min, 720);
  assert.notEqual(brk.start_min, lun.start_min);
});

test('§3.1.2 — an each chore resolves each child\'s own placement independently', () => {
  const slots = [
    { child_id: 'ellie', subject_kind: 'chore', subject_key: 'homework', instance_key: '', start_min: 480, duration_min: null },
    { child_id: 'talia', subject_kind: 'chore', subject_key: 'homework', instance_key: '', start_min: 600, duration_min: null },
  ];
  const idx = SlotsCore.indexSlots(slots);
  const ellieRow = { child_id: 'ellie', source_id: 'homework', instance_key: '', claim_group: null };
  const taliaRow = { child_id: 'talia', source_id: 'homework', instance_key: '', claim_group: null };
  assert.equal(SlotsCore.placementFor(idx, ellieRow).start_min, 480);
  assert.equal(SlotsCore.placementFor(idx, taliaRow).start_min, 600);
});

test('§3.1.2 — a claim chore resolves the single child-less row for every participant; changing participants leaves it intact', () => {
  const slots = [
    { child_id: '', subject_kind: 'chore', subject_key: 'cat', instance_key: '', start_min: 990, duration_min: null },
  ];
  const idx = SlotsCore.indexSlots(slots);
  const ellieRow = { child_id: 'ellie', source_id: 'cat', instance_key: '', claim_group: 'grp-1' };
  const taliaRow = { child_id: 'talia', source_id: 'cat', instance_key: '', claim_group: 'grp-1' };
  assert.equal(SlotsCore.placementFor(idx, ellieRow).start_min, 990);
  assert.equal(SlotsCore.placementFor(idx, taliaRow).start_min, 990);
  // A new participant (never in the group before) still finds the one
  // household placement — nothing keys it to a specific child.
  const newcomer = { child_id: 'ravi', source_id: 'cat', instance_key: '', claim_group: 'grp-1' };
  assert.equal(SlotsCore.placementFor(idx, newcomer).start_min, 990);
});

test('§3.1.2 — a claim and an each placement at the same subject key do not collide', () => {
  const slots = [
    { child_id: '', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 600, duration_min: null },
    { child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 900, duration_min: null },
  ];
  const idx = SlotsCore.indexSlots(slots);
  const claimRow = { child_id: 'ellie', source_id: 'dishes', instance_key: '', claim_group: 'grp-2' };
  const eachRow = { child_id: 'ellie', source_id: 'dishes', instance_key: '', claim_group: null };
  assert.equal(SlotsCore.placementFor(idx, claimRow).start_min, 600);
  assert.equal(SlotsCore.placementFor(idx, eachRow).start_min, 900);
});

test('§3.5.1 — the duration chain: per-day beats standing beats the parent\'s estimate beats 15', () => {
  const withEstimate = { source_id: 'bins', instance_key: '', expected_duration_min: 30 };
  const noEstimate = { source_id: 'trash', instance_key: '', expected_duration_min: null };
  assert.equal(SlotsCore.resolveDurationMin(noEstimate, null, null), 15); // row 4 — nothing else to go on
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, null, null), 30); // row 3 — the parent's estimate
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: null }, null), 30); // a cleared standing override still falls to the estimate
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: 45 }, null), 45); // row 2 — standing override
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: 45 }, { duration_min: 10 }), 10); // row 1 — per-day wins
});

test('§3.5.1 — clearing the per-day override falls back exactly one step, not to the bottom', () => {
  const row = { source_id: 'bins', instance_key: '', claim_group: null, expected_duration_min: 30 };
  const withStanding = SlotsCore.resolveDurationMin(row, { duration_min: 45 }, null);
  assert.equal(withStanding, 45); // not 30 or 15 — the standing override still applies
});

test('isOverridden is true with either override present, false with neither', () => {
  assert.equal(SlotsCore.isOverridden(null, null), false);
  assert.equal(SlotsCore.isOverridden({ duration_min: null }, null), false);
  assert.equal(SlotsCore.isOverridden({ duration_min: 45 }, null), true);
  assert.equal(SlotsCore.isOverridden(null, { duration_min: 10 }), true);
});

test('§16 Phase 5b — assignedDurationMin is row 3/4 of the chain in isolation, with no override applied', () => {
  assert.equal(SlotsCore.assignedDurationMin({ expected_duration_min: 30 }), 30);
  assert.equal(SlotsCore.assignedDurationMin({ expected_duration_min: null }), 15);
  assert.equal(SlotsCore.assignedDurationMin({}), 15);
});

// ===========================================================  collisions (§9, §16 Phase 5)

test('isPrivateChore: null claim_group is private, any claim_group is shared', () => {
  assert.equal(SlotsCore.isPrivateChore({ claim_group: null }), true);
  assert.equal(SlotsCore.isPrivateChore({ claim_group: 'grp-1' }), false);
});

test('§9 — two private chores for one child overlapping warns', () => {
  const row = { id: 'a1', child_id: 'ellie', claim_group: null, title: 'Feed the cat' };
  const others = [
    { row: { id: 'a2', child_id: 'ellie', claim_group: null, title: 'Homework' },
      chip: { startMin: 480, durationMin: 30 } },
  ];
  const hit = SlotsCore.findCollision(row, 495, 15, others); // 8:15, overlaps 8:00-8:30
  assert.equal(hit && hit.row.id, 'a2');
});

test('§9 — the same pair for two DIFFERENT children does not warn', () => {
  const row = { id: 'a1', child_id: 'ellie', claim_group: null, title: 'Feed the cat' };
  const others = [
    { row: { id: 'a2', child_id: 'talia', claim_group: null, title: 'Homework' },
      chip: { startMin: 480, durationMin: 30 } },
  ];
  assert.equal(SlotsCore.findCollision(row, 495, 15, others), null);
});

test('§9 — a shared (claim) chore overlapping a private one does not warn, on either side', () => {
  const privateOther = { row: { id: 'a2', child_id: 'ellie', claim_group: null, title: 'Homework' },
    chip: { startMin: 480, durationMin: 30 } };
  const sharedRow = { id: 'a1', child_id: 'ellie', claim_group: 'grp-1', title: 'Set the table' };
  assert.equal(SlotsCore.findCollision(sharedRow, 495, 15, [privateOther]), null);

  const sharedOther = { row: { id: 'a2', child_id: 'ellie', claim_group: 'grp-1', title: 'Set the table' },
    chip: { startMin: 480, durationMin: 30 } };
  const privateRow = { id: 'a1', child_id: 'ellie', claim_group: null, title: 'Homework' };
  assert.equal(SlotsCore.findCollision(privateRow, 495, 15, [sharedOther]), null);
});

test('§9 — partial overlap (4:00+30min vs 4:15) is detected where a slot-equality test would miss it', () => {
  const row = { id: 'a1', child_id: 'ellie', claim_group: null, title: 'Piano practice' };
  const others = [
    { row: { id: 'a2', child_id: 'ellie', claim_group: null, title: 'Reading' },
      chip: { startMin: 16 * 60, durationMin: 30 } }, // 16:00-16:30
  ];
  const hit = SlotsCore.findCollision(row, 16 * 60 + 15, 15, others); // 16:15-16:30 — no shared boundary
  assert.equal(hit && hit.row.id, 'a2');
  // Just after the other ends: no overlap.
  assert.equal(SlotsCore.findCollision(row, 16 * 60 + 30, 15, others), null);
});

test('§9 — the overlap uses the RESOLVED duration, so an override that shortens a chip can clear a warning', () => {
  const row = { id: 'a1', child_id: 'ellie', claim_group: null, title: 'Piano practice' };
  const otherAtFullDuration = [
    { row: { id: 'a2', child_id: 'ellie', claim_group: null, title: 'Reading' },
      chip: { startMin: 480, durationMin: 30 } }, // 8:00-8:30
  ];
  assert.ok(SlotsCore.findCollision(row, 495, 15, otherAtFullDuration)); // 8:15 still inside
  const otherShortened = [
    { row: { id: 'a2', child_id: 'ellie', claim_group: null, title: 'Reading' },
      chip: { startMin: 480, durationMin: 15 } }, // shortened to 8:00-8:15
  ];
  assert.equal(SlotsCore.findCollision(row, 495, 15, otherShortened), null); // 8:15 no longer inside
});

test('rangesOverlap: touching boundaries do not overlap, any real intersection does', () => {
  assert.equal(SlotsCore.rangesOverlap(0, 30, 30, 15), false); // 0-30 and 30-45: adjacent, not overlapping
  assert.equal(SlotsCore.rangesOverlap(0, 30, 29, 15), true); // 0-30 and 29-44: one minute of overlap
});

// ===========================================================  time-core (§11.3)

test('formatMinutes renders 09:05 and 21:05 in both modes', () => {
  assert.equal(TimeCore.formatMinutes(9 * 60 + 5, '24h'), '09:05');
  assert.equal(TimeCore.formatMinutes(9 * 60 + 5, '12h'), '9:05 am');
  assert.equal(TimeCore.formatMinutes(21 * 60 + 5, '24h'), '21:05');
  assert.equal(TimeCore.formatMinutes(21 * 60 + 5, '12h'), '9:05 pm');
});

test('formatMinutes handles midnight and noon, the two that catch naive implementations', () => {
  assert.equal(TimeCore.formatMinutes(0, '24h'), '00:00');
  assert.equal(TimeCore.formatMinutes(0, '12h'), '12:00 am');
  assert.equal(TimeCore.formatMinutes(12 * 60, '24h'), '12:00');
  assert.equal(TimeCore.formatMinutes(12 * 60, '12h'), '12:00 pm');
});

test('§16 Phase 5b — formatDurationMin: minutes-only, hours-only, and mixed', () => {
  assert.equal(TimeCore.formatDurationMin(15), '15m');
  assert.equal(TimeCore.formatDurationMin(45), '45m');
  assert.equal(TimeCore.formatDurationMin(60), '1h');
  assert.equal(TimeCore.formatDurationMin(120), '2h');
  assert.equal(TimeCore.formatDurationMin(75), '1h 15m');
});

// ===========================================================  remind-core (§11.5, §16 Phase 6b)

function remindState(rows, slots) {
  return {
    today: '2026-08-15',
    children: [{ id: 'ellie', name: 'Ellie' }, { id: 'talia', name: 'Talia' }],
    rows: rows,
    slots: slots || [],
    slotDays: [],
  };
}

test('a pending chore at its placed start time is due', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 480, duration_min: null }];
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  const due = RemindCore.dueNow(candidates, 480, { date: state.today }, {});
  assert.equal(due.length, 1);
  assert.equal(due[0].row.id, 'a1');
});

test('the same chore already complete is never a chime candidate', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'complete', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 480, duration_min: null }];
  const state = remindState(rows, slots);
  assert.equal(RemindCore.chimeCandidates(state, state.today).length, 0);
});

test('a chore with no placement never is due — there is no "when" to ring for it', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const state = remindState(rows, []); // no slots at all — unplaced
  assert.equal(RemindCore.chimeCandidates(state, state.today).length, 0);
});

test('a child whose soundOn is false contributes none', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 480, duration_min: null }];
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  const due = RemindCore.dueNow(candidates, 480, { date: state.today, soundOnByChild: { ellie: false } }, {});
  assert.equal(due.length, 0);
  // Absent from the map entirely — the default is ON, not silent.
  const dueDefault = RemindCore.dueNow(candidates, 480, { date: state.today, soundOnByChild: {} }, {});
  assert.equal(dueDefault.length, 1);
});

test('nothing is due inside the quiet-hours window', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 22 * 60, duration_min: null }];
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  const due = RemindCore.dueNow(candidates, 22 * 60, { date: state.today, quietStartHour: 21, quietEndHour: 6 }, {});
  assert.equal(due.length, 0);
});

test('§14.14 — a start time that passed while the page was loading is not retro-fired on boot', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 8 * 60, duration_min: null }]; // 08:00
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  // The page loads at 08:47 — 47 minutes after the chore's placed start time.
  const due = RemindCore.dueNow(candidates, 8 * 60 + 47, { date: state.today }, {});
  assert.equal(due.length, 0);
});

test('dueNow never re-fires an instant already in firedKeys', () => {
  const rows = [{ id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null }];
  const slots = [{ child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 480, duration_min: null }];
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  const fired = {};
  fired[RemindCore.fireKey({ id: 'a1' }, state.today)] = true;
  assert.equal(RemindCore.dueNow(candidates, 480, { date: state.today }, fired).length, 0);
  assert.equal(RemindCore.dueNow(candidates, 480, { date: state.today }, {}).length, 1);
});

test('nextChimeMin finds the earliest placed time strictly after `afterMin`, or null once nothing is left', () => {
  const rows = [
    { id: 'a1', kind: 'chore', child_id: 'ellie', date: '2026-08-15', status: 'pending', source_id: 'dishes', instance_key: '', claim_group: null },
    { id: 'a2', kind: 'chore', child_id: 'talia', date: '2026-08-15', status: 'pending', source_id: 'trash', instance_key: '', claim_group: null },
  ];
  const slots = [
    { child_id: 'ellie', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', start_min: 480, duration_min: null },
    { child_id: 'talia', subject_kind: 'chore', subject_key: 'trash', instance_key: '', start_min: 600, duration_min: null },
  ];
  const state = remindState(rows, slots);
  const candidates = RemindCore.chimeCandidates(state, state.today);
  assert.equal(RemindCore.nextChimeMin(candidates, 0), 480);
  assert.equal(RemindCore.nextChimeMin(candidates, 480), 600);
  assert.equal(RemindCore.nextChimeMin(candidates, 600), null);
});

test('inQuietHours wraps midnight the same way nav-ui.js\'s isNight does', () => {
  assert.equal(RemindCore.inQuietHours(21 * 60, 21, 6), true);
  assert.equal(RemindCore.inQuietHours(5 * 60 + 59, 21, 6), true);
  assert.equal(RemindCore.inQuietHours(6 * 60, 21, 6), false);
  assert.equal(RemindCore.inQuietHours(20 * 60, 21, 6), false);
  assert.equal(RemindCore.inQuietHours(12 * 60, 12, 12), false); // start === end — never quiet
});

// ==================================================  school blocks (§14.6)

function activity(childId, courseName, date, status, extra = {}) {
  return { kind: 'activity', child_id: childId, course_name: courseName, date, status, rescinded_at: null, ...extra };
}

test('§14.6: a member course is checked only when every non-rescinded activity is complete or waived', () => {
  const date = '2026-08-15';
  const allDone = [activity('ellie', 'Math', date, 'complete'), activity('ellie', 'Math', date, 'complete')];
  assert.equal(SchoolCore.courseRollup(allDone, 'ellie', 'Math', date).checked, true);

  const oneOpen = [activity('ellie', 'Math', date, 'complete'), activity('ellie', 'Math', date, 'pending')];
  assert.equal(SchoolCore.courseRollup(oneOpen, 'ellie', 'Math', date).checked, false);

  // Waived counts as resolved, not outstanding — matches the rest of the
  // codebase's own rule (child-app planner-core.js isResolved).
  const waived = [activity('ellie', 'Math', date, 'complete'), activity('ellie', 'Math', date, 'waived')];
  const rollup = SchoolCore.courseRollup(waived, 'ellie', 'Math', date);
  assert.equal(rollup.checked, true);
  assert.equal(rollup.resolved, 2);
});

test('§14.6: a member course with no activities that day is neither checked nor unchecked', () => {
  const rollup = SchoolCore.courseRollup([], 'ellie', 'Math', '2026-08-15');
  assert.equal(rollup.total, 0);
  assert.equal(rollup.checked, null);
});

test('§14.6: rows for another course or another child do not contribute', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'complete'),
    activity('ellie', 'Science', date, 'pending'), // different course
    activity('talia', 'Math', date, 'pending'), // different child
    activity('ellie', 'Math', '2026-08-14', 'pending'), // different date
  ];
  const rollup = SchoolCore.courseRollup(rows, 'ellie', 'Math', date);
  assert.equal(rollup.total, 1);
  assert.equal(rollup.checked, true);
});

test('§14.6: a rescinded activity does not count toward the total', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'complete'),
    activity('ellie', 'Math', date, 'pending', { rescinded_at: 12345 }),
  ];
  const rollup = SchoolCore.courseRollup(rows, 'ellie', 'Math', date);
  assert.equal(rollup.total, 1);
  assert.equal(rollup.checked, true);
});

test('§14.6: the block collapses only when every member is checked', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'complete'),
    activity('ellie', 'Language Arts', date, 'complete'),
    activity('ellie', 'Geography', date, 'pending'),
  ];
  const allDone = SchoolCore.memberRollups(rows, 'ellie', date, ['Math', 'Language Arts']);
  assert.equal(SchoolCore.isCollapsed(allDone), true);

  const oneOpen = SchoolCore.memberRollups(rows, 'ellie', date, ['Math', 'Language Arts', 'Geography']);
  assert.equal(SchoolCore.isCollapsed(oneOpen), false);
});

test('§14.6: a block with no members, or whose members all have zero activities, never collapses', () => {
  assert.equal(SchoolCore.isCollapsed([]), false);

  const noActivitiesYet = SchoolCore.memberRollups([], 'ellie', '2026-08-15', ['Math', 'Science']);
  assert.ok(noActivitiesYet.every((r) => r.checked === null));
  assert.equal(SchoolCore.isCollapsed(noActivitiesYet), false);
});

test('§14.6a: the membership picker lists exactly that child\'s courses with activities that date, alphabetically', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'pending'),
    activity('ellie', 'Language Arts', date, 'complete'),
    activity('talia', 'Geography', date, 'pending'), // different child
    activity('ellie', 'Science', '2026-08-14', 'pending'), // different date
    activity('ellie', 'History', date, 'pending', { rescinded_at: 999 }), // rescinded
  ];
  assert.deepEqual(SchoolCore.coursesWithActivities(rows, 'ellie', date), ['Language Arts', 'Math']);
});

// ==========================================================  week view (§16 Phase 8)

test('difficultyStars: one star per tier number, 0 for no tier or an unparseable one', () => {
  assert.equal(ChoresCore.difficultyStars({ payload: { difficultyTier: 'D01' } }), 1);
  assert.equal(ChoresCore.difficultyStars({ payload: { difficultyTier: 'D02' } }), 2);
  assert.equal(ChoresCore.difficultyStars({ payload: { difficultyTier: 'D12' } }), 12);
  assert.equal(ChoresCore.difficultyStars({ payload: {} }), 0);
  assert.equal(ChoresCore.difficultyStars({ payload: { difficultyTier: null } }), 0);
  assert.equal(ChoresCore.difficultyStars({ payload: { difficultyTier: 'bogus' } }), 0);
  // payload may arrive as a JSON string, same as every other *-core.js reader
  assert.equal(ChoresCore.difficultyStars({ payload: '{"difficultyTier":"D03"}' }), 3);
});

test('activityTypeCounts: counts by activity_type for one child/course/date, first-seen order', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'pending', { activity_type: 'Lesson' }),
    activity('ellie', 'Math', date, 'complete', { activity_type: 'Lesson' }),
    activity('ellie', 'Math', date, 'pending', { activity_type: 'Quiz' }),
    activity('ellie', 'Science', date, 'pending', { activity_type: 'Lesson' }), // different course
    activity('talia', 'Math', date, 'pending', { activity_type: 'Lesson' }), // different child
    activity('ellie', 'Math', '2026-08-14', 'pending', { activity_type: 'Lesson' }), // different date
    activity('ellie', 'Math', date, 'pending', { activity_type: 'Quiz', rescinded_at: 1 }), // rescinded
  ];
  assert.deepEqual(
    SchoolCore.activityTypeCounts(rows, 'ellie', 'Math', date),
    [{ type: 'Lesson', count: 2 }, { type: 'Quiz', count: 1 }]
  );
});

test('activityTypeCounts: a row with no activity_type counts as "Other"', () => {
  const date = '2026-08-15';
  const rows = [activity('ellie', 'Math', date, 'pending')];
  assert.deepEqual(SchoolCore.activityTypeCounts(rows, 'ellie', 'Math', date), [{ type: 'Other', count: 1 }]);
});

test('coursesWithTypeCounts: one entry per course with activities that date, each carrying its type breakdown', () => {
  const date = '2026-08-15';
  const rows = [
    activity('ellie', 'Math', date, 'pending', { activity_type: 'Lesson' }),
    activity('ellie', 'Math', date, 'complete', { activity_type: 'Quiz' }),
    activity('ellie', 'Language Arts', date, 'pending', { activity_type: 'Lesson' }),
  ];
  assert.deepEqual(SchoolCore.coursesWithTypeCounts(rows, 'ellie', date), [
    { courseName: 'Language Arts', typeCounts: [{ type: 'Lesson', count: 1 }] },
    { courseName: 'Math', typeCounts: [{ type: 'Lesson', count: 1 }, { type: 'Quiz', count: 1 }] },
  ]);
});

// =====================================================  month-core (§7, §14.7)
//
// §7.1's grid shape, §7.2's fetch window, and §14.7's events dedupe
// "re-asserted against the new month window" — the last of which is an
// assertion about EventsCore running unchanged over a 42-day grid, since
// buildCells calls it per cell and carries no dedupe of its own.

const evt = (id, date, extra = {}) => ({
  id, kind: 'event', date, source_id: id, title: 'Event ' + id, payload: '{}', ...extra,
});

test('§7.1 — the grid is always six Sunday-first weeks, whatever shape the month is', () => {
  // 2026-08-01 is a Saturday: the leading week is almost entirely July, and
  // a five-row month still draws six rows.
  const aug = MonthCore.gridDates('2026-08-14');
  assert.equal(aug.length, 42);
  assert.equal(aug[0], '2026-07-26'); // the Sunday on or before the 1st
  assert.equal(aug[41], '2026-09-05');

  // 2026-02-01 is a Sunday and 2026 is not a leap year, so February is
  // exactly four weeks — the case a "however many rows it needs" grid would
  // draw at two-thirds height.
  const feb = MonthCore.gridDates('2026-02-10');
  assert.equal(feb.length, 42);
  assert.equal(feb[0], '2026-02-01');
  assert.equal(feb[27], '2026-02-28');
  assert.equal(feb[41], '2026-03-14');
});

test('§7.1 — every drawn date is one day after the last, across both month boundaries', () => {
  const dates = MonthCore.gridDates('2026-08-14');
  const dayMs = 86400000;
  for (let i = 1; i < dates.length; i++) {
    const gap = Date.parse(dates[i] + 'T00:00:00Z') - Date.parse(dates[i - 1] + 'T00:00:00Z');
    assert.equal(gap, dayMs, `${dates[i - 1]} -> ${dates[i]}`);
  }
});

test('§7.2 — the fetch window is exactly the drawn grid, and inside the route\'s 62-day cap', () => {
  const win = MonthCore.windowFor('2026-08-14');
  const dates = MonthCore.gridDates('2026-08-14');
  assert.equal(win.from, dates[0]);
  assert.equal(win.to, dates[41]);
  const span = (Date.parse(win.to + 'T00:00:00Z') - Date.parse(win.from + 'T00:00:00Z')) / 86400000 + 1;
  assert.equal(span, 42);
  assert.ok(span <= 62, 'the window must never trip handleWallEvents\' MAX_EVENTS_WINDOW_DAYS');
});

test('§7.1 — leading and trailing cells are marked out-of-month but still carry their events', () => {
  const cells = MonthCore.buildCells('2026-08-14', [evt('e1', '2026-07-28')]);
  const july28 = cells.find((c) => c.date === '2026-07-28');
  assert.equal(july28.inMonth, false);
  assert.equal(july28.dayNum, 28);
  assert.equal(july28.events.length, 1); // drawn, not dropped — just recessed
  assert.equal(cells.find((c) => c.date === '2026-08-01').inMonth, true);
});

test('§14.7 — three children\'s rows for one event on one day collapse to one month cell entry', () => {
  const rows = ['a', 'b', 'c'].map((cid) => ({
    id: 'row-' + cid, child_id: cid, kind: 'event', date: '2026-08-13',
    source_id: 'evt-1', title: 'Family movie night', payload: '{}',
  }));
  const cells = MonthCore.buildCells('2026-08-14', rows);
  const cell = cells.find((c) => c.date === '2026-08-13');
  assert.equal(cell.events.length, 1);
  assert.equal(cell.events[0].title, 'Family movie night');
  // and it is on that day only — the other 41 cells stay empty
  assert.equal(cells.filter((c) => c.events.length > 0).length, 1);
});

test('§14.7 — a multi-day event yields one entry per day it touches, with the right span label', () => {
  const row = evt('evt-2', '2026-08-13', {
    title: 'Grandma visiting',
    payload: JSON.stringify({ startDate: '2026-08-13', endDate: '2026-08-16' }),
  });
  const cells = MonthCore.buildCells('2026-08-14', [row]);
  const touched = cells.filter((c) => c.events.length > 0);
  assert.deepEqual(touched.map((c) => c.date), ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']);
  assert.equal(EventsCore.spanLabel(touched[1].events[0], touched[1].date), 'Day 2 of 4');
  // one entry per day, never four stacked on the day the row is dated
  touched.forEach((c) => assert.equal(c.events.length, 1));
});

test('§7.1 — a cell carries its whole day, however many events that is; an empty one is empty rather than absent', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => evt('e' + n, '2026-08-13'));
  const cells = MonthCore.buildCells('2026-08-14', rows);
  // The whole list travels with the cell whatever gets drawn, because the
  // "+N more" sheet opens on the WHOLE day, not on the hidden tail.
  assert.equal(cells.find((c) => c.date === '2026-08-13').events.length, 5);
  assert.deepEqual(cells.find((c) => c.date === '2026-08-20').events, []);
});

test('§7.1 — largestFit takes the most a cell can draw, not the first thing that fits', () => {
  // The fixture: three of five fit. The search must not stop at one.
  const fits = (n) => n <= 3;
  assert.equal(MonthCore.largestFit(5, fits), 3);
  assert.equal(MonthCore.largestFit(3, fits), 3); // nothing hidden when it all fits
  assert.equal(MonthCore.largestFit(0, fits), 0);
});

test('§7.1 — largestFit gives up gracefully rather than looping when nothing fits at all', () => {
  // A cell too short even for one line: the affordance alone is the answer,
  // never a negative count and never a hang.
  assert.equal(MonthCore.largestFit(4, () => false), 0);
});

test('§7.1 — largestFit asks about the affordance\'s own line, so it can never overflow the box it announces', () => {
  // `fits` is the caller's: month-ui.js shows "+N more" inside the state it
  // measures whenever n is short of the total. Modelled here as one line for
  // each drawn event plus one for the affordance, against a 3-line box.
  const asked = [];
  const fits = (n) => {
    asked.push(n);
    const lines = n + (n < 5 ? 1 : 0);
    return lines <= 3;
  };
  assert.equal(MonthCore.largestFit(5, fits), 2); // 2 events + "+3 more" = 3 lines
  assert.deepEqual(asked, [5, 4, 3, 2]); // searched down from the whole list
});

test('§7.1 — a timed event sorts ahead of an untimed one inside a cell, as it does in the day band', () => {
  const rows = [
    evt('e1', '2026-08-13', { title: 'No time' }),
    evt('e2', '2026-08-13', { title: 'Has time', payload: JSON.stringify({ time: '3:00 PM' }) }),
  ];
  const cell = MonthCore.buildCells('2026-08-14', rows).find((c) => c.date === '2026-08-13');
  assert.deepEqual(cell.events.map((e) => e.title), ['Has time', 'No time']);
});

test('§7.1 — chunkWeeks lays the 42 cells out as six rows of seven, in grid order', () => {
  const weeks = MonthCore.chunkWeeks(MonthCore.buildCells('2026-08-14', []));
  assert.equal(weeks.length, MonthCore.WEEKS);
  weeks.forEach((w) => assert.equal(w.length, 7));
  assert.equal(weeks[0][0].date, '2026-07-26');
  assert.equal(weeks[5][6].date, '2026-09-05');
});
