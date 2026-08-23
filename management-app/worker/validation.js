/* Pure helpers for the Worker — no D1, no Request, no Response.
 *
 * Split out of index.js for the same reason the Child App has its `*-core.js`
 * files: these are the decisions worth exercising directly, and index.js cannot
 * be imported by a test because it pulls in migrations.js, which imports `.sql`
 * files that only Wrangler's Text loader understands (§3.7.2).
 *
 * Nothing here touches the network or the database. If a function in this file
 * ever needs `env`, it belongs back in index.js.
 */

// ---- dates (§3.3: `date` and `deferred_to` are YYYY-MM-DD TEXT) ----

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---- child-owned column values (§4.2.1) ----

// §3.3's status domain. Enforced rather than documented because the two ends
// read it differently and both break on a value outside it: the child's planner
// drops any row that is not 'pending' (assignment-core's isPlannable) and §6.3's
// rescind SQL only touches rows that still are, so one nonsense status would
// take a row off the kid's plan AND lock the parent out of pulling it back, with
// no screen in either app able to undo it.
export const COMPLETION_STATUSES = new Set(['pending', 'complete', 'waived']);

// A block hint is a label the child picked, not free storage.
export const MAX_BLOCK_HINT_LEN = 200;

// Child Feedback Loop §5.2 — long enough for "I did problems 1-10, skipped
// 11, wasn't sure how" without being an open text dump.
export const MAX_NOTE_LEN = 1000;

// Child Feedback Loop §6.2, confirmed 2026-08-12 — deliberately shorter than a
// completion note. A message is a question ("I don't understand problem 7"),
// not the account of finished work a note carries, and the inbox is a list a
// parent scans rather than reads.
export const MAX_MESSAGE_LEN = 500;

// One message as `POST /api/messages` accepts it. Returns an error string, or
// null when the row is acceptable — same contract as validateCompletionValue,
// so handleMessages can reject per row the way every other device batch route
// does (§5.6). Ownership of `assignment_id` is *not* checked here: it needs a
// database round trip, so the route does it (§6.2).
export function validateMessage(row) {
  if (!row || typeof row !== 'object') return 'Each message must be an object.';
  if (typeof row.id !== 'string' || !row.id) return 'Each message needs an id.';
  if (typeof row.assignmentId !== 'string' || !row.assignmentId) {
    return 'Each message needs an assignmentId.';
  }
  if (typeof row.body !== 'string') return 'body must be a string.';
  // Trimmed before measuring and before storing: a body of spaces is not a
  // question, and the child's composer should not be able to queue one.
  const body = row.body.trim();
  if (!body) return 'body must not be empty.';
  if (body.length > MAX_MESSAGE_LEN) return `body must be at most ${MAX_MESSAGE_LEN} characters.`;
  if (row.createdAt !== undefined && row.createdAt !== null
      && !(Number.isSafeInteger(row.createdAt) && row.createdAt >= 0)) {
    return 'createdAt must be a millisecond timestamp.';
  }
  return null;
}

// §4.2 puts the Worker, not the client, in charge of what a credential may
// write. That was read narrowly as *which columns*, and the child's values went
// in unchecked while every parent-supplied value was validated. Same rule, same
// enforcement point: a device is scoped, not trusted.
//
// Returns an error string, or null when the value is acceptable. `null` is
// always allowed — clearing a deferment or a grade is a real write.
export function validateCompletionValue(key, value) {
  if (value === null) return null;

  switch (key) {
    case 'status':
      if (!COMPLETION_STATUSES.has(value)) {
        return `status must be one of ${[...COMPLETION_STATUSES].join(', ')}.`;
      }
      return null;
    case 'completedAt':
      if (!Number.isSafeInteger(value) || value < 0) {
        return 'completedAt must be a millisecond timestamp.';
      }
      // Wall Calendar Redesign §8.3.1 — the not-in-the-future bound has to
      // live here, not only in the wall's completion sheet, because this
      // function is the one place both /api/completions-style routes and
      // the claim route already run every completedAt value through.
      return value <= Date.now() ? null : 'completedAt must not be in the future.';
    case 'grade':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : 'grade must be a finite number.';
    case 'deferredTo':
      return isValidDate(value) ? null : 'deferredTo must be a YYYY-MM-DD date.';
    case 'childBlockHint':
      if (typeof value !== 'string') return 'childBlockHint must be a string.';
      return value.length <= MAX_BLOCK_HINT_LEN
        ? null
        : `childBlockHint must be at most ${MAX_BLOCK_HINT_LEN} characters.`;
    case 'childSortOrder':
      return Number.isSafeInteger(value) ? null : 'childSortOrder must be a whole number.';
    case 'completionNote':
      if (typeof value !== 'string') return 'completionNote must be a string.';
      return value.length <= MAX_NOTE_LEN
        ? null
        : `completionNote must be at most ${MAX_NOTE_LEN} characters.`;
    default:
      // Unreachable: the caller has already checked the key against
      // ASSIGNMENT_COMPLETION_FIELDS. Refuse rather than fall through, so a
      // column added to that map without a rule here fails closed.
      return `No validation rule for ${key}.`;
  }
}

