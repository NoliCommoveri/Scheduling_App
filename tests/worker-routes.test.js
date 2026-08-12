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
