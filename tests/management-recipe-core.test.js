// Tests for the Management App's title-pattern engine (recipe-core.js).
// Per TDS_Slice_Lesson_Recipe.md §5.6/§5.6.1. Pure, DOM-free — same split as
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
const RecipeCore = loadModule('management-app/js/recipe-core.js', 'RecipeCore');

function typesByKey(overrides = {}) {
  const base = new Map([
    ['video', { activityTypeKey: 'video', label: 'Video', structurePattern: 'count' }],
    ['practice-level', { activityTypeKey: 'practice-level', label: 'Practice', structurePattern: 'count' }],
    ['quiz', { activityTypeKey: 'quiz', label: 'Quiz', structurePattern: 'count' }],
    ['pdf', { activityTypeKey: 'pdf', label: 'PDF', structurePattern: 'page-range' }],
    ['online-sim', { activityTypeKey: 'online-sim', label: 'Online Sim', structurePattern: 'count' }],
  ]);
  for (const [k, v] of Object.entries(overrides)) base.set(k, v);
  return base;
}

// ---------------------------------------------------------- builtInPattern

test('builtInPattern collapses video to {lesson} at count 1', () => {
  assert.equal(RecipeCore.builtInPattern('video', 1), '{lesson}');
  assert.equal(RecipeCore.builtInPattern('video', 2), '{lesson}: Part {n}');
});

test('builtInPattern gives practice/quiz a stable pattern regardless of count', () => {
  assert.equal(RecipeCore.builtInPattern('practice-level', 1), 'Level {n}');
  assert.equal(RecipeCore.builtInPattern('practice-level', 4), 'Level {n}');
  assert.equal(RecipeCore.builtInPattern('quiz', 1), 'Assessment {n}');
});

test('builtInPattern gives page-range types the page-range default', () => {
  assert.equal(RecipeCore.builtInPattern('pdf', 3), 'Pages {start}–{end}');
});

// ----------------------------------------------------------- resolvePattern

test('resolvePattern falls back to the built-in default with no override', () => {
  assert.equal(RecipeCore.resolvePattern('video', 1, undefined), '{lesson}');
  assert.equal(RecipeCore.resolvePattern('video', 1, {}), '{lesson}');
});

test('resolvePattern honors an override at every count, including count 1 (no collapse)', () => {
  const overrides = { video: '{lesson} — Lesson {n}' };
  assert.equal(RecipeCore.resolvePattern('video', 1, overrides), '{lesson} — Lesson {n}');
  assert.equal(RecipeCore.resolvePattern('video', 3, overrides), '{lesson} — Lesson {n}');
});

test('resolvePattern leaves other types on their default when only one type is overridden', () => {
  const overrides = { 'practice-level': 'Round {n}' };
  assert.equal(RecipeCore.resolvePattern('practice-level', 1, overrides), 'Round {n}');
  assert.equal(RecipeCore.resolvePattern('quiz', 1, overrides), 'Assessment {n}');
});

// -------------------------------------------------------------- renderTitle

test('renderTitle substitutes every token present in the context', () => {
  assert.equal(
    RecipeCore.renderTitle('{lesson}: Part {n}', { lesson: 'Adding Fractions', n: 2 }),
    'Adding Fractions: Part 2',
  );
  assert.equal(
    RecipeCore.renderTitle('Pages {start}–{end}', { start: 10, end: 13 }),
    'Pages 10–13',
  );
});

test('renderTitle leaves a token untouched when the context omits it', () => {
  assert.equal(RecipeCore.renderTitle('Pages {start}–{end}', { start: 10 }), 'Pages 10–{end}');
});

// ------------------------------------------------------ validatePatternString

test('validatePatternString accepts a pattern using only the five known tokens', () => {
  assert.deepEqual(RecipeCore.validatePatternString('{lesson}: Part {n}', 'count'), { ok: true });
});

