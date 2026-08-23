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

test('blockLabel/blockHintLabel give the tray badge its text, falling back the way the hint does', () => {
  assert.equal(ChoresCore.blockLabel('morning'), 'Morning');
  assert.equal(ChoresCore.blockLabel('night'), 'Night');
  assert.equal(ChoresCore.blockLabel('bogus'), 'Morning'); // same fallback effectiveBlockHint takes
  assert.equal(ChoresCore.blockHintLabel({ block_hint: 'evening' }), 'Evening');
  assert.equal(ChoresCore.blockHintLabel({ child_block_hint: 'afternoon', block_hint: 'evening' }), 'Afternoon');
  assert.equal(ChoresCore.blockHintLabel({}), 'Morning');
});

test('compareBlockHint orders the tray morning -> night and leaves sort_order alone within a block', () => {
  // Three occurrences of one chore (Shared Chores §2.4), same title, one per
  // block — the case the badge exists for.
  const rows = [
    { id: 'c', title: 'Dishes', block_hint: 'evening', instance_key: 'i3' },
    { id: 'a', title: 'Dishes', block_hint: 'morning', instance_key: 'i1' },
    { id: 'b', title: 'Dishes', block_hint: 'afternoon', instance_key: 'i2' },
  ];
  assert.deepEqual(rows.slice().sort(ChoresCore.compareBlockHint).map((r) => r.id), ['a', 'b', 'c']);

  // Same block: the incoming order (handlePlan's `ORDER BY date, sort_order`)
  // survives, because the comparator returns 0 and the sort is stable.
  const sameBlock = [
    { id: 'x', block_hint: 'morning' },
    { id: 'y', child_block_hint: 'morning', block_hint: 'night' },
    { id: 'z' },
  ];
  assert.deepEqual(sameBlock.slice().sort(ChoresCore.compareBlockHint).map((r) => r.id), ['x', 'y', 'z']);
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
  // Placement Scopes §8 test 3 — these four assertions must still hold with
  // the weekday row absent. The calls now pass it explicitly as null rather
  // than relying on argument position: the weekday row sits at position 2 of
  // the chain, so a 3-argument call would silently deliver the per-day row
  // into the weekday slot and still produce these answers, which would leave
  // the test passing while asserting something else.
  assert.equal(SlotsCore.resolveDurationMin(noEstimate, null, null, null), 15); // nothing else to go on
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, null, null, null), 30); // the parent's estimate
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: null }, null, null), 30); // a cleared standing override still falls to the estimate
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: 45 }, null, null), 45); // standing override
  assert.equal(SlotsCore.resolveDurationMin(withEstimate, { duration_min: 45 }, null, { duration_min: 10 }), 10); // per-day wins
});

test('§3.5.1 — clearing the per-day override falls back exactly one step, not to the bottom', () => {
  const row = { source_id: 'bins', instance_key: '', claim_group: null, expected_duration_min: 30 };
  const withStanding = SlotsCore.resolveDurationMin(row, { duration_min: 45 }, null, null);
  assert.equal(withStanding, 45); // not 30 or 15 — the standing override still applies
});

