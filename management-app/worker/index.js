/* Cloudflare Worker — the API for both apps.
 * Per TDS_Slice_Online_Revamp.md §3-§7 (schema, auth, lifecycle) and §5 (routes).
 *
 * Owns /api/*, /admin/migrations, and the two §10 short-URL redirects. Every
 * other path falls through to the static asset binding, which now covers the
 * whole repo (minus .assetsignore) so both apps are served from this one
 * origin.
 */

import { MIGRATIONS } from './migrations.js';
// Pure helpers live next door in validation.js so tests/ can exercise them
// without dragging in migrations.js, whose `.sql` imports only Wrangler's Text
// loader resolves. Same split as the Child App's `*-core.js` files.
import {
  isValidDate,
  validateCompletionValue,
  validateChange,
  keyToId,
  splitStatements,
  capRows,
  MAX_QUERY_ROWS,
  clampInt,
  randomPairCode,
  timingSafeEqual,
  validateMessage,
} from './validation.js';

const MAX_BATCH = 500;
const DEFAULT_SNAPSHOT_LIMIT = 2000;
const MAX_SNAPSHOT_LIMIT = 5000;
const PAIR_CODE_TTL_MS = 15 * 60 * 1000;
const PAIR_CODE_MAX_FAILS = 10;

// records§3.1: only these stores are mirrored from the Management App's
// curriculum-authoring IndexedDB. Child-side stores never land in `records`
// — they belong to the relational tables in §3.3-§3.6. `appSettings` and
// `syncOutbox` are device-local credentials/queues and are never mirrored.
const ALLOWED_SYNC_STORES = new Set([
  'meta', 'curricula', 'tiers', 'rewardCategories', 'activityTypes', 'courses',
  'lessons', 'activities', 'children', 'chores', 'familyEvents',
  'pacingProfiles', 'generationLog',
]);

// §3.3 paired-ownership columns. Disjoint by construction so the two writers
// never contend for a value (§4.2). `date` is a top-level bookkeeping column,
// not in either owned block in the schema comment, but §6.5 is explicit that
// only a PATCH (parent-authenticated) may move it; the child writes
// `deferred_to` instead and leaves `date` untouched.
//
// Shared Chores §7 adds a third ownership class: `claimed_by`/`claimed_at`
// are neither parent- nor child-owned. They are derived by the Worker from a
// race between two device credentials, and are set only by the claim and
// release routes below — never through ASSIGNMENT_CREATE_FIELDS,
// ASSIGNMENT_PATCH_FIELDS, or ASSIGNMENT_COMPLETION_FIELDS.
const ASSIGNMENT_CREATE_FIELDS = {
  date: 'date', kind: 'kind', sourceId: 'source_id', title: 'title',
  courseName: 'course_name', activityType: 'activity_type', sequenceNo: 'sequence_no',
  payload: 'payload', expectedDurationMin: 'expected_duration_min',
  rewardAmount: 'reward_amount', rewardCategory: 'reward_category',
  blockHint: 'block_hint', sortOrder: 'sort_order',
  // Shared Chores §3.2/§7 — part of occurrence identity, parent-minted at
  // Commit. Never in ASSIGNMENT_PATCH_FIELDS: moving a row between
  // instances is a different occurrence, not an edit.
  instanceKey: 'instance_key',
  // Shared Chores §5.3 — a signal, not a stored column. Marks a row for
  // claim_groups resolution before insert; `claim_group` (server-minted) is
  // what actually lands in the table. Listed here only so the per-row
  // "may not set" check (below) accepts it.
  shared: 'shared',
};
const ASSIGNMENT_PATCH_FIELDS = {
  date: 'date', sourceId: 'source_id', title: 'title', courseName: 'course_name',
  activityType: 'activity_type', sequenceNo: 'sequence_no', payload: 'payload',
  expectedDurationMin: 'expected_duration_min', rewardAmount: 'reward_amount',
  rewardCategory: 'reward_category', blockHint: 'block_hint', sortOrder: 'sort_order',
};
const ASSIGNMENT_COMPLETION_FIELDS = {
  status: 'status', completedAt: 'completed_at', grade: 'grade',
  deferredTo: 'deferred_to', childBlockHint: 'child_block_hint',
  childSortOrder: 'child_sort_order',
  // Child Feedback Loop §5.2. Requires migration 0004 to already be applied
  // (release 1 of that slice) — see DEPLOY.md's note on why the ordering
  // matters.
  completionNote: 'completion_note',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/admin/migrations') {
        return await handleAdminMigrations(request, env);
      }

      if (!url.pathname.startsWith('/api/')) {
        const redirect = staticRedirect(url);
        if (redirect) return redirect;
        return env.ASSETS.fetch(request);
      }

      if (!env.DB) {
        return json({ error: 'D1 binding "DB" is not configured on this Worker.' }, 500);
      }

      return await routeApi(request, env, ctx, url);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};

// §10 entry points. The assets directory widened from ./management-app to the
// repo root so the Child App is same-origin with the API, which moved the
// Management App off `/` and onto `/management-app/`. These keep the short URLs
// working: `/` is the parent's existing bookmark, `/kid` is what goes on a
// child's home screen.
//
// 302, not 301: a permanent redirect is cached by the browser indefinitely and
// would be painful to walk back if these paths are ever rearranged again.
function staticRedirect(url) {
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '') return redirect(url, '/management-app/');
  if (path === '/kid') return redirect(url, '/child-app/');
  return null;
}

function redirect(url, pathname) {
  const target = new URL(url);
  target.pathname = pathname;
  return Response.redirect(target.toString(), 302);
}

async function routeApi(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  // ---- Migrations (§5.3a) — parent only ----
  if (pathname === '/api/migrations' && method === 'GET') {
    return withParent(request, env, () => handleMigrationsStatus(env));
  }
  if (pathname === '/api/migrations/apply' && method === 'POST') {
    return withParent(request, env, () => handleMigrationsApply(env));
  }

  // ---- Admin reset — parent only ----
  if (pathname === '/api/admin/reset' && method === 'POST') {
    return withParent(request, env, () => handleAdminReset(request, env));
  }
  if (pathname === '/api/admin/assignments/clear' && method === 'POST') {
    return withParent(request, env, () => handleAdminClearAssignments(request, env));
  }

  // ---- Curriculum mirror (§5.1) — unchanged behaviour, narrowed store list ----
  if (pathname === '/api/sync/push' && method === 'POST') {
    return withParent(request, env, () => handleSyncPush(request, env));
  }
  if (pathname === '/api/sync/snapshot' && method === 'GET') {
    return withParent(request, env, () => handleSyncSnapshot(url, env));
  }
  if (pathname === '/api/sync/status' && method === 'GET') {
    return withParent(request, env, () => handleSyncStatus(env));
  }

  // ---- Assignments (§5.2) — parent only ----
  if (pathname === '/api/assignments' && method === 'POST') {
    return withParent(request, env, () => handleAssignmentsCreate(request, env));
  }
  if (pathname === '/api/assignments' && method === 'GET') {
    return withParent(request, env, () => handleAssignmentsQuery(url, env));
  }
  if (pathname === '/api/assignments/rescind' && method === 'POST') {
    return withParent(request, env, () => handleAssignmentsRescind(request, env));
  }
  const patchMatch = /^\/api\/assignments\/([^/]+)$/.exec(pathname);
  if (patchMatch && method === 'PATCH') {
    return withParent(request, env, () => handleAssignmentPatch(request, env, patchMatch[1]));
  }

  // ---- Devices and rewards (§5.3) — parent only ----
  if (pathname === '/api/devices/pair-code' && method === 'POST') {
    return withParent(request, env, () => handlePairCodeMint(request, env));
  }
  if (pathname === '/api/devices' && method === 'GET') {
    return withParent(request, env, () => handleDevicesList(env));
  }
  const revokeMatch = /^\/api\/devices\/([^/]+)\/revoke$/.exec(pathname);
  if (revokeMatch && method === 'POST') {
    return withParent(request, env, () => handleDeviceRevoke(env, revokeMatch[1]));
  }
  if (pathname === '/api/rewards' && method === 'GET') {
    return withParent(request, env, () => handleRewardsQuery(url, env));
  }
  if (pathname === '/api/rewards/adjust' && method === 'POST') {
    return withParent(request, env, () => handleRewardsAdjust(request, env));
  }

  // ---- Assignment messages (Child Feedback Loop §6.2) ----
  // Read and read-marking are the parent's; appending is the child's, below.
  if (pathname === '/api/messages' && method === 'GET') {
    return withParent(request, env, () => handleMessagesQuery(url, env));
  }
  if (pathname === '/api/messages/read' && method === 'POST') {
    return withParent(request, env, () => handleMessagesRead(request, env));
  }

  // ---- Child — unauthenticated (§5.4) ----
  if (pathname === '/api/pair' && method === 'POST') {
    return await handlePair(request, env);
  }

  // ---- Child — device credential (§5.5) ----
  if (pathname === '/api/plan/version' && method === 'GET') {
    return withDevice(request, env, ctx, (device) => handlePlanVersion(env, device));
  }
  if (pathname === '/api/plan' && method === 'GET') {
    return withDevice(request, env, ctx, (device) => handlePlan(url, env, device));
  }
  if (pathname === '/api/completions' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleCompletions(request, env, device));
  }
  // Shared Chores §5.4/§5.5 — the one synchronous, arbitrated write in the
  // API (§5.6 says why this is not folded into /api/completions).
  const claimMatch = /^\/api\/assignments\/([^/]+)\/claim$/.exec(pathname);
  if (claimMatch && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleAssignmentClaim(request, env, device, claimMatch[1]));
  }
  if (claimMatch && method === 'DELETE') {
    return withDevice(request, env, ctx, (device) => handleAssignmentClaimRelease(env, device, claimMatch[1]));
  }
  if (pathname === '/api/rewards/entries' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleRewardEntries(request, env, device));
  }
  if (pathname === '/api/streak' && method === 'PUT') {
    return withDevice(request, env, ctx, (device) => handleStreakUpsert(request, env, device));
  }
  if (pathname === '/api/messages' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleMessages(request, env, device));
  }

  return json({ error: 'Not found.' }, 404);
}