// ---- wall placements (Wall Calendar Redesign §3.2, §12) ----

// 'school' is REMOVED as of the 2026-08-15 §5 revision (§20): a school block
// is now a span holding several member courses, which doesn't fit
// wall_slots' singleton (child_id, subject_kind, subject_key, instance_key)
// key. School blocks get their own tables (§5.5) instead — wall_slots ends
// up used for 'chore' only.
export const SLOT_SUBJECT_KINDS = new Set(['chore']);

// A placement's clock position: minutes from local midnight, snapped to the
// 15-minute grid (§4.3). `1440` itself (midnight of the next day) is excluded
// — a placement lives on exactly one day's grid.
export function isValidStartMin(value) {
  return Number.isInteger(value) && value >= 0 && value < 1440 && value % 15 === 0;
}

// A duration override on `wall_slots` or `wall_slot_days` (§3.5.1's rows 1-2
// of the precedence chain). `null` is always valid — it is how a standing
// `wall_slots` override is cleared, returning a chip to the assignment's own
// estimate.
//
// An OVERRIDE row may carry a null here too (Placement Scopes §4.1, Phase 2):
// `wall_slot_days` and `wall_slot_weekdays` each hold an independent start and
// duration, and a row that moves a chore without re-timing it has a null
// duration. What stays true is that a row overriding NOTHING is meaningless —
// both routes reject both-null and DELETE is how a level goes away. The same
// positive-multiple-of-15 shape applies whenever a value is present.
export function isValidSlotDuration(value) {
  if (value === null) return true;
  return Number.isInteger(value) && value > 0 && value % 15 === 0;
}

// ---- placement scopes (Placement_Scopes §2.1, §2.3, §4.3, Phase 1) ----

// The weekday level of the placement chain, shared by chores
// (`wall_slot_weekdays`) and school blocks (`wall_school_block_weekdays`).
// 0 = Sunday .. 6 = Saturday, matching §6's Sunday-first week so the number in
// the table and the column on screen are the same number.
//
// The Worker NEVER derives a weekday — it stores and returns what the client
// sends (§2.3). That is deliberate: `new Date("2026-08-23")` parses as UTC
// midnight, which is the previous day in every timezone west of Greenwich, so
// a server-side conversion would be wrong for exactly the household this is
// built for and right in every test run under UTC. There is one
// implementation, it is `TimeCore.weekdayOf`, and it is client-side. This
// helper only checks the range.
export function isValidWeekday(value) {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

// A start-time override at the weekday or occurrence level (§2.1 rows 1-2).
// Unlike `wall_slots.start_min` — NOT NULL, and its presence IS the placement
// (§2.1 row 4) — an override level may say nothing, and `null` is how it says
// so. Mirrors how isValidSlotDuration already treats a nullable override.
export function isValidStartMinOverride(value) {
  return value === null || isValidStartMin(value);
}

// ---- school blocks (Wall Calendar Redesign §5.5, §12, Phase 7) ----

// A block's label is optional and cosmetic only (§5.1.1) — not a key, just a
// display string swapped for "School" when absent. Bounded so nobody
// free-types a paragraph into a chip read from two metres.
export const MAX_BLOCK_LABEL_LEN = 60;

export function isValidBlockLabel(value) {
  if (value === null || value === undefined) return true; // NULL = render as "School"
  return typeof value === 'string' && value.length <= MAX_BLOCK_LABEL_LEN;
}

// A block's span is required at creation (§5.4) — unlike wall_slots'
// duration_min, which is allowed to be null to CLEAR a standing override
// (§3.5.1), a block with no duration is meaningless. Same 15-minute grid,
// null excluded.
export function isValidBlockDuration(value) {
  return isValidSlotDuration(value) && value !== null;
}

// A course name snapshot, matching an activity row's own denormalized
// course_name (§5.2.1) — the only course identity either row carries.
export const MAX_COURSE_NAME_LEN = 200;

export function isValidCourseName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_COURSE_NAME_LEN;
}

// ---- school block scopes (Placement_Scopes §2.2, §2.2.1, §4.3, Phase 1) ----

// A block's span at ANY level resolves as a pair, never column by column
// (§2.2): both set, or both NULL. `start_min` and `end_min` are two ends of
// one span, not two independent facts the way a chore's start and duration
// are, and mixing levels can compose `end_min <= start_min` — which the grid's
// absolute positioning, §4.4's bucketing and the early/late strips all treat
// as impossible. Resolving as a pair makes that unrepresentable rather than
// merely validated against.
//
// `end_min` may be 1440 (midnight) — it is an END, so unlike isValidStartMin's
// exclusive bound it may name the close of the day. That is also why this does
// not simply call isValidStartMin twice.
// `undefined` is REJECTED, not treated as null. §4.1's full-row PUT says an
// omitted field is written NULL, so it is the route's job to normalize
// `undefined -> null` before calling — exactly as handleWallSlotPut already
// does for `durationMin`. Doing it here instead would let a body with a
// misspelled key validate as "clear the span", which is the one outcome a
// typo should never quietly produce.
export function isValidBlockSpan(startMin, endMin) {
  if (startMin === null && endMin === null) return true;      // inherit the level below
  if (!isValidStartMin(startMin)) return false;
  if (!Number.isInteger(endMin) || endMin % 15 !== 0) return false;
  if (endMin > 1440) return false;
  return endMin > startMin;
}

