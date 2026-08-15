/* Grading Assistant §2.2 — the pure layer. DOM-free, IO-free: no D1, no
 * Request, no Response, no crypto. Same split as validation.js and the
 * Child/Wall Apps' `*-core.js` files, and for the same reason — this is the
 * most behaviour-critical code in the feature, so it is the code worth
 * exercising directly in tests/, with no network call and no database.
 *
 * Three responsibilities, per §9 Phase 2: rubric resolution, the mechanics
 * filter, and score normalization. The grading call itself and the tables
 * its proposals land in are Phase 3 — nothing here touches either.
 */

import { fryRank } from './word-list.js';

// ---- the rubric model (§2) ----

// §2.1's table, verbatim. The bottom of the three-layer fall-through
// (householdDefaults, then a course's sparse override) that resolveRubric
// resolves against.
export const RUBRIC_DEFAULTS = Object.freeze({
  spelling: 'listOnly',
  grammar: 'off',
  paraphraseTolerance: 'normal',
  partialCredit: true,
  houseRules: '',
});

// One validator per field, so a malformed layer (bad settings JSON, a typo
// in a course record) is dropped rather than propagated into a prompt or a
// stored digest. Unlike validateCompletionValue in validation.js, an invalid
// value here has no route to reject a request with a 400 — a rubric is
// read, not submitted — so "fall through to the layer below" is the only
// sane failure mode.
const RUBRIC_VALIDATORS = {
  spelling: (v) => v === 'off' || v === 'listOnly' || v === 'all',
  grammar: (v) => v === 'off' || v === 'on',
  paraphraseTolerance: (v) => v === 'strict' || v === 'normal' || v === 'generous',
  partialCredit: (v) => typeof v === 'boolean',
  houseRules: (v) => typeof v === 'string',
};

// Keeps only the keys of `layer` that are both a real rubric field and pass
// that field's validator. `null`/`undefined` never survive this — for this
// model, unlike a completion value, there is no "clear it" write; an absent
// or unusable key simply means the layer above did not decide it.
function validLayerKeys(layer) {
  if (!layer || typeof layer !== 'object') return {};
  const out = {};
  for (const key of Object.keys(RUBRIC_DEFAULTS)) {
    if (key in layer && RUBRIC_VALIDATORS[key](layer[key])) out[key] = layer[key];
  }
  return out;
}

// §2.2 — resolveRubric(courseOverride, householdDefaults) → rubric.
// Three layers, resolved in order: built-in defaults, then household
// defaults, then the course's own sparse override. Reused verbatim from
// TDS_Slice_Lesson_Recipe.md D13's titlePatterns pattern (recipe-core.js
// resolvePattern): absent keys fall through, so improving a default still
// reaches every course that has not opted out of it.
export function resolveRubric(courseOverride, householdDefaults) {
  return {
    ...RUBRIC_DEFAULTS,
    ...validLayerKeys(householdDefaults),
    ...validLayerKeys(courseOverride),
  };
}

// §2.2 — rubricToPrompt(rubric, gradeLevel) → string. Ordering matters for
// §6's cache breakpoint: this text is the "resolved rubric text" layer,
// stable per course, so it must be byte-identical across every child's page
// for the same course or the cache never hits.
//
// The base instructions mirror Grading_Assistant_Pre_Build_Test.md §2 —
// that manual prompt is the one this feature is validated against, so the
// built prompt does not depart from its wording without a reason.
export function rubricToPrompt(rubric, gradeLevel) {
  const lines = [
    `Grade against what is reasonable for a student at this level: ${gradeLevel}. Incomplete sentences, weak spelling, and informal phrasing are not errors unless the item is specifically testing those things.`,
  ];

  switch (rubric.paraphraseTolerance) {
    case 'strict':
      lines.push('The answer key gives the required wording. Accept only responses that match its content and phrasing closely — do not credit a differently-worded answer even if it conveys a similar idea.');
      break;
    case 'generous':
      lines.push('The answer key gives one example answer, not the only acceptable one. Accept any response that conveys a related idea, even loosely, giving the student the benefit of the doubt.');
      break;
    case 'normal':
    default:
      lines.push("The answer key gives a MODEL answer, not the only acceptable one. Accept any response that conveys the same idea. Do not require the key's wording, phrasing, or level of detail.");
      break;
  }

  lines.push(
    'Mark an item BLANK if it was not attempted. Do not mark it incorrect. These are different and they matter differently.',
    'Do not invent errors. If the answer is acceptable, say so plainly.',
    'If you cannot read the handwriting, or you genuinely cannot tell whether an answer should count, mark the item UNSURE and say why. An honest UNSURE is more useful than a confident guess. Do not guess.',
  );

  lines.push(
    rubric.partialCredit
      ? 'A PARTIAL verdict is available for an answer that is partly correct; it will count as half credit.'
      : 'A PARTIAL verdict is available for an answer that is partly correct, but this course does not award partial credit for it.',
  );

  // §3.2 — the model reports every suspected misspelling and grammar issue;
  // the Worker decides what counts. Instructing it to pre-filter nothing
  // keeps that decision entirely server-side.
  lines.push(
    'Separately, report every suspected spelling error you notice, regardless of whether you think it should count against the student: for each, give the word as written, what you believe was intended, and whether that word is age-expected or advanced for the stated grade level. Pre-filter nothing — report all of them and let the grading system decide which count.',
  );
  if (rubric.grammar === 'on') {
    lines.push('Also report grammar errors you notice, the same way.');
  }

  if (rubric.houseRules) {
    lines.push(rubric.houseRules);
  }

  return lines.join('\n');
}