test('validatePatternString rejects an unknown token', () => {
  const result = RecipeCore.validatePatternString('{lessson} {n}', 'count');
  assert.match(result.error, /Unknown token/);
});

test('validatePatternString rejects {start}/{end} on a non-page-range type', () => {
  const result = RecipeCore.validatePatternString('Pages {start}–{end}', 'count');
  assert.match(result.error, /page-range/);
});

test('validatePatternString allows {start}/{end} on a page-range type', () => {
  assert.deepEqual(RecipeCore.validatePatternString('Pages {start}–{end}', 'page-range'), { ok: true });
});

// ------------------------------------------------------ sanitizeTitlePatterns

test('sanitizeTitlePatterns drops blank entries rather than storing empty strings', () => {
  const result = RecipeCore.sanitizeTitlePatterns(
    { video: '  ', 'practice-level': 'Round {n}' },
    typesByKey(),
  );
  assert.deepEqual(result, { titlePatterns: { 'practice-level': 'Round {n}' } });
});

test('sanitizeTitlePatterns returns undefined titlePatterns when every entry is blank', () => {
  const result = RecipeCore.sanitizeTitlePatterns({ video: '', quiz: '   ' }, typesByKey());
  assert.deepEqual(result, { titlePatterns: undefined });
});

test('sanitizeTitlePatterns rejects an unresolvable Activity Type key', () => {
  const result = RecipeCore.sanitizeTitlePatterns({ nope: '{lesson}' }, typesByKey());
  assert.match(result.error, /Unknown Activity Type/);
});

test('sanitizeTitlePatterns rejects an invalid token, naming the type label', () => {
  const result = RecipeCore.sanitizeTitlePatterns({ video: '{lessson}' }, typesByKey());
  assert.match(result.error, /^Video:/);
});

test('sanitizeTitlePatterns rejects {start} on a count-structured type', () => {
  const result = RecipeCore.sanitizeTitlePatterns({ quiz: '{start}' }, typesByKey());
  assert.match(result.error, /page-range/);
});

test('sanitizeTitlePatterns accepts a valid sparse map spanning multiple types', () => {
  const result = RecipeCore.sanitizeTitlePatterns(
    { video: '{lesson} — Lesson {n}', pdf: 'Pages {start}–{end}' },
    typesByKey(),
  );
  assert.deepEqual(result, {
    titlePatterns: { video: '{lesson} — Lesson {n}', pdf: 'Pages {start}–{end}' },
  });
});

// -------------------------------------------------------- computeSplitChunks

test('computeSplitChunks: first-page mode on the worked example (10, 14 over budget 10-17)', () => {
  const result = RecipeCore.computeSplitChunks({ numbers: [10, 14], mode: 'first', budgetStart: 10, budgetEnd: 17 });
  assert.deepEqual(result.chunks, [{ start: 10, end: 13 }, { start: 14, end: 17 }]);
  assert.deepEqual(result.warnings, []);
});

test('computeSplitChunks: last-page mode on the worked example (13, 17) is byte-identical to first-page (10, 14) — acceptance check 5', () => {
  const first = RecipeCore.computeSplitChunks({ numbers: [10, 14], mode: 'first', budgetStart: 10, budgetEnd: 17 });
  const last = RecipeCore.computeSplitChunks({ numbers: [13, 17], mode: 'last', budgetStart: 10, budgetEnd: 17 });
  assert.deepEqual(last.chunks, first.chunks);
});

test('computeSplitChunks: single-chunk splits in both modes — the case that defeats inference', () => {
  const first = RecipeCore.computeSplitChunks({ numbers: [10], mode: 'first', budgetStart: 10, budgetEnd: 17 });
  const last = RecipeCore.computeSplitChunks({ numbers: [17], mode: 'last', budgetStart: 10, budgetEnd: 17 });
  assert.deepEqual(first.chunks, [{ start: 10, end: 17 }]);
  assert.deepEqual(last.chunks, [{ start: 10, end: 17 }]);
});