// ============================================================================
// Auth (§4)
// ============================================================================

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isParentToken(request, env) {
  if (!env.SYNC_TOKEN) return false; // fail closed — an unset secret opens nothing
  const token = bearerToken(request);
  if (!token) return false;
  return timingSafeEqual(token, env.SYNC_TOKEN);
}

// A device credential is valid only when it hashes to a non-revoked row.
// Returns { deviceId, childId } or null. §4.2's rule that "the Worker derives
// child_id from the token, never the request body" is enforced by every
// device-scoped handler reading device.childId rather than a query/body value.
async function resolveDevice(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, child_id FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL`
  ).bind(tokenHash).first();
  if (!row) return null;
  return { deviceId: row.id, childId: row.child_id };
}

// Wrap a parent-only handler. Any non-parent credential — missing, wrong
// secret, or a valid-but-different-scope device token — is 401, matching
// acceptance check §13.2 (a device token against a parent route is 401, not 403).
async function withParent(request, env, handler) {
  if (!isParentToken(request, env)) return json({ error: 'Unauthorized.' }, 401);
  return await handler();
}

// Wrap a device-only handler. 401 for an unknown/revoked bearer; the handler
// itself is responsible for any 403 "wrong child" check against a resource.
async function withDevice(request, env, ctx, handler) {
  const device = await resolveDevice(request, env);
  if (!device) return json({ error: 'Unauthorized.' }, 401);
  ctx.waitUntil(
    env.DB.prepare(`UPDATE devices SET last_seen_at = ?1 WHERE id = ?2`)
      .bind(Date.now(), device.deviceId).run()
  );
  return await handler(device);
}

// ============================================================================
// Migrations (§3.7) — shared by /api/migrations* and /admin/migrations
// ============================================================================

async function ensureMigrationsTable(env) {
  // env.DB.exec() splits on newlines, not statements, so this has to be one
  // physical line — unlike the migration files themselves, which go through
  // batch()+prepare() via splitStatements() and tolerate normal formatting.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
  );
}

async function getAppliedNames(env) {
  const { results } = await env.DB.prepare(`SELECT name FROM d1_migrations`).all();
  return new Set((results || []).map((r) => r.name));
}

async function getPendingMigrations(env) {
  await ensureMigrationsTable(env);
  const applied = await getAppliedNames(env);
  return MIGRATIONS.filter((m) => !applied.has(m.name));
}

// Each migration's statements, plus its own tracking-row insert, run in one
// env.DB.batch() — an implicit transaction (§3.7.4). Batches are not chained:
// the first failure stops the run and everything before it stays applied.
async function applyPendingMigrations(env) {
  await ensureMigrationsTable(env);
  const applied = await getAppliedNames(env);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.name));

  const appliedNow = [];
  for (const migration of pending) {
    const statements = splitStatements(migration.sql).map((s) => env.DB.prepare(s));
    statements.push(
      env.DB.prepare(`INSERT INTO d1_migrations (name) VALUES (?1)`).bind(migration.name)
    );
    try {
      await env.DB.batch(statements);
      appliedNow.push(migration.name);
    } catch (err) {
      return { applied: appliedNow, failed: { name: migration.name, error: String(err && err.message || err) } };
    }
  }
  return { applied: appliedNow };
}

async function handleMigrationsStatus(env) {
  await ensureMigrationsTable(env);
  const applied = await getAppliedNames(env);
  const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
  const pending = migrations.filter((m) => !m.applied).length;
  return json({ migrations, pending });
}

async function handleMigrationsApply(env) {
  const result = await applyPendingMigrations(env);
  return json(result, result.failed ? 207 : 200);
}

// ---- GET/POST /admin/migrations — server-rendered, no JS (§3.7.5-6) ----

async function handleAdminMigrations(request, env) {
  if (!env.DB) {
    return html(renderAdminPage({ error: 'D1 binding "DB" is not configured on this Worker.' }), 500);
  }

  if (request.method === 'GET') {
    await ensureMigrationsTable(env);
    const applied = await getAppliedNames(env);
    const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
    return html(renderAdminPage({ migrations }));
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const token = String(form.get('token') || '');
    const confirmed = form.get('confirm') === 'yes';

    if (!env.SYNC_TOKEN || !timingSafeEqual(token, env.SYNC_TOKEN)) {
      await ensureMigrationsTable(env);
      const applied = await getAppliedNames(env);
      const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
      return html(renderAdminPage({ migrations, error: 'Incorrect token.' }), 401);
    }
    if (!confirmed) {
      await ensureMigrationsTable(env);
      const applied = await getAppliedNames(env);
      const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
      return html(renderAdminPage({ migrations, error: 'Confirm the checkbox to apply.' }));
    }

    const result = await applyPendingMigrations(env);
    const applied = await getAppliedNames(env);
    const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
    return html(renderAdminPage({ migrations, result }));
  }

  return json({ error: 'Not found.' }, 404);
}

function renderAdminPage({ migrations = [], result, error } = {}) {
  const pending = migrations.filter((m) => !m.applied).length;
  const rows = migrations
    .map((m) => `<tr><td>${escapeHtml(m.name)}</td><td>${m.applied ? 'applied' : 'pending'}</td></tr>`)
    .join('\n');

  let resultBlock = '';
  if (result) {
    if (result.failed) {
      resultBlock = `<p class="err">Applied ${result.applied.length}, then stopped: <strong>${escapeHtml(result.failed.name)}</strong> failed — ${escapeHtml(result.failed.error)}</p>`;
    } else if (result.applied.length === 0) {
      resultBlock = `<p>No pending migrations.</p>`;
    } else {
      resultBlock = `<p>Applied: ${result.applied.map(escapeHtml).join(', ')}</p>`;
    }
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migrations — scheduling-app</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #ddd; }
  .err { color: #a11; font-weight: 600; }
  form { margin-top: 1.5rem; padding: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  label { display: block; margin: 0.5rem 0; }
  input[type=password] { width: 100%; padding: 0.4rem; box-sizing: border-box; }
  button { margin-top: 0.75rem; padding: 0.5rem 1rem; }
</style>
</head>
<body>
<h1>Database migrations</h1>
<p>${pending} pending of ${migrations.length} total.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
${resultBlock}
<table><tbody>${rows}</tbody></table>
<form method="post" action="/admin/migrations">
  <label>Parent token
    <input type="password" name="token" required autocomplete="off">
  </label>
  <label>
    <input type="checkbox" name="confirm" value="yes"> I understand this applies pending migrations to the live database.
  </label>
  <button type="submit">Apply pending migrations</button>
</form>
<p>No JavaScript runs on this page, so it works even if the Management App itself is broken.</p>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============================================================================
// Admin reset — parent only. Empties every data table; the schema itself
// (and d1_migrations' record of what has been applied) is untouched, so a
// reset never re-triggers a migration run. This is a data wipe, not a
// schema rebuild — the two are deliberately kept separate.
// ============================================================================

// Fixed, hardcoded list — never built from user input — so interpolating
// these names into DELETE FROM is safe. Order does not matter: every
// statement rides in one env.DB.batch(), which D1 runs as a transaction.
const RESET_TABLES = [
  'assignment_messages', 'claim_groups', 'commit_chunks', 'reward_entries',
  'streaks', 'devices', 'pair_codes', 'assignments', 'children', 'records',
];

async function handleAdminReset(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  // Typed confirmation, not just a bearer token — the parent token already
  // authorizes this request; this second check is what stops a stray or
  // scripted POST from wiping the database by accident.
  if (!body || body.confirm !== 'RESET') {
    return json({ error: 'Send {"confirm":"RESET"} to proceed.' }, 400);
  }

  await env.DB.batch(RESET_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`).bind()));

  return json({ ok: true, tables: RESET_TABLES });
}

