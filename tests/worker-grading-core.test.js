// Tests for the Grading Assistant's pure layer
// (management-app/worker/grading-core.js, management-app/worker/word-list.js).
//
// Per TDS_Slice_Grading_Assistant.md §8 — Phase 2's three suites: rubric
// resolution, the mechanics filter, and score normalization. Neither file
// touches D1, Request, or Response, so these run with no network and no
// database, same as tests/worker-validation.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUBRIC_DEFAULTS,
  resolveRubric,
  rubricToPrompt,
  parseGradeNumber,
  fryCeilingForGrade,
  resolveMechanicsFinding,
  normalizeScore,
  distinctPageCount,
} from '../management-app/worker/grading-core.js';
import { FRY_HUNDREDS, fryRank } from '../management-app/worker/word-list.js';

// ---------------------------------------------------------- word-list.js

test('FRY_HUNDREDS holds exactly 1000 words across 10 groups of 100', () => {
  assert.equal(FRY_HUNDREDS.length, 10);
  for (const hundred of FRY_HUNDREDS) assert.equal(hundred.length, 100);
  const total = FRY_HUNDREDS.reduce((n, h) => n + h.length, 0);
  assert.equal(total, 1000);
});

test('fryRank ranks the first and last words of the list', () => {
  assert.equal(fryRank('the'), 1);
  assert.equal(fryRank('view'), 1000);
});

test('fryRank is case-insensitive', () => {
  assert.equal(fryRank('THE'), 1);
  assert.equal(fryRank('The'), 1);
});

test('fryRank returns null for a word not in the list', () => {
  assert.equal(fryRank('photosynthesis'), null);
  assert.equal(fryRank(''), null);
  assert.equal(fryRank(null), null);
  assert.equal(fryRank(undefined), null);
});

// --------------------------------------------------- rubric resolution (§2.2)

test('resolveRubric with no overrides resolves to exactly RUBRIC_DEFAULTS', () => {
  assert.deepEqual(resolveRubric(undefined, undefined), RUBRIC_DEFAULTS);
  assert.deepEqual(resolveRubric(null, null), RUBRIC_DEFAULTS);
  assert.deepEqual(resolveRubric({}, {}), RUBRIC_DEFAULTS);
});

test('resolveRubric lets household defaults override the built-in defaults', () => {
  const rubric = resolveRubric(undefined, { grammar: 'on', partialCredit: false });
  assert.equal(rubric.grammar, 'on');
  assert.equal(rubric.partialCredit, false);
  // untouched keys still fall through to the built-in defaults
  assert.equal(rubric.spelling, RUBRIC_DEFAULTS.spelling);
  assert.equal(rubric.paraphraseTolerance, RUBRIC_DEFAULTS.paraphraseTolerance);
});

test('resolveRubric is sparse: a course override only touches the keys it sets', () => {
  const household = { spelling: 'all', grammar: 'on' };
  const courseOverride = { spelling: 'off' };
  const rubric = resolveRubric(courseOverride, household);
  assert.equal(rubric.spelling, 'off', 'course override wins over household default');
  assert.equal(rubric.grammar, 'on', 'household default falls through when the course is silent');
});

test('resolveRubric drops an invalid value at any layer and falls through instead', () => {
  const rubric = resolveRubric(
    { spelling: 'sometimes' }, // not one of the enum values
    { spelling: 'all' },
  );
  assert.equal(rubric.spelling, 'all', 'invalid course value falls through to household');
});

test('resolveRubric drops a wrong-typed partialCredit and falls through', () => {
  const rubric = resolveRubric({ partialCredit: 'yes' }, undefined);
  assert.equal(rubric.partialCredit, RUBRIC_DEFAULTS.partialCredit);
});

test('resolveRubric passes houseRules through verbatim when it is a string', () => {
  const rubric = resolveRubric({ houseRules: 'Accept British spellings.' }, undefined);
  assert.equal(rubric.houseRules, 'Accept British spellings.');
});