test('computeSplitChunks warns on a front gap without blocking (first mode)', () => {
  const result = RecipeCore.computeSplitChunks({ numbers: [12], mode: 'first', budgetStart: 10, budgetEnd: 17 });
  assert.deepEqual(result.chunks, [{ start: 12, end: 17 }]);
  assert.match(result.warnings.join(' '), /Front gap/);
});

test('computeSplitChunks warns on a back gap without blocking (last mode)', () => {
  const result = RecipeCore.computeSplitChunks({ numbers: [14], mode: 'last', budgetStart: 10, budgetEnd: 17 });
  assert.deepEqual(result.chunks, [{ start: 10, end: 14 }]);
  assert.match(result.warnings.join(' '), /Back gap/);
});

test('computeSplitChunks warns, but generates, when a split point falls outside the budget', () => {
  const result = RecipeCore.computeSplitChunks({ numbers: [5, 14], mode: 'first', budgetStart: 10, budgetEnd: 17 });
  assert.equal(result.error, undefined);
  assert.equal(result.chunks.length, 2);
  assert.match(result.warnings.join(' '), /outside the Lesson's page budget/);
});

test('computeSplitChunks rejects non-ascending or duplicate split points', () => {
  assert.match(RecipeCore.computeSplitChunks({ numbers: [14, 10], mode: 'first', budgetStart: 10, budgetEnd: 17 }).error, /strictly increasing/);
  assert.match(RecipeCore.computeSplitChunks({ numbers: [10, 10], mode: 'first', budgetStart: 10, budgetEnd: 17 }).error, /strictly increasing/);
});

// -------------------------------------------------------- buildProposalRows

function ctx(overrides = {}) {
  return {
    lessonTitle: 'Adding Fractions',
    budgetStart: 10,
    budgetEnd: 17,
    activityTypesByKey: typesByKey(),
    titlePatterns: undefined,
    ...overrides,
  };
}

test('buildProposalRows reproduces the worked example: 9 rows in entry order, each type consecutive', () => {
  const recipe = {
    entries: [
      { activityTypeKey: 'pdf', pageRange: { numbers: [10, 14], mode: 'first' } },
      { activityTypeKey: 'video', count: 1 },
      { activityTypeKey: 'practice-level', count: 4 },
      { activityTypeKey: 'online-sim', count: 1 },
      { activityTypeKey: 'quiz', count: 1 },
    ],
  };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.rows.map((r) => r.activityTypeKey), [
    'pdf', 'pdf', 'video', 'practice-level', 'practice-level', 'practice-level', 'practice-level', 'online-sim', 'quiz',
  ]);
});

test('buildProposalRows gives the two PDF chunks page ranges and Pages-pattern titles (acceptance check 4, pre-fill only)', () => {
  const recipe = { entries: [{ activityTypeKey: 'pdf', pageRange: { numbers: [10, 14], mode: 'first' } }] };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.deepEqual(
    result.rows.map((r) => [r.pageRangeStart, r.pageRangeEnd, r.title]),
    [[10, 13, 'Pages 10–13'], [14, 17, 'Pages 14–17']],
  );
});

test('buildProposalRows titles four Practice rows "Level 1".."Level 4" with no page range (acceptance check 6)', () => {
  const recipe = { entries: [{ activityTypeKey: 'practice-level', count: 4 }] };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.deepEqual(result.rows.map((r) => r.title), ['Level 1', 'Level 2', 'Level 3', 'Level 4']);
  assert.ok(result.rows.every((r) => r.pageRangeStart === undefined));
});

test('buildProposalRows collapses a single Video to the Lesson title; count 2 yields Part 1/Part 2 (acceptance check 7)', () => {
  const one = RecipeCore.buildProposalRows({ entries: [{ activityTypeKey: 'video', count: 1 }] }, ctx());
  assert.deepEqual(one.rows.map((r) => r.title), ['Adding Fractions']);
  const two = RecipeCore.buildProposalRows({ entries: [{ activityTypeKey: 'video', count: 2 }] }, ctx());
  assert.deepEqual(two.rows.map((r) => r.title), ['Adding Fractions: Part 1', 'Adding Fractions: Part 2']);
});