// A narrower sibling of Admin reset, for pacing/generator testing: empties
// only the assignment lifecycle, not curriculum, children, devices, or
// reward_entries/streaks. Same fixed-table-list safety as RESET_TABLES, and
// the same ordering — child tables (assignment_messages, claim_groups,
// commit_chunks) before the assignments they reference.
const CLEAR_ASSIGNMENTS_TABLES = ['assignment_messages', 'claim_groups', 'commit_chunks', 'assignments'];

async function handleAdminClearAssignments(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (!body || body.confirm !== 'CLEAR_ASSIGNMENTS') {
    return json({ error: 'Send {"confirm":"CLEAR_ASSIGNMENTS"} to proceed.' }, 400);
  }

  await env.DB.batch(CLEAR_ASSIGNMENTS_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`).bind()));

  return json({ ok: true, tables: CLEAR_ASSIGNMENTS_TABLES });
}

// ============================================================================
// Curriculum mirror (§5.1, retained) — unchanged behaviour, narrowed §3.1 stores
// ============================================================================

async function handleSyncPush(request, env) {
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
  if (changes.length > MAX_BATCH) {
    return json({ error: `At most ${MAX_BATCH} changes per push.` }, 413);
  }
  if (changes.length === 0) {
    return json({ applied: 0, serverTime: Date.now() });
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
  const now = Date.now();

  const upsert = env.DB.prepare(
    `INSERT INTO records (store, key, value, deleted, updated_at, device_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (store, key) DO UPDATE SET
       value      = excluded.value,
       deleted    = excluded.deleted,
       updated_at = excluded.updated_at,
       device_id  = excluded.device_id`
  );

  // §3.2's queryable projection of the child records that live as opaque blobs
  // in `records`. Maintained here, in the same batch as the mirror write, so
  // the two can never disagree: one implicit transaction, both or neither.
  // Until now nothing populated this table and the schema comment claiming
  // otherwise was simply false; 0002 backfills what predates this code.
  const upsertChild = env.DB.prepare(
    `INSERT INTO children (id, name, active, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, active = excluded.active, updated_at = excluded.updated_at`
  );
  const deleteChild = env.DB.prepare(`DELETE FROM children WHERE id = ?1`);

  const statements = [];
  // Counted separately from `statements`, which also carries the §3.2 children
  // projection writes. Conflating them made a push of one child record report
  // two changes applied.
  let mirrored = 0;
  for (const change of changes) {
    const problem = validateChange(change);
    if (problem) return json({ error: problem }, 400);

    // §3.1 narrows the mirror to parent authoring stores. A client sending
    // anything else is buggy, not hostile — skip rather than fail the batch.
    if (!ALLOWED_SYNC_STORES.has(change.store)) continue;

    mirrored++;
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

    if (change.store === 'children') {
      const child = (!isDelete && change.value && typeof change.value === 'object') ? change.value : null;
      const id = child && typeof child.id === 'string' ? child.id : keyToId(change.key);
      if (id) {
        if (isDelete) {
          statements.push(deleteChild.bind(id));
        } else if (typeof child.name === 'string' && child.name) {
          // Absent `active` reads as active, matching Children.isActive() in
          // the Management App — a record written before the flag existed is
          // older than the flag, not archived.
          statements.push(upsertChild.bind(id, child.name, child.active === false ? 0 : 1, now));
        }
        // A put with no usable name is left out of the projection rather than
        // failing the batch: `name` is NOT NULL, and one malformed record must
        // not block an otherwise good curriculum push.
      }
    }
  }

  if (statements.length > 0) await env.DB.batch(statements);

  return json({ applied: mirrored, serverTime: now });
}

async function handleSyncSnapshot(url, env) {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_SNAPSHOT_LIMIT, 1, MAX_SNAPSHOT_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  const { results } = await env.DB.prepare(
    `SELECT store, key, value FROM records
     WHERE deleted = 0
     ORDER BY store, key
     LIMIT ?1 OFFSET ?2`
  ).bind(limit, offset).all();

  const records = (results || []).map((row) => ({
    store: row.store,
    key: row.key,
    value: row.value === null ? null : JSON.parse(row.value),
  }));

  return json({ records, count: records.length, limit, offset, serverTime: Date.now() });
}

async function handleSyncStatus(env) {
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

// ============================================================================
// Assignments (§5.2, §6) — parent
// ============================================================================

async function handleAssignmentsCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const { batchId, childId, assignments } = body || {};
  if (typeof batchId !== 'string' || !batchId) return json({ error: 'batchId is required.' }, 400);
  if (typeof childId !== 'string' || !childId) return json({ error: 'childId is required.' }, 400);
  if (!Array.isArray(assignments)) return json({ error: 'assignments must be an array.' }, 400);
  if (assignments.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} assignments per commit.` }, 413);

  // §6.1's replay safety, which until migration 0003 was a claim with nothing
  // behind it. A Commit larger than MAX_BATCH arrives as several requests
  // sharing one batchId, so the batch alone does not identify a request —
  // (batchId, chunkIndex) does. An older client that sends no chunkIndex is
  // treated as chunk 0, which is exactly right for the single-request Commit
  // that is the only shape it can produce.
  const chunkIndex = body.chunkIndex === undefined ? 0 : body.chunkIndex;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return json({ error: 'chunkIndex must be a non-negative integer.' }, 400);
  }

  if (assignments.length === 0) return json({ ids: [], applied: 0, skipped: 0 });

  const already = await findCommitChunk(env, batchId, chunkIndex);
  if (already) return json(duplicateChunkResponse(already));

  for (const row of assignments) {
    if (!row || typeof row !== 'object') return json({ error: 'Each assignment must be an object.' }, 400);

    const rejected = Object.keys(row).filter((k) => !(k in ASSIGNMENT_CREATE_FIELDS));
    if (rejected.length > 0) {
      return json({ error: `Assignment rows may not set: ${rejected.join(', ')}` }, 400);
    }
    if (!isValidDate(row.date)) return json({ error: 'Each assignment needs a YYYY-MM-DD date.' }, 400);
    if (!['activity', 'chore', 'event'].includes(row.kind)) {
      return json({ error: 'Each assignment kind must be activity, chore, or event.' }, 400);
    }
    if (typeof row.title !== 'string' || !row.title) {
      return json({ error: 'Each assignment needs a title.' }, 400);
    }
    // Shared Chores §5.3 step 1 — a shared row has no identity to group on
    // without a sourceId, so there is nothing §5.3's resolution could key it
    // by.
    if (row.shared && row.sourceId == null) {
      return json({ error: 'A shared assignment needs a sourceId to group on.' }, 400);
    }
  }

  // §3.8's idempotency is scoped to one batch, which is the wrong scope for the
  // duplicate parents actually hit. Two *different* Commits over the same range
  // carry two different batchIds, so nothing collided and every row landed a
  // second time — the same chore, twice, on the same day. Under the packet model
  // that was free: re-generating produced the same file and the child replaced
  // its plan wholesale on import. D1 is insert-only, so the same act now doubles
  // the plan. §6.6 is the rule this enforces.
  const liveKeys = await loadLiveAssignmentKeys(env, childId, assignments);

  // Shared Chores §5.3 — resolved before the insert statements are built,
  // because D1's batch() is a transaction whose results cannot be read
  // mid-flight. A chunk with no `shared: true` rows costs nothing here:
  // resolveClaimGroups returns an empty map without touching the database.
  const claimGroups = await resolveClaimGroups(env, assignments);

  const now = Date.now();
  const ids = [];
  const statements = [];
  let skipped = 0;

  for (const row of assignments) {
    const key = naturalKey(row.date, row.kind, row.sourceId, row.instanceKey ?? '');
    if (key !== null && liveKeys.has(key)) { skipped++; continue; }
    if (key !== null) liveKeys.add(key); // a repeat inside one chunk is the same duplicate

    const claimGroup = row.shared
      ? claimGroups.get(claimGroupKey(row.date, row.sourceId, row.instanceKey ?? ''))
      : null;

    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(
      env.DB.prepare(
        // The `WHERE NOT EXISTS` repeats the check the Set above already made,
        // and is not redundant: the Set was read before this request built its
        // statements, so a second parent device committing the same range
        // concurrently would slip past it. This is the check that cannot.
        // A row with no source_id has no natural key at all — `source_id = NULL`
        // is never true, so NOT EXISTS always holds and it inserts, which is
        // the right answer for a row nothing can identify as a repeat.
        `INSERT INTO assignments (
           id, child_id, date, kind, batch_id,
           source_id, title, course_name, activity_type, sequence_no,
           payload, expected_duration_min, reward_amount, reward_category,
           block_hint, sort_order, instance_key, claim_group,
           status, assigned_at, updated_at, updated_by
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5,
           ?6, ?7, ?8, ?9, ?10,
           ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18,
           'pending', ?19, ?19, 'parent'
         WHERE NOT EXISTS (
           SELECT 1 FROM assignments
            WHERE child_id = ?2 AND date = ?3 AND kind = ?4 AND source_id = ?6
              AND instance_key = ?17
              AND rescinded_at IS NULL
         )`
      ).bind(
        id, childId, row.date, row.kind, batchId,
        row.sourceId ?? null, row.title, row.courseName ?? null, row.activityType ?? null, row.sequenceNo ?? null,
        row.payload ? JSON.stringify(row.payload) : null, row.expectedDurationMin ?? null,
        row.rewardAmount ?? null, row.rewardCategory ?? null,
        row.blockHint ?? null, row.sortOrder ?? null, row.instanceKey ?? '', claimGroup ?? null,
        now
      )
    );
  }

  // The accounting row rides in the same batch as the assignments it accounts
  // for. That is the whole guarantee: D1's batch() is an implicit transaction,
  // so a replay collides on the (batch_id, chunk_index) primary key and rolls
  // the assignment inserts back with it. The pre-check above is a courtesy that
  // answers a replay without an error; this is what makes it correct.
  //
  // `row_count` is what this chunk *inserted*, so it excludes rows dropped as
  // already-live above. That is what a replay should report back: re-sending
  // this chunk would insert exactly the same rows again and no more.
  statements.push(
    env.DB.prepare(
      `INSERT INTO commit_chunks (batch_id, chunk_index, child_id, row_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(batchId, chunkIndex, childId, ids.length, now)
  );

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // Distinguish "this chunk already landed" from a genuine failure by asking
    // the table rather than pattern-matching SQLite's error text. A racing
    // duplicate is the expected reason to be here and is not an error to the
    // caller — the rows it wanted are already stored.
    const raced = await findCommitChunk(env, batchId, chunkIndex);
    if (raced) return json(duplicateChunkResponse(raced));
    throw err;
  }

  return json({ ids, applied: ids.length, skipped, duplicate: false });
}

// The identity of a day's work, as the domain means it: this child, this day,
// this thing. `id` is a server-minted UUID (§3.3.1) and so can never answer
// "have I already assigned this?" — the natural key is what can.
//
// `source_id` is the curriculum item behind the row: an Activity id, a Chore id
// (the chore itself, not a per-occurrence key — §3.3.1 repealed those), or a
// Family Event id. Null means the row carries no provenance and is not
// deduplicable; callers treat that as "always insert".
function naturalKey(date, kind, sourceId, instanceKey) {
  if (sourceId == null) return null;
  return `${date} ${kind} ${sourceId} ${instanceKey}`;
}

// The live natural keys this child already has across the chunk's date span.
// Rescinded rows are deliberately absent: pulling a batch back and generating
// the range again is a supported repair, and a tombstone must not block it.
// A resolved row (complete or waived) is still live and does block — re-issuing
// work a child has already finished is the same duplicate wearing a hat.
async function loadLiveAssignmentKeys(env, childId, rows) {
  let from = null;
  let to = null;
  for (const row of rows) {
    if (row.sourceId == null) continue;
    if (from === null || row.date < from) from = row.date;
    if (to === null || row.date > to) to = row.date;
  }

  const keys = new Set();
  if (from === null) return keys; // nothing in this chunk has a natural key

  // Bounded by the chunk's own span and served by idx_assign_child_date, so
  // this stays one indexed range scan however long the child's history is.
  const { results } = await env.DB.prepare(
    `SELECT date, kind, source_id, instance_key FROM assignments
      WHERE child_id = ?1 AND date >= ?2 AND date <= ?3
        AND source_id IS NOT NULL AND rescinded_at IS NULL`
  ).bind(childId, from, to).all();

  for (const row of results || []) {
    keys.add(naturalKey(row.date, row.kind, row.source_id, row.instance_key));
  }
  return keys;
}

// Shared Chores §5.3 — resolves `(sourceId, date, instanceKey)` triples for
// every `shared: true` row in the chunk to the `claim_groups` id that owns
// that occurrence, minting one if this is the first Commit to reach it.
//
// The insert is `ON CONFLICT DO NOTHING` rather than a SELECT-then-INSERT,
// because two children's per-child Commits can resolve the same triple at
// the same time: whichever insert lands first wins the row, and the other's
// insert is silently absorbed. The read-back that follows is what makes
// either order see the same, single id.
async function resolveClaimGroups(env, assignments) {
  const triples = new Map(); // claimGroupKey(...) -> { sourceId, date, instanceKey }
  for (const row of assignments) {
    if (!row.shared || row.sourceId == null) continue;
    const instanceKey = row.instanceKey ?? '';
    triples.set(claimGroupKey(row.date, row.sourceId, instanceKey), {
      sourceId: row.sourceId, date: row.date, instanceKey,
    });
  }

  const resolved = new Map();
  if (triples.size === 0) return resolved;

  const now = Date.now();
  await env.DB.batch(
    [...triples.values()].map(({ sourceId, date, instanceKey }) =>
      env.DB.prepare(
        `INSERT INTO claim_groups (source_id, date, instance_key, id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (source_id, date, instance_key) DO NOTHING`
      ).bind(sourceId, date, instanceKey, crypto.randomUUID(), now)
    )
  );

  // One read-back for the whole chunk — a composite-key IN via row values,
  // which reads whichever id won the insert above, this device's or a
  // sibling Commit's that raced it.
  const values = [...triples.values()];
  const placeholders = values.map(() => '(?, ?, ?)').join(', ');
  const params = values.flatMap(({ sourceId, date, instanceKey }) => [sourceId, date, instanceKey]);
  const { results } = await env.DB.prepare(
    `SELECT source_id, date, instance_key, id FROM claim_groups
      WHERE (source_id, date, instance_key) IN (VALUES ${placeholders})`
  ).bind(...params).all();

  for (const row of results || []) {
    resolved.set(claimGroupKey(row.date, row.source_id, row.instance_key), row.id);
  }
  return resolved;
}

function claimGroupKey(date, sourceId, instanceKey) {
  return `${date}\0${sourceId}\0${instanceKey}`;
}

async function findCommitChunk(env, batchId, chunkIndex) {
  return await env.DB.prepare(
    `SELECT row_count, created_at FROM commit_chunks WHERE batch_id = ?1 AND chunk_index = ?2`
  ).bind(batchId, chunkIndex).first();
}

// A replay is answered with what the first attempt applied, not with an error.
// `ids` is empty because this request minted none — the caller wants the count,
// and packet.js reads `applied` for exactly that reason.
function duplicateChunkResponse(row) {
  return { ids: [], applied: row.row_count, duplicate: true, appliedAt: row.created_at };
}

async function handleAssignmentPatch(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'Body must be a JSON object.' }, 400);

  const rejected = Object.keys(body).filter((k) => !(k in ASSIGNMENT_PATCH_FIELDS));
  if (rejected.length > 0) {
    return json({ error: `Not a parent-writable column: ${rejected.join(', ')}` }, 400);
  }
  const keys = Object.keys(body);
  if (keys.length === 0) return json({ error: 'No fields to update.' }, 400);
  if ('date' in body && !isValidDate(body.date)) return json({ error: 'date must be YYYY-MM-DD.' }, 400);

  const existing = await env.DB.prepare(`SELECT id FROM assignments WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ error: 'Assignment not found.' }, 404);

  const now = Date.now();
  const setClauses = keys.map((k, i) => `${ASSIGNMENT_PATCH_FIELDS[k]} = ?${i + 1}`);
  const values = keys.map((k) => (k === 'payload' && body[k] != null ? JSON.stringify(body[k]) : body[k]));

  await env.DB.prepare(
    `UPDATE assignments SET ${setClauses.join(', ')}, updated_at = ?${keys.length + 1}, updated_by = 'parent'
     WHERE id = ?${keys.length + 2}`
  ).bind(...values, now, id).run();

  return json({ ok: true });
}

async function handleAssignmentsRescind(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const includeCompleted = body && body.includeCompleted === true;
  const now = Date.now();
  const statusClause = includeCompleted ? '1=1' : `status = 'pending'`;

  // `?1` is the timestamp; the selector's own parameters start at `?2` and are
  // numbered from the values array so the two cannot drift. (This used to bind
  // `now` twice to hold `?2` open while the selector started at `?3` — legal,
  // since SQLite sizes a bind list by the highest index it sees, but a trap for
  // anyone adding a clause.)
  const selectorBase = 2;
  let where, params;
  if (body && typeof body.batchId === 'string' && body.batchId) {
    where = `batch_id = ?${selectorBase}`;
    params = [body.batchId];
  } else if (body && Array.isArray(body.ids) && body.ids.length > 0) {
    if (body.ids.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} ids per rescind.` }, 413);
    where = `id IN (${body.ids.map((_, i) => `?${i + selectorBase}`).join(',')})`;
    params = body.ids;
  } else if (body && typeof body.childId === 'string' && body.childId && isValidDate(body.from) && isValidDate(body.to)) {
    where = `child_id = ?${selectorBase} AND date BETWEEN ?${selectorBase + 1} AND ?${selectorBase + 2}`;
    params = [body.childId, body.from, body.to];
  } else {
    return json({ error: 'Provide batchId, ids[], or childId with from/to.' }, 400);
  }

  const sql = `UPDATE assignments SET rescinded_at = ?1, updated_at = ?1, updated_by = 'parent'
               WHERE rescinded_at IS NULL AND ${statusClause} AND ${where}`;
  const result = await env.DB.prepare(sql).bind(now, ...params).run();

  return json({ rescinded: (result.meta && result.meta.changes) || 0 });
}

async function handleAssignmentsQuery(url, env) {
  const childId = url.searchParams.get('childId');
  if (!childId) return json({ error: 'childId is required.' }, 400);

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const status = url.searchParams.get('status');
  const includeRescinded = ['1', 'true'].includes(url.searchParams.get('includeRescinded'));

  let sql = `SELECT * FROM assignments WHERE child_id = ?1`;
  const params = [childId];
  let i = 2;
  if (from && isValidDate(from)) { sql += ` AND date >= ?${i}`; params.push(from); i++; }
  if (to && isValidDate(to)) { sql += ` AND date <= ?${i}`; params.push(to); i++; }
  if (status) { sql += ` AND status = ?${i}`; params.push(status); i++; }
  if (!includeRescinded) sql += ` AND rescinded_at IS NULL`;
  // One row over the cap, so a truncated answer can say so rather than quietly
  // handing a report a short list it would present as complete.
  sql += ` ORDER BY date, sort_order LIMIT ${MAX_QUERY_ROWS + 1}`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json(capRows(results, 'assignments'));
}

// ============================================================================
// Devices and rewards (§5.3) — parent
// ============================================================================

async function handlePairCodeMint(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (!body || typeof body.childId !== 'string' || !body.childId) {
    return json({ error: 'childId is required.' }, 400);
  }

  const now = Date.now();
  const expiresAt = now + PAIR_CODE_TTL_MS;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomPairCode();
    try {
      await env.DB.prepare(
        `INSERT INTO pair_codes (code, child_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`
      ).bind(code, body.childId, expiresAt, now).run();
      return json({ code, expiresAt });
    } catch (err) {
      // PK collision on `code` — vanishingly rare at 30^8, retry with a new one.
      if (attempt === 4) throw err;
    }
  }
}

async function handleDevicesList(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, child_id, label, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at DESC`
  ).all();
  return json({ devices: results || [] });
}

async function handleDeviceRevoke(env, id) {
  const result = await env.DB.prepare(
    `UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`
  ).bind(Date.now(), id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ error: 'Device not found or already revoked.' }, 404);
  }
  return json({ ok: true });
}

