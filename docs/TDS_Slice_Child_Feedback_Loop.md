# Technical Design Specification — Slice

## Scope: Child Feedback Loop — Undo, Course-Ordered Filtering, Completion Notes, Assignment Messages (Child App, + minimal Management App read-side)

**Status:** Drafted 2026-08-12, in-session with Ray. The four decisions in §0 were made in-session
(AskUserQuestion) and are locked; the rest of this document is the design that follows from them,
drafted for review before build starts. Per `CLAUDE.md` §II, this document is what makes each
feature below buildable — nothing in it should be implemented until it is confirmed against §10's
open items.

**Applies to:** Child App primarily. Management App gains a small read-only surface for Notes
(§5.4) and a new Inbox surface for Messages (§6.5) — both are called out as isolated, app-owned
code per `CLAUDE.md` §I.A; neither shares a JS file with the Child App.

**Builds on:** `TDS_Slice_Online_Revamp.md` (the shared `assignments` table, column-level
ownership, the outbox/drain model, the append-only `reward_entries` ledger). Nothing here
repeals or amends that document; this slice only adds columns, one table, and routes in the
shape it already established.

---

## 0. Decisions made in this slice

1. **Undo requires no parent PIN.** Unlike Waive/Reschedule (SRS Module 5), un-completing an item
   reverses everything the completion granted, in the same action: the reward is clawed back (§3.3)
   and the streak advance is walked back (§3.4). There is nothing left to bank, so there is nothing
   to game. This is a property of the design rather than an assumption about the child — if either
   reversal were dropped, Undo would become a way to keep a reward or a streak day for work that
   was not done, and the PIN question would have to be reopened (§10).
2. **"Subject" is dropped as a grouping level.** The Management App's course records do carry a
   free-text `subject` field (`management-app/js/courses.js:106`, `children.js:717`), but it is
   never carried onto an `assignments` row today — the Commit builder (`management-app/js/packet.js`)
   only snapshots `courseName`, and the `assignments` schema has no `subject` column. Wiring
   `subject` through Commit into a new column, and re-deriving the Child App's grouping around it,
   is real but separate scope (§10). This slice sorts/groups by `course_name` only.
3. **Assignment Messages are one-way for v1.** Child → parent only. The parent reads in a new
   Management App inbox; there is no reply channel and the Child App does not poll for one.
   Two-way threading is future scope (§10).
4. **The Completed view shows the real device-local day only.** No historical browsing, no undo of
   a past day's completion. This keeps Undo's blast radius to "the thing I just did," and avoids a
   policy question about how far back a reward can be reversed. "Real device-local day" is meant
   literally, and is not the same thing as the planner's `state.today` — the preview affordance can
   point that at any date, and §3.2 says why this view must not follow it.

---

## 1. Why a slice, not the full TDS

All four features are additive to the shared-table model `TDS_Slice_Online_Revamp.md` already
locked in: two need no schema change at all, one adds a single nullable column, and one adds a
single new append-only table following the exact pattern `reward_entries` already established
(client-minted id, idempotent insert, parent reads / child appends). Nothing here changes an
existing column's ownership, an existing route's contract, or the outbox's drain mechanics —
it extends all three in place.

This slice fixes, per feature: the schema delta (if any), the new/changed routes and their
validation, the outbox integration, the UI flow, and what's explicitly deferred.

---

## 2. Schema changes — summary

Two new migrations, forward-only, each registered in `management-app/worker/migrations.js`
per `CLAUDE.md` §III.D — applied from Settings → Database in the browser, never a CLI or the
D1 console.

| File | Change |
|---|---|
| `migrations/0004_completion_note.sql` | `ALTER TABLE assignments ADD COLUMN completion_note TEXT;` — one nullable, child-owned column (§5). |
| `migrations/0005_assignment_messages.sql` | `CREATE TABLE assignment_messages (...)` — one new append-only table (§6). |

Neither migration touches the Child App's IndexedDB schema version *except* §6.3, which adds one
new local store (`assignmentMessages`) and therefore does bump it — noted there, not here. §3.4
adds a field to the object stored in the existing `streak` singleton, which is a value change
inside a store that already exists and needs no version bump.

