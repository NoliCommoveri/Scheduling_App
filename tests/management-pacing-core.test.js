// Tests for the Management App's pacing-hint reader (pacing-core.js).
// Per SRS_Management_Module_05_Pacing_Configuration.md §2.6a/FR-1a. Pure,
// DOM-free — same split as recipe-core.js, worker/validation.js and the Child
// App's *-core.js files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const PacingCore = loadModule('management-app/js/pacing-core.js', 'PacingCore');

// ------------------------------------------------------------- parseHint

test('reads the documented labelled forms', () => {
  assert.deepEqual(PacingCore.parseHint('Activities Per Day - 2'), {
    pacingMode: 'activityCount',
    activitiesPerDay: 2,
  });
  assert.deepEqual(PacingCore.parseHint('Minutes Per Day - 60'), {
    pacingMode: 'minutesBudget',
    minutesPerDay: 60,
  });
});

test('label form is case- and delimiter-tolerant', () => {
  for (const hint of [
    'minutes per day - 45',
    'MINUTES PER DAY: 45',
    'Minutes Per Day = 45',
    'Minutes per day 45',
    'Minutes/day - 45',
  ]) {
    assert.equal(PacingCore.parseHint(hint).minutesPerDay, 45, hint);
  }
});

test('reads two labelled clauses from one line', () => {
  assert.deepEqual(PacingCore.parseHint('Minutes Per Day - 60; Days - Mon/Wed/Fri'), {
    daysOfWeek: ['Mon', 'Wed', 'Fri'],
    pacingMode: 'minutesBudget',
    minutesPerDay: 60,
  });
});

test('a comma inside a day list is not a clause boundary', () => {
  assert.deepEqual(PacingCore.parseHint('Days - Mon, Wed, Fri, Activities Per Day - 3'), {
    daysOfWeek: ['Mon', 'Wed', 'Fri'],
    pacingMode: 'activityCount',
    activitiesPerDay: 3,
  });
});

test('reads looser free text already typed into the field', () => {
  assert.deepEqual(PacingCore.parseHint('45 min a day, Mon-Thu'), {
    daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu'],
    pacingMode: 'minutesBudget',
    minutesPerDay: 45,
  });
  assert.deepEqual(PacingCore.parseHint('three lessons per day'), {
    pacingMode: 'activityCount',
    activitiesPerDay: 3,
  });
  assert.deepEqual(PacingCore.parseHint('2/day'), {
    pacingMode: 'activityCount',
    activitiesPerDay: 2,
  });
});

