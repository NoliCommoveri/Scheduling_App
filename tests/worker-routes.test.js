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
      sql, args, answer,
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
      // D1 returns one result per statement, in order, each carrying `results`
      // as well as `meta` — which is how a batched SELECT is read back, and
      // what a handler that chunks an `IN (...)` list across several statements
      // depends on. Answered from the same `respond` the statement was
      // recorded with, so a test writes the answer once whether the statement
      // ends up run alone or in a batch.
      return list.map((s) => {
        const answer = (s && s.answer) || {};
        if (answer.throws) throw answer.throws;
        return { success: true, meta: answer.meta || { changes: 1 }, results: answer.results || [] };
      });
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

// §3.5a: a losing claim row is `pending` by construction, so every selector
// here would sweep it up — and a swept row can never be released, because
// release requires `rescinded_at IS NULL`. The guard is the exact negation of
// `isClaimedElsewhere`, which is why it is not a bare `claimed_by IS NULL`.
test('§3.5a: every rescind selector carries the claim guard', async () => {
  const bodies = [
    { batchId: 'B1' },
    { ids: ['A-1', 'A-2'] },
    { childId: 'CH-1', from: '2026-08-01', to: '2026-08-31' },
  ];
  for (const body of bodies) {
    const { env, statements } = makeEnv();
    await call(env, '/api/assignments/rescind', { method: 'POST', token: PARENT_TOKEN, body });
    const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
    assert.ok(
      update.sql.includes('(claimed_by IS NULL OR claimed_by = child_id)'),
      `missing claim guard for ${JSON.stringify(body)}`
    );
  }
});

test('§3.5a: the claim guard survives includeCompleted, so a loser is still spared', async () => {
  // The winner's row carries `claimed_by = child_id` and is deliberately still
  // reachable here — includeCompleted is a parent action about completed work.
  const { env, statements } = makeEnv();
  await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: { batchId: 'B1', includeCompleted: true },
  });
  const update = statements.find((s) => s.sql.startsWith('UPDATE assignments'));
  assert.ok(!update.sql.includes("status = 'pending'"));
  assert.ok(update.sql.includes('(claimed_by IS NULL OR claimed_by = child_id)'));
});

test('§3.5a: the guard binds no parameters — the selector numbering is unmoved', async () => {
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

// The insert batch, addressed by what it contains rather than by position. The
// ownership lookup rides in a batch() of its own now — chunked at D1's
// bound-parameter cap — so DB.batched[0] is the lookup, not the inserts.
function messageInserts(DB) {
  return DB.batched.find((list) => list.some((st) => st.sql.includes('INSERT INTO assignment_messages'))) || [];
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

  const insert = messageInserts(DB)[0];
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
  assert.equal(messageInserts(DB).length, 1, 'only the owned message may be inserted');
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
  assert.equal(messageInserts(DB).length, 1);
});

test('a message body is stored trimmed', async () => {
  const { env, DB } = messageEnv();
  await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { messages: [{ id: 'm1', assignmentId: 'a1', body: '  why?  ' }] },
  });
  assert.ok(messageInserts(DB)[0].args.includes('why?'));
});

test('§11.7: a failed message batch defers rather than dropping the questions', async () => {
  // Fails the insert specifically. The ownership lookup batches too now, so a
  // blanket DB.batchError would trip that first and prove the wrong thing.
  const { env } = messageEnv((sql) => (
    sql.includes('INSERT INTO assignment_messages')
      ? { throws: new Error('D1_ERROR: no such table: assignment_messages') }
      : {}
  ));
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

  // Three batches: the claim_groups insert, the read-back that resolves the
  // id, then the assignment insert. The read-back is a batch because it splits
  // at D1's bound-parameter cap.
  assert.equal(DB.batched.length, 3);
  const groupInserts = DB.batched[0];
  assert.ok(groupInserts[0].sql.includes('INSERT INTO claim_groups'));
  assert.ok(groupInserts[0].sql.includes('ON CONFLICT'));
  assert.ok(DB.batched[1][0].sql.includes('SELECT source_id, date, instance_key, id FROM claim_groups'));

  const insert = DB.batched[2].find((s) => s.sql.includes('INSERT INTO assignments'));
  assert.ok(insert.sql.includes('claim_group'), 'claim_group is in the column list');
  assert.equal(insert.args.at(-2), 'GRP-9', 'bound from the resolved group id');
});

test('§5.3: an unshared chunk never touches claim_groups', async () => {
  const { env, DB } = makeEnv((sql) => (sql.includes('FROM commit_chunks') ? { first: null } : {}));
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B3', chunkIndex: 0, childId: 'CH-1', assignments: [choreRow] },
  });
  assert.equal(DB.batched.length, 1, 'no claim_groups resolution batches when nothing is shared');
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

// ==============================  D1's bound-parameter cap (100 per statement)
//
// The failure these cover, in Ray's words on 2026-08-23: "Commit blocked —
// D1_ERROR: too many SQL variables at offset 481". A chores-only Commit for one
// child over seven days, refused whole, nothing written. Offset 481 is the
// character position of the 101st `?` in the claim_groups read-back, which binds
// three parameters per shared occurrence and so ran out at the 34th.
//
// Nothing bounded what a route *bound*, so every route building an `IN (...)`
// from a caller-supplied array had the same defect waiting. These assert the
// property directly — no statement may bind past the cap — because a test that
// only counted statements would pass against a build that had merely moved the
// list around.

// The number of values a statement binds. `args.length` is the honest count:
// SQLite sizes a bind list by the highest `?n` it sees, and every statement here
// numbers its parameters densely from ?1.
function overCap(statements) {
  return statements.filter((s) => s.args.length > 100);
}

test('a Commit of 40 shared chores splits the claim_groups read-back at the cap', async () => {
  // 34 was the real-world breaking point. 40 is past it and still one Commit a
  // parent would plausibly press.
  const { env, DB, statements } = makeEnv((sql) => {
    if (sql.includes('FROM commit_chunks')) return { first: null };
    return {};
  });
  const shared = Array.from({ length: 40 }, (_, i) => ({
    date: '2026-08-11', kind: 'chore', sourceId: `CHR-${i}`, title: 'Dishes', shared: true,
  }));

  const res = await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B-CAP', chunkIndex: 0, childId: 'CH-1', assignments: shared },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, 40);

  assert.deepEqual(overCap(statements), [], 'no statement may bind past 100 values');
  const readBacks = DB.batched[1];
  assert.equal(readBacks.length, 2, '40 triples at three parameters each is two statements');
  assert.deepEqual(readBacks.map((r) => r.args.length), [99, 21]);
});

