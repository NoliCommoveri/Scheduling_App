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
  SLOT_SUBJECT_KINDS,
  isValidStartMin,
  isValidSlotDuration,
  isValidBlockLabel,
  isValidBlockDuration,
  isValidCourseName,
  MAX_BLOCK_LABEL_LEN,
  MAX_COURSE_NAME_LEN,
  isValidLessonId,
} from './validation.js';
// Grading Assistant §2.2/§3.2/§8.3 — the pure layer, Phase 2. rubric
// resolution, the mechanics filter, and score normalization all live here so
// they stay directly testable (tests/worker-grading-core.test.js), with no
// D1 and no network call.
import {
  resolveRubric,
  rubricToPrompt,
  resolveMechanicsFinding,
  normalizeScore,
} from './grading-core.js';

const MAX_BATCH = 500;
// Grading Assistant §4 — generous headroom under R2's free-tier 10 GB; a
// scanned answer key runs a few hundred KB to a few MB.
const MAX_ANSWER_KEY_BYTES = 20 * 1024 * 1024;
// A phone photo of a worksheet page. Generous headroom over a typical
// few-MB capture; large enough that a legitimate photo is never the reason
// this rejects, small enough to bound a malicious upload.
const MAX_GRADING_PHOTO_BYTES = 15 * 1024 * 1024;
const DEFAULT_SNAPSHOT_LIMIT = 2000;
const MAX_SNAPSHOT_LIMIT = 5000;
const PAIR_CODE_TTL_MS = 15 * 60 * 1000;
const PAIR_CODE_MAX_FAILS = 10;

// Wall Calendar Redesign §7.2 — a month view moving one month at a time never
// approaches this; it exists so a malformed or malicious window can't ask for
// an unbounded dedupe scan.
const MAX_EVENTS_WINDOW_DAYS = 62;