test('day words, ranges and letter tokens all resolve to canonical order', () => {
  const cases = [
    ['Days - weekdays', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']],
    ['Days - daily', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']],
    ['Days - weekends', ['Sun', 'Sat']],
    ['Days - Monday through Friday', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']],
    ['Days - Fri, Tue', ['Tue', 'Fri']],
    ['Days - Tuesday and Thursday', ['Tue', 'Thu']],
    ['Days - MWF', ['Mon', 'Wed', 'Fri']],
    ['Days - T/R', ['Tue', 'Thu']],
    ['Days - Sat-Sun', ['Sun', 'Sat']],
  ];
  for (const [hint, expected] of cases) {
    assert.deepEqual(PacingCore.parseHint(hint).daysOfWeek, expected, hint);
  }
});

test('a duplicated day is collapsed, not repeated', () => {
  assert.deepEqual(PacingCore.parseHint('Days - Mon, Monday, Mon-Tue').daysOfWeek, ['Mon', 'Tue']);
});

// Letter tokens are the fallback reading, not an additional one: a hint that
// spells any day out is read by name only, so an ordinary uppercase word
// sitting beside "Mon" cannot inject days of its own.
test('letter tokens are ignored once a day is spelled out', () => {
  assert.deepEqual(PacingCore.parseHint('Days - Mon, Wed (see the SUM chapter)').daysOfWeek, ['Mon', 'Wed']);
});

test('minutes are read before the bare per-day count, never as one', () => {
  const parsed = PacingCore.parseHint('60 minutes per day');
  assert.equal(parsed.pacingMode, 'minutesBudget');
  assert.equal(parsed.minutesPerDay, 60);
  assert.equal(parsed.activitiesPerDay, undefined);
});

test('a count and a minutes aside together read as a count', () => {
  assert.deepEqual(PacingCore.parseHint('3 lessons per day, about 30 minutes'), {
    pacingMode: 'activityCount',
    activitiesPerDay: 3,
  });
});

test('a weekly figure is not read as a daily budget', () => {
  assert.deepEqual(PacingCore.parseHint('3 lessons per week'), {});
  assert.deepEqual(PacingCore.parseHint('120 minutes a week'), {});
  // "weekdays" is not a weekly clause.
  assert.deepEqual(PacingCore.parseHint('2 activities per day on weekdays'), {
    daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    pacingMode: 'activityCount',
    activitiesPerDay: 2,
  });
});

test('unusable hints parse to nothing rather than guessing', () => {
  for (const hint of [undefined, null, '', '   ', 'go at his own pace', 'follow the book']) {
    assert.deepEqual(PacingCore.parseHint(hint), {}, String(hint));
  }
});

test('out-of-range and zero values are refused', () => {
  assert.deepEqual(PacingCore.parseHint('Activities Per Day - 0'), {});
  assert.deepEqual(PacingCore.parseHint('Minutes Per Day - 0'), {});
  assert.deepEqual(PacingCore.parseHint('Minutes Per Day - 5000'), {});
  assert.deepEqual(PacingCore.parseHint('Activities Per Day - 500'), {});
});

test('an ordinary sentence is not mined for stray day letters', () => {
  assert.equal(PacingCore.parseHint('Use the M textbook').daysOfWeek, undefined);
  assert.equal(PacingCore.parseHint('minutes per day - 30').daysOfWeek, undefined);
});

// -------------------------------------------------- defaultProfileFields

test('a fully-stated hint fills every field and is marked as hint-sourced', () => {
  const { fields, source } = PacingCore.defaultProfileFields(
    'Activities Per Day - 2; Days - Mon/Wed/Fri',
    '2026-08-13'
  );
  assert.deepEqual(fields, {
    startDate: '2026-08-13',
    daysOfWeek: ['Mon', 'Wed', 'Fri'],
    pacingMode: 'activityCount',
    activitiesPerDay: 2,
  });
  assert.deepEqual(source, { days: 'hint', budget: 'hint' });
});

test('a hint stating only a budget takes the default days', () => {
  const { fields, source } = PacingCore.defaultProfileFields('Minutes Per Day - 60', '2026-08-13');
  assert.deepEqual(fields, {
    startDate: '2026-08-13',
    daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    pacingMode: 'minutesBudget',
    minutesPerDay: 60,
  });
  assert.deepEqual(source, { days: 'default', budget: 'hint' });
});

test('a hint stating only days takes the default budget', () => {
  const { fields, source } = PacingCore.defaultProfileFields('Days - Tue/Thu', '2026-08-13');
  assert.deepEqual(fields, {
    startDate: '2026-08-13',
    daysOfWeek: ['Tue', 'Thu'],
    pacingMode: 'activityCount',
    activitiesPerDay: 1,
  });
  assert.deepEqual(source, { days: 'hint', budget: 'default' });
});

test('no hint at all still yields a complete, valid field set', () => {
  const { fields, source } = PacingCore.defaultProfileFields(undefined, '2026-08-13');
  assert.deepEqual(fields, {
    startDate: '2026-08-13',
    daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    pacingMode: 'activityCount',
    activitiesPerDay: 1,
  });
  assert.deepEqual(source, { days: 'default', budget: 'default' });
});

test('the field set never carries the other mode\'s budget key', () => {
  const minutes = PacingCore.defaultProfileFields('Minutes Per Day - 60', '2026-08-13').fields;
  assert.ok(!('activitiesPerDay' in minutes));
  const count = PacingCore.defaultProfileFields('Activities Per Day - 4', '2026-08-13').fields;
  assert.ok(!('minutesPerDay' in count));
});

// ------------------------------------------------------------- describe

test('describe reads back as parent-facing copy', () => {
  assert.equal(
    PacingCore.describe(PacingCore.defaultProfileFields('Activities Per Day - 2; Days - MWF', '2026-08-13').fields),
    'Mon/Wed/Fri · 2 activities/day'
  );
  assert.equal(
    PacingCore.describe(PacingCore.defaultProfileFields('Minutes Per Day - 60', '2026-08-13').fields),
    'Mon/Tue/Wed/Thu/Fri · 60 min/day'
  );
  assert.equal(
    PacingCore.describe(PacingCore.defaultProfileFields('', '2026-08-13').fields),
    'Mon/Tue/Wed/Thu/Fri · 1 activity/day'
  );
});
