// Tests for the Management App's answer-key filename matcher
// (answer-keys-core.js). Per TDS_Slice_Grading_Assistant.md §4. Pure, DOM-free
// — same split as worker/validation.js and the Child App's *-core.js files.
//
// The property these all circle is the one in the module's header: a wrong
// placement is worse than no placement, so every ambiguity must come back as
// an unmatched file with a reason, never as a guess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const AnswerKeysCore = loadModule('management-app/js/answer-keys-core.js', 'AnswerKeysCore');

function lessons(...specs) {
  return specs.map((spec, i) => ({
    id: spec.id || `LSN-${i}`,
    lessonCode: spec.lessonCode,
    title: spec.title,
    order: spec.order === undefined ? i : spec.order,
  }));
}

const THREE = lessons(
  { id: 'LSN-a', lessonCode: 'L01', title: 'Fractions' },
  { id: 'LSN-b', lessonCode: 'L02', title: 'Decimals' },
  { id: 'LSN-c', lessonCode: 'L03', title: 'Percentages' }
);

function files(...names) {
  return names.map((name, i) => ({ id: `f${i}`, name }));
}

function placement(result, fileId) {
  const match = result.matches.find((m) => m.fileId === fileId);
  return match ? match.lessonId : null;
}

function rejection(result, fileId) {
  const miss = result.unmatched.find((u) => u.fileId === fileId);
  return miss ? miss.reason : null;
}

// ------------------------------------------------------------- normalization

test('normalize folds case and every separator to single spaces', () => {
  assert.equal(AnswerKeysCore.normalize('Math_L01-Key'), 'math l01 key');
  assert.equal(AnswerKeysCore.normalize('Math...L01   Key!!'), 'math l01 key');
  assert.equal(AnswerKeysCore.normalize(''), '');
});

test('stripExtension removes only the last suffix', () => {
  assert.equal(AnswerKeysCore.stripExtension('lesson.1.answers.pdf'), 'lesson.1.answers');
  assert.equal(AnswerKeysCore.stripExtension('no-extension'), 'no-extension');
});

test('numbersIn reads every digit run, leading zeros collapsed', () => {
  assert.deepEqual(AnswerKeysCore.numbersIn('unit-07 of 2026'), [7, 2026]);
  assert.deepEqual(AnswerKeysCore.numbersIn('no digits here'), []);
});

test('lessonNumber prefers the code, falls back to order + 1', () => {
  assert.equal(AnswerKeysCore.lessonNumber({ lessonCode: 'L03', order: 9 }), 3);
  assert.equal(AnswerKeysCore.lessonNumber({ lessonCode: 'INTRO', order: 0 }), 1);
  // Two numbers in the code name no single lesson number.
  assert.equal(AnswerKeysCore.lessonNumber({ lessonCode: 'L3B2', order: 4 }), null);
});

// ------------------------------------------------------------------- matching

test('matches a lesson code appearing as its own token', () => {
  const result = AnswerKeysCore.matchFiles(files('Math_L02_key.pdf'), THREE);
  assert.equal(placement(result, 'f0'), 'LSN-b');
  assert.equal(result.matches[0].tier, 'code');
  assert.equal(result.unmatched.length, 0);
});

test('a code buried inside a word is not a code match', () => {
  // "lxqz" contains "xq" as a substring; substring matching is exactly what
  // would put lesson XQ's key on an unrelated scan, so it does not count.
  const buried = lessons({ id: 'LSN-x', lessonCode: 'XQ', title: 'Opening', order: 5 });
  const result = AnswerKeysCore.matchFiles(files('lxqz.pdf'), buried);
  assert.equal(result.matches.length, 0);
});

test('a digit attached to a word still counts at the number tier', () => {
  // The weakest tier is deliberately generous: "level1.pdf" in a course whose
  // lesson 1 is the only 1 is the placement a parent would make. It only fires
  // when no code or title matched and exactly one lesson answers to the number,
  // and the parent sees the reason on the row before anything uploads.
  const withL1 = lessons({ id: 'LSN-x', lessonCode: 'L1', title: 'Opening' });
  const result = AnswerKeysCore.matchFiles(files('level1.pdf'), withL1);
  assert.equal(placement(result, 'f0'), 'LSN-x');
  assert.equal(result.matches[0].tier, 'number');
});