// Wall Display App §8.1. `devices.child_id` and `pair_codes.child_id` are both
// NOT NULL (0001:96, 0001:110) and SQLite cannot drop that in place, so a wall
// row — which is household-scoped and names no child — stores this sentinel.
// It is never a real id: those are server-minted UUIDs. `devices.scope` is
// what actually distinguishes a wall credential; on `pair_codes` the sentinel
// is the whole distinction, and it is what stops a child's pair code from
// redeeming into a household-scoped token at /api/wall/pair.
const WALL_SENTINEL_CHILD_ID = '';

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
  courseName: 'course_name', activityType: 'activity_type',
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
  activityType: 'activity_type', payload: 'payload',
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
  // Wall Display App §8.5 — what goes in the wall tablet's kiosk browser.
  if (path === '/wall') return redirect(url, '/wall-app/');
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

  // ---- Grading Assistant (Grading_Assistant §5, Phase 1) — parent only ----
  //
  // The other three §5 routes (page capture, review read-back, remediation
  // report) are Phase 3/7 — the grading call itself and the tables it reads
  // don't exist yet. This is the media half only: an answer key never enters
  // the tree (it would be world-downloadable under [assets]) and is never
  // public — Worker-mediated, token-gated, same as a photo will be.
  if (pathname === '/api/grading/keys' && method === 'POST') {
    return withParent(request, env, () => handleGradingKeyUpload(request, env, url));
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
    return withDevice(request, env, ctx, (device) => handlePlan(url, env, deviceActor(device)));
  }
  if (pathname === '/api/completions' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => withJsonBody(request, (body) =>
      handleCompletions(request, env, deviceActor(device), body)));
  }
  // Shared Chores §5.4/§5.5 — the one synchronous, arbitrated write in the
  // API (§5.6 says why this is not folded into /api/completions).
  const claimMatch = /^\/api\/assignments\/([^/]+)\/claim$/.exec(pathname);
  if (claimMatch && method === 'POST') {
    return withDevice(request, env, ctx, (device) => withJsonBody(request, (body) =>
      handleAssignmentClaim(env, deviceActor(device), claimMatch[1], body)));
  }
  if (claimMatch && method === 'DELETE') {
    return withDevice(request, env, ctx, (device) => handleAssignmentClaimRelease(env, deviceActor(device), claimMatch[1]));
  }
  if (pathname === '/api/rewards/entries' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => withJsonBody(request, (body) =>
      handleRewardEntries(request, env, deviceActor(device), body)));
  }
  if (pathname === '/api/streak' && method === 'PUT') {
    return withDevice(request, env, ctx, (device) => handleStreakUpsert(request, env, device));
  }
  if (pathname === '/api/messages' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleMessages(request, env, device));
  }

  // ---- Grading Assistant (Grading_Assistant §5, Phase 3) — child device
  // credential. §0.2: the child's own device requests grading for its own
  // assignment; child_id derives from the token exactly as every other
  // route in this section does. No new §III.E exception.
  if (pathname === '/api/grading/page' && method === 'POST') {
    return withDevice(request, env, ctx, (device) => handleGradingPageCapture(request, env, deviceActor(device), url));
  }
  const gradingReviewMatch = /^\/api\/grading\/review\/([^/]+)$/.exec(pathname);
  if (gradingReviewMatch && method === 'GET') {
    return withDevice(request, env, ctx, (device) => handleGradingReviewRead(env, deviceActor(device), gradingReviewMatch[1]));
  }

  // ---- Wall Display App (Wall §8.3) — wall credential ----
  //
  // Every route here is one of the device handlers above with `child_id`
  // resolved from a validated request parameter instead of from the token. The
  // handlers, the field maps, and the SQL are the same objects, not copies:
  // that is what keeps column ownership from widening along with child
  // selection (§8.3, CLAUDE.md §III.E bound 3).
  if (pathname === '/api/wall/pair' && method === 'POST') {
    return await handleWallPair(request, env);
  }
  if (pathname === '/api/wall/children' && method === 'GET') {
    return withWall(request, env, ctx, () => handleWallChildren(env));
  }
  if (pathname === '/api/wall/plan' && method === 'GET') {
    return withWall(request, env, ctx, (wall) =>
      withWallChild(env, wall, url.searchParams.get('childId'), (actor) => handlePlan(url, env, actor)));
  }
  if (pathname === '/api/wall/completions' && method === 'POST') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      withWallChild(env, wall, body.childId, (actor) => handleCompletions(request, env, actor, body))));
  }
  if (pathname === '/api/wall/rewards/entries' && method === 'POST') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      withWallChild(env, wall, body.childId, (actor) => handleRewardEntries(request, env, actor, body))));
  }
  const wallClaimMatch = /^\/api\/wall\/assignments\/([^/]+)\/claim$/.exec(pathname);
  if (wallClaimMatch && method === 'POST') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) => {
      // `childId` is this route family's own parameter, not part of the claim
      // body — CLAIM_BODY_KEYS is reused verbatim and would reject it as a key
      // the caller may not set, which is precisely the check worth keeping.
      const { childId, ...claimBody } = body;
      return withWallChild(env, wall, childId, (actor) =>
        handleAssignmentClaim(env, actor, wallClaimMatch[1], claimBody));
    }));
  }
  if (wallClaimMatch && method === 'DELETE') {
    // childId rides the query string on DELETE. §8.3's table gives "Body /
    // query" as one column and the release carries nothing else; a body on a
    // DELETE is legal but awkward, and an absent one would 400 as unparseable
    // JSON before the route could say anything useful.
    return withWall(request, env, ctx, (wall) =>
      withWallChild(env, wall, url.searchParams.get('childId'), (actor) =>
        handleAssignmentClaimRelease(env, actor, wallClaimMatch[1])));
  }

  // ---- Wall Calendar Redesign §12 — placements and the household events feed ----
  //
  // These five routes touch `wall_slots` / `wall_slot_days` only, never
  // `assignments` — so `withWallChild`'s active-child lookup is the wrong
  // tool here: §12's sentinel rule needs '' accepted on a chore placement,
  // and `withWallChild` 404s an empty childId. `resolveSlotChildId` below is
  // that rule's one enforcement point. `/api/wall/events` names no child at
  // all, exactly like `/api/wall/children` (CLAUDE.md §III.E) — it is
  // household-scoped by the `children.active = 1` join in its own query.
  if (pathname === '/api/wall/slots' && method === 'GET') {
    return withWall(request, env, ctx, () => handleWallSlotsGet(url, env));
  }
  if (pathname === '/api/wall/slots' && method === 'PUT') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSlotPut(env, wall, body)));
  }
  if (pathname === '/api/wall/slots' && method === 'DELETE') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSlotDelete(env, wall, body)));
  }
  if (pathname === '/api/wall/slots/day' && method === 'PUT') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSlotDayPut(env, wall, body)));
  }
  if (pathname === '/api/wall/slots/day' && method === 'DELETE') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSlotDayDelete(env, wall, body)));
  }
  if (pathname === '/api/wall/events' && method === 'GET') {
    return withWall(request, env, ctx, () => handleWallEvents(url, env));
  }

  // ---- Wall Calendar Redesign §5.5, §12 — school blocks (Phase 7) ----
  //
  // Like wall_slots/wall_slot_days above, these touch only
  // wall_school_blocks / wall_school_block_courses, never `assignments` — so
  // childId is validated against the roster directly (resolveActiveChildId),
  // not through withWallChild. Unlike a chore placement, there is NO
  // sentinel here: a block is always one child's (§12, §3.1.2's child-less
  // row problem doesn't exist for a block).
  if (pathname === '/api/wall/school-blocks' && method === 'GET') {
    return withWall(request, env, ctx, () => handleWallSchoolBlocksGet(env));
  }
  if (pathname === '/api/wall/school-blocks' && method === 'POST') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSchoolBlockPost(env, wall, body)));
  }
  const schoolBlockMatch = /^\/api\/wall\/school-blocks\/([^/]+)$/.exec(pathname);
  if (schoolBlockMatch && method === 'PUT') {
    return withWall(request, env, ctx, (wall) => withJsonBody(request, (body) =>
      handleWallSchoolBlockPut(env, wall, schoolBlockMatch[1], body)));
  }
  if (schoolBlockMatch && method === 'DELETE') {
    return withWall(request, env, ctx, () => handleWallSchoolBlockDelete(env, schoolBlockMatch[1]));
  }
  const schoolBlockCoursesMatch = /^\/api\/wall\/school-blocks\/([^/]+)\/courses$/.exec(pathname);
  if (schoolBlockCoursesMatch && method === 'PUT') {
    return withWall(request, env, ctx, () => withJsonBody(request, (body) =>
      handleWallSchoolBlockCoursePut(env, schoolBlockCoursesMatch[1], body)));
  }
  if (schoolBlockCoursesMatch && method === 'DELETE') {
    return withWall(request, env, ctx, () => withJsonBody(request, (body) =>
      handleWallSchoolBlockCourseDelete(env, schoolBlockCoursesMatch[1], body)));
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
// Returns { deviceId, childId, scope } or null. §4.2's rule that "the Worker
// derives child_id from the token, never the request body" is enforced by
// every device-scoped handler reading actor.childId rather than a query/body
// value — and by the wall routes, which are the one exception (Wall §8.3),
// resolving the named child against the roster before they build an actor.
//
// SELECT * rather than a column list, deliberately: naming `scope` explicitly
// would make this throw on a database where 0009 has not been applied yet, and
// this is the auth path — that is the Child App stopping dead, not one row
// being held back the way §11.7 contains a completion. DEPLOY.md's ordering
// note says apply first; this is what happens if the order slips anyway. A row
// from before 0009 reads as 'child', which is exactly what it is.
async function resolveDevice(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT * FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL`
  ).bind(tokenHash).first();
  if (!row) return null;
  return { deviceId: row.id, childId: row.child_id, scope: row.scope || 'child' };
}

// Who a write is attributed to (Wall §8.4). A device token names one child, so
// `device:<id>` is enough to trace a row back. One wall device writes for every
// active child, so the row itself has to say it came from the wall — it is the
// cheap half of any later "who ticked this", and it costs one string literal.
function deviceActor(device) {
  return { deviceId: device.deviceId, childId: device.childId, actorTag: `device:${device.deviceId}` };
}

function wallActor(wall, childId) {
  return { deviceId: wall.deviceId, childId, actorTag: `wall:${wall.deviceId}` };
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
//
// Wall §8.2: a wall token is 401 here too. These routes derive child_id from
// the token, and a household-scoped credential has no child to derive — so the
// existing device routes gain strictly no new callers from this slice, and the
// wall's narrowing cannot leak sideways into them.
async function withDevice(request, env, ctx, handler) {
  const device = await resolveDevice(request, env);
  if (!device || device.scope !== 'child') return json({ error: 'Unauthorized.' }, 401);
  ctx.waitUntil(touchDevice(env, device.deviceId));
  return await handler(device);
}

// Wrap a wall-only handler (Wall §8.2). The mirror image: a child device token
// is 401 on every /api/wall/* route, so the two credential classes cannot be
// substituted for one another in either direction.
//
// What this credential may do is bounded by the routes, not by trust. It widens
// *which child* may be acted for — never *what may be written*: every wall
// route below hands the request to the same handler a device token reaches,
// with the same ASSIGNMENT_COMPLETION_FIELDS allowlist and the same SQL.
async function withWall(request, env, ctx, handler) {
  const device = await resolveDevice(request, env);
  if (!device || device.scope !== 'wall') return json({ error: 'Unauthorized.' }, 401);
  ctx.waitUntil(touchDevice(env, device.deviceId));
  return await handler({ deviceId: device.deviceId });
}

function touchDevice(env, deviceId) {
  return env.DB.prepare(`UPDATE devices SET last_seen_at = ?1 WHERE id = ?2`)
    .bind(Date.now(), deviceId).run();
}

// The one exception to "the Worker derives child_id from the token, never the
// request body" (CLAUDE.md §III.E, Wall §8.3). A household-scoped credential
// cannot name a child by itself, so the wall names one — and the name is
// checked against the roster before anything touches `assignments`.
//
// Three of §III.E's four bounds live here: the child must be active, the
// handler receives the *server's* id rather than the caller's string, and every
// statement downstream keeps its own `AND child_id = ?` with that id
// substituted for the token-derived one. The fourth (cross-credential 401) is
// withDevice/withWall above. A wall token therefore cannot act for an archived
// child, cannot act for an id that is not a child at all, and cannot reach a
// row belonging to a child other than the one it named.
async function withWallChild(env, wall, childId, handler) {
  if (typeof childId !== 'string' || !childId) {
    return json({ error: 'childId is required.' }, 400);
  }
  const row = await env.DB.prepare(
    `SELECT id FROM children WHERE id = ?1 AND active = 1`
  ).bind(childId).first();
  if (!row) return json({ error: 'Not an active child.' }, 404);
  return await handler(wallActor(wall, row.id));
}

// Wall Calendar Redesign §12 — the one place this slice softens a validation,
// and the softening is narrow. `wall_slots` / `wall_slot_days` sit outside
// the child-scoping scheme entirely (CLAUDE.md §III.E), so this is not a
// fourth bound on top of withWallChild's three — it is a different table's
// own rule. Returns the resolved childId to store (the sentinel, or the
// server's own copy of a real id) or null when the id is unusable.
async function resolveSlotChildId(env, childId, subjectKind) {
  if (childId === WALL_SENTINEL_CHILD_ID) {
    // §3.1.2 — a `claim` chore's placement is one child-less row.
    // `subjectKind` can only be 'chore' by the time this runs — SLOT_SUBJECT_
    // KINDS no longer has a 'school' member (§20) — so this ternary's `: null`
    // branch is a defensive belt, not a live path.
    return subjectKind === 'chore' ? WALL_SENTINEL_CHILD_ID : null;
  }
  if (typeof childId !== 'string' || !childId) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM children WHERE id = ?1 AND active = 1`
  ).bind(childId).first();
  return row ? row.id : null;
}