test('a Commit of 40 shared chores still resolves every group id', async () => {
  // Splitting the read-back must not lose the rows that came back in the
  // second statement — the failure mode a cap-only assertion would miss.
  const { env, statements } = makeEnv((sql, args) => {
    if (sql.includes('FROM commit_chunks')) return { first: null };
    if (sql.includes('SELECT source_id, date, instance_key, id FROM claim_groups')) {
      // Answer from the triples this statement actually asked about.
      const results = [];
      for (let i = 0; i < args.length; i += 3) {
        results.push({ source_id: args[i], date: args[i + 1], instance_key: args[i + 2], id: `GRP-${args[i]}` });
      }
      return { results };
    }
    return {};
  });
  const shared = Array.from({ length: 40 }, (_, i) => ({
    date: '2026-08-11', kind: 'chore', sourceId: `CHR-${i}`, title: 'Dishes', shared: true,
  }));
  await call(env, '/api/assignments', {
    method: 'POST', token: PARENT_TOKEN,
    body: { batchId: 'B-CAP', chunkIndex: 0, childId: 'CH-1', assignments: shared },
  });

  const inserts = statements.filter((st) => st.sql.includes('INSERT INTO assignments'));
  assert.equal(inserts.length, 40);
  for (const insert of inserts) {
    // claim_group is the second-to-last bound value (§5.3).
    assert.match(String(insert.args.at(-2)), /^GRP-CHR-\d+$/, 'every row carries a resolved group');
  }
});

test('a 250-id rescind splits into statements that each bind under the cap', async () => {
  const { env, statements } = makeEnv(() => ({ meta: { changes: 99 } }));
  const ids = Array.from({ length: 250 }, (_, i) => `a${i}`);
  const res = await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: { ids },
  });
  assert.equal(res.status, 200);

  const updates = statements.filter((s) => s.sql.startsWith('UPDATE assignments'));
  assert.deepEqual(overCap(updates), []);
  assert.deepEqual(updates.map((u) => u.args.length), [100, 100, 53], 'now holds ?1 in each');
  // Every id is asked for exactly once, and none is dropped at a seam.
  assert.deepEqual(updates.flatMap((u) => u.args.slice(1)), ids);
  // The count is summed across the statements, not taken from the last one.
  assert.equal((await res.json()).rescinded, 297);
});

test('a single-selector rescind is still one statement', async () => {
  // The chunking must not turn the common case into a fan-out.
  const { env, statements } = makeEnv();
  await call(env, '/api/assignments/rescind', {
    method: 'POST', token: PARENT_TOKEN, body: { batchId: 'B1' },
  });
  assert.equal(statements.filter((s) => s.sql.startsWith('UPDATE assignments')).length, 1);
});

test('a 250-id mark-read splits at the cap and sums what it changed', async () => {
  const { env, statements } = makeEnv(() => ({ meta: { changes: 10 } }));
  const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
  const res = await call(env, '/api/messages/read', {
    method: 'POST', token: PARENT_TOKEN, body: { ids },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).read, 30, 'three statements at ten rows each');

  const updates = statements.filter((s) => s.sql.startsWith('UPDATE assignment_messages'));
  assert.deepEqual(overCap(updates), []);
  assert.deepEqual(updates.flatMap((u) => u.args.slice(1)), ids);
});

test('a message drain naming 150 assignments splits the ownership lookup', async () => {
  // MAX_BATCH allows 500 messages, so the lookup that guards §6.2 was one long
  // drain away from the same refusal — and a refused lookup defers every
  // question in the batch.
  const ids = Array.from({ length: 150 }, (_, i) => `a${i}`);
  const { env, statements } = makeEnv(deviceResolver((sql, args) => {
    if (sql.includes('SELECT id FROM assignments')) {
      return { results: args.slice(1).map((id) => ({ id })) };
    }
    return {};
  }));

  const res = await call(env, '/api/messages', {
    method: 'POST', token: DEVICE_TOKEN, outboxProtocol: 2,
    body: { messages: ids.map((id, i) => ({ id: `m${i}`, assignmentId: id, body: 'why?' })) },
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.applied, 150, 'every message is owned, so every one is written');
  assert.deepEqual(out.rejected, [], 'a split lookup must not read as unowned');

  const lookups = statements.filter((s) => s.sql.includes('SELECT id FROM assignments'));
  assert.deepEqual(overCap(lookups), []);
  assert.deepEqual(lookups.map((l) => l.args.length), [100, 52]);
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
  // Wall Calendar Redesign §12
  ['/api/wall/slots', 'GET', undefined],
  ['/api/wall/slots', 'PUT', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', startMin: 480 }],
  ['/api/wall/slots', 'DELETE', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1' }],
  ['/api/wall/slots/day', 'PUT', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14', durationMin: 30 }],
  ['/api/wall/slots/day', 'DELETE', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14' }],
  ['/api/wall/events?from=2026-08-01&to=2026-08-14', 'GET', undefined],
  // Wall Calendar Redesign §5.5, §12 (Phase 7)
  ['/api/wall/school-blocks', 'GET', undefined],
  ['/api/wall/school-blocks', 'POST', { childId: 'CH-1', startMin: 480, durationMin: 60 }],
  ['/api/wall/school-blocks/BLOCK-1', 'PUT', { startMin: 540 }],
  ['/api/wall/school-blocks/BLOCK-1', 'DELETE', undefined],
  ['/api/wall/school-blocks/BLOCK-1/courses', 'PUT', { courseName: 'Math' }],
  ['/api/wall/school-blocks/BLOCK-1/courses', 'DELETE', { courseName: 'Math' }],
  // Placement Scopes §4.2, §8 test 9 (Phase 2)
  ['/api/wall/slots/weekday', 'PUT', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 480 }],
  ['/api/wall/slots/weekday', 'DELETE', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5 }],
  ['/api/wall/school-blocks/BLOCK-1/weekdays', 'PUT', { weekday: 1 }],
  ['/api/wall/school-blocks/BLOCK-1/weekdays', 'DELETE', { weekday: 1 }],
  ['/api/wall/school-blocks/BLOCK-1/dates', 'PUT', { date: '2026-08-24', occurs: 0 }],
  ['/api/wall/school-blocks/BLOCK-1/dates', 'DELETE', { date: '2026-08-24' }],
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

// ================================  Wall Calendar Redesign §12 (Phase 1a)
//
// Placements live in `wall_slots` / `wall_slot_days`, tables outside the
// child-scoping scheme entirely — so these routes use `resolveSlotChildId`,
// not `withWallChild`, and the one thing worth checking that the ordinary
// wall routes above don't need to is the sentinel `childId` rule (§12): ''
// is accepted only on a chore placement.

test('§12/§14.11a: the sentinel childId is accepted on a chore placement and stores one row', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: '', subjectKind: 'chore', subjectKey: 'CHORE-1', startMin: 240 },
  });
  assert.equal(res.status, 200);
  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_slots'));
  assert.ok(insert, 'a household placement is stored');
  assert.equal(insert.args[0], '', 'child_id is the sentinel, not a real id');
});

test('§20/§12: subjectKind "school" is no longer valid on wall_slots — school blocks live in their own tables', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: '', subjectKind: 'school', subjectKey: 'Algebra', startMin: 480 },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /subjectKind must be one of chore/);
  assert.equal(statements.filter((s) => s.sql.includes('wall_slots')).length, 0, 'nothing is written');
});

