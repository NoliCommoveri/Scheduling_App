# Technical Design Specification — Slice

## Scope: Shared Chores — one Chore record, many children, many occurrences a day, two allocation modes (Management App authoring + Commit; Worker claim arbitration; Child App claim UI)

**Status:** Drafted 2026-08-12, in-session with Ray. The decisions in §0 were made in-session and
are locked; the rest of this document is the design that follows from them, drafted for review
before build starts. Per `CLAUDE.md` §II this document is what makes the feature buildable —
nothing here should be implemented until §13's open items are confirmed and §0.8's narrowing of
`CLAUDE.md` §III.A is authorized.

**Applies to:** Management App (chore authoring, Propose/Commit, reporting), the Worker (one new
table, four new columns, two new routes), and the Child App (claim interaction, planner
visibility, Completed view). The two apps share the schema and the API and no JS file, per
`CLAUDE.md` §I.A.

**Builds on:** `TDS_Slice_Online_Revamp.md` — the shared `assignments` table (§3.3), column-level
ownership (§4.2), server-minted opaque ids (§3.3.1), the append-only reward ledger (§3.4), and
the outbox/drain model (§8.4). This slice adds one table, four columns, and two routes in the
shape that document already established. It **amends** `SRS_Management_Module_06` FR-1 and FR-7
(§14) and **narrows** `CLAUDE.md` §III.A for one row class (§0.8, §5.7).

---

## 0. Decisions made in this slice

1. **One Chore record, whatever the arrangement.** "Breakfast Dishes" is one row in `chores`,
   one line in the authoring list, one edit when the tier or the days change — regardless of how
   many children do it or how the occurrences are dealt out. The alternative in force today is
   one Chore record per child (SRS Module 06 FR-7), which means duplicate lines, duplicate edits,
   and no way for the system to know that two of them are the same chore.

2. **One Chore record, however many times a day it happens.** Ray's working arrangement today is
   three Chore records — Breakfast Dishes, Lunch Dishes, Dinner Dishes — which is the same
   duplication §0.1 removes across *children*, repeated across *times of day*. A Chore recurs on
   its days once per **instance**, defaulting to one (§2.2, §3).

3. **Two independent axes, not four chore types.** *Who participates* (`childIds`) and *how each
   occurrence is allocated among them* (`allocation`) are separate fields. The four arrangements
   Ray named are four points on that grid (§2.1), not four code paths.

4. **`allocation` has exactly two values: `each` and `claim`.** `each` gives every scheduled
   participant their own row, to complete and earn on independently. `claim` gives every
   participant a linked row, of which the first completion takes the reward and resolves the rest.

5. **A one-child chore is not a special case.** It is `childIds: [x]`, `allocation: 'each'` —
   the same expansion as a two-child `each`, with a shorter list. Today's private chore keeps
   working with no new machinery, and "both kids do it and both earn" costs nothing beyond
   multi-child expansion.

6. **"Days rotated" means fixed days per child, not alternating turns.** DECIDED in-session:
   Ellie has Mon/Wed/Fri, Sam has Tue/Thu/Sat. This is `allocation: 'each'` plus an optional
   per-child day restriction (§4.3), so it needs no rotation engine, no anchor date, and no
   derived turn index — and, critically, no state that Propose could re-derive differently on a
   re-run. True alternation (Ellie, Sam, Ellie, …) is **not built** and is listed in §13.

7. **A losing claim shows "Already done", never a name.** DECIDED in-session: with two children,
   a kid who did not get there first already knows who did. No sibling name is denormalized onto
   an assignment row, so no child device learns anything about another child that it does not
   already know. `claimed_by` does ship to the device (§5.2) — it is an opaque child id, and the
   device only ever compares it to its own.

8. **A `claim` chore requires a live connection to complete.** AUTHORIZATION REQUIRED — this
   narrows `CLAUDE.md` §III.A ("local writes never block on the network"). Ray's basis, in
   session: the children are online whenever they are home, and being offline means being away
   from home and not doing chores. The design reason is stronger than the practical one: for a
   `claim` row the truth genuinely is not local — only the server knows whether the sibling got
   there first — so a local commit would be a guess that has to be reversed about as often as it
   is right. §5.7 states the narrowing precisely; every other row class keeps the existing
   offline-tolerant path untouched.

9. **Only `claim` needs arbitration.** `each` — in all its forms, one child or several, shared
   days or per-child days — is entirely a Management App expansion change: no Worker change, no
   Child App change. Instances (§0.2) need one column and a key change, and nothing else. This
   is what makes §11's phasing worth following.

---

## 1. Why a slice, not the full TDS

Three of the four arrangements Ray named are additive to the model
`TDS_Slice_Online_Revamp.md` already locked in, and need no schema at all: they are more rows in
the existing `assignments` table, produced by a Commit that already knows how to produce rows.
Multiple occurrences a day need one column, because they change what "the same thing on the same
day" means and that phrase is the duplicate guard's whole content. The fourth arrangement adds
one nullable-column group and one table that follows the pattern `commit_chunks` established — a
small server-owned table whose primary key does the arbitration a client cannot be trusted to do.

Nothing here changes an existing column's ownership, an existing route's contract, or the
outbox's drain mechanics. The one thing it does change is *when* a completion is authoritative,
for one class of row, and that is called out on its own in §5.7 rather than buried in a flow.

---

## 2. The model

### 2.1 The four arrangements