async function handleRewardsQuery(url, env) {
  const childId = url.searchParams.get('childId');
  if (!childId) return json({ error: 'childId is required.' }, 400);

  const [{ results: balances }, { results: entries }] = await Promise.all([
    env.DB.prepare(
      `SELECT category, SUM(amount) AS balance FROM reward_entries WHERE child_id = ?1 GROUP BY category`
    ).bind(childId).all(),
    env.DB.prepare(
      `SELECT * FROM reward_entries WHERE child_id = ?1 ORDER BY earned_at DESC LIMIT 500`
    ).bind(childId).all(),
  ]);

  return json({ balances: balances || [], entries: entries || [] });
}

async function handleRewardsAdjust(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const { childId, category, amount, reason } = body || {};
  if (typeof childId !== 'string' || !childId) return json({ error: 'childId is required.' }, 400);
  if (typeof category !== 'string' || !category) return json({ error: 'category is required.' }, 400);
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return json({ error: 'amount must be a number.' }, 400);
  const reasonValue = ['adjustment', 'spend', 'earned'].includes(reason) ? reason : 'adjustment';

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reward_entries (id, child_id, assignment_id, category, amount, reason, earned_at, created_by)
     VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 'parent')`
  ).bind(id, childId, category, amount, reasonValue, now).run();

  return json({ id, childId, category, amount, reason: reasonValue, earnedAt: now });
}

// ============================================================================
// Pairing (§4.3, §5.4) — unauthenticated
// ============================================================================

async function handlePair(request, env) {
  if (!env.DB) return json({ error: 'D1 binding "DB" is not configured on this Worker.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const label = typeof body.label === 'string' ? body.label.slice(0, 200) : null;
  if (!code) return json({ error: 'code is required.' }, 400);

  const row = await env.DB.prepare(
    `SELECT code, child_id, expires_at, consumed_at, fail_count FROM pair_codes WHERE code = ?1`
  ).bind(code).first();

  if (!row) return json({ error: 'Unknown pairing code.' }, 409);

  const now = Date.now();
  const alreadyBurned = row.fail_count >= PAIR_CODE_MAX_FAILS;
  if (row.consumed_at || alreadyBurned) {
    return json({ error: 'Pairing code already used.' }, 409);
  }
  if (row.expires_at < now) {
    await env.DB.prepare(`UPDATE pair_codes SET fail_count = fail_count + 1 WHERE code = ?1`).bind(code).run();
    return json({ error: 'Pairing code expired.' }, 409);
  }

  // Success: consume the code, mint the device.
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const deviceId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(`UPDATE pair_codes SET consumed_at = ?1 WHERE code = ?2 AND consumed_at IS NULL`).bind(now, code),
    env.DB.prepare(
      `INSERT INTO devices (id, child_id, label, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(deviceId, row.child_id, label, tokenHash, now),
  ]);

  // childName comes from the §3.2 projection, which is what that table is for:
  // reading a child's name without parsing a JSON blob. The `records` fallback
  // stays for the case where the projection has not caught up — a database
  // where 0002 has not been applied yet, or a child authored by a device that
  // has not pushed since. Pairing is not the place to discover a stale table.
  const projected = await env.DB.prepare(
    `SELECT name FROM children WHERE id = ?1`
  ).bind(row.child_id).first();

  let childName = projected ? projected.name : null;
  if (!childName) {
    const childRecord = await env.DB.prepare(
      `SELECT value FROM records WHERE store = 'children' AND key = ?1 AND deleted = 0`
    ).bind(JSON.stringify(row.child_id)).first();
    childName = childRecord ? (JSON.parse(childRecord.value) || {}).name || null : null;
  }

  return json({ token, childId: row.child_id, childName });
}