// ---- mechanics: the filter (§3) ----

// §3.1's table. A guess until real results exist (§11.3) — deliberately one
// constant, so it is trivial to retune once real accuracy data comes in.
// Keyed by grade *ceiling*: a child at this grade or below has this Fry rank
// or lower counted against them.
const FRY_CEILING_BY_GRADE = [
  { maxGrade: 3, ceiling: 300 },
  { maxGrade: 4, ceiling: 600 },
];
const FRY_CEILING_DEFAULT = 1000; // grade 5+, and the fallback below

// A child's `gradeLabel` (children.js:48) is free text a parent typed —
// "5th Grade", "Grade 3", "Kindergarten" — not an enum. This pulls the
// first meaningful number out of it, or recognizes kindergarten as grade 0.
// Returns null when nothing recognizable is present.
export function parseGradeNumber(gradeLabel) {
  if (typeof gradeLabel !== 'string') return null;
  const lower = gradeLabel.toLowerCase();
  if (/\bk\b/.test(lower) || lower.includes('kinder')) return 0;
  const match = /\d+/.exec(lower);
  return match ? Number.parseInt(match[0], 10) : null;
}

// An unparseable gradeLabel gets the narrowest tier (300), not the widest —
// a data-entry gap in the Management App should never be the reason a word
// outside a child's likely level counts against them. Favors the child, per
// the same weighting §0.4/§4.2's L-vs-H distinction gives silent leniency
// its lower priority: an uncounted finding is still recorded (§0.4), so
// nothing is lost, only left out of the child's score until the label is
// filled in.
export function fryCeilingForGrade(gradeLabel) {
  const grade = parseGradeNumber(gradeLabel);
  if (grade === null) return FRY_CEILING_BY_GRADE[0].ceiling;
  const tier = FRY_CEILING_BY_GRADE.find((t) => grade <= t.maxGrade);
  return tier ? tier.ceiling : FRY_CEILING_DEFAULT;
}

// §3.2 — resolves one model-reported finding into { counted, source }. The
// caller (the Phase 3 grading route) combines this with the rest of the row
// (child_id, assignment_id, as_written, intended, found_at) before the
// insert into mechanics_findings — every finding is written regardless of
// `counted` (§0.4), so this function only ever decides that one field.
//
// `finding` is `{ kind, intended, ageJudgment }` — as_written plays no part
// in the decision, only in what gets stored.
export function resolveMechanicsFinding(finding, rubric, gradeLabel) {
  if (finding.kind === 'grammar') {
    // No word list for grammar — the model is the only arm there is.
    return { counted: rubric.grammar === 'on' ? 1 : 0, source: 'model' };
  }

  // spelling, in §3.2's order:
  if (rubric.spelling === 'off') return { counted: 0, source: 'list' };

  const rank = fryRank(finding.intended);
  if (rank !== null && rank <= fryCeilingForGrade(gradeLabel)) {
    return { counted: 1, source: 'list' };
  }

  if (rubric.spelling === 'all') {
    return { counted: finding.ageJudgment === 'expected' ? 1 : 0, source: 'model' };
  }

  // not in the list, and spelling: 'listOnly'
  return { counted: 0, source: 'list' };
}

// ---- score normalization (§8.3) ----

const COUNTED_VERDICTS = new Set(['CORRECT', 'PARTIAL', 'INCORRECT']);

// §8.3 — normalizeScore(items, rubric) → { score, outOf }. BLANK and UNSURE
// are excluded from the denominator entirely (§6 — an honest UNSURE is the
// system working, not a wrong answer); PARTIAL counts as half only when the
// rubric's partialCredit is on, but is always in the denominator regardless
// — it was still attempted. `score` is null, not NaN or 0, when nothing in
// the set was gradable, so a caller can tell "0 out of 0" apart from a
// genuine zero.
export function normalizeScore(items, rubric) {
  const rows = Array.isArray(items) ? items : [];
  let outOf = 0;
  let earned = 0;
  let excluded = 0;

  for (const item of rows) {
    const verdict = item && item.verdict;
    if (!COUNTED_VERDICTS.has(verdict)) {
      excluded += 1;
      continue;
    }
    outOf += 1;
    if (verdict === 'CORRECT') earned += 1;
    else if (verdict === 'PARTIAL') earned += rubric.partialCredit ? 0.5 : 0;
  }

  return { score: outOf === 0 ? null : earned, outOf, excluded };
}
