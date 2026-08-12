# Technical Design Specification — Slice

## Scope: Shared Chores — one Chore record, many children, two allocation modes (Management App authoring + Commit; Worker claim arbitration; Child App claim UI)

**Status:** Drafted 2026-08-12, in-session with Ray. The decisions in §0 were made in-session and
are locked; the rest of this document is the design that follows from them, drafted for review
before build starts. Per `CLAUDE.md` §II this document is what makes the feature buildable —
nothing here should be implemented until §11's open items are confirmed and §0.7's narrowing of
`CLAUDE.md` §III.A is authorized.

**Applies to:** Management App (chore authoring, Propose/Commit, reporting), the Worker (one new
table, three new columns, two new routes), and the Child App (claim interaction, planner
visibility). The two apps share the schema and the API and no JS file, per `CLAUDE.md` §I.A.

**Builds on:** `TDS_Slice_Online_Revamp.md` — the shared `assignments` table (§3.3), column-level
ownership (§4.2), server-minted opaque ids (§3.3.1), the append-only reward ledger (§3.4), and
the outbox/drain model (§8.4). This slice adds one table, three nullable columns, and two routes
in the shape that document already established. It **amends** `SRS_Management_Module_06` FR-7
(§12) and **narrows** `CLAUDE.md` §III.A for one row class (§0.7, §4.7).

---

## 0. Decisions made in this slice

1. **One Chore record, whatever the arrangement.** "Breakfast Dishes" is one row in `chores`,
   one line in the authoring list, one edit when the tier or the days change — regardless of how
   many children do it or how the occurrences are dealt out. The alternative in force today is
   one Chore record per child (SRS Module 06 FR-7), which means duplicate lines, duplicate edits,
   and no way for the system to know that two of them are the same chore.

2. **Two independent axes, not four chore types.** *Who participates* (`childIds`) and *how each
   occurrence is allocated among them* (`allocation`) are separate fields. The four arrangements
   Ray named are four points on that grid (§2.1), not four code paths.

3. **`allocation` has exactly two values: `each` and `claim`.** `each` gives every scheduled
   participant their own row, to complete and earn on independently. `claim` gives every
   participant a linked row, of which the first completion takes the reward and resolves the rest.

4. **A one-child chore is not a special case.** It is `childIds: [x]`, `allocation: 'each'` —
   the same expansion as a two-child `each`, with a shorter list. Today's private chore keeps
   working with no new machinery, and "both kids do it and both earn" costs nothing beyond
   multi-child expansion.

5. **"Days rotated" means fixed days per child, not alternating turns.** DECIDED in-session:
   Ellie has Mon/Wed/Fri, Sam has Tue/Thu/Sat. This is `allocation: 'each'` plus an optional
   per-child day restriction (§3.3), so it needs no rotation engine, no anchor date, and no
   derived turn index — and, critically, no state that Propose could re-derive differently on a
   re-run. True alternation (Ellie, Sam, Ellie, …) is **not built** and is listed in §11.

6. **A losing claim shows "Already done", never a name.** DECIDED in-session: with two children,
   a kid who did not get there first already knows who did. No sibling name is denormalized onto
   an assignment row, so no child device learns anything about another child that it does not
   already know. `claimed_by` does ship to the device (§4.2) — it is an opaque child id, and the
   device only ever compares it to its own.

7. **A `claim` chore requires a live connection to complete.** AUTHORIZATION REQUIRED — this
   narrows `CLAUDE.md` §III.A ("local writes never block on the network"). Ray's basis, in
   session: the children are online whenever they are home, and being offline means being away
   from home and not doing chores. The design reason is stronger than the practical one: for a
   `claim` row the truth genuinely is not local — only the server knows whether the sibling got
   there first — so a local commit would be a guess that has to be reversed about as often as it
   is right. §4.7 states the narrowing precisely; every other row class keeps the existing
   offline-tolerant path untouched.

