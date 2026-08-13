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