test('buildProposalRows drops a zero-count entry silently', () => {
  const recipe = { entries: [{ activityTypeKey: 'video', count: 0 }, { activityTypeKey: 'quiz', count: 1 }] };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.deepEqual(result.rows.map((r) => r.activityTypeKey), ['quiz']);
});

test('buildProposalRows rejects an all-zero recipe as empty', () => {
  const result = RecipeCore.buildProposalRows({ entries: [{ activityTypeKey: 'video', count: 0 }] }, ctx());
  assert.match(result.error, /generates no Activities/);
});

test('buildProposalRows rejects a second page-range entry (D11, acceptance check 10)', () => {
  const recipe = {
    entries: [
      { activityTypeKey: 'pdf', pageRange: { numbers: [10], mode: 'first' } },
      { activityTypeKey: 'workbook', pageRange: { numbers: [12], mode: 'first' } },
    ],
  };
  const result = RecipeCore.buildProposalRows(recipe, ctx({
    activityTypesByKey: typesByKey({ workbook: { activityTypeKey: 'workbook', label: 'Workbook', structurePattern: 'page-range' } }),
  }));
  assert.match(result.error, /At most one page-range/);
});

test('buildProposalRows honors a Course title-pattern override, including at count 1 (acceptance check 23)', () => {
  const recipe = { entries: [{ activityTypeKey: 'video', count: 1 }] };
  const result = RecipeCore.buildProposalRows(recipe, ctx({ titlePatterns: { video: '{lesson} — Lesson {n}' } }));
  assert.deepEqual(result.rows.map((r) => r.title), ['Adding Fractions — Lesson 1']);
});

test('buildProposalRows surfaces computeSplitChunks warnings on the whole-recipe result', () => {
  const recipe = { entries: [{ activityTypeKey: 'pdf', pageRange: { numbers: [12], mode: 'first' } }] };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.match(result.warnings.join(' '), /Front gap/);
});

test('buildProposalRows applies copied chunk titles positionally when the new split matches the copied count (§5.4)', () => {
  const recipe = {
    entries: [{
      activityTypeKey: 'pdf',
      pageRange: { numbers: [10, 14], mode: 'first', titleOverrides: ['Guided Notes', 'Fraction Detective'] },
    }],
  };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.deepEqual(result.rows.map((r) => r.title), ['Guided Notes', 'Fraction Detective']);
});

test('buildProposalRows falls back to pattern titles when the copied chunk-title count does not match the new split', () => {
  const recipe = {
    entries: [{
      activityTypeKey: 'pdf',
      pageRange: { numbers: [10], mode: 'first', titleOverrides: ['Guided Notes', 'Fraction Detective'] },
    }],
  };
  const result = RecipeCore.buildProposalRows(recipe, ctx());
  assert.deepEqual(result.rows.map((r) => r.title), ['Pages 10–17']);
});

// --------------------------------------------------------- finalizeProposal

test('finalizeProposal assigns contiguous order 0..N-1 in the given (post-reorder) array order', () => {
  const rows = [{ title: 'Quiz 1' }, { title: 'Video 1' }, { title: 'Level 1' }];
  const result = RecipeCore.finalizeProposal(rows);
  assert.deepEqual(result.rows.map((r) => r.order), [0, 1, 2]);
  assert.deepEqual(result.rows.map((r) => r.title), ['Quiz 1', 'Video 1', 'Level 1']);
});

test('finalizeProposal rejects a title blanked out by a Stage 2 edit', () => {
  const result = RecipeCore.finalizeProposal([{ title: '  ' }]);
  assert.match(result.error, /non-empty title/);
});