// ============================================================================
// Child — device credential (§5.5)
// ============================================================================

async function handlePlanVersion(env, device) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count, MAX(updated_at) AS maxUpdatedAt FROM assignments WHERE child_id = ?1`
  ).bind(device.childId).first();
  return json({ maxUpdatedAt: (row && row.maxUpdatedAt) || null, count: (row && row.count) || 0 });
}

function defaultPlanRange() {
  const day = 24 * 60 * 60 * 1000;
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  return {
    from: fmt(new Date(today.getTime() - 7 * day)),
    to: fmt(new Date(today.getTime() + 14 * day)),
  };
}

async function handlePlan(url, env, device) {
  const defaults = defaultPlanRange();
  const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : defaults.from;
  const to = isValidDate(url.searchParams.get('to')) ? url.searchParams.get('to') : defaults.to;
  const since = clampInt(url.searchParams.get('since'), null, 0, Number.MAX_SAFE_INTEGER);

  // Rescinded rows are included on purpose (§5.5) so the client can remove
  // them from its cache rather than never learning they were rescinded.
  let sql = `SELECT * FROM assignments WHERE child_id = ?1 AND date >= ?2 AND date <= ?3`;
  const params = [device.childId, from, to];
  if (since !== null) {
    sql += ` AND updated_at > ?4`;
    params.push(since);
  }
  sql += ` ORDER BY date, sort_order LIMIT ${MAX_QUERY_ROWS + 1}`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ ...capRows(results, 'assignments'), from, to });
}

async function handleCompletions(request, env, device) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const completions = body && body.completions;
  if (!Array.isArray(completions)) return json({ error: 'Body must include a "completions" array.' }, 400);
  if (completions.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} completions per batch.` }, 413);
  if (completions.length === 0) return json({ applied: 0, rejected: [] });

  const now = Date.now();
  const updatedBy = `device:${device.deviceId}`;
  const rejected = [];
  const deferred = [];
  let applied = 0;

  for (const row of completions) {
    if (!row || typeof row.id !== 'string' || !row.id) {
      rejected.push({ id: row && row.id, error: 'Missing id.' });
      continue;
    }
    const fields = { ...row };
    delete fields.id;
    const badKeys = Object.keys(fields).filter((k) => !(k in ASSIGNMENT_COMPLETION_FIELDS));
    if (badKeys.length > 0) {
      rejected.push({ id: row.id, error: `Not a child-writable column: ${badKeys.join(', ')}` });
      continue;
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      rejected.push({ id: row.id, error: 'No fields to update.' });
      continue;
    }

    // Per row, not per request (§5.6): a device that queued one malformed
    // completion must not lose the day's good ones alongside it.
    const badValues = keys
      .map((k) => { const problem = validateCompletionValue(k, fields[k]); return problem ? `${k}: ${problem}` : null; })
      .filter(Boolean);
    if (badValues.length > 0) {
      rejected.push({ id: row.id, error: badValues.join(' ') });
      continue;
    }

    const setClauses = keys.map((k, i) => `${ASSIGNMENT_COMPLETION_FIELDS[k]} = ?${i + 1}`);
    const values = keys.map((k) => fields[k]);

    // child_id is part of the WHERE, never trusted from the body (§4.2) —
    // an assignment belonging to another child is left untouched, not 403'd
    // mid-batch, so one bad row cannot wedge a device's whole outbox drain.
    let result;
    try {
      // Shared Chores §5.6 — a claim_group row is unarbitrated through this
      // route; the batch route drains asynchronously and has no way to answer
      // "someone else got it" before the tap's UI needs to know.
      result = await env.DB.prepare(
        `UPDATE assignments SET ${setClauses.join(', ')}, updated_at = ?${keys.length + 1}, updated_by = ?${keys.length + 2}
         WHERE id = ?${keys.length + 3} AND child_id = ?${keys.length + 4} AND claim_group IS NULL`
      ).bind(...values, now, updatedBy, row.id, device.childId).run();
    } catch (err) {
      // Child Feedback Loop §11.7, closed. This throw used to escape the loop
      // and the handler, landing on the top-level catch as a 500 — which
      // outbox.js reads as retryable and answers by halting the device's
      // *entire* drain (completions, rewards, streak) until the fault clears.
      // A missing column made that the documented cost of applying a migration
      // late (§5.5).
      //
      // It is contained here instead, but deliberately NOT as a `rejected`
      // row. Every property of the row was already checked above — unknown
      // column, bad value, missing id all rejected before this point — so a
      // throw from the statement itself is never about the row. It is the
      // schema or the database, and it will stop being true. `rejected` means
      // "never going to work", and outbox.js discards those rows for good
      // (outbox.js:181); reporting a missing column that way would delete a
      // child's completions rather than stall them, which is strictly worse
      // than the 500 this replaces.
      //
      // `deferred` is the third answer: this row did not land, keep it queued,
      // try again. The rest of the batch still applies.
      deferred.push({ id: row.id, error: dbFaultMessage(err) });
      continue;
    }

    if (result.meta && result.meta.changes > 0) {
      applied++;
      continue;
    }

    // The row exists but the WHERE excluded it (shared) rather than never
    // matching (not found / another child's). Only queried on the reject
    // path, so an ordinary drain of unshared rows pays nothing extra here.
    const owned = await env.DB.prepare(
      `SELECT claim_group FROM assignments WHERE id = ?1 AND child_id = ?2`
    ).bind(row.id, device.childId).first();
    if (owned && owned.claim_group != null) {
      rejected.push({ id: row.id, error: 'This assignment is shared; use /api/assignments/:id/claim instead.' });
    } else {
      rejected.push({ id: row.id, error: 'Not found for this child.' });
    }
  }

  if (deferred.length > 0 && !understandsDeferred(request)) return deferralUnsupportedResponse(deferred);
  return json({ applied, rejected, deferred });
}