test('§12/§14.11a: a GET never expands the sentinel row per active child', async () => {
  const { env } = makeEnv(wallResolver((sql) => (
    sql.startsWith('SELECT * FROM wall_slots')
      ? { results: [{ child_id: '', subject_kind: 'chore', subject_key: 'CHORE-1', instance_key: '', start_min: 240, duration_min: null }] }
      : {}
  )));
  const res = await call(env, '/api/wall/slots', { token: WALL_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.slots.length, 1, 'the sentinel is one row, not fanned out across the roster');
  assert.equal(out.slots[0].child_id, '');
});

test('§14.11: an archived or unknown childId writes no placement (PUT or DELETE, either slots route)', async () => {
  const cases = [
    ['/api/wall/slots', 'PUT', { subjectKind: 'chore', subjectKey: 'CHORE-1', startMin: 240 }],
    ['/api/wall/slots', 'DELETE', { subjectKind: 'chore', subjectKey: 'CHORE-1' }],
    ['/api/wall/slots/day', 'PUT', { subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14', durationMin: 30 }],
    ['/api/wall/slots/day', 'DELETE', { subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14' }],
  ];
  for (const [path, method, rest] of cases) {
    for (const childId of ['CH-ARCHIVED', 'CH-NOT-A-CHILD']) {
      const { env, statements } = makeEnv(wallResolver());
      const res = await call(env, path, { method, token: WALL_TOKEN, body: { childId, ...rest } });
      assert.equal(res.status, 400, `${method} ${path} with ${childId}`);
      assert.equal(
        statements.filter((s) => s.sql.includes('wall_slot')).length, 0,
        `${method} ${path} must write nothing for ${childId}`
      );
    }
  }
});

test('§14.11: startMin and durationMin are bound to the 15-minute grid', async () => {
  const cases = [
    { body: { startMin: 1 }, error: /startMin/ },
    { body: { startMin: -15 }, error: /startMin/ },
    { body: { startMin: 1440 }, error: /startMin/ },
    { body: { startMin: 480, durationMin: 10 }, error: /durationMin/ },
    { body: { startMin: 1425, durationMin: 30 }, error: /midnight/ },
  ];
  for (const { body, error } of cases) {
    const { env } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/slots', {
      method: 'PUT', token: WALL_TOKEN,
      body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', ...body },
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, error);
  }
});

test('Placement Scopes §11.6: un-placing deletes the standing row and NOTHING else', async () => {
  // This reverses what this test asserted before Phase 2, deliberately. The
  // old sweep of `wall_slot_days` had no honest undo — the tray gesture is
  // this route's only caller and its Undo restores the standing row alone —
  // and §3.4's alternative trigger does not exist on the chore side, since the
  // wall is never told a chore was deleted. Ray's answer (2026-08-23): un-
  // placing is standing-scoped, and the override levels are left inert
  // beneath it, exactly as a `wall_slot_days` row already is with no
  // placement above it.
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots', {
    method: 'DELETE', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1' },
  });
  assert.equal(res.status, 200);
  assert.ok(statements.some((s) => s.sql.startsWith('DELETE FROM wall_slots ')), 'the placement is removed');
  assert.equal(
    statements.filter((s) => s.sql.startsWith('DELETE FROM wall_slot_days')).length, 0,
    'a per-date override survives, and comes back if the chore is placed again'
  );
  assert.equal(
    statements.filter((s) => s.sql.startsWith('DELETE FROM wall_slot_weekdays')).length, 0,
    'so does a weekday one — clearing a level is its own explicit route'
  );
});

test('Placement Scopes §4.1: a wall_slot_days write that overrides nothing is a 400', async () => {
  // Was "durationMin may never be null". §4.1 generalizes rather than relaxes
  // it: either column may be null now that `start_min` exists (0016), but not
  // both, because DELETE is how an override goes away.
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots/day', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14', durationMin: null },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /startMin or durationMin/);
  assert.equal(statements.filter((s) => s.sql.includes('wall_slot_days')).length, 0);
});

test('Placement Scopes §4.2: a date override may move a chore without re-timing it', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots/day', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-14', startMin: 900 },
  });
  assert.equal(res.status, 200);
  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_slot_days'));
  assert.ok(insert.sql.includes('start_min'), '0016\'s column is written, not ignored');
  assert.equal(insert.args[5], 900);
  assert.equal(insert.args[6], null, 'the level\'s own duration is null, not the resolved one (§4.1)');
});

test('§12: GET /api/wall/slots bounds wall_slot_days to the window but returns every placement', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => {
    if (sql.startsWith('SELECT * FROM wall_slots')) return { results: [{ child_id: 'CH-1' }] };
    if (sql.startsWith('SELECT * FROM wall_slot_days')) return { results: [{ child_id: 'CH-1', date: '2026-08-14' }] };
    return {};
  }));
  const res = await call(env, '/api/wall/slots?from=2026-08-14&to=2026-08-14', { token: WALL_TOKEN });
  const out = await res.json();
  assert.equal(out.slots.length, 1);
  assert.equal(out.days.length, 1);
  const daysQuery = statements.find((s) => s.sql.startsWith('SELECT * FROM wall_slot_days'));
  assert.ok(daysQuery.sql.includes('WHERE date >= ?1 AND date <= ?2'));
  assert.deepEqual(daysQuery.args, ['2026-08-14', '2026-08-14']);
});