8. **Only `claim` touches D1.** `each` — in all its forms, one child or several, shared days or
   per-child days — is entirely a Management App expansion change: no migration, no Worker
   change, no Child App change. This is what makes §9's phasing worth following.

---

## 1. Why a slice, not the full TDS

Three of the four arrangements Ray named are additive to the model
`TDS_Slice_Online_Revamp.md` already locked in, and need no schema at all: they are more rows in
the existing `assignments` table, produced by a Commit that already knows how to produce rows.
The fourth adds one nullable-column group and one table that follows the pattern
`commit_chunks` established — a small server-owned table whose primary key does the arbitration
a client cannot be trusted to do.

Nothing here changes an existing column's ownership, an existing route's contract, or the
outbox's drain mechanics. The one thing it does change is *when* a completion is authoritative,
for one class of row, and that is called out on its own in §4.7 rather than buried in a flow.

---

## 2. The model

### 2.1 The four arrangements

| Ray's phrasing | `childIds` | `allocation` | Per-child days | Rows per occurrence |
|---|---|---|---|---|
| Private — one kid owns it, the other never sees it | `[ellie]` | `each` | — | 1 |
| Shared name, days split between them | `[ellie, sam]` | `each` | yes | 1 (whoever's day it is) |
| Shared work, either one does it | `[ellie, sam]` | `claim` | no (§3.3) | 2, linked |
| Shared work, both do it and both earn | `[ellie, sam]` | `each` | no | 2, independent |

Read the table by its last column: allocation is a rule about how many rows an occurrence
becomes and whether they are linked. Everything else follows.

### 2.2 Chore record shape

`chores` is mirrored into D1 through the `records` store (`ALLOWED_SYNC_STORES`,
`management-app/worker/index.js:38`), so this is a JSON blob shape change and needs **no
migration**.

```
{
  id,                       // 'CHR-{token}', unchanged
  title, choreType, difficultyTier,
  notes?, blockHint?,       // unchanged
  daysOfWeek: ['Mon', …],   // the chore's recurrence — the default for every participant
  childIds: [childId, …],   // NEW — replaces `childId`. Non-empty.
  allocation: 'each'|'claim', // NEW — defaults to 'each'
  childDays?: {             // NEW, optional, `each` only (§3.3)
    [childId]: ['Mon', …]   // this participant's days; absent → daysOfWeek
  }
}
```

Validation (`management-app/js/chores.js:36`, `validateFields`):

- `childIds` non-empty; every entry resolves to an existing Child; no duplicates.
- `allocation` is one of the two values.
- `daysOfWeek` non-empty, as today (FR-1).
- `childDays`, when present: every key is in `childIds`; every value is a non-empty subset of
  `daysOfWeek`; keys absent from the map inherit `daysOfWeek`. A participant may not end up with
  an empty effective day set — that is "not participating", which is expressed by removing them
  from `childIds`.
- `childDays` is rejected when `allocation === 'claim'` (§3.3).

### 2.3 Back-compat with existing records

Every existing chore is `{ childId }` with no `allocation`. Readers normalize rather than
migrate:

```
participantsOf(chore) → chore.childIds || (chore.childId ? [chore.childId] : [])
allocationOf(chore)   → chore.allocation || 'each'
daysFor(chore, childId) → (chore.childDays && chore.childDays[childId]) || chore.daysOfWeek
```

One helper module in the Management App owns all three, and every call site goes through it —
`listChores` (`chores.js:132`), the list row (`chores.js:217`), the edit form
(`chores.js:249`), and Propose (`packet.js:277`). A save through the edit form rewrites the
record in the new shape; a chore never edited keeps its old shape and keeps working. There is no
migration pass and no dual-write window.

`listChores(childId)` becomes a membership test, which is the same change Family Events already
made (`packet.js:289` reads `ev.childIds.includes(childId)`) — the precedent for a multi-child
curriculum record in this codebase already exists and is followed here rather than reinvented.

---

## 3. Allocation `each` — no schema, no Worker, no Child App

### 3.1 Propose

`packet.js:277` today is:

```js
for (const chore of allChores.filter((c) => c.childId === childId)) {
```

It becomes a participation-and-days test:

```js
for (const chore of allChores) {
  if (!participantsOf(chore).includes(childId)) continue;
  const days = daysFor(chore, childId);
  …
  if (!days.includes(weekday(d))) continue;
```

That is the whole of it. Propose is already a per-child session (`packet.js:163`), so each
child's run independently produces the occurrences that belong to that child, and a chore whose
days are split simply yields no occurrence on the other child's days.

### 3.2 Commit

Unchanged. `assignmentFromChore` (`packet.js:507`) already snapshots `sourceId: c.id` — the
chore's curriculum id, not a per-occurrence key — so two children's rows for the same chore-day
carry the same `source_id` under different `child_id`s. The Worker's duplicate guard is keyed on
`(child_id, date, kind, source_id)` (`index.js:658`, `naturalKey`), which is per-child and
therefore already correct for this: Ellie's row and Sam's row for the same chore on the same day
are not duplicates of each other, and re-committing either range still dedupes against itself.

### 3.3 Effective days, and why `claim` does not get them

`daysFor` is the only new concept, and it exists to serve exactly one arrangement — the split
schedule (§2.1 row 2).

Per-child days are **rejected for `allocation: 'claim'`**. A claim only means something when two
or more participants are scheduled on the same occurrence; a claim chore with split days would
produce a one-row "group" on most days, where the claim is a formality and the extra machinery
buys nothing. Rather than define what a one-participant claim means, authoring forbids the
combination.

---

## 4. Allocation `claim`

### 4.1 What has to be true

- Both rows exist and are individually visible to their own child, through the existing
  `GET /api/plan` (`index.js:1030`), which is scoped by the device token's `child_id`. No child
  device ever queries another child's rows.
- Exactly one child can win, even if both tap in the same second.
- The winner earns; the loser earns nothing and never sees a reward appear and then vanish.
- The loser's row leaves their plan as *resolved*, not as *theirs* — the parent's reporting must
  credit one child, not two, and must not count the loser as having missed it.
- The arbitration happens server-side. `CLAUDE.md` is explicit that the Worker derives `child_id`
  from the token and clients are never trusted to self-limit; a child device must never write a
  sibling's row, and in this design it never does — it writes its own and the Worker resolves
  the group.

### 4.2 Schema — `migrations/0006_shared_chore_claims.sql`

Forward-only, registered in `management-app/worker/migrations.js` per `CLAUDE.md` §III.D,
applied from Settings → Database in the browser.

```sql
-- Three nullable columns on assignments. NULL claim_group = an ordinary,
-- unshared row, which is every row that exists today.
ALTER TABLE assignments ADD COLUMN claim_group TEXT;
ALTER TABLE assignments ADD COLUMN claimed_by   TEXT;      -- child_id of the winner
ALTER TABLE assignments ADD COLUMN claimed_at   INTEGER;

CREATE INDEX IF NOT EXISTS idx_assign_claim_group
  ON assignments (claim_group) WHERE claim_group IS NOT NULL;

-- The group identity, minted and owned by the server.
--
-- This table exists so that `claim_group` can be an opaque server-minted UUID
-- (§3.3.1) rather than a key derived from the chore and the date. A derived key
-- would be simpler by one table — and would be the exact pattern the revamp
-- repealed: `CHR-{token}-{date}` was a chore id and a date concatenated, and
-- §3.3.1 repealed it. Re-introducing that shape under a new column name is not
-- a smaller change, it is the same mistake with better manners.
--
-- The primary key is what makes two independent per-child Commits agree on one
-- group without coordinating: both INSERT OR IGNORE the same (source_id, date),
-- and SQLite arbitrates. Either order, any number of re-runs, one group.
CREATE TABLE IF NOT EXISTS claim_groups (
  source_id  TEXT NOT NULL,   -- the chore's curriculum id
  date       TEXT NOT NULL,   -- YYYY-MM-DD, the occurrence
  id         TEXT NOT NULL,   -- server-minted UUID — the value in assignments.claim_group
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, date)
);
```

`GET /api/plan` is `SELECT *` (`index.js:1038`), so all three columns reach the child device
with no route change.

### 4.3 Group resolution at Commit

`ASSIGNMENT_CREATE_FIELDS` (`index.js:49`) gains one parent-owned key: `shared` (boolean).
`assignmentFromChore` sets `shared: true` when the chore's allocation is `claim`.

`handleAssignmentsCreate` resolves groups **before** it builds its insert statements, because
D1's `batch()` is a transaction whose results cannot be read mid-flight:

1. Collect `(sourceId, date)` for every row in the chunk with `shared: true` and a non-null
   `sourceId`. A shared row with no `sourceId` is rejected 400 — it has no identity to group on.
2. One batch of `INSERT INTO claim_groups (…) VALUES (…) ON CONFLICT DO NOTHING`, one statement
   per distinct pair, each carrying a freshly minted `crypto.randomUUID()`.
3. One `SELECT source_id, date, id FROM claim_groups WHERE (source_id, date) IN …` to read back
   whichever id won — this device's, or the one the sibling's Commit already stored.
4. Build the assignment inserts as today, with `claim_group` bound from that map.

Two extra round trips per chunk that contains shared chores, and none for a chunk that does not.
The existing `commit_chunks` idempotency (§3.8) is untouched: a replayed chunk still short-
circuits before any of this runs.

`claim_groups` rows are never deleted. A rescinded-and-regenerated occurrence resolves to the
same group id it had before, which is the correct answer — it is the same occurrence.

### 4.4 `POST /api/assignments/:id/claim` — device credential

Body: the same child-owned completion fields the batch route accepts, so a win is recorded in
one round trip:

```json
{ "grade": 95, "completionNote": "…" }   // both optional
```

Validated through the existing `validateCompletionValue` (`worker/validation.js:72`) against
`ASSIGNMENT_COMPLETION_FIELDS` minus `status`/`completedAt`/`deferredTo` — those are the route's
to set, not the caller's.

Steps:

1. `SELECT claim_group, status, rescinded_at, claimed_by FROM assignments WHERE id=?1 AND child_id=?2`,
   with `child_id` from the token and never the body. Not found → 404.
   `claim_group IS NULL` → 400, this row is not claimable and the caller should have used
   `/api/completions`.
   `rescinded_at IS NOT NULL` → 409, the parent pulled it.
2. **The arbitration**, one statement:
   ```sql
   UPDATE assignments
      SET claimed_by = ?1, claimed_at = ?2, updated_at = ?2
    WHERE claim_group = ?3 AND claimed_by IS NULL
   ```
   This writes **every** row in the group — the caller's and the sibling's — in one statement, so
   the loser's row learns the outcome at the same instant, with no second write to race against.
   `meta.changes > 0` → this caller won.
3. `changes === 0` → someone already holds it. Re-read `claimed_by`. If it equals this caller's
   `child_id`, this is a replay of a request that already succeeded and is answered as a win
   (idempotent). Otherwise the caller lost.
4. On a win only, a second statement records the completion on the caller's own row:
   `status='complete', completed_at=?, grade=?, completion_note=?, updated_by='device:<id>'`.

Responses:

```json
{ "claimed": true,  "assignment": { …the caller's updated row… } }
{ "claimed": false }
```

`claimed: false` is a 200, not an error: losing a race is a normal outcome of a correct request,
and every 4xx/5xx in this app's client code is a retry-or-discard decision (`outbox.js`) that
would be wrong here.

Step 2 and step 4 are deliberately **not** one batch. A batch cannot branch on step 2's result,
and running step 4 unconditionally would mark a loser complete. The failure window between them
is safe in both directions: a caller holding the claim with `status='pending'` still sees the row
on their own plan (§5.3's rule keys on `claimed_by` versus *self*, not on presence), and tapping
again re-enters at step 3, matches its own `claimed_by`, and completes.

### 4.5 `DELETE /api/assignments/:id/claim` — release

Undo (Child Feedback Loop §3.3) has to give the chore back, or a mis-tap locks a sibling out of
work they could still do.

```sql
UPDATE assignments
   SET claimed_by = NULL, claimed_at = NULL, updated_at = ?1
 WHERE claim_group = ?2 AND claimed_by = ?3
```

`claimed_by = ?3` is the authorization: only the current claimant can release, and a caller who
already lost the race releases nothing (`changes === 0` → 200 with `{ "released": false }`).
On release the caller's own row is returned to `status='pending'`, `completed_at=NULL`,
`grade=NULL`, `completion_note=NULL` — the same field set `undoItem` already clears
(`child-app/js/completion.js:127`).

The reward reversal is unchanged and stays on the existing path: `undoItem` appends a
compensating negative `reward_entries` row, which is what `CLAUDE.md` §III.C requires of an
append-only ledger. Nothing about a claim makes a ledger row mutable.

### 4.6 Why not `/api/completions`

The batch route drains an outbox: many rows, per-row rejection, replay-safe, and — by design —
asynchronous with respect to the tap that produced each row (`index.js:1050`). A claim is the
opposite on every axis: one row, an answer the UI needs *before* it can decide what to show, and
a result that is neither "applied" nor "rejected" but "someone else got it". Folding it in would
mean a fourth response category, a version negotiation to introduce it safely (the
`understandsDeferred` shape at `index.js:1136`), and an outbox that sometimes needs its answer
synchronously. A separate route costs a route.

`/api/completions` gains one guard: a row whose `claim_group IS NOT NULL` is rejected per-row
with "use /api/assignments/:id/claim". That keeps a stale client from resolving a shared chore
through the unarbitrated path.

### 4.7 Online-required — the narrowing of `CLAUDE.md` §III.A

§III.A says: *"Local writes never block on the network. A completion commits locally and drains
later."* For a `claim` row, this slice says instead: **the claim is the write, and it is
synchronous.** Nothing is committed locally until the server answers.

Scope of the narrowing, stated precisely so it cannot spread:

- It applies to rows with `claim_group IS NOT NULL`, and to no others.
- Activities, events, private chores, and `each` chores — including multi-child `each` — keep the
  existing local-first path with no change.
- Deferment, waive, block/order overrides, notes, and messages keep the existing local-first
  path **even on a claim row**: none of them is contended, so none of them needs arbitrating.
- The Child App still opens from cache offline, still renders the last known plan, and still
  drains everything else. A claim chore is one disabled button, not a broken app.

This is a narrowing, not a repeal, and it needs Ray's authorization before Phase 3 is built
(§9). If it is refused, the fallback is the provisional-credit design — local commit, optimistic
reward, compensating reversal when the drain reports a loss — which is buildable on the same
schema and routes, and is described in §11.4 rather than here because it is not what was chosen.

---

## 5. Child App

### 5.1 The tap

`planner-ui.js:856` calls `Completion.completeItem(item, grade, rawNote)`. That call site does
not change; `completeItem` (`completion.js:59`) branches at the top:

- `item.claim_group == null` → today's path, unchanged, byte for byte.
- otherwise → `Claim.take(item, grade, note)`: disable the control, `POST …/claim`, await.
  - `claimed: true` → the existing local writes run exactly as they do now: `activityRecords`
    row, `rewardEntries` earn row, streak recheck. The completion is **not** enqueued to the
    outbox — the server already has it, and a queued duplicate would be a second write of the
    same fields under a different path. The reward entry **is** enqueued as normal: it is
    client-minted, idempotent on its id (§5.5), and the claim route does not write the ledger.
  - `claimed: false` → no local record, no ledger row, no streak call. Apply the server's answer
    to the cached row (`DB.setAssignmentFields`, `db.js:423`) with `claimed_by` set to a
    non-self value, and re-render. The kid sees "Already done" (§0.6).

### 5.2 Losing

Because nothing was written before the answer, losing is not a reversal — there is nothing to
reverse. This is the whole payoff of §0.7, and the reason no compensating ledger entry, no
outbox response category, and no `undoItem` re-use appear anywhere in the losing path.

### 5.3 Planner visibility

`AssignmentCore.isPlannable` (`assignment-core.js:77`) gains one clause:

```js
function isPlannable(row, selfChildId) {
  if (row.claimed_by != null && row.claimed_by !== selfChildId) return false;
  return (row.status || "pending") === "pending" && row.rescinded_at == null;
}
```

`toState(rows, selfChildId)` threads it through, and `DB.loadState` (`db.js:336`) reads the id
from `syncMeta.childId`, which pairing already stores (`pairing.js:66`).

Comparing against self rather than testing `claimed_by != null` is deliberate. The row-only rule
would be *almost* right — a winner's own row also carries `status='complete'` — but it breaks in
the §4.4 window where a claim is held and the completion has not landed, and it breaks again on
release. An explicit identity test has no such edge, and `selfChildId` is already on the device.

`decorateById` (`assignment-core.js:164`) keeps its no-filter contract: the Completed view and
the CSV export join records back to rows and must still find a lost row in order to label it.

### 5.4 Streak — free

`StreakCore.requiredDueOn` (`streak-core.js:18`) filters rows for `required === true`, and a
chore is always `required` (`assignment-core.js:111`). A lost claim row would therefore be "due
and unresolved" — a broken streak for the kid who did not get there first, which is exactly
wrong.

No change is needed. `streak.js:11` reads its rows from `DB.loadState()`, which is `toState`'s
already-filtered output, so a row dropped by §5.3 never reaches `requiredDueOn` at all. The kid
who lost the race keeps their streak, and the kid who won keeps theirs. This is worth an
acceptance check (§10.7) precisely because it works by construction and could be broken by a
future caller that reads raw rows.

### 5.5 Undo

The Completed view's Undo (`completion.js:100`) branches the same way `completeItem` does: on a
row with a `claim_group` it calls `DELETE …/claim` first and only proceeds with the local
reversal if the release succeeds. A failed release leaves the completion standing, with a
"try again" message — the alternative is a local un-complete against a claim the server still
holds, which would show the chore as available to a kid who cannot actually claim it.

### 5.6 Offline

A `claim` row's completion control is disabled whenever the device is offline, with a short
label: *"Shared chore — needs the internet."* Offline is read from `navigator.onLine` plus the
last sync outcome (`syncMeta.lastError`, `plan-sync.js:106`), which is already maintained. A
claim attempted anyway — the connection dropped between render and tap — fails with the same
message and no local write.

---

## 6. Column and table ownership — additions to Online Revamp §4.2

| Column / table | Owner | Written by |
|---|---|---|
| `assignments.claim_group` | parent | Commit only (`POST /api/assignments`). Never patched, never cleared. |
| `assignments.claimed_by` | **server** | The claim and release routes only. Neither credential may set it directly — it is not in `ASSIGNMENT_CREATE_FIELDS`, `ASSIGNMENT_PATCH_FIELDS`, or `ASSIGNMENT_COMPLETION_FIELDS`. |
| `assignments.claimed_at` | **server** | As above. |
| `claim_groups` (all) | **server** | `handleAssignmentsCreate` only. Insert-only; never updated, never deleted. |

`claimed_by` is a third ownership class this table has not had before: parent-owned and
child-owned columns are disjoint by construction (§4.2), and this one is neither — it is derived
by the Worker from a race between two credentials. It is listed here rather than folded into
either block so that the disjointness claim stays literally true.

---

## 7. Management App — authoring UI

One line per chore, as today. The list row (`chores.js:217`) shows participants instead of a
single name, and the arrangement:

```
Breakfast Dishes   Ellie, Sam   Kitchen/Dining   Mon–Fri   Either can claim   [Edit] [Delete]
```

The edit and create forms (`chores.js:249`, `chores.js:292`) replace the `<select name="childId">`
with:

- a checkbox list of active children (`Children.activeOnly`, as the Propose form already uses at
  `packet.js:800`);
- a two-radio **Arrangement** control, shown only when more than one child is checked:
  *"Each child does their own"* / *"Either child can claim it — first one earns the reward"*;
- a **"Same days for everyone"** checkbox, checked by default, shown only for *Each* with more
  than one child. Unchecking it reveals one day-grid per checked child, seeded from the chore's
  `daysOfWeek` (§2.2's `childDays`).

Archived children are not offered, matching `packet.js:797`. A participant removed from a chore
stops generating future occurrences and touches nothing already committed — the same rule
SRS Module 06 §2.5 already states for deletion.

---

## 8. Reporting

`reporting.js` buckets rows by `status` and excludes rescinded-and-pending rows from the
scorable denominator (`reporting.js:66`, `isRescinded`). A lost claim row is `status='pending'`
forever, so without a change it would count against the sibling's completion rate as work they
never did.

Add a sibling bucket alongside the existing one, in the same shape:

```js
function isClaimedElsewhere(row, childId) {
  return row.claimed_by != null && row.claimed_by !== childId;
}
```

Such a row is counted in a new `claimedBySibling` total, excluded from `scorable`, and excluded
from `pending`. The per-course rollup's synthetic chore bucket (`reporting.js:102`) gets the same
treatment. The CSV export's status column (`reporting.js:161`) reports `claimed-by-sibling`,
sitting beside the existing `rescinded` synthetic value.

---

## 9. Build phasing

Ordered so that each phase is independently shippable and none leaves a half-state in a database
a family is using. Each is a session or less; per `CLAUDE.md` §V.A the whole is not.

**Phase 1 — `each`, multi-child.** `chores.js` record shape, normalizing helpers, validation,
authoring UI; `packet.js:277` participation-and-days expansion; `listChores` membership. No
migration, no Worker change, no Child App change. Delivers arrangements 1, 2, and 4 of §2.1 —
three of the four — on their own.

**Phase 2 — the claim, server side.** Migration `0006`, registered; `claim_groups` resolution in
`handleAssignmentsCreate`; the claim and release routes; the `/api/completions` guard; the
`shared` create field. `tests/` covers the pure additions (validation, the group-key collection)
per `CLAUDE.md` §I.B. Nothing calls the new routes yet — the same ordering discipline
`0005_assignment_messages.sql` used, and for the same reason.

**Phase 3 — the claim, clients.** Requires §0.7 authorized. `allocation: 'claim'` in authoring
and `shared: true` in the Commit projection; the Child App claim/release calls, `isPlannable`
threading, offline button state; reporting's sibling bucket.

Phase 2 must be deployed and its migration applied before Phase 3's Commit can write a shared
row. That is the same hazard `TDS_Slice_Child_Feedback_Loop` §5.5 documented for
`completion_note`, with the same mitigation: the column-bearing release ships first, alone.

---

## 10. Acceptance checks

Run against a real database from the browser, per `CLAUDE.md` §IV.C.

1. A chore with one child and `allocation: 'each'` generates and commits exactly as it does
   today — the pre-existing private-chore path is unchanged.
2. A chore with two children and `each` commits two rows per occurrence, one per child, with
   different `child_id` and the same `source_id`. Both children complete independently and both
   ledgers gain an entry.
3. A chore with two children, `each`, and split `childDays` commits exactly one row per
   occurrence, to the child whose day it is. The other child's plan does not show it.
4. Re-running Propose and Commit over the same range for either child inserts nothing new
   (`skipped` equals the row count) — §6.6's guard still holds with multi-child chores.
5. A `claim` chore commits two rows per occurrence carrying the **same** `claim_group`, and the
   two per-child Commits produce that same value in either order.
6. Two devices claiming the same occurrence: exactly one gets `claimed: true`. The loser's next
   plan poll shows the row gone from their plan and labelled "Already done" in Completed. Exactly
   one `reward_entries` row exists for the occurrence.
7. The losing child's streak for that day is `resolved`, not `breaking`.
8. The winner's Undo releases the claim; the occurrence returns to both children's plans; the
   winner's ledger carries a compensating negative entry and the balance is back where it started.
9. A child device attempting `POST /api/completions` on a `claim_group` row is rejected per-row,
   and the rest of its batch still applies.
10. A child device attempting to set `claimed_by` through any route is rejected.
11. A device token for child A cannot claim, release, or read child B's row (404, not 403 —
    matching §5.6's existing shape).
12. Airplane mode: the claim control is disabled with its message; every other completion on the
    plan still commits locally and drains on reconnect.
13. Reporting over a range containing a resolved claim credits exactly one child and counts the
    other as neither pending nor missed.
14. `migrations/0006_shared_chore_claims.sql` applies cleanly on an empty database and on the
    live one, from Settings → Database, with no CLI.

---

## 11. Open items — deferred, not decided here

1. **True alternation.** §0.5 chose fixed per-child days. Alternating turns (Ellie, Sam, Ellie…)
   would need a derived turn index and an anchor date, and would raise a question this design
   does not have to answer: what happens to the sequence when `daysOfWeek` is edited mid-term.
   Not built.
2. **Rescinding a shared occurrence.** Rescind is `batch_id`-scoped (§6.3), and two children's
   rows for one occurrence come from two different Commits and therefore two different batches.
   Pulling a shared chore back is currently two rescind actions. Whether rescind should also
   accept a `claim_group` is a real question and is out of scope here.
3. **Changing `allocation` on a chore with live rows.** Editing a chore to or from `claim`
   affects only future generation; already-committed rows keep the arrangement they were
   committed under. This is consistent with SRS Module 06 §2.5 but has not been walked through
   for the case where one occurrence is mid-claim.
4. **The provisional-credit fallback**, if §0.7 is refused: local commit on tap, optimistic
   reward, and a compensating reversal driven by a new outbox response category when the drain
   reports the claim lost. Same schema, same routes, materially worse UX (a reward that appears
   and then disappears). Recorded so the choice is not re-litigated from scratch.
5. **Three or more participants.** The design is N-ary throughout — `childIds`, the arbitration
   statement, and the group table all work unchanged — but nothing has been tested past two, and
   §0.6's "no name needed" reasoning explicitly depends on there being two.
6. **A parent-side view of who claimed what.** Reporting counts it (§8); there is no screen that
   shows a parent the claim history for a chore over a week.

---

## 12. SRS amendments required

- **`SRS_Management_Module_06_Chore_Authoring.md` FR-7** — *"Single-child only. A Chore belongs
  to exactly one Child (`childId`) and cannot be shared across multiple children. A household
  chore two kids both do is two separate Chore records"* — is **repealed** by §0.1/§2.2. The
  replacement: a Chore names one or more participating Children (`childIds`) and an allocation
  rule. Its §5 field table gains `childIds`, `allocation`, and `childDays`, and loses `childId`.
- **`SRS_Management_Module_06` §2.5** (deletion does not recall delivered content) is unchanged
  and now also covers removing a participant from a chore.
- **`CLAUDE.md` §III.A** — narrowed for `claim_group` rows only, per §0.7/§4.7. The Quick
  Reference entry "Online-first, offline-tolerant — LOCKED" stands; this adds one row class where
  a specific write is online-required, and does not touch the general guarantee.
- **`CLAUDE.md` §VII** gains one row: *Shared chore claims — LOCKED — server-arbitrated,
  online-required, `each`/`claim` allocation on a single Chore record.*