test('finalizeProposal rejects an empty row list', () => {
  const result = RecipeCore.finalizeProposal([]);
  assert.match(result.error, /generates no Activities/);
});

// ------------------------------------------------------ buildCopyFromLessonSeed

function committed(overrides = {}) {
  return { activityType: 'quiz', title: 'Assessment 1', ...overrides };
}

test('buildCopyFromLessonSeed derives entries in first-appearance order with per-type counts (§5.4 "types and counts", "the accepted order")', () => {
  const source = [
    committed({ activityType: 'pdf', title: 'Guided Notes', pageRangeStart: 10, pageRangeEnd: 13 }),
    committed({ activityType: 'pdf', title: 'Fraction Detective', pageRangeStart: 14, pageRangeEnd: 17 }),
    committed({ activityType: 'video', title: 'Adding Fractions' }),
    committed({ activityType: 'practice-level', title: 'Level 1' }),
    committed({ activityType: 'practice-level', title: 'Level 2' }),
    committed({ activityType: 'quiz', title: 'Assessment 1' }),
  ];
  const seed = RecipeCore.buildCopyFromLessonSeed(source);
  assert.deepEqual(seed.entries, [
    { activityTypeKey: 'pdf', pageRange: true },
    { activityTypeKey: 'video', count: 1 },
    { activityTypeKey: 'practice-level', count: 2 },
    { activityTypeKey: 'quiz', count: 1 },
  ]);
  assert.equal(seed.pageRangeTypeKey, 'pdf');
  assert.deepEqual(seed.pageRangeTitles, ['Guided Notes', 'Fraction Detective']);
});

test('buildCopyFromLessonSeed reports no page-range type when the source Lesson has none', () => {
  const source = [committed({ activityType: 'video', title: 'A' }), committed({ activityType: 'quiz', title: 'B' })];
  const seed = RecipeCore.buildCopyFromLessonSeed(source);
  assert.equal(seed.pageRangeTypeKey, null);
  assert.deepEqual(seed.pageRangeTitles, []);
});

test('buildCopyFromLessonSeed counts a type once at its first appearance even if the source was reordered to interleave', () => {
  const source = [
    committed({ activityType: 'video', title: 'Video 1' }),
    committed({ activityType: 'quiz', title: 'Assessment 1' }),
    committed({ activityType: 'video', title: 'Video 2' }),
  ];
  const seed = RecipeCore.buildCopyFromLessonSeed(source);
  assert.deepEqual(seed.entries, [
    { activityTypeKey: 'video', count: 2 },
    { activityTypeKey: 'quiz', count: 1 },
  ]);
});

test('buildCopyFromLessonSeed on an empty source produces no entries', () => {
  assert.deepEqual(RecipeCore.buildCopyFromLessonSeed([]), { entries: [], pageRangeTypeKey: null, pageRangeTitles: [] });
});

// ------------------------------------------------------ pickCourseSettingsToCopy

test('pickCourseSettingsToCopy copies configuration fields but never name, courseCode, id, or state (§5.7)', () => {
  const course = {
    id: 'COU-1', name: 'Math 5', courseCode: 'MATH5', state: 'template',
    curriculumId: 'CUR-1', subject: 'Math', coreElective: 'core', description: 'desc',
    defaultPacingHint: 'hint', titlePatterns: { video: '{lesson}' },
  };
  assert.deepEqual(RecipeCore.pickCourseSettingsToCopy(course), {
    curriculumId: 'CUR-1', subject: 'Math', coreElective: 'core', description: 'desc',
    defaultPacingHint: 'hint', titlePatterns: { video: '{lesson}' },
  });
});

test('pickCourseSettingsToCopy omits fields the source Course does not have, rather than copying undefined', () => {
  const course = { id: 'COU-1', name: 'Math 5', courseCode: 'MATH5', state: 'template', curriculumId: 'CUR-1' };
  assert.deepEqual(RecipeCore.pickCourseSettingsToCopy(course), { curriculumId: 'CUR-1' });
});
