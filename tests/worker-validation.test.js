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
  SLOT_SUBJECT_KINDS,
  isValidStartMin,
  isValidSlotDuration,
  isValidBlockLabel,
  isValidBlockDuration,
  isValidCourseName,
  isValidWeekday,
  isValidStartMinOverride,
  isValidBlockSpan,
  isValidOccurs,
  isValidBlockDateException,
  MAX_BLOCK_LABEL_LEN,
  MAX_COURSE_NAME_LEN,
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

// Wall Calendar Redesign §8.3.1 — the not-in-the-future bound has to be
// server-side, not merely a disabled confirm button in the sheet.
test('validateCompletionValue refuses a completedAt in the future', () => {
  const problem = validateCompletionValue('completedAt', Date.now() + 60_000);
  assert.ok(problem, 'expected an error string');
  assert.match(problem, /future/);
  // The instant itself, and any moment up to it, are legitimate: a parent
  // correcting yesterday evening's bins at breakfast is a real entry.
  assert.equal(validateCompletionValue('completedAt', Date.now()), null);
  assert.equal(validateCompletionValue('completedAt', Date.now() - 60_000), null);
});

// -------------------------------- wall placements (§3.2, §12) --------------

test('isValidStartMin accepts the 15-minute grid and nothing else', () => {
  for (const ok of [0, 15, 360, 1425]) assert.equal(isValidStartMin(ok), true, `${ok} should be valid`);
  for (const bad of [-15, 1, 1430, 1440, 1.5, '360', null, undefined]) {
    assert.equal(isValidStartMin(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('isValidSlotDuration accepts null (clears an override) and positive multiples of 15', () => {
  assert.equal(isValidSlotDuration(null), true);
  for (const ok of [15, 30, 300]) assert.equal(isValidSlotDuration(ok), true, `${ok} should be valid`);
  for (const bad of [0, -15, 10, 1.5, '30', undefined]) {
    assert.equal(isValidSlotDuration(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('§20: SLOT_SUBJECT_KINDS is exactly chore — school blocks moved to their own tables', () => {
  assert.deepEqual([...SLOT_SUBJECT_KINDS].sort(), ['chore']);
});

// -------------------------------- school blocks (§5.5, §12, Phase 7) -------

test('isValidBlockLabel allows null/undefined (renders as "School") and bounds a string', () => {
  assert.equal(isValidBlockLabel(null), true);
  assert.equal(isValidBlockLabel(undefined), true);
  assert.equal(isValidBlockLabel('Morning School'), true);
  assert.equal(isValidBlockLabel('x'.repeat(MAX_BLOCK_LABEL_LEN)), true);
  assert.equal(isValidBlockLabel('x'.repeat(MAX_BLOCK_LABEL_LEN + 1)), false);
  assert.equal(isValidBlockLabel(42), false);
});

test('isValidBlockDuration is isValidSlotDuration with null excluded — a block always has a span', () => {
  assert.equal(isValidBlockDuration(null), false);
  for (const ok of [15, 30, 300]) assert.equal(isValidBlockDuration(ok), true, `${ok} should be valid`);
  for (const bad of [0, -15, 10, 1.5, '30', undefined]) {
    assert.equal(isValidBlockDuration(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('isValidCourseName requires a non-empty, bounded string', () => {
  assert.equal(isValidCourseName('Math'), true);
  assert.equal(isValidCourseName(''), false);
  assert.equal(isValidCourseName('x'.repeat(MAX_COURSE_NAME_LEN)), true);
  assert.equal(isValidCourseName('x'.repeat(MAX_COURSE_NAME_LEN + 1)), false);
  assert.equal(isValidCourseName(null), false);
  assert.equal(isValidCourseName(undefined), false);
});

// ------------------------------------------- placement scopes (Phase 1, §8)

test('isValidWeekday accepts 0-6 and nothing else', () => {
  // §8 test 8. The range is Sunday-first (§2.3), so both ends are real days
  // and neither is a sentinel — 7 is not "unset", it is out of range.
  for (const day of [0, 1, 2, 3, 4, 5, 6]) assert.equal(isValidWeekday(day), true, `weekday ${day}`);
  assert.equal(isValidWeekday(7), false);
  assert.equal(isValidWeekday(-1), false);
  assert.equal(isValidWeekday('1'), false);
  assert.equal(isValidWeekday(1.5), false);
  assert.equal(isValidWeekday(null), false);
  assert.equal(isValidWeekday(undefined), false);
});

test('isValidStartMinOverride is isValidStartMin plus null', () => {
  // An override level may say nothing about the start time (§2.1) — unlike
  // wall_slots.start_min, which is NOT NULL because its presence IS the
  // placement. Everything else must still be on the 15-minute grid.
  assert.equal(isValidStartMinOverride(null), true);
  assert.equal(isValidStartMinOverride(0), true);
  assert.equal(isValidStartMinOverride(1425), true);
  assert.equal(isValidStartMinOverride(1440), false);   // a placement lives on one day's grid
  assert.equal(isValidStartMinOverride(7), false);
  assert.equal(isValidStartMinOverride(undefined), false);
});

test('isValidBlockSpan takes both ends or neither', () => {
  // §8 test 7. The pair rule from §2.2: mixing levels is what would compose
  // end <= start, which every consumer of a block treats as impossible.
  assert.equal(isValidBlockSpan(null, null), true, 'both null = inherit the level below');
  assert.equal(isValidBlockSpan(540, 690), true);
  assert.equal(isValidBlockSpan(540, null), false, 'one without the other');
  assert.equal(isValidBlockSpan(null, 690), false, 'one without the other');
  assert.equal(isValidBlockSpan(690, 540), false, 'end before start');
  assert.equal(isValidBlockSpan(540, 540), false, 'zero-length span');
  assert.equal(isValidBlockSpan(540, 695), false, 'end off the 15-minute grid');
  assert.equal(isValidBlockSpan(547, 690), false, 'start off the 15-minute grid');
  // undefined is not null: the route normalizes an omitted field to null
  // (§4.1), so a misspelled key must not validate as "clear the span".
  assert.equal(isValidBlockSpan(undefined, undefined), false);
  assert.equal(isValidBlockSpan(540, undefined), false);
});

test('isValidBlockSpan lets a block END at midnight, matching the shipped POST', () => {
  // handleWallSchoolBlockPost rejects `startMin + durationMin > 1440`, so a
  // block ending exactly at 1440 is already legal today. end_min is an END,
  // which is why this is not isValidStartMin twice — that one excludes 1440
  // because a START there would put the placement on the next day's grid.
  assert.equal(isValidBlockSpan(1380, 1440), true);
  assert.equal(isValidBlockSpan(1380, 1455), false);
});

test('isValidOccurs is strict about 0 and 1', () => {
  // §8 test 7a, first half. Truthiness would turn a client bug into a
  // silently skipped school day, which is the failure nobody would report as
  // a bug — they would just think school did not happen.
  assert.equal(isValidOccurs(0), true);
  assert.equal(isValidOccurs(1), true);
  assert.equal(isValidOccurs('0'), false);
  assert.equal(isValidOccurs(false), false);
  assert.equal(isValidOccurs(true), false);
  assert.equal(isValidOccurs(2), false);
  assert.equal(isValidOccurs(null), false);
  assert.equal(isValidOccurs(undefined), false);
});

test('a skipped day carries no span (§2.2.1)', () => {
  // §8 test 7a, second half — the one rule here that spans columns, which is
  // why it lives in validation.js rather than inline in the Phase 2 route.
  assert.equal(isValidBlockDateException(0, null, null), true, 'a plain skip');
  assert.equal(isValidBlockDateException(0, 540, 690), false, 'a skip with a time is meaningless');
  assert.equal(isValidBlockDateException(1, null, null), true, 'a backup day at the default span');
  assert.equal(isValidBlockDateException(1, 600, 750), true, 'just this once, later');
  assert.equal(isValidBlockDateException(1, 600, null), false, 'the pair rule still applies');
  assert.equal(isValidBlockDateException('1', null, null), false, 'occurs is still strict');
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

test('0007 adds the claim columns and creates claim_groups keyed on the occurrence', () => {
  // Shared Chores §5.2: the primary key is what lets two independent
  // per-child Commits agree on one group without coordinating.
  const sql = readMigration('0007_shared_chore_claims.sql').replace(/\s+/g, ' ');
  assert.match(sql, /ALTER TABLE assignments ADD COLUMN claim_group TEXT;/);
  assert.match(sql, /ALTER TABLE assignments ADD COLUMN claimed_by TEXT;/);
  assert.match(sql, /ALTER TABLE assignments ADD COLUMN claimed_at INTEGER;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS claim_groups/);
  assert.match(sql, /PRIMARY KEY \(source_id, date, instance_key\)/);
});

test('0015 keys the weekday override exactly like wall_slots, plus a weekday', () => {
  // §2.1: three tables, one chain. If this key ever drifts from wall_slots'
  // (migrations/0010), a weekday override silently stops matching the
  // placement it is supposed to override — the chore keeps its standing time
  // and nothing anywhere reports a problem.
  const sql = readMigration('0015_wall_slot_weekdays.sql').replace(/\s+/g, ' ');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wall_slot_weekdays/);
  assert.match(sql, /PRIMARY KEY \(child_id, subject_kind, subject_key, instance_key, weekday\)/);
  // instance_key must carry 0006's NOT NULL DEFAULT '': `NULL = NULL` is never
  // true in SQLite, so a nullable key component disables every comparison.
  assert.match(sql, /instance_key\s+TEXT\s+NOT NULL DEFAULT ''/);
});

test('0017 creates both block scope tables, and only the weekday one is a schedule', () => {
  // §2.2: presence in wall_school_block_weekdays IS the schedule, so its key
  // is (block, weekday) with no room for a duplicate. wall_school_block_dates
  // is the per-date exception (§2.2.1) and defaults to "happens" — a row
  // written without `occurs` must mean a move, never a skip.
  const sql = readMigration('0017_wall_school_block_scopes.sql').replace(/\s+/g, ' ');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wall_school_block_weekdays/);
  assert.match(sql, /PRIMARY KEY \(block_id, weekday\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wall_school_block_dates/);
  assert.match(sql, /PRIMARY KEY \(block_id, date\)/);
  assert.match(sql, /occurs\s+INTEGER NOT NULL DEFAULT 1/);
});

test('0018 backfills Mon-Fri only, and is guarded so a re-apply is safe', () => {
  // Ray chose Mon-Fri (§3.3a). Saturday is the family's Sabbath; Sunday is a
  // backup day, which is a per-date fact (§2.2.1), not a weekly one. The
  // NOT EXISTS guard is what lets a half-applied pair be fixed by pressing
  // the button again — the only recovery an operator with no CLI has.
  const sql = readMigration('0018_wall_school_block_weekday_backfill.sql').replace(/\s+/g, ' ');
  assert.match(sql, /INSERT INTO wall_school_block_weekdays/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.doesNotMatch(sql, /SELECT 0 AS weekday/, 'Sunday is not in the backfill');
  assert.doesNotMatch(sql, /UNION ALL SELECT 6/, 'Saturday is not in the backfill');
  const days = [...sql.matchAll(/SELECT (\d) AS weekday|UNION ALL SELECT (\d)/g)]
    .map((m) => Number(m[1] !== undefined ? m[1] : m[2]));
  assert.deepEqual(days, [1, 2, 3, 4, 5]);
});

test('0018 is a separate file from 0017, per Online_Revamp §3.7.1', () => {
  // "A migration that adds a table and backfills it is two files." Also the
  // practical reason: if the backfill fails, 0017 stays applied and the retry
  // is the same button, not a rollback nobody can drive.
  const create = readMigration('0017_wall_school_block_scopes.sql');
  assert.ok(!/INSERT INTO/i.test(create), '0017 must not backfill');
  const backfill = readMigration('0018_wall_school_block_weekday_backfill.sql');
  assert.ok(!/CREATE TABLE/i.test(backfill), '0018 must not create');
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
