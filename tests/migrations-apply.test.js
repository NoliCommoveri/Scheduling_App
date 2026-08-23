// Applies every migration, in order, to a real SQLite database.
//
// Why this exists: `CLAUDE.md` §0 and §III.D say Ray has no CLI. A migration
// is applied by pressing a button in a browser, and if it fails there, the
// error message is the whole of the recovery story. Every other test in this
// repo checks what the Worker *decides*; this one checks that the DDL it is
// about to hand D1 is DDL SQLite will actually accept — which until now was
// verified by applying it to the live database and watching.
//
// It runs the real `splitStatements` over the real files, so a comment that
// swallows a statement or a stray semicolon fails here rather than there.
//
// Two things it deliberately does NOT claim to be:
//   - It is not D1. D1 is SQLite, but the batch/transaction wrapper is
//     Cloudflare's. What is pinned here is the SQL, not the runner.
//   - Foreign keys are turned OFF, to match this database. D1 does not
//     enforce them here — `handleWallSchoolBlockDelete` deletes a block
//     BEFORE its wall_school_block_courses children and has always worked —
//     whereas node:sqlite enables them by default. Leaving them on would fail
//     a test for a constraint production does not apply, which is worse than
//     not testing it: it would teach the next session to write around a rule
//     that is not there. §3.4's explicit multi-table cleanup is what keeps
//     these rows from orphaning, and that is a Phase 2 route test.
//
// `npm test` prints one "SQLite is an experimental feature" line for this
// file, as a TAP comment. That is Node's warning about node:sqlite, not a
// failure, and silencing it would mean a --no-warnings flag on the whole
// suite. Left visible on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { splitStatements } from '../management-app/worker/validation.js';

const repo = new URL('../', import.meta.url);
const migrationsDir = new URL('migrations/', repo);
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const readMigration = (name) => readFileSync(new URL(name, migrationsDir), 'utf8');

// node:sqlite is experimental and arrived in Node 22.5. Nothing else in this
// repo needs a Node floor, and adding one so a test can run would be the tail
// wagging the dog — so this skips cleanly instead.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* older Node — every test below skips */
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');   // matches D1 for this database — see the header
  return db;
}

// The runner's shape (worker/index.js `applyPendingMigrations`): one migration
// is its statements plus a tracking row, in one transaction. Batches are not
// chained, so a failure stops the run with everything before it applied.
function apply(db, name) {
  db.exec('BEGIN');
  try {
    for (const statement of splitStatements(readMigration(name))) db.exec(statement);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`${name}: ${err.message}`);
  }
}

const applyAll = (db, upTo = migrationFiles.length) => {
  for (const name of migrationFiles.slice(0, upTo)) apply(db, name);
};

// node:sqlite hands back null-prototype rows, which deepStrictEqual will not
// match against an object literal. Nothing here cares about the prototype.
const plain = (row) => ({ ...row });

const columnsOf = (db, table) =>
  db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name);

const indexOfMigration = (prefix) => migrationFiles.findIndex((f) => f.startsWith(prefix));

test('every migration applies, in order, to an empty database', { skip: !DatabaseSync }, () => {
  // The §IV.B "applies cleanly on an empty DB" check, as an assertion rather
  // than a ritual. This is what a fresh deploy does on its first button press.
  const db = freshDb();
  applyAll(db);
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all().map((r) => r.name);
  for (const expected of [
    'assignments', 'wall_slots', 'wall_slot_days', 'wall_slot_weekdays',
    'wall_school_blocks', 'wall_school_block_courses',
    'wall_school_block_weekdays', 'wall_school_block_dates',
  ]) {
    assert.ok(tables.includes(expected), `${expected} missing after a full apply`);
  }
  db.close();
});

test('0016 adds start_min to wall_slot_days without disturbing its key', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  applyAll(db);
  const cols = columnsOf(db, 'wall_slot_days');
  assert.deepEqual(cols, [
    'child_id', 'subject_kind', 'subject_key', 'instance_key', 'date',
    'duration_min', 'updated_at', 'updated_by', 'start_min',
  ]);
  db.close();
});