test('§7.2/§14.11: /api/wall/events refuses a window over 62 days', async () => {
  const { env } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/events?from=2026-01-01&to=2026-04-01', { token: WALL_TOKEN });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /62/);
});

test('§7.2: the events query joins active children and dedupes by source and date', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/events?from=2026-08-01&to=2026-10-01', { token: WALL_TOKEN });
  assert.equal(res.status, 200, 'exactly 62 days is the boundary, not the refusal');
  const query = statements.find((s) => s.sql.includes('FROM assignments a'));
  assert.ok(query.sql.includes('JOIN children c ON c.id = a.child_id AND c.active = 1'));
  assert.ok(query.sql.includes("a.kind = 'event'"));
  assert.ok(query.sql.includes('GROUP BY COALESCE(a.source_id, a.id), a.date'));
});

test('§14.15: no wall route ever touches expected_duration_min', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('UPDATE assignments') ? { meta: { changes: 1 } } : {}
  )));
  await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', status: 'complete' }] },
  });
  await call(env, '/api/wall/slots', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', startMin: 240, durationMin: 45 },
  });
  assert.ok(
    !statements.some((s) => s.sql.includes('expected_duration_min')),
    'the wall adjusts a duration in a table it owns, never the parent-owned column'
  );
});

test('§14.15: a durationMin sent to /api/wall/completions is rejected like any unknown key', async () => {
  const { env } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', durationMin: 45 }] },
  });
  const out = await res.json();
  assert.match(out.rejected[0].error, /Not a child-writable column: durationMin/);
});

// ================================  Wall Calendar Redesign §5.5, §12 (Phase 7)
//
// School blocks live in wall_school_blocks/wall_school_block_courses,
// touched by NO `assignments` access — so, like the slots routes above,
// these use a direct active-child check (resolveActiveChildId) rather than
// withWallChild. Unlike a chore placement's PUT, there is no sentinel here:
// a block is always one child's (§12's table).

test('§12: POST /api/wall/school-blocks mints an id and stores the span', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN,
    body: { childId: 'CH-1', startMin: 540, durationMin: 90, label: 'Morning School' },
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(typeof out.id, 'string');
  assert.ok(out.id.length > 0);

  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_school_blocks'));
  assert.ok(insert, 'the block is stored');
  assert.equal(insert.args[1], 'CH-1');
  assert.equal(insert.args[2], 'Morning School');
  assert.equal(insert.args[3], 540, 'start_min');
  assert.equal(insert.args[4], 630, 'end_min = startMin + durationMin');
  assert.ok(insert.args.includes('wall:DEV-WALL'), 'provenance matches every other wall write');
});

test('§12: POST /api/wall/school-blocks refuses the sentinel childId — a block is always one child\'s', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN,
    body: { childId: '', startMin: 540, durationMin: 60 },
  });
  assert.equal(res.status, 400);
  assert.equal(statements.filter((s) => s.sql.includes('wall_school_blocks')).length, 0);
});

test('§12: POST /api/wall/school-blocks refuses an archived or unknown childId', async () => {
  for (const childId of ['CH-ARCHIVED', 'CH-NOT-A-CHILD']) {
    const { env, statements } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/school-blocks', {
      method: 'POST', token: WALL_TOKEN, body: { childId, startMin: 540, durationMin: 60 },
    });
    assert.equal(res.status, 400, childId);
    assert.equal(statements.filter((s) => s.sql.includes('wall_school_blocks')).length, 0);
  }
});

test('§12: POST /api/wall/school-blocks validates span and label', async () => {
  const cases = [
    { body: { startMin: 1 }, error: /startMin/ },
    { body: { startMin: 540, durationMin: 10 }, error: /durationMin/ },
    { body: { startMin: 540, durationMin: null }, error: /durationMin/ }, // unlike a chore, never null
    { body: { startMin: 1425, durationMin: 30 }, error: /midnight/ },
    { body: { startMin: 540, durationMin: 60, label: 'x'.repeat(61) }, error: /label/ },
  ];
  for (const { body, error } of cases) {
    const { env } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/school-blocks', {
      method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', ...body },
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, error);
  }
});

function schoolBlockResolver(existing, extra = () => ({})) {
  return wallResolver((sql, args) => {
    if (sql.startsWith('SELECT * FROM wall_school_blocks WHERE id')) {
      return { first: args[0] === existing.id ? existing : null };
    }
    return extra(sql, args);
  });
}

test('§5.4/§12: PUT /api/wall/school-blocks/:id moves/resizes/relabels — only the given fields change', async () => {
  const existing = { id: 'BLOCK-1', child_id: 'CH-1', label: 'School', start_min: 540, end_min: 600 };
  const { env, statements } = makeEnv(schoolBlockResolver(existing, (sql) => (
    sql.startsWith('UPDATE wall_school_blocks') ? { meta: { changes: 1 } } : {}
  )));
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1', {
    method: 'PUT', token: WALL_TOKEN, body: { startMin: 600 },
  });
  assert.equal(res.status, 200);
  const update = statements.find((s) => s.sql.startsWith('UPDATE wall_school_blocks'));
  assert.equal(update.args[0], 600, 'start_min moved');
  assert.equal(update.args[1], 660, 'end_min preserves the existing 60-minute duration');
  assert.equal(update.args[2], 'School', 'label untouched');
});

test('§5.4/§12: PUT /api/wall/school-blocks/:id on an unknown id is 404', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('SELECT * FROM wall_school_blocks WHERE id') ? { first: null } : {}
  )));
  const res = await call(env, '/api/wall/school-blocks/NOPE', {
    method: 'PUT', token: WALL_TOKEN, body: { startMin: 600 },
  });
  assert.equal(res.status, 404);
  assert.equal(statements.filter((s) => s.sql.startsWith('UPDATE wall_school_blocks')).length, 0);
});

test('§5.4/§12: PUT /api/wall/school-blocks/:id label may be cleared back to null ("School")', async () => {
  const existing = { id: 'BLOCK-1', child_id: 'CH-1', label: 'Morning School', start_min: 540, end_min: 600 };
  const { env, statements } = makeEnv(schoolBlockResolver(existing, (sql) => (
    sql.startsWith('UPDATE wall_school_blocks') ? { meta: { changes: 1 } } : {}
  )));
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1', {
    method: 'PUT', token: WALL_TOKEN, body: { label: null },
  });
  assert.equal(res.status, 200);
  const update = statements.find((s) => s.sql.startsWith('UPDATE wall_school_blocks'));
  assert.equal(update.args[2], null);
});