// §5.5/§12 — a school block's childId, unlike a chore placement's, never
// accepts the sentinel: "no sentinel here, a block is always one child's."
// A separate helper rather than resolveSlotChildId(..., 'school') because
// that call would silently pass through the (now dead) sentinel branch above
// — this one simply never looks for it.
async function resolveActiveChildId(env, childId) {
  if (typeof childId !== 'string' || !childId) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM children WHERE id = ?1 AND active = 1`
  ).bind(childId).first();
  return row ? row.id : null;
}

// Reads the body once. The wall routes need `childId` out of it before the rest
// goes to the shared handler, and a handler that parsed the request itself
// would leave nothing for the second read.
async function withJsonBody(request, handler) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  return await handler(body || {});
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
           source_id, title, course_name, activity_type,
           payload, expected_duration_min, reward_amount, reward_category,
           block_hint, sort_order, instance_key, claim_group,
           status, assigned_at, updated_at, updated_by
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5,
           ?6, ?7, ?8, ?9,
           ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17,
           'pending', ?18, ?18, 'parent'
         WHERE NOT EXISTS (
           SELECT 1 FROM assignments
            WHERE child_id = ?2 AND date = ?3 AND kind = ?4 AND source_id = ?6
              AND instance_key = ?16
              AND rescinded_at IS NULL
         )`
      ).bind(
        id, childId, row.date, row.kind, batchId,
        row.sourceId ?? null, row.title, row.courseName ?? null, row.activityType ?? null,
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
  // Wall §3.2 — the same mint, the same alphabet, the same 15-minute TTL. A
  // wall code names no child, so it carries the §8.1 sentinel; that is what
  // /api/wall/pair checks for, and what /api/pair refuses.
  const scope = body && body.scope === 'wall' ? 'wall' : 'child';
  if (scope === 'child' && (!body || typeof body.childId !== 'string' || !body.childId)) {
    return json({ error: 'childId is required.' }, 400);
  }
  const codeChildId = scope === 'wall' ? WALL_SENTINEL_CHILD_ID : body.childId;

  const now = Date.now();
  const expiresAt = now + PAIR_CODE_TTL_MS;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomPairCode();
    try {
      await env.DB.prepare(
        `INSERT INTO pair_codes (code, child_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`
      ).bind(code, codeChildId, expiresAt, now).run();
      return json({ code, expiresAt, scope });
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

// Shared by /api/pair and /api/wall/pair (Wall §3.2). Returns a Response on
// every failure path, or { token, deviceId, childId } once the code has been
// consumed and the device row minted.
//
// `scope` is checked against the code, not merely stamped on the device: a
// child's pair code redeemed at /api/wall/pair would turn a credential meant
// for one child into one that acts for every active child, which is the one
// escalation this route family could offer. The §8.1 sentinel is what the two
// codes are told apart by, and the check runs in both directions.
async function redeemPairCode(request, env, scope) {
  if (!env.DB) return { error: json({ error: 'D1 binding "DB" is not configured on this Worker.' }, 500) };

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: json({ error: 'Body must be JSON.' }, 400) };
  }
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const label = typeof body.label === 'string' ? body.label.slice(0, 200) : null;
  if (!code) return { error: json({ error: 'code is required.' }, 400) };

  const row = await env.DB.prepare(
    `SELECT code, child_id, expires_at, consumed_at, fail_count FROM pair_codes WHERE code = ?1`
  ).bind(code).first();

  if (!row) return { error: json({ error: 'Unknown pairing code.' }, 409) };

  const isWallCode = row.child_id === WALL_SENTINEL_CHILD_ID;
  if (scope === 'wall' && !isWallCode) {
    return { error: json({ error: 'That code is for a child device, not a wall display.' }, 409) };
  }
  if (scope === 'child' && isWallCode) {
    return { error: json({ error: 'That code is for a wall display, not a child device.' }, 409) };
  }

  const now = Date.now();
  const alreadyBurned = row.fail_count >= PAIR_CODE_MAX_FAILS;
  if (row.consumed_at || alreadyBurned) {
    return { error: json({ error: 'Pairing code already used.' }, 409) };
  }
  if (row.expires_at < now) {
    await env.DB.prepare(`UPDATE pair_codes SET fail_count = fail_count + 1 WHERE code = ?1`).bind(code).run();
    return { error: json({ error: 'Pairing code expired.' }, 409) };
  }

  // Success: consume the code, mint the device.
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const deviceId = crypto.randomUUID();

  // The child INSERT deliberately does not name `scope` — the column defaults
  // to 'child', so child pairing keeps working on a database where 0009 has
  // not been applied yet. The wall INSERT names it, and therefore needs 0009;
  // that is the right way round, since nothing can want a wall token before
  // the wall app exists.
  const insertDevice = scope === 'wall'
    ? env.DB.prepare(
        `INSERT INTO devices (id, child_id, label, token_hash, created_at, scope) VALUES (?1, ?2, ?3, ?4, ?5, 'wall')`
      ).bind(deviceId, WALL_SENTINEL_CHILD_ID, label, tokenHash, now)
    : env.DB.prepare(
        `INSERT INTO devices (id, child_id, label, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(deviceId, row.child_id, label, tokenHash, now);

  await env.DB.batch([
    env.DB.prepare(`UPDATE pair_codes SET consumed_at = ?1 WHERE code = ?2 AND consumed_at IS NULL`).bind(now, code),
    insertDevice,
  ]);

  return { token, deviceId, childId: row.child_id };
}

async function handlePair(request, env) {
  const redeemed = await redeemPairCode(request, env, 'child');
  if (redeemed.error) return redeemed.error;
  const childId = redeemed.childId;

  // childName comes from the §3.2 projection, which is what that table is for:
  // reading a child's name without parsing a JSON blob. The `records` fallback
  // stays for the case where the projection has not caught up — a database
  // where 0002 has not been applied yet, or a child authored by a device that
  // has not pushed since. Pairing is not the place to discover a stale table.
  const projected = await env.DB.prepare(
    `SELECT name FROM children WHERE id = ?1`
  ).bind(childId).first();

  let childName = projected ? projected.name : null;
  if (!childName) {
    const childRecord = await env.DB.prepare(
      `SELECT value FROM records WHERE store = 'children' AND key = ?1 AND deleted = 0`
    ).bind(JSON.stringify(childId)).first();
    childName = childRecord ? (JSON.parse(childRecord.value) || {}).name || null : null;
  }

  return json({ token: redeemed.token, childId, childName });
}

// ============================================================================
// Wall Display App (Wall §8.3) — wall credential
// ============================================================================

// Unauthenticated, like /api/pair. The credential it mints is household-scoped
// and route-restricted; §3.1 records why it is neither SYNC_TOKEN nor a Worker
// secret — there is nothing for Ray to set anywhere, and revocation is the one
// click in the Devices UI that already exists.
async function handleWallPair(request, env) {
  const redeemed = await redeemPairCode(request, env, 'wall');
  if (redeemed.error) return redeemed.error;
  return json({ token: redeemed.token, deviceId: redeemed.deviceId });
}

// Wall §3.3 — the roster, read live from D1 on every poll. A child added in
// the Management App appears within one poll and an archived one disappears,
// with no wall-side action at all: that requirement is the whole reason this
// credential is household-scoped rather than per-child (§0.1).
async function handleWallChildren(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM children WHERE active = 1 ORDER BY name`
  ).all();
  return json({ children: results || [] });
}