test('isOverridden is true with any of the three overrides present, false with none', () => {
  assert.equal(SlotsCore.isOverridden(null, null, null), false);
  assert.equal(SlotsCore.isOverridden({ duration_min: null }, null, null), false);
  assert.equal(SlotsCore.isOverridden({ duration_min: 45 }, null, null), true);
  assert.equal(SlotsCore.isOverridden(null, null, { duration_min: 10 }), true);
  // Placement Scopes §2.1 — the weekday level counts too, or the italic-dot
  // marker goes dark on a chip whose duration a family set for Fridays.
  assert.equal(SlotsCore.isOverridden(null, { duration_min: 20 }, null), true);
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

// ==========================================================================
// Placement Scopes §8, tests 1-6 and 10 (Phase 3) — the pure layer of
// standing / weekday / occurrence, for chores and school blocks alike.
// ==========================================================================

// --- test 1: the timezone trap (§2.3) -------------------------------------

test('§8.1: weekdayOf is LOCAL — 2026-08-23 is Sunday in Chicago, not Saturday', () => {
  // The whole reason this function exists. `new Date("2026-08-23")` parses as
  // UTC midnight, which is the previous day west of Greenwich — so the naive
  // implementation answers Saturday for a Sunday, and does it only for the
  // people who never run the tests. Node honours a TZ change at runtime, so
  // the trap can be sprung here rather than described in a comment.
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Chicago';
    assert.equal(TimeCore.weekdayOf('2026-08-23'), 0, 'Sunday');
    assert.equal(new Date('2026-08-23').getDay(), 6, 'the trap itself: string-parsed, it reads Saturday');
    assert.equal(TimeCore.weekdayOf('2026-08-22'), 6, 'Saturday');
    assert.equal(TimeCore.weekdayOf('2026-08-24'), 1, 'Monday');
    // month-core builds its own Dates for date arithmetic (§2.3 leaves it
    // alone); checked against the same trap so the exemption stays honest.
    assert.equal(MonthCore.gridDates('2026-08-15')[0], '2026-07-26');
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

// --- tests 2-4: the chore chains ------------------------------------------

const CHORE = { id: 'a1', child_id: 'c1', source_id: 'dishes', instance_key: '', claim_group: null, expected_duration_min: 30 };
const FRIDAY = '2026-08-21';   // a Friday in every timezone this runs in
const THURSDAY = '2026-08-20';

function chipOn(date, { slot, weekday, day } = {}) {
  return SlotsCore.resolveChip(
    SlotsCore.indexSlots(slot ? [{ child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', ...slot }] : []),
    SlotsCore.indexWeekdays(weekday ? [{ child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', ...weekday }] : []),
    SlotsCore.indexDays(day ? [{ child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', ...day }] : []),
    CHORE, date
  );
}

test('§8.2: the start-time chain, all four rows, each naming its own scope', () => {
  const standing = chipOn(FRIDAY, { slot: { start_min: 480, duration_min: null } });
  assert.equal(standing.startMin, 480);
  assert.equal(standing.scope, 'standing');

  const byWeekday = chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: null },
    weekday: { weekday: 5, start_min: 420, duration_min: null },
  });
  assert.equal(byWeekday.startMin, 420, 'Friday moves earlier');
  assert.equal(byWeekday.scope, 'weekday');

  // A date row over a weekday row over a standing row — all three at once,
  // which is the row this chain exists for.
  const byDate = chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: null },
    weekday: { weekday: 5, start_min: 420, duration_min: null },
    day: { date: FRIDAY, start_min: 600, duration_min: null },
  });
  assert.equal(byDate.startMin, 600);
  assert.equal(byDate.scope, 'day');

  const unplaced = chipOn(FRIDAY, {});
  assert.equal(unplaced.startMin, null);
  assert.equal(unplaced.scope, null, 'in the tray — no level supplied a time');
});

test('§8.2/§11.7: a weekday row cannot PLACE a chore that has no standing row', () => {
  // §2.1's gate, and the property that makes un-placing safe to leave
  // standing-scoped: the rows left behind are dormant, not orphaned.
  const chip = chipOn(FRIDAY, { weekday: { weekday: 5, start_min: 420, duration_min: 45 } });
  assert.equal(chip.startMin, null, 'still in the tray, on its own weekday');
  assert.equal(chip.scope, null);
  // Same for a date row alone — this is the shipped behaviour the gate
  // generalizes, not a new rule.
  assert.equal(chipOn(FRIDAY, { day: { date: FRIDAY, start_min: 600 } }).startMin, null);
});

test('§8.2: a weekday override applies on its weekday and nowhere else', () => {
  const opts = {
    slot: { start_min: 480, duration_min: null },
    weekday: { weekday: 5, start_min: 420, duration_min: null },
  };
  assert.equal(chipOn(FRIDAY, opts).startMin, 420);
  assert.equal(chipOn(THURSDAY, opts).startMin, 480, 'Thursday is untouched');
  assert.equal(chipOn(THURSDAY, opts).scope, 'standing');
});

test('§8.3: the duration chain, all five rows', () => {
  const base = { slot: { start_min: 480, duration_min: null } };
  assert.equal(chipOn(FRIDAY, base).durationMin, 30, 'the parent\'s estimate');
  assert.equal(
    SlotsCore.resolveDurationMin({ ...CHORE, expected_duration_min: null }, null, null, null), 15,
    'and 15 under that'
  );
  assert.equal(chipOn(FRIDAY, { slot: { start_min: 480, duration_min: 45 } }).durationMin, 45, 'standing');
  assert.equal(chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: 45 },
    weekday: { weekday: 5, start_min: null, duration_min: 20 },
  }).durationMin, 20, 'weekday beats standing');
  assert.equal(chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: 45 },
    weekday: { weekday: 5, start_min: null, duration_min: 20 },
    day: { date: FRIDAY, start_min: null, duration_min: 10 },
  }).durationMin, 10, 'the date beats them both');
});

test('§8.4: the two chains are independent — a weekday row may move a chore without re-timing it', () => {
  const chip = chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: 45 },
    weekday: { weekday: 5, start_min: 420, duration_min: null },
  });
  assert.equal(chip.startMin, 420, 'start comes from the weekday row');
  assert.equal(chip.durationMin, 45, 'duration falls PAST it to the standing row, not to its null');
  assert.equal(chip.scope, 'weekday');
});

