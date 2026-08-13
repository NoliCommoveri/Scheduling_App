// Route-level tests for the Worker, against a fake D1.
//
// The fake does not execute SQL — it answers each `prepare().bind()` from a
// handler the test supplies, and records every statement. That is enough for
// what these check, which is the Worker's *decisions*: who is allowed through,
// which columns and values a credential may write, and what it does with a
// replayed chunk. Anything that genuinely depends on SQLite semantics stays in
// the manual §13 acceptance checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./sql-loader.mjs', import.meta.url);
const worker = (await import('../management-app/worker/index.js')).default;

const PARENT_TOKEN = 'parent-secret-token';
const DEVICE_TOKEN = 'device-bearer-token';
// SHA-256 of DEVICE_TOKEN, as `devices.token_hash` stores it.
const DEVICE_HASH = await sha256Hex(DEVICE_TOKEN);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- the fake

// `respond(sql, args)` returns whatever that statement should produce:
//   { first }  for .first()      { results } for .all()      { meta } for .run()
//   { throws } to make the statement reject, the way D1 does against a schema
//              that has not caught up yet — what §11.7's containment is for.
// Anything not answered falls back to a benign empty result.
function makeEnv(respond = () => ({})) {
  const statements = [];
  const record = (sql, args) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
    const answer = respond(sql, args) || {};
    const fail = async () => { throw answer.throws; };
    return {
      sql, args,
      first: answer.throws ? fail : async () => (answer.first === undefined ? null : answer.first),
      all: answer.throws ? fail : async () => ({ results: answer.results || [] }),
      run: answer.throws ? fail : async () => ({ meta: answer.meta || { changes: 1 } }),
    };
  };

  const DB = {
    prepare: (sql) => ({
      bind: (...args) => record(sql, args),
      first: async () => record(sql, []).first(),
      all: async () => record(sql, []).all(),
      run: async () => record(sql, []).run(),
    }),
    batch: async (list) => {
      DB.batched.push(list);
      if (DB.batchError) throw DB.batchError;
      return list.map(() => ({ meta: { changes: 1 } }));
    },
    batchError: null,
    exec: async () => ({}),
    batched: [],
  };

  return { env: { DB, SYNC_TOKEN: PARENT_TOKEN, ASSETS: { fetch: async () => new Response('asset') } }, statements, DB };
}

const ctx = { waitUntil() {} };