test('§5.4/§12: DELETE /api/wall/school-blocks/:id cascades to its membership rows', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1', { method: 'DELETE', token: WALL_TOKEN });
  assert.equal(res.status, 200);
  assert.ok(statements.some((s) => s.sql.startsWith('DELETE FROM wall_school_blocks WHERE id')));
  assert.ok(statements.some((s) => s.sql.startsWith('DELETE FROM wall_school_block_courses WHERE block_id')));
  // Placement Scopes §3.4 — the half of the cleanup that survived §11.6.
  // Unlike a chore, a deleted block really is the subject disappearing: no UI
  // can reach these rows again and no new block can inherit them, since a new
  // block gets a newly minted id.
  assert.ok(statements.some((s) => s.sql.startsWith('DELETE FROM wall_school_block_weekdays WHERE block_id')));
  assert.ok(statements.some((s) => s.sql.startsWith('DELETE FROM wall_school_block_dates WHERE block_id')));
});

test('§5.2/§12: PUT .../courses adds a member, idempotently', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('SELECT id FROM wall_school_blocks WHERE id') ? { first: { id: 'BLOCK-1' } } : {}
  )));
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1/courses', {
    method: 'PUT', token: WALL_TOKEN, body: { courseName: 'Math' },
  });
  assert.equal(res.status, 200);
  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_school_block_courses'));
  assert.ok(insert.sql.includes('DO NOTHING'), 're-adding an existing member is a no-op, not an error');
  assert.deepEqual(insert.args, ['BLOCK-1', 'Math']);
});

test('§5.2/§12: PUT .../courses on an unknown block is 404', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => (
    sql.startsWith('SELECT id FROM wall_school_blocks WHERE id') ? { first: null } : {}
  )));
  const res = await call(env, '/api/wall/school-blocks/NOPE/courses', {
    method: 'PUT', token: WALL_TOKEN, body: { courseName: 'Math' },
  });
  assert.equal(res.status, 404);
  assert.equal(statements.filter((s) => s.sql.includes('INSERT INTO wall_school_block_courses')).length, 0);
});

test('§5.2/§12: PUT .../courses rejects a missing or oversized courseName', async () => {
  for (const courseName of [undefined, '', 'x'.repeat(201)]) {
    const { env } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/school-blocks/BLOCK-1/courses', {
      method: 'PUT', token: WALL_TOKEN, body: { courseName },
    });
    assert.equal(res.status, 400, JSON.stringify(courseName));
  }
});

test('§5.2/§12: DELETE .../courses removes only the membership row, never an activity row', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1/courses', {
    method: 'DELETE', token: WALL_TOKEN, body: { courseName: 'Math' },
  });
  assert.equal(res.status, 200);
  const del = statements.find((s) => s.sql.startsWith('DELETE FROM wall_school_block_courses'));
  assert.deepEqual(del.args, ['BLOCK-1', 'Math']);
  assert.equal(statements.filter((s) => s.sql.includes('assignments')).length, 0);
});

test('§12: GET /api/wall/school-blocks returns both tables, household-wide', async () => {
  const { env } = makeEnv(wallResolver((sql) => {
    if (sql.startsWith('SELECT * FROM wall_school_blocks')) {
      return { results: [{ id: 'BLOCK-1', child_id: 'CH-1', start_min: 540, end_min: 600 }] };
    }
    if (sql.startsWith('SELECT * FROM wall_school_block_courses')) {
      return { results: [{ block_id: 'BLOCK-1', course_name: 'Math' }] };
    }
    return {};
  }));
  const res = await call(env, '/api/wall/school-blocks', { token: WALL_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blockCourses.length, 1);
});

test('Placement Scopes §4.2: GET /api/wall/school-blocks returns the schedule and its exceptions too', async () => {
  const { env } = makeEnv(wallResolver((sql) => {
    if (sql.startsWith('SELECT * FROM wall_school_block_weekdays')) {
      return { results: [{ block_id: 'BLOCK-1', weekday: 1, start_min: null, end_min: null }] };
    }
    if (sql.startsWith('SELECT * FROM wall_school_block_dates')) {
      return { results: [{ block_id: 'BLOCK-1', date: '2026-08-24', occurs: 0, start_min: null, end_min: null }] };
    }
    return {};
  }));
  const res = await call(env, '/api/wall/school-blocks', { token: WALL_TOKEN });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.blockWeekdays.length, 1, 'without this array nothing can decide which days a block happens on');
  assert.equal(out.blockDates.length, 1);
  assert.equal(out.blockDates[0].occurs, 0);
});

test('§14.15: no school-block route ever touches expected_duration_min or an activity row', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => {
    if (sql.startsWith('SELECT * FROM wall_school_blocks WHERE id')) {
      return { first: { id: 'BLOCK-1', child_id: 'CH-1', label: null, start_min: 540, end_min: 600 } };
    }
    if (sql.startsWith('UPDATE wall_school_blocks')) return { meta: { changes: 1 } };
    return {};
  }));
  await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', startMin: 540, durationMin: 60 },
  });
  const putRes = await call(env, '/api/wall/school-blocks/BLOCK-1', {
    method: 'PUT', token: WALL_TOKEN, body: { durationMin: 90 },
  });
  assert.equal(putRes.status, 200);
  assert.ok(
    !statements.some((s) => s.sql.includes('expected_duration_min') || s.sql.includes('UPDATE assignments')),
    'the wall authors a block\'s span directly (§20) — it never touches the parent-owned column, and a ' +
    'block is not an assignment row at all'
  );
});

// ============================  Placement Scopes §4.2, §8 test 9 (Phase 2)
//
// The credential matrix for these six routes is covered by WALL_ROUTES above
// (a device token and a parent token are both 401 on every one of them). What
// is left is what each route decides for itself: the child gate on the chore
// side, the block gate on the block side, and the validation rules that only
// exist because a level may say nothing.

test('§4.2: a weekday override stores the level\'s own values under the chore\'s key', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots/weekday', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 900 },
  });
  assert.equal(res.status, 200);
  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_slot_weekdays'));
  assert.deepEqual(insert.args.slice(0, 6), ['CH-1', 'chore', 'CHORE-1', '', 5, 900]);
  assert.equal(insert.args[6], null, 'duration is the level\'s own null, not the resolved number (§4.1)');
  assert.equal(insert.args.at(-1), 'wall:DEV-WALL', 'provenance matches every other wall write');
});