test('§8.4a: the composed pair is clamped, because no single write can see it', () => {
  // A weekday row moving the chore to 23:45 validates fine against its own
  // null duration; the standing row's 60 minutes then composes a chip ending
  // at 00:45. Neither write could have caught it — the resolver is the only
  // place this exists (§2.1's decision).
  const chip = chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: 60 },
    weekday: { weekday: 5, start_min: 1425, duration_min: null },
  });
  assert.equal(chip.startMin, 1425);
  assert.equal(chip.durationMin, 15, 'clamped to midnight, not 60');
  assert.equal(chip.clamped, true);
  // An ordinary chip is not marked clamped.
  assert.equal(chipOn(FRIDAY, { slot: { start_min: 480, duration_min: 60 } }).clamped, false);
});

test('§8.4b: an override write carries the level\'s own value, never the resolved one', () => {
  // Asserted at the boundary the day view calls: the chip renders 30 minutes
  // because the PARENT authored 30, so the weekday row's own duration is
  // null. Writing the resolved 30 would freeze Friday against the parent's
  // later change and light the override marker on a chip nobody re-timed.
  const chip = chipOn(FRIDAY, {
    slot: { start_min: 480, duration_min: null },
    weekday: { weekday: 5, start_min: 420, duration_min: null },
  });
  assert.equal(chip.durationMin, 30, 'what is drawn');
  const idx = SlotsCore.indexWeekdays([{ child_id: 'c1', subject_kind: 'chore', subject_key: 'dishes', instance_key: '', weekday: 5, start_min: 420, duration_min: null }]);
  const own = SlotsCore.weekdayOverrideFor(idx, CHORE, 5);
  assert.equal(own.duration_min, null, 'what must be written');
  assert.equal(chip.overridden, false, 'and the marker stays dark');
});

// --- tests 5-6: the block side --------------------------------------------

const BLOCK = { id: 'b1', child_id: 'c1', start_min: 540, end_min: 600 };
const MON_FRI = [1, 2, 3, 4, 5].map((weekday) => ({ block_id: 'b1', weekday, start_min: null, end_min: null }));

function occursOn(weekdayRows, dateRows, date) {
  return SchoolCore.blockOccursOn(
    SchoolCore.indexBlockWeekdays(weekdayRows),
    SchoolCore.indexBlockDates(dateRows),
    'b1', date, TimeCore.weekdayOf(date)
  );
}

test('§8.5: the weekday list IS the schedule — Mon-Fri renders Monday, not Saturday', () => {
  assert.equal(occursOn(MON_FRI, [], '2026-08-24'), true, 'Monday');
  assert.equal(occursOn(MON_FRI, [], '2026-08-22'), false, 'Saturday — this is §0.1');
  assert.equal(occursOn(MON_FRI, [], '2026-08-23'), false, 'Sunday');
  // A block with no weekday rows happens on NO day. That is why POST applies
  // the Mon-Fri default server-side rather than leaving it to the client.
  assert.equal(occursOn([], [], '2026-08-24'), false);
  assert.deepEqual(SchoolCore.scheduledWeekdays(SchoolCore.indexBlockWeekdays(MON_FRI), 'b1'), [1, 2, 3, 4, 5]);
});

