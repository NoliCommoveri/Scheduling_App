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
      return Number.isSafeInteger(value) && value >= 0
        ? null
        : 'completedAt must be a millisecond timestamp.';
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
