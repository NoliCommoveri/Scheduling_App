// Tests for the Worker's pure helpers (management-app/worker/validation.js).
//
// Run with `npm test` — no dependencies, no build step, no network. These do not
// touch D1: what is exercised here is the decision-making the Worker does before
// it reaches the database, which is where every rule in §4.2 and §5.6 lives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  isValidDate,
  validateCompletionValue,
  validateChange,
  keyToId,
  splitStatements,
  capRows,
  MAX_QUERY_ROWS,
  MAX_NOTE_LEN,
  MAX_MESSAGE_LEN,
  validateMessage,
  clampInt,
  randomPairCode,
  PAIR_CODE_ALPHABET,
  timingSafeEqual,
} from '../management-app/worker/validation.js';

// The registry cannot be imported: it `import`s `.sql` files, which only
// Wrangler's Text loader (§3.7.2) resolves. Read it off disk instead — which is
// closer to what these tests are actually asserting about anyway.
const repo = new URL('../', import.meta.url);
const registrySource = readFileSync(new URL('management-app/worker/migrations.js', repo), 'utf8');
const migrationFiles = readdirSync(new URL('migrations/', repo)).filter((f) => f.endsWith('.sql')).sort();
const readMigration = (name) => readFileSync(new URL(`migrations/${name}`, repo), 'utf8');

// ---------------------------------------------------------------- dates