test('resolveRubric never leaks an unknown key into the resolved rubric', () => {
  const rubric = resolveRubric({ notARubricField: 'x' }, undefined);
  assert.equal('notARubricField' in rubric, false);
  assert.deepEqual(Object.keys(rubric).sort(), Object.keys(RUBRIC_DEFAULTS).sort());
});

// ------------------------------------------------------- rubricToPrompt (§6)

test('rubricToPrompt is a deterministic function of its inputs (cache breakpoint, §6)', () => {
  const rubric = resolveRubric({}, {});
  const a = rubricToPrompt(rubric, '5th grade');
  const b = rubricToPrompt(rubric, '5th grade');
  assert.equal(a, b);
});

test('rubricToPrompt text changes with paraphraseTolerance', () => {
  const strict = rubricToPrompt(resolveRubric({ paraphraseTolerance: 'strict' }, {}), '5th grade');
  const generous = rubricToPrompt(resolveRubric({ paraphraseTolerance: 'generous' }, {}), '5th grade');
  assert.notEqual(strict, generous);
  assert.match(strict, /Accept only responses that match/);
  assert.match(generous, /benefit of the doubt/);
});

test('rubricToPrompt appends houseRules verbatim when present, omits it when empty', () => {
  const withRules = rubricToPrompt(resolveRubric({ houseRules: 'No red ink language.' }, {}), '3rd grade');
  assert.match(withRules, /No red ink language\./);

  const withoutRules = rubricToPrompt(resolveRubric({}, {}), '3rd grade');
  assert.doesNotMatch(withoutRules, /No red ink language\./);
});

test('rubricToPrompt mentions grammar only when the rubric turns it on', () => {
  const on = rubricToPrompt(resolveRubric({ grammar: 'on' }, {}), '5th grade');
  const off = rubricToPrompt(resolveRubric({ grammar: 'off' }, {}), '5th grade');
  assert.match(on, /Also report grammar errors/);
  assert.doesNotMatch(off, /Also report grammar errors/);
});

// --------------------------------------------------- grade → Fry ceiling (§3.1)

test('parseGradeNumber reads a leading or embedded number out of free text', () => {
  assert.equal(parseGradeNumber('5th Grade'), 5);
  assert.equal(parseGradeNumber('Grade 3'), 3);
  assert.equal(parseGradeNumber('7'), 7);
});

test('parseGradeNumber recognizes kindergarten as grade 0', () => {
  assert.equal(parseGradeNumber('Kindergarten'), 0);
  assert.equal(parseGradeNumber('K'), 0);
});

test('parseGradeNumber returns null for unrecognizable text', () => {
  assert.equal(parseGradeNumber('Advanced'), null);
  assert.equal(parseGradeNumber(''), null);
  assert.equal(parseGradeNumber(null), null);
});

test('fryCeilingForGrade follows the §3.1 table', () => {
  assert.equal(fryCeilingForGrade('1st Grade'), 300);
  assert.equal(fryCeilingForGrade('3rd Grade'), 300);
  assert.equal(fryCeilingForGrade('4th Grade'), 600);
  assert.equal(fryCeilingForGrade('5th Grade'), 1000);
  assert.equal(fryCeilingForGrade('9th Grade'), 1000);
});

test('fryCeilingForGrade falls back to the narrowest tier for an unparseable label', () => {
  // Favors the child (grading-core.js's own rationale): a data-entry gap
  // should never widen what counts against them.
  assert.equal(fryCeilingForGrade('gifted program'), 300);
  assert.equal(fryCeilingForGrade(undefined), 300);
});

// -------------------------------------------------- mechanics filter (§3.2)

test('resolveMechanicsFinding: spelling off never counts, regardless of list membership', () => {
  const rubric = resolveRubric({ spelling: 'off' }, {});
  const common = resolveMechanicsFinding({ kind: 'spelling', intended: 'the', ageJudgment: 'expected' }, rubric, '5th Grade');
  assert.deepEqual(common, { counted: 0, source: 'list' });

  const rare = resolveMechanicsFinding({ kind: 'spelling', intended: 'photosynthesis', ageJudgment: 'advanced' }, rubric, '5th Grade');
  assert.deepEqual(rare, { counted: 0, source: 'list' });
});

