// Tests for the Management App's bulk Activity-duration arithmetic
// (course-durations-core.js). Per SRS_Management_Module_03_Course_Template_
// Library.md FR-11 and docs/TDS_Slice_Course_Duration_Bulk_Edit.md §3. Pure,
// DOM-free — the same split as pacing-core.js, recipe-core.js,
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
const Core = loadModule('management-app/js/course-durations-core.js', 'CourseDurationsCore');

// Table order as `Storage.getAll('activityTypes')` returns it (by key).
const TYPES = [
  { activityTypeKey: 'drill', label: 'Drill', structurePattern: 'count' },
  { activityTypeKey: 'practice-level', label: 'Practice', structurePattern: 'count' },
  { activityTypeKey: 'quiz', label: 'Quiz', structurePattern: 'count' },
  { activityTypeKey: 'workbook', label: 'Workbook', structurePattern: 'page-range' },
];

let nextId = 1;
function activity(activityType, expectedDurationMin, extra = {}) {
  const a = {
    id: `MATH5-TPL-L01-${String(nextId++).padStart(2, '0')}`,
    lessonId: 'LSN-aaaaaa',
    activityType,
    title: 'Something',
    required: true,
    difficultyTier: 'D01',
    order: 0,
    ...extra,
  };
  if (expectedDurationMin !== undefined) a.expectedDurationMin = expectedDurationMin;
  return a;
}

// ---- normalizeDuration ----

test('normalizeDuration accepts a positive whole number', () => {
  assert.deepEqual(Core.normalizeDuration(20), { value: 20 });
  assert.deepEqual(Core.normalizeDuration('20'), { value: 20 });
  assert.deepEqual(Core.normalizeDuration(' 7 '), { value: 7 });
});

test('normalizeDuration reports blank rather than erroring — a blank row is left alone', () => {
  assert.deepEqual(Core.normalizeDuration(''), { blank: true });
  assert.deepEqual(Core.normalizeDuration('   '), { blank: true });
  assert.deepEqual(Core.normalizeDuration(null), { blank: true });
  assert.deepEqual(Core.normalizeDuration(undefined), { blank: true });
});

test('normalizeDuration rejects zero, negatives and fractions — matching the single-Activity form', () => {
  for (const bad of [0, -5, 1.5, 'abc', '10min']) {
    assert.ok(Core.normalizeDuration(bad).error, `${bad} should be rejected`);
  }
});

// ---- summarize ----

test('summarize returns one row per type present, never the whole type table', () => {
  const rows = Core.summarize([activity('quiz', 20), activity('quiz', 20), activity('drill')], TYPES);
  assert.deepEqual(rows.map((r) => r.activityTypeKey), ['drill', 'quiz']);
});

test('summarize keys a uniform row off every Activity carrying the same number', () => {
  const rows = Core.summarize([activity('quiz', 20), activity('quiz', 20)], TYPES);
  assert.equal(rows[0].uniformValue, 20);
  assert.equal(rows[0].unsetCount, 0);
  assert.equal(Core.describeRow(rows[0]), '2 Activities · all 20 min');
});

test('summarize refuses to pick a winner when one Activity of the type is unset', () => {
  const rows = Core.summarize([activity('quiz', 20), activity('quiz', 20), activity('quiz')], TYPES);
  assert.equal(rows[0].uniformValue, null);
  assert.equal(rows[0].unsetCount, 1);
  assert.deepEqual(rows[0].values, [20]);
  assert.equal(Core.describeRow(rows[0]), '3 Activities · 20 min · 1 with none');
});

test('summarize lists distinct values in ascending order on a mixed row', () => {
  const rows = Core.summarize([activity('quiz', 30), activity('quiz', 10), activity('quiz', 30)], TYPES);
  assert.deepEqual(rows[0].values, [10, 30]);
  assert.equal(rows[0].uniformValue, null);
  assert.equal(Core.describeRow(rows[0]), '3 Activities · 10, 30 min');
});

test('summarize describes an untouched type as having no duration set', () => {
  const rows = Core.summarize([activity('drill'), activity('drill')], TYPES);
  assert.deepEqual(rows[0].values, []);
  assert.equal(Core.describeRow(rows[0]), '2 Activities · no duration set');
});

test('summarize singularises a one-Activity row', () => {
  const rows = Core.summarize([activity('quiz', 15)], TYPES);
  assert.equal(Core.describeRow(rows[0]), '1 Activity · all 15 min');
});

test('summarize keeps a row for a type that no longer exists, labelled by its raw key', () => {
  const rows = Core.summarize([activity('quiz', 20), activity('lab-report', 45)], TYPES);
  // Unknown keys sort after every known one, so a deleted type never displaces
  // the table order of the types that survive.
  assert.deepEqual(rows.map((r) => r.activityTypeKey), ['quiz', 'lab-report']);
  assert.equal(rows[1].known, false);
  assert.equal(rows[1].label, 'lab-report');
});