// ============================================================================
// Wall Calendar Redesign §3, §12 — placements
// ============================================================================

// Shared by all four slot routes: the key that identifies a placement or a
// per-day override, checked before anything touches the database.
function parseSlotKey(body) {
  if (!SLOT_SUBJECT_KINDS.has(body.subjectKind)) {
    return { error: `subjectKind must be one of ${[...SLOT_SUBJECT_KINDS].join(', ')}.` };
  }
  if (typeof body.subjectKey !== 'string' || !body.subjectKey) {
    return { error: 'subjectKey is required.' };
  }
  const instanceKey = typeof body.instanceKey === 'string' ? body.instanceKey : '';
  return { subjectKind: body.subjectKind, subjectKey: body.subjectKey, instanceKey };
}

// §12 — every placement, household-wide, plus any wall_slot_days overrides
// inside the window. `wall_slots` itself carries no date (§3.3 — a placement
// is a standing default, not a per-day fact), so `from`/`to` bound only the
// day-scoped overrides; omitting them returns every override there is, which
// is "small" per §12 because overrides are rare.
async function handleWallSlotsGet(url, env) {
  const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : null;
  const to = isValidDate(url.searchParams.get('to')) ? url.searchParams.get('to') : null;

  const { results: slotRows } = await env.DB.prepare(
    `SELECT * FROM wall_slots ORDER BY child_id, subject_kind, subject_key, instance_key`
  ).all();

  let daysSql = `SELECT * FROM wall_slot_days`;
  const daysParams = [];
  if (from && to) {
    daysSql += ` WHERE date >= ?1 AND date <= ?2`;
    daysParams.push(from, to);
  }
  daysSql += ` ORDER BY date, child_id, subject_kind, subject_key, instance_key`;
  const { results: dayRows } = await env.DB.prepare(daysSql).bind(...daysParams).all();

  // Two arrays, so capRows' single `truncated`/`limit` shape would collide if
  // both were capped — named separately instead of reused generically.
  const slotsCapped = slotRows.length > MAX_QUERY_ROWS;
  const daysCapped = dayRows.length > MAX_QUERY_ROWS;
  const body = {
    slots: slotsCapped ? slotRows.slice(0, MAX_QUERY_ROWS) : slotRows,
    days: daysCapped ? dayRows.slice(0, MAX_QUERY_ROWS) : dayRows,
    from,
    to,
  };
  if (slotsCapped) body.slotsTruncated = true;
  if (daysCapped) body.daysTruncated = true;
  return json(body);
}