test('resolveMechanicsFinding: a word in the Fry list at or below the child\'s level always counts, source "list"', () => {
  const rubric = resolveRubric({ spelling: 'listOnly' }, {});
  // "the" is rank 1 — inside any grade's ceiling.
  const result = resolveMechanicsFinding({ kind: 'spelling', intended: 'the', ageJudgment: 'advanced' }, rubric, '1st Grade');
  assert.deepEqual(result, { counted: 1, source: 'list' });
});

test('resolveMechanicsFinding: a Fry word above the child\'s grade ceiling does not count via the list arm', () => {
  const rubric = resolveRubric({ spelling: 'listOnly' }, {});
  // "molecules" (Tenth Hundred, rank ~900s) is well past a 1st grader's 300-word ceiling.
  const result = resolveMechanicsFinding({ kind: 'spelling', intended: 'molecules', ageJudgment: 'expected' }, rubric, '1st Grade');
  assert.deepEqual(result, { counted: 0, source: 'list' });
});

test('resolveMechanicsFinding: not in the list, spelling "all" falls to the model\'s ageJudgment', () => {
  const rubric = resolveRubric({ spelling: 'all' }, {});
  const expected = resolveMechanicsFinding({ kind: 'spelling', intended: 'photosynthesis', ageJudgment: 'expected' }, rubric, '5th Grade');
  assert.deepEqual(expected, { counted: 1, source: 'model' });

  const advanced = resolveMechanicsFinding({ kind: 'spelling', intended: 'photosynthesis', ageJudgment: 'advanced' }, rubric, '5th Grade');
  assert.deepEqual(advanced, { counted: 0, source: 'model' });
});

test('resolveMechanicsFinding: not in the list, spelling "listOnly" is recorded but never counted', () => {
  const rubric = resolveRubric({ spelling: 'listOnly' }, {});
  const result = resolveMechanicsFinding({ kind: 'spelling', intended: 'photosynthesis', ageJudgment: 'expected' }, rubric, '5th Grade');
  assert.deepEqual(result, { counted: 0, source: 'list' });
});

test('resolveMechanicsFinding: grammar counts only when the rubric turns it on, source is always "model"', () => {
  const on = resolveMechanicsFinding({ kind: 'grammar' }, resolveRubric({ grammar: 'on' }, {}), '5th Grade');
  assert.deepEqual(on, { counted: 1, source: 'model' });

  const off = resolveMechanicsFinding({ kind: 'grammar' }, resolveRubric({ grammar: 'off' }, {}), '5th Grade');
  assert.deepEqual(off, { counted: 0, source: 'model' });
});

// --------------------------------------------------- score normalization (§8.3)

test('normalizeScore counts CORRECT as 1 and INCORRECT as 0', () => {
  const rubric = resolveRubric({}, {});
  const result = normalizeScore(
    [{ verdict: 'CORRECT' }, { verdict: 'CORRECT' }, { verdict: 'INCORRECT' }],
    rubric,
  );
  assert.deepEqual(result, { score: 2, outOf: 3, excluded: 0 });
});

test('normalizeScore counts PARTIAL as half when partialCredit is on', () => {
  const rubric = resolveRubric({ partialCredit: true }, {});
  const result = normalizeScore([{ verdict: 'PARTIAL' }, { verdict: 'CORRECT' }], rubric);
  assert.deepEqual(result, { score: 1.5, outOf: 2, excluded: 0 });
});

test('normalizeScore counts PARTIAL as zero, but still in the denominator, when partialCredit is off', () => {
  const rubric = resolveRubric({ partialCredit: false }, {});
  const result = normalizeScore([{ verdict: 'PARTIAL' }, { verdict: 'CORRECT' }], rubric);
  assert.deepEqual(result, { score: 1, outOf: 2, excluded: 0 });
});

