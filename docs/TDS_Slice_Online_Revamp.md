# Technical Design Specification — Slice

## Scope: Online Revamp — Shared-Table Assignment Model on Cloudflare D1

**Status:** Authored 2026-08-10. Authorized by Ray in-session.
**Amended 2026-08-11**, authorized in-session, after a standing review found three places
where this document and the built system disagreed. In each case the code was the better
design and the document moved:
§3.2 records who maintains the `children` projection and gives `active` a source (it had
none); §5.6 and §13.1/§13.3 replace a request-level `400` and an unreachable `403` with the
per-row rejection the Worker actually implements, and note the one client-side gap that
leaves open. No behaviour was changed to match the old text.

**Amended again 2026-08-11**, authorized in-session, after a second review found four
defects. Unlike the first amendment, this one moved the *code* — in each case the document
described the better design and the build had not reached it:
§3.8 adds `commit_chunks` (migration `0003`) and §6.1 makes "the Commit is replay-safe" true
rather than aspirational — nothing had implemented it, so a chunked Commit that failed
partway left rows live with no handle on them and duplicated the lot on retry;
§4.2 and §5.5 extend the Worker's ownership check from *which* columns a device may write to
*what values* it may write to them; §5.5's reward append moves to per-row rejection for the
same §5.6 reason completions already had; and §5.6's recorded client-side gap is closed —
`outbox.js` now reads the `rejected` array and surfaces it.

**Amended a third time 2026-08-11**, authorized in-session, recording the **local ledger
collapse** — the last part of §12's Phase 5 to be built, and the ledger half of what §14
had bundled as one deferred item. `rewardLedgerSnapshot` and `rewardLedgerTail` are gone;
IndexedDB v7 migrates both into the single append-only `rewardEntries` store §8.1 names, and
the N=100 fold — repealed for D1 in §3.4 and never repealed for the device until now — is
deleted rather than ported. Two consequences worth naming, because neither was in the
original text: a local entry now carries the *same* client-minted id the outbox uploads, so
one earning is one row at both ends rather than two constructions that happen to agree; and
§14 gains an open item recording that the device's zero-floored balance and §3.4's flat
`SUM` disagree in a case nothing reconciles. The §8.2 planner shim is untouched and stays
deferred. *(That deferral was gated on live days when this was written; the sixth amendment
repeals the gate. What is left of the shim is deferred on its size alone.)*

**Amended a fourth time 2026-08-11**, authorized in-session, closing the last gap between
this design and a device someone can actually start using. §4.3 has always said the child
opens the app and types a code; what the built app did was run the pre-revamp Startup Wizard,
ask someone to *type the child's name*, and drop into a planner with no token — leaving
pairing reachable only from behind the parent PIN in Settings, which is to say leaving a
fresh install looking like an app that does not work. §4.3.1 is new and records pairing as a
step of first-run setup rather than a Settings errand; §4.4 is new and states what an unpaired
device is, and how it differs from an offline one and an unlinked one; §13 gains checks 22–25.
No API, schema or credential behaviour changed — this is the client reaching the design.

**Amended a fifth time 2026-08-11**, authorized in-session, recording **phase 1 of the §8.2
shim collapse**. §8.2 and §14 are rewritten to say which half is built: the planning
derivation now reads the child-owned columns off the assignment row and the parallel `meta`
map is gone, so one assignment is one object rather than a record plus a lookup. The two
halves still deferred are named separately in §14 — `planner-ui.js`'s field names, and the
IndexedDB v8 store drop. No API, schema, credential or rendering behaviour changed; this is
the same plan derived from one object instead of two.

**Amended a sixth time 2026-08-11**, authorized in-session, **repealing §12's live-days
gate**. Every phase of the cutover was gated on the replacement having "carried real days"
before its fallback could be deleted. That gate has been removed, not satisfied: Ray waived
it for phase 1 of the shim collapse in the same session, and rather than leave a rule
standing that the project has already stepped around once, it is withdrawn. §12 now says
what remains true — the sequencing constraint, and the reason the gate existed — without
blocking work on it.

What this does **not** change: the fallbacks are already gone. Phase 5 deleted the packet
import and the CSV transport, and the service worker fix landed with them, so nothing is
now waiting on a proving period to be deleted. What is left of the §8.2 shim is deferred on
its size — a rewrite of the largest file in the Child App, and an IndexedDB v8 migration —
and that is the only reason it is deferred. §14 states it that way.

**Amended a seventh time 2026-08-11**, authorized in-session, recording **phase 2 of the
§8.2 shim collapse**. Phase 1 left one object per assignment answering to two vocabularies:
`decorate()` minted a camelCase alias for six §3.3 columns because `planner-ui.js` and
`completion.js` were written against the pre-revamp names, and it overwrote the `payload`
column with a parsed, stripped object because the planner rendered from it. Both readers now
read the columns, the aliases are deleted, and `payload` passes through as the column it is —
what was parsed out of it is added under names of its own, including `content` for an
activity's kind-specific descriptor. §8.2 is rewritten around what `decorate()` is left
doing, which is one stateable thing: the row, plus the fields §3.3 gives no column. §14
records phase 3 as the only remaining part, and notes that it now has no callers left to
convert — only the IndexedDB v8 migration and an amendment to CLAUDE.md §IV.B. No API,
schema, credential or rendering behaviour changed; the same plan renders from the same
values under one set of names.