// §12 — upsert of the standing placement. `startMin` is required: the column
// is NOT NULL and this route is the only writer, so there is no prior value
// to preserve on a partial body. `durationMin` absent or `null` clears the
// standing override, which is what makes "Use the assigned time" (§3.5.2, a
// later phase) a one-field write.
async function handleWallSlotPut(env, wall, body) {
  body = body || {};
  const key = parseSlotKey(body);
  if (key.error) return json({ error: key.error }, 400);
  if (!isValidStartMin(body.startMin)) {
    return json({ error: 'startMin must be a multiple of 15 minutes, 0-1425.' }, 400);
  }
  const durationMin = body.durationMin === undefined ? null : body.durationMin;
  if (!isValidSlotDuration(durationMin)) {
    return json({ error: 'durationMin must be a positive multiple of 15 minutes, or null.' }, 400);
  }
  if (durationMin !== null && body.startMin + durationMin > 1440) {
    return json({ error: 'startMin + durationMin must not run past midnight.' }, 400);
  }
  const childId = await resolveSlotChildId(env, body.childId, key.subjectKind);
  if (childId === null) {
    return json({ error: 'childId must be an active child, or the shared sentinel on a chore.' }, 400);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO wall_slots (child_id, subject_kind, subject_key, instance_key, start_min, duration_min, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (child_id, subject_kind, subject_key, instance_key)
     DO UPDATE SET start_min = ?5, duration_min = ?6, updated_at = ?7, updated_by = ?8`
  ).bind(childId, key.subjectKind, key.subjectKey, key.instanceKey, body.startMin, durationMin, now, `wall:${wall.deviceId}`).run();

  return json({ ok: true });
}

// §12 — un-place; the chore returns to the tray. Also clears that subject's
// `wall_slot_days` rows: an override of a placement that no longer exists is
// unreachable garbage.
async function handleWallSlotDelete(env, wall, body) {
  body = body || {};
  const key = parseSlotKey(body);
  if (key.error) return json({ error: key.error }, 400);
  const childId = await resolveSlotChildId(env, body.childId, key.subjectKind);
  if (childId === null) {
    return json({ error: 'childId must be an active child, or the shared sentinel on a chore.' }, 400);
  }

  const result = await env.DB.prepare(
    `DELETE FROM wall_slots WHERE child_id = ?1 AND subject_kind = ?2 AND subject_key = ?3 AND instance_key = ?4`
  ).bind(childId, key.subjectKind, key.subjectKey, key.instanceKey).run();
  await env.DB.prepare(
    `DELETE FROM wall_slot_days WHERE child_id = ?1 AND subject_kind = ?2 AND subject_key = ?3 AND instance_key = ?4`
  ).bind(childId, key.subjectKind, key.subjectKey, key.instanceKey).run();

  return json({ deleted: !!(result.meta && result.meta.changes > 0) });
}

// §3.5.2 — "just this one." Same key as a placement plus a date. `durationMin`
// is required and non-null: a null row is meaningless, so clearing an
// override is DELETE, never a PUT that writes null.
async function handleWallSlotDayPut(env, wall, body) {
  body = body || {};
  const key = parseSlotKey(body);
  if (key.error) return json({ error: key.error }, 400);
  if (!isValidDate(body.date)) {
    return json({ error: 'date must be a YYYY-MM-DD date.' }, 400);
  }
  if (body.durationMin === null || !isValidSlotDuration(body.durationMin)) {
    return json({ error: 'durationMin must be a positive multiple of 15 minutes.' }, 400);
  }
  const childId = await resolveSlotChildId(env, body.childId, key.subjectKind);
  if (childId === null) {
    return json({ error: 'childId must be an active child, or the shared sentinel on a chore.' }, 400);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO wall_slot_days (child_id, subject_kind, subject_key, instance_key, date, duration_min, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (child_id, subject_kind, subject_key, instance_key, date)
     DO UPDATE SET duration_min = ?6, updated_at = ?7, updated_by = ?8`
  ).bind(childId, key.subjectKind, key.subjectKey, key.instanceKey, body.date, body.durationMin, now, `wall:${wall.deviceId}`).run();

  return json({ ok: true });
}

// §12 — clears the per-day override; the chip falls back down the chain.
async function handleWallSlotDayDelete(env, wall, body) {
  body = body || {};
  const key = parseSlotKey(body);
  if (key.error) return json({ error: key.error }, 400);
  if (!isValidDate(body.date)) {
    return json({ error: 'date must be a YYYY-MM-DD date.' }, 400);
  }
  const childId = await resolveSlotChildId(env, body.childId, key.subjectKind);
  if (childId === null) {
    return json({ error: 'childId must be an active child, or the shared sentinel on a chore.' }, 400);
  }

  const result = await env.DB.prepare(
    `DELETE FROM wall_slot_days WHERE child_id = ?1 AND subject_kind = ?2 AND subject_key = ?3 AND instance_key = ?4 AND date = ?5`
  ).bind(childId, key.subjectKind, key.subjectKey, key.instanceKey, body.date).run();

  return json({ deleted: !!(result.meta && result.meta.changes > 0) });
}

// §7.2 — inclusive day count between two YYYY-MM-DD dates, used only to bound
// /api/wall/events' window. Both strings are already isValidDate-checked, so
// a plain UTC parse is safe (no timezone ambiguity in a date-only string).
function inclusiveDaySpan(from, to) {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.floor(ms / 86400000) + 1;
}

// §7.2 — a household-wide, deduped events feed. Names no child, exactly like
// handleWallChildren above: bounded by the `children.active = 1` join, acts
// for nobody, and reads no child-owned column that could be attributed to
// one. Not a fourth exception to CLAUDE.md §III.E's four bounds — those
// govern routes that act for a named child, and this route does not act.
async function handleWallEvents(url, env) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isValidDate(from) || !isValidDate(to)) {
    return json({ error: 'from and to are required YYYY-MM-DD dates.' }, 400);
  }
  if (to < from) return json({ error: 'to must not be before from.' }, 400);
  if (inclusiveDaySpan(from, to) > MAX_EVENTS_WINDOW_DAYS) {
    return json({ error: `Window may not exceed ${MAX_EVENTS_WINDOW_DAYS} days.` }, 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT MIN(a.id) AS id, a.source_id, a.date, a.title, a.payload
       FROM assignments a
       JOIN children c ON c.id = a.child_id AND c.active = 1
      WHERE a.kind = 'event'
        AND a.rescinded_at IS NULL
        AND a.date BETWEEN ?1 AND ?2
      GROUP BY COALESCE(a.source_id, a.id), a.date
      ORDER BY a.date
      LIMIT ${MAX_QUERY_ROWS + 1}`
  ).bind(from, to).all();

  return json({ ...capRows(results, 'events'), from, to });
}

// ============================================================================
// Wall Calendar Redesign (TDS_Slice_Wall_Calendar_Redesign.md) §5.5, §12 —
// school blocks (Phase 7)
// ============================================================================

// §5.5/§12 — every school block, household-wide, plus its member courses.
// Two flat tables, joined client-side — the same shape as
// handleWallSlotsGet's slots/days split, and for the same reason:
// wall_school_blocks carries no date (§5.4 — no per-day override for a
// block's span in v1), so there is nothing here for a window to bound. A
// block is a standing placement, like everything else in this slice (§3.3).
async function handleWallSchoolBlocksGet(env) {
  const { results: blocks } = await env.DB.prepare(
    `SELECT * FROM wall_school_blocks ORDER BY child_id, start_min`
  ).all();
  const { results: blockCourses } = await env.DB.prepare(
    `SELECT * FROM wall_school_block_courses ORDER BY block_id, course_name`
  ).all();

  const blocksCapped = blocks.length > MAX_QUERY_ROWS;
  const coursesCapped = blockCourses.length > MAX_QUERY_ROWS;
  const body = {
    blocks: blocksCapped ? blocks.slice(0, MAX_QUERY_ROWS) : blocks,
    blockCourses: coursesCapped ? blockCourses.slice(0, MAX_QUERY_ROWS) : blockCourses,
  };
  if (blocksCapped) body.blocksTruncated = true;
  if (coursesCapped) body.blockCoursesTruncated = true;
  return json(body);
}

// §5.4 — the "+ School" affordance: mints a new block id and drops an empty,
// unlabeled block at the given span. `startMin`/`durationMin` share
// wall_slots PUT's exact validation shape, with one difference: a block's
// duration may never be null (isValidBlockDuration), since there is no
// assignment-authored estimate underneath it to fall back to (§3.5.1 does
// not apply to blocks, §20).
async function handleWallSchoolBlockPost(env, wall, body) {
  body = body || {};
  if (!isValidStartMin(body.startMin)) {
    return json({ error: 'startMin must be a multiple of 15 minutes, 0-1425.' }, 400);
  }
  if (!isValidBlockDuration(body.durationMin)) {
    return json({ error: 'durationMin must be a positive multiple of 15 minutes.' }, 400);
  }
  if (body.startMin + body.durationMin > 1440) {
    return json({ error: 'startMin + durationMin must not run past midnight.' }, 400);
  }
  if (!isValidBlockLabel(body.label)) {
    return json({ error: `label must be at most ${MAX_BLOCK_LABEL_LEN} characters.` }, 400);
  }
  const childId = await resolveActiveChildId(env, body.childId);
  if (!childId) return json({ error: 'childId must be an active child.' }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO wall_school_blocks (id, child_id, label, start_min, end_min, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, childId, body.label || null, body.startMin, body.startMin + body.durationMin, now, `wall:${wall.deviceId}`).run();

  return json({ id });
}

// §5.4 — moves (startMin), resizes (durationMin) or relabels (label) an
// existing block. Every field is optional and independent — only the keys
// present in the body change, the rest keep the block's current value.
// `childId` is deliberately not patchable (§12's table): moving a block
// between children isn't a modeled operation.
async function handleWallSchoolBlockPut(env, wall, id, body) {
  body = body || {};
  const existing = await env.DB.prepare(`SELECT * FROM wall_school_blocks WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ error: 'Not found.' }, 404);

  let startMin = existing.start_min;
  let durationMin = existing.end_min - existing.start_min;
  if (body.startMin !== undefined) {
    if (!isValidStartMin(body.startMin)) {
      return json({ error: 'startMin must be a multiple of 15 minutes, 0-1425.' }, 400);
    }
    startMin = body.startMin;
  }
  if (body.durationMin !== undefined) {
    if (!isValidBlockDuration(body.durationMin)) {
      return json({ error: 'durationMin must be a positive multiple of 15 minutes.' }, 400);
    }
    durationMin = body.durationMin;
  }
  if (startMin + durationMin > 1440) {
    return json({ error: 'startMin + durationMin must not run past midnight.' }, 400);
  }
  let label = existing.label;
  if (body.label !== undefined) {
    if (!isValidBlockLabel(body.label)) {
      return json({ error: `label must be at most ${MAX_BLOCK_LABEL_LEN} characters.` }, 400);
    }
    label = body.label;
  }

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE wall_school_blocks SET start_min = ?1, end_min = ?2, label = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?6`
  ).bind(startMin, startMin + durationMin, label, now, `wall:${wall.deviceId}`, id).run();

  return json({ ok: true });
}

// §5.4 — un-places the block entirely. Cascades to its
// wall_school_block_courses rows; touches no activity row (§5's write-side
// rule, unchanged — this deletes a wall-owned row, not a course's own).
async function handleWallSchoolBlockDelete(env, id) {
  const result = await env.DB.prepare(`DELETE FROM wall_school_blocks WHERE id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM wall_school_block_courses WHERE block_id = ?1`).bind(id).run();
  return json({ deleted: !!(result.meta && result.meta.changes > 0) });
}

// §5.2 — checking a box in the membership picker. Idempotent: re-adding an
// existing member is a no-op, not an error.
async function handleWallSchoolBlockCoursePut(env, id, body) {
  body = body || {};
  if (!isValidCourseName(body.courseName)) {
    return json({ error: `courseName is required, at most ${MAX_COURSE_NAME_LEN} characters.` }, 400);
  }
  const block = await env.DB.prepare(`SELECT id FROM wall_school_blocks WHERE id = ?1`).bind(id).first();
  if (!block) return json({ error: 'Not found.' }, 404);

  await env.DB.prepare(
    `INSERT INTO wall_school_block_courses (block_id, course_name) VALUES (?1, ?2)
     ON CONFLICT (block_id, course_name) DO NOTHING`
  ).bind(id, body.courseName).run();
  return json({ ok: true });
}

// §5.2 — unchecking a box. Deletes only the membership row; the course's own
// activity rows are untouched.
async function handleWallSchoolBlockCourseDelete(env, id, body) {
  body = body || {};
  if (!isValidCourseName(body.courseName)) {
    return json({ error: `courseName is required, at most ${MAX_COURSE_NAME_LEN} characters.` }, 400);
  }
  const result = await env.DB.prepare(
    `DELETE FROM wall_school_block_courses WHERE block_id = ?1 AND course_name = ?2`
  ).bind(id, body.courseName).run();
  return json({ deleted: !!(result.meta && result.meta.changes > 0) });
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

// Shared by /api/plan (child devices) and /api/wall/plan. `actor.childId` is
// token-derived on the first and roster-validated on the second; from here
// down there is no difference, which is the point.
async function handlePlan(url, env, actor) {
  const defaults = defaultPlanRange();
  const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : defaults.from;
  const to = isValidDate(url.searchParams.get('to')) ? url.searchParams.get('to') : defaults.to;
  const since = clampInt(url.searchParams.get('since'), null, 0, Number.MAX_SAFE_INTEGER);

  // Rescinded rows are included on purpose (§5.5) so the client can remove
  // them from its cache rather than never learning they were rescinded.
  let sql = `SELECT * FROM assignments WHERE child_id = ?1 AND date >= ?2 AND date <= ?3`;
  const params = [actor.childId, from, to];
  if (since !== null) {
    sql += ` AND updated_at > ?4`;
    params.push(since);
  }
  sql += ` ORDER BY date, sort_order LIMIT ${MAX_QUERY_ROWS + 1}`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ ...capRows(results, 'assignments'), from, to });
}

async function handleCompletions(request, env, actor, body) {
  const completions = body && body.completions;
  if (!Array.isArray(completions)) return json({ error: 'Body must include a "completions" array.' }, 400);
  if (completions.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} completions per batch.` }, 413);
  if (completions.length === 0) return json({ applied: 0, rejected: [] });

  const now = Date.now();
  const updatedBy = actor.actorTag;
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
      ).bind(...values, now, updatedBy, row.id, actor.childId).run();
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
    ).bind(row.id, actor.childId).first();
    if (owned && owned.claim_group != null) {
      rejected.push({ id: row.id, error: 'This assignment is shared; use /api/assignments/:id/claim instead.' });
    } else {
      rejected.push({ id: row.id, error: 'Not found for this child.' });
    }
  }

  if (deferred.length > 0 && !understandsDeferred(request)) return deferralUnsupportedResponse(deferred);
  return json({ applied, rejected, deferred });
}