test('§8.5a: a date row beats the weekday list, in BOTH directions', () => {
  // occurs 0 on a scheduled Monday — a field trip.
  assert.equal(occursOn(MON_FRI, [{ block_id: 'b1', date: '2026-08-24', occurs: 0, start_min: null, end_min: null }], '2026-08-24'), false);
  // occurs 1 on an unscheduled Sunday — the backup school day.
  assert.equal(occursOn(MON_FRI, [{ block_id: 'b1', date: '2026-08-23', occurs: 1, start_min: null, end_min: null }], '2026-08-23'), true);
  // The exception is confined to its own date, in both directions.
  assert.equal(occursOn(MON_FRI, [{ block_id: 'b1', date: '2026-08-24', occurs: 0 }], '2026-08-25'), true);
  assert.equal(occursOn(MON_FRI, [{ block_id: 'b1', date: '2026-08-23', occurs: 1 }], '2026-08-30'), false);

  // A backup Sunday with no span of its own takes the BLOCK's default span —
  // there is no Sunday weekday row to read, which is the case a reader
  // assumes must be special and is not.
  const placement = SchoolCore.resolvePlacement(
    SchoolCore.indexBlockWeekdays(MON_FRI),
    SchoolCore.indexBlockDates([{ block_id: 'b1', date: '2026-08-23', occurs: 1, start_min: null, end_min: null }]),
    BLOCK, '2026-08-23', TimeCore.weekdayOf('2026-08-23')
  );
  assert.equal(placement.occurs, true);
  assert.equal(placement.startMin, 540);
  assert.equal(placement.endMin, 600);
  assert.equal(placement.spanScope, 'block');
});

test('§8.6: a block span resolves as a PAIR, and a half-span contributes nothing', () => {
  const wdSpan = { block_id: 'b1', weekday: 1, start_min: 480, end_min: 570 };
  const dtSpan = { block_id: 'b1', date: '2026-08-24', occurs: 1, start_min: 600, end_min: 660 };

  assert.deepEqual(SchoolCore.resolveBlockSpan(BLOCK, null, null), { startMin: 540, endMin: 600, scope: 'block' });
  assert.deepEqual(SchoolCore.resolveBlockSpan(BLOCK, wdSpan, null), { startMin: 480, endMin: 570, scope: 'weekday' });
  assert.deepEqual(SchoolCore.resolveBlockSpan(BLOCK, wdSpan, dtSpan), { startMin: 600, endMin: 660, scope: 'date' });

  // A NULL span does not contribute half of one: the level is skipped whole.
  assert.deepEqual(
    SchoolCore.resolveBlockSpan(BLOCK, { block_id: 'b1', weekday: 1, start_min: null, end_min: null }, null),
    { startMin: 540, endMin: 600, scope: 'block' }
  );
  // Neither does a malformed one-sided row, which the routes reject but a
  // resolver should never be the second line of defence against.
  assert.deepEqual(
    SchoolCore.resolveBlockSpan(BLOCK, { block_id: 'b1', weekday: 1, start_min: 480, end_min: null }, null),
    { startMin: 540, endMin: 600, scope: 'block' }
  );
});

// --- test 10: the member-course fix (§5.3) --------------------------------

test('§8.10: a member course with nothing that date is not drawn, and cannot hold the block open', () => {
  const rows = [
    { kind: 'activity', child_id: 'c1', course_name: 'Math', date: '2026-08-24', status: 'complete', rescinded_at: null },
    { kind: 'activity', child_id: 'c1', course_name: 'Latin', date: '2026-08-25', status: 'pending', rescinded_at: null },
  ];
  const rollups = SchoolCore.memberRollups(rows, 'c1', '2026-08-24', ['Math', 'Latin']);
  assert.equal(rollups.length, 2);
  assert.equal(rollups[1].checked, null, 'Latin has nothing on the 24th');

  const renderable = SchoolCore.renderableRollups(rollups);
  assert.deepEqual(renderable.map((r) => r.courseName), ['Math'], 'the phantom course is gone');
  // And the block collapses, which it could not while a null member was in
  // the list — `isCollapsed` requires every entry to be checked === true.
  assert.equal(SchoolCore.isCollapsed(rollups), false);
  assert.equal(SchoolCore.isCollapsed(renderable), true);

  // A block whose members ALL have nothing that day is the empty shell, not
  // a collapsed one: an empty set is not an achievement (§5.3).
  const none = SchoolCore.renderableRollups(SchoolCore.memberRollups(rows, 'c1', '2026-08-26', ['Math', 'Latin']));
  assert.deepEqual(none, []);
  assert.equal(SchoolCore.isCollapsed(none), false);
});