test('normalizeScore excludes BLANK and UNSURE from the denominator entirely', () => {
  const rubric = resolveRubric({}, {});
  const result = normalizeScore(
    [{ verdict: 'CORRECT' }, { verdict: 'BLANK' }, { verdict: 'UNSURE' }, { verdict: 'INCORRECT' }],
    rubric,
  );
  assert.deepEqual(result, { score: 1, outOf: 2, excluded: 2 });
});

test('normalizeScore guards the empty-denominator case: score is null, not NaN or 0', () => {
  const rubric = resolveRubric({}, {});
  assert.deepEqual(normalizeScore([], rubric), { score: null, outOf: 0, excluded: 0 });
  assert.deepEqual(
    normalizeScore([{ verdict: 'BLANK' }, { verdict: 'UNSURE' }], rubric),
    { score: null, outOf: 0, excluded: 2 },
  );
});

// ------------------------------------- score normalization across pages (§12.7.1)

test('normalizeScore folds items drawn from several pages into one score', () => {
  const rubric = resolveRubric({}, {});
  const result = normalizeScore(
    [
      { verdict: 'CORRECT', page: 1 },
      { verdict: 'INCORRECT', page: 1 },
      { verdict: 'CORRECT', page: 2 },
      { verdict: 'PARTIAL', page: 3 },
    ],
    rubric,
  );
  assert.deepEqual(result, { score: 2.5, outOf: 4, excluded: 0 });
});

test('normalizeScore across pages still excludes BLANK/UNSURE from the denominator', () => {
  const rubric = resolveRubric({}, {});
  const result = normalizeScore(
    [
      { verdict: 'CORRECT', page: 1 },
      { verdict: 'BLANK', page: 2 },
      { verdict: 'UNSURE', page: 3 },
      { verdict: 'INCORRECT', page: 3 },
    ],
    rubric,
  );
  assert.deepEqual(result, { score: 1, outOf: 2, excluded: 2 });
});

test('normalizeScore is unaffected by a page contributing no items at all', () => {
  const rubric = resolveRubric({}, {});
  // Page 2 contributes nothing (e.g. it was a read-only page) — the result
  // must be identical to an item set that never mentions page 2 at all.
  const withGap = normalizeScore(
    [{ verdict: 'CORRECT', page: 1 }, { verdict: 'INCORRECT', page: 3 }],
    rubric,
  );
  const withoutGap = normalizeScore(
    [{ verdict: 'CORRECT', page: 1 }, { verdict: 'INCORRECT', page: 2 }],
    rubric,
  );
  assert.deepEqual(withGap, withoutGap);
});

// -------------------------------------------------- page attribution (§12.7.2)

test('distinctPageCount counts unique page numbers referenced by an item set', () => {
  const items = [{ page: 1 }, { page: 1 }, { page: 2 }, { page: 3 }, { page: 3 }];
  assert.equal(distinctPageCount(items), 3);
});

test('distinctPageCount ignores items with a missing or non-integer page', () => {
  const items = [{ page: 1 }, { page: null }, {}, { page: 'two' }, { page: 1.5 }];
  assert.equal(distinctPageCount(items), 1);
});

test('distinctPageCount is 0 for an empty, null, or non-array item list', () => {
  assert.equal(distinctPageCount([]), 0);
  assert.equal(distinctPageCount(null), 0);
  assert.equal(distinctPageCount(undefined), 0);
});

test('distinctPageCount never exceeds page_count for a well-formed multi-page response', () => {
  const pageCount = 3;
  const items = [
    { page: 1 }, { page: 1 }, { page: 2 }, { page: 3 }, { page: 3 }, { page: 3 },
  ];
  assert.ok(distinctPageCount(items) <= pageCount);
});

test('distinctPageCount flags a response that attributes items beyond the pages actually sent', () => {
  const pageCount = 2;
  // page 5 was never photographed for this 2-page assignment
  const items = [{ page: 1 }, { page: 2 }, { page: 5 }];
  assert.ok(distinctPageCount(items) > pageCount);
});