// Shared Chores §5.4 — the arbitrated claim. `grade`, `completionNote` and
// (Wall Calendar Redesign §8.3.1) `completedAt`: the rest of
// ASSIGNMENT_COMPLETION_FIELDS is the route's own to set (status) or belongs
// to the ordinary local-first path (deferredTo, childBlockHint,
// childSortOrder — §5.4's field-list note).
//
// `completedAt` joins this list because the wall's completion sheet asks
// *when* a chore was finished (§8.3), and without this the claim route
// silently discarded that answer — stamping its own `Date.now()` regardless
// — while the earn route next to it already honoured a client `earnedAt`,
// so the reward ledger and the assignment row would have disagreed about
// when the work happened. See §8.3.1 and §20 revision #2.
const CLAIM_BODY_KEYS = ['grade', 'completionNote', 'completedAt'];

async function handleAssignmentClaim(env, actor, id, body) {
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
  ).bind(id, actor.childId).first();
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
  ).bind(actor.childId, now, row.claim_group).run();

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
    won = !!claimant && claimant.claimed_by === actor.childId;
    if (!won) return json({ claimed: false });
  }

  // On a win only — first-time or an idempotent replay — record the
  // completion on the caller's own row. §5.4 step 4. Wall Calendar Redesign
  // §8.3.1 — `completedAt` is now the caller's to supply (the sheet's chosen
  // time), falling back to `now` when absent so the Child App's existing
  // claim calls, which send neither key, are unaffected. `updated_at` stays
  // the server's own clock — a provenance stamp, not a value the sheet owns.
  const updatedBy = actor.actorTag;
  const completedAt = body.completedAt ?? now;
  await env.DB.prepare(
    `UPDATE assignments
        SET status = 'complete', completed_at = ?1, grade = ?2, completion_note = ?3,
            updated_at = ?4, updated_by = ?5
      WHERE id = ?6 AND child_id = ?7`
  ).bind(completedAt, body.grade ?? null, body.completionNote ?? null, now, updatedBy, id, actor.childId).run();

  const assignment = await env.DB.prepare(`SELECT * FROM assignments WHERE id = ?1`).bind(id).first();
  return json({ claimed: true, assignment });
}

// Shared Chores §5.5 — undo has to give the chore back, or a mis-tap locks a
// sibling out of work they could still do.
async function handleAssignmentClaimRelease(env, actor, id) {
  const row = await env.DB.prepare(
    `SELECT claim_group FROM assignments WHERE id = ?1 AND child_id = ?2`
  ).bind(id, actor.childId).first();
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
  ).bind(now, row.claim_group, actor.childId).run();

  if (!result.meta || result.meta.changes === 0) return json({ released: false });

  // The sibling's row is not touched beyond claimed_by/claimed_at/updated_at
  // above — it was never completed, so there is nothing on it to clear.
  const updatedBy = actor.actorTag;
  await env.DB.prepare(
    `UPDATE assignments
        SET status = 'pending', completed_at = NULL, grade = NULL, completion_note = NULL,
            updated_at = ?1, updated_by = ?2
      WHERE id = ?3 AND child_id = ?4`
  ).bind(now, updatedBy, id, actor.childId).run();

  const assignment = await env.DB.prepare(`SELECT * FROM assignments WHERE id = ?1`).bind(id).first();
  return json({ released: true, assignment });
}

async function handleRewardEntries(request, env, actor, body) {
  const entries = body && body.entries;
  if (!Array.isArray(entries)) return json({ error: 'Body must include an "entries" array.' }, 400);
  if (entries.length > MAX_BATCH) return json({ error: `At most ${MAX_BATCH} entries per batch.` }, 413);
  if (entries.length === 0) return json({ applied: 0 });

  const now = Date.now();
  const createdBy = actor.actorTag;
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
      ).bind(row.id, actor.childId, row.assignmentId || null, row.category, row.amount, reason, row.earnedAt || now, createdBy)
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
// Grading Assistant (Grading_Assistant §4, §5, Phase 1) — media only.
// The grading call itself, and the tables its proposals land in, are below.
// ============================================================================