// ==========================================================================
// Placement Scopes §8 (Phase 4) — the write side of the chain. §8 assigned
// Phase 4 only manual check 12, but §6.1's transition table and §4.1's
// send-your-own-value rule are decision logic, not rendering: they now live
// in `slots-core.js` beside the resolver, so the bug §6.1 spends a paragraph
// warning about is prevented by construction rather than by care in a DOM
// file.
// ==========================================================================

test('§6.1: moving a placement clears only the OVERRIDE level it came from', () => {
  // The six rows of §6.1's table, in its own order.
  assert.deepEqual(SlotsCore.planScopeWrite('standing', 'weekday'), { write: 'weekday', clear: null });
  assert.deepEqual(SlotsCore.planScopeWrite('standing', 'day'), { write: 'day', clear: null });
  assert.deepEqual(SlotsCore.planScopeWrite('weekday', 'day'), { write: 'day', clear: 'weekday' });
  assert.deepEqual(SlotsCore.planScopeWrite('day', 'weekday'), { write: 'weekday', clear: 'day' });
  assert.deepEqual(SlotsCore.planScopeWrite('weekday', 'standing'), { write: 'standing', clear: 'weekday' });
  assert.deepEqual(SlotsCore.planScopeWrite('day', 'standing'), { write: 'standing', clear: 'day' });
});

test('§6.1: standing is NEVER cleared — that clear would un-place the chore', () => {
  // The misreading §6.1 warns about: `wall_slots.start_min` is NOT NULL and
  // the row's presence IS the placement, so "clear the level it came from"
  // taken literally on standing → only-today takes the chore off the grid
  // every other day of the year.
  ['weekday', 'day', 'standing'].forEach((to) => {
    assert.notEqual(SlotsCore.planScopeWrite('standing', to).clear, 'standing');
  });
  // And a re-time at the level already in force — every drag, under §7.1 —
  // clears nothing at all.
  ['standing', 'weekday', 'day'].forEach((level) => {
    assert.deepEqual(SlotsCore.planScopeWrite(level, level), { write: level, clear: null });
  });
});

test('§4.1: a write carries the level\'s own row, and both-null is a DELETE', () => {
  const slot = { start_min: 480, duration_min: null };
  const weekday = { weekday: 5, start_min: 420, duration_min: null };
  assert.equal(SlotsCore.levelRow('standing', slot, weekday, null), slot);
  assert.equal(SlotsCore.levelRow('weekday', slot, weekday, null), weekday);
  assert.equal(SlotsCore.levelRow('day', slot, weekday, null), null, 'no date row — null, not the one below');

  // The pair the override routes 400 on, resolved here instead: an override
  // that overrides nothing is a DELETE, which is how a level goes away.
  assert.deepEqual(SlotsCore.overrideWrite('weekday', null, null), { verb: 'delete', startMin: null, durationMin: null });
  assert.deepEqual(SlotsCore.overrideWrite('day', null, null), { verb: 'delete', startMin: null, durationMin: null });
  assert.deepEqual(SlotsCore.overrideWrite('weekday', 420, null), { verb: 'put', startMin: 420, durationMin: null });
  assert.deepEqual(SlotsCore.overrideWrite('day', null, 45), { verb: 'put', startMin: null, durationMin: 45 });

  // Standing is always a PUT — its row's presence is the placement, so a
  // null duration there is "no override", never "delete the placement".
  assert.deepEqual(SlotsCore.overrideWrite('standing', 480, null), { verb: 'put', startMin: 480, durationMin: null });
});

test('§6.1: weekdayName gives the sheet its button and the toast its plural', () => {
  assert.equal(TimeCore.weekdayName(5), 'Friday');
  assert.equal(TimeCore.weekdayName(5, true), 'Fridays');
  assert.equal(TimeCore.weekdayName(0), 'Sunday', 'Sunday-first, like weekdayOf');
  assert.equal(TimeCore.weekdayName(6, true), 'Saturdays');
  assert.equal(TimeCore.weekdayName(7), '', 'out of range names nothing rather than "undefineds"');
});

// ==========================================================================
// Placement Scopes §8 (Phase 5a) — the write side of the BLOCK chain. §8
// assigned Phase 5 only the manual checks (11, 12a, 13), but three of the
// rules the block UI runs on are decisions rather than rendering, and two of
// them are wrong in a way nobody would see on the tablet until a school day
// went missing: §6.4's creation default is invisible on five days out of
// seven, and §2.2.1's write table turns on a condition (is this date already
// scheduled by the weekday list?) that the sheet has no way to re-check.
// ==========================================================================