test('matches a lesson title when no code is present', () => {
  const result = AnswerKeysCore.matchFiles(files('answers - decimals.pdf'), THREE);
  assert.equal(placement(result, 'f0'), 'LSN-b');
  assert.equal(result.matches[0].tier, 'title');
});

test('a multi-word title must appear as a contiguous run', () => {
  const two = lessons(
    { id: 'LSN-p', lessonCode: 'A', title: 'Adding Fractions' },
    { id: 'LSN-q', lessonCode: 'B', title: 'Subtracting Decimals' }
  );
  assert.equal(placement(AnswerKeysCore.matchFiles(files('adding fractions.pdf'), two), 'f0'), 'LSN-p');
  // The same words, not adjacent: not evidence.
  assert.equal(placement(AnswerKeysCore.matchFiles(files('adding and subtracting.pdf'), two), 'f0'), null);
});

test('falls back to the lesson number, ignoring unrelated digits', () => {
  const result = AnswerKeysCore.matchFiles(files('key 2026 lesson 3.pdf'), THREE);
  assert.equal(placement(result, 'f0'), 'LSN-c');
  assert.equal(result.matches[0].tier, 'number');
});

test('a code match wins over the number match it also has', () => {
  // "L03 ... 2" would be lesson 3 by code and lesson 2 by number; the stronger
  // tier decides, and the weaker one never gets a vote.
  const result = AnswerKeysCore.matchFiles(files('L03 part 2.pdf'), THREE);
  assert.equal(placement(result, 'f0'), 'LSN-c');
});

test('a tie inside a tier is left for the parent, not broken by a weaker tier', () => {
  const twins = lessons(
    { id: 'LSN-m', lessonCode: 'L01', title: 'Review' },
    { id: 'LSN-n', lessonCode: 'L1', title: 'Review' }
  );
  const result = AnswerKeysCore.matchFiles(files('review 1.pdf'), twins);
  assert.equal(result.matches.length, 0);
  assert.match(rejection(result, 'f0'), /matches 2 lessons/);
});

test('two files claiming one lesson place neither', () => {
  const result = AnswerKeysCore.matchFiles(files('L01.pdf', 'L01-v2.pdf'), THREE);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatched.length, 2);
  assert.match(rejection(result, 'f0'), /2 files match L01/);
  assert.match(rejection(result, 'f1'), /2 files match L01/);
});

test('a lesson already holding a file is never displaced', () => {
  const result = AnswerKeysCore.matchFiles(files('L01.pdf'), THREE, ['LSN-a']);
  assert.equal(result.matches.length, 0);
  assert.match(rejection(result, 'f0'), /already has a file waiting/);
});

test('a folder of mixed filenames places what it can and explains the rest', () => {
  const result = AnswerKeysCore.matchFiles(
    files('L01_key.pdf', 'percentages answers.pdf', 'scan0042.pdf'),
    THREE
  );
  assert.equal(placement(result, 'f0'), 'LSN-a');
  assert.equal(placement(result, 'f1'), 'LSN-c');
  assert.equal(placement(result, 'f2'), null);
  assert.equal(rejection(result, 'f2'), 'no lesson code, title or number in the filename');
});

test('every file handed in comes back in exactly one list', () => {
  const given = files('L01.pdf', 'L01 again.pdf', 'nothing.pdf', 'decimals.pdf');
  const result = AnswerKeysCore.matchFiles(given, THREE);
  const returned = result.matches.map((m) => m.fileId).concat(result.unmatched.map((u) => u.fileId));
  assert.deepEqual(returned.sort(), given.map((f) => f.id).sort());
});

test('a one- or two-character title is not treated as evidence', () => {
  const short = lessons({ id: 'LSN-s', lessonCode: 'ZZ', title: 'A' });
  const result = AnswerKeysCore.matchFiles(files('a scan of something.pdf'), short);
  assert.equal(result.matches.length, 0);
});

test('no lessons means nothing is placed and nothing throws', () => {
  const result = AnswerKeysCore.matchFiles(files('L01.pdf'), []);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatched.length, 1);
});

// ----------------------------------------------------------------- formatting

test('formatBytes reads at human scale and refuses non-numbers', () => {
  assert.equal(AnswerKeysCore.formatBytes(512), '512 B');
  assert.equal(AnswerKeysCore.formatBytes(2048), '2 KB');
  assert.equal(AnswerKeysCore.formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(AnswerKeysCore.formatBytes(undefined), '');
  assert.equal(AnswerKeysCore.formatBytes(NaN), '');
});