Undo (§3) and course-ordered filtering (§4) need **no migration at all** — both work entirely
within columns and enum values (`status: 'pending'`, `reason: 'adjustment'`) the Worker already
accepts (`management-app/worker/validation.js:26`, `management-app/worker/index.js:1059`).

§5.5 covers the one ordering hazard the browser-applied migration model creates for §5, and why
that phase ships across two releases rather than one.

---

## 3. Feature A — Completed view + Undo

### 3.1 Problem

`PlannerCore.onToday()` (`child-app/js/planner-core.js:79-84`) drops a resolved row from every
view the instant `isResolved(row.id)` is true. A child has no way to see what they checked off
today, and no way to correct a mis-tap or a dishonest tap short of asking a parent to do it for
them in the Management App.

### 3.2 View

New tab in `planner-ui.js`'s `VIEWS` array: `{ id: "completed", label: "Completed" }`.

Data source: `state.records` (`activityRecords`, already loaded every `reload()` —
`planner-ui.js:73-75`), filtered to
`status === 'complete' && date === g.DateUtil.localISODate(new Date())`.

**The filter reads the real device-local date, not `state.today`, and this is load-bearing.**
`state.today` is the planner's *view* date: the preview affordance (`openPreviewDate`,
`planner-ui.js:209`) lets a child point it at any day, and every other view reads it as "today"
precisely so that previewing works at all. Completion does not follow it — `completeItem` hands
`buildActivityRecord` the real `g.DateUtil.today()` (`completion.js:63-65`), so a record's `date`
is always the day the work actually happened. Filtering this view on `state.today` would therefore
list some past day's completed items and put a live Undo button on each of them, which is exactly
the reach §0.4 exists to prevent. A read-only surface may follow the preview date — `todayCounts()`
does (`planner-ui.js:275-283`) and is harmless for it — but a destructive control may not.

The intended consequence: while a preview is active, the Completed tab shows the real day's
completions rather than the previewed day's. The existing preview banner (`previewBanner`,
`planner-ui.js:241`) already tells the child the rest of the screen is not today, so the tab does
not need a second warning of its own.