test('§6.4: a new block is scheduled Mon-Fri AND on the day you are standing on', () => {
  // The weekday case: Monday is already in Mon-Fri, so nothing is added.
  assert.deepEqual(SchoolCore.defaultWeekdaysFor(1), [1, 2, 3, 4, 5]);
  assert.deepEqual(SchoolCore.defaultWeekdaysFor(5), [1, 2, 3, 4, 5]);
  // The weekend case, which is the whole point: creating a block on a
  // Saturday and having it vanish is indistinguishable from a crash (§6.4).
  assert.deepEqual(SchoolCore.defaultWeekdaysFor(6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(SchoolCore.defaultWeekdaysFor(0), [0, 1, 2, 3, 4, 5], 'Sunday-first sorts to the front');
});

test('§7.1: a block drag writes the level that put it where the finger found it', () => {
  // The unchanged common path: no override carries a span, so the drag moves
  // the block's own row and every scheduled day moves with it.
  assert.deepEqual(
    SchoolCore.planBlockMove('block', 480, 570, '2026-08-28', 5),
    { level: 'block', startMin: 480, endMin: 570 });

  // The case this rule exists for: the span came from the Friday row, so the
  // write goes there. Writing the block row instead would land underneath the
  // Friday row and the block would not move.
  assert.deepEqual(
    SchoolCore.planBlockMove('weekday', 480, 570, '2026-08-28', 5),
    { level: 'weekday', weekday: 5, startMin: 480, endMin: 570 });

  // A date-level move carries occurs: 1 — a move is not a skip, and under
  // §4.1 an omitted `occurs` is written NULL, which is not a valid one.
  assert.deepEqual(
    SchoolCore.planBlockMove('date', 600, 690, '2026-08-28', 5),
    { level: 'date', date: '2026-08-28', occurs: 1, startMin: 600, endMin: 690 });
});

test('§6.2: the Today radio is read off the state, not remembered', () => {
  const MON = { block_id: 'b1', weekday: 1, start_min: null, end_min: null };
  assert.equal(SchoolCore.todayChoice(MON, null), 'as-scheduled');
  assert.equal(SchoolCore.todayChoice(null, null), 'not-today', 'no weekday row, no block');

  const skip = { block_id: 'b1', date: '2026-08-24', occurs: 0, start_min: null, end_min: null };
  assert.equal(SchoolCore.todayChoice(MON, skip), 'not-today');

  // occurs: 1 with no span says the block HAPPENS and says nothing about
  // when — Ray's backup Sunday. That is 'as-scheduled', not 'just-today'.
  const backup = { block_id: 'b1', date: '2026-08-23', occurs: 1, start_min: null, end_min: null };
  assert.equal(SchoolCore.todayChoice(null, backup), 'as-scheduled');

  const moved = { block_id: 'b1', date: '2026-08-24', occurs: 1, start_min: 600, end_min: 690 };
  assert.equal(SchoolCore.todayChoice(MON, moved), 'just-today');
});

test('§2.2.1: two of the three Today writes depend on what the weekday list already says', () => {
  const span = { startMin: 600, endMin: 690 };

  // A date row exists only to DISAGREE with the weekly rule. Agreeing with it
  // is a DELETE, both ways round.
  assert.deepEqual(SchoolCore.planDateWrite('as-scheduled', true, span), { verb: 'delete' });
  assert.deepEqual(SchoolCore.planDateWrite('not-today', false, span), { verb: 'delete' });

  // Disagreeing is a PUT, and a skipped day carries no time (§2.2.1) — the
  // Worker rejects occurs: 0 with a span rather than ignoring it.
  assert.deepEqual(
    SchoolCore.planDateWrite('not-today', true, span),
    { verb: 'put', occurs: 0, startMin: null, endMin: null });
  assert.deepEqual(
    SchoolCore.planDateWrite('as-scheduled', false, span),
    { verb: 'put', occurs: 1, startMin: null, endMin: null },
    'the backup day: it happens, at the level below\'s span');

  // "Just today" is the one choice that does not care about the weekly rule.
  [true, false].forEach((scheduled) => {
    assert.deepEqual(
      SchoolCore.planDateWrite('just-today', scheduled, span),
      { verb: 'put', occurs: 1, startMin: 600, endMin: 690 });
  });
});