// A parent uploads an answer key PDF for a lesson, stored at keys/{lessonId}
// — never in the tree, never public (§4). Not multipart: the whole request
// body is the file, `lessonId` rides the query string the way a placement's
// `childId` rides it on the wall's DELETE routes elsewhere in this file.
async function handleGradingKeyUpload(request, env, url) {
  if (!env.MEDIA) {
    return json({ error: 'R2 binding "MEDIA" is not configured on this Worker.' }, 500);
  }

  const lessonId = url.searchParams.get('lessonId');
  if (!isValidLessonId(lessonId)) {
    return json({ error: 'A lessonId query parameter is required.' }, 400);
  }

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/pdf')) {
    return json({ error: 'Content-Type must be application/pdf.' }, 400);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: 'Request body must not be empty.' }, 400);
  if (bytes.byteLength > MAX_ANSWER_KEY_BYTES) {
    return json({ error: `Answer key must be at most ${MAX_ANSWER_KEY_BYTES} bytes.` }, 413);
  }

  const key = `keys/${lessonId}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  return json({ ok: true, key });
}

// ============================================================================
// Grading Assistant (Grading_Assistant §5, §6, Phase 3) — the grading call.
//
// Reads the answer key and rubric context Phases 1/2 already made possible to
// store, calls the Anthropic Messages API directly over fetch (this Worker
// carries no npm runtime dependencies — package.json:5 — so raw HTTP is the
// fit, not the SDK), and writes the result to grading_reviews and
// mechanics_findings, its own two tables. It never touches assignments.grade
// — a proposal reaches `grade` only through the existing completion path,
// using exactly ASSIGNMENT_COMPLETION_FIELDS, same as any other completion
// (§0.1, CLAUDE.md §0's column-ownership row).
// ============================================================================

const GRADING_MODEL_DEFAULT = 'claude-sonnet-5';
const GRADING_MODEL_OVERRIDE = 'claude-opus-5'; // §6 — the only per-course override this route recognizes
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// §6's response shape, pinned with structured outputs rather than parsed
// from prose. `items` order is item order — no separate index field, so a
// reordered response can't silently mislabel an item. `mechanics` mirrors
// §3.2's model-reported shape exactly: the model reports, resolveMechanicsFinding
// (grading-core.js) decides what counts — never this schema.
const GRADING_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transcription: { type: 'string' },
          verdict: { type: 'string', enum: ['CORRECT', 'PARTIAL', 'INCORRECT', 'BLANK', 'UNSURE'] },
          reason: { type: 'string' },
        },
        required: ['transcription', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
    mechanics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['spelling', 'grammar'] },
          asWritten: { type: 'string' },
          intended: { type: 'string' },
          ageJudgment: { type: 'string', enum: ['expected', 'advanced'] },
        },
        required: ['kind', 'asWritten', 'intended', 'ageJudgment'],
        additionalProperties: false,
      },
    },
    feedback: { type: 'string' },
  },
  required: ['items', 'mechanics', 'feedback'],
  additionalProperties: false,
};

const GRADING_OUTPUT_INSTRUCTION =
  'Grade every item on the page against the answer key. For each item, transcribe exactly ' +
  'what the child wrote, give a verdict (CORRECT, PARTIAL, INCORRECT, BLANK, or UNSURE), and a ' +
  'short reason. Separately, list every suspected spelling or grammar issue you notice — report ' +
  'all of them, pre-filtering none. Finish with one short paragraph of feedback addressed ' +
  'directly to the child, in an encouraging tone appropriate to their grade level.';

// The `records` mirror keys every row on JSON.stringify(key) (online-revamp
// §3.1 — the same convention handlePair's fallback lookup already uses
// against the `children` store, above). Returns the parsed value, or null
// when the row is absent, deleted, or unparseable — every caller below
// treats null as "resolve nothing further," never as an error to throw.
async function readRecordValue(env, store, key) {
  const row = await env.DB.prepare(
    `SELECT value FROM records WHERE store = ?1 AND key = ?2 AND deleted = 0`
  ).bind(store, JSON.stringify(key)).first();
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

// Workers' `btoa` takes a binary string, and `String.fromCharCode(...bytes)`
// blows the call-stack argument limit past a few tens of KB — a scanned PDF
// or a phone photo both routinely exceed that. Chunking keeps every call
// inside the limit regardless of file size.
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// §2/§3 — walks assignment → activity → lesson → course to resolve the
// rubric and lesson context a grading call needs. Returns either
// `{ error: Response }` for the caller to return as-is, or the resolved
// context — kept as one function because every step depends on the last and
// none of it is useful half-resolved.
async function resolveGradingContext(env, assignment) {
  if (assignment.kind !== 'activity' || !assignment.source_id) {
    return { error: json({ error: 'Grading is only available for lesson activities.' }, 400) };
  }

  const activity = await readRecordValue(env, 'activities', assignment.source_id);
  if (!activity || !activity.lessonId) {
    return { error: json({ error: 'No activity record found for this assignment; its lesson cannot be resolved.' }, 422) };
  }

  const lesson = await readRecordValue(env, 'lessons', activity.lessonId);
  if (!lesson || !lesson.courseId) {
    return { error: json({ error: 'No lesson record found for this activity; its course cannot be resolved.' }, 422) };
  }

  const course = await readRecordValue(env, 'courses', lesson.courseId);
  if (!course) {
    return { error: json({ error: 'No course record found for this lesson.' }, 422) };
  }

  // §2's settings record — sparse, one per install, authored in a later
  // phase (§9 Phase 4). Absent today on every household; resolveRubric
  // treats a missing layer exactly like an empty one and falls through to
  // RUBRIC_DEFAULTS, so grading works before Phase 4 ships and picks up
  // authored defaults the moment it does, with no change to this route.
  const householdDefaults = await readRecordValue(env, 'meta', 'gradingDefaults');
  const rubric = resolveRubric(course.gradingRubric, householdDefaults);

  const child = await readRecordValue(env, 'children', assignment.child_id);
  const gradeLabel = (child && child.gradeLabel) || null;

  const model = course.gradingModel === GRADING_MODEL_OVERRIDE ? GRADING_MODEL_OVERRIDE : GRADING_MODEL_DEFAULT;

  return { lessonId: activity.lessonId, course, rubric, gradeLabel, model };
}

// The Anthropic call. §6's block ordering is load-bearing for the cache: the
// answer key, the resolved rubric, and the lesson context are byte-identical
// for every child doing this lesson, so the breakpoint sits after the third
// block — a household grading three children's copies of one lesson in a
// sitting pays full price once and roughly a tenth of it twice more.
//
// Thinking is explicitly disabled rather than left to run adaptive by
// default: this call carries no tools, so the "tool call written as plain
// text" failure mode disabled thinking can cause doesn't apply here, and a
// malformed response degrades cleanly to a `failed` row (the caller's JSON
// parse simply fails) rather than corrupting a grade. Effort `medium` is the
// other half of the same cost discipline this feature exists under (§0's
// narrowed free-tier row, CLAUDE.md §0): ~$7-11/month at ~240 worksheets
// assumes a mid-effort call, not `xhigh`.
async function callGradingModel(env, { model, answerKeyBase64, rubricPromptText, lessonContextText, photoBase64, photoContentType }) {
  const body = {
    model,
    max_tokens: 8000,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: answerKeyBase64 } },
          { type: 'text', text: rubricPromptText },
          { type: 'text', text: lessonContextText, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image', source: { type: 'base64', media_type: photoContentType, data: photoBase64 } },
          { type: 'text', text: GRADING_OUTPUT_INSTRUCTION },
        ],
      },
    ],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: GRADING_OUTPUT_SCHEMA } },
  };

  return fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// Writes (or replaces — §1.1: a re-grade is a draft with no ledger property
// to protect) the grading_reviews row, and appends every mechanics_findings
// row regardless of whether the household's rubric counts it (§0.4 —
// recording is decoupled from counting). `state` is 'proposed' on success,
// 'failed' on any grading-call fault; a failed row still records the attempt
// (model, rubric_digest, photo_key) so a parent or a later session can see
// an attempt happened and why it produced nothing, rather than guessing from
// an absent row.
async function saveGradingOutcome(env, { assignmentId, childId, photoKey, model, rubricDigest, state, proposedScore, verdictItems, mechanicsFindings, feedback, gradeLabel, rubric }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO grading_reviews (assignment_id, child_id, photo_key, proposed_score, items, feedback, rubric_digest, model, state, created_at, reviewed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
     ON CONFLICT (assignment_id) DO UPDATE SET
       child_id = excluded.child_id, photo_key = excluded.photo_key, proposed_score = excluded.proposed_score,
       items = excluded.items, feedback = excluded.feedback, rubric_digest = excluded.rubric_digest,
       model = excluded.model, state = excluded.state, created_at = excluded.created_at, reviewed_at = NULL`
  ).bind(
    assignmentId, childId, photoKey, proposedScore,
    verdictItems ? JSON.stringify(verdictItems) : null, feedback || null,
    rubricDigest, model, state, now
  ).run();

  if (!mechanicsFindings || mechanicsFindings.length === 0) return;

  const findingRows = mechanicsFindings.map((finding) => {
    const { counted, source } = resolveMechanicsFinding(finding, rubric, gradeLabel);
    return env.DB.prepare(
      `INSERT INTO mechanics_findings (id, child_id, assignment_id, kind, as_written, intended, counted, source, found_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(crypto.randomUUID(), childId, assignmentId, finding.kind, finding.asWritten, finding.intended, counted, source, now);
  });
  await env.DB.batch(findingRows);
}

// POST /api/grading/page — §5, §6. Upload a captured worksheet photo,
// resolve the rubric and answer key, run the grading call, and return the
// proposal. Online-required (§0.7; CLAUDE.md §III.A's third narrowing) — a
// capture made offline never reaches this handler at all; the Child App
// queues the photo in its ordinary outbox and grades on drain.
async function handleGradingPageCapture(request, env, actor, url) {
  if (!env.MEDIA) {
    return json({ error: 'R2 binding "MEDIA" is not configured on this Worker.' }, 500);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY secret is not configured on this Worker.' }, 500);
  }

  const assignmentId = url.searchParams.get('assignmentId');
  if (typeof assignmentId !== 'string' || !assignmentId) {
    return json({ error: 'An assignmentId query parameter is required.' }, 400);
  }

  // child_id is part of the WHERE, never trusted from the body (§4.2 of the
  // revamp slice — same discipline as handleCompletions above): a photo can
  // only be graded against the calling device's own assignment.
  const assignment = await env.DB.prepare(
    `SELECT id, child_id, kind, source_id, title, course_name FROM assignments
     WHERE id = ?1 AND child_id = ?2 AND rescinded_at IS NULL`
  ).bind(assignmentId, actor.childId).first();
  if (!assignment) return json({ error: 'Assignment not found for this child.' }, 404);

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    return json({ error: 'Content-Type must be an image/* type.' }, 400);
  }

  const photoBytes = await request.arrayBuffer();
  if (photoBytes.byteLength === 0) return json({ error: 'Request body must not be empty.' }, 400);
  if (photoBytes.byteLength > MAX_GRADING_PHOTO_BYTES) {
    return json({ error: `Photo must be at most ${MAX_GRADING_PHOTO_BYTES} bytes.` }, 413);
  }

  const context = await resolveGradingContext(env, assignment);
  if (context.error) return context.error;
  const { lessonId, course, rubric, gradeLabel, model } = context;

  const keyObject = await env.MEDIA.get(`keys/${lessonId}`);
  if (!keyObject) {
    return json({ error: 'No answer key has been uploaded for this lesson yet. Ask a parent to add one.' }, 422);
  }
  const answerKeyBase64 = bufferToBase64(await keyObject.arrayBuffer());

  const photoKey = `pages/${assignmentId}`;
  await env.MEDIA.put(photoKey, photoBytes, { httpMetadata: { contentType } });
  const photoBase64 = bufferToBase64(photoBytes);

  const rubricPromptText = rubricToPrompt(rubric, gradeLabel || 'not specified');
  const rubricDigest = await sha256Hex(rubricPromptText);
  const lessonContextText = `Lesson: ${assignment.title}\nCourse: ${course.name || assignment.course_name || 'unknown'}`;

  const failOutcome = (extra) => saveGradingOutcome(env, {
    assignmentId, childId: actor.childId, photoKey, model, rubricDigest, state: 'failed',
    proposedScore: null, verdictItems: null, mechanicsFindings: [], feedback: null, gradeLabel, rubric, ...extra,
  });

  let apiResponse;
  try {
    apiResponse = await callGradingModel(env, { model, answerKeyBase64, rubricPromptText, lessonContextText, photoBase64, photoContentType: contentType });
  } catch (err) {
    await failOutcome();
    return json({ error: `Could not reach the grading service: ${String((err && err.message) || err)}` }, 502);
  }

  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    await failOutcome();
    return json({ error: `Grading service error (${apiResponse.status}): ${detail.slice(0, 300)}` }, 502);
  }

  const payload = await apiResponse.json();

  if (payload.stop_reason === 'refusal') {
    await failOutcome();
    return json({ error: 'Grading was declined for this content. Try a different photo, or ask a parent to grade it directly.' }, 422);
  }

  const textBlock = (payload.content || []).find((b) => b.type === 'text');
  let parsed = null;
  try {
    parsed = textBlock ? JSON.parse(textBlock.text) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.items) || !Array.isArray(parsed.mechanics)) {
    await failOutcome();
    return json({ error: 'The grading service returned an unusable response.' }, 502);
  }

  const score = normalizeScore(parsed.items, rubric);

  await saveGradingOutcome(env, {
    assignmentId, childId: actor.childId, photoKey, model, rubricDigest, state: 'proposed',
    proposedScore: score.score, verdictItems: parsed.items, mechanicsFindings: parsed.mechanics,
    feedback: parsed.feedback, gradeLabel, rubric,
  });

  return json({
    assignmentId,
    state: 'proposed',
    score: score.score,
    outOf: score.outOf,
    items: parsed.items,
    feedback: parsed.feedback,
  });
}

// GET /api/grading/review/:assignmentId — §5. Read back a standing proposal
// for the calling device's own child.
async function handleGradingReviewRead(env, actor, assignmentId) {
  const owned = await env.DB.prepare(
    `SELECT id FROM assignments WHERE id = ?1 AND child_id = ?2`
  ).bind(assignmentId, actor.childId).first();
  if (!owned) return json({ error: 'Assignment not found for this child.' }, 404);

  const row = await env.DB.prepare(
    `SELECT assignment_id, child_id, photo_key, proposed_score, items, feedback, rubric_digest, model, state, created_at, reviewed_at
     FROM grading_reviews WHERE assignment_id = ?1`
  ).bind(assignmentId).first();
  if (!row) return json({ error: 'No grading proposal for this assignment.' }, 404);

  return json({
    review: {
      assignmentId: row.assignment_id,
      childId: row.child_id,
      proposedScore: row.proposed_score,
      items: row.items ? JSON.parse(row.items) : null,
      feedback: row.feedback,
      model: row.model,
      state: row.state,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    },
  });
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