test('summarize survives an empty type table', () => {
  const rows = Core.summarize([activity('quiz', 20)], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].known, false);
});

// ---- planUpdates ----

test('planUpdates sets the value on every Activity of the named type only', () => {
  const activities = [activity('quiz'), activity('quiz'), activity('drill', 5)];
  const plan = Core.planUpdates(activities, [{ activityTypeKey: 'quiz', mode: 'set', value: '20' }]);
  assert.equal(plan.updates.length, 2);
  assert.ok(plan.updates.every((a) => a.activityType === 'quiz' && a.expectedDurationMin === 20));
  assert.deepEqual(plan.changedByType, { quiz: 2 });
});

test('planUpdates skips Activities already at the target — a re-save writes nothing', () => {
  const activities = [activity('quiz', 20), activity('quiz', 20)];
  const plan = Core.planUpdates(activities, [{ activityTypeKey: 'quiz', mode: 'set', value: 20 }]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.changedByType, {});
  assert.equal(Core.describeResult(plan.changedByType), 'No changes — every Activity already had that duration.');
});

test('planUpdates applies several type rows in one run', () => {
  const activities = [activity('quiz'), activity('drill'), activity('practice-level')];
  const plan = Core.planUpdates(activities, [
    { activityTypeKey: 'quiz', mode: 'set', value: 20 },
    { activityTypeKey: 'drill', mode: 'set', value: 5 },
  ]);
  assert.equal(plan.updates.length, 2);
  assert.deepEqual(plan.changedByType, { quiz: 1, drill: 1 });
  // The untouched type is not in the plan at all.
  assert.ok(!plan.updates.some((a) => a.activityType === 'practice-level'));
});

test('planUpdates clear removes the key outright — never null, never 0', () => {
  const activities = [activity('quiz', 20), activity('quiz')];
  const plan = Core.planUpdates(activities, [{ activityTypeKey: 'quiz', mode: 'clear' }]);
  assert.equal(plan.updates.length, 1); // the already-unset row is untouched
  assert.equal('expectedDurationMin' in plan.updates[0], false);
  assert.deepEqual(plan.changedByType, { quiz: 1 });
});

test('planUpdates touches no other field on the record it rewrites', () => {
  const original = activity('workbook', undefined, {
    pageRangeStart: 45,
    pageRangeEnd: 60,
    instructions: 'Show your work',
    excludeFromGeneration: true,
  });
  const plan = Core.planUpdates([original], [{ activityTypeKey: 'workbook', mode: 'set', value: 25 }]);
  const written = plan.updates[0];
  assert.deepEqual(
    { ...written, expectedDurationMin: undefined },
    { ...original, expectedDurationMin: undefined }
  );
  assert.equal(written.expectedDurationMin, 25);
  // Spread, not mutation: the caller's row is unchanged until the write lands.
  assert.equal('expectedDurationMin' in original, false);
});

test('planUpdates rejects an invalid value without proposing any write, including for valid rows beside it', () => {
  const activities = [activity('quiz'), activity('drill')];
  const plan = Core.planUpdates(activities, [
    { activityTypeKey: 'drill', mode: 'set', value: 5 },
    { activityTypeKey: 'quiz', mode: 'set', value: '0' },
  ]);
  assert.ok(plan.error);
  assert.equal(plan.activityTypeKey, 'quiz');
  assert.equal(plan.updates, undefined);
});

test('planUpdates rejects a set with no value rather than silently clearing', () => {
  const plan = Core.planUpdates([activity('quiz', 20)], [{ activityTypeKey: 'quiz', mode: 'set', value: '' }]);
  assert.ok(plan.error);
});

test('planUpdates on no edits is a no-op', () => {
  assert.deepEqual(Core.planUpdates([activity('quiz', 20)], []).updates, []);
  assert.deepEqual(Core.planUpdates([activity('quiz', 20)]).updates, []);
});

// ---- describeResult ----

test('describeResult names the type when only one changed, and counts types otherwise', () => {
  assert.equal(Core.describeResult({ quiz: 1 }, { quiz: 'Quiz' }), 'Updated 1 Activity — Quiz.');
  assert.equal(Core.describeResult({ quiz: 12 }, { quiz: 'Quiz' }), 'Updated 12 Activities — Quiz.');
  assert.equal(Core.describeResult({ quiz: 12, drill: 2 }, {}), 'Updated 14 Activities across 2 types.');
});

test('describeResult says cleared, not updated, after a Clear run', () => {
  assert.equal(
    Core.describeResult({ quiz: 2 }, { quiz: 'Quiz' }, 'clear'),
    'Cleared the duration on 2 Activities — Quiz.'
  );
  assert.equal(
    Core.describeResult({}, {}, 'clear'),
    'No changes — no Activity of that type had a duration to clear.'
  );
});