test('§4.2: the weekday routes take the sentinel childId, like every other chore placement', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots/weekday', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: '', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 900 },
  });
  assert.equal(res.status, 200);
  assert.equal(statements.find((s) => s.sql.includes('INSERT INTO wall_slot_weekdays')).args[0], '');
});

test('§8 test 9: the weekday routes reject an archived or unknown childId', async () => {
  for (const method of ['PUT', 'DELETE']) {
    for (const childId of ['CH-ARCHIVED', 'CH-NOT-A-CHILD']) {
      const { env, statements } = makeEnv(wallResolver());
      const res = await call(env, '/api/wall/slots/weekday', {
        method, token: WALL_TOKEN,
        body: { childId, subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 900 },
      });
      assert.equal(res.status, 400, `${method} with ${childId}`);
      assert.equal(
        statements.filter((s) => s.sql.includes('wall_slot_weekdays')).length, 0,
        `${method} must write nothing for ${childId}`
      );
    }
  }
});

test('§8 test 9: a weekday PUT with both fields null is a 400', async () => {
  for (const body of [{}, { startMin: null, durationMin: null }]) {
    const { env, statements } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/slots/weekday', {
      method: 'PUT', token: WALL_TOKEN,
      body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, ...body },
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /startMin or durationMin/);
    assert.equal(statements.filter((s) => s.sql.includes('wall_slot_weekdays')).length, 0);
  }
});

test('§2.3/§4.3: the weekday is bounded 0-6 and never derived server-side', async () => {
  for (const weekday of [7, -1, '1', 1.5, undefined, null]) {
    const { env, statements } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/slots/weekday', {
      method: 'PUT', token: WALL_TOKEN,
      body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday, startMin: 900 },
    });
    assert.equal(res.status, 400, JSON.stringify(weekday));
    assert.equal(statements.filter((s) => s.sql.includes('wall_slot_weekdays')).length, 0);
  }
  // No Date() anywhere in the path: a UTC-parsed "YYYY-MM-DD" is the previous
  // day in this household's timezone, so the client owns the conversion.
  const { env, statements } = makeEnv(wallResolver());
  await call(env, '/api/wall/slots/weekday', {
    method: 'PUT', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 900, date: '2026-08-23' },
  });
  assert.equal(statements.find((s) => s.sql.includes('INSERT INTO wall_slot_weekdays')).args[4], 5);
});

test('§2.1/§11.3: clearing a weekday override deletes one row and unplaces nothing', async () => {
  const { env, statements } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/slots/weekday', {
    method: 'DELETE', token: WALL_TOKEN,
    body: { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5 },
  });
  assert.equal(res.status, 200);
  const del = statements.find((s) => s.sql.startsWith('DELETE FROM wall_slot_weekdays'));
  assert.deepEqual(del.args, ['CH-1', 'chore', 'CHORE-1', '', 5]);
  assert.equal(
    statements.filter((s) => s.sql.includes('wall_slots ')).length, 0,
    'the weekday level answers when, never whether — the standing placement is untouched'
  );
});

// ---- the block side: the weekday list IS the schedule -------------------

test('§2.2/§4.2: scheduling a block on a weekday writes a row with no span of its own', async () => {
  const { env, statements } = makeEnv(blockExistsResolver());
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1/weekdays', {
    method: 'PUT', token: WALL_TOKEN, body: { weekday: 1 },
  });
  assert.equal(res.status, 200);
  const insert = statements.find((s) => s.sql.includes('INSERT INTO wall_school_block_weekdays'));
  assert.deepEqual(insert.args, ['BLOCK-1', 1, null, null], 'NULL span = the block\'s own (§2.2)');
});