function call(env, path, { method = 'GET', token, body, outboxProtocol } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (outboxProtocol) headers['X-Outbox-Protocol'] = String(outboxProtocol);
  const request = new Request(`https://example.test${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(request, env, ctx);
}

// A device lookup that resolves DEVICE_TOKEN to child CH-1 and nothing else.
function deviceResolver(extra = () => ({})) {
  return (sql, args) => {
    if (sql.includes('FROM devices WHERE token_hash')) {
      return { first: args[0] === DEVICE_HASH ? { id: 'DEV-1', child_id: 'CH-1' } : null };
    }
    return extra(sql, args);
  };
}

// =========================================================  authorization

test('a parent route with no credential is 401', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/api/assignments?childId=CH-1');
  assert.equal(res.status, 401);
});

test('§13.2: a child device token on /api/sync/snapshot is 401, not 403', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/sync/snapshot', { token: DEVICE_TOKEN });
  assert.equal(res.status, 401);
});

test('a device token on a parent assignments route is 401', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/assignments?childId=CH-1', { token: DEVICE_TOKEN });
  assert.equal(res.status, 401);
});

test('a revoked or unknown bearer on a child route is 401', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/plan', { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
});

test('an unset SYNC_TOKEN fails closed rather than opening every parent route', async () => {
  const { env } = makeEnv();
  delete env.SYNC_TOKEN;
  const res = await call(env, '/api/assignments?childId=CH-1', { token: 'anything' });
  assert.equal(res.status, 401);
});

// ==================================================  commit replay safety

const oneRow = { date: '2026-08-11', kind: 'activity', title: 'Read chapter 4' };

test('a fresh chunk is inserted and reports what it applied', async () => {
  const { env, DB } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: [oneRow, oneRow] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.ids.length, 2);
  assert.equal(out.applied, 2);
  assert.equal(out.duplicate, false);

  // §3.8.1: the accounting row must ride in the same batch as the assignments.
  assert.equal(DB.batched.length, 1);
  const sqls = DB.batched[0].map((s) => s.sql.replace(/\s+/g, ' '));
  assert.equal(sqls.filter((s) => s.includes('INSERT INTO assignments')).length, 2);
  assert.equal(sqls.filter((s) => s.includes('INSERT INTO commit_chunks')).length, 1);
});

test('§13.16: a replayed chunk inserts nothing and reports the first attempt', async () => {
  const { env, DB } = makeEnv((sql) => (
    sql.includes('FROM commit_chunks') ? { first: { row_count: 2, created_at: 1700000000000 } } : {}
  ));
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: [oneRow, oneRow] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.duplicate, true);
  assert.equal(out.applied, 2, 'the retry learns what the first attempt stored');
  assert.deepEqual(out.ids, []);
  assert.equal(DB.batched.length, 0, 'a replay must not write anything');
});

test('a racing duplicate is answered as a duplicate, not a 500', async () => {
  // The pre-check misses a concurrent poster; the primary key catches it, and
  // the Worker must recognise that rather than surfacing a SQL error.
  let seen = false;
  const { env } = makeEnv((sql) => {
    if (sql.includes('FROM commit_chunks')) {
      const answer = { first: seen ? { row_count: 1, created_at: 1 } : null };
      seen = true;
      return answer;
    }
    return {};
  });
  env.DB.batch = async () => { throw new Error('UNIQUE constraint failed: commit_chunks.batch_id'); };

  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: [oneRow] },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
});

// ---- §6.6: the same range committed twice ------------------------------
//
// `commit_chunks` is keyed on (batch_id, chunk_index), so it only ever caught a
// *retry* of one Commit. Proposing the same fortnight a second time mints a new
// batchId, collides with nothing, and used to put every chore on the plan twice.
// These cover the natural key that closes that.

const choreRow = {
  date: '2026-08-11', kind: 'chore', sourceId: 'CHR-7k2', title: 'Empty the dishwasher',
};

// Answers the pre-check with whatever `live` says is already on the plan.
function envWithLivePlan(live) {
  return makeEnv((sql) => {
    if (sql.includes('FROM commit_chunks')) return { first: null };
    if (sql.includes('SELECT date, kind, source_id, instance_key FROM assignments')) return { results: live };
    return {};
  });
}

function insertsIn(DB) {
  return DB.batched[0]
    .map((s) => s.sql.replace(/\s+/g, ' '))
    .filter((s) => s.includes('INSERT INTO assignments'));
}

test('§13.21: a row already live for that child, day and source is not assigned again', async () => {
  const { env, DB } = envWithLivePlan([{ date: '2026-08-11', kind: 'chore', source_id: 'CHR-7k2', instance_key: '' }]);
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B2', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 0);
  assert.equal(out.skipped, 1);
  assert.deepEqual(out.ids, []);
  assert.equal(insertsIn(DB).length, 0, 'the duplicate must never reach an INSERT');
  const sqls = DB.batched[0].map((s) => s.sql.replace(/\s+/g, ' '));
  assert.equal(
    sqls.filter((s) => s.includes('INSERT INTO commit_chunks')).length, 1,
    'the chunk is still accounted for, so a retry of it is still recognised'
  );
});

test('§13.21: a different day, kind or source is a different assignment', async () => {
  const { env, DB } = envWithLivePlan([{ date: '2026-08-11', kind: 'chore', source_id: 'CHR-7k2', instance_key: '' }]);
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: {
      batchId: 'B2', chunkIndex: 0, childId: 'CH-1',
      assignments: [
        { ...choreRow, date: '2026-08-12' },            // same chore, next day
        { ...choreRow, kind: 'activity' },              // same id, different kind
        { ...choreRow, sourceId: 'CHR-999' },           // another chore, same day
      ],
    },
  });
  const out = await res.json();
  assert.equal(out.applied, 3);
  assert.equal(out.skipped, 0);
  assert.equal(insertsIn(DB).length, 3);
});

// ---- Shared Chores §3: instance_key is a fourth component of identity ----

test('Shared Chores §3: a different instanceKey is a different occurrence, even same day/kind/source', async () => {
  // Three-dishes: Breakfast/Lunch/Dinner share date, kind and sourceId and are
  // distinguished only by instanceKey. Without it in the natural key, the
  // second and third collapse into the first.
  const { env, DB } = envWithLivePlan([{ date: '2026-08-11', kind: 'chore', source_id: 'CHR-7k2', instance_key: 'i1' }]);
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: {
      batchId: 'B2', chunkIndex: 0, childId: 'CH-1',
      assignments: [
        { ...choreRow, instanceKey: 'i1' }, // already live — skipped
        { ...choreRow, instanceKey: 'i2' },
        { ...choreRow, instanceKey: 'i3' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(out.applied, 2);
  assert.equal(out.skipped, 1);
  assert.equal(insertsIn(DB).length, 2);
});

test('Shared Chores §3: instanceKey defaults to the empty string, not null', async () => {
  const { env, DB } = envWithLivePlan([]);
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B2', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow] },
  });
  const insertStmt = DB.batched[0].find((s) => s.sql.includes('INSERT INTO assignments'));
  assert.ok(insertStmt.sql.includes('instance_key'), 'instance_key is in the column list');
  assert.ok(insertStmt.sql.includes('instance_key = ?16'), 'the NOT EXISTS guard keys on it too');
  // Shared Chores §5.2 added claim_group as the bind right after instance_key,
  // pushing instance_key to third-from-last (claim_group, then now).
  assert.equal(insertStmt.args.at(-3), '', 'bound as empty string, never null — NULL = NULL never matches in SQLite');
});

test('§13.21: the same row twice inside one chunk is stored once', async () => {
  const { env, DB } = envWithLivePlan([]);
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B2', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow, choreRow] },
  });
  const out = await res.json();
  assert.equal(out.applied, 1);
  assert.equal(out.skipped, 1);
  assert.equal(insertsIn(DB).length, 1);
});

test('§13.21: a rescinded row does not block assigning that work again', async () => {
  // The repair path §6.3 exists for: pull a bad batch back, fix the pacing,
  // generate the range again. A tombstone that blocked the re-assign would make
  // rescind a one-way door, so the lookup has to exclude rescinded rows — and
  // the guard on the INSERT has to agree with it.
  const { env, statements, DB } = envWithLivePlan([]);
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B2', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow] },
  });
  const lookup = statements.find((s) => s.sql.includes('SELECT date, kind, source_id, instance_key FROM assignments'));
  assert.ok(lookup, 'the pre-check must run');
  assert.match(lookup.sql, /rescinded_at IS NULL/);
  assert.match(insertsIn(DB)[0], /NOT EXISTS/);
  assert.match(insertsIn(DB)[0], /rescinded_at IS NULL/);
});

test('§13.21: the lookup is bounded by the chunk\'s own date span', async () => {
  // Unbounded, this would read the child's whole history on every chunk of a
  // four-chunk semester Commit. Bounded, it is one indexed range scan.
  const { env, statements } = envWithLivePlan([]);
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: {
      batchId: 'B2', chunkIndex: 0, childId: 'CH-1',
      assignments: [{ ...choreRow, date: '2026-09-04' }, choreRow, { ...choreRow, date: '2026-08-20' }],
    },
  });
  const lookup = statements.find((s) => s.sql.includes('SELECT date, kind, source_id, instance_key FROM assignments'));
  assert.deepEqual(lookup.args, ['CH-1', '2026-08-11', '2026-09-04']);
});

test('§13.21: a row with no sourceId has no natural key and is always inserted', async () => {
  // `oneRow` carries no provenance, so nothing can call it a repeat. It must
  // not be silently deduped against another provenance-less row.
  const { env, DB, statements } = envWithLivePlan([]);
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B2', chunkIndex: 0, childId: 'CH-1', assignments: [oneRow, oneRow] },
  });
  assert.equal((await res.json()).applied, 2);
  assert.equal(insertsIn(DB).length, 2);
  assert.ok(
    !statements.some((s) => s.sql.includes('SELECT date, kind, source_id, instance_key FROM assignments')),
    'with nothing to key on there is nothing to look up'
  );
});

test('a genuine batch failure is still an error', async () => {
  const { env } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  env.DB.batch = async () => { throw new Error('database is locked'); };
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: [oneRow] },
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /database is locked/);
});

test('chunkIndex must be a non-negative integer, and defaults to 0', async () => {
  const { env } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  for (const bad of [-1, 1.5, 'one']) {
    const res = await call(env, '/api/assignments', {
      method: 'POST', token: PARENT_TOKEN,
      body: { batchId: 'B1', chunkIndex: bad, childId: 'CH-1', assignments: [oneRow] },
    });
    assert.equal(res.status, 400, `chunkIndex ${bad} should be refused`);
  }
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', childId: 'CH-1', assignments: [oneRow] },
  });
  assert.equal(res.status, 200, 'an older client sending no chunkIndex still works');
});

test('a Commit row may not carry a child-owned column', async () => {
  const { env } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: [{ ...oneRow, status: 'complete' }] },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /may not set: status/);
});

test('a Commit over MAX_BATCH rows is 413', async () => {
  const { env } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B1', chunkIndex: 0, childId: 'CH-1', assignments: Array(501).fill(oneRow) },
  });
  assert.equal(res.status, 413);
});

// ==============================================  child writes (§4.2, §5.6)

test('§13.19: a bad value is rejected per row and never reaches an UPDATE', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,
    body: {
      completions: [
        { id: 'good', status: 'complete', completedAt: 1754870400000 },
        { id: 'bad-status', status: 'banana' },
        { id: 'bad-date', deferredTo: 'tomorrow' },
        { id: 'bad-grade', grade: 'A+' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200, 'the batch as a whole must still succeed');
  assert.equal(out.applied, 1);
  assert.deepEqual(out.rejected.map((r) => r.id).sort(), ['bad-date', 'bad-grade', 'bad-status']);

  const updates = statements.filter((s) => s.sql.startsWith('UPDATE assignments'));
  assert.equal(updates.length, 1, 'only the well-formed row may be written');
});

test('§13.3: a child writing a parent-owned column is rejected by name', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,
    body: { completions: [{ id: 'a1', title: 'hacked', rewardAmount: 999 }] },
  });
  const out = await res.json();
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].error, /title/);
  assert.match(out.rejected[0].error, /rewardAmount/);
  assert.equal(statements.filter((s) => s.sql.startsWith('UPDATE assignments')).length, 0);
});

test('§13.1: child_id comes from the token and the body cannot forge it', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,
    body: { childId: 'CH-SOMEONE-ELSE', completions: [{ id: 'a1', status: 'complete' }] },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(update.sql.includes('child_id = ?'), 'child_id must be in the WHERE');
  assert.ok(update.args.includes('CH-1'), 'the token\'s child is what is bound');
  assert.ok(!update.args.includes('CH-SOMEONE-ELSE'), 'the body value must be ignored');
});

test('a completion naming another child\'s assignment comes back in rejected', async () => {
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.startsWith('\n      UPDATE assignments') || sql.includes('UPDATE assignments SET')
      ? { meta: { changes: 0 } } : {}
  )));
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,
    body: { completions: [{ id: 'someone-elses', status: 'complete' }] },
  });
  const out = await res.json();
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].error, /Not found for this child/);
});

test('§13.20: one bad reward entry does not take the batch with it', async () => {
  const { env, DB } = makeEnv(deviceResolver());
  const res = await call(env, '/api/rewards/entries', {
    method: 'POST', token: DEVICE_TOKEN,
    body: {
      entries: [
        { id: 'r1', category: 'RC-1', amount: 1 },
        { id: 'r2', amount: 1 },                       // no category
        { id: 'r3', category: 'RC-1', amount: 'lots' }, // not a number
      ],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200, 'must NOT be a 400 — the client discards a 4xx batch');
  assert.equal(out.applied, 1);
  assert.deepEqual(out.rejected.map((r) => r.id), ['r2', 'r3']);
  assert.equal(DB.batched[0].length, 1);
});

// ====================================  §11.7: deferral, not rejection

test('§11.7: a D1 throw defers that row and leaves the rest of the batch applied', async () => {
  // The failure §5.5 describes: the Worker writes a column the migration has
  // not added yet. Only the rows carrying that column throw.
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('completion_note =') ? { throws: new Error('D1_ERROR: no such column: completion_note') } : {}
  )));
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      completions: [
        { id: 'plain', status: 'complete' },
        { id: 'with-note', status: 'complete', completionNote: 'skipped #11' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200, 'a 500 here would halt the device\'s whole drain');
  assert.equal(out.applied, 1, 'the row that could be written still was');
  assert.deepEqual(out.rejected, [], 'a missing column is not the row\'s fault');
  assert.deepEqual(out.deferred.map((r) => r.id), ['with-note']);
  assert.match(out.deferred[0].error, /no such column: completion_note/,
    'the parent needs to see which migration is missing');
});

test('§11.7: a deferral is reported separately from a rejection in one batch', async () => {
  const { env } = makeEnv(deviceResolver((sql, args) => {
    if (sql.includes('UPDATE assignments') && args.includes('doomed')) {
      return { throws: new Error('D1_ERROR: database is locked') };
    }
    return {};
  }));
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      completions: [
        { id: 'fine', status: 'complete' },
        { id: 'doomed', status: 'complete' },
        { id: 'malformed', status: 'banana' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(out.applied, 1);
  assert.deepEqual(out.rejected.map((r) => r.id), ['malformed'], 'a bad value is still permanent');
  assert.deepEqual(out.deferred.map((r) => r.id), ['doomed'], 'a database fault is not');
});

test('§11.7: a failed reward batch defers every queued entry instead of 500ing', async () => {
  const { env, DB } = makeEnv(deviceResolver());
  DB.batchError = new Error('D1_ERROR: no such table: reward_entries');
  const res = await call(env, '/api/rewards/entries', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      entries: [
        { id: 'r1', category: 'RC-1', amount: 1 },
        { id: 'r2', category: 'RC-1', amount: -1, reason: 'adjustment' },
        { id: 'bad', amount: 1 },
      ],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 0, 'nothing landed, so nothing may be reported as applied');
  assert.deepEqual(out.rejected.map((r) => r.id), ['bad'], 'the malformed entry is still permanent');
  assert.deepEqual(out.deferred.map((r) => r.id), ['r1', 'r2'],
    'an append-only ledger must never have rows discarded by a transient fault');
});

test('a clean batch reports an empty deferred array, not an absent one', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { completions: [{ id: 'a1', status: 'complete' }] },
  });
  const out = await res.json();
  assert.deepEqual(out.deferred, []);
});

test('§11.7: a client that does not announce protocol 2 gets a retryable 5xx', async () => {
  // The compatibility half. A shell predating this change reads only
  // `rejected`, so handing it a 200 carrying `deferred` would make it delete
  // the very rows the server just declined to write. It gets the old answer.
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('completion_note =') ? { throws: new Error('D1_ERROR: no such column: completion_note') } : {}
  )));
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,   // no X-Outbox-Protocol
    body: { completions: [{ id: 'with-note', status: 'complete', completionNote: 'hi' }] },
  });
  assert.equal(res.status, 503, 'retryable, so an old client keeps its queue rows');
  const out = await res.json();
  assert.equal(out.deferred, 1);
  assert.match(out.detail, /no such column/);
});

test('§11.7: the rewards route gates the new shape the same way', async () => {
  const { env, DB } = makeEnv(deviceResolver());
  DB.batchError = new Error('D1_ERROR: no such table: reward_entries');
  const res = await call(env, '/api/rewards/entries', {
    method: 'POST', token: DEVICE_TOKEN,   // no X-Outbox-Protocol
    body: { entries: [{ id: 'r1', category: 'RC-1', amount: 1 }] },
  });
  assert.equal(res.status, 503);
});

test('a reward append is idempotent on the client-minted id', async () => {
  const { env, DB } = makeEnv(deviceResolver());
  await call(env, '/api/rewards/entries', {
    method: 'POST', token: DEVICE_TOKEN,
    body: { entries: [{ id: 'r1', category: 'RC-1', amount: 1 }] },
  });
  assert.match(DB.batched[0][0].sql.replace(/\s+/g, ' '), /ON CONFLICT \(id\) DO NOTHING/);
});

test('the streak upsert clamps rather than storing nonsense', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  await call(env, '/api/streak', {
    method: 'PUT', token: DEVICE_TOKEN,
    body: { currentStreak: -5, longestStreak: 2, lastQualifiedDate: 'never' },
  });
  const upsert = statements.find((s) => s.sql.includes('INSERT INTO streaks'));
  assert.equal(upsert.args[1], 0, 'a negative current streak clamps to 0');
  assert.equal(upsert.args[3], null, 'a malformed date is stored as NULL');
});

// ===============================================================  the plan

test('/api/plan is scoped to the token\'s child and takes no child parameter', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  await call(env, '/api/plan?childId=CH-OTHER&from=2026-08-01&to=2026-08-31', { token: DEVICE_TOKEN });
  const select = statements.find((s) => s.sql.startsWith('SELECT * FROM assignments'));
  assert.ok(select.args.includes('CH-1'));
  assert.ok(!select.args.includes('CH-OTHER'));
});

test('/api/plan is bounded and reports truncation', async () => {
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('SELECT * FROM assignments')
      ? { results: Array.from({ length: 5001 }, (_, i) => ({ id: `a${i}` })) }
      : {}
  )));
  const res = await call(env, '/api/plan', { token: DEVICE_TOKEN });
  const out = await res.json();
  assert.equal(out.assignments.length, 5000);
  assert.equal(out.truncated, true);
});

test('/api/plan includes rescinded rows so the client can drop them', async () => {
  const { env, statements } = makeEnv(deviceResolver());
  await call(env, '/api/plan', { token: DEVICE_TOKEN });
  const select = statements.find((s) => s.sql.startsWith('SELECT * FROM assignments'));
  assert.ok(!select.sql.includes('rescinded_at IS NULL'), 'the child must learn about rescissions');
});

// ==============================================================  rescind

test('rescind defaults to pending rows only', async () => {
  const { env, statements } = makeEnv();
  await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: { batchId: 'B1' },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(update.sql.includes("status = 'pending'"));
  assert.ok(update.sql.includes('rescinded_at IS NULL'));
  // §6.3: never a DELETE.
  assert.ok(!statements.some((s) => /DELETE FROM assignments/.test(s.sql)));
});

test('rescind binds exactly the parameters its selector uses', async () => {
  // The old code bound `now` twice to hold ?2 open while the selector started
  // at ?3. Legal, but one added clause away from a silent mis-bind.
  const { env, statements } = makeEnv();
  await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN,
    body: { childId: 'CH-1', from: '2026-08-01', to: '2026-08-31' },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  const highest = Math.max(...[...update.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(update.args.length, highest, 'one bound value per placeholder index');
  assert.deepEqual(update.args.slice(1), ['CH-1', '2026-08-01', '2026-08-31']);
});

test('rescind with includeCompleted drops the status guard', async () => {
  const { env, statements } = makeEnv();
  await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: { batchId: 'B1', includeCompleted: true },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(!update.sql.includes("status = 'pending'"));
});

test('rescind needs a selector', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: {},
  });
  assert.equal(res.status, 400);
});

// =============================================================  routing

test('the §10 short URLs redirect', async () => {
  const { env } = makeEnv();
  const root = await call(env, '/');
  assert.equal(root.status, 302);
  assert.equal(new URL(root.headers.get('location')).pathname, '/management-app/');

  const kid = await call(env, '/kid');
  assert.equal(new URL(kid.headers.get('location')).pathname, '/child-app/');
});

test('an unknown /api/ path is 404', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/api/nope', { token: PARENT_TOKEN });
  assert.equal(res.status, 404);
});

test('every API response is no-store', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/api/nope', { token: PARENT_TOKEN });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/admin/migrations renders a no-JS form and refuses a wrong token', async () => {
  const { env } = makeEnv();
  const page = await call(env, '/admin/migrations');
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.match(body, /<form method="post"/);
  assert.ok(!/<script/i.test(body), 'the fallback page must not depend on JavaScript');

  const form = new FormData();
  form.set('token', 'wrong');
  form.set('confirm', 'yes');
  const rejected = await worker.fetch(
    new Request('https://example.test/admin/migrations', { method: 'POST', body: form }), env, ctx
  );
  assert.equal(rejected.status, 401);
});

// ==========================  admin reset

test('a device token on /api/admin/reset is 401', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/admin/reset', {
    method: 'POST', token: DEVICE_TOKEN, body: { confirm: 'RESET' },
  });
  assert.equal(res.status, 401);
});

test('/api/admin/reset with the parent token but no typed confirmation is a 400, and writes nothing', async () => {
  const { env, DB } = makeEnv();
  const res = await call(env, '/api/admin/reset', { method: 'POST', token: PARENT_TOKEN, body: {} });
  assert.equal(res.status, 400);
  assert.equal(DB.batched.length, 0);
});

test('/api/admin/reset with confirm:"RESET" deletes every data table in one batch', async () => {
  const { env, DB } = makeEnv();
  const res = await call(env, '/api/admin/reset', {
    method: 'POST', token: PARENT_TOKEN, body: { confirm: 'RESET' },
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);

  assert.equal(DB.batched.length, 1);
  const statements = DB.batched[0].map((s) => s.sql);
  assert.ok(statements.every((sql) => /^DELETE FROM \w+$/.test(sql)));
  // d1_migrations is deliberately untouched — a reset empties data, not the
  // record of which migrations have already been applied.
  assert.ok(!statements.some((sql) => sql.includes('d1_migrations')));
  for (const table of ['assignments', 'devices', 'records', 'children', 'reward_entries']) {
    assert.ok(statements.some((sql) => sql === `DELETE FROM ${table}`), `missing DELETE for ${table}`);
  }
});

// ==========================  admin clear assignments

test('a device token on /api/admin/assignments/clear is 401', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, '/api/admin/assignments/clear', {
    method: 'POST', token: DEVICE_TOKEN, body: { confirm: 'CLEAR_ASSIGNMENTS' },
  });
  assert.equal(res.status, 401);
});

test('/api/admin/assignments/clear with the parent token but no typed confirmation is a 400, and writes nothing', async () => {
  const { env, DB } = makeEnv();
  const res = await call(env, '/api/admin/assignments/clear', { method: 'POST', token: PARENT_TOKEN, body: {} });
  assert.equal(res.status, 400);
  assert.equal(DB.batched.length, 0);
});

test('/api/admin/assignments/clear with confirm:"CLEAR_ASSIGNMENTS" deletes only the assignment lifecycle tables', async () => {
  const { env, DB } = makeEnv();
  const res = await call(env, '/api/admin/assignments/clear', {
    method: 'POST', token: PARENT_TOKEN, body: { confirm: 'CLEAR_ASSIGNMENTS' },
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);

  assert.equal(DB.batched.length, 1);
  const statements = DB.batched[0].map((s) => s.sql);
  assert.ok(statements.every((sql) => /^DELETE FROM \w+$/.test(sql)));
  for (const table of ['assignments', 'claim_groups', 'commit_chunks', 'assignment_messages']) {
    assert.ok(statements.some((sql) => sql === `DELETE FROM ${table}`), `missing DELETE for ${table}`);
  }
  // Curriculum, children, devices, and reward data are a different concern —
  // this route must never touch them (that is what /api/admin/reset is for).
  for (const table of ['children', 'devices', 'records', 'reward_entries', 'streaks', 'pair_codes']) {
    assert.ok(!statements.some((sql) => sql === `DELETE FROM ${table}`), `unexpected DELETE for ${table}`);
  }
});

// ==========================  assignment messages (§6.2, SRS Module 13)

// Resolves the ownership lookup: CH-1 owns a1 and a2, nothing else.
function messageEnv(extra = () => ({})) {
  return makeEnv(deviceResolver((sql, args) => {
    if (sql.includes('SELECT id FROM assignments')) {
      const owned = ['a1', 'a2'].filter((id) => args.includes(id));
      return { results: owned.map((id) => ({ id })) };
    }
    return extra(sql, args);
  }));
}

test('a message batch inserts idempotently and takes child_id from the token', async () => {
  const { env, DB } = messageEnv();
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      childId: 'CH-SOMEONE-ELSE',
      messages: [{ id: 'm1', assignmentId: 'a1', body: 'why is problem 7 like that?' }],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 1);
  assert.deepEqual(out.rejected, []);

  const insert = DB.batched[0][0];
  assert.match(insert.sql.replace(/\s+/g, ' '), /ON CONFLICT \(id\) DO NOTHING/);
  assert.ok(insert.args.includes('CH-1'), "the token's child is what is bound");
  assert.ok(!insert.args.includes('CH-SOMEONE-ELSE'), 'the body value must be ignored');
});

test('a message naming another child\'s assignment is rejected, not written', async () => {
  // §6.2's extra check: without it a device could staple a message onto any
  // assignment id it could guess.
  const { env, DB } = messageEnv();
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      messages: [
        { id: 'm1', assignmentId: 'a1', body: 'mine' },
        { id: 'm2', assignmentId: 'not-mine', body: 'someone else\'s' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(out.applied, 1);
  assert.deepEqual(out.rejected.map((r) => r.id), ['m2']);
  assert.match(out.rejected[0].error, /Not found for this child/);
  assert.equal(DB.batched[0].length, 1, 'only the owned message may be inserted');
});

test('a malformed message is rejected per row and never reaches the batch', async () => {
  const { env, DB } = messageEnv();
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: {
      messages: [
        { id: 'm1', assignmentId: 'a1', body: 'fine' },
        { id: 'm2', assignmentId: 'a1', body: '   ' },
        { id: 'm3', assignmentId: 'a1', body: 'x'.repeat(501) },
        { assignmentId: 'a1', body: 'no id' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(res.status, 200, 'one bad row must not take the batch with it');
  assert.equal(out.applied, 1);
  assert.equal(out.rejected.length, 3);
  assert.equal(DB.batched[0].length, 1);
});

test('a message body is stored trimmed', async () => {
  const { env, DB } = messageEnv();
  await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { messages: [{ id: 'm1', assignmentId: 'a1', body: '  why?  ' }] },
  });
  assert.ok(DB.batched[0][0].args.includes('why?'));
});

test('§11.7: a failed message batch defers rather than dropping the questions', async () => {
  const { env, DB } = messageEnv();
  DB.batchError = new Error('D1_ERROR: no such table: assignment_messages');
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { messages: [{ id: 'm1', assignmentId: 'a1', body: 'why?' }] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 0);
  assert.deepEqual(out.deferred.map((r) => r.id), ['m1']);
});

test('§11.7: a failed ownership lookup defers instead of guessing at ownership', async () => {
  // Unknown ownership is not "not owned" — rejecting here would discard a
  // child's question because the database blinked.
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('SELECT id FROM assignments') ? { throws: new Error('D1_ERROR: database is locked') } : {}
  )));
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { messages: [{ id: 'm1', assignmentId: 'a1', body: 'why?' }] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 0);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.deferred.map((r) => r.id), ['m1']);
});

test('an empty message batch is a no-op, not an error', async () => {
  const { env, DB } = messageEnv();
  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, body: { messages: [] },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, 0);
  assert.equal(DB.batched.length, 0);
});

test('the message routes split by credential the way §6.2 says', async () => {
  const { env } = messageEnv();
  // Parent token cannot append.
  assert.equal((await call(env, '/api/messages', {
    method: 'POST', token: PARENT_TOKEN, body: { messages: [] },
  })).status, 401);
  // Device token cannot read the inbox or mark anything read.
  assert.equal((await call(env, '/api/messages?childId=CH-1', { token: DEVICE_TOKEN })).status, 401);
  assert.equal((await call(env, '/api/messages/read', {
    method: 'POST', token: DEVICE_TOKEN, body: { ids: ['m1'] },
  })).status, 401);
});

test('the inbox query left-joins the assignment so a rescinded one still shows', async () => {
  // FR-6: the question was still asked. A plain join would drop exactly the
  // rows a parent most needs to see.
  const { env, statements } = makeEnv(() => ({ results: [], first: { n: 0 } }));
  const res = await call(env, '/api/messages?childId=CH-1&unreadOnly=1', { token: PARENT_TOKEN });
  assert.equal(res.status, 200);
  const query = statements.find((s) => s.sql.includes('FROM assignment_messages m'));
  assert.match(query.sql, /LEFT JOIN assignments/);
  assert.match(query.sql, /read_at IS NULL/);
  assert.match(query.sql, /ORDER BY m\.created_at DESC/);
});

test('the inbox reports an unread count independent of the page it returned', async () => {
  const { env } = makeEnv((sql) => (
    sql.includes('COUNT(*)') ? { first: { n: 7 } } : { results: [{ id: 'm1' }] }
  ));
  const out = await (await call(env, '/api/messages?childId=CH-1', { token: PARENT_TOKEN })).json();
  assert.equal(out.unread, 7);
  assert.equal(out.messages.length, 1);
});

test('the inbox rejects a malformed since rather than ignoring it', async () => {
  const { env } = makeEnv(() => ({ results: [], first: { n: 0 } }));
  assert.equal((await call(env, '/api/messages?since=yesterday', { token: PARENT_TOKEN })).status, 400);
  assert.equal((await call(env, '/api/messages?since=1754870400000', { token: PARENT_TOKEN })).status, 200);
});

test('mark-read only touches unread rows, so a timestamp is never bumped', async () => {
  const { env, statements } = makeEnv(() => ({ meta: { changes: 2 } }));
  const res = await call(env, '/api/messages/read', {
    method: 'POST', token: PARENT_TOKEN, body: { ids: ['m1', 'm2'] },
  });
  const out = await res.json();
  assert.equal(out.read, 2);
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignment_messages'));
  assert.match(update.sql, /read_at IS NULL/);
});

test('mark-read needs a non-empty ids array and caps the batch', async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, '/api/messages/read', {
    method: 'POST', token: PARENT_TOKEN, body: { ids: [] },
  })).status, 400);
  assert.equal((await call(env, '/api/messages/read', {
    method: 'POST', token: PARENT_TOKEN, body: { ids: Array(501).fill('m1') },
  })).status, 413);
});

test('there is no route that clears read_at — FR-4 has no mark-unread in v1', async () => {
  const { env } = makeEnv();
  for (const path of ['/api/messages/unread', '/api/messages/read/undo']) {
    const res = await call(env, path, { method: 'POST', token: PARENT_TOKEN, body: { ids: ['m1'] } });
    assert.equal(res.status, 404, `${path} must not exist`);
  }
});

// ============================================  Shared Chores §5: claim/release

const CLAIM_PATH = '/api/assignments/AS-1/claim';

test('the claim route needs a device credential, not a parent token', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: PARENT_TOKEN, body: {} });
  assert.equal(res.status, 401);
});

test('§5.4: a claim body may not set anything but grade and completionNote', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, CLAIM_PATH, {
    method: 'POST', token: DEVICE_TOKEN, body: { status: 'complete' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /may not set: status/);
});

test('§5.4: a claim body value is validated the same way a completion value is', async () => {
  const { env } = makeEnv(deviceResolver());
  const res = await call(env, CLAIM_PATH, {
    method: 'POST', token: DEVICE_TOKEN, body: { grade: 'A+' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /grade must be a finite number/);
});

test('§5.4: an unknown or another child\'s assignment id is 404, not 403', async () => {
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('SELECT claim_group, rescinded_at FROM assignments') ? { first: null } : {}
  )));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: {} });
  assert.equal(res.status, 404);
});

test('§5.4: a row with no claim_group is rejected, pointed at /api/completions', async () => {
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('SELECT claim_group, rescinded_at FROM assignments')
      ? { first: { claim_group: null, rescinded_at: null } } : {}
  )));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /use \/api\/completions/);
});

test('§5.4: a rescinded row is 409 — the parent pulled it', async () => {
  const { env } = makeEnv(deviceResolver((sql) => (
    sql.includes('SELECT claim_group, rescinded_at FROM assignments')
      ? { first: { claim_group: 'GRP-1', rescinded_at: 1700000000000 } } : {}
  )));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: {} });
  assert.equal(res.status, 409);
});

test('§5.4: winning the arbitration writes the completion and returns the row', async () => {
  const { env, statements } = makeEnv(deviceResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 2 } };
    if (sql.includes("SET status = 'complete'")) return { meta: { changes: 1 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) {
      return { first: { id: 'AS-1', status: 'complete', claimed_by: 'CH-1' } };
    }
    return {};
  }));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: { grade: 95 } });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.claimed, true);
  assert.equal(out.assignment.id, 'AS-1');

  // The arbitration writes the whole group in one statement, not just the
  // caller's row — that is what puts the outcome on the sibling's row too.
  const arbitration = statements.find((s) => s.sql.includes('SET claimed_by = ?1, claimed_at = ?2'));
  assert.ok(!arbitration.sql.includes('AND child_id'), 'the arbitration UPDATE is not scoped to one child');
  assert.equal(arbitration.args[0], 'CH-1');
  assert.equal(arbitration.args[2], 'GRP-1');
});

test('§5.4: losing the arbitration writes nothing and answers claimed: false', async () => {
  const { env, DB } = makeEnv(deviceResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 0 } };
    if (sql.includes('SELECT claimed_by FROM assignments')) return { first: { claimed_by: 'CH-SIBLING' } };
    return {};
  }));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: {} });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out, { claimed: false });
  assert.equal(DB.batched.length, 0, 'the claim route writes directly, never through batch()');
});

test('§5.4: a replay of an already-won claim is answered as a win, idempotently', async () => {
  // The window §5.4 names: this caller's own arbitration write already
  // landed, so this attempt's UPDATE matches nothing new — but the group's
  // live claimant is still this caller, read back from the group rather than
  // the caller's own (still-unclaimed-looking) row.
  const { env } = makeEnv(deviceResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 0 } };
    if (sql.includes('SELECT claimed_by FROM assignments')) return { first: { claimed_by: 'CH-1' } };
    if (sql.includes("SET status = 'complete'")) return { meta: { changes: 1 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) return { first: { id: 'AS-1' } };
    return {};
  }));
  const res = await call(env, CLAIM_PATH, { method: 'POST', token: DEVICE_TOKEN, body: {} });
  assert.equal((await res.json()).claimed, true);
});

test('§5.5: releasing gives the occurrence back and clears the caller\'s completion', async () => {
  const { env, statements } = makeEnv(deviceResolver((sql) => {
    if (sql.includes('SELECT claim_group FROM assignments WHERE id')) return { first: { claim_group: 'GRP-1' } };
    if (sql.includes('SET claimed_by = NULL')) return { meta: { changes: 2 } };
    if (sql.includes("SET status = 'pending'")) return { meta: { changes: 1 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) return { first: { id: 'AS-1', status: 'pending' } };
    return {};
  }));
  const res = await call(env, CLAIM_PATH, { method: 'DELETE', token: DEVICE_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.released, true);

  const release = statements.find((s) => s.sql.includes('SET claimed_by = NULL'));
  assert.ok(release.sql.includes('claimed_by = ?3'), 'only the current claimant may release');
});

test('§5.5: a caller who already lost the race releases nothing', async () => {
  const { env } = makeEnv(deviceResolver((sql) => {
    if (sql.includes('SELECT claim_group FROM assignments WHERE id')) return { first: { claim_group: 'GRP-1' } };
    if (sql.includes('SET claimed_by = NULL')) return { meta: { changes: 0 } };
    return {};
  }));
  const res = await call(env, CLAIM_PATH, { method: 'DELETE', token: DEVICE_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out, { released: false });
});

test('§5.6: a shared row cannot be completed through /api/completions', async () => {
  const { env, DB } = makeEnv(deviceResolver((sql) => {
    if (sql.startsWith('UPDATE assignments') && sql.includes('claim_group IS NULL')) {
      return { meta: { changes: 0 } };
    }
    if (sql.includes('SELECT claim_group FROM assignments WHERE id')) return { first: { claim_group: 'GRP-1' } };
    return {};
  }));
  const res = await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN,
    body: { completions: [{ id: 'AS-1', status: 'complete' }] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].error, /use \/api\/assignments\/:id\/claim/);
  assert.equal(DB.batched.length, 0, 'this route never batches');
});

test('§5.3: a shared assignment row is grouped, keyed by the resolved claim_groups id', async () => {
  const { env, DB } = makeEnv((sql) => {
    if (sql.includes('FROM commit_chunks')) return { first: null };
    // Answers the read-back as if this triple already had a group — either
    // this device minted it moments ago or a sibling Commit's insert won the
    // race; the resolution is the same either way.
    if (sql.includes('SELECT source_id, date, instance_key, id FROM claim_groups')) {
      return { results: [{ source_id: 'CHR-7k2', date: '2026-08-11', instance_key: '', id: 'GRP-9' }] };
    }
    return {};
  });
  const sharedRow = { ...choreRow, shared: true };

  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B3', chunkIndex: 0, childId: 'CH-1', assignments: [sharedRow] },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 1);

  // Two batches: the claim_groups resolution, then the assignment insert.
  assert.equal(DB.batched.length, 2);
  const groupInserts = DB.batched[0];
  assert.ok(groupInserts[0].sql.includes('INSERT INTO claim_groups'));
  assert.ok(groupInserts[0].sql.includes('ON CONFLICT'));

  const insert = DB.batched[1].find((s) => s.sql.includes('INSERT INTO assignments'));
  assert.ok(insert.sql.includes('claim_group'), 'claim_group is in the column list');
  assert.equal(insert.args.at(-2), 'GRP-9', 'bound from the resolved group id');
});

test('§5.3: an unshared chunk never touches claim_groups', async () => {
  const { env, DB } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B3', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow] },
  });
  assert.equal(DB.batched.length, 1, 'no claim_groups resolution batch when nothing is shared');
});

test('§5.3: a shared row with no sourceId is rejected — it has no identity to group on', async () => {
  const { env } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: {
      batchId: 'B3', chunkIndex: 0, childId: 'CH-1',
      assignments: [{ date: '2026-08-11', kind: 'chore', title: 'Dishes', shared: true }],
    },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /needs a sourceId to group on/);
});

// ==========================================  Wall Display App §8 (Phase 1)
//
// Wall TDS §12.12-15. The wall's whole safety argument is that one credential
// widens *which child* may be acted for and nothing else, so these check the
// two directions of the credential wall and the three bounds that contain the
// child-from-the-request narrowing (CLAUDE.md §III.E).

const WALL_TOKEN = 'wall-bearer-token';
const WALL_HASH = await sha256Hex(WALL_TOKEN);

// Resolves WALL_TOKEN to a scope='wall' device and DEVICE_TOKEN to a child
// one, so a single env can be pointed at either credential.
function wallResolver(extra = () => ({})) {
  return (sql, args) => {
    if (sql.includes('FROM devices WHERE token_hash')) {
      if (args[0] === WALL_HASH) return { first: { id: 'DEV-WALL', child_id: '', scope: 'wall' } };
      if (args[0] === DEVICE_HASH) return { first: { id: 'DEV-1', child_id: 'CH-1', scope: 'child' } };
      return { first: null };
    }
    // The roster check every wall route runs before it touches `assignments`.
    if (sql.includes('FROM children WHERE id = ?1 AND active = 1')) {
      return { first: args[0] === 'CH-1' ? { id: 'CH-1' } : null };
    }
    return extra(sql, args);
  };
}

const WALL_DEVICE_ROUTES = [
  ['/api/plan', 'GET', undefined],
  ['/api/plan/version', 'GET', undefined],
  ['/api/completions', 'POST', { completions: [] }],
  ['/api/rewards/entries', 'POST', { entries: [] }],
  ['/api/assignments/AS-1/claim', 'POST', {}],
  ['/api/assignments/AS-1/claim', 'DELETE', undefined],
  ['/api/streak', 'PUT', { currentStreak: 1 }],
  ['/api/messages', 'POST', { messages: [] }],
];

test('§12.12: a wall token is 401 on every child-device route', async () => {
  for (const [path, method, body] of WALL_DEVICE_ROUTES) {
    const { env, DB } = makeEnv(wallResolver());
    const res = await call(env, path, { method, token: WALL_TOKEN, body, outboxProtocol: 2 });
    assert.equal(res.status, 401, `${method} ${path} must not accept a wall token`);
    assert.equal(DB.batched.length, 0);
  }
});

const WALL_ROUTES = [
  ['/api/wall/children', 'GET', undefined],
  ['/api/wall/plan?childId=CH-1', 'GET', undefined],
  ['/api/wall/completions', 'POST', { childId: 'CH-1', completions: [] }],
  ['/api/wall/rewards/entries', 'POST', { childId: 'CH-1', entries: [] }],
  ['/api/wall/assignments/AS-1/claim', 'POST', { childId: 'CH-1' }],
  ['/api/wall/assignments/AS-1/claim?childId=CH-1', 'DELETE', undefined],
];

test('§12.13: a child device token is 401 on every /api/wall/* route', async () => {
  for (const [path, method, body] of WALL_ROUTES) {
    const { env } = makeEnv(wallResolver());
    const res = await call(env, path, { method, token: DEVICE_TOKEN, body, outboxProtocol: 2 });
    assert.equal(res.status, 401, `${method} ${path} must not accept a child device token`);
  }
});

test('a parent token is 401 on the wall routes too — the credential is minted, not the secret', async () => {
  for (const [path, method, body] of WALL_ROUTES) {
    const { env } = makeEnv(wallResolver());
    const res = await call(env, path, { method, token: PARENT_TOKEN, body, outboxProtocol: 2 });
    assert.equal(res.status, 401, `${method} ${path} must not accept SYNC_TOKEN`);
  }
});

test('§8.2: a device row from before 0009 reads as a child token, not a wall one', async () => {
  // The migration is applied in the browser and the code may land first
  // (DEPLOY.md's ordering note). A row with no `scope` must keep working on
  // the Child App's routes and must not become a household credential.
  const { env } = makeEnv((sql, args) => {
    if (sql.includes('FROM devices WHERE token_hash')) {
      return { first: args[0] === DEVICE_HASH ? { id: 'DEV-1', child_id: 'CH-1' } : null };
    }
    return {};
  });
  assert.equal((await call(env, '/api/plan', { token: DEVICE_TOKEN })).status, 200);
  assert.equal((await call(env, '/api/wall/children', { token: DEVICE_TOKEN })).status, 401);
});

test('§3.3: the roster is exactly the active children, by name', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.includes('SELECT id, name FROM children')
      ? { results: [{ id: 'CH-2', name: 'Ellie' }, { id: 'CH-1', name: 'Talia' }] }
      : {}
  )));
  const res = await call(env, '/api/wall/children', { token: WALL_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out.children.map((c) => c.name), ['Ellie', 'Talia']);

  const roster = statements.find((s) => s.sql.includes('SELECT id, name FROM children'));
  assert.ok(roster.sql.includes('active = 1'), 'archived children are not on the wall');
  assert.ok(!roster.sql.includes('devices'), 'the roster is D1\'s answer, not a list of paired tablets');
});

// ---- §8.3 bound 1: the named child is validated against the roster --------

test('§12.14: an unknown or archived childId writes nothing', async () => {
  for (const childId of ['CH-ARCHIVED', 'CH-NOT-A-CHILD']) {
    const { env, statements, DB } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/completions', {
      method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
      body: { childId, completions: [{ id: 'AS-1', status: 'complete' }] },
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /active child/);
    assert.equal(DB.batched.length, 0);
    assert.equal(
      statements.filter((s) => s.sql.includes('assignments')).length, 0,
      'the roster check runs before anything touches assignments'
    );
  }
});

test('§12.14: a missing childId is a 400, not a write against an empty string', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { completions: [{ id: 'AS-1', status: 'complete' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(statements.filter((s) => s.sql.includes('assignments')).length, 0);
});

// ---- §8.3 bound 2: every statement keeps its own AND child_id = ? ---------

test('§12.14: the resolved child is substituted into the existing child_id clause', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('UPDATE assignments') ? { meta: { changes: 1 } } : {}
  )));
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', status: 'complete', completedAt: 1755100000000 }] },
  });
  assert.equal((await res.json()).applied, 1);

  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(update.sql.includes('AND child_id = ?'), 'the clause is kept, not dropped');
  assert.ok(update.args.includes('CH-1'), 'bound to the roster-resolved child');
  assert.ok(update.sql.includes('claim_group IS NULL'), 'shared rows still go through the claim route');
});

test('a wall token cannot reach a row belonging to a child other than the one it named', async () => {
  // The UPDATE matches nothing because the row is CH-2's; the wall gets the
  // same "not found for this child" a device token would, not another child's row.
  const { env } = makeEnv(wallResolver((sql) => {
    if (sql.startsWith('UPDATE assignments')) return { meta: { changes: 0 } };
    if (sql.includes('SELECT claim_group FROM assignments WHERE id')) return { first: null };
    return {};
  }));
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-2-BELONGS-TO-CH-2', status: 'complete' }] },
  });
  const out = await res.json();
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].error, /Not found for this child/);
});

// ---- §8.3 bound 3: column ownership is not widened -----------------------

test('§12.15: a parent-owned key in a wall completion is rejected per row', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('UPDATE assignments') ? { meta: { changes: 1 } } : {}
  )));
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: {
      childId: 'CH-1',
      completions: [
        { id: 'AS-1', title: 'Something else entirely' },
        { id: 'AS-2', rewardAmount: 999 },
        { id: 'AS-3', status: 'complete' },
      ],
    },
  });
  const out = await res.json();
  assert.equal(out.applied, 1, 'the good row still lands — per row, not per request');
  assert.equal(out.rejected.length, 2);
  assert.match(out.rejected[0].error, /Not a child-writable column: title/);
  assert.match(out.rejected[1].error, /Not a child-writable column: rewardAmount/);
  assert.equal(
    statements.filter((s) => s.sql.startsWith('UPDATE assignments')).length, 1,
    'a rejected row never reaches a statement'
  );
});

test('§12.15: a wall completion value is validated exactly as a device one is', async () => {
  const { env } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', status: 'deleted' }] },
  });
  assert.equal((await res.json()).rejected.length, 1);
});

test('§8.3: the wall claim route strips childId before the claim body check', async () => {
  // CLAIM_BODY_KEYS is reused verbatim, so childId would otherwise be
  // rejected as a key the caller may not set.
  const { env, statements } = makeEnv(wallResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 2 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) return { first: { id: 'AS-1' } };
    return {};
  }));
  const res = await call(env, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).claimed, true);

  const arbitration = statements.find((s) => s.sql.includes('SET claimed_by = ?1'));
  assert.equal(arbitration.args[0], 'CH-1', 'the group is claimed for the named child');
});

test('§8.3: the wall claim route still refuses a body key the caller may not set', async () => {
  const { env } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', status: 'complete' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /may not set: status/);
});

test('§6.5: the wall release takes its child from the query string', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => {
    if (sql.includes('SELECT claim_group FROM assignments WHERE id')) return { first: { claim_group: 'GRP-1' } };
    if (sql.includes('SET claimed_by = NULL')) return { meta: { changes: 2 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) return { first: { id: 'AS-1' } };
    return {};
  }));
  const res = await call(env, '/api/wall/assignments/AS-1/claim?childId=CH-1', {
    method: 'DELETE', token: WALL_TOKEN,
  });
  assert.equal((await res.json()).released, true);
  const release = statements.find((s) => s.sql.includes('SET claimed_by = NULL'));
  assert.equal(release.args[2], 'CH-1', 'only the named child releases its own claim');
});

// ---- §8.4: provenance ----------------------------------------------------

test('§8.4: a wall write is stamped wall:<deviceId>, not device:<deviceId>', async () => {
  const { env, statements, DB } = makeEnv(wallResolver((sql) => (
    sql.startsWith('UPDATE assignments') ? { meta: { changes: 1 } } : {}
  )));
  await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', status: 'complete' }] },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(update.args.includes('wall:DEV-WALL'), 'one wall device writes for every child');

  await call(env, '/api/wall/rewards/entries', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', entries: [{ id: 'RE-1', category: 'screen-time', amount: 2 }] },
  });
  const insert = DB.batched.at(-1)[0];
  assert.ok(insert.sql.includes('INSERT INTO reward_entries'));
  assert.equal(insert.args[1], 'CH-1', 'the ledger row is the named child\'s');
  assert.equal(insert.args.at(-1), 'wall:DEV-WALL');
});

test('a device write is still stamped device:<deviceId>', async () => {
  const { env, statements } = makeEnv(deviceResolver((sql) => (
    sql.startsWith('UPDATE assignments') ? { meta: { changes: 1 } } : {}
  )));
  await call(env, '/api/completions', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { completions: [{ id: 'AS-1', status: 'complete' }] },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(update.args.includes('device:DEV-1'));
});

// ---- §3.2/§8.1: the two pair-code classes are not interchangeable ---------

function pairEnv(codeChildId) {
  return makeEnv((sql) => {
    if (sql.includes('FROM pair_codes WHERE code')) {
      return { first: { code: 'ABCDEFGH', child_id: codeChildId, expires_at: Date.now() + 60000, consumed_at: null, fail_count: 0 } };
    }
    if (sql.includes('SELECT name FROM children')) return { first: { name: 'Ellie' } };
    return {};
  });
}

test('§8.1: a child pair code cannot be redeemed into a household-scoped wall token', async () => {
  const { env, DB } = pairEnv('CH-1');
  const res = await call(env, '/api/wall/pair', { method: 'POST', body: { code: 'ABCDEFGH' } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /for a child device/);
  assert.equal(DB.batched.length, 0, 'nothing is minted and the code is not consumed');
});

test('§8.1: a wall pair code cannot be redeemed as a child device token', async () => {
  const { env, DB } = pairEnv('');
  const res = await call(env, '/api/pair', { method: 'POST', body: { code: 'ABCDEFGH' } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /for a wall display/);
  assert.equal(DB.batched.length, 0);
});

test('§3.2: redeeming a wall code mints one scope=\'wall\' device and returns a token', async () => {
  const { env, DB } = pairEnv('');
  const res = await call(env, '/api/wall/pair', {
    method: 'POST', body: { code: 'ABCDEFGH', label: 'Wall display' },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.ok(out.token, 'the credential is minted at runtime, never a Worker secret');
  assert.equal(out.childId, undefined, 'a wall token names no child');

  const insert = DB.batched[0].find((s) => s.sql.includes('INSERT INTO devices'));
  assert.ok(insert.sql.includes("'wall'"), 'the row carries the scope that restricts it');
  assert.equal(insert.args[1], '', '§8.1\'s sentinel, since devices.child_id is NOT NULL');
  assert.equal(insert.args[2], 'Wall display', 'the label rides the pair request');
});

test('§3.2: a child pairing still mints without naming scope, so it survives a late 0009', async () => {
  const { env, DB } = pairEnv('CH-1');
  const res = await call(env, '/api/pair', { method: 'POST', body: { code: 'ABCDEFGH' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).childId, 'CH-1');
  const insert = DB.batched[0].find((s) => s.sql.includes('INSERT INTO devices'));
  assert.ok(!insert.sql.includes('scope'), 'the column default is what makes it a child token');
});

test('§3.2: minting a wall pair code needs no childId and stores the sentinel', async () => {
  const { env, statements } = makeEnv();
  const res = await call(env, '/api/devices/pair-code', {
    method: 'POST', token: PARENT_TOKEN, body: { scope: 'wall' },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.scope, 'wall');
  const insert = statements.find((s) => s.sql.includes('INSERT INTO pair_codes'));
  assert.equal(insert.args[1], '');
});

test('a child pair code still requires a childId', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/api/devices/pair-code', { method: 'POST', token: PARENT_TOKEN, body: {} });
  assert.equal(res.status, 400);
});

// ---- §8.5: the short URL --------------------------------------------------

test('§8.5: /wall redirects to /wall-app/, alongside /kid', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/wall');
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).pathname, '/wall-app/');
});
