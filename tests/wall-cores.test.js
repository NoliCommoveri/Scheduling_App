// Tests for the Wall App's pure cores (TDS_Slice_Wall_Display_App.md §12).
// Phase 2 lands pin-core.js only; events-core.js, chores-core.js and
// completed-core.js join with their tests in Phase 3.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
for (const file of ['pin-core.js']) {
  vm.runInThisContext(readFileSync(new URL(`wall-app/js/${file}`, repo), 'utf8'), { filename: file });
}
const { PinCore } = globalThis;

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