`date` on an `activityRecords` row is "the device-local calendar day the child would recognise"
(`completion-core.js:71-76`'s comment on `buildEntry`, same value `buildActivityRecord` stamps) —
not the assignment's due date — so an overdue item rolled forward and finished today correctly
shows up as completed *today*, which is what a child means by "what did I do today."

Each row is joined back to its `assignments` row (`state.data.rows`) for title/course/block/grade
display, using the existing `itemCard`-adjacent rendering conventions (read-only here — no reorder
controls, no block picker; this view is a list, not a plan).

Waived items are explicitly **out of scope** for this view and for Undo — SRS Module 5 already
frames a waive as "can't be undone," and reversing one would need to un-waive *and* decide whether
required-item roll-forward resumes, which this slice does not take on.

Empty state: "Nothing completed yet today."

### 3.3 Undo mechanics

New `Completion.undoItem(item)` in `completion.js`, mirroring `completeItem`'s shape:

1. Guard: only proceeds if a local `activityRecords` row exists with `status === 'complete'` for
   `item.id`. (A `'waived'` row is left untouched — no Undo button is rendered for it, per §3.2.)
2. Compute the reversal: same category and amount the original earn used —
   `item.reward_category` / `item.reward_amount` (falling back to the flat `1`,
   `completion-core.js:88-91`'s existing rule) — **negated**. This is recomputed from the
   assignment row's own snapshotted values, not looked up from the original ledger entry, so it
   can never disagree with what was actually earned (the assignment row is immutable child-side
   between assign and rescind).
3. Delete the local `activityRecords` row: `DB.del("activityRecords", item.id)` (`db.js:262`,
   already on `g.DB`'s surface alongside `delMany`). The store's keyPath is `activityId` and
   `buildActivityRecord` stamps that with the assignment id, so `item.id` is the key — the same
   lookup `completeItem`'s idempotency guard already performs (`completion.js:53`). This is a
   cache/outbox mutation, not a ledger mutation — `CLAUDE.md`'s append-only rule binds
   `reward_entries` (and server-side, the assignment row's rescission), not this local mirror.
4. Enqueue a completion op clearing the row back to pending:
   `{ status: 'pending', completedAt: null, grade: null, completionNote: null }` (the last field
   only once §5 lands) via the existing `Outbox.enqueueCompletion` path. `null` is already a
   universally accepted value for every completion field (`validateCompletionValue`'s
   `if (value === null) return null;`, `validation.js:39`) — no Worker change needed.
5. Mint and enqueue a reversal `reward_entries` row via the existing `Outbox.enqueueReward` path:
   `reason: 'adjustment'`, `assignmentId: item.id`, `amount` from step 2. The Worker already
   accepts a device-posted `'adjustment'` entry at any signed amount
   (`management-app/worker/index.js:1059`) — this is the existing trust model (a device is
   already trusted to report its own reward accounting; the server does not recompute), not a new
   exposure this feature introduces.
6. Walk back the streak advance if today has stopped qualifying, via `Streak.undoToday()` — the
   reversal path designed in §3.4. Note that this is *not* `notifyStreak()`/`recheckToday()`: that
   path advances a streak and never retracts one, so it is a no-op in this direction.
7. `reload()`.

`CompletionCore.balanceOf`'s existing zero-floor fold (`completion-core.js:107-130`) already
handles "the reward was already spent before the undo" — the category floors at 0 rather than
going negative, matching the locked "no owed state" rule.

### 3.4 Streak reversal

Completing the last unresolved required item of the day advances the streak — `notifyStreak()`
calls `Streak.recheckToday()` (`streak.js:46-57`) as the final step of `completeItem`. Undo has to
walk that advance back, and Module 7 as it stands cannot: `recheckToday` returns without writing on
any day whose `dayStatus` is not `'resolved'` (SRS Module 7 FR-2 — "neutral/breaking never trigger
a change"), so once a day has been counted, the count stands. `reconcileOnOpen` does not close the
gap either; it walks *forward* from `lastQualifyingDate + 1` (`streak.js:66-81`), so the day it is
anchored on is never re-judged, on that open or any later one.

Without a reversal path, then, a child banks a streak day by completing the day's last required
item and immediately undoing it — permanently, and repeatably once per day. That is precisely the
outcome §0.1's no-PIN decision rests on being impossible, so the reversal is a requirement of this
feature rather than a refinement of it.

**Design.** A new `Streak.undoToday()`, added to Module 7's single-writer surface
(`streak.js:83`) and called from `Completion.undoItem` step 6:

1. Load context exactly as `recheckToday` does (`loadContext()`, unchanged).
2. Write nothing unless **both** conditions hold: `streak.lastQualifyingDate === today` (today was
   counted) and `StreakCore.dayStatus(rows, resolved, today) !== 'resolved'` (today no longer
   qualifies). Undoing a non-required item, or a required one on a day that is still fully
   resolved, correctly leaves the streak alone — neither changes whether the day qualified.
3. Restore the streak record that the day's advance replaced.
4. Enqueue the restored record through the existing `Outbox.enqueueStreak` path.

Step 3 restores a snapshot rather than decrementing, because the value to return to is not
derivable. `lastQualifyingDate` is not simply "yesterday": `dayStatus` returns `'neutral'` for a day
carrying no required items, `reconcileOnOpen` walks neutral days without writing, and so a single
advance can move `lastQualifyingDate` forward across an arbitrary gap of neutral days. Subtracting
one from `currentStreak` and guessing the previous date would be wrong whenever that gap is
non-empty — which is every school holiday.

So `write()` records what it is displacing. The `streak` singleton gains one field:

```js
{
  currentStreak: 3,
  lastQualifyingDate: "2026-08-12",
  longestStreak: 7,
  // The record this one replaced. Written only by the live same-day advance in
  // recheckToday, read only by undoToday, cleared by both undoToday (on restore)
  // and reconcileOnOpen's reset (a reset is not an advance, so there is nothing
  // for an undo to walk back to).
  //
  // Local-only: buildStreakOp (outbox-core.js:114-126) names the three fields
  // it puts on the wire, so this never reaches the Online Revamp's §3.5 row
  // and needs no column there.
  priorStreak: { currentStreak: 2, lastQualifyingDate: "2026-08-11", longestStreak: 7 }
}
```

One level of history is sufficient, and is not a limitation being tolerated: `recheckToday`'s
`if (lastQualifyingDate === today) return` (`streak.js:51`) already caps the live path at one
advance per day, and §0.4 caps Undo at the same day, so a second advance to unwind cannot exist.

Restoring wholesale is also what keeps `longestStreak` honest. `write()` derives the high-water
mark as a running maximum over the record it is replacing (`streak.js:35`), so by the time an
advance has been made, the inflated count is already folded into it; a reversal that touched only
`currentStreak` would leave the inflated maximum behind forever, in the one field the Management
App's reporting reads and the child cannot see. Putting the snapshot back puts the pre-advance
maximum back with it. The lowered value propagates rather than sticking server-side:
`handleStreakUpsert` assigns `longest_streak = excluded.longest_streak` on conflict
(`worker/index.js:1095`), clamped only against the current streak (`worker/index.js:1086`), so a
high-water mark that moves down is accepted.

Step 4 is safe against a drain landing mid-sequence. Streak ops coalesce last-one-wins at plan
time (`outbox-core.js:166-171`), because the Online Revamp's §3.5 is a single upserted row per
child — so an advance and its reversal queued between two drains collapse into one upload of the
final state, and the server never observes the intermediate count. If a drain does fit between
them, the reversal is simply a normal subsequent upsert of the corrected values.

`reconcileOnOpen` needs no change and gains the right behaviour for free. After a reversal,
`lastQualifyingDate` points back at the last day that genuinely qualified, which is the anchor its
forward walk already expects. The undone day is then judged on its own merits at the next open: if
the item was re-completed it passes, and if it was left undone the day is `'breaking'` and the
streak resets — which is the honest outcome, and one the current forward walk would have skipped
entirely.

**SRS dependency.** FR-2 governs the advance path and stays as written. The reversal is a second,
narrower rule that writes on a breaking day, so SRS Module 7 needs a new FR covering it (§9). This
is a genuine addition to Module 7's contract, not an offline-vs-online mismatch of the kind
`CLAUDE.md` §V.A waves through.

### 3.5 Reach

Because the Completed view is bounded to the real device-local day (§0.4, §3.2) and Undo only ever
targets a row inside it, there is no "how far back can this reach" question to answer — a row
becomes unreachable the moment the device's date rolls over, whatever the planner's view date is
pointed at.

---

## 4. Feature B — Course-ordered filtering

### 4.1 Problem

`filterView` (`planner-core.js:139-150`) sorts School/Chores by block, then by position only —
no course grouping. `subjectsView` (`planner-core.js:162-179`) groups by `course_name` but ignores
block entirely. Neither expresses "block, then course, then the lesson's own sequence" in one
pass, and "order within the lesson" — `sequence_no`, already a real column and already rendered as
a "No. {n}" tag (`planner-ui.js:575-577`) — currently never drives sort order at all.

### 4.2 New sort

Extend `renderFilter("school")` (and the School half of `renderToday`'s per-block loop) to group
in three passes, all pure additions to `planner-core.js` (no store/schema change):

1. **Block** — unchanged, `CANON_BLOCKS` order (§ existing).
2. **Course** — `course_name`, grouped within each block. Items with no `course_name` fall into
   their own unlabeled group, sorted last, so a course-less activity/chore doesn't silently vanish
   from the list.
3. **Lesson order** — within a course group, sort by `sequence_no` ascending when every item in
   the group has one; fall back to `effectiveSortKey` (today's `child_sort_order` ??
   `sort_order`) for a group where `sequence_no` is absent.

### 4.3 Manual reorder interaction — flagged, not decided

The up/down arrows (`planner-ui.js:1174-1190`) currently reorder within the whole block+category
group. Once a course sub-grouping exists, that scope needs to narrow to block+course, or a child
dragging one course's items would silently jump them into a different course's position.

Separately: `sequence_no` is parent-authored curriculum order (Lesson 1, 2, 3…), and letting a
child freely reorder *within* a course arguably fights that ordering rather than complementing it.
**Recommendation, not yet decided:** hide the up/down controls for any item that has a
`sequence_no`, and keep them only for course-less or `sequence_no`-less items, where nothing
authoritative is being overridden. This needs a yes/no before build (§10).

### 4.4 Views affected

`School` tab and the School half of `Today`. `Subjects` tab is now redundant with the new grouping
minus the block level — **recommendation:** retire it rather than maintain two overlapping views,
but this is a product call, not a technical one (§10).

---

## 5. Feature C — Completion notes

### 5.1 Schema

`migrations/0004_completion_note.sql`:

```sql
ALTER TABLE assignments ADD COLUMN completion_note TEXT;
```

Child-owned (parent may read, never write), same tier as `grade`. Registered in
`management-app/worker/migrations.js` as entry 4.

### 5.2 Worker

- `ASSIGNMENT_COMPLETION_FIELDS` (`worker/index.js:61-65`) gains `completionNote: 'completion_note'`.
- `validateCompletionValue` (`validation.js:38-70`) gains:
  ```js
  case 'completionNote':
    if (typeof value !== 'string') return 'completionNote must be a string.';
    return value.length <= MAX_NOTE_LEN ? null : `completionNote must be at most ${MAX_NOTE_LEN} characters.`;
  ```
  Proposed `MAX_NOTE_LEN = 1000` — long enough for "I did problems 1-10, skipped 11, wasn't sure
  how" without being an open text dump. `null` clears a note, same as every other completion field.

### 5.3 Child App

- `outbox-core.js`'s `CHILD_FIELDS` (line 29-31) gains `'completionNote'`.
- `completion-core.js`'s `buildActivityRecord` gains an optional `note` field, written alongside
  `grade`.
- UI: today, only grade-capturing items get a dialog at all (`handleComplete`,
  `planner-ui.js:687-690`); everything else completes silently. Proposed consolidation: every
  "Mark done" tap opens one small dialog — grade field only when `item.capturesGrade`, note field
  always, both optional, with a one-tap "Just mark done" path preserved for the common case of
  nothing to say. This replaces `openGradeDialog` with a slightly wider dialog rather than adding
  a second one.
- The note is editable after the fact from the Completed view (§3.2) — same `setOverride`-style
  write path as `child_block_hint`, since it's an always-writable child-owned column, not a
  write-once field.

### 5.4 Management App

A note nobody reads is dead weight. Minimal companion change: display `completion_note` read-only
wherever Reporting (SRS Module 10) already shows a completed item's grade — no new surface, one
field added to an existing render path. This is management-app-owned code per `CLAUDE.md` §I.A;
no file crosses into `child-app/`.

### 5.5 Release ordering

This is the one feature in the slice where the code and the schema it depends on arrive by
different routes: migration 0004 is applied from the browser (`CLAUDE.md` §III.D) while the Worker
and both apps ship on a git push. The schema therefore arrives *second*, and there is a window
between the two.

Inside that window, a device posting a `completionNote` drives `handleCompletions` into
`UPDATE assignments SET completion_note = ?1 ...` against a table with no such column. D1 throws.
The throw is not caught per row — it exits the loop and the handler and lands on the Worker's
top-level catch (`worker/index.js:88`), which answers 500.

Nothing is lost: `outbox.js` classifies 5xx as retryable rather than permanent
(`outbox.js:166-169`), and a retryable failure halts the drain keeping its rows
(`outbox.js:224`). But the halt is drain-wide rather than note-specific. The affected device stops
uploading completions, rewards and streaks *entirely* until the migration lands, so the window is a
full sync stall for every paired child, not a degraded note field. A parent who deploys on Friday
and applies the migration on Monday has silently frozen the weekend's completions on every device.

**This phase therefore ships as two releases, and the ordering is not optional:**

1. **Release 1** — the migration file and its `migrations.js` registry entry, and nothing else. No
   reader, no writer; the column is inert on arrival. The parent applies it from Settings →
   Database.
2. **Release 2** — the Worker's `ASSIGNMENT_COMPLETION_FIELDS` entry, the `validateCompletionValue`
   case, `CHILD_FIELDS`, and the Child App dialog.

The cost is one extra deploy, against a failure mode whose blast radius is every child's whole
outbox. `management-app/DEPLOY.md` should carry the sequence, since it is the document a parent
actually follows.

The general question this exposes — that any unexpected D1 error inside `handleCompletions`'
per-row loop escalates to a request-level 500, defeating the per-row rejection design the Online
Revamp's §5.6 put there deliberately — is not specific to this column and is not fixed here (§10).

---

## 6. Feature D — Assignment messages (one-way, v1)

### 6.1 Shape

Not a column — many messages can reference one assignment, and it's an append-only log, not a
mutable field. New table, following `reward_entries`'s exact pattern (client-minted id,
idempotent insert, one mutable exception column):

```sql
-- migrations/0005_assignment_messages.sql
CREATE TABLE IF NOT EXISTS assignment_messages (
  id            TEXT PRIMARY KEY,   -- client-minted UUID, replay-safe (Online Revamp §5.5)
  child_id      TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,      -- 'device:<deviceId>'
  read_at       INTEGER             -- NULL = unread. The one parent-owned exception column,
                                     -- same style as devices.revoked_at / assignments.rescinded_at.
);

CREATE INDEX IF NOT EXISTS idx_messages_child_created ON assignment_messages (child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_assignment ON assignment_messages (assignment_id);
```

### 6.2 Routes

- **`POST /api/messages`** (device-authenticated). Body: `{ messages: [{ id, assignmentId, body,
  createdAt }, ...] }` — batched, mirroring `/api/rewards/entries` exactly
  (`worker/index.js:1020-1073`): per-row rejection, idempotent `INSERT ... ON CONFLICT (id) DO
  NOTHING`, `child_id` taken from the device token, never the body. Additional per-row check this
  route needs that `/api/rewards/entries` doesn't: `assignment_id` must belong to
  `device.childId` (a `SELECT 1 FROM assignments WHERE id = ? AND child_id = ?` before the
  insert, or a single batched query up front) — otherwise a device could stamp a message onto an
  assignment it doesn't own. `body` capped (proposed 500 chars — shorter than a completion note;
  this is a question, not an essay).

- **`GET /api/messages?childId=&unreadOnly=&since=`** (parent-authenticated, `withParent`). Same
  shape as `handleRewardsQuery`/`handleAssignmentsQuery` — ordered `created_at DESC`, capped via
  the existing `capRows`/`MAX_QUERY_ROWS` convention.

- **`POST /api/messages/read`** (parent-authenticated). Body: `{ ids: [...] }`, capped at
  `MAX_BATCH` like rescind's `ids[]` path. `UPDATE assignment_messages SET read_at = ?1 WHERE id
  IN (...) AND read_at IS NULL`.

### 6.3 Child App

- New IndexedDB store `assignmentMessages` (keyPath `id`) — **this does bump `childAppDB`'s
  version**, the one schema touch on the Child App side; follows the precedent already set for
  `activityRecords`/`rewardEntries` (see the Online Revamp's v7-v9 history in
  `TDS_Slice_Online_Revamp.md`).
- New outbox op kind `'message'` in `outbox-core.js`: `buildMessageOp(entry, now)`, id-keyed
  dedup, never merged — same shape as `buildRewardOp` (§ existing, `outbox-core.js:95-110`).
  `plan()` gets a matching chunked-request branch posting to `/api/messages`.
- UI: on `itemCard`'s footer (`planner-ui.js:625-649`), a new ghost button — "Ask a question" —
  opening a small modal (same construction as the Reschedule/Waive dialogs, no PIN) with a
  textarea and Send/Cancel. On send: mint an id, write locally, enqueue, toast confirmation. A
  small "📨 sent" indicator on the card once a message exists locally for that assignment id lets
  the child see they already asked without needing a reply channel.

### 6.4 What v1 deliberately does not do

No reply visible to the child, no read receipt shown child-side, no polling for new messages. All
three are the natural v2 once one-way is proven (§10).

### 6.5 Management App

Needs a new surface — nothing existing covers this (there is no SRS module for it). Minimal v1:
an inbox list (sender's child, assignment title + date for identification, body, timestamp),
"mark read" action, and an unread-count badge near the existing nav (`Assignments / Reporting /
Settings`). This is real scope on its own — **recommend treating it as its own SRS module
("Module 13: Assignment Messages") and its own build phase**, not squeezed into the same session
as §3-§5. Per `CLAUDE.md` §V.A, this alone is likely to exceed the 2-3 hour estimate once the
inbox UI is included.

---

## 7. Column/table ownership — additions to the existing table

| Column/table | Owner | Notes |
|---|---|---|
| `assignments.completion_note` | child-owned | parent reads, never writes (§5) |
| `assignment_messages.*` (all but `read_at`) | child-owned (append-only) | one row per message, minted by the device |
| `assignment_messages.read_at` | parent-owned | the one mutable field, same pattern as `rescinded_at`/`revoked_at` |

No existing column changes ownership. No existing route's contract changes.

---

## 8. Outbox additions

| Op kind | New/existing | Dedup key | Merge behaviour |
|---|---|---|---|
| `completion` (status→pending, note clear) | existing | `assignmentId` | fields merged, later write wins per field — unchanged |
| `reward` (reversal entry) | existing | entry `id` | never merged — unchanged |
| `streak` (restored record, §3.4) | existing | singleton per child | last one wins at plan time — an advance and its reversal collapse to one upload |
| `message` | **new** | entry `id` | never merged, same as `reward` |

Undo enqueues three of these in one action (completion, reward, streak) and none of them is a new
op kind — which is the reason Feature A needs no Worker change at all.

---

## 9. Build phasing

Per `CLAUDE.md` §V.A's 2-3 hour halt threshold, this is not one session:

1. **Feature B (course-ordered filtering)** — no schema, no Worker change, `planner-core.js` +
   `planner-ui.js` only. Smallest, do first. §4.3's reorder-scope question blocks final polish
   but not a first pass.
2. **Feature A (Completed view + Undo)** — no schema, no Worker change beyond what's already
   deployed; touches `completion.js`, `completion-core.js`, `streak.js` and `planner-ui.js`, plus a
   new FR in SRS Module 7 for §3.4's reversal rule, authored before the code. Budget for the streak
   reversal as the substantial half of this phase: Undo is not a delete plus a negative ledger row,
   and the half that makes §0.1's no-PIN decision sound is the half in `streak.js`.
3. **Feature C (Notes)** — one migration, one Worker map/validation entry, Child App write path +
   dialog consolidation, one Management App read-only display addition. Two releases, in §5.5's
   order, with the parent applying the migration between them.
4. **Feature D (Messages)** — one migration, three new routes, new outbox op, new IndexedDB store
   (version bump), new Child App UI, **and** a new Management App inbox surface. Its own phase(s);
   recommend authoring Module 13's SRS entry before starting the build, not after.

---

## 10. Open items (explicitly deferred, not decided here)

1. **Subject as a real grouping level.** Would mean threading `subject` through the Commit
   builder into a new `assignments.subject` column, then re-deriving §4's grouping around it
   instead of `course_name`. Real, separate scope (§0.2).
2. **Two-way assignment messaging.** Parent replies visible to the child needs a pull path in the
   Child App (poll `GET /api/messages` the way `plan-sync.js` polls `/api/plan`) and a
   `created_by: 'parent'` write path. Deferred by §0.3.
3. **Undo's PIN-gate.** Ungated per §0.1, which holds only while both reversals in §3.3 and §3.4
   stay intact. Revisit if either is ever weakened, or if a parent reports Undo being used to dodge
   accountability rather than to correct mistakes.
4. **Manual reorder vs. `sequence_no`** (§4.3) — whether the up/down arrows should be suppressed
   for any item carrying a parent-authored lesson order.
5. **`Subjects` tab retirement** (§4.4) — folding it into the new course-grouped `School` view vs.
   keeping both.
6. **Historical Completed/Undo browsing** — deferred by §0.4; would need a policy for how far back
   a reward reversal is allowed to reach, and a decision on whether the streak snapshot in §3.4
   grows into a real history to support it.
7. **Per-row containment of D1 errors in `handleCompletions`** (§5.5) — an unexpected throw inside
   the per-row loop escalates to a request-level 500 and stalls the whole drain — the exact
   failure the Online Revamp's §5.6 per-row rejection design exists to avoid. Containing it would
   make §5.5's two-release sequence a belt-and-braces measure rather than a requirement, and would
   cover every column added after this one. Separate scope: it changes a shared route's error
   semantics for all callers, not just this feature's.
8. **Roadmap update** — per `CLAUDE.md` §IV.C, `docs/Roadmap_Schedule_App.md` should get an entry
   once this slice is authorized, a new FR in SRS Module 7 before §3.4 is built, and a Module 13
   SRS stub for Messages before §6.5 is built.