test('§2.2: a block\'s span is both-or-neither at the weekday level', async () => {
  const cases = [
    { startMin: 540 },
    { endMin: 600 },
    { startMin: 600, endMin: 540 },
    { startMin: 600, endMin: 600 },
    { startMin: 7, endMin: 600 },
  ];
  for (const span of cases) {
    const { env, statements } = makeEnv(blockExistsResolver());
    const res = await call(env, '/api/wall/school-blocks/BLOCK-1/weekdays', {
      method: 'PUT', token: WALL_TOKEN, body: { weekday: 1, ...span },
    });
    assert.equal(res.status, 400, JSON.stringify(span));
    assert.equal(statements.filter((s) => s.sql.includes('wall_school_block_weekdays')).length, 0);
  }
  // 1440 is allowed: end_min is an END, so it may name the close of the day.
  const { env, statements } = makeEnv(blockExistsResolver());
  const ok = await call(env, '/api/wall/school-blocks/BLOCK-1/weekdays', {
    method: 'PUT', token: WALL_TOKEN, body: { weekday: 1, startMin: 1380, endMin: 1440 },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(statements.find((s) => s.sql.includes('INSERT INTO wall_school_block_weekdays')).args, ['BLOCK-1', 1, 1380, 1440]);
});

test('§4.2: a weekday or date PUT on an unknown block is 404, and writes nothing', async () => {
  for (const [path, body] of [
    ['/api/wall/school-blocks/NOPE/weekdays', { weekday: 1 }],
    ['/api/wall/school-blocks/NOPE/dates', { date: '2026-08-24', occurs: 0 }],
  ]) {
    const { env, statements } = makeEnv(wallResolver((sql) => (
      sql.startsWith('SELECT id FROM wall_school_blocks WHERE id') ? { first: null } : {}
    )));
    const res = await call(env, path, { method: 'PUT', token: WALL_TOKEN, body });
    assert.equal(res.status, 404, path);
    assert.equal(statements.filter((s) => s.sql.startsWith('INSERT INTO wall_school_block')).length, 0);
  }
});

test('§0.1/§4.2: unscheduling a weekday is what takes a block off Saturday', async () => {
  const { env, statements } = makeEnv(blockExistsResolver());
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1/weekdays', {
    method: 'DELETE', token: WALL_TOKEN, body: { weekday: 6 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(statements.find((s) => s.sql.startsWith('DELETE FROM wall_school_block_weekdays')).args, ['BLOCK-1', 6]);
});

test('§2.2.1: a date row decides its own date in both directions', async () => {
  // occurs 0 — a scheduled Monday that does not happen.
  const { env: skipEnv, statements: skipStmts } = makeEnv(blockExistsResolver());
  const skip = await call(skipEnv, '/api/wall/school-blocks/BLOCK-1/dates', {
    method: 'PUT', token: WALL_TOKEN, body: { date: '2026-08-24', occurs: 0 },
  });
  assert.equal(skip.status, 200);
  assert.deepEqual(
    skipStmts.find((s) => s.sql.includes('INSERT INTO wall_school_block_dates')).args,
    ['BLOCK-1', '2026-08-24', 0, null, null]
  );

  // occurs 1 on an unscheduled Sunday — Ray's backup school day, taking the
  // block's own span because there is no weekday row to read.
  const { env: addEnv, statements: addStmts } = makeEnv(blockExistsResolver());
  const add = await call(addEnv, '/api/wall/school-blocks/BLOCK-1/dates', {
    method: 'PUT', token: WALL_TOKEN, body: { date: '2026-08-23', occurs: 1 },
  });
  assert.equal(add.status, 200);
  assert.deepEqual(
    addStmts.find((s) => s.sql.includes('INSERT INTO wall_school_block_dates')).args,
    ['BLOCK-1', '2026-08-23', 1, null, null]
  );
});

test('§2.2.1: a skipped date may not carry a span, and occurs is checked strictly', async () => {
  const cases = [
    { occurs: 0, startMin: 540, endMin: 600 },  // a skipped day has no time
    { occurs: '0' },                            // a string is a client bug, not a skip
    { occurs: false },
    { occurs: 2 },
    { occurs: undefined },                      // the column's DEFAULT 1 is not a licence to omit it
    { occurs: null },
  ];
  for (const body of cases) {
    const { env, statements } = makeEnv(blockExistsResolver());
    const res = await call(env, '/api/wall/school-blocks/BLOCK-1/dates', {
      method: 'PUT', token: WALL_TOKEN, body: { date: '2026-08-24', ...body },
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(statements.filter((s) => s.sql.includes('wall_school_block_dates')).length, 0);
  }
});

test('§4.2: clearing a date exception lets the weekday rule decide again', async () => {
  const { env, statements } = makeEnv(blockExistsResolver());
  const res = await call(env, '/api/wall/school-blocks/BLOCK-1/dates', {
    method: 'DELETE', token: WALL_TOKEN, body: { date: 'not-a-date' },
  });
  assert.equal(res.status, 400, 'the date is validated even on the delete path');
  assert.equal(statements.filter((s) => s.sql.includes('wall_school_block_dates')).length, 0);

  const { env: okEnv, statements: okStmts } = makeEnv(blockExistsResolver());
  const ok = await call(okEnv, '/api/wall/school-blocks/BLOCK-1/dates', {
    method: 'DELETE', token: WALL_TOKEN, body: { date: '2026-08-24' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(okStmts.find((s) => s.sql.startsWith('DELETE FROM wall_school_block_dates')).args, ['BLOCK-1', '2026-08-24']);
});

// ---- §6.4: creating a block schedules it, in one batch --------------------

test('§4.2/§6.4: a POST that names no weekdays still gets a Mon-Fri schedule', async () => {
  const { env, DB } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', startMin: 540, durationMin: 60 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).weekdays, [1, 2, 3, 4, 5]);
  // The default is applied HERE, server-side, which is what lets a Phase 3
  // client that knows nothing of weekdays create a visible block (§9).
  assert.equal(DB.batched.length, 1, 'the block and its schedule are one batch, not six writes');
  assert.equal(DB.batched[0].length, 6, 'the block row plus five weekday rows');
});

test('§4.2: a POST may name its own weekdays, deduped and sorted', async () => {
  const { env, DB } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN,
    body: { childId: 'CH-1', startMin: 540, durationMin: 60, weekdays: [3, 1, 3] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).weekdays, [1, 3]);
  assert.equal(DB.batched[0].length, 3);
});

test('§4.2: a malformed weekdays list is a 400, not a silent Mon-Fri', async () => {
  for (const weekdays of [[7], ['1'], [1, 1.5], 'weekdays', 5]) {
    const { env, DB } = makeEnv(wallResolver());
    const res = await call(env, '/api/wall/school-blocks', {
      method: 'POST', token: WALL_TOKEN,
      body: { childId: 'CH-1', startMin: 540, durationMin: 60, weekdays },
    });
    assert.equal(res.status, 400, JSON.stringify(weekdays));
    assert.equal(DB.batched.length, 0, 'no block is minted for a body the client got wrong');
  }
});

test('§4.2: an empty weekdays array is an older client, not a request for no schedule', async () => {
  // A block with no weekday rows renders on no day at all (§2.2), so treating
  // [] as "schedule nothing" would mint §6.4's invisible block.
  const { env, DB } = makeEnv(wallResolver());
  const res = await call(env, '/api/wall/school-blocks', {
    method: 'POST', token: WALL_TOKEN,
    body: { childId: 'CH-1', startMin: 540, durationMin: 60, weekdays: [] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).weekdays, [1, 2, 3, 4, 5]);
  assert.equal(DB.batched[0].length, 6);
});

test('§4.2: no placement-scope route touches an assignments column', async () => {
  const calls = [
    ['/api/wall/slots/weekday', 'PUT', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5, startMin: 900 }],
    ['/api/wall/slots/weekday', 'DELETE', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', weekday: 5 }],
    ['/api/wall/slots/day', 'PUT', { childId: 'CH-1', subjectKind: 'chore', subjectKey: 'CHORE-1', date: '2026-08-24', startMin: 900 }],
    ['/api/wall/school-blocks/BLOCK-1/weekdays', 'PUT', { weekday: 1 }],
    ['/api/wall/school-blocks/BLOCK-1/weekdays', 'DELETE', { weekday: 1 }],
    ['/api/wall/school-blocks/BLOCK-1/dates', 'PUT', { date: '2026-08-24', occurs: 0 }],
    ['/api/wall/school-blocks/BLOCK-1/dates', 'DELETE', { date: '2026-08-24' }],
  ];
  for (const [path, method, body] of calls) {
    const { env, statements } = makeEnv(blockExistsResolver());
    const res = await call(env, path, { method, token: WALL_TOKEN, body });
    assert.equal(res.status, 200, `${method} ${path}`);
    assert.ok(
      !statements.some((s) => s.sql.includes('assignments') || s.sql.includes('expected_duration_min')),
      `${method} ${path} must widen nothing on assignments (CLAUDE.md §0, §I.A)`
    );
  }
});

function blockExistsResolver(extra = () => ({})) {
  return wallResolver((sql, args) => (
    sql.startsWith('SELECT id FROM wall_school_blocks WHERE id') ? { first: { id: args[0] } } : extra(sql, args)
  ));
}

// ---- §8.3.1: the claim route can now carry the completion sheet's time ----

function claimWonResolver(extra = () => ({})) {
  return wallResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 2 } };
    if (sql.startsWith('SELECT * FROM assignments WHERE id')) return { first: { id: 'AS-1' } };
    return extra(sql);
  });
}

test('§8.3.1: a completedAt in the claim body lands on the row', async () => {
  const past = Date.now() - 60_000;
  const { env, statements } = makeEnv(claimWonResolver());
  const res = await call(env, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', completedAt: past },
  });
  assert.equal(res.status, 200);
  const complete = statements.find((s) => s.sql.includes("SET status = 'complete'"));
  assert.equal(complete.args[0], past, "the sheet's time, not the route's own clock");
});

test('§8.3.1: an absent completedAt still falls back to now, unchanged for existing Child App calls', async () => {
  const before = Date.now();
  const { env, statements } = makeEnv(claimWonResolver());
  const res = await call(env, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1' },
  });
  assert.equal(res.status, 200);
  const complete = statements.find((s) => s.sql.includes("SET status = 'complete'"));
  assert.ok(complete.args[0] >= before, "falls back to the route's own clock");
});

test('§8.3.1: a future completedAt is refused server-side, on the claim route and on completions alike', async () => {
  const future = Date.now() + 60_000;

  const { env: claimEnv } = makeEnv(claimWonResolver());
  const claimRes = await call(claimEnv, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', completedAt: future },
  });
  assert.equal(claimRes.status, 400);
  assert.match((await claimRes.json()).error, /future/);

  const { env: completeEnv } = makeEnv(wallResolver());
  const completeRes = await call(completeEnv, '/api/wall/completions', {
    method: 'POST', token: WALL_TOKEN, outboxProtocol: 2,
    body: { childId: 'CH-1', completions: [{ id: 'AS-1', status: 'complete', completedAt: future }] },
  });
  const out = await completeRes.json();
  assert.match(out.rejected[0].error, /future/);
});

test('§8.3.1: a losing claim writes no completed_at at all', async () => {
  const { env, statements } = makeEnv(wallResolver((sql) => {
    if (sql.includes('SELECT claim_group, rescinded_at FROM assignments')) {
      return { first: { claim_group: 'GRP-1', rescinded_at: null } };
    }
    if (sql.includes('SET claimed_by = ?1, claimed_at = ?2')) return { meta: { changes: 0 } };
    if (sql.includes('SELECT claimed_by FROM assignments')) return { first: { claimed_by: 'CH-2' } };
    return {};
  }));
  const res = await call(env, '/api/wall/assignments/AS-1/claim', {
    method: 'POST', token: WALL_TOKEN, body: { childId: 'CH-1', completedAt: Date.now() },
  });
  assert.equal((await res.json()).claimed, false);
  assert.ok(!statements.some((s) => s.sql.includes("SET status = 'complete'")));
});

// ---- §8.5: the short URL --------------------------------------------------

test('§8.5: /wall redirects to /wall-app/, alongside /kid', async () => {
  const { env } = makeEnv();
  const res = await call(env, '/wall');
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).pathname, '/wall-app/');
});