// Shared Chores §5.4 — the arbitrated claim. `grade` and `completionNote`
// only: the rest of ASSIGNMENT_COMPLETION_FIELDS is the route's own to set
// (status, completedAt) or belongs to the ordinary local-first path
// (deferredTo, childBlockHint, childSortOrder — §5.4's field-list note).
const CLAIM_BODY_KEYS = ['grade', 'completionNote'];

async function handleAssignmentClaim(request, env, device, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  body = body || {};

  const badKeys = Object.keys(body).filter((k) => !CLAIM_BODY_KEYS.includes(k));
  if (badKeys.length > 0) {
    return json({ error: `Claim body may not set: ${badKeys.join(', ')}` }, 400);
  }
  const badValues = CLAIM_BODY_KEYS
    .filter((k) => body[k] !== undefined)
    .map((k) => { const problem = validateCompletionValue(k, body[k]); return problem ? `${k}: ${problem}` : null; })
    .filter(Boolean);
  if (badValues.length > 0) return json({ error: badValues.join(' ') }, 400);

  // child_id from the token, never the body (§4.2) — a miss here (wrong
  // child, wrong id) is a 404, not a 403, matching every other device route.
  const row = await env.DB.prepare(
    `SELECT claim_group, rescinded_at FROM assignments WHERE id = ?1 AND child_id = ?2`
  ).bind(id, device.childId).first();
  if (!row) return json({ error: 'Not found.' }, 404);
  if (row.claim_group == null) {
    return json({ error: 'This assignment is not shared; use /api/completions.' }, 400);
  }
  if (row.rescinded_at != null) return json({ error: 'This assignment was rescinded.' }, 409);

  const now = Date.now();

  // The arbitration, one statement. Writes every live row in the group — the
  // caller's and the sibling's — so the loser's row learns the outcome at the
  // same instant, with no second write to race against. §5.4 step 2.
  const arbitration = await env.DB.prepare(
    `UPDATE assignments
        SET claimed_by = ?1, claimed_at = ?2, updated_at = ?2
      WHERE claim_group = ?3
        AND rescinded_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM assignments held
           WHERE held.claim_group = ?3
             AND held.rescinded_at IS NULL
             AND held.claimed_by IS NOT NULL
        )`
  ).bind(device.childId, now, row.claim_group).run();

  let won = !!(arbitration.meta && arbitration.meta.changes > 0);

  if (!won) {
    // Someone already holds it. Reading the group's live claimant — not the
    // caller's own row — is what makes a replay survive a regeneration: the
    // caller's fresh row is unclaimed even when the caller is the one
    // holding the group. §5.4 step 3.
    const claimant = await env.DB.prepare(
      `SELECT claimed_by FROM assignments
        WHERE claim_group = ?1 AND rescinded_at IS NULL AND claimed_by IS NOT NULL
        LIMIT 1`
    ).bind(row.claim_group).first();
    won = !!claimant && claimant.claimed_by === device.childId;
    if (!won) return json({ claimed: false });
  }

  // On a win only — first-time or an idempotent replay — record the
  // completion on the caller's own row. §5.4 step 4.
  const updatedBy = `device:${device.deviceId}`;
  await env.DB.prepare(
    `UPDATE assignments
        SET status = 'complete', completed_at = ?1, grade = ?2, completion_note = ?3,
            updated_at = ?1, updated_by = ?4
      WHERE id = ?5 AND child_id = ?6`
  ).bind(now, body.grade ?? null, body.completionNote ?? null, updatedBy, id, device.childId).run();

  const assignment = await env.DB.prepare(`SELECT * FROM assignments WHERE id = ?1`).bind(id).first();
  return json({ claimed: true, assignment });
}