**Amended an eighth time 2026-08-11**, authorized in-session, recording **phase 3 of the
§8.2 shim collapse — the IndexedDB v8 store drop**, and closing out the item. `activities`,
`chores` and `events` are deleted (they reached v8 empty; Phase 5 had already removed their
last writer), `DB.loadState()` returns `{ rows }` alone, and CLAUDE.md §IV.B's pin on the
four legacy keys is lifted. Two files depended on the dropped stores directly rather than
through the shim — `export-core.js`/`export.js` (Module 8's CSV report) and `wipe.js`
(Module 9) — and would have thrown against a store that no longer exists; both now work from
the decorated `assignments` row and `activityRecords` respectively, and §14 records what
moved. `plannerMeta` is not part of this: §8.1's table has always named folding it into the
child-owned columns as the eventual shape, but doing so is a write-path change with several
files having a stake in it, not a deletion with nothing left to read — it is split out as its
own open item rather than carried under a "shim collapse" that is now finished. No API,
schema, credential or rendering behaviour changed.

**Amended a ninth time 2026-08-11**, authorized in-session, closing the item split out of
the eighth amendment: **folding `plannerMeta` into the assignment row's own columns.** This
was always the write-path change the shim collapse deferred, not a deletion — `deferment.js`,
`planner-ui.js`, `db.js` and `outbox-core.js` all had a stake in it. IndexedDB reaches v9:
an override this device wrote but had not yet drained is carried onto the `assignments` row
it overrides before `plannerMeta` is dropped (`foldPlannerMetaIntoAssignments`), and an
override with no matching row — the assignment had already fallen out of the cache — is
dropped with it. Going forward, a reschedule or a block/order change writes
`deferred_to`/`child_block_hint`/`child_sort_order` straight onto the cached row
(`DB.setAssignmentFields`), and `DB.loadState()` reads `assignments` alone — the merge
`applyLocalMeta` used to do at every read is gone with the second store it was merging in.
The race that merge existed to survive is handled the other way now: `DB.applyPlan`, which
ingests each `/api/plan` poll, reapplies any planner-column write still sitting in the
outbox on top of an incoming row before it is stored, so a poll landing before the outbox
drains cannot silently revert a deferral or a reorder the child just made.
`OutboxCore.completionFieldsFromOverride`/`columnsFromCompletionFields` hold that
translation, in both directions, in the one place it can't drift. §8.1 and §8.2 are updated
to say this is done; §14's entry is retained rather than deleted, per its own convention. No
API, schema or credential behaviour changed — the assignment row already carried these
columns (§3.3); only where the client stages a write ahead of the network changed.

**Applies to:** Both apps, the Worker, and the interchange layer between them.
**Supersedes:** `TDS_Slice_D1_Sync_Management_App.md` (the mirror becomes a
curriculum-only backup), `Interchange_Contract.md` (replaced by §5's API),
Child SRS Module 02, Child SRS Module 08, Management SRS Module 09.

---

## 0. Revision note — the constraint being repealed

Every previous slice in this project was written under one assumption: **the parent's
database and the child's database may never talk to each other.** That assumption is
withdrawn. It is not narrowed, not amended for one app — withdrawn.

Ray's stated reason for offline-first was cost. Cloudflare's free tier removes the cost,
and the offline constraint was buying resilience nobody wanted at a price now visible in
the code: a packet format, a JSON-Schema validator, a merge engine, deterministic ID
minting, reserved-prefix validation, a generation decision log, a CSV writer, and a CSV
importer — all of it reconciliation protocol between two databases that were forbidden
from sharing a transaction.

| Previously LOCKED | New status |
|---|---|
| §III.A "No network calls during normal app operation" | **REPEALED.** Both apps are networked. The Worker API is the normal path. |
| §III.A "IndexedDB is the source of truth" | **REPEALED.** D1 is the system of record. IndexedDB is a cache plus an outbox on both sides. |
| §X "Offline-first guarantee" | **REPLACED** by online-first, offline-tolerant (§8.4). |
| §III.B Per-occurrence chore identity `CHR-{token}-{YYYYMMDD}` | **REPEALED.** IDs are server-minted opaque UUIDs (§3.3). |
| §III.B Reserved prefix validation (`CHR`, `EVT`) | **REPEALED.** Nothing derives meaning from an ID's text. |
| §III.D Reward ledger fold at N=100 | **REPEALED.** A storage-size hack for IndexedDB; SQLite does not need it (§3.5). |
| §III.E `plannerMeta` keyed by item ID | **REPEALED as a store.** Its three fields become columns on the assignment row (§3.3). |
| §III.C Packet & Completion CSV interchange | **REPEALED as transport.** CSV survives only as a report export (§11). |

**Preserved unchanged:** vanilla JS with no build step *in the two browser apps*; the
two-app split with no shared runtime code; the Propose/Review/Commit authoring flow (M7);
the pacing engine; IndexedDB on both devices (demoted in role, not removed).

**New hard constraint: Ray has no CLI.** No step in this project — deployment, schema
application, backup, recovery — may require a terminal. Anything that would have been a
`wrangler` command must be reachable from a browser. See §3.7.

Roadmap principle 3 ("no required server") is repealed. Principles 1 and 2 (zero-cost
development and maintenance) hold — §10 stays inside the free tier.

```
[DECISION] System of record for the whole project
Decided: Cloudflare D1. One shared `assignments` table that the parent writes
  and the child completes. No interchange format between the apps.
Rationale: The packet/CSV machinery exists only to reconcile two databases that
  cannot share a transaction. Given a shared database the reconciliation problem
  does not exist, so neither does the code. Column-level ownership (§4.2) makes
  the design conflict-free by construction rather than by resolution policy.
Locked for: this slice and forward.
```

```
[DECISION] Where the pacing engine runs
Decided: Stays in the parent's browser at Commit time, for this round.
Rationale: M7's Propose/Review/Commit logic is the most valuable code in the
  repo and is transport-independent. Only its final stage changes — it writes
  rows instead of serializing a file. Moving it into the Worker is a separate
  project with no user-visible benefit until scheduled generation is wanted.
Consequence: assignments materialize only when the Management App is open.
Forward compatibility: §3.3's schema carries no browser-only assumption, and
  §5.2's write endpoint is the same one a server-side generator would call, so
  the move is additive and needs no migration.
Locked for: this slice. Revisit when unattended generation is wanted.
```

---

## 1. Architecture

```
Management App (parent)                          Child App (PWA, per kid)
  IndexedDB: curriculum authoring + outbox         IndexedDB: assignment cache + outbox
      │  writes curriculum (blob mirror)                │  GET  /api/plan
      │  POST /api/assignments  (Commit)                │  POST /api/completions
      ▼                                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker  —  one script, /api/* + static assets   │
   │  D1 `scheduling-app`  =  SYSTEM OF RECORD                   │
   └────────────────────────────────────────────────────────────┘
```

Two storage idioms live in one database, deliberately:

- **`records`** — the existing opaque `(store, key, value)` mirror from
  `TDS_Slice_D1_Sync`. Its role narrows to **parent curriculum authoring stores only**
  (§3.1). Schemaless, tolerant of new object stores, good for backup and restore, useless
  for querying. That is acceptable because only the Management App interprets it.
- **Relational tables** (§3.2–§3.6, §3.8) — everything a child produces or is assigned.
  These get real columns because they are the facts Ray will want to query years from now:
  what was assigned, what got done, what was earned.

The dividing line: **authored curriculum stays opaque; assigned work and child outcomes
become relational.**

---

## 2. Vocabulary change

"Packet" is retired. The unit is an **assignment**: one row, one child, one day, one thing
to do. A Commit produces a **batch** of assignments sharing a `batch_id`.

---

## 3. D1 schema

Delivered as numbered migration files and applied **from the browser** — Ray has no CLI,
and no step in this project may require one. See §3.7 for the mechanism; it is a hard
constraint, not a convenience.

### 3.1 `records` — retained, narrowed

Unchanged in shape. Its permitted `store` values are now restricted to parent authoring
stores: `meta`, `curricula`, `tiers`, `rewardCategories`, `activityTypes`, `courses`,
`lessons`, `activities`, `children`, `chores`, `familyEvents`, `pacingProfiles`,
`generationLog`. `appSettings` and `syncOutbox` remain never-mirrored. Child-side stores
are never written here — they belong to §3.3–§3.6.

### 3.2 `children`

A queryable projection of the authoritative record in `records`, so joins and reports do
not have to parse JSON blobs.

```sql
CREATE TABLE IF NOT EXISTS children (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

**3.2.1 Who maintains it.** `handleSyncPush` writes this table in the same `batch()` as the
`records` upsert whenever a change touches the `children` store — one implicit transaction,
so the projection and the mirror cannot disagree. A `put` upserts; a `delete` removes the
row while the mirror keeps its tombstone. A record with no usable `name` is skipped rather
than failing the push, since `name` is `NOT NULL` and one malformed record must not block a
curriculum sync.

Migration `0002_backfill_children_projection.sql` derives the table from `records` for
everything authored before the Worker maintained it. That is not the backfill §12 forbids:
§12 is about curriculum that never reached D1 at all and cannot be recovered, whereas this
denormalises rows already sitting in this same database.

**3.2.2 Where `active` comes from.** As originally written this column had no source — the
child record was `{ id, name }` and nothing in either app had a notion of an inactive
child, so `active` would have read `1` forever. It is now a real field on the child record,
set by **Archive / Restore** on the Children page. Archiving withdraws a child from every
picker that starts new work — Assign, Chores, Events, and device pairing — while leaving
them fully present in Assignments and Reporting, and leaving everything already assigned
exactly as it was. It is the non-destructive alternative to delete, which cascades away
chores, events and pacing history.

Absent means active, in both directions: a child record written before the flag existed is
older than the flag, not archived. `Children.isActive()` in the Management App and the
`CASE` in `0002` agree on that reading, and the Worker writes `1` for a record with no
`active` key.

### 3.3 `assignments` — the shared table

```sql
CREATE TABLE IF NOT EXISTS assignments (
  id                    TEXT PRIMARY KEY,   -- server-minted UUID (§3.3.1)
  child_id              TEXT NOT NULL,
  date                  TEXT NOT NULL,      -- YYYY-MM-DD, the day it is due
  kind                  TEXT NOT NULL,      -- 'activity' | 'chore' | 'event'
  batch_id              TEXT,               -- the Commit that produced it (§6.2)

  -- ── parent-owned columns: child may read, never write ──────────────
  source_id             TEXT,               -- originating curriculum activity/chore/event
  title                 TEXT NOT NULL,
  course_name           TEXT,
  activity_type         TEXT,
  sequence_no           INTEGER,
  payload               TEXT,               -- JSON: pageRange, instructions, etc.
  expected_duration_min INTEGER,
  reward_amount         REAL,
  reward_category       TEXT,
  block_hint            TEXT,               -- parent's suggested block
  sort_order            INTEGER,            -- parent's initial ordering
  rescinded_at          INTEGER,            -- NULL = live (§6.3)

  -- ── child-owned columns: parent may read, never write ──────────────
  status                TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'complete'|'waived'
  completed_at          INTEGER,
  grade                 REAL,
  deferred_to           TEXT,               -- YYYY-MM-DD, child moved it (§6.5)
  child_block_hint      TEXT,               -- child's override of block_hint
  child_sort_order      INTEGER,            -- child's reordering of their day

  -- ── bookkeeping ────────────────────────────────────────────────────
  assigned_at           INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT                -- 'parent' | 'device:<deviceId>'
);

CREATE INDEX IF NOT EXISTS idx_assign_child_date    ON assignments (child_id, date);
CREATE INDEX IF NOT EXISTS idx_assign_child_updated ON assignments (child_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_assign_batch         ON assignments (batch_id);
```

**3.3.1 Identity.** `id` is a `crypto.randomUUID()` minted by the Worker on insert. It is
opaque. Nothing parses it, no prefix carries meaning, and no client can derive it. This
is what replaces `CHR-{token}-{YYYYMMDD}`.

**3.3.2 Denormalization is deliberate.** `title`, `course_name`, `reward_amount` and the
rest are snapshotted at assign time rather than joined from curriculum. Three reasons: a
completed assignment must record what it *was* when it was done, not follow later edits to
the course; the child's device needs a self-contained row to render without a second
fetch; and curriculum lives in the opaque `records` blob, which cannot be joined anyway.
This is normal ledger practice, not an accident.

**3.3.3 Paired ownership columns.** `block_hint`/`child_block_hint` and
`sort_order`/`child_sort_order` exist as pairs specifically so that the parent's intent and
the child's adjustment never contend for one column. Render with
`COALESCE(child_sort_order, sort_order)`. This is what preserves Module 3's planner
behaviour under strict column ownership.

**3.3.4 `status` excludes rescission on purpose.** Rescission is a parent act recorded in
`rescinded_at`; status is a child act. Keeping them orthogonal resolves the
parent-rescinds-while-child-completes race with no special casing — see §6.4.

### 3.4 `reward_entries` — append-only earnings ledger

```sql
CREATE TABLE IF NOT EXISTS reward_entries (
  id            TEXT PRIMARY KEY,   -- client-minted UUID → replay-safe (§5.5)
  child_id      TEXT NOT NULL,
  assignment_id TEXT,               -- NULL for manual adjustments
  category      TEXT NOT NULL,
  amount        REAL NOT NULL,      -- negative permitted: spend or reversal
  reason        TEXT NOT NULL,      -- 'earned' | 'adjustment' | 'spend'
  earned_at     INTEGER NOT NULL,
  created_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reward_child_cat ON reward_entries (child_id, category);
```

Balance is a query, never a stored number:

```sql
SELECT category, SUM(amount) AS balance
FROM reward_entries WHERE child_id = ?1 GROUP BY category;
```

Rows are never updated or deleted. A correction is a new compensating row. This is what
retires the N=100 fold: the fold existed to stop `rewardLedgerTail` growing without bound
in IndexedDB on a budget Android phone, and SQLite is indifferent to tens of thousands of
rows.

### 3.5 `streaks`

```sql
CREATE TABLE IF NOT EXISTS streaks (
  child_id            TEXT PRIMARY KEY,
  current_streak      INTEGER NOT NULL DEFAULT 0,
  longest_streak      INTEGER NOT NULL DEFAULT 0,
  last_qualified_date TEXT,
  updated_at          INTEGER NOT NULL
);
```

Child-owned. The rules stay in `streak-core.js` on the device; the server stores the
result so reporting can read it without recomputation.

### 3.6 `devices` and `pair_codes`

```sql
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  child_id     TEXT NOT NULL,
  label        TEXT,                    -- "Ellie's tablet"
  token_hash   TEXT NOT NULL UNIQUE,    -- SHA-256 of the bearer; plaintext never stored
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_child ON devices (child_id);

CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,   -- 8 chars, Crockford-style alphabet (no I/L/O/U/0/1)
  child_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,   -- 15 minutes from mint
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);
```

### 3.7 Migrations — applied from the browser

**Hard constraint: Ray has no CLI.** `wrangler d1 execute` does not exist as an option, and
the current `DEPLOY.md` instruction to paste statements into the D1 console one at a time
does not survive a schema this size. Every schema change in this project must be
applicable by clicking a button in a browser.

This pattern is already proven in Ray's `Heritage-Hooves` repo (200+ migrations, applied
in-app at `/admin/migrations`). Adopted here with the same shape and two adaptations.

**3.7.1 Files.** `/migrations/NNNN_short_description.sql`, zero-padded from `0001`,
**forward-only**. Never edit a migration that has been applied — correct it with a new one.
One logical change per file; a migration that adds a table and backfills it is two files.
Comment the intent in one plain-English sentence at the top, and document the shape of any
`TEXT` column holding JSON, because nothing else enforces it.

`0001_online_revamp_init.sql` carries §3.2–§3.6 plus a `CREATE TABLE IF NOT EXISTS records`
matching §3.1, so a fresh database gets everything and the live one — where `records` was
created by hand in the console — is a no-op.

**3.7.2 Bundling.** Wrangler already bundles the Worker with esbuild, so SQL files can be
imported as text:

```toml
[[rules]]
type = "Text"
globs = ["**/*.sql"]
fallthrough = true
```

> This does **not** breach "vanilla JS, no build step." That rule governs the two browser
> apps, which still ship unbundled and unminified. The Worker has been bundled by Wrangler
> since the first D1 deploy — `main` points at source and `wrangler deploy` bundles it.
> Recording this so a future session does not "fix" it.

**3.7.3 Registry.** `management-app/worker/migrations.js` holds a static import and a list
entry per file, in order:

```js
import m0001 from '../../migrations/0001_online_revamp_init.sql';
export const MIGRATIONS = [ { name: '0001_online_revamp_init.sql', sql: m0001 } ];
```

Applied so far: `0001_online_revamp_init.sql` (§3.2–§3.6),
`0002_backfill_children_projection.sql` (§3.2.1),
`0003_commit_chunks.sql` (§3.8).

**Adding a migration file also means registering it here.** The duplication is deliberate:
the file is the source of truth, the list is what makes it visible to the in-app runner.

**3.7.4 Tracking and application.**

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

Each pending migration's statements **plus its own tracking-row insert** run in a single
`env.DB.batch()` — an implicit transaction, so a migration either lands completely or not
at all. Batches are not chained: if the third of five fails, the first two stay applied and
the run stops there. That is intentional and matches what re-running a CLI apply would do;
the status table always shows exactly where things stand.

**3.7.5 Surfaces.** Two, deliberately:

- **Settings → Database**, in the Management App. Auto-checks `GET /api/migrations` on app
  load and shows a banner when anything is pending: *"2 migrations pending — Apply."*
  This is the everyday path and satisfies the "check automatically" requirement.
- **`GET /admin/migrations`**, a server-rendered HTML page from the Worker, with a plain
  `<form method="post">` and a confirm checkbox. No JavaScript, no dependency on the
  Management App loading at all.

The second exists because of a lesson recorded in Heritage-Hooves: **the migrations page
fixes everything, including a botched deploy, so it must never be the thing a locked-out
operator cannot reach.** If a schema change breaks the Management App's own startup, a
migrations UI that lives inside that app is unreachable exactly when it is needed. The
server-rendered page has no such dependency.

**3.7.6 Authorization.** Both surfaces require the parent `SYNC_TOKEN` — the API panel by
`Authorization: Bearer`, the standalone page by a token field on the form. Heritage-Hooves
needs a pre-setup bootstrap hole because its gate lives in a database table that migrations
create; this project's gate is a Worker secret that exists from the first deploy, so no
hole is needed. Child device tokens are rejected outright.

### 3.8 `commit_chunks` — what makes a Commit replay-safe

```sql
CREATE TABLE IF NOT EXISTS commit_chunks (
  batch_id    TEXT    NOT NULL,
  chunk_index INTEGER NOT NULL,
  child_id    TEXT    NOT NULL,
  row_count   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (batch_id, chunk_index)
);
```

Added by migration `0003_commit_chunks.sql`. §6.1 has always said a Commit is replay-safe
because the client mints the `batchId`; that was never true, because nothing on the server
looked at it. A Commit over `MAX_BATCH` rows arrives as several requests sharing one
`batchId`, so the batch alone does not identify a request — `(batch_id, chunk_index)` does.

**3.8.1 Where the guarantee lives.** The `INSERT` here rides in the *same* `env.DB.batch()`
as the assignment rows it accounts for. D1's `batch()` is an implicit transaction, so a
replayed chunk collides on the primary key and takes the duplicate assignment inserts down
with it. The Worker's `SELECT` beforehand is a courtesy that answers a replay with
`{ ids: [], applied, duplicate: true }` instead of an error; the primary key is what makes
it correct under a race.

**3.8.2 What this buys the parent.** A four-chunk semester Commit that dies on chunk three
is now *resumed* by pressing Commit again — chunks one and two are recognised and skipped.
Before, the retry minted a fresh `batchId` and assigned every row a second time. See §6.1.

---

## 4. Authorization

### 4.1 Two credential types

| | Parent | Child device |
|---|---|---|
| Credential | `SYNC_TOKEN`, a Worker secret | Long-lived bearer, minted at pairing |
| Storage | Worker env; device-local in `appSettings` | Hashed in `devices`; plaintext only on the device |
| Scope | Everything | One `child_id` |
| Obtained by | Ray, in the dashboard | Redeeming an 8-character pairing code once |
| Revocation | Rotate the secret, redeploy | `POST /api/devices/:id/revoke`, effective immediately |

**The parent token never goes on a kid's phone.** It grants a whole-database snapshot.
This is the single most important rule in this slice.

### 4.2 Column-level ownership

The Worker — not the client — decides which columns a request may write, based on which
credential it presents.

- A **parent** request may write parent-owned columns of any assignment. Attempts to write
  child-owned columns are rejected with `400`, not silently dropped.
- A **child device** request may write child-owned columns of assignments whose `child_id`
  matches the token's child. Any `child_id` in the request body is ignored; the Worker
  derives it from the token. Attempts to write parent-owned columns are rejected `400`.

**4.2.1 Values, not only columns.** The same rule governs what may go *into* an owned
column. A device is scoped, not trusted, and the two ends of this system read these
columns differently enough that a value outside its domain breaks both: the child's planner
drops any row whose `status` is not `'pending'` (`assignment-core.js`'s `isPlannable`),
while §6.3's rescind only touches rows that still are — so a single nonsense `status` would
take a row off the kid's plan *and* lock the parent out of pulling it back, with no screen
in either app able to undo it. The Worker therefore checks `status` against its enum,
`deferred_to` against the date format, and `completed_at`/`grade`/`child_sort_order` for
numeric sanity, rejecting per row per §5.6. This was originally read as a rule about
*which* columns only, and child-supplied values went in unchecked while every
parent-supplied value was validated.

Because the two column sets are disjoint, **no two writers ever contend for a value.**
There is no last-write-wins policy in this design because there is nothing for it to
arbitrate. That is a stronger guarantee than the mirror's, achieved with less code.

### 4.3 Pairing flow

1. Parent opens Settings → Devices, picks a child, presses **Pair a device**.
2. Worker mints an 8-character code, valid 15 minutes, single use.
3. Kid opens the Child App, types the code.
4. Worker validates, marks the code consumed, mints a device bearer token, stores its
   SHA-256 in `devices`, returns `{ token, childId, childName }`.
5. The Child App stores the token in IndexedDB and never shows it again.

Rate limit: 10 failed redemptions per code, then the code is burned. Codes are single-use
regardless of outcome once consumed.

**4.3.1 Where step 3 happens.** In the **Startup Wizard**, as its second step, between the
PIN and the semester label — not only in Settings. This is the amendment of 2026-08-11 and
it is worth stating plainly, because the alternative was the shipped behaviour: the wizard
asked someone to type the child's name, wrote it locally, and handed over a planner with no
token, no plan, and no visible way to get one. Settings holds the code form too, but Settings
is behind the parent PIN, which is exactly the wrong side of the door for the one action that
makes a new device work at all.

Two consequences follow, and both are load-bearing:

- **`childName` from step 4 is the source of the local name.** Nothing types it. Step 4
  already returns the answer from the party that holds it, and a typed name was only ever a
  stand-in for not being able to ask. Re-pairing overwrites the local name only when the
  device holds none, or when the token now scopes to a different `child_id` — a display name
  set in Settings (Module 11 FR-1) is a deliberate local choice and survives a re-pair of the
  same child.
- **The token commits at step 5, before setup finishes.** So "setup completed" cannot be
  tested by the presence of a name — the pairing step writes one. It is tested by the PIN,
  which only the wizard's final step writes. A device abandoned mid-setup re-enters the
  wizard and its pairing step recognises the token it already holds rather than demanding a
  code that has been consumed and cannot be redeemed twice.

### 4.4 What an unpaired device is

Nothing. It has no plan (`/api/plan` needs the bearer), no upload path (§5.5 likewise), and
under §4.3.1 no name. This is not a degraded mode worth designing for — it is the state
before setup finishes, and the only thing the app should do in it is ask for a code.

Distinguish it from **offline**, which §8.4 does design for: an offline *paired* device has a
token, a cached plan and a draining outbox, and is fully usable. The distinction is why the
wizard requires a network round-trip once and the planner never does.

A device that has been *unlinked* — Settings → "Forget this device", which drops the local
token without revoking it server-side — lands between the two: it keeps its name, PIN, cached
plan and local history, so it does not re-enter the wizard, and the planner's empty state
points at Settings for a fresh code. Re-entering setup there would be destructive over a
recoverable state.

---

## 5. HTTP API

All same-origin under `/api/`. JSON in, JSON out, `Cache-Control: no-store`.

### 5.1 Existing, retained

`POST /api/sync/push`, `GET /api/sync/snapshot`, `GET /api/sync/status` — the curriculum
blob mirror, parent credential, unchanged behaviour, narrowed store list per §3.1.

### 5.2 Parent — assignments

| Route | Purpose |
|---|---|
| `POST /api/assignments` | Commit one chunk of a batch. Body `{ batchId, chunkIndex, childId, assignments:[…] }`. Worker mints each `id`, sets `assigned_at`/`updated_at`, returns `{ ids, applied, skipped }`. Idempotent on `(batchId, chunkIndex)` per §3.8 — a replay inserts nothing and answers `{ ids: [], applied, duplicate: true }`. Also deduplicated on the natural key `(child_id, date, kind, source_id)` per §6.6, which is what catches a *different* Commit over the same range; those rows come back in `skipped`, not as an error. `chunkIndex` defaults to `0` when absent. |
| `PATCH /api/assignments/:id` | Edit parent-owned columns of one assignment (§6.5). |
| `POST /api/assignments/rescind` | Rescind by `batchId`, explicit `ids[]`, or `childId` + date range (§6.3). |
| `GET /api/assignments` | Query by `childId`, `from`, `to`, `status`, `includeRescinded`. **This replaces Completion CSV import entirely.** |

### 5.3 Parent — devices and rewards

| Route | Purpose |
|---|---|
| `POST /api/devices/pair-code` | `{ childId }` → `{ code, expiresAt }` |
| `GET /api/devices` | List with `child_id`, `label`, `last_seen_at`, `revoked_at` |
| `POST /api/devices/:id/revoke` | Immediate |
| `GET /api/rewards` | `childId` → balances by category, plus entries |
| `POST /api/rewards/adjust` | Append a compensating or manual entry |

### 5.3a Parent — migrations (§3.7)

| Route | Purpose |
|---|---|
| `GET /api/migrations` | `{ migrations:[{name, applied}], pending: n }`. Polled on Management App load. |
| `POST /api/migrations/apply` | Applies all pending, in order. Returns `{ applied:[names], failed?:{name,error} }`. |
| `GET /admin/migrations` | Server-rendered HTML fallback page. Not under `/api/`; no JS required. |
| `POST /admin/migrations` | Form post with a confirm checkbox and a token field. |

### 5.4 Child — unauthenticated

| Route | Purpose |
|---|---|
| `POST /api/pair` | `{ code, label }` → `{ token, childId, childName }`. The only route reachable without a bearer. |

### 5.5 Child — device credential

| Route | Purpose |
|---|---|
| `GET /api/plan/version` | `{ maxUpdatedAt, count }`. Cheap poll target (§8.3). |
| `GET /api/plan?from=&to=&since=` | Assignments for the token's child. Includes rescinded rows so the client can remove them. Defaults to `today−7 … today+14`. |
| `POST /api/completions` | Batch upsert of child-owned columns. Idempotent: the server-minted `id` is stable, so a replay is a no-op. |
| `POST /api/rewards/entries` | Batch append. Idempotent on the client-minted `id` primary key. Rejects per row like `/api/completions`, and for the same §5.6 reason — a request-level `400` here would have the client discard a whole drain's worth of earnings from an append-only ledger. |
| `PUT /api/streak` | Upsert the child's streak row. |

### 5.6 Rejections

`401` unknown or revoked bearer · `400` attempted write to a column the credential does
not own, **on single-row routes** · `409` pairing code expired, consumed, or unknown ·
`413` batch over 500 rows.

**Batch routes reject per row, not per request.** `POST /api/completions` returns `200`
with `{ applied, rejected: [{ id, error }] }`. A row naming a column the credential does
not own, or an assignment belonging to another child, is listed in `rejected` and the rest
of the batch still lands.

This is deliberate and it is not a softening of §4.2 — the write is refused either way and
the stored row is untouched. It is about blast radius. The Child App's outbox treats any
4xx other than 401/408/429 as permanent and **discards the rows that request carried**
(`outbox.js`, `drainRequests`), so a request-level `400` for one malformed row would throw
away every good completion queued alongside it. Per-row rejection is the only shape that
lets a bad row fail without taking a day's work with it.

`403` is **never returned**, and no route can return it. The Worker derives `child_id`
from the token and ignores any child identifier in a request body or query string, so
"valid credential, wrong child" is not a reachable state — a completion naming another
child's assignment matches no row and comes back in `rejected`. Structural impossibility
rather than a check.

> **Closed 2026-08-11.** This previously read as a known gap: `outbox.js` inspected only
> the HTTP status, so a per-row rejection was dropped from the queue without a log and the
> child's device believed a completion had landed that the server had refused.
>
> `outbox.js` now reads `rejected` on every 2xx and records each entry in a durable
> `rejections` object store (Child App IndexedDB v6). It does **not** re-queue them: a
> rejection is permanent by construction — a column the credential does not own, a value
> outside its domain, an assignment belonging to another child — so retrying would spin
> against a server that will keep saying no. Settings surfaces the count and the reasons,
> and offers a dismissal once a parent has seen them. The store is separate from `syncMeta`
> deliberately: `plan-sync.js` does a read-modify-write on that singleton around every
> poll, and a second writer would eventually clobber the device token.

---

## 6. Assignment lifecycle

### 6.1 Assign

Propose/Review/Commit is unchanged through Review. **Commit** changes only its final act:
instead of serializing a packet and triggering a download, it mints a `batchId`
(client-side UUID) and `POST`s the rows to §5.2 in chunks of `MAX_BATCH`, each carrying its
`chunkIndex`. The Generation Log continues to record what was generated, but its
cross-air-gap purpose — remembering what had already been *sent* — is gone; it is now
scheduling history.

**6.1.1 Replay safety, and what it took.** This section used to assert that a client-minted
`batchId` made the Commit replay-safe. It did not, because nothing on the server read it:
every attempt minted fresh row ids and inserted unconditionally. A full-semester Commit is
about 1,800 rows — four chunks — so the failure was on the ordinary path, not a corner. A
POST that died on chunk three left 1,000 rows live on the child's plan, reported *"nothing
was recorded locally; press Commit again to retry"*, carried no `batchId` for the parent to
rescind with, and then assigned all 1,800 again on the retry.

§3.8's `commit_chunks` makes the claim true. What follows from it on the client
(`packet.js`):

- The `batchId` lives on the **proposal**, not the attempt, so every retry reuses it and
  resumes: chunks already stored are recognised and skipped.
- A partial send is reported as one — how many rows are live, under which batch, and that
  retrying will not duplicate them.
- Review edits are **frozen** while a batch is partly live. Resumption is by chunk
  position, so changing which rows sit at those positions would skip some and duplicate
  others.
- **Abandon** rescinds the partial batch rather than merely dropping the session, since
  otherwise the orphaned rows outlive every local record of them.

### 6.2 Batches

Every row from one Commit shares a `batch_id`. This is what makes undo tractable: without
it, reversing a bad Commit means reconstructing its extent from date-range guesswork.

### 6.3 Rescind

Rescission sets `rescinded_at`; it never deletes. A row that vanishes can be resurrected
by a stale device replaying its outbox — the same reasoning that made the mirror tombstone
its deletes.

```sql
UPDATE assignments SET rescinded_at = ?1, updated_at = ?1, updated_by = 'parent'
WHERE batch_id = ?2 AND rescinded_at IS NULL AND status = 'pending'
  AND (claimed_by IS NULL OR claimed_by = child_id);
```

Default scope is `status = 'pending'`. Rescinding work a child already completed requires
an explicit `includeCompleted: true` and is surfaced in the UI as a separate, confirmed
action.

*(The claim guard is an amendment of 2026-08-25 —
`TDS_Slice_Subject_Order_Grouped_Review.md` §3.5a, **built the same day** as the first of
that slice's two Phase 3b commits. Without it, rescinding a batch sweeps the
**losing** rows of a shared-chore claim, which are `pending` by construction; Shared Chores
§5.5's release then skips them for their `rescinded_at IS NULL` clause, and a chore either
child could have done comes back to one of them permanently. The clause is the exact
negation of Reporting's `isClaimedElsewhere`, so the winner's own row — `claimed_by =
child_id` — stays reachable by an `includeCompleted` rescind exactly as it is today. It
applies to all three selector branches, not only `batch_id`.)*

**Rescinding never claws back earnings.** `reward_entries` is append-only; a completed
assignment's reward row survives its assignment being rescinded. Reversing an award is a
deliberate compensating entry via `POST /api/rewards/adjust`. A child's balance must never
silently drop because a parent reorganised a syllabus.

### 6.4 The rescind/complete race

A parent rescinds while a kid, offline, completes the same item. On drain:

- The completion writes `status`, `completed_at`, `grade` — child-owned columns, accepted.
- `rescinded_at` is already set — a parent-owned column, untouched by the completion.

Result: the row records both facts. The planner treats an assignment as visible when
`rescinded_at IS NULL OR status <> 'pending'`, so the kid keeps credit for work genuinely
done, while the item stays out of future planning. No arbitration, no lost write. This
falls out of §3.3.4 rather than needing a rule.

### 6.5 Edit and reschedule

Moving a due date is `PATCH /api/assignments/:id` with `{ date }`. Under the packet model
this required regenerating and re-importing an entire packet.

Child-side deferment writes `deferred_to`, leaving `date` intact. The planner renders on
`COALESCE(deferred_to, date)`, and reporting can therefore distinguish "assigned Monday"
from "actually done Tuesday" — information the old model discarded.

### 6.6 The same range, committed twice

§3.8 made a Commit replay-safe, and stopped there. `commit_chunks` is keyed on
`(batch_id, chunk_index)`, so it recognises a **retry of one Commit** and nothing else. Two
*different* Commits over the same range carry two different `batchId`s, collide with
nothing, and both insert in full. Propose the same fortnight a second time — the ordinary
way a parent extends a plan or fixes one day of it — and every chore in it is on the child's
plan twice.

**6.6.1 Why re-proposing a covered range is normal, not a mistake.** Propose deliberately
reproduces prior `sent` decisions that fall in range (M7 §4.2.2) so the parent sees the
whole period rather than a hole where last week's work was. Under the packet model that
cost nothing: re-committing produced a byte-identical packet, and the child *replaced* its
plan on import — M7's acceptance check 9 asserts exactly this, and it was true. Insert-only
D1 turns the same act into a second copy. The reversal in §0 repealed the transport; this
is a guarantee that quietly went with it and was never rebuilt.

**6.6.2 The natural key.** An `id` is a server-minted UUID (§3.3.1) and can never answer
"have I already assigned this?". What can is the identity the domain already has:

```
(child_id, date, kind, source_id)
```

`POST /api/assignments` refuses to insert a row whose natural key already matches a **live**
row — `rescinded_at IS NULL`, whatever its `status`. Refused rows are reported as `skipped`,
never as an error: a Commit that overlaps existing work is a normal thing for a parent to
press, not a fault.

- **Rescinded rows do not block.** Pull a bad batch back, fix the pacing, generate the range
  again — §6.3's repair path stays open. A tombstone that blocked re-assignment would make
  rescind a one-way door.
- **Resolved rows do.** A `complete` or `waived` row is still live, and re-issuing work a
  child has already finished is the same duplicate wearing a hat.
- **A row with no `source_id` has no natural key** and always inserts. `source_id = NULL` is
  never true in SQL, so this falls out of the guard rather than needing a branch.

Enforcement is in two places on purpose. One `SELECT` per chunk, bounded by that chunk's own
date span and served by `idx_assign_child_date`, builds the set of live keys and is what
produces an accurate `skipped` count. Each `INSERT` then carries its own `WHERE NOT EXISTS`
on the same condition, which is what holds when a second parent device commits the same
range concurrently — the set was read before the statements were built, so it alone is not
enough. No unique index: a constraint violation inside `env.DB.batch()` would roll back a
whole chunk and hand the parent a 500 where the honest answer is "already there".

**6.6.3 What the Management App does with it.** Propose asks `GET /api/assignments` for the
range and marks every item whose natural key is already live. Those items are **shown**, and
they still count against the day's pacing budget, but:

- Commit does not send them, and reports how many it left alone.
- Review actions on them are refused, pointing at the Assignments view. Every Review action
  is a local rearrangement that Commit realises by *inserting*, so "relocate" on a live item
  would leave Monday's row where it is and add a second one on Tuesday — the same duplicate,
  wearing the parent's own intent as a disguise. Moving and editing a live row is §6.5's
  `PATCH`, which changes the row that exists.
- `sort_order` still advances across skipped items. The position is occupied by a row
  already in D1 carrying that number; renumbering the new rows over it would scramble the
  day.

D1 is asked rather than the Generation Log because it is the only source that knows about a
rescind — pulling a batch back leaves its `sent` log rows behind. The log is the fallback
when the device has no token or no network: conservative in the safe direction (it can
believe something is still assigned after a rescind, never the reverse) and blind to events,
which are re-derived each Propose rather than logged. The Worker's own check stands behind
both readings; the client check exists so the screen tells the truth *before* the parent
presses Commit.

---

## 7. Rewards and streak

Earning is a side effect of completion, computed on-device by the existing
`reward-core.js` and posted as a `reward_entries` row with a client-minted UUID in the same
outbox drain as the completion. The category and amount come from the assignment row's
snapshotted `reward_category`/`reward_amount`, so later edits to a tier never retroactively
change what was already earned.

Balance display reads the local cache; the server's `SUM` is authoritative on reconnect.

---

## 8. Child App

### 8.1 IndexedDB

*(Headed "v3" when written; the store list below is what matters, and the version reached
**v9** on 2026-08-11 with the `plannerMeta` fold. Versions landed one phase at a time: v3
`syncMeta`, v4 `assignments`, v5 `outbox`, v6 `rejections`, v7 `rewardEntries`.)*

| Dropped | Added |
|---|---|
| `activities`, `chores`, `events` | `assignments` (keyPath `id`) — **done, v8.** Migrated data: none. Phase 5 had already deleted the packet import that was their last writer, and phase 2 removed their last reader, so the v8 upgrade simply deletes the three (already empty) stores. |
| `plannerMeta` | — folded into assignment columns — **done, v9.** An override this device wrote but had not yet drained is carried onto the `assignments` row it overrides (`child_block_hint`/`child_sort_order`/`deferred_to`) before the store is dropped; an override with no matching row is dropped with it. Local writes now go straight onto the cached row (`DB.setAssignmentFields`) instead of a separate keyed store, and an incoming `/api/plan` row is patched with anything still queued in the outbox before it overwrites the cache (`DB.applyPlan`), so a poll racing the drain cannot revert a pending deferral or reorder. |
| `activityRecords` | — folded into `status`/`completed_at`/`grade` |
| `rewardLedgerSnapshot`, `rewardLedgerTail` | `rewardEntries` (keyPath `id`) — **done, v7.** The key is the client-minted entry id the outbox uploads (§5.5), so the local row and the server row are one row. Balance is `CompletionCore.balanceOf`, never stored. Migrated, not dropped: the v7 upgrade rewrites the snapshot as a single opening entry and each tail row as a signed entry, inside the versionchange transaction, so an interrupted upgrade retries against untouched data. |
| — | `outbox` (autoIncrement) |
| — | `rejections` (autoIncrement) — §5.6's refused writes, kept to be shown |
| — | `syncMeta` singleton: device token, `childId`, `lastVersion` |
| `child`, `semester`, `themeSettings`, `streak` retained | |

### 8.2 The `loadState()` adapter

`DB.loadState()` returns `{ rows }`. `rows` is what the whole Child App works from: the
`assignments` rows for this device, live and pending only (§6.4), each decorated by
`assignment-core.js`.

This was an explicit compatibility shim with a stated lifespan: it existed so the planner UI
did not have to be rewritten in the same change that replaced the data layer. All three
phases of §14's collapse are now built. What each one removed is described below, for the
record.

**Phase 1 removed the second object.** `decorate()` used to emit a packet-shaped record
*plus* a parallel `meta` map holding the child-owned values under different names, so every
planning decision consulted two objects and an id lookup to answer what one row already
answered. It now returns the row, and the derivation in `planner-core.js` reads
`deferred_to`, `child_block_hint` and `child_sort_order` directly — §3.3.3's
`COALESCE(child_sort_order, sort_order)`, evaluated on the client exactly as the server
states it.

**Phase 2 removed the second vocabulary.** `decorate()` used to add a camelCase alias for
six columns — `courseName`, `sequenceNumber`, `activityType`, `rewardCategoryId`,
`rewardAmount`, `expectedDurationMin` — and to overwrite the `payload` column with a parsed,
stripped object, so a row answered to two names for one value and misreported one of its own
columns. `planner-ui.js` and `completion.js` read the §3.3 columns now, and the aliases are
deleted. `subjectsView`'s synthesized groups are keyed `course_name` for the same reason: the
value is the column.

What `decorate()` does is now exactly one thing — **the row, plus the fields §3.3 gives no
column**, every one of them lifted out of `payload`:

| Added | Applies to | Why it cannot be a column |
|---|---|---|
| `required` | activity, chore | §3.3 has none; drives the overdue roll-forward (§2.1) |
| `capturesGrade` | activity | §3.3 has none; gates grade entry (Module 4 FR-2) |
| `startDate` / `endDate` | event | The row's `date` is one in-range day, not the span |
| `difficultyTier`, `lessonTitle`, `instructions`, `choreType`, `notes`, `time` | by kind | Parent-authored detail with no column |
| `content` | activity | The kind-specific descriptor (`pageRange` / `reference` / `freeText` / `none`) that `packet.js`'s `projectPayload` writes |

`content` is named for what it is rather than shadowing `payload`, which is passed through
untouched — so the decorated object is still the row, with additions, and nothing has to know
that a column was reinterpreted on the way past.

*(As of the ninth amendment this is no longer how an unflushed override reaches the planner
— see below. It stood while `plannerMeta` was still live: an override this device had
written but not yet drained lived there in the pre-revamp vocabulary, and `loadState()`
overlaid it onto the row as the column it was on its way to becoming, field by field, so a
pending deferral reached the planner without a second shape surviving alongside the first.)*

**Phase 3 dropped the store shape, not `plannerMeta` itself.** The four legacy `loadState()`
keys — `activities`, `chores`, `events`, `meta` — and the IndexedDB stores the first three
mirrored are gone as of v8: nothing had read any of them since phase 2 (`planner-ui.js` and
`streak.js` both took `rows` already, and `meta` lost its last reader when `planner-core.js`
stopped taking one), so this was a deletion with no callers to convert, plus the matching
amendment to CLAUDE.md §IV.B. Two files reached into the dropped stores directly, bypassing
`loadState()` entirely, and needed real changes rather than a deletion: `export-core.js` /
`export.js` (Module 8's CSV report) read the received Activity/Chore for a completion's
course, activity type, block hint and sequence number — that source is now the decorated
`assignments` row, keyed the same way the old `activities`/`chores` maps were, and a
completion whose assignment has aged out of the local cache window (§8.3) is skipped, same as
an orphaned record was before. `wipe.js` (Module 9) opened its own transaction against
`activities`/`chores`/`events` to pair-delete a completion's source item and clear past family
events; both had been no-ops since Phase 5 — nothing wrote either store for a
server-assigned completion — so Wipe now runs against `activityRecords` alone, which is the
part of it that ever cleared anything.

`plannerMeta` itself was not part of phase 3 — §8.1's table named folding it into
`child_block_hint`/`child_sort_order`/`deferred_to` as the eventual shape, but that meant
writing local overrides straight onto the cached `assignments` row instead of a keyed store,
a write-path change rather than a shim with idle callers. **Done, ninth amendment, IndexedDB
v9.** `deferment.js` and `planner-ui.js` now call `DB.setAssignmentFields(id, patch)` with a
patch already in column vocabulary, which reads the cached row, merges the patch in, and
writes it back — no separate store, no second vocabulary. `DB.loadState()` drops the
`plannerMeta`/`applyLocalMeta` merge entirely and reads `assignments` alone, since a local
override is now just a value already on the row it describes.

That removes the reason `applyLocalMeta` existed — reapplying an unflushed override at every
read — but the race it was quietly covering is real: `plan-sync.js`'s poll can land between a
local write and the outbox draining it, and a naive `store.put()` of the server's copy would
overwrite the column the child just set with whatever the server last knew. `DB.applyPlan`
closes that the other way: before storing an incoming row it looks up anything still queued
for that assignment id in the `outbox` store, keeps only the planner columns
(`OutboxCore.columnsFromCompletionFields` — `status`/`completedAt`/`grade` are excluded,
since completion state lives in `activityRecords` and was never staged here), and reapplies
them on top. The outbox is already the durable record of what has not reached the server;
this reads it as that, rather than duplicating it in a second store.
`OutboxCore.completionFieldsFromOverride` (column → wire) and `columnsFromCompletionFields`
(wire → column) are exact inverses of one shared map, so the outgoing request and the
ingest-time reapplication cannot name a field differently from each other.

### 8.3 Freshness

`GET /api/plan/version` on launch, on `visibilitychange` to visible, and every 60s while
open. If `maxUpdatedAt` exceeds the cached value, fetch the delta with `?since=`. No
WebSockets, no Durable Objects, no push subscription. At a kid's usage pattern this is
indistinguishable from push and costs nothing.

### 8.4 Online-first, offline-tolerant

The app opens from cache and renders the last known plan instantly. Completions commit
locally and enter the outbox, which drains on reconnect. What is genuinely given up: a
device must reach the network at least once to *receive* new assignments. There is no
sneakernet fallback, by choice.

### 8.5 Service worker

The current worker is cache-first for every GET, which would serve a stale plan
indefinitely. Required change: cache-first for the precached shell, **network-only for
`/api/*`**, never cache an API response.

---

## 9. Management App

- `packet.js` — Commit posts rows; Propose and Review untouched.
- New **Assignments** view: browse by child and date range, rescind a batch, edit or move
  a single assignment.
  *(Presentation amended 2026-08-25 by `TDS_Slice_Subject_Order_Grouped_Review.md` §3 — the batch
  list moves behind a collapse; a day's rows group subject → course with chores and events in
  groups of their own; a chore a sibling claimed reads as resolved rather than outstanding (§3.5,
  from `claimed_by` — no sweep and no auto-rescind, §3.6); and rescinded rows are hidden behind a
  checkbox, still fetched so the count stays honest (§3.7). **Built 2026-08-25**, §3 in Phase 3 and
§3.5/§3.7 in Phase 3b. §3.5 and §3.7
  are read-side only and no column or route changes; the slice's one write-path change is §3.5a,
  a narrowing clause on the rescind statement in §6.3 above, which stops a batch rescind sweeping
  a shared chore's losing rows.)*
- New **Reporting** reads `GET /api/assignments` and `GET /api/rewards` directly. Module 10
  keeps its analysis; only its input changes.
- Module 09 (Completion Import) is deleted, not ported.
- Settings gains **Devices** (pair, list, revoke).

---

## 10. Deployment

One Worker, both apps, per the decision recorded in session:

```toml
name = "scheduling-app"
main = "./management-app/worker/index.js"
compatibility_date = "2025-04-01"

[assets]
directory = "./"          # was "./management-app"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "scheduling-app"
database_id = "bb58d835-f115-4ae5-a8ad-5653b102957e"

# Bundles each migration file into the Worker as text so Settings → Database and
# /admin/migrations can apply them from a button click (§3.7).
[[rules]]
type = "Text"
globs = ["**/*.sql"]
fallthrough = true
```

A repo-root `.assetsignore` is load-bearing once the assets directory widens — everything
not excluded becomes publicly downloadable:

```
.git/
.github/
docs/
migrations/
management-app/worker/
node_modules/
tests/
*.md
package.json
package-lock.json
wrangler.toml
```

`migrations/` is excluded from *assets* but still reaches the Worker, because §3.7.2
imports the files into the bundle rather than serving them.

**No CLI is required at any point.** `DEPLOY.md`'s current step 3 — pasting `CREATE TABLE`
statements into the D1 console one at a time — is removed and replaced by §3.7: push, then
click Apply. The only remaining dashboard steps are creating the database once and setting
the `SYNC_TOKEN` secret.

Worker-side redirects: `/` → `/management-app/`, `/kid` → `/child-app/`.

Nothing else about the deploy changes — `wrangler.toml` stays at the repo root, one git
connection, no build command, secrets on the Worker. The Child App moves off GitHub Pages
to gain same-origin (no CORS); cost is a one-time home-screen re-add and a service worker
scope of `/child-app/`, which the existing relative paths already satisfy.

**Free-tier headroom** (verified 2026-08-10): Workers 100k requests/day with static assets
free and uncapped; D1 5 GB, 5M row reads/day, 100k row writes/day. Projected load is ~2% of
the request ceiling; a full semester Commit for three children is ~5,400 row writes, about
5% of the daily write budget. The failure mode at the ceiling is hard — D1 returns errors
until 00:00 UTC — but is not reachable at this volume.

---

## 11. Deleted

`fixtures/packet_schema.json` · `fixtures/packet_sample.json` ·
`child-app/js/validator.js` · `import-core.js` · `merge-core.js` · `importer.js` ·
`schema.js` · `sample-packet.js` · Child Module 02 · Management Module 09 ·
`Interchange_Contract.md` as a contract.

`export-core.js` **survives, repurposed**: CSV stops being transport and becomes a report
export for a parent who wants a spreadsheet. It is no longer on any critical path.

---

## 12. Phasing and cutover

The current app keeps working throughout.

> **The live-days gate is repealed** (sixth amendment). This section used to open "nothing
> is deleted until the replacement carries real days", and Phase 5 was marked "only after
> phases 3–4 have carried live days". Both are withdrawn.
>
> The rule was written when every phase still had a fallback behind it — a file import, a
> CSV import — and the worry it answered was deleting one before the replacement had been
> trusted with a real week. Phase 5 has since deleted those fallbacks, so there is nothing
> left for the gate to protect; what it was still doing was blocking the §8.2 shim collapse,
> which deletes no fallback at all and only removes scaffolding this document has called
> scaffolding since it was written.
>
> Judgement replaces it: **do not delete a path while something still depends on it**, which
> is a thing to check rather than a period to wait out. Work that is deferred from here is
> deferred for a stated reason of its own — see §14, where each open item carries one.

> **No backfill phase.** An earlier draft opened with one, because `sync.js`'s outbox only
> ever captured writes made *after* a sync token was set — curriculum authored before that
> never reached D1. That gap is real and is what cost Ray a curriculum. It is not a task,
> because there is nothing left to recover: authoring restarts on the new system.
>
> The consequence that matters for sequencing: **no new curriculum should be authored until
> Phase 1 lands and durability is verifiable.** Do not re-add a backfill phase.

| Phase | Work | Note |
|---|---|---|
| **0** | Migration runner + `/admin/migrations` (§3.7) | **Must land before any schema change.** It is the only way schema reaches the database without a CLI, so it is a prerequisite for Phase 1 rather than part of it. Start here. |
| **1** | Schema migrations + Worker routes (§3, §5) | Applied by clicking Apply. No client changes yet. |
| **2** | Pairing (§4.3) + Devices UI | Child App still on the old path. |
| **3** | Commit writes assignments; Child App reads `/api/plan` | File import retained as fallback. |
| **4** | Completions and rewards upload; Reporting view | CSV import retained as fallback. |
| **5** | Delete §11, collapse the §8.2 shim, service worker fix | **Done.** The §11 deletions, the service worker fix, and all three phases of the shim collapse — see §14. |

---

## 13. Acceptance checks

1. Two devices paired to different children; each `GET /api/plan` returns only its own
   child's rows. A device posting a completion for an assignment belonging to the other
   child changes nothing and gets that row back in `rejected` — `/api/plan` takes no child
   parameter to forge, and `/api/completions` ignores any `childId` in the body, so there
   is no request that expresses "this child's token, that child's data."
   *(Was: "a device token used with another child's ID returns `403`." That check could
   never fail, because no route accepts a caller-supplied child id in the first place —
   see §5.6. Rewritten to test the guarantee that actually holds.)*
2. A child device token presented to `/api/sync/snapshot` returns `401`.
3. A child request writing `title` or `reward_amount` leaves the stored row unchanged and
   names the offending column in `rejected`, while every well-formed row in the same batch
   is applied. *(Was: "returns `400`." See §5.6 — a request-level 400 would make the
   client discard the whole batch.)*
4. Commit a batch, then rescind by `batch_id`: pending rows gain `rescinded_at`, completed
   rows are untouched, and every `reward_entries` row survives.
5. Rescind a batch while a device is offline with a pending completion for one of its rows.
   On drain the row shows both `rescinded_at` and `status='complete'`, and the reward stands.
6. Replay an identical `POST /api/completions` twice: no duplicate rows, no duplicate
   reward entries, balances unchanged.
7. Revoke a device; its next request returns `401` without a redeploy.
8. Airplane mode: the app opens, renders the cached plan, accepts completions, and drains
   them on reconnect.
9. `SELECT` assigned-vs-completed for a child over a date range returns a correct report
   with no CSV involved anywhere.
10. `curl` the deployed origin for `/docs/…`, `/wrangler.toml`, `/migrations/…`, and
    `/management-app/worker/index.js`: all `404`.
11. On a database with no tables, open `/admin/migrations`, supply the token, tick confirm,
    apply: every migration lands and the page then reports zero pending. **Performed with a
    browser only — no CLI, no D1 console.**
12. Re-apply with nothing pending: reports "No pending migrations" and writes nothing.
13. Register a deliberately broken migration after two good ones: the two apply, the third
    reports its error by name, `d1_migrations` lists exactly the two, and the broken one's
    partial statements left no trace.
14. Load the Management App with a migration pending: the Settings → Database banner appears
    without being asked for.
15. `/admin/migrations` renders and applies with JavaScript disabled, and with the
    Management App's own startup deliberately broken.
16. Post the same `(batchId, chunkIndex)` twice: the second answers `duplicate: true` with
    the first attempt's `applied` count, and `SELECT COUNT(*)` over that batch is unchanged.
17. Commit a proposal larger than one chunk with the network cut after the first chunk: the
    error names the batch and the rows already live, Review actions are refused, and
    pressing Commit again finishes the batch with no duplicated row.
18. Abandon that same partly-sent proposal instead: every pending row of the batch gains
    `rescinded_at`, and nothing is recorded in the Generation Log.
19. A child device posting `status: 'banana'`, a non-date `deferredTo`, or a non-numeric
    `grade` leaves the stored row unchanged and names the offending field in `rejected`,
    while well-formed rows in the same batch apply.
20. A batch of reward entries containing one entry with no `category`: the rest are
    appended and only the bad one comes back in `rejected` — the request is not a `400`.
21. Provoke a per-row rejection on a paired device: the count appears in the Child App's
    Settings, the reason is listed, it survives a reload, and dismissing it clears it.
22. **First run, end to end, on a device that has never held this app.** Mint a code in
    Settings → Devices, open `/kid`, set a PIN, type the code, finish setup: the child's own
    name — never typed — appears in the planner header, and their committed plan is on screen
    without anyone opening Settings. This is the check the shipped wizard could not pass
    (§4.3.1).
23. Type that code in lower case with a dash through the middle: it pairs identically.
    Then try an expired one and an already-consumed one: each names its reason, the step
    stays put, and a fresh code entered afterwards still works.
24. Close the app immediately after the pairing step and reopen it: setup restarts at the
    PIN, its pairing step reports the device already linked and names the child, and no
    second code is asked for. Finishing from there produces exactly one device row in
    Settings → Devices.
25. Pair a device, rename the child in the Child App's Settings, then revoke and re-pair to
    the *same* child: the chosen name survives. Re-pair to a *different* child: the name
    follows the new token.
26. **§6.6, the check M7's acceptance 9 used to make.** Commit a range containing a weekly
    chore, then Propose the *same* range again and Commit: the already-assigned items are
    marked on screen, `SELECT COUNT(*)` over the child's live rows for that range is
    unchanged, and the child's planner shows each chore once. Repeat with `sourceId`
    unchanged but the date moved by a day: that one *is* a new row, because it is a
    different assignment.
27. Rescind that batch, Propose the same range again: every item is offered as new — no
    tombstone blocks it — and Commit restores the plan. With the device offline instead
    (no token, or the API unreachable), Propose falls back to the Generation Log, says so
    on screen, and Commit still assigns nothing twice because the Worker refuses it.
28. Relocate, Exclude, Defer or Drop an already-assigned item in a proposal: each is
    refused and names the Assignments view. Moving it there instead changes the row's
    `date` in place and produces no second row.

---

## 14. Deferred

- Pacing engine in the Worker (unattended generation). Schema is ready; see §0's decision.
- Web Push for "new plan available". Polling is sufficient; VAPID and iOS quirks are not
  worth it yet.
- Normalizing curriculum out of `records` into relational tables. Only needed if the server
  must generate plans or report on curriculum structure.
- Multi-parent accounts. The single-authoring-parent assumption stands.
- Scheduled snapshot export as a real backup. Cloud storage is not a backup; `/api/sync/snapshot`
  already provides the mechanism, but nothing yet runs it on a schedule.
- **A per-tier reward amount.** §7 has the earned amount come from the assignment row's
  snapshotted `reward_amount`, and the column is real, but nothing populates it: a tier is
  `{ tierId, label, order, rewardCategoryId }` with no number on it, so `packet.js` leaves
  the column NULL and `completion-core.js` falls through to the flat `1` the Child App has
  always used. Both ends handle that coherently and the plumbing is finished — what is
  missing is the field on the tier, and a decision about whether it is per tier or per
  activity. Until then §7 describes a path that carries a constant. The one way a row gets
  a real amount today is a parent editing it by hand in the Assignments view.
- **Collapsing the §8.2 shim — done.** All three phases are built; this entry is retained for
  the record rather than deleted, per §14's own convention for finished items (see the local
  ledger note at the end of it).

  **Done (phase 1): the derivation moved onto the row.** `planner-core.js` and
  `streak-core.js` read the child-owned columns (`deferred_to`, `child_block_hint`,
  `child_sort_order`) off the assignment row and no longer take a `meta` map; the views
  take the flat row array and select on `kind` instead of being handed a pre-sorted
  `{ activities, chores, events }` triple. `assignment-core.js` stopped minting a second
  object per assignment — `decorate()` returns the row with the pre-revamp *names* added
  alongside its columns, so there is one object per assignment carrying its own overrides.
  `receiptIndex` and the `blockHint` alias are gone with the lookups that needed them, and
  `DB.loadState()` overlaid an unflushed `plannerMeta` record as the columns it was on its
  way to becoming rather than as a parallel map. *(That overlay is itself gone as of the
  ninth amendment — the columns it wrote onto are all the row has now.)*

  **Done (phase 2): the render names.** `planner-ui.js` renders from the §3.3 columns —
  `course_name`, `sequence_no`, `activity_type` — and `completion.js` builds its earn entry
  from `reward_category` and `reward_amount`. The six camelCase aliases `decorate()` minted
  for them are deleted, `expectedDurationMin` among them (nothing had read it since the
  packet era). `payload` is no longer overwritten with a parsed subset of itself: the column
  passes through untouched and an activity's kind-specific descriptor is added as `content`.
  `subjectsView`'s groups are keyed `course_name`. What `decorate()` adds is now only what
  §3.3 gives no column — see §8.2's table.

  **Done (phase 3): the store drop.** IndexedDB reached v8: `activities`, `chores` and
  `events` are deleted (empty on every device that reaches this upgrade — Phase 5 had already
  removed their last writer), and `DB.loadState()` returns `{ rows }` alone. CLAUDE.md §IV.B
  no longer pins the four legacy keys; `toState()` no longer builds them. This was a deletion
  with no callers to convert — nothing had read `activities`/`chores`/`events`/`meta` since
  phase 2 — except for two files that reached into the dropped stores directly, bypassing
  `loadState()`: `export-core.js`/`export.js` (Module 8's CSV report) now source a
  completion's course, activity type, block hint and sequence number from the decorated
  `assignments` row instead of the received Activity/Chore, keyed the same way; and
  `wipe.js` (Module 9) now runs against `activityRecords` alone, having dropped the
  pair-delete and past-event clear that read `activities`/`chores`/`events` and had been
  no-ops since Phase 5 for the same reason. Neither is a shim in the sense the rest of this
  item is — they never answered to two vocabularies — but both would have thrown against a
  store the v8 upgrade no longer creates, so they moved with it.

  > The **local ledger** half of this item, with which it was originally bundled, is
  > **done** — see the third amendment at the head of this document.

  **Split out, folding `plannerMeta` into the columns — done, ninth amendment.** §8.1's
  table had named this as the eventual shape — `child_block_hint`/`child_sort_order`/
  `deferred_to` written straight onto the cached `assignments` row instead of staged in a
  separate keyed store — and unlike the store drop above, it was a write-path redesign with
  several files holding a stake in it, which is why it was split out rather than folded into
  a "shim collapse" that was otherwise finished.

  IndexedDB reaches v9: `foldPlannerMetaIntoAssignments` carries any override this device had
  written but not yet drained onto the `assignments` row it overrides, then drops the store
  (an override with no matching row — the assignment had already aged out of the cache — is
  dropped with it, same as `pruneMeta` used to do at runtime). `deferment-core.js`'s
  `buildReschedulePatch` and `planner-ui.js`'s block-picker/reorder handlers now build a patch
  keyed by column name (`deferred_to`, `child_block_hint`, `child_sort_order`) instead of the
  pre-revamp `deferredDate`/`blockHint`/`sortOrder` shape; `db.js`'s `setMeta`/`pruneMeta` pair
  is replaced by one function, `setAssignmentFields`, a read-merge-write directly against the
  cached row. `DB.loadState()` no longer merges a second store — `AssignmentCore.applyLocalMeta`
  and its `META_TO_COLUMN` table are deleted along with the read-time merge they existed for.

  What replaces that merge is a write-time one: `DB.applyPlan`, which ingests every
  `/api/plan` poll, now reapplies any planner-column write still sitting in the `outbox` store
  on top of an incoming row before storing it, so a poll that lands before the outbox drains
  cannot silently overwrite a deferral or reorder the child just made with the server's
  not-yet-caught-up copy. `outbox-core.js`'s `META_TO_COLUMN` is replaced by `PLANNER_COLUMNS`
  plus its two directions, `completionFieldsFromOverride` (column → the wire's camelCase) and
  `columnsFromCompletionFields` (the reverse, used by `applyPlan`) — one map, so the outgoing
  translation and the ingest-time reapplication cannot name a field differently.

- **Whether a reward balance floors at zero.** The device folds a category's entries with a
  per-step zero floor, so an adjustment large enough to take a category negative leaves the
  child at `0` and the next earn counts up from there. §3.4's server balance is a flat
  `SUM(amount)` and would report the negative. Both behaviours are defensible — the floor
  implements the locked "no negative or owed state" rule (Roadmap §8), the sum is what an
  append-only ledger literally says — and nothing reconciles them, so §7's "the server's
  `SUM` is authoritative on reconnect" currently describes an intent no code implements.
  The divergence is latent: it needs an adjustment bigger than a balance to become visible,
  and only the parent's repair form can write one. Recorded rather than fixed because
  choosing an end is a product decision, not a refactor. It predates the ledger collapse.
