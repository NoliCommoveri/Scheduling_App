/* Cloudflare Worker — Management App durable mirror API.
 * Per TDS_Slice_D1_Sync_Management_App.md §4–§5.
 *
 * Owns /api/* only. Every other path falls through to the static asset
 * binding, which serves the existing vanilla-JS app unchanged (§7).
 */

const MAX_CHANGES_PER_PUSH = 500;
const DEFAULT_SNAPSHOT_LIMIT = 2000;
const MAX_SNAPSHOT_LIMIT = 5000;

// appSettings holds the launchPin and the sync token — device-local, never
// mirrored (TDS §1.2, SRS Module 11 §2.3). Enforced server-side as well as
// client-side so a buggy or tampered client cannot push a credential here.
const NEVER_MIRRORED = new Set(['appSettings', 'syncOutbox']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) {
      return json({ error: 'D1 binding "DB" is not configured on this Worker.' }, 500);
    }
    if (!authorize(request, env)) {
      return json({ error: 'Unauthorized.' }, 401);
    }

    try {
      if (url.pathname === '/api/sync/push' && request.method === 'POST') {
        return await handlePush(request, env);
      }
      if (url.pathname === '/api/sync/snapshot' && request.method === 'GET') {
        return await handleSnapshot(url, env);
      }
      if (url.pathname === '/api/sync/status' && request.method === 'GET') {
        return await handleStatus(env);
      }
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }

    return json({ error: 'Not found.' }, 404);
  },
};

// ---- Auth (TDS §4.1) ----

function authorize(request, env) {
  const expected = env.SYNC_TOKEN;
  // Fail closed: an unset secret denies everything rather than opening the
  // database to the internet.
  if (!expected) return false;

  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;

  return timingSafeEqual(match[1], expected);
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  // Length is not itself secret here, but compare a fixed number of bytes
  // regardless so the loop cost does not vary with match position.
  let diff = bufA.length ^ bufB.length;
  const len = Math.max(bufA.length, bufB.length);
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i] || 0) ^ (bufB[i] || 0);
  }
  return diff === 0;
}

// ---- POST /api/sync/push ----

async function handlePush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const changes = body && body.changes;
  if (!Array.isArray(changes)) {
    return json({ error: 'Body must include a "changes" array.' }, 400);
  }
  if (changes.length > MAX_CHANGES_PER_PUSH) {
    return json({ error: `At most ${MAX_CHANGES_PER_PUSH} changes per push.` }, 413);
  }
  if (changes.length === 0) {
    return json({ applied: 0, serverTime: Date.now() });
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
  const now = Date.now();

  // Upsert by (store, key) — last write wins (TDS §1.7). Deletes tombstone
  // rather than remove (§1.8), so a stale device cannot resurrect a record
  // and since-based pull stays correct.
  const upsert = env.DB.prepare(
    `INSERT INTO records (store, key, value, deleted, updated_at, device_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (store, key) DO UPDATE SET
       value      = excluded.value,
       deleted    = excluded.deleted,
       updated_at = excluded.updated_at,
       device_id  = excluded.device_id`
  );

  const statements = [];
  for (const change of changes) {
    const problem = validateChange(change);
    if (problem) return json({ error: problem }, 400);

    // Silently skip rather than reject: a client that sends these is buggy,
    // not hostile, and failing the whole batch would wedge its outbox.
    if (NEVER_MIRRORED.has(change.store)) continue;

    const isDelete = change.op === 'delete';
    statements.push(
      upsert.bind(
        change.store,
        change.key,
        isDelete ? null : JSON.stringify(change.value ?? null),
        isDelete ? 1 : 0,
        now,
        deviceId
      )
    );
  }

  if (statements.length > 0) await env.DB.batch(statements);

  return json({ applied: statements.length, serverTime: now });
}

function validateChange(change) {
  if (!change || typeof change !== 'object') return 'Each change must be an object.';
  if (typeof change.store !== 'string' || !change.store) return 'change.store must be a non-empty string.';
  if (typeof change.key !== 'string') return 'change.key must be a string.';
  if (change.op !== 'put' && change.op !== 'delete') return 'change.op must be "put" or "delete".';
  return null;
}

// ---- GET /api/sync/snapshot ----

async function handleSnapshot(url, env) {
  // Paged so a large corpus cannot exceed the Worker response limit; the
  // client loops until it receives fewer rows than the limit (§6).
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_SNAPSHOT_LIMIT, 1, MAX_SNAPSHOT_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  const { results } = await env.DB.prepare(
    `SELECT store, key, value FROM records
     WHERE deleted = 0
     ORDER BY store, key
     LIMIT ?1 OFFSET ?2`
  )
    .bind(limit, offset)
    .all();

  const records = (results || []).map((row) => ({
    store: row.store,
    key: row.key,
    value: row.value === null ? null : JSON.parse(row.value),
  }));

  return json({ records, count: records.length, limit, offset, serverTime: Date.now() });
}

// ---- GET /api/sync/status ----

async function handleStatus(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count, MAX(updated_at) AS lastUpdatedAt
     FROM records WHERE deleted = 0`
  ).first();

  return json({
    count: (row && row.count) || 0,
    lastUpdatedAt: (row && row.lastUpdatedAt) || null,
    serverTime: Date.now(),
  });
}

// ---- helpers ----

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