// §2.2.1 — `occurs` decides a single date outright, in both directions:
// 0 skips a scheduled day, 1 adds an unscheduled one. Checked STRICTLY, not
// for truthiness: a body carrying "0" or false is a client bug, and coercing
// it would turn that bug into a silently skipped school day.
export function isValidOccurs(value) {
  return value === 0 || value === 1;
}

// The cross-field rule for a date row, kept here beside the two helpers it
// composes rather than inline in the route, so the one rule that spans columns
// is testable at the same boundary as the ones that do not (§8, test 7a).
//
// A SKIPPED DAY HAS NO TIME: `occurs: 0` carrying a span is rejected rather
// than accepted-and-ignored, because a stored span nobody reads is a fact
// waiting to be believed by a later reader of the table.
// `occurs` is required here even though the column defaults to 1 (§3.3's
// DDL). The default exists so a row written by some future path still means
// "happens"; it is not a licence for the route to accept a body that omits
// the field, since under §4.1 an omitted field means NULL and NULL is not a
// valid `occurs`. Phase 2's route sends what the body carried and 400s if
// that is not 0 or 1.
export function isValidBlockDateException(occurs, startMin, endMin) {
  if (!isValidOccurs(occurs)) return false;
  if (!isValidBlockSpan(startMin, endMin)) return false;
  if (occurs === 0 && !(startMin === null && endMin === null)) return false;
  return true;
}

// ---- grading assistant (Grading_Assistant §1.1, §5, Phase 1) ----

// A lesson id, same "opaque, nothing parses it" treatment CLAUDE.md's ID rule
// gives every other identifier here — bounded so nobody turns the R2 key into
// a path-traversal vector or a multi-KB query string.
export const MAX_LESSON_ID_LEN = 200;

export function isValidLessonId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LESSON_ID_LEN;
}

// ---- curriculum mirror (§5.1) ----

export function validateChange(change) {
  if (!change || typeof change !== 'object') return 'Each change must be an object.';
  if (typeof change.store !== 'string' || !change.store) return 'change.store must be a non-empty string.';
  if (typeof change.key !== 'string') return 'change.key must be a string.';
  if (change.op !== 'put' && change.op !== 'delete') return 'change.op must be "put" or "delete".';
  return null;
}

// `records.key` is JSON.stringify of the IndexedDB key, so a child's key is a
// quoted string. Used only as the fallback when a delete carries no value.
export function keyToId(key) {
  try {
    const parsed = JSON.parse(key);
    return typeof parsed === 'string' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

// ---- migrations (§3.7.4) ----

// Strips `--` comments (whole-line and trailing), then splits on `;`.
// Sufficient for this project's migrations (plain DDL, no semicolons or `--`
// inside string literals) without pulling in a SQL parser for a Worker
// script. Trailing comments matter here because several column comments
// contain their own semicolon (e.g. "-- JSON record; NULL when deleted = 1"),
// which a whole-line-only stripper would leave in the statement text.
export function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---- query bounds ----

// Cap on rows returned by a single query route (§5.2's GET, §5.5's plan fetch).
export const MAX_QUERY_ROWS = 5000;

// A child's whole school year is a few thousand rows, so nothing legitimate
// reaches this cap — but "nothing legitimate" is not a bound, and an unbounded
// SELECT * is one bad date range away from a response D1's free tier will not
// serve. Truncation is reported, never silent.
export function capRows(results, key) {
  const rows = results || [];
  const truncated = rows.length > MAX_QUERY_ROWS;
  const body = { [key]: truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows };
  if (truncated) {
    body.truncated = true;
    body.limit = MAX_QUERY_ROWS;
  }
  return body;
}

export function clampInt(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ---- pairing codes (§4.3) ----

export const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford32, minus 0/1 too
// Largest multiple of the alphabet length that fits in a byte. Bytes at or above
// it are redrawn rather than folded with `%`, which would make the first
// 256 % 30 = 16 letters marginally likelier than the rest.
export const PAIR_CODE_BYTE_CEILING = 256 - (256 % PAIR_CODE_ALPHABET.length);

// Rejection sampling, per the constant above. The bias `%` alone would introduce
// is small, but this is the credential that stands between a stranger and a
// child's plan, and unbiased is two lines.
export function randomPairCode() {
  let code = '';
  const bytes = new Uint8Array(16);
  while (code.length < 8) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= PAIR_CODE_BYTE_CEILING) continue;
      code += PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length];
      if (code.length === 8) break;
    }
  }
  return code;
}

// ---- credentials (§4.1) ----

export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  let diff = bufA.length ^ bufB.length;
  const len = Math.max(bufA.length, bufB.length);
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i] || 0) ^ (bufB[i] || 0);
  }
  return diff === 0;
}