| Ray's phrasing | `childIds` | `allocation` | Per-child days | Rows per occurrence |
|---|---|---|---|---|
| Private — one kid owns it, the other never sees it | `[ellie]` | `each` | — | 1 |
| Shared name, days split between them | `[ellie, sam]` | `each` | yes | 1 (whoever's day it is) |
| Shared work, either one does it | `[ellie, sam]` | `claim` | no (§4.3) | 2, linked |
| Shared work, both do it and both earn | `[ellie, sam]` | `each` | no | 2, independent |

Read the table by its last column: allocation is a rule about how many rows an occurrence
becomes and whether they are linked. Everything else follows. The `instances` axis (§0.2)
multiplies every row of this table and interacts with none of it: three instances a day give a
private chore three occurrences, and a `claim` chore three independent claims (§3.4).

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
  childDays?: {             // NEW, optional, `each` only (§4.3)
    [childId]: ['Mon', …]   // this participant's days; absent → daysOfWeek
  },
  instances?: [             // NEW (§3) — occurrences per day. Absent → one.
    { id, label?, blockHint? }
  ]
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
- `childDays` is rejected when `allocation === 'claim'` (§4.3).
- `instances`, when present: non-empty; every `id` unique within the chore, non-empty, and
  containing no `-` (§3.2); every `blockHint`, where given, one of `BLOCK_HINTS` — the same
  check the chore's own `blockHint` already gets at `chores.js:53`.

### 2.3 Back-compat with existing records

Every existing chore is `{ childId }` with no `allocation` and no `instances`. Readers normalize
rather than migrate:

```
participantsOf(chore) → chore.childIds || (chore.childId ? [chore.childId] : [])
allocationOf(chore)   → chore.allocation || 'each'
daysFor(chore, childId) → (chore.childDays && chore.childDays[childId]) || chore.daysOfWeek
instancesOf(chore)    → chore.instances || [{ id: '' }]
```

One helper module in the Management App owns all four, and every call site goes through it —
`listChores` (`chores.js:132`), the list row (`chores.js:217`), the edit form
(`chores.js:244`), Propose (`packet.js:277`), and the child cascade (`children.js:104`). A save
through the edit form rewrites the record in the new shape; a chore never edited keeps its old
shape and keeps working. There is no migration pass and no dual-write window.

`instancesOf`'s single-element default is what lets §3 have one code path rather than two: a
chore with no `instances` is a chore with one instance whose id is the empty string, which is
exactly the value `instance_key` defaults to in the schema (§3.1).

`listChores(childId)` becomes a membership test, which is the same change Family Events already
made (`packet.js:289` reads `ev.childIds.includes(childId)`) — the precedent for a multi-child
curriculum record in this codebase already exists and is followed here rather than reinvented.
That precedent is followed for *reads only*; §4.4 says why the cascade-delete half of it is not
a precedent worth copying.

### 2.4 Why instances need ids, and not counts or ordinals

An occurrence's identity is `(child_id, date, kind, source_id)`, mirrored in three places that
must agree: `naturalKey` (`worker/index.js:711`), the `WHERE NOT EXISTS` guard
(`worker/index.js:656`), and the client-side `keyOf` (`packet.js:108`). Three rows from one chore
on one day are **identical** under that key. Committing them would leave one row: the in-chunk
`liveKeys.add(key)` (`index.js:630`) drops the second and third before SQL runs, and the SQL
guard would drop them again.

So the key needs a fourth component, and that component has to be **stable across
regenerations** — that is the entire basis of the §6.6 guard.

A positional ordinal (`0, 1, 2`) is not stable. Deleting *Lunch* from
`[Breakfast, Lunch, Dinner]` slides Dinner to index 1, which is Lunch's committed key: the live
Lunch row now blocks Dinner from inserting, and the row that survives still reads "Lunch". That
is a silent wrong answer of exactly the kind §6.6 was landed to prevent, and it would surface
weeks later as a chore that quietly stopped being assigned.

A **stable id minted once at authoring time** is stable under every edit: reorder, mid-list
delete, and rename all leave existing identities alone.

A bare count is deliberately not offered either. It would throw away the one thing Ray's current
three-record workaround gets right: on the child's planner, "Dishes / Dishes / Dishes" is worse
than what he has now, and the labels are what make the instances distinguishable.

```
instances: [
  { id: 'i1', label: 'Breakfast', blockHint: 'morning'   },
  { id: 'i2', label: 'Lunch',     blockHint: 'afternoon' },
  { id: 'i3', label: 'Dinner',    blockHint: 'evening'   }
]
```

- **Absent** means one unlabeled occurrence per day — today's behavior exactly, and what every
  existing chore record keeps. There is no backfill.
- `id` is minted at authoring time, unique within the chore, and **never reused or reassigned**.
  It is opaque and only ever compared for equality.
- `label` is optional. When present the projected title is `"{chore.title} — {label}"`,
  snapshotted at assign time like every other denormalized column (Online Revamp §3.3). Renaming
  a label later leaves committed rows reading what they read when they were assigned, which is
  the intended behavior of a snapshot, not a defect.
- `blockHint` is optional and overrides the chore's own for that occurrence — which is what makes
  the three dishes land in three different parts of the kid's day.

---

## 3. Occurrence identity — `migrations/0006_chore_instances.sql`

Forward-only, registered in `management-app/worker/migrations.js` per `CLAUDE.md` §III.D,
applied from Settings → Database in the browser.

### 3.1 Schema

```sql
ALTER TABLE assignments ADD COLUMN instance_key TEXT NOT NULL DEFAULT '';
```

`NOT NULL DEFAULT ''` rather than a nullable column, and the choice is load-bearing:
`NULL = NULL` is never true in SQLite, and the existing guard already relies on that property for
`source_id` (`index.js:656`). A nullable `instance_key` would make the `NOT EXISTS` subquery
never match for single-occurrence chores, silently disabling the duplicate guard for every chore
that exists today. An empty string compares cleanly, so old rows, single-occurrence chores, and
activities and events all share one code path with no `COALESCE`.

SQLite permits `ADD COLUMN … NOT NULL` when the default is a non-null constant, and existing rows
read the default — so this is a metadata-only change with no table rewrite.

No new index. `loadLiveAssignmentKeys` (`index.js:721`) is already an indexed range scan on
`idx_assign_child_date`; it gains one column in its `SELECT` list and nothing in its `WHERE`.

### 3.2 The key, site by site

**Worker** (`management-app/worker/`):

| Site | Change |
|---|---|
| `ASSIGNMENT_CREATE_FIELDS` (`index.js:49`) | add `instanceKey: 'instance_key'`. Parent-owned; never patchable, never child-writable. |
| `naturalKey` (`index.js:711`) | `` `${date} ${kind} ${sourceId} ${instanceKey}` `` |
| the `NOT EXISTS` guard (`index.js:656`) | add `AND instance_key = ?N` |
| `loadLiveAssignmentKeys` (`index.js:738`) | select `instance_key`, feed it to `naturalKey` |
| insert column list (`index.js:643`) | add `instance_key`, bound from `row.instanceKey ?? ''` |

**Management App** (`management-app/js/packet.js`):

| Site | Change |
|---|---|
| `keyOf` (`:108`) | fourth component, mirroring `naturalKey` exactly |
| `loadCommittedKeys`, D1 branch (`:133`) | key on `row.instance_key` |
| `loadCommittedKeys`, log fallback (`:150`) | recover the instance from the occurrence id (below) |
| Step 2 reproduce (`:240`) | carry the parsed instance onto the reproduced item |
| Step 4 expansion (`:277`) | inner loop over `instancesOf(chore)`, one item per instance per day |
| `assignmentFromChore` (`:507`) | set `instanceKey`; apply the instance's `label` to the title and its `blockHint` |

The Generation Log's per-occurrence id is `CHR-{token}-{YYYYMMDD}-{instanceId}`, with the
suffix omitted for a chore with no `instances`. This is why §2.2 forbids `-` in an instance id:
the two existing parse sites read `itemId.split('-')[1]` to recover the chore token
(`packet.js:154`, `packet.js:242`), and a fourth segment leaves that index untouched while a
hyphen inside the id would not. The chore token itself is six characters of `[a-z0-9]`
(`chores.js:19`), so it has never contained one either — the instance id is held to the rule the
token already meets. `decisionItemIds` (`packet.js:206`) then suppresses a dropped instance
individually rather than the whole day's set, which is the behavior a parent dropping one of
three dishes expects.

Note that this id lives only in `generationLog` — local scheduling history — and never becomes
an assignment id. Online Revamp §3.3.1's repeal of derived ids is untouched: `assignments.id`
stays a server-minted UUID, and `instance_key` is an opaque authoring value, not a parsed one.

`generationLog`'s keyPath is `['childId', 'itemId']` (`storage.js:159`), so two children's log
rows for the same chore occurrence coexist rather than collide. Multi-child expansion (§4)
depends on that and does not have to arrange it.

### 3.3 Editing the instance list

| Edit | Effect |
|---|---|
| Add an instance | Regeneration inserts only the new occurrence; the others dedupe against themselves. |
| Remove an instance | Future generation stops emitting it. Already-committed rows stay live — generation never retracts; the parent rescinds. Same rule as SRS Module 06 §2.5. |
| Reorder | Nothing. Identity is the id, not the position. This is the point of §2.4. |
| Rename a label | Committed rows keep their snapshotted title; future rows get the new one. |
| Change a `blockHint` | Same — committed rows keep what they were assigned with. |

### 3.4 Ordering, against the rest of this slice

`instance_key` ships **before** the claim work, and the reason is a SQLite limitation rather
than a preference: `claim_groups` is keyed `(source_id, date, instance_key)` (§5.2), and SQLite
cannot alter a primary key. Built the other way round, adding the column later would mean a
create-copy-drop-rename migration on a table already holding live groups. Built in this order,
the table is created correctly once and never touched again.

Sort order within a day is unchanged. `projectAssignments` (`packet.js:540`) already numbers by
position as it walks, and instances are walked in array order, so their relative order is stable
across runs.

---

## 4. Allocation `each` — no schema, no Worker, no Child App

### 4.1 Propose

`packet.js:277` today is:

```js
for (const chore of allChores.filter((c) => c.childId === childId)) {
```

It becomes a participation-and-days test with an instance loop inside it:

```js
for (const chore of allChores) {
  if (!participantsOf(chore).includes(childId)) continue;
  const days = daysFor(chore, childId);
  for (const d of rangeDates) {
    if (!days.includes(weekday(d))) continue;
    for (const inst of instancesOf(chore)) {
      …
```

That is the whole of it. Propose is already a per-child session (`packet.js:163`), so each
child's run independently produces the occurrences that belong to that child, and a chore whose
days are split simply yields no occurrence on the other child's days.

### 4.2 Commit

Unchanged apart from `instanceKey` (§3.2). `assignmentFromChore` (`packet.js:507`) already
snapshots `sourceId: c.id` — the chore's curriculum id, not a per-occurrence key — so two
children's rows for the same chore-day carry the same `source_id` under different `child_id`s.
The Worker's duplicate guard is keyed on `(child_id, date, kind, source_id, instance_key)`
(`index.js:656`), which is per-child and therefore already correct for this: Ellie's row and
Sam's row for the same chore on the same day are not duplicates of each other, and re-committing
either range still dedupes against itself.

### 4.3 Effective days, and why `claim` does not get them

`daysFor` is the only new concept in this section, and it exists to serve exactly one arrangement
— the split schedule (§2.1 row 2).

Per-child days are **rejected for `allocation: 'claim'`**. A claim only means something when two
or more participants are scheduled on the same occurrence; a claim chore with split days would
produce a one-row "group" on most days, where the claim is a formality and the extra machinery
buys nothing. Rather than define what a one-participant claim means, authoring forbids the
combination.

### 4.4 Removing a participant, and deleting a child

Removing a child from `childIds` stops future occurrences for that child and touches nothing
already committed — the same rule SRS Module 06 §2.5 already states for deletion.

Deleting a Child is the case that needs stating, because the code that handles it today cannot
be left as it is. `cascadeDeleteChild` (`children.js:104`) deletes every chore whose `childId`
matches:

```js
for (const c of chores.filter((c) => c.childId === childId)) t.objectStore('chores').delete(c.id);
```

Against the §2.2 record shape that line is wrong twice over. A new-shape chore has no `childId`
at all, so it survives the cascade carrying a `childIds` entry that no longer resolves. And the
obvious repair — testing `participantsOf(chore).includes(childId)` — deletes a chore Ellie and
Sam share when Ellie is deleted, taking Sam's half of it with her.

The rule is **prune, then delete when empty**:

```js
for (const c of chores) {
  const rest = participantsOf(c).filter((id) => id !== childId);
  if (rest.length === 0) t.objectStore('chores').delete(c.id);
  else if (rest.length !== participantsOf(c).length) {
    t.objectStore('chores').put(pruneParticipant(c, childId)); // also drops childDays[childId]
  }
}
```

`pruneParticipant` rewrites the record in the new shape, drops the departing child's `childDays`
entry, and leaves `allocation` alone — a `claim` chore that falls to one participant keeps
generating, as a group of one, which §5.4 resolves correctly and §13.5 flags as untested past two
in the other direction.

This is the one place where the Family Events precedent §2.3 leans on must **not** be followed.
`children.js:115` deletes an entire Family Event when any one of its `childIds` is deleted, which
is the same data loss described above and is a real defect in Module 07. Fixing it is out of
scope for this slice — it is a different module with its own SRS — but it is named here so that
"do what events do" is not read as an instruction at this call site.

---

## 5. Allocation `claim` — `migrations/0007_shared_chore_claims.sql`

### 5.1 What has to be true

- Both rows exist and are individually visible to their own child, through the existing
  `GET /api/plan` (`index.js:1030`), which is scoped by the device token's `child_id`. No child
  device ever queries another child's rows.
- Exactly one child can win, even if both tap in the same second.
- The winner earns; the loser earns nothing and never sees a reward appear and then vanish.
- The loser's row leaves their plan as *resolved*, not as *theirs*, and says so somewhere the kid
  can see (§6.2). The parent's reporting must credit one child, not two, and must not count the
  loser as having missed it.
- One occurrence pays once, across every regeneration of it (§5.4).
- The arbitration happens server-side. `CLAUDE.md` is explicit that the Worker derives `child_id`
  from the token and clients are never trusted to self-limit; a child device must never write a
  sibling's row, and in this design it never does — it writes its own and the Worker resolves
  the group.

### 5.2 Schema

Forward-only, registered in `management-app/worker/migrations.js` per `CLAUDE.md` §III.D,
applied from Settings → Database in the browser. It follows `0006` (§3.4).

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
-- group without coordinating: both INSERT OR IGNORE the same triple, and SQLite
-- arbitrates. Either order, any number of re-runs, one group.
CREATE TABLE IF NOT EXISTS claim_groups (
  source_id    TEXT NOT NULL,  -- the chore's curriculum id
  date         TEXT NOT NULL,  -- YYYY-MM-DD, the occurrence
  instance_key TEXT NOT NULL,  -- §3; '' for a chore with one occurrence a day
  id           TEXT NOT NULL,  -- server-minted UUID — the value in assignments.claim_group
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (source_id, date, instance_key)
);
```

`GET /api/plan` is `SELECT *` (`index.js:1038`), so all three columns reach the child device
with no route change.

### 5.3 Group resolution at Commit

`ASSIGNMENT_CREATE_FIELDS` (`index.js:49`) gains one parent-owned key: `shared` (boolean).
`assignmentFromChore` sets `shared: true` when the chore's allocation is `claim`.

`handleAssignmentsCreate` resolves groups **before** it builds its insert statements, because
D1's `batch()` is a transaction whose results cannot be read mid-flight:

1. Collect `(sourceId, date, instanceKey)` for every row in the chunk with `shared: true` and a
   non-null `sourceId`, `instanceKey` defaulting to `''`. A shared row with no `sourceId` is
   rejected 400: it has no identity to group on.
2. One batch of `INSERT INTO claim_groups (…) VALUES (…) ON CONFLICT DO NOTHING`, one statement
   per distinct triple, each carrying a freshly minted `crypto.randomUUID()`.
3. One `SELECT source_id, date, instance_key, id FROM claim_groups WHERE …` to read back
   whichever id won — this device's, or the one the sibling's Commit already stored.
4. Build the assignment inserts as today, with `claim_group` bound from that map.

Two extra round trips per chunk that contains shared chores, and none for a chunk that does not.
The existing `commit_chunks` idempotency (§3.8) is untouched: a replayed chunk still short-
circuits before any of this runs.

`claim_groups` rows are never deleted. An occurrence that is rescinded and generated again
resolves to the same group id it had before, which is the right answer — it is the same
occurrence, and §5.4's arbitration is written so that it pays once across both generations.

### 5.4 `POST /api/assignments/:id/claim` — device credential

Body: the child-owned completion fields a win records, so it lands in one round trip:

```json
{ "grade": 95, "completionNote": "…" }   // both optional
```

`grade` and `completionNote` only. Each is validated through the existing
`validateCompletionValue` (`worker/validation.js:72`) under its own key. The rest of
`ASSIGNMENT_COMPLETION_FIELDS` is not accepted here: `status`, `completedAt` and `deferredTo` are
the route's to set rather than the caller's, and `childBlockHint`/`childSortOrder` are planner
overrides that have nothing to do with resolving a race — they keep the ordinary local-first path
(§5.7).

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
    WHERE claim_group = ?3
      AND rescinded_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM assignments held
         WHERE held.claim_group = ?3
           AND held.rescinded_at IS NULL
           AND held.claimed_by IS NOT NULL
      )
   ```
   This writes **every** live row in the group — the caller's and the sibling's — in one
   statement, so the loser's row learns the outcome at the same instant, with no second write to
   race against. `meta.changes > 0` → this caller won.

   The `NOT EXISTS` is what makes an occurrence pay once rather than once per generation. The
   narrower predicate — `AND claimed_by IS NULL`, per row — is correct only while every row in a
   group is of one generation, and §5.3 guarantees the opposite: rescind Ellie's row, regenerate
   it, and the group holds a live claimed row belonging to Sam alongside a fresh unclaimed one
   belonging to Ellie. Under the per-row predicate Ellie claims a second time and earns a second
   reward for one morning's dishes. Under this one the group is held until every live row in it
   is released or rescinded, which is what "somebody already did this" means. It remains a single
   statement, so it remains atomic: SQLite serializes writers, and the second of two simultaneous
   claims evaluates its subquery against the first's committed effect.

   `rescinded_at IS NULL` in the outer `WHERE` keeps a tombstone from being stamped with a
   claimant it never had, which would otherwise be the second way a regenerated group goes wrong.
3. `changes === 0` → someone already holds it. Re-read the group's live claimant:
   `SELECT claimed_by FROM assignments WHERE claim_group=?1 AND rescinded_at IS NULL AND claimed_by IS NOT NULL LIMIT 1`.
   If it equals this caller's `child_id`, this is a replay of a request that already succeeded and
   is answered as a win (idempotent). Otherwise the caller lost. Reading the group rather than the
   caller's own row is what makes the replay test survive a regeneration: the caller's fresh row
   is unclaimed even when the caller is the one holding the group.
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
on their own plan (§6.3's rule keys on `claimed_by` versus *self*, not on presence), and tapping
again re-enters at step 3, matches its own `child_id` against the group's claimant, and completes.

Stamping `updated_at` on the sibling's row is load-bearing, not incidental. `handlePlan` supports
an incremental `since` filter (`index.js:1041`), and that timestamp is the only thing that brings
the outcome down to the losing device on its next poll. A future change that narrows the UPDATE
to "only the caller's row, to avoid touching a sibling's" would leave the loser tapping a chore
that is already gone.

### 5.5 `DELETE /api/assignments/:id/claim` — release

Undo (Child Feedback Loop §3.3) has to give the chore back, or a mis-tap locks a sibling out of
work they could still do.

```sql
UPDATE assignments
   SET claimed_by = NULL, claimed_at = NULL, updated_at = ?1
 WHERE claim_group = ?2 AND claimed_by = ?3 AND rescinded_at IS NULL
```

`claimed_by = ?3` is the authorization: only the current claimant can release, and a caller who
already lost the race releases nothing (`changes === 0` → 200 with `{ "released": false }`).
`rescinded_at IS NULL` scopes the release to the live generation, matching §5.4's arbitration —
a tombstone keeps whatever claimant it had when it was pulled.

On release the caller's own row is returned to `status='pending'`, `completed_at=NULL`,
`grade=NULL`, `completion_note=NULL` — the same field set `undoItem` already clears
(`child-app/js/completion.js:127`). The sibling's row is not touched beyond `claimed_by`,
`claimed_at` and `updated_at`; it was never completed, so there is nothing on it to clear, and
its bumped `updated_at` is what puts the chore back on the sibling's plan at their next poll.

The reward reversal is unchanged and stays on the existing path: `undoItem` appends a
compensating negative `reward_entries` row, which is what `CLAUDE.md` §III.C requires of an
append-only ledger. Nothing about a claim makes a ledger row mutable.

### 5.6 Why not `/api/completions`

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

### 5.7 Online-required — the narrowing of `CLAUDE.md` §III.A

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
(§11). If it is refused, the fallback is the provisional-credit design — local commit, optimistic
reward, compensating reversal when the drain reports a loss — which is buildable on the same
schema and routes, and is described in §13.4 rather than here because it is not what was chosen.

---

## 6. Child App

### 6.1 The tap

`planner-ui.js:855` calls `Completion.completeItem(item, grade, rawNote)`, and
`completeItem` (`completion.js:59`) branches at the top:

- `item.claim_group == null` → today's path, unchanged, byte for byte.
- otherwise → `Claim.take(item, grade, note)`: `POST …/claim`, await.
  - `claimed: true` → the existing local writes run exactly as they do now: `activityRecords`
    row, `rewardEntries` earn row, streak recheck. The completion is **not** enqueued to the
    outbox — the server already has it, and a queued duplicate would be a second write of the
    same fields under a different path — so `queueUpload` splits into its two halves and only the
    reward half runs. The reward entry **is** enqueued as normal: it is client-minted, idempotent
    on its id (§5.5 of the revamp), and the claim route does not write the ledger. The cached row
    is patched to `status: 'complete'` through `DB.setAssignmentFields` (`db.js:423`), so the
    planner and the Completed view agree before the next poll rather than after it.
  - `claimed: false` → no local record, no ledger row, no streak call. Apply the server's answer
    to the cached row (`DB.setAssignmentFields`) with `claimed_by` set to a non-self value, and
    return `{ ok: true, claimedElsewhere: true }`.

`completeItem`'s result gains that one key, and `doComplete` (`planner-ui.js:855`) gains the
branch that reads it:

```js
if (res.claimedElsewhere) { toast("Already done — someone got there first.", false); reload(); return; }
```

Without it the losing child is toasted **"Marked done."** — `doComplete` has exactly three
outcomes today (`!res.ok`, `res.alreadyDone`, else success), and a win and a loss both arrive as
`ok: true`. This is the one Child App call site §6 changes that is not optional.

The completion dialog is already dismissed before `doComplete` runs (`openCompleteDialog` calls
`overlay.remove()` in both submit handlers, `planner-ui.js:867`), so there is no modal to hold
open across the round trip. The card stays on screen until `reload()`, and a second tap during
that window is harmless: §5.4 step 3 answers a replay as a win.

### 6.2 Losing, and where it shows

Because nothing was written before the answer, losing is not a reversal — there is nothing to
reverse. This is the whole payoff of §0.8, and the reason no compensating ledger entry, no
outbox response category, and no `undoItem` re-use appear anywhere in the losing path.

It is also why the loss cannot be shown the way a completion is shown. `renderCompleted`
(`planner-ui.js:594`) builds its list from `state.records` — local `activityRecords` rows with
`status === 'complete'` — joined back to `state.rowsById`. A losing child has no such record and
never will. Left there, the chore would simply vanish from the planner mid-morning with no
explanation anywhere on the device, which is a worse answer than the one §0.7 was arguing about.

So the Completed view takes a second source, drawn from the rows it already holds:

```js
var claimedElsewhere = Object.keys(rowsById)
  .map(function (id) { return rowsById[id]; })
  .filter(function (row) {
    return row.claim_group != null
      && row.claimed_by != null && row.claimed_by !== state.selfChildId
      && row.date === today;
  });
```

Each renders through a `claimedCard(item)` — `completedCard`'s (`planner-ui.js:616`) layout and
lane colour, the title and the chore-type tag, the words **"Already done"**, and no grade, no
note control, and no Undo button. There is nothing to undo: this device wrote nothing, and the
Undo path (`handleUndo`, `planner-ui.js:660`) would find no `activityRecords` row and refuse
anyway. Bounded to the device-local day for the same reason the completed list is (§3.2 of the
Child Feedback Loop slice): a preview may point the rest of the screen at any date, and this
section follows the section it sits in.

No sibling name appears, per §0.7. "Already done" is the whole of it.

### 6.3 Planner visibility

`AssignmentCore.isPlannable` (`assignment-core.js:77`) gains one clause and one parameter:

```js
function isPlannable(row, selfChildId) {
  if (row.claimed_by != null && row.claimed_by !== selfChildId) return false;
  return (row.status || "pending") === "pending" && row.rescinded_at == null;
}
```

`toState(rows, selfChildId)` (`assignment-core.js:137`) threads it through, and `DB.loadState`
(`db.js:336`) reads the id from `syncMeta.childId`, which pairing already stores
(`pairing.js:66`). That makes `loadState` two reads rather than one — the singleton alongside the
`getAll` — and leaves its `{ rows }` return shape, which `CLAUDE.md` §IV.B pins, untouched.
`PlanSync.status()` (`plan-sync.js:231`) already reads that singleton and is already in
`planner-ui.js:81`'s load fan-out, so it returns `childId` alongside `childName` and the id lands
on `state.selfChildId` in the same pass, for §6.2's filter to read. No second store read is added
to the render path.

Comparing against self rather than testing `claimed_by != null` is deliberate. The row-only rule
would be *almost* right — a winner's own row also carries `status='complete'` — but it breaks in
the §5.4 window where a claim is held and the completion has not landed, and it breaks again on
release. An explicit identity test has no such edge, and `selfChildId` is already on the device.

`decorateById` (`assignment-core.js:164`) keeps its no-filter contract: the Completed view and
the CSV export join records back to rows and must still find a lost row in order to label it —
§6.2's second source reads that map directly and would have nothing to read otherwise.

Both signatures are exercised directly by `tests/child-cores.test.js:208` onward, which calls the
one-argument forms throughout; those calls take the new parameter, and the suite gains cases for
a row claimed by self and a row claimed by a sibling.

### 6.4 Streak — free

`StreakCore.requiredDueOn` (`streak-core.js:18`) filters rows for `required === true`, and a
chore is always `required` (`assignment-core.js:111`). A lost claim row would therefore be "due
and unresolved" — a broken streak for the kid who did not get there first, which is exactly
wrong.

No change is needed. `streak.js:11` reads its rows from `DB.loadState()`, which is `toState`'s
already-filtered output, so a row dropped by §6.3 never reaches `requiredDueOn` at all. The kid
who lost the race keeps their streak, and the kid who won keeps theirs. This is worth an
acceptance check (§12.8) precisely because it works by construction and could be broken by a
future caller that reads raw rows.

### 6.5 Undo

The Completed view's Undo (`completion.js:100`) branches the same way `completeItem` does: on a
row with a `claim_group` it calls `DELETE …/claim` first and only proceeds with the local
reversal if the release succeeds. A failed release leaves the completion standing, with a
"try again" message — the alternative is a local un-complete against a claim the server still
holds, which would show the chore as available to a kid who cannot actually claim it.

A `claimedCard` carries no Undo control at all (§6.2), so this path is only ever entered by the
child who won.

### 6.6 Offline

A `claim` row's completion control is disabled whenever the device is offline, with a short
label: *"Shared chore — needs the internet."* Offline is read from `navigator.onLine` plus the
last sync outcome (`syncMeta.lastError`, `plan-sync.js:106`), which is already maintained. A
claim attempted anyway — the connection dropped between render and tap — fails with the same
message and no local write.

---

## 7. Column and table ownership — additions to Online Revamp §4.2

| Column / table | Owner | Written by |
|---|---|---|
| `assignments.instance_key` | parent | Commit only (`POST /api/assignments`). Not in `ASSIGNMENT_PATCH_FIELDS`: moving a row between instances is not an edit, it is a different occurrence. |
| `assignments.claim_group` | parent | Commit only. Never patched, never cleared. |
| `assignments.claimed_by` | **server** | The claim and release routes only. Neither credential may set it directly — it is not in `ASSIGNMENT_CREATE_FIELDS`, `ASSIGNMENT_PATCH_FIELDS`, or `ASSIGNMENT_COMPLETION_FIELDS`. |
| `assignments.claimed_at` | **server** | As above. |
| `claim_groups` (all) | **server** | `handleAssignmentsCreate` only. Insert-only; never updated, never deleted. |

`claimed_by` is a third ownership class this table has not had before: parent-owned and
child-owned columns are disjoint by construction (§4.2), and this one is neither — it is derived
by the Worker from a race between two credentials. It is listed here rather than folded into
either block so that the disjointness claim stays literally true.

---

## 8. Management App — authoring UI

One line per chore, as today. The list row (`chores.js:217`) shows participants instead of a
single name, the arrangement, and the occurrence count when there is more than one:

```
Breakfast Dishes   Ellie, Sam   Kitchen/Dining   Mon–Fri   3×/day   Either can claim   [Edit] [Delete]
```

The edit and create forms (`chores.js:244`, `chores.js:288`) replace the `<select name="childId">`
with:

- a checkbox list of children;
- a two-radio **Arrangement** control, shown only when more than one child is checked:
  *"Each child does their own"* / *"Either child can claim it — first one earns the reward"*;
- a **"Same days for everyone"** checkbox, checked by default, shown only for *Each* with more
  than one child. Unchecking it reveals one day-grid per checked child, seeded from the chore's
  `daysOfWeek` (§2.2's `childDays`);
- an **Occurrences per day** list below Days of week, each row a label and an optional block
  hint, with *Add* and *Remove* buttons. An empty list is the default and renders nothing extra,
  so a one-a-day chore's form is unchanged. Removing a row warns that already-committed
  occurrences are unaffected, matching the existing delete confirmation's wording
  (`chores.js:233`).

The checkbox list follows the rule `childOptions` (`chores.js:157`) already applies to the single
select: **archived children are offered only when they are already participants.**

```js
allChildren.filter((c) => Children.isActive(c) || participants.includes(c.id))
```

The existing comment there gives the reason and it holds unchanged for a checkbox list — dropping
an archived-but-selected child from the control would leave the form showing a different set of
participants than the record holds, and silently rewrite `childIds` on the next save. The Propose
form's flat exclusion (`packet.js:800`) is the *other* case, and its own comment says so: it
generates new work and has no already-selected child to preserve. The browse filter above the
list is built from the full child list either way, so an archived child's chores stay reachable.

A participant removed from a chore stops generating future occurrences and touches nothing
already committed — the same rule SRS Module 06 §2.5 already states for deletion, and the same
rule §4.4 applies when the Child itself is deleted.

---

## 9. Reporting

`reporting.js` buckets rows by `status` and excludes rescinded-and-pending rows from the
scorable denominator (`reporting.js:66`, `isRescinded`). A lost claim row is `status='pending'`
forever, so without a change it would count against the sibling's completion rate as work they
never did.

Add a sibling bucket alongside the existing one, in the same shape:

```js
function isClaimedElsewhere(row) {
  return row.claimed_by != null && row.claimed_by !== row.child_id;
}
```

The test needs no child id passed in. Every row these functions see arrives from
`/api/assignments?childId=…` (`reporting.js:247`) and carries its own `child_id`, so the row
answers the question itself — which keeps `summarize`, `byCourse` and `toCsv`
(`reporting.js:77`, `:106`, `:151`) as one-argument pure functions and keeps
`tests/management-reporting.test.js` calling them the way it already does.

Such a row still increments `assigned` — it *was* assigned, and a parent looking at a month
should see it — and is then counted into a new `claimedBySibling` total, excluded from `pending`,
and subtracted from the denominator:

```js
const scorable = totals.assigned - totals.events - totals.claimedBySibling;
```

which is `reporting.js:95` with one more term, in the shape `events` already established. The
per-course rollup's synthetic chore bucket (`reporting.js:106`) gets the same treatment. The CSV
export's status column (`reporting.js:161`) reports `claimed-by-sibling`, sitting beside the
existing `rescinded` synthetic value.

---

## 10. Tests

`tests/` covers the pure layers only — `worker/validation.js` and the Child App's `*-core.js`
files (`CLAUDE.md` §I.B). Three suites move:

- `tests/worker-validation.test.js` — the claim body's accepted key set (§5.4), and the
  `instances` and `childIds`/`childDays` validation rules (§2.2) if the normalizing helpers are
  written DOM-free, which they should be.
- `tests/child-cores.test.js` — `isPlannable`/`toState` under the new second argument (§6.3),
  including a row claimed by self, a row claimed by a sibling, and the §5.4-window case of a held
  claim still at `status='pending'`.
- `tests/management-reporting.test.js` — `isClaimedElsewhere` and the three-term `scorable`
  (§9).

`tests/worker-routes.test.js` covers the routes it can reach without D1; the arbitration itself
is a §12 acceptance check against a real database, because what it is really asserting is
SQLite's serialization and no test double can stand in for that.

---

## 11. Build phasing

Ordered so that each phase is independently shippable and none leaves a half-state in a database
a family is using. Each is a session or less; per `CLAUDE.md` §V.A the whole is not.

**Phase 1 — instances.** Migration `0006`, registered; `instance_key` through the Worker's key
sites (§3.2); `keyOf`, `loadCommittedKeys`, the reproduce step and the Step 4 expansion in
`packet.js`; the Occurrences control in authoring. Single-child, single-allocation throughout —
no `childIds` yet. Delivers Ray's three-dishes case on its own and lays the key `claim_groups`
depends on (§3.4).

**Phase 2 — `each`, multi-child.** `chores.js` record shape, normalizing helpers, validation,
the participant checkbox list; `packet.js:277` participation-and-days expansion; `listChores`
membership; `cascadeDeleteChild`'s prune-then-delete (§4.4). No migration, no Worker change, no
Child App change. Delivers arrangements 1, 2, and 4 of §2.1 — three of the four.

**Phase 3 — the claim, server side.** Migration `0007`, registered; `claim_groups` resolution in
`handleAssignmentsCreate`; the claim and release routes; the `/api/completions` guard; the
`shared` create field. Nothing calls the new routes yet — the same ordering discipline
`0005_assignment_messages.sql` used, and for the same reason.

**Phase 4 — the claim, clients.** Requires §0.8 authorized. `allocation: 'claim'` in authoring
and `shared: true` in the Commit projection; the Child App claim/release calls, the
`claimedElsewhere` result key and its `doComplete` branch, `isPlannable` threading, the
Completed view's second source, offline button state; reporting's sibling bucket.

Phase 3 must be deployed and its migration applied before Phase 4's Commit can write a shared
row, and Phase 1's before either. That is the same hazard `TDS_Slice_Child_Feedback_Loop` §5.5
documented for `completion_note`, with the same mitigation: the column-bearing release ships
first, alone.

---

## 12. Acceptance checks

Run against a real database from the browser, per `CLAUDE.md` §IV.C.

**Instances (§3)**

1. A chore with no `instances` generates and commits exactly as it does today, with
   `instance_key = ''` on every row.
2. A chore with three instances commits three rows per child per day, with distinct
   `instance_key`, distinct titles, and distinct block hints.
3. Re-running Propose and Commit over an **overlapping** range inserts nothing new — `skipped`
   equals the full row count, for all three instances. This is §6.6's guard under the new key.
4. Deleting the middle instance and regenerating leaves the other two live and untouched, and
   does not resurrect or rename the deleted one.
5. Reordering the instance list and regenerating inserts nothing.
6. Dropping one instance from one day in Propose suppresses that instance only; the other two
   are still proposed for that day.
7. `0006` applied to a database with existing chore assignments leaves every pre-existing row
   deduplicating correctly — the `NULL`-comparison trap in §3.1, verified rather than assumed.

**`each` (§4)**

8. A chore with one child and `allocation: 'each'` generates and commits exactly as it does
   today — the pre-existing private-chore path is unchanged.
9. A chore with two children and `each` commits two rows per occurrence, one per child, with
   different `child_id` and the same `source_id`. Both children complete independently and both
   ledgers gain an entry.
10. A chore with two children, `each`, and split `childDays` commits exactly one row per
    occurrence, to the child whose day it is. The other child's plan does not show it.
11. Re-running Propose and Commit over the same range for either child inserts nothing new
    (`skipped` equals the row count) — §6.6's guard still holds with multi-child chores.
12. Deleting a Child who shares a chore with a sibling leaves the chore live with the sibling as
    its only participant, and deletes only the chores that child solely owned.
13. Editing a chore whose participant list includes an archived child leaves that child checked
    and still a participant after a save with no other change.

**`claim` (§5, §6)**

14. A `claim` chore commits two rows per occurrence carrying the **same** `claim_group`, and the
    two per-child Commits produce that same value in either order.
15. Three instances a day produce three separate claim groups; claiming one leaves the other two
    claimable.
16. Two devices claiming the same occurrence: exactly one gets `claimed: true`. The loser's next
    plan poll shows the row gone from their plan and a card reading "Already done" in Completed,
    with no Undo control on it. Exactly one `reward_entries` row exists for the occurrence.
17. The losing child sees a toast that says so — not "Marked done."
18. The losing child's streak for that day is `resolved`, not `breaking`.
19. The winner's Undo releases the claim; the occurrence returns to both children's plans; the
    winner's ledger carries a compensating negative entry and the balance is back where it
    started.
20. **Rescind one child's row for a claimed occurrence, regenerate it, and claim again: the
    request is answered `claimed: false` and no second `reward_entries` row appears.** One
    occurrence pays once (§5.4).
21. A child device attempting `POST /api/completions` on a `claim_group` row is rejected per-row,
    and the rest of its batch still applies.
22. A child device attempting to set `claimed_by` or `instance_key` through any route is
    rejected.
23. A device token for child A cannot claim, release, or read child B's row (404, not 403 —
    matching §5.6's existing shape).
24. Airplane mode: the claim control is disabled with its message; every other completion on the
    plan still commits locally and drains on reconnect.
25. Reporting over a range containing a resolved claim credits exactly one child and counts the
    other as neither pending nor missed.
26. Both migrations apply cleanly on an empty database and on the live one, from
    Settings → Database, with no CLI.

---

## 13. Open items — deferred, not decided here

1. **True alternation.** §0.6 chose fixed per-child days. Alternating turns (Ellie, Sam, Ellie…)
   would need a derived turn index and an anchor date, and would raise a question this design
   does not have to answer: what happens to the sequence when `daysOfWeek` is edited mid-term.
   Not built.
2. **Rescinding a shared occurrence in one action.** Rescind is `batch_id`-scoped (§6.3), and two
   children's rows for one occurrence come from two different Commits and therefore two different
   batches, so pulling a shared chore back is two rescind actions. §5.4's arbitration is written
   to stay correct through any partial rescind, so this is an ergonomics gap rather than a
   correctness one — but whether rescind should also accept a `claim_group` is a real question
   and is out of scope here.
3. **Changing `allocation` on a chore with live rows.** Editing a chore to or from `claim`
   affects only future generation; already-committed rows keep the arrangement they were
   committed under. This is consistent with SRS Module 06 §2.5 but has not been walked through
   for the case where one occurrence is mid-claim.
4. **The provisional-credit fallback**, if §0.8 is refused: local commit on tap, optimistic
   reward, and a compensating reversal driven by a new outbox response category when the drain
   reports the claim lost. Same schema, same routes, materially worse UX (a reward that appears
   and then disappears). Recorded so the choice is not re-litigated from scratch.
5. **Three or more participants.** The design is N-ary throughout — `childIds`, the arbitration
   statement, and the group table all work unchanged — but nothing has been tested past two, and
   §0.7's "no name needed" reasoning explicitly depends on there being two.
6. **A `claim` chore pruned to one participant** by §4.4's child deletion keeps its allocation and
   generates a group of one. That resolves correctly — the sole participant always wins — but it
   is the one-participant claim §4.3 declined to define, arrived at from the other direction.
   Whether authoring should flip it back to `each` is unresolved.
7. **A parent-side view of who claimed what.** Reporting counts it (§9); there is no screen that
   shows a parent the claim history for a chore over a week.
8. **Family Event cascade delete** (`children.js:115`) loses a whole event when one of its
   participants is deleted — the defect §4.4 declines to copy. It belongs to Module 07 and wants
   its own fix.

---

## 14. SRS amendments required

- **`SRS_Management_Module_06_Chore_Authoring.md` FR-7** — *"Single-child only. A Chore belongs
  to exactly one Child (`childId`) and cannot be shared across multiple children. A household
  chore two kids both do is two separate Chore records"* — is **repealed** by §0.1/§2.2. The
  replacement: a Chore names one or more participating Children (`childIds`) and an allocation
  rule. Its §5 field table gains `childIds`, `allocation`, `childDays` and `instances`, and loses
  `childId`.
- **`SRS_Management_Module_06` FR-1** describes a Chore's recurrence as `daysOfWeek[]` alone,
  which implies at most one occurrence per day. It gains a sentence: a Chore recurs on its days
  *once per instance*, defaulting to one.
- **`SRS_Management_Module_06` §2.5** (deletion does not recall delivered content) is unchanged
  and now also covers removing a participant from a chore, and removing one by deleting the Child
  (§4.4).
- **`SRS_Management_Module_04_Child_Management.md` FR-8** describes the Tier 2 cascade as
  deleting the child's Chores. It becomes: the cascade removes the child from every Chore's
  participant list and deletes only those left with no participants (§4.4).
- **`CLAUDE.md` §III.A** — narrowed for `claim_group` rows only, per §0.8/§5.7. The Quick
  Reference entry "Online-first, offline-tolerant — LOCKED" stands; this adds one row class where
  a specific write is online-required, and does not touch the general guarantee.
- **`CLAUDE.md` §VII** gains one row: *Shared chore claims — LOCKED — server-arbitrated,
  online-required, `each`/`claim` allocation and per-day instances on a single Chore record.*
