// Tests for the household's standing subject order and the comparator every
// subject-grouped view sorts with (subject-order-core.js). Per
// SRS_Management_Module_11_Settings_Backup.md FR-9 and
// docs/TDS_Slice_Subject_Order_Grouped_Review.md §1. Pure, DOM-free — the same
// split as pacing-core.js, course-durations-core.js, recipe-core.js,
// worker/validation.js and the Child App's *-core.js files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const Core = loadModule('management-app/js/subject-order-core.js', 'SubjectOrderCore');

const ORDER = ['Math', 'Language Arts', 'Science'];

// ---- label / key ----------------------------------------------------------

test('label falls back to No subject for blank, absent and whitespace', () => {
  assert.equal(Core.label('Math'), 'Math');
  assert.equal(Core.label('  Math  '), 'Math');
  assert.equal(Core.label(''), Core.NO_SUBJECT);
  assert.equal(Core.label('   '), Core.NO_SUBJECT);
  assert.equal(Core.label(null), Core.NO_SUBJECT);
  assert.equal(Core.label(undefined), Core.NO_SUBJECT);
});

// ---- compare --------------------------------------------------------------

test('an absent or empty order sorts alphabetically, No subject last', () => {
  // The behaviour of courses.js / instances.js / weekly.js before FR-9 existed:
  // an un-configured install must look exactly the way it looks today.
  const subjects = ['Science', 'No subject', 'Bible', 'Math'];
  const expected = ['Bible', 'Math', 'Science', 'No subject'];
  assert.deepEqual(Core.sortSubjects(subjects, []), expected);
  assert.deepEqual(Core.sortSubjects(subjects, undefined), expected);
  assert.deepEqual(Core.sortSubjects(subjects, null), expected);
});

test('listed subjects sort by their stored index, not alphabetically', () => {
  assert.deepEqual(
    Core.sortSubjects(['Science', 'Math', 'Language Arts'], ORDER),
    ['Math', 'Language Arts', 'Science']
  );
});

test('unlisted subjects sort after every listed one, alphabetically among themselves', () => {
  assert.deepEqual(
    Core.sortSubjects(['Woodwork', 'Science', 'Art', 'Math'], ORDER),
    ['Math', 'Science', 'Art', 'Woodwork']
  );
});

test('unlisted-only falls through to alphabetical', () => {
  assert.deepEqual(Core.sortSubjects(['Woodwork', 'Art'], ORDER), ['Art', 'Woodwork']);
});

test('No subject sorts last even when the stored order names it', () => {
  // It is a display fallback, not a subject: a parent who typed it into the
  // list must not be able to hoist the un-subjected bucket above real work.
  assert.deepEqual(
    Core.sortSubjects(['Science', 'No subject', 'Math'], ['No subject', 'Math']),
    ['Math', 'Science', 'No subject']
  );
});

test('matching ignores case and surrounding whitespace, and rewrites nothing', () => {
  // Both entries match ORDER despite their spelling, so Math leads Science —
  // and each comes back exactly as the caller wrote it. §1.2: the stored order
  // is consulted as a rank, never as a display source, so a casing difference
  // between the list and the Course record cannot rename anything.
  assert.deepEqual(
    Core.sortSubjects(['  science  ', 'MATH'], ORDER),
    ['MATH', '  science  ']
  );
  assert.deepEqual(Core.sortSubjects(['MATH'], ORDER), ['MATH']);
});

test('a near-miss spelling is a different subject, and sorts as unlisted', () => {
  assert.deepEqual(Core.sortSubjects(['Maths', 'Science'], ORDER), ['Science', 'Maths']);
});

test('two subjects of equal rank sort stably by text', () => {
  const c = Core.compare(ORDER);
  assert.equal(c('Art', 'Art'), 0);
  assert.ok(c('Art', 'Woodwork') < 0);
  assert.ok(c('Woodwork', 'Art') > 0);
});

test('sortSubjects returns a copy and leaves its input alone', () => {
  const input = ['Science', 'Math'];
  const out = Core.sortSubjects(input, ORDER);
  assert.deepEqual(input, ['Science', 'Math']);
  assert.notEqual(out, input);
});

// ---- normalize ------------------------------------------------------------

test('normalize trims, drops blanks and No subject, and collapses duplicates first-spelling-wins', () => {
  assert.deepEqual(
    Core.normalize(['  Math ', '', 'math', 'No subject', 'Science', null]),
    ['Math', 'Science']
  );
  assert.deepEqual(Core.normalize('not an array'), []);
});

// ---- merge (the editor's effective list) ----------------------------------

test('merge keeps stored entries in their stored positions and appends the rest alphabetically', () => {
  const rows = Core.merge(['Science', 'Math'], ['Math', 'Woodwork', 'Art', 'Science']);
  assert.deepEqual(rows.map((r) => r.subject), ['Science', 'Math', 'Art', 'Woodwork']);
  assert.deepEqual(rows.map((r) => r.listed), [true, true, false, false]);
});

test('merge flags a stored subject no course uses any more, and never drops it', () => {
  const rows = Core.merge(['Math', 'Latin'], ['Math']);
  assert.deepEqual(rows.map((r) => [r.subject, r.inUse]), [['Math', true], ['Latin', false]]);
  assert.deepEqual(Core.unused(['Math', 'Latin'], ['Math']), ['Latin']);
  assert.deepEqual(Core.unused(['Math'], ['Math', 'Art']), []);
});

test('merge dedupes in-use subjects case-insensitively and ignores blank ones', () => {
  const rows = Core.merge([], ['Math', 'math', '  ', null, 'MATH']);
  assert.deepEqual(rows.map((r) => r.subject), ['Math']);
});

test('merge matches a stored entry to an in-use subject spelled differently', () => {
  const rows = Core.merge(['Math'], ['  math  ']);
  assert.deepEqual(rows, [{ subject: 'Math', listed: true, inUse: true }]);
});

// ---- move -----------------------------------------------------------------

test('move walks an entry one step and returns a new array', () => {
  assert.deepEqual(Core.move(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(Core.move(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
});

test('move off either end is a no-op, not an error', () => {
  assert.deepEqual(Core.move(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(Core.move(['a', 'b'], 1, 1), ['a', 'b']);
  assert.deepEqual(Core.move(['a', 'b'], 7, -1), ['a', 'b']);
});