test('0018 backfills an existing block to Mon-Fri, and moves nothing', { skip: !DatabaseSync }, () => {
  // The one migration here whose correctness nothing else can check, applied
  // the way Ray will apply it: to a database that already has blocks in it.
  const db = freshDb();
  applyAll(db, indexOfMigration('0017'));          // everything before the scope tables

  db.exec(`INSERT INTO wall_school_blocks (id, child_id, label, start_min, end_min, updated_at, updated_by)
           VALUES ('b1', 'c1', 'Morning School', 540, 690, 1, 'wall:dev'),
                  ('b2', 'c2', NULL, 780, 840, 1, 'wall:dev')`);

  apply(db, '0017_wall_school_block_scopes.sql');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM wall_school_block_weekdays').get().n, 0,
    '0017 alone schedules nothing — it is 0018 that keeps existing blocks visible'
  );

  apply(db, '0018_wall_school_block_weekday_backfill.sql');
  const rows = db.prepare(
    'SELECT block_id, weekday, start_min, end_min FROM wall_school_block_weekdays ORDER BY block_id, weekday'
  ).all();
  assert.deepEqual(rows.map((r) => `${r.block_id}:${r.weekday}`), [
    'b1:1', 'b1:2', 'b1:3', 'b1:4', 'b1:5',
    'b2:1', 'b2:2', 'b2:3', 'b2:4', 'b2:5',
  ]);
  // NULL span on every row = inherit the block's own. Nothing moves (§3.3a).
  assert.ok(rows.every((r) => r.start_min === null && r.end_min === null), 'the backfill must not set a span');
  // And the blocks themselves are untouched.
  const b1 = db.prepare('SELECT start_min, end_min FROM wall_school_blocks WHERE id = ?').get('b1');
  assert.deepEqual(plain(b1), { start_min: 540, end_min: 690 });
  db.close();
});

test('0018 run twice inserts nothing the second time', { skip: !DatabaseSync }, () => {
  // The recovery path: 0017 applied, 0018 failed, Ray presses the button
  // again. The guard is what makes that safe rather than a duplicate-key
  // error on a database he cannot reach any other way.
  const db = freshDb();
  applyAll(db, indexOfMigration('0017'));
  db.exec(`INSERT INTO wall_school_blocks (id, child_id, label, start_min, end_min, updated_at, updated_by)
           VALUES ('b1', 'c1', NULL, 540, 690, 1, 'wall:dev')`);
  apply(db, '0017_wall_school_block_scopes.sql');
  apply(db, '0018_wall_school_block_weekday_backfill.sql');
  apply(db, '0018_wall_school_block_weekday_backfill.sql');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wall_school_block_weekdays').get().n, 5);
  db.close();
});

test('a weekday override row survives the key it shares with wall_slots', { skip: !DatabaseSync }, () => {
  // Both tables take the '' household sentinel for a `claim` chore (§3.1.2),
  // and both default instance_key to '' so the composite key never compares
  // against NULL. Written here as data rather than as a regex over the DDL.
  const db = freshDb();
  applyAll(db);
  db.exec(`INSERT INTO wall_slots (child_id, subject_kind, subject_key, start_min, duration_min, updated_at, updated_by)
           VALUES ('', 'chore', 'chore-1', 480, NULL, 1, 'wall:dev')`);
  db.exec(`INSERT INTO wall_slot_weekdays (child_id, subject_kind, subject_key, weekday, start_min, duration_min, updated_at, updated_by)
           VALUES ('', 'chore', 'chore-1', 5, 420, NULL, 1, 'wall:dev')`);
  const joined = db.prepare(
    `SELECT s.start_min AS standing, w.start_min AS friday
       FROM wall_slots s
       JOIN wall_slot_weekdays w
         ON w.child_id = s.child_id AND w.subject_kind = s.subject_kind
        AND w.subject_key = s.subject_key AND w.instance_key = s.instance_key`
  ).get();
  assert.deepEqual(plain(joined), { standing: 480, friday: 420 });
  db.close();
});