// Shared Chores §5.5 — undo has to give the chore back, or a mis-tap locks a
// sibling out of work they could still do.
async function handleAssignmentClaimRelease(env, device, id) {
  const row = await env.DB.prepare(
    `SELECT claim_group FROM assignments WHERE id = ?1 AND child_id = ?2`
  ).bind(id, device.childId).first();
  if (!row) return json({ error: 'Not found.' }, 404);
  if (row.claim_group == null) {
    return json({ error: 'This assignment is not shared.' }, 400);
  }

  const now = Date.now();
  // `claimed_by = ?3` is the authorization: only the current claimant can
  // release. A caller who already lost the race releases nothing.
  const result = await env.DB.prepare(
    `UPDATE assignments
        SET claimed_by = NULL, claimed_at = NULL, updated_at = ?1
      WHERE claim_group = ?2 AND claimed_by = ?3 AND rescinded_at IS NULL`
  ).bind(now, row.claim_group, device.childId).run();

  if (!result.meta || result.meta.changes === 0) return json({ released: false });

  // The sibling's row is not touched beyond claimed_by/claimed_at/updated_at
  // above — it was never completed, so there is nothing on it to clear.
  const updatedBy = `device:${device.deviceId}`;
  await env.DB.prepare(
    `UPDATE assignments
        SET status = 'pending', completed_at = NULL, grade = NULL, completion_note = NULL,
            updated_at = ?1, updated_by = ?2
      WHERE id = ?3 AND child_id = ?4`
  ).bind(now, updatedBy, id, device.childId).run();

  const assignment = await env.DB.prepare(`SELECT * FROM assignments WHERE id = ?1`).bind(id).first();
  return json({ released: true, assignment });
}

async function handleRewardEntries(request, env, device) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const entries = body && body.entries;
  if (!Array.isArray(entries)) return json({ error: 'Body must include an "entries" array.' }, 400);
  if (entries.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} entries per batch.` }, 413);
  if (entries.length === 0) return json({ applied: 0 });

  const now = Date.now();
  const createdBy = `device:${device.deviceId}`;
  const statements = [];
  const queuedIds = [];
  const rejected = [];

  // Per-row rejection, matching /api/completions and for the same §5.6 reason.
  // This route used to answer a single malformed entry with a request-level
  // 400, which outbox.js reads as permanent and acts on by discarding every row
  // the request carried — so one bad entry destroyed a whole drain's worth of
  // earnings, in an append-only ledger with no way to reconstruct them.
  for (const row of entries) {
    if (!row || typeof row.id !== 'string' || !row.id) {
      rejected.push({ id: row && row.id, error: 'Each entry needs an id.' });
      continue;
    }
    if (typeof row.category !== 'string' || !row.category) {
      rejected.push({ id: row.id, error: 'Each entry needs a category.' });
      continue;
    }
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) {
      rejected.push({ id: row.id, error: 'Each entry needs a numeric amount.' });
      continue;
    }
    if (row.earnedAt !== undefined && row.earnedAt !== null && !(Number.isSafeInteger(row.earnedAt) && row.earnedAt >= 0)) {
      rejected.push({ id: row.id, error: 'earnedAt must be a millisecond timestamp.' });
      continue;
    }
    const reason = ['earned', 'adjustment', 'spend'].includes(row.reason) ? row.reason : 'earned';

    // Idempotent on the client-minted id (§5.5): a replay is a harmless no-op.
    queuedIds.push(row.id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO reward_entries (id, child_id, assignment_id, category, amount, reason, earned_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO NOTHING`
      ).bind(row.id, device.childId, row.assignmentId || null, row.category, row.amount, reason, row.earnedAt || now, createdBy)
    );
  }

  // §11.7, closed — same reasoning as /api/completions, one batch rather than a
  // per-row loop. Every row here was validated above, so a throw from the batch
  // is the database, not the entries; the whole batch is deferred for retry
  // rather than rejected, because rejecting it would discard an append-only
  // ledger's rows with no way to reconstruct them.
  const deferred = [];
  let applied = 0;
  if (statements.length > 0) {
    try {
      await env.DB.batch(statements);
      applied = statements.length;
    } catch (err) {
      const error = dbFaultMessage(err);
      for (const id of queuedIds) deferred.push({ id, error });
    }
  }
  if (deferred.length > 0 && !understandsDeferred(request)) return deferralUnsupportedResponse(deferred);
  return json({ applied, rejected, deferred });
}