// ==========================  reassignable (TDS_Slice_Rescind_Regeneration.md)
//
// The route that tells Propose which school work was pulled back and never
// re-assigned (§4). What the fake can check is the Worker's decisions: who gets
// in, what it refuses to answer without, and what the statement asks for. The
// three-case truth of §2.1 — rescinded-only returns, re-assigned does not,
// re-assigned-and-completed does not — is `SUM(...) = 0` over real rows, which
// this harness does not execute; it is §7.1's manual checks.

test('§4: reassignable is parent-only — a device token and a wall token are both 401', async () => {
  for (const token of [DEVICE_TOKEN, WALL_TOKEN]) {
    const { env, statements } = makeEnv(wallResolver());
    const res = await call(env, '/api/assignments/reassignable?childId=CH-1', { token });
    assert.equal(res.status, 401, 'only the parent token may read the whole history');
    assert.ok(!statements.some((s) => s.sql.includes('FROM assignments')));
  }
});

test('§4: reassignable without a childId is 400 and reads nothing', async () => {
  const { env, statements } = makeEnv();
  const res = await call(env, '/api/assignments/reassignable', { token: PARENT_TOKEN });
  assert.equal(res.status, 400);
  assert.ok(!statements.some((s) => s.sql.includes('FROM assignments')));
});

test('§4: reassignable asks for one child\'s activities with no live row', async () => {
  const { env, statements } = makeEnv((sql) =>
    (sql.includes('HAVING SUM') ? { results: [{ source_id: 'ACT-1' }, { source_id: 'ACT-2' }] } : {})
  );
  const res = await call(env, '/api/assignments/reassignable?childId=CH-1', { token: PARENT_TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { activityIds: ['ACT-1', 'ACT-2'] });

  const select = statements.find((s) => s.sql.includes('FROM assignments'));
  assert.deepEqual(select.args, ['CH-1'], 'scoped to the named child, and nothing else');
  // §2.2 — a chore's identity contains its date, so a rescinded chore day is
  // spent and has no walk to return to. The filter lives in the SQL so no
  // caller can drop it.
  assert.ok(select.sql.includes("kind = 'activity'"));
  // §2.1 — "no live row anywhere", not "has a rescinded row".
  assert.ok(select.sql.includes('HAVING SUM(CASE WHEN rescinded_at IS NULL THEN 1 ELSE 0 END) = 0'));
  assert.ok(!statements.some((s) => /UPDATE|INSERT|DELETE/.test(s.sql)), 'a read, and only a read');
});

test('§4: a truncated reassignable answer says so', async () => {
  const { env } = makeEnv((sql) =>
    (sql.includes('HAVING SUM')
      ? { results: Array.from({ length: 5001 }, (_, i) => ({ source_id: `ACT-${i}` })) }
      : {})
  );
  const res = await call(env, '/api/assignments/reassignable?childId=CH-1', { token: PARENT_TOKEN });
  const out = await res.json();
  assert.equal(out.activityIds.length, 5000);
  assert.equal(out.truncated, true);
});