test('isValidDate accepts YYYY-MM-DD and nothing else', () => {
  assert.equal(isValidDate('2026-08-11'), true);
  for (const bad of ['2026-8-11', '11/08/2026', '2026-08-11T00:00:00Z', '', null, undefined, 20260811]) {
    assert.equal(isValidDate(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------- child-owned values (§4.2.1)

test('validateCompletionValue accepts the whole status enum', () => {
  for (const status of ['pending', 'complete', 'waived']) {
    assert.equal(validateCompletionValue('status', status), null);
  }
});

test('validateCompletionValue rejects a status outside the enum', () => {
  // The defect this guards: a status that is neither pending nor a resolution
  // drops the row from the child's planner AND locks the parent out of
  // rescinding it, with no screen in either app able to undo it.
  const problem = validateCompletionValue('status', 'banana');
  assert.ok(problem, 'expected an error string');
  assert.match(problem, /status must be one of/);
});

test('validateCompletionValue always permits null — clearing is a real write', () => {
  for (const key of [
    'status', 'completedAt', 'grade', 'deferredTo', 'childBlockHint', 'childSortOrder', 'completionNote',
  ]) {
    assert.equal(validateCompletionValue(key, null), null, `${key} should accept null`);
  }
});

// Child Feedback Loop §5.2
test('validateCompletionValue bounds completionNote at MAX_NOTE_LEN', () => {
  assert.equal(validateCompletionValue('completionNote', 'skipped #11'), null);
  assert.equal(validateCompletionValue('completionNote', ''), null, 'an empty string is a valid write, distinct from null');
  assert.ok(validateCompletionValue('completionNote', 'x'.repeat(MAX_NOTE_LEN + 1)));
  assert.equal(validateCompletionValue('completionNote', 'x'.repeat(MAX_NOTE_LEN)), null);
  assert.ok(validateCompletionValue('completionNote', 42), 'must be a string');
});

test('validateCompletionValue rejects malformed timestamps, grades and dates', () => {
  assert.ok(validateCompletionValue('completedAt', -1));
  assert.ok(validateCompletionValue('completedAt', 1.5));
  assert.ok(validateCompletionValue('completedAt', '1754870400000'));
  assert.ok(validateCompletionValue('grade', 'A+'));
  assert.ok(validateCompletionValue('grade', Number.POSITIVE_INFINITY));
  assert.ok(validateCompletionValue('grade', Number.NaN));
  assert.ok(validateCompletionValue('deferredTo', 'tomorrow'));
  assert.ok(validateCompletionValue('childSortOrder', 2.5));
  assert.equal(validateCompletionValue('completedAt', 1754870400000), null);
  assert.equal(validateCompletionValue('grade', 87.5), null);
  assert.equal(validateCompletionValue('grade', 0), null);
  assert.equal(validateCompletionValue('deferredTo', '2026-08-12'), null);
  assert.equal(validateCompletionValue('childSortOrder', -3), null);
});

test('validateCompletionValue bounds childBlockHint', () => {
  assert.equal(validateCompletionValue('childBlockHint', 'Morning'), null);
  assert.ok(validateCompletionValue('childBlockHint', 'x'.repeat(201)));
  assert.ok(validateCompletionValue('childBlockHint', 42));
});

test('validateCompletionValue fails closed on an unknown key', () => {
  // A column added to ASSIGNMENT_COMPLETION_FIELDS without a rule here must be
  // refused, not waved through.
  assert.ok(validateCompletionValue('somethingNew', 'x'));
});

// ------------------------------------------------ curriculum mirror (§5.1)

test('validateChange enforces the change envelope', () => {
  assert.equal(validateChange({ store: 'courses', key: '"c1"', op: 'put' }), null);
  assert.equal(validateChange({ store: 'courses', key: '"c1"', op: 'delete' }), null);
  assert.ok(validateChange(null));
  assert.ok(validateChange({ store: '', key: '"c1"', op: 'put' }));
  assert.ok(validateChange({ store: 'courses', key: 1, op: 'put' }));
  assert.ok(validateChange({ store: 'courses', key: '"c1"', op: 'upsert' }));
});

test('keyToId unwraps a JSON-stringified string key', () => {
  assert.equal(keyToId('"CH-1"'), 'CH-1');
  assert.equal(keyToId('""'), null);
  assert.equal(keyToId('123'), null);
  assert.equal(keyToId('not json'), null);
});

// ------------------------------------------------------ migrations (§3.7)

test('splitStatements strips whole-line and trailing comments', () => {
  const sql = `
    -- a leading note
    CREATE TABLE t (
      a TEXT,     -- JSON record; NULL when deleted = 1
      b INTEGER
    );
    CREATE INDEX i ON t (a);
  `;
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
  // The trailing comment contains its own semicolon — a whole-line-only
  // stripper would split the CREATE TABLE in half here.
  assert.ok(statements[0].startsWith('CREATE TABLE t'));
  assert.ok(!statements[0].includes('NULL when deleted'));
  assert.ok(statements[1].startsWith('CREATE INDEX i'));
});

test('splitStatements drops empty trailing fragments', () => {
  assert.deepEqual(splitStatements('SELECT 1;\n\n-- done\n'), ['SELECT 1']);
  assert.deepEqual(splitStatements('-- only a comment\n'), []);
});

test('every migration file on disk is registered, imported, and in order', () => {
  // The §IV.A pre-build audit as an assertion. An unregistered migration is
  // invisible to the in-app runner, which under "Ray has no CLI" means it can
  // never be applied at all.
  assert.ok(migrationFiles.length > 0, 'no migrations found on disk');

  const listed = [...registrySource.matchAll(/\{ name: '([^']+)'/g)].map((m) => m[1]);
  const imported = [...registrySource.matchAll(/from '\.\.\/\.\.\/migrations\/([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(listed, migrationFiles, 'MIGRATIONS list must match /migrations, in filename order');
  assert.deepEqual(imported.sort(), migrationFiles, 'every file must be imported as well as listed');
});

test('every migration is forward-only and parses into statements', () => {
  for (const name of migrationFiles) {
    const statements = splitStatements(readMigration(name));
    assert.ok(statements.length > 0, `${name} produced no statements`);
    for (const statement of statements) {
      assert.ok(!statement.includes('--'), `${name} left a comment inside a statement`);
      // §3.7.1 is forward-only. A migration that drops or renames cannot be
      // corrected by a later one on a database that already applied it.
      assert.ok(!/\bDROP\s+TABLE\b/i.test(statement), `${name} drops a table`);
    }
  }
});

test('0003 creates commit_chunks with the composite primary key', () => {
  // §3.8: the primary key is the entire replay-safety guarantee. If it is ever
  // relaxed to a plain batch_id, a chunked Commit silently breaks — the second
  // chunk would collide with the first and no Commit over 500 rows could land.
  const sql = readMigration('0003_commit_chunks.sql').replace(/\s+/g, ' ');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS commit_chunks/);
  assert.match(sql, /PRIMARY KEY \(batch_id, chunk_index\)/);
});

// ------------------------------------------------------- query bounds

test('capRows passes short results through untouched', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(capRows(rows, 'assignments'), { assignments: rows });
  assert.deepEqual(capRows(null, 'assignments'), { assignments: [] });
});

test('capRows truncates and says so', () => {
  const rows = Array.from({ length: MAX_QUERY_ROWS + 5 }, (_, i) => ({ id: i }));
  const body = capRows(rows, 'assignments');
  assert.equal(body.assignments.length, MAX_QUERY_ROWS);
  assert.equal(body.truncated, true);
  assert.equal(body.limit, MAX_QUERY_ROWS);
});

test('clampInt falls back and bounds', () => {
  assert.equal(clampInt(null, 7, 0, 10), 7);
  assert.equal(clampInt('', 7, 0, 10), 7);
  assert.equal(clampInt('abc', 7, 0, 10), 7);
  assert.equal(clampInt('5', 7, 0, 10), 5);
  assert.equal(clampInt('-5', 7, 0, 10), 0);
  assert.equal(clampInt('500', 7, 0, 10), 10);
});

// ----------------------------------------------------- pairing codes (§4.3)

test('randomPairCode is 8 characters from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = randomPairCode();
    assert.equal(code.length, 8);
    for (const ch of code) {
      assert.ok(PAIR_CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
    }
  }
});

test('randomPairCode alphabet excludes the characters people misread', () => {
  for (const ch of ['0', '1', 'I', 'L', 'O', 'U']) {
    assert.ok(!PAIR_CODE_ALPHABET.includes(ch), `${ch} should not be in the alphabet`);
  }
});

test('randomPairCode is not visibly biased toward the low letters', () => {
  // Rejection sampling, not `% 30`. With the modulo version the first
  // 256 % 30 = 16 letters each came up 9/256 of the time against 8/256 for the
  // rest — a ~12.5% excess. This checks the observed spread is far tighter
  // than that, with enough samples that the bound is not flaky.
  const counts = new Map([...PAIR_CODE_ALPHABET].map((c) => [c, 0]));
  const draws = 60000;
  for (let i = 0; i < draws / 8; i++) {
    for (const ch of randomPairCode()) counts.set(ch, counts.get(ch) + 1);
  }
  const expected = draws / PAIR_CODE_ALPHABET.length;
  for (const [ch, n] of counts) {
    const drift = Math.abs(n - expected) / expected;
    assert.ok(drift < 0.08, `${ch} drifted ${(drift * 100).toFixed(1)}% from uniform`);
  }
});

// ------------------------------------------------------- credentials (§4.1)

test('timingSafeEqual matches only identical strings', () => {
  assert.equal(timingSafeEqual('hunter2', 'hunter2'), true);
  assert.equal(timingSafeEqual('hunter2', 'hunter3'), false);
  assert.equal(timingSafeEqual('hunter2', 'hunter2x'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual('', 'x'), false);
  assert.equal(timingSafeEqual('sécret', 'sécret'), true);
});

// -------------------------------------  assignment messages (§6.2, Module 13)

test('validateMessage requires an id, an assignmentId and a non-empty body', () => {
  assert.equal(validateMessage({ id: 'm1', assignmentId: 'a1', body: 'why?' }), null);
  assert.match(validateMessage(null), /must be an object/);
  assert.match(validateMessage({ assignmentId: 'a1', body: 'why?' }), /needs an id/);
  assert.match(validateMessage({ id: 'm1', body: 'why?' }), /needs an assignmentId/);
  assert.match(validateMessage({ id: 'm1', assignmentId: 'a1' }), /body must be a string/);
});

test('validateMessage treats a whitespace-only body as empty', () => {
  // The composer must not be able to queue a question that says nothing.
  assert.match(validateMessage({ id: 'm1', assignmentId: 'a1', body: '   \n ' }), /must not be empty/);
});

test('validateMessage bounds the body at MAX_MESSAGE_LEN, measured after trimming', () => {
  const atCap = { id: 'm1', assignmentId: 'a1', body: 'x'.repeat(MAX_MESSAGE_LEN) };
  assert.equal(validateMessage(atCap), null);
  const overCap = { id: 'm1', assignmentId: 'a1', body: 'x'.repeat(MAX_MESSAGE_LEN + 1) };
  assert.match(validateMessage(overCap), /at most 500 characters/);
  // Padding does not push a legal body over the line.
  const padded = { id: 'm1', assignmentId: 'a1', body: `   ${'x'.repeat(MAX_MESSAGE_LEN)}   ` };
  assert.equal(validateMessage(padded), null);
});

test('a message body is capped shorter than a completion note', () => {
  // §6.2: a question, not the account of finished work a note carries.
  assert.ok(MAX_MESSAGE_LEN < MAX_NOTE_LEN);
});

test('validateMessage accepts an absent createdAt but not a malformed one', () => {
  assert.equal(validateMessage({ id: 'm1', assignmentId: 'a1', body: 'why?' }), null);
  assert.equal(validateMessage({ id: 'm1', assignmentId: 'a1', body: 'why?', createdAt: 1754870400000 }), null);
  assert.match(validateMessage({ id: 'm1', assignmentId: 'a1', body: 'why?', createdAt: 'now' }), /millisecond timestamp/);
  assert.match(validateMessage({ id: 'm1', assignmentId: 'a1', body: 'why?', createdAt: -1 }), /millisecond timestamp/);
});