async function handleStreakUpsert(request, env, device) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  // Clamped, not just type-checked: a negative streak is not a fact the child's
  // device can hold, and §3.5's columns are read straight into reports.
  const clampStreak = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
  const currentStreak = clampStreak(body.currentStreak);
  const longestStreak = Math.max(clampStreak(body.longestStreak), currentStreak);
  const lastQualifiedDate = isValidDate(body.lastQualifiedDate) ? body.lastQualifiedDate : null;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO streaks (child_id, current_streak, longest_streak, last_qualified_date, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (child_id) DO UPDATE SET
       current_streak = excluded.current_streak,
       longest_streak = excluded.longest_streak,
       last_qualified_date = excluded.last_qualified_date,
       updated_at = excluded.updated_at`
  ).bind(device.childId, currentStreak, longestStreak, lastQualifiedDate, now).run();

  return json({ ok: true });
}

// ============================================================================
// Assignment messages (Child Feedback Loop §6, SRS Management Module 13)
//
// One-way for v1: the child appends, the parent reads and marks read. There is
// no reply route and no `created_by: 'parent'` write path — that is §11.2's
// deferred scope, not an omission to be filled in opportunistically.
//
// Nothing calls these yet. The Child App composer (§6.3) and the Management
// App inbox (§6.5) are later releases; this is the API landing first so both
// can be built against something real.
// ============================================================================

async function handleMessages(request, env, device) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const messages = body && body.messages;
  if (!Array.isArray(messages)) return json({ error: 'Body must include a "messages" array.' }, 400);
  if (messages.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} messages per batch.` }, 413);
  if (messages.length === 0) return json({ applied: 0, rejected: [], deferred: [] });

  const now = Date.now();
  const createdBy = `device:${device.deviceId}`;
  const rejected = [];
  const deferred = [];

  const shaped = [];
  for (const row of messages) {
    const problem = validateMessage(row);
    if (problem) {
      rejected.push({ id: row && row.id, error: problem });
      continue;
    }
    shaped.push(row);
  }

  // The ownership check §6.2 calls for, and the one thing this route needs that
  // /api/rewards/entries does not: a device must not be able to staple a
  // message onto an assignment belonging to another child. Batched into one
  // query rather than one per row — a drain can carry MAX_BATCH of these.
  //
  // `child_id` comes from the token (§III.E). The body's assignmentId is the
  // only thing being trusted, and this is what stops it being trusted blindly.
  //
  // Rescinded assignments deliberately still count as owned. A device queues a
  // message offline and drains later; if the parent rescinded the work in
  // between, filtering on `rescinded_at IS NULL` here would reject the question
  // rather than deliver it — and Module 13 FR-6 wants it kept precisely then,
  // because "why was this taken away" is a thing a child asks.
  const owned = new Set();
  if (shaped.length > 0) {
    const ids = [...new Set(shaped.map((r) => r.assignmentId))];
    try {
      const { results } = await env.DB.prepare(
        `SELECT id FROM assignments
         WHERE child_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`
      ).bind(device.childId, ...ids).all();
      for (const r of results || []) owned.add(r.id);
    } catch (err) {
      // §11.7: the lookup itself failed, so ownership is unknown for every row.
      // Unknown is not "not owned" — deferring is the only answer that neither
      // drops a child's question nor writes one it could not verify.
      const error = dbFaultMessage(err);
      for (const r of shaped) deferred.push({ id: r.id, error });
      if (!understandsDeferred(request)) return deferralUnsupportedResponse(deferred);
      return json({ applied: 0, rejected, deferred });
    }
  }

  const statements = [];
  const queuedIds = [];
  for (const row of shaped) {
    if (!owned.has(row.assignmentId)) {
      // Deliberately the same wording handleCompletions uses for the same
      // situation, and a rejection rather than a 403: one row naming someone
      // else's assignment must not wedge the batch behind it.
      rejected.push({ id: row.id, error: 'Not found for this child.' });
      continue;
    }
    queuedIds.push(row.id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO assignment_messages (id, child_id, assignment_id, body, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO NOTHING`
      ).bind(row.id, device.childId, row.assignmentId, row.body.trim(), row.createdAt || now, createdBy)
    );
  }

  let applied = 0;
  if (statements.length > 0) {
    try {
      await env.DB.batch(statements);
      applied = statements.length;
    } catch (err) {
      const error = dbFaultMessage(err);
      for (const id of queuedIds) deferred.push({ id, error });
    }
  }

  if (deferred.length > 0 && !understandsDeferred(request)) return deferralUnsupportedResponse(deferred);
  return json({ applied, rejected, deferred });
}

async function handleMessagesQuery(url, env) {
  const childId = url.searchParams.get('childId');
  const unreadOnly = ['1', 'true'].includes(url.searchParams.get('unreadOnly'));
  const since = url.searchParams.get('since');

  // The assignment join is what makes a message identifiable in the inbox —
  // a body with no title beside it is not actionable (Module 13 FR-1). LEFT,
  // because FR-6 keeps a message readable after its assignment is rescinded,
  // and a plain join would silently drop exactly those rows.
  let sql = `SELECT m.*, a.title AS assignment_title, a.date AS assignment_date,
                    a.course_name AS assignment_course, a.rescinded_at AS assignment_rescinded_at
             FROM assignment_messages m
             LEFT JOIN assignments a ON a.id = m.assignment_id
             WHERE 1=1`;
  const params = [];
  let i = 1;
  if (childId) { sql += ` AND m.child_id = ?${i}`; params.push(childId); i++; }
  if (unreadOnly) sql += ` AND m.read_at IS NULL`;
  if (since !== null && since !== '') {
    const sinceMs = Number(since);
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
      return json({ error: 'since must be a millisecond timestamp.' }, 400);
    }
    sql += ` AND m.created_at > ?${i}`; params.push(sinceMs); i++;
  }
  // One over the cap, so a truncated answer can say so — same convention
  // handleAssignmentsQuery uses.
  sql += ` ORDER BY m.created_at DESC LIMIT ${MAX_QUERY_ROWS + 1}`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const body = capRows(results || [], 'messages');

  // The badge's number (Module 13 FR-3). Counted rather than derived from the
  // page above, which is capped and may be filtered to one child.
  const unread = await env.DB.prepare(
    childId
      ? `SELECT COUNT(*) AS n FROM assignment_messages WHERE read_at IS NULL AND child_id = ?1`
      : `SELECT COUNT(*) AS n FROM assignment_messages WHERE read_at IS NULL`
  ).bind(...(childId ? [childId] : [])).first();

  return json({ ...body, unread: (unread && unread.n) || 0 });
}

async function handleMessagesRead(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const ids = body && body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'Body must include a non-empty "ids" array.' }, 400);
  if (ids.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} ids per request.` }, 413);

  // `read_at IS NULL` in the WHERE, so a message already read keeps its
  // original timestamp rather than having it bumped by a second click. There
  // is no route that clears it: Module 13 FR-4 has no mark-unread in v1, and
  // omitting the path is how that stays true.
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE assignment_messages SET read_at = ?1
     WHERE read_at IS NULL AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`
  ).bind(now, ...ids).run();

  return json({ read: (result.meta && result.meta.changes) || 0, readAt: now });
}

// ============================================================================
// Response helpers — the only things left here that touch neither D1 nor a
// route. Everything else pure now lives in validation.js.
// ============================================================================

// Child Feedback Loop §11.7 — does this client know what `deferred` means?
//
// It is a new third answer on a route that already had two, and the difference
// between them is what the client does with the queue rows behind it: a
// `rejected` row is deleted, a `deferred` row is kept. A shell that predates
// this change reads only `rejected`, so it deletes everything a 2xx covered —
// including rows the server just said it did not write. That is silent data
// loss, and it would land in exactly the situation this feature exists for.
//
// So the new shape is opt-in. A client announces it by sending the header;
// anything that does not is answered the way it was before — a 5xx, which it
// reads as retryable and responds to by keeping the whole batch. Both ends
// upgrade independently, and neither ordering loses a row.
const OUTBOX_PROTOCOL_HEADER = 'X-Outbox-Protocol';

function understandsDeferred(request) {
  return Number(request.headers.get(OUTBOX_PROTOCOL_HEADER) || 0) >= 2;
}

// The pre-§11.7 answer, for a client that cannot read the new one. 503 rather
// than the 500 this replaced: same retryable class to every existing client,
// but honest about the fault being transient.
function deferralUnsupportedResponse(deferred) {
  return json({
    error: 'Some rows could not be written and were not applied. Retry.',
    deferred: deferred.length,
    detail: deferred[0] ? deferred[0].error : undefined,
  }, 503);
}

// The text put on a `deferred` row (Child Feedback Loop §11.7). D1's own
// message is the useful half — "no such column: completion_note" tells a
// parent exactly which migration is missing, which is the failure this
// containment was built for — so it is passed through rather than flattened
// into "database error". Bounded because it crosses the wire to a device that
// logs it; a deferral is not written to the rejection store, which records what
// was *refused*, and a row that will be retried was not.
function dbFaultMessage(err) {
  const detail = err && err.message ? String(err.message) : String(err);
  const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  return `Database error, not applied — will retry: ${trimmed}`;
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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
