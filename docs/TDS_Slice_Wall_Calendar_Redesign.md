# Technical Design Specification — Slice

## Scope: Wall Calendar — the Wall Display App becomes a shared family calendar with 15-minute chore placement, block collapse, week and month views

**Status:** in build. **§18 signed off by Ray, 2026-08-14 — Phase 0 complete.** Phase 1a
(`wall_slots`/`wall_slot_days` migration + Worker routes), Phase 1b (§3.5's chore duration in
the Management App), Phase 2 (shell & nav), Phase 3 (day view, read-only), Phase 4 (block
mode), Phase 5 (placement writes), Phase 5b (duration adjust), Phase 6 (completion), Phase 6b
(sound), and **Phase 7 (school blocks — migration 0011, the five `/api/wall/school-blocks*`
routes, `school-core.js`, and their rendering in all three day-view modes)** are complete.
**§5 was rewritten 2026-08-15, before any Phase 7 code was written** — a school block is now a
span holding several member courses, not one block per course; see §20's 2026-08-15 entry.
**§18.1a's CLAUDE.md amendment landed with Phase 7**, as its own text said it must — see
`CLAUDE.md` v2.4. Also revised 2026-08-14 after a design review; see §20. Phase 5b's gesture
choice (long-press opens the duration sheet — §3.5.2) is still flagged for Ray's confirmation,
not yet signed off the way §0's decisions were — no later phase has depended on it, so it
remains open rather than resolved by default. §5.4's block creation gesture carries the same
kind of flag, built exactly as proposed (drag to move, long-press to resize/relabel, tap for
the membership picker, "+ School" to create) — still not put to Ray. Phase 8 (week & month) is
next.
**Date:** 2026-08-15 (§5 revision, Phase 7); slice originally dated 2026-08-14.
**Depends on:** `TDS_Slice_Online_Revamp.md` (controlling design), `TDS_Slice_Wall_Display_App.md`
(the app this rewrites), `TDS_Slice_Shared_Chores.md` (claim arbitration).
**Supersedes:** large parts of `TDS_Slice_Wall_Display_App.md` — see §1.2 for the itemized list of
what survives, what is repealed, and what is replaced.
**Amends:** `CLAUDE.md` §I.A/§III.E/§VII → v2.3 (§18). `docs/Roadmap_Schedule_App.md` §0.

---

## 0. Decisions made in this slice

All were put to Ray in-session on 2026-08-14 and answered. They are recorded here as `[DECISION]`
blocks in the sections that own them rather than re-argued.

1. **The wall becomes a calendar, not an ambient board.** Day, week and month views, reached from a
   sidebar behind a top-left hamburger, landing on **today** every time. The day view is the
   scheduling surface: a 15-minute grid with **one column per active child** and a shared time
   gutter. §4.

2. **Chore placement is wall-only, and it is a wall-owned fact.** The Management App stays
   block-based (`blockHint` ∈ morning/afternoon/evening/night, `chores.js:115`); it gains no clock
   times and no new UI. The wall owns a new D1 table it alone writes, and touches no column of
   `assignments` that it did not already touch. §3.

3. **A placement is a standing default, carried forward to every future day.** Dropping "Feed the
   cat" at 4:15pm places it at 4:15pm for that child on every day it recurs, until it is moved
   again. There are no per-day overrides in v1. §3.3.

4. **Per-child PIN gating of chores is repealed outright.** One shared view, every active child, no
   gate. The column a tap lands in is what names the child — which is also what makes shared-chore
   claiming work without a PIN. The **admin** PIN survives, on Settings only. §2.3, §8.2.

5. **Nothing disappears when it is completed.** A finished chore stays in its slot, visibly done,
   carrying the time it was finished. This makes the old Done Today board redundant and it is
   removed. §8.4.

6. **Completion asks *when*.** A sheet opens on tap, defaulting to the current time and adjustable
   in 5-minute steps. `completed_at` records what the sheet says, not when the finger landed.
   §8.3.

7. **School blocks are read-only aggregates — and a block now holds several courses, not one.**
   A school block is a placement of a *time span* for one child, containing whichever courses the
   family puts in it (`"School: 0900–1130 — Math, Language Arts, Geography"`). It renders each
   member course's activities, cannot be ticked itself, shows a checkmark beside each course as
   that course's activities finish, and collapses to a compact done state once every member course
   is checked. **Revised 2026-08-15**, before Phase 7 code existed, from the original
   one-block-per-course model — see §20. §5.

8. **Overlap is normal.** Two things may share a slot. The only warning is two **private**
   (non-shared) chores for the **same child** overlapping, and it is a warning, never a block. §9.

9. **The ambient poll slows to 10 minutes**, polls immediately on any interaction, and offers a
   large centre refresh. The midnight rollover stays on its own timer and is not a poll. §10.

10. **Motion is spent only on interaction.** Transform and opacity only, 150–300ms, nothing loops —
    with one exception, the now-line, which moves once a minute. §11.2.

11. **The wall makes two sounds.** A chime when a placed chore's start time arrives and it is still
    pending, and a confirmation tone when one is ticked. Synthesized rather than shipped as files,
    costing no request at all, silenced during night-dim hours, and switchable off per child —
    subject to the browser autoplay rule §11.5.1 is honest about. §11.5.

---

## 1. What this is, and what it does to the previous slice

### 1.1 Why a slice and not a new TDS

Everything structural about the Wall Display App survives: the household-scoped wall token, the
roster read live from `children WHERE active = 1`, online-required writes, no IndexedDB, no outbox,
the reuse of `ASSIGNMENT_COMPLETION_FIELDS`, and the four bounds of `CLAUDE.md` §III.E. What changes
is the **surface** — and one genuinely new thing, a table the wall owns (§3.2).

That is a slice's worth of work. It is a large slice: §16's phase table runs to eight phases, none
of which exceeds the `CLAUDE.md` §V.A ceiling.

### 1.2 What survives, what is repealed, what is replaced

| `TDS_Slice_Wall_Display_App.md` | Fate |
|---|---|
| §0.1, §3.1–3.3 — one household wall token, roster from D1 | **Survives unchanged.** |
| §0.2, §6.2 — completions credit rewards; the earn rule | **Survives unchanged**, including the `reward_category IS NULL` clause and the three-answer `pendingEarns` table. |
| §0.3, §4.1–4.4, §4.6 — per-child PINs, the PIN pad, tile lockouts | **REPEALED** (§0.4). Never built — Phase 4a of that slice does not exist in the tree, so this costs nothing to remove. `wall.pins` becomes a dead localStorage key. |
| §4.5 — the admin PIN on Settings | **Survives.** |
| §0.4 — pending chore titles behind the PIN | **REPEALED** with the gate that enforced it. Every title is on the shared board. |
| §0.5, §6.3 — shared chores claimable from the wall | **Survives**, with the column-tap replacing the PIN as the thing that names the claimant (§8.2). The claim route gains one field so the completion sheet's time survives it — §8.3.1, the only change to an existing wall route in this slice. |
| §5.1.1 — the on-today rule (deferment + overdue roll-forward) | **Survives, and widens.** The same rule now answers "on *this* day" for any rendered date, not just today. §4.5. |
| §5.1 — `kind='activity'` ignored entirely | **REPEALED, read-side only.** School blocks read activities. The wall still writes nothing to an activity row, ever. §5. |
| §5.2 — 60s/15min poll cadence | **Replaced** by §10. |
| §5.3 — day rollover | **Survives**, and matters more. §10.3. |
| §5.4 — staleness stamp, no error modals | **Survives.** |
| §6.1 — completion write, the pre-check | **Survives**, with `completedAt` now coming from the sheet. §8.3. |
| §6.4 — online-required writes, no outbox | **Survives**, and extends to placement writes. §3.5. |
| §6.5 — Undo, both paths | **Survives.** §8.5. |
| §6.6 — what the wall never writes | **Amended**, not repealed. The list is unchanged for `assignments`; the wall additionally writes its own `wall_slots` table. §18.1. |
| §6.7 — the Done Today board | **REPEALED** (§0.5). A completed chore stays in its slot with its time on it, which is what that board existed to show. §8.4. |
| §7 — the events union and dedupe | **Survives** as logic; its rendering moves into the day/week/month views and a household-wide fetch (§7.2). |
| §10.2 — 960×600 landscape baseline, 64px targets, night dim, shell-only SW | **Survives.** |

---

## 2. Architecture

```
   Fire tablet on the wall, always on, landscape, house wifi
   ┌────────────────────────────────────────────────────────┐
   │  wall-app/ — vanilla JS, no build step                   │
   │  localStorage: wallToken · settings · pendingEarns        │
   │  no IndexedDB · no outbox · no child PINs                 │
   └───────────────┬────────────────────────────────────────┘
                   │  one wall token; the child is named per request
                   │  GET  /api/wall/children          (roster)
                   │  GET  /api/wall/plan?childId=     (read)
                   │  GET  /api/wall/events            (NEW — household, deduped)
                   │  GET/PUT/DELETE /api/wall/slots   (NEW — placements)
                   │  POST /api/wall/completions
                   │  POST /api/wall/rewards/entries
                   │  POST/DELETE /api/wall/assignments/:id/claim
                   ▼
   ┌────────────────────────────────────────────────────────┐
   │  Cloudflare Worker — same script, same D1                │
   │  D1 `scheduling-app` = SYSTEM OF RECORD                  │
   │  assignments · reward_entries · wall_slots (NEW)         │
   └────────────────────────────────────────────────────────┘
```

### 2.1 The roster is still the whole story

`children WHERE active = 1`, polled, rendered verbatim, no local nicknames. A child added in the
Management App becomes a column on the next poll; archiving removes it. This is unchanged and it is
what makes the next paragraph free.

### 2.2 The "Parents" column

Ray intends to possibly add a pseudo-child named `Parents`, so parent commitments occupy a column
the kids can see. **This needs no special-casing anywhere in this slice** — it is an ordinary
`children` row, so it gets a column, a placement namespace, and a chore list like any other.

**A shared chore will not span into it, and this needs no flag** — stated because the opposite is a
reasonable thing to assume, and the fix someone would reach for is a schema change that is not
needed. Spanning is driven by *participation*, and participation is an explicit per-chore choice: the
Chore form's participant checkboxes and its `each`/`claim` radio (`chores.js:482-497`). A chore
spans the Parents column only if Parents is ticked on that chore. The same holds under §3.1.2's
child-less placement row, which spans whatever that day's rows say the participants are — and
Parents has a row only if it is one.

Nothing else auto-enrols it either. Every path that could reach a pseudo-child — shared-chore
participants, event assignment, course assignment, pacing, device pairing — is an explicit pick.

The residual cost is noise, not correctness, and it is worth seeing in full before adding a column
to avoid it:

- an extra option in roughly six pickers (reporting filter, assignments, events, course instances,
  pacing, devices);
- inclusion in any *all-children* aggregate in reporting;
- `reward_entries` appended like anyone else's, if a chore assigned to it carries a reward category.

**Deferred rather than solved: a "not a real child" flag.** §17.10 records what it would cost and
the one thing that is easy to build backwards.

### 2.3 No gate in front of the board

```
[DECISION] Per-child PIN gating is repealed
Decided: there is no PIN in front of any child's chores. One shared view, every
  active child, every title visible. The admin PIN survives on Settings only,
  because the parent still needs somewhere the kids cannot re-pair the display
  or change the dim hours from.
Rationale: Ray, 2026-08-14 — "I dont want chores to be gated by kid anymore."
  The previous design's gate answered two questions at once: may you see this,
  and who is tapping. The column-per-child layout (§4.2) answers the second
  question better than a PIN did — it is answered before the tap rather than
  five minutes earlier — and Ray's answer to the first is that a family board
  should show the family's work.
Consequence: any child can tick any child's chore. The deterrent is now social
  and visible rather than technical: it is a shared board in a shared room, and
  every completion carries a time. This is a real loss of a real protection and
  it is being traded deliberately, not overlooked.
Consequence: §4 of the wall slice — PIN pad, five-minute idle session, per-tile
  lockout, the PIN-less-child rule — is deleted rather than reworked. None of it
  was built (Phase 4a never landed), so there is no code to remove.
Locked for: this slice.
```

---

## 3. Placement — the core new mechanism

### 3.1 What a placement is

A **placement** binds a recurring *thing* to a time of day for one child:

> child + subject → start time (a multiple of 15 minutes from local midnight) + duration.

It is **not** a property of an assignment row. An assignment row is one child's one day; a placement
is the standing arrangement that every one of those days is drawn from. That distinction is what
makes §0.3's carry-forward the default behaviour rather than a feature bolted on top of it.

The **subject** is whichever stable identity the row class has:

| Row class | Subject key | Why |
|---|---|---|
| Chore | `source_id` + `instance_key` | `source_id` is the chore's curriculum id and is stable across days (`packet.js:544`). `instance_key` distinguishes three-dishes-a-day occurrences of one chore (`migrations/0006`), which must be placeable at three different times. |
| School block | a server-minted block id | **Revised 2026-08-15 (§20).** A school block is no longer keyed by a course at all — a child may have several blocks a day, each holding a *set* of member courses (§5). Its shape (one span, many members) doesn't fit the `(child_id, subject_kind, subject_key, instance_key)` singleton key below, so it lives in its own tables, not `wall_slots`. §5.5. |
| Event | — | Events are not placeable. They carry their own freeform `payload.time` and are family-wide. §7.1. |

#### 3.1.1 Identity is minted, never a name — and the placement key relies on that

Worth stating outright, because the obvious worry is a real one and the answer is already built:
**two chores, or two occurrences of one chore, may share a title and are still distinct.** A Chore
record carries a minted id (`c.id` → `source_id`, `packet.js:544`); an occurrence carries a minted
6-character token (`chores.js:416`, and `buildInstancesFromLabels` re-rolls until a row's own ids
are distinct, `chores.js:269-278`). The label a parent types is stored *beside* that id, never as
it. Ids are minted once on Add and never reassigned, so **renaming an occurrence does not move its
placement**.

So `source_id` + `instance_key` is a genuinely stable handle across every child and every date —
the same tuple Commit already uses as its duplicate guard (`keyOf`, `packet.js:103`), which is good
corroboration that it is the row class's real identity rather than a convenient one.

The one place in this slice where a **name** is load-bearing is the school block's `course_name`
(§5.2), and the cost of that is stated there. Chores are not exposed to it.

#### 3.1.2 Shared chores: `each` places per child, `claim` places once

`TDS_Slice_Shared_Chores.md` §0.4 gives a Chore two allocations, and they want **different**
placement behaviour. The distinction was missing from this slice's first draft and is load-bearing,
because §4.2's "a shared chore spans the columns it is up for" is only true of one of them:

| Allocation | Rows per occurrence | Placement | Rendering |
|---|---|---|---|
| `each` (including one child, and multi-child) | one per participant, independently completed and earned | **one placement per child**, keyed as above | a separate chip in each child's column. Two children may legitimately do their own dishes at different times, so the per-child key is not a limitation here — it is the point. |
| `claim` | one row per participant, linked by `claim_group` | **one placement, no child** — see below | drawn once, spanning the columns of the children it is up for (§4.2, §8.2) |

A `claim` chore's placement is stored as a **single child-less row**: `child_id = ''`, the household
sentinel `migrations/0009` already established for the wall's own `devices` row, with the subject key
unchanged (`source_id` + `instance_key`).

```
[DECISION] A claim chore holds one placement, not one per participant
Decided: `child_id = ''` on the placement row. One drag writes one row.
Rationale: the alternative — a placement row per participant, written by one
  PUT each — is wrong three ways. It is not atomic, so a partial failure leaves
  two children's copies of one chore at different times on a chip that is
  supposed to be drawn once. It goes stale: change a claim chore's participants
  in the Management App and the departed child's placement is an orphan while
  the joining child has none, so the chore reappears in their tray as though it
  had never been placed. And it stores N copies of a fact that has exactly one
  value, which is the shape §3.2(b) already rejected for `assignments`.
  A child-less row has none of those problems: it spans whatever that day's
  rows say the participants are, and self-corrects when they change.
Why NOT `claim_group` as the key, which is the other obvious candidate: it is
  minted per DAY (`index.js:1018`, keyed `source_id`/`date`/`instance_key`), so
  it cannot anchor a standing arrangement, and it is NULL on every `each` row.
  It is the right way to RECOGNISE a shared chore at render time; it is not an
  identity a placement can hold.
Consequence: `PUT /api/wall/slots` must accept the sentinel, which means its
  active-child validation is conditional rather than unconditional. §12 states
  the exact rule, and it is narrow: the sentinel is accepted ONLY on
  `subject_kind = 'chore'`, and `wall_slots` is a wall-owned table outside the
  child-scoping scheme entirely (`CLAUDE.md` §III.E), so this widens nothing on
  `assignments`.
Consequence: an `each` chore and a `claim` chore never collide in the table
  even at the same subject key, because one writes `child_id = <uuid>` and the
  other `child_id = ''`. If a parent changes a chore's allocation, the old
  placement is simply not found and the chore returns to the tray — visible,
  not silent.
Approved by Ray in-session, 2026-08-14, on the review that found the gap. It
  softens one validation on a wall-owned table and nothing on `assignments`;
  §18.6 is the check that says so.
Locked for: this slice.
```

At render time the wall reads the allocation from the row it already has:
`claim_group IS NOT NULL` means look up the child-less placement, otherwise look up the child's own.
No new fetch, no new column.

### 3.2 Where placements live

```
[DECISION] Placements live in D1, in a table the wall owns
Decided: a new `wall_slots` table, written only by the wall, read only by the
  wall. NOT localStorage, and NOT a column on `assignments`.
Rationale: three candidates were weighed.
  (a) localStorage, like the PINs and dim hours already are. Cheapest — no
      migration, no route, no amendment. Rejected on durability: a placement map
      is built up over weeks and is the single most laborious thing on this
      tablet to recreate. Silk clearing site data, a factory reset, or a swapped
      tablet would erase all of it silently, and there would be no copy anywhere.
      PINs survive that trade because a PIN is four digits and re-entering one
      takes ten seconds.
  (b) A column on `assignments` (e.g. `start_min`). Rejected because it is the
      wrong shape twice over: it would be written once per row per day for a
      standing arrangement that does not vary by day, and it would put the wall
      inside the assignment table's column-ownership question for no benefit.
  (c) A wall-owned table. Chosen. It is durable, it survives a re-pair and a
      tablet swap, and — the part that matters for CLAUDE.md §0 — it does NOT
      widen column ownership on `assignments` at all. The wall's writes there
      remain exactly ASSIGNMENT_COMPLETION_FIELDS. The wall simply gains a
      table nothing else in the system reads or writes.
Consequence: this DOES widen the wall's write scope beyond "completions, earn
  entries, and claims" (CLAUDE.md §I.A). That sentence needs amending, and the
  amendment is the narrow one — the wall writes its own table, not anyone
  else's column. §18.1.
Consequence: placements are household-visible, so a second wall display would
  share them for free. That is a nice property, not a requirement.
Locked for: this slice, pending §18 sign-off.
```

```sql
-- migrations/0010_wall_slots.sql
CREATE TABLE IF NOT EXISTS wall_slots (
  -- '' = the household sentinel, and it means "this placement belongs to a
  -- `claim` chore's whole group rather than to one child" (§3.1.2). The same
  -- sentinel `migrations/0009` uses for the wall's own `devices` row, and for
  -- the same reason: a real id is always a server-minted UUID, so '' can never
  -- collide with one. NOT NULL rather than nullable, per the instance_key note
  -- below — a nullable key component disables every comparison that uses it.
  child_id      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,          -- 'chore' | 'school'
  subject_key   TEXT    NOT NULL,          -- chore: source_id; school: course_name
  instance_key  TEXT    NOT NULL DEFAULT '',
  start_min     INTEGER NOT NULL,          -- minutes from local midnight, % 15 == 0
  duration_min  INTEGER,                   -- NULL = use the assignment's own estimate (§3.5)
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,          -- 'wall:<deviceId>'
  PRIMARY KEY (child_id, subject_kind, subject_key, instance_key)
);

-- The per-day override: "just this instance" (§3.5.2). Same key as wall_slots
-- plus a date, so one precedence chain covers chores and school blocks alike.
CREATE TABLE IF NOT EXISTS wall_slot_days (
  child_id      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,
  subject_key   TEXT    NOT NULL,
  instance_key  TEXT    NOT NULL DEFAULT '',
  date          TEXT    NOT NULL,          -- YYYY-MM-DD
  duration_min  INTEGER,                   -- NULL row is meaningless; delete instead
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,
  PRIMARY KEY (child_id, subject_kind, subject_key, instance_key, date)
);
```

`wall_slots` answers **when** and, optionally, **for how long**. `wall_slot_days` answers "…except
on this one day." Neither ever touches an `assignments` column — §3.5 is where that matters.

**The `'school'` value in `subject_kind`'s comment above is now historical.** It described the
pre-2026-08-15 model, where a school block *was* a `wall_slots` row keyed by `course_name`. That
model was never built — Phase 7 hadn't started — so there is nothing to migrate away from. Migration
0010 is applied and stays exactly as applied (`CLAUDE.md` §II.4: never edit an applied migration);
`wall_slots` simply ends up used for `'chore'` only, and school blocks get their own tables in a new
migration, §5.5.

`instance_key` is `NOT NULL DEFAULT ''` for exactly the reason `migrations/0006` gives at length:
`NULL = NULL` is never true in SQLite, so a nullable component of a natural key silently disables
every comparison that uses it.

Registered in `management-app/worker/migrations.js` in the same commit, applied from Settings →
Database in the browser (`CLAUDE.md` §III.D). No CLI, ever.

### 3.3 Carry-forward: what "remember it" means

```
[DECISION] A placement is a standing default, not a per-day edit
Decided: moving a chore moves it for today and for every future day it recurs
  on. There is no "just today" option and no per-day override in v1.
Rationale: Ray, 2026-08-14 — "I want it to remember how we set up or changed to
  day and pull that forward to future days." One arrangement, carried forward,
  is both the simplest thing to implement and the simplest thing to explain
  standing at the tablet. A per-day override needs a date-keyed second table, a
  UI that asks "this day or every day?" on every drag, and a rule for what
  happens when the standing time later changes — three costs for a case Ray has
  not asked for.
Consequence: past days are rendered from the CURRENT placement, so moving a
  chore today retroactively changes where it appears on last Tuesday's grid.
  This is real revisionism and it is tolerable here because the thing that
  actually happened is recorded elsewhere and rendered on the chip: a completed
  chore carries its `completed_at` (§8.4). The planned position is a plan; the
  completion time is the record.
Deferred, not forgotten: §17.1 sketches the per-day override if it is ever
  wanted.
Locked for: this slice.
```

### 3.4 Chores — and courses — with no placement yet

A chore the wall has never been told a time for is **not hidden and not guessed at**. It goes in an
**unscheduled tray** at the top of its child's column — a compact, always-visible strip reading
`Not scheduled · 3`, expanding to the list, each item draggable into the grid.

**Courses are not tray items, and school blocks are created a different way (§5.4).** An earlier
draft of this section put an unplaced-course entry in this tray, on the reasoning that dragging a
course out was the only gesture that could bring a block into existence. That reasoning no longer
holds after §5's 2026-08-15 revision (§20): a block is a span that can hold *several* member
courses, chosen from a checklist, so "drag this one course onto the grid" doesn't describe the
action a family actually takes any more — there's no longer a one-to-one course-to-block mapping to
drag into place. The tray therefore goes back to listing **chores only**. §5.4 describes how a block
itself gets created, and §5.2 how courses get added to one.

The alternative — deriving a slot from `block_hint` (morning → 9:00 and so on) — was rejected. It
would put chores on the grid at times nobody chose, and since a placement is a standing default
(§3.3) the first drag of a mis-derived chore would look like a correction rather than a first
placement. The tray makes placement a deliberate act exactly once per chore.

In **block mode** (§4.4) an unplaced chore appears inside its `block_hint` block instead of the
tray, since that is precisely the information a block hint carries. `child_block_hint` is read as an
override where present, mirroring `planner-core.js:55` — the wall reads it and, as ever, never
writes it.

### 3.5 Duration: the column already exists, and chores should be able to set it

```
[DECISION] Duration lives on the assignment row, not on the placement
Decided: a chip's height comes from `assignments.expected_duration_min`, and
  Chore Authoring (Management Module 06) gains an `expectedDurationMin` field
  so a chore can carry one. `wall_slots` stores no duration.
Rationale: Ray, 2026-08-14 — "we have an estimated activity time field we use
  for pacing; why not just write that into a column on the d1 assignment table
  and let me set it for Chores too?" This is a better answer than this slice's
  first draft, which had a `duration_min` on the placement, and the reason is
  that duration is a property of the WORK, not of the arrangement: "empty the
  dishwasher takes ten minutes" is true wherever it sits on the grid, and would
  otherwise have to be re-stated per placement and re-entered if it moved.
Cost, counted: essentially nothing.
  - The column EXISTS. `expected_duration_min INTEGER` on `assignments`
    (`migrations/0001:46`).
  - The API already accepts it. `expectedDurationMin` is in BOTH
    ASSIGNMENT_CREATE_FIELDS (`index.js:67`) and ASSIGNMENT_PATCH_FIELDS
    (`index.js:83`), and the Commit insert already writes it (`index.js:909`).
  - So there is NO migration and NO Worker work. Activities have been filling
    this column since the revamp (`packet.js:527`); chores simply never set it.
  What remains is two small Management App changes: the authoring field, and
  one line in `assignmentFromChore` mirroring the activity path.
Fallback: 15 minutes where the column is NULL, which is the pacing engine's own
  fallback for the same field (`packet.js:43`, DEFAULT_MINUTES).
Rendering: the grid is 15-minute rows, so a chip is ceil(duration / 15) rows
  tall. The stored value is NOT rounded — a 20-minute activity keeps 20 and
  simply occupies two rows. Rounding the truth to fit the drawing would put a
  wrong number into a column the pacing engine reads.
Consequence: this slice now touches `management-app/` as well as `wall-app/`
  and needs SRS Module 06 amended (§18.3). That is a scope declaration, not a
  violation — CLAUDE.md §I.A forbids shared runtime CODE, not coordinated
  change, and no file is shared.
Locked for: this slice.
```

#### 3.5.1 The wall may adjust a duration — but not by writing that column

Ray, 2026-08-14: *"do let them adjust the minutes on already assigned stuff though. I'll of course
update next push, but I dont want to accidentally commit half an hour on two weeks of chores and
hog two blocks if it ends up taking ten minutes."*

That is the right requirement and it runs straight into the one rule that has no exceptions:
**`expected_duration_min` is a parent-owned column** (`migrations/0001:46`, in the parent-owned
block; writable only through `ASSIGNMENT_CREATE_FIELDS` / `ASSIGNMENT_PATCH_FIELDS`, both of which
are parent routes). `CLAUDE.md` §0 states it plainly — *"No credential class widens this"* — and
this slice does not propose to be the first.

So the wall does not write the estimate. It writes an **override it owns**, and the renderer
resolves the two. The parent's authored number stays exactly what the parent authored, which is
also what makes Ray's "I'll update next push" work: the next Commit rewrites the assignment's
estimate and the override is still visibly sitting on top of it, ready to be cleared.

**The precedence chain**, resolved per chip per rendered date, in `slots-core.js`:

| # | Source | Meaning |
|---|---|---|
| 1 | `wall_slot_days.duration_min` for this subject **and this date** | "just this instance" |
| 2 | `wall_slots.duration_min` | the standing wall override — "future occurrences" |
| 3 | `assignments.expected_duration_min` | what the parent authored (§3.5) |
| 4 | 15 minutes | `packet.js:43`'s own fallback |

#### 3.5.2 The fork: this instance, or from now on

Adjusting a duration opens a two-button choice, exactly as Ray asked: **Just this one** →
`wall_slot_days`; **This and future** → `wall_slots.duration_min`. A third, quieter action appears
whenever an override is in force: **Use the assigned time (30 min)**, which deletes the override and
returns the chip to row 3 of the chain.

```
[DECISION] What gesture opens the adjust control
Decided: a LONG-PRESS (held ~550ms with no movement) on a PLACED chip, built
  §16 Phase 5b. Not put to Ray — flagged here for confirmation rather than
  argued as settled the way this section's other choices are.
Rationale: the three actions themselves are pinned by this section's own
  text, but the gesture that opens them isn't, and a plain tap on a chip is
  already spoken for — `onChipTap`, reserved since Phase 5 for the
  completion sheet (Phase 6). A drag moves the chip; that leaves a held,
  stationary press as the one gesture not already claimed. Tray items
  (unplaced chores) don't get it — there is no standing placement yet to
  adjust a duration ON, so the gesture is wired only where §16 Phase 5's
  chips already exist (buildColumn), not the tray.
Alternatives not built: a dedicated small control drawn on every chip (the
  duration text itself as a tap target) — rejected as visual clutter on an
  un-overridden 15-minute chip, which is the common case (§4.3) and already
  one grid row tall; a chip-level "..." icon — same clutter, plus a second
  hit target inside an already-small chip on a two-metre-viewing-distance
  display (§10.2/§11.1's constraints).
Consequence: a held chip gets a transient `.pressing` opacity change so the
  gesture has SOME feedback before the sheet opens — no animated
  box-shadow (§11.2).
Locked for: nothing yet — this is the one open item Phase 5b leaves for
  Ray, unlike §0's decisions which were all settled in-session.
```

- **An overridden chip is marked**, subtly — the duration reads in italic with a small dot. A wall
  that silently disagrees with the assignment about how long something takes is worse than one that
  says so, and this is the affordance that makes "I'll update next push" end in a cleanup rather
  than in two numbers quietly diverging forever.
- **"This and future" is date-less**, like every other placement (§3.3), so it also applies to *past*
  days that carry no per-day override. Same revisionism, same defence: what actually happened is
  recorded in `completed_at` and rendered on the chip.
- **Both overrides are wall-scoped.** The Child App and the Management App never read `wall_slots`
  and are unaffected; pacing continues to use the parent's estimate, untouched. The wall's opinion
  about how long the bins take does not leak into next term's schedule.
- This precedence chain, and the long-press sheet that edits it, is a **chore-only** mechanism.
  **Revised 2026-08-15 (§20):** a school block no longer has an assignment-authored estimate to sit
  on top of — its span is authored directly, not derived — so there is no chain for a block to join.
  §5.4 gives blocks their own, simpler resize gesture rather than reusing this one.
- Duration overrides snap to 15-minute multiples, matching the grid. The parent's estimate does not
  (§3.5) — a 20-minute activity keeps 20 and occupies two rows.

This also makes §17.1's deferred per-day *start* override nearly free: `wall_slot_days` is already
keyed by date, and it would be one nullable `start_min` column and one more button. Deliberately not
built now — Ray asked for duration, and a per-day time override is a different feature wearing the
same table.

The Management App work, in full:

| Change | File | Size |
|---|---|---|
| `expectedDurationMin` on the chore form, in `validateFields` (positive integer, or absent) and `buildRecord` | `management-app/js/chores.js` | small |
| Pass it through to the assignment row, mirroring `packet.js:527` | `management-app/js/packet.js` | one line |
| The bulk-import CSV column — see below | `management-app/js/chores-csv-core.js` | small |
| FR + validation row for the new field | `docs/SRS_Management_Module_06_Chore_Authoring.md` | doc |

**The CSV column is a real if minor decision.** `CSV_COLUMNS` is validated by exact length and exact
order (`chores-csv-core.js:78-79`), so adding a column means any previously saved import file is
rejected until re-exported from the app's own template button (`:272`). Recommended anyway: a
duration is a flat scalar, which is exactly what a CSV represents well — unlike `childDays` and
per-occurrence `blockHint`, which Module 06's Amendment A1 keeps out of the CSV precisely because
they are *maps*. That rationale does not extend to this field.

### 3.6 Placement writes are online-required

Consistent with wall slice §6.4: a placement write is synchronous. A failure leaves the chip where
it was, shows a brief message, and the drag can be repeated. There is no outbox on this device and
this slice does not introduce one. A placement is a two-second gesture, not a completion the child
has already mentally banked.

---

## 4. The day view

### 4.1 The landing state

The app opens on **today, day view**, every time — on boot, after a rollover, and after the sidebar
is dismissed without a choice. There is no "last view I was on" memory: an always-on wall in a
kitchen should be showing today when someone walks past it, not wherever the last person left it.

### 4.2 Column per child

```
   ┌──────┬───────────────┬───────────────┬───────────────┐
   │      │  Ellie        │  Talia        │  Parents      │   ← sticky, never scrolls
   ├──────┼───────────────┴───────────────┴───────────────┤
   │      │  ▸ Dentist 3:00 PM        (events band)        │   ← family-wide, full width
   ├──────┼───────────────┬───────────────┬───────────────┤
   │      │ Not sched · 2 │ Not sched · 1 │               │   ← unscheduled tray (§3.4)
   ├──────┼───────────────┼───────────────┼───────────────┤
   │ 8:00 │ ▓ Math        │               │               │
   │ 8:15 │ ▓ (school)    │ ▓ Reading     │               │
   │ 8:30 │ ▓             │ ▓             │ ▓ Work call   │
   │ ⋯    │               │               │               │
   │──────┼───────────────┴───────────────┼───────────────│   ← a shared chore spans
   │ 4:15 │ ▨ Feed the cat (Ellie/Talia)  │               │      the columns it is up for
   └──────┴───────────────────────────────┴───────────────┘
```

- **The time gutter is frozen left; the child headers are frozen top** (`position: sticky`), so a
  chip always reads as both *who* and *when* however far the grid is scrolled. Ray, 2026-08-14.
- Two columns at the 960×600 landscape baseline is ~380px each after the gutter; three is ~250px.
  Both hold a title and a time without truncation. The design is not built for more than four —
  §17.4 says what would have to change.
- **Events are family-wide** (wall slice §7) and get a **full-width band** above the grid rather
  than a home in any one column. An event with a `payload.time` shows it; the band is ordered timed
  first, then untimed, matching `events-core.js:58-64`.

### 4.3 The grid

- **15-minute rows.** The smallest placeable and displayable unit, per Ray's "up to 15 min
  increments".
- **A chip's height is `ceil(duration / 15)` rows**, where `duration` is §3.5.1's four-step
  precedence chain — per-day override, then standing wall override, then the assignment's own
  `expected_duration_min`, then 15 minutes. Today no chore carries an estimate at all, so every
  chore chip is one row until §3.5's authoring field ships.
- **The grid runs 06:00 to 23:00**, not a full 24 hours. Ray, 2026-08-14: 23:00 is one child's
  bedtime, so the range ends at a household boundary rather than at midnight. That is 68
  fifteen-minute rows, which is a comfortable scroll rather than the 96 a full day would need, and
  it spends no vertical space on hours that will never hold anything.
- **Anything placed outside the range gets an early/late strip**, one at the top and one at the
  bottom, each collapsed to a single line listing what is out there (`Before 6:00 · 1`). It is not
  hidden and not silently clamped: a chore placed at 05:30 is a real placement, and a grid that
  swallowed it would be lying. Tapping a strip expands it in place.
- **The now-line** is a single horizontal rule across all columns at the current time, and the grid
  **scrolls to it on load** so the tablet opens on the part of the day that is actually happening.
  Outside 06:00–23:00 it pins to the nearest edge rather than vanishing.
  Ray, 2026-08-14. It moves on a one-minute tick — one `transform`, the only looping motion in the
  app (§11.2).
- **Vertical scrolling only.** No horizontal scroll anywhere, per wall slice §10.2.

### 4.4 Block mode

The day view collapses into the four canonical blocks — `morning`, `afternoon`, `evening`, `night`
— matching `planner-core.js:36`'s `CANON_BLOCKS` and the Management App's `BLOCK_HINTS`
(`chores.js:115`), so the wall and the child's own tablet name the parts of a day identically.

- **Collapsed:** four stacked sections per column, each listing its items compactly. No time grid.
- **Expanded (one block):** that block's hours only, at full 15-minute resolution.
- **Expanded (all):** §4.3's full-day grid.

Default block hours, used to decide which block a *placed* chip belongs to:

| Block | Hours |
|---|---|
| morning | 06:00 – 11:59 |
| afternoon | 12:00 – 16:59 |
| evening | 17:00 – 20:59 |
| night | 21:00 – 05:59 |

These are constants in v1, not settings. §17.3.

An **unplaced** chore's block comes from `child_block_hint || block_hint || 'morning'`, exactly
`planner-core.js:55`. A **placed** chore's block comes from its `start_min` — the placement wins,
because it is the more specific statement of the same fact.

### 4.5 Which rows belong to a rendered day

The wall slice's §5.1.1 rule is kept in full and **generalized from "today" to "the rendered date"**:
`effectiveDueDate(row) = row.deferred_to || row.date` (`planner-core.js:48`), plus the overdue
roll-forward for still-pending required rows (`onToday`, `planner-core.js:179`). A chore the child deferred to
tomorrow on their own tablet is absent from the wall's today, and yesterday's un-done bins are
present on it.

The roll-forward only applies when the rendered date **is** today. Rendering *last* Tuesday must
show what was due last Tuesday, not everything still pending from before it — otherwise scrolling
back through the week would show the same overdue chore on every day at once.

---

## 5. School blocks

**Revised 2026-08-15, before any Phase 7 code was written — see §20.** The original model (§5 as it
stood on 2026-08-14) keyed a block to a single course, created by dragging that course out of the
unscheduled tray. This section replaces that model outright: a block is now a **span of time**
holding a **set of member courses**, matching how the family actually talks about the school day —
`"School: 0900–1130 — Math, Language Arts, Geography"`, `"School: 1300–1400 — Science, Spelling"`.
Nothing about the write-side rule changes: the wall still has no code path, button, or route that
writes anything to an activity row (§18.2's third narrowing, untouched).

### 5.1 What they are

```
[DECISION] A school block is a span holding several member courses
Decided: a placement, in its own `wall_school_blocks` row (§5.5) naming a
  time span (start_min/end_min) for one child, plus a set of member courses
  chosen from that child's course list. It renders each member course's activities for
  the day, is never tappable itself, shows a checkmark beside each member
  course once that course's day is done, and collapses to a compact done
  state once every member course is checked.
Rationale: corrected 2026-08-15, in review before Phase 7 began — the
  original one-course-per-block model didn't match how a family actually
  schedules a school day: several courses share one sitting ("School:
  9:00-11:30 -- math, language arts, geography"), and a child may have more
  than one such sitting in a day. Superseded before any code existed to
  migrate away from, so this is a correction to the design, not a rebuild.
Consequence: this still REPEALS the read half of wall slice §5.1's
  "kind='activity' is ignored entirely" — a block reads activity rows for
  each of its member courses. The write half is untouched and absolute.
Consequence: the per-course rollup (§5.3) is now the primary signal — a
  family reads "which courses are left," not just a single count — and the
  block-level complete state is derived FROM the per-course state, not
  computed independently. There is exactly one rollup, read two ways.
Locked for: this slice, superseding this section's 2026-08-14 text.
```

The block shows: its label (§5.1.1), its time span, and one row per member course — course name,
that course's activity count (`3 of 5`), and a checkmark once that count's denominator is met. It is
a window onto several courses, not a control for any of them.

#### 5.1.1 Naming a block

A block's label defaults to **"School"** and may be overridden with a custom label per instance
(e.g. "Morning School" / "Afternoon School") — set at creation or edited later from the same sheet
that manages membership (§5.2). The label is cosmetic only: it is not a key, carries no identity, and
is not what distinguishes two same-day blocks for a child — their (possibly overlapping) time spans
do that, the same way two chore chips at different times are distinguished by `start_min`, not by
title.

### 5.2 Membership: which courses are in a block

A block starts empty. Courses are added and removed from a **course picker sheet**, opened by
tapping the block: a checklist of that child's courses that have non-rescinded activities for the
rendered date, with already-member courses pre-checked. Checking a course adds it; unchecking removes
it. This replaces the 2026-08-14 draft's "drag a course out of the tray" gesture (§3.4) — there is no
longer a single course a drag could be dragging, since a block can hold several.

A course with no activities that date does not appear in the picker: there is nothing to add, and an
empty-set membership row would be an invitation to a block that renders as empty for that course
(§5.3). A course removed from a block (or one whose activities are later rescinded to zero) simply
disappears from that block's row list on the next render — its assignment rows are untouched, because
the wall owns nothing of the course's own.

#### 5.2.1 The `course_name` key, and what it costs

Membership is stored as `course_name`, not a course id, for the same reason the pre-2026-08-15 draft
used it as the whole subject key: an activity row's `source_id` is the *activity's* id and differs
every day, so it cannot key a standing relationship. `course_name` is the only course identity the
row carries (`packet.js:521`, snapshotted from `session.maps.courseName`), and it is a
**denormalized text snapshot** by design (`CLAUDE.md` §III.B).

The cost is the same one the original draft named, now scoped to a membership row instead of a whole
block: **renaming a course in the Management App orphans its membership in every block it was in.**
Old activity rows keep the old snapshot, new ones carry the new name, and a membership row matches
whichever string it was created with. Nothing errors — that member's row in the block simply stops
matching new activities and its count reads `0 of 0`, and the fix is to re-check it in the picker.
Accepted for the reason §17.5 gives: renaming a course mid-year is rare, the failure is visible
rather than silent, and threading a course-instance id through `packet.js` is a Management App change
for a wall feature.

### 5.3 Completion: per-course checkmarks, and the block collapses

A member course is checked when, for its child, that course, and the rendered date, every
non-rescinded `kind='activity'` row is `status='complete'`. Waived rows count as resolved, not
outstanding. A member course with **no** activities that day is not checked and not unchecked — it
simply has nothing to show that date (§5.2 keeps it out of the picker in the first place, so this is
the rare case of a course whose activities were all rescinded after being added).

**The block collapses once every member course is checked.** There is no independent block-level
rollup to keep in sync — "all members checked" *is* the complete state, read off the same per-course
computation the checkmarks already use. A collapsed block shrinks to a single compact row (label,
time span, a single checkmark) instead of its full course list; tapping it again re-expands to the
picker. A block with **no members**, or whose members all have zero activities that day, renders as
empty and is never collapsed — an empty set is not an achievement, same rule the original draft
stated for the single-course case.

This is computed in `school-core.js` (§13), pure, from activity rows already in hand — the plan
window already returns them and the wall has simply been discarding them. Per-member checkmarks are
one grouping pass over the same rows the old single-course rollup used; nothing new is fetched.

Refresh timing is unchanged from everything else on the wall: a checkmark (and the block's collapse)
appears on the next poll — the 10-minute ambient cadence, or immediately after any on-device
interaction (§10) — not the instant the child taps complete on their own tablet. The wall has no push
path; §6.4's online-required, no-outbox rule was never about instant cross-device sync.

### 5.4 Creating and sizing a block

```
[DECISION] How a block is created and resized
Decided: a "+ School" affordance (in the tray header, alongside the
  unscheduled-chore strip) mints a new block id and drops an empty,
  unlabeled block into that child's column at a default span (60 minutes, at
  the next free slot). From there it is an ordinary chip: DRAG to move it
  (§16 Phase 5's existing placement-write mechanism — this also sets its
  standing start time, carried forward per §3.3), and LONG-PRESS to open a
  sheet that sets its end time (equivalently, its duration) and its label
  (§5.1.1). Tapping it (a plain tap, not a long-press) opens the membership
  picker (§5.2).
Rationale: proposed in this revision to reuse exactly the mechanics Phase 5
  and 5b already built for chores — drag-to-place and long-press-to-adjust —
  rather than inventing a drag-to-draw-a-range gesture from scratch. The only
  genuinely new pieces are the "+ School" affordance that mints an empty
  block, and the tap target being a membership picker instead of a
  completion sheet.
Consequence: a block's span is a standing placement like everything else in
  this slice (§3.3) — set once, carried forward until moved or resized.
  There is no per-day override for a block's span in v1, matching §17.1's
  deferred treatment of per-day start-time overrides for chores.
Consequence: unlike a chore chip, a block's long-press sheet has no
  precedence chain to display (§3.5.1 no longer applies to blocks) — it
  edits `wall_school_blocks.end_min` directly, with no "just this one" /
  "this and future" fork, because there is no assignment-authored estimate
  underneath it to fall back to or to diverge from.
Not put to Ray — flagged here for confirmation, the same way §3.5.2's
  duration-adjust gesture was, rather than argued as settled.
Locked for: nothing yet.
```

Deleting a block (long-press sheet → remove) un-places it entirely — its member courses' activity
rows are untouched, and the courses simply have no block to show in until a new one is created or
they're added to another. This mirrors the "un-placing never deletes the thing itself" rule §5's
original draft stated for the single-course case.

### 5.5 Where blocks live

```sql
-- migrations/0011_wall_school_blocks.sql
CREATE TABLE IF NOT EXISTS wall_school_blocks (
  id            TEXT    PRIMARY KEY,       -- server-minted, like every other id
  child_id      TEXT    NOT NULL,
  label         TEXT,                      -- NULL = render as "School"
  start_min     INTEGER NOT NULL,          -- minutes from local midnight, % 15 == 0
  end_min       INTEGER NOT NULL,          -- > start_min, % 15 == 0
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL           -- 'wall:<deviceId>'
);

CREATE TABLE IF NOT EXISTS wall_school_block_courses (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  course_name   TEXT    NOT NULL,          -- see §5.2.1's cost
  PRIMARY KEY (block_id, course_name)
);
```

These sit beside `wall_slots`/`wall_slot_days`, not inside them (§3.2's migration 0010 stays exactly
as applied — `CLAUDE.md` §II.4). A block's shape — one span, many members — doesn't fit the
`(child_id, subject_kind, subject_key, instance_key)` singleton key `wall_slots` uses, and trying to
force it in was what made the 2026-08-14 draft wrong: it would have needed one `wall_slots` row per
member course, which is exactly the "N copies of a fact with one value" shape §3.1.2's `claim`
decision already rejected for a different reason.

Both tables are wall-owned in exactly the sense §3.2's `[DECISION]` block already established for
`wall_slots`: written only by the wall, read only by the wall, and outside `CLAUDE.md` §III.E's
child-scoping scheme entirely. Registered in `management-app/worker/migrations.js` in the same
commit that adds it, applied from Settings → Database in the browser, never a CLI (`CLAUDE.md`
§III.D).

**This does widen the wall's write scope a second time**, beyond the `wall_slots`/`wall_slot_days`
widening §18.1 already recorded — two more wall-owned tables, still touching no column of
`assignments` outside `ASSIGNMENT_COMPLETION_FIELDS`. `CLAUDE.md` §I.A's Data Flow cell needs a
further amendment before Phase 7 ships; see §18's note on this revision.

---

## 6. Week view

Seven day-columns, **Sunday-first**, with the same sticky-header treatment — the day names freeze at the
top. The kid-per-column trick is unavailable here (columns are days), so **attribution moves to
colour plus name**: each child gets a stable colour assigned by roster order, carried identically
across day, week and month, and each chip carries the child's name.

Sunday-first is a household fact, not a locale default: **Saturday is the family's Sabbath** and
will usually be empty (Ray, 2026-08-14). Running Monday-first would put that reliably-blank column
second-to-last and strand Sunday alone past it; Sunday-first keeps the busy days contiguous and
lets the quiet one close the week. The month grid (§7) uses the same column order, for the same
reason and so the two views' weeks line up.

Week view is **read-only**. Placement is a day-view gesture: a 15-minute grid across seven columns
at 960px is ~130px a column, which is not a drop target anyone can hit reliably at arm's length.
Tapping a chip opens the same completion sheet (§8.3); tapping empty space in a day jumps to that
day's day view.

Chores, school blocks and events all appear, compressed to one line each, ordered by placement time
with unplaced items last.

---

## 7. Month view

### 7.1 Events only

A month grid — six week-rows of seven day-cells — showing **events**, per Ray's "seeing a whole
month of events at once". Chores are recurring and near-daily; drawing them on a month grid produces
a wall of identical chips that says nothing. Each cell shows its date, its events (title, and
`payload.time` where set), and a `+2 more` affordance when the cell overflows. Tapping a day opens
that day's day view.

A multi-day event appears on each day it touches, with its span label (`Day 2 of 4`) from
`events-core.js:72`.

### 7.2 A household-wide events route

A month of events must not be fetched as one plan call per child per month. Two reasons: the
per-child fan-out multiplies a large window by the roster, and the wall then has to dedupe rows it
paid to transfer (an event assigned to three children is three rows in D1 — wall slice §7).

```
GET /api/wall/events?from=YYYY-MM-DD&to=YYYY-MM-DD
  → { events: [ { id, source_id, date, title, payload } ], from, to }
```

One query, deduped server-side across active children:

```sql
SELECT MIN(a.id) AS id, a.source_id, a.date, a.title, a.payload
  FROM assignments a
  JOIN children c ON c.id = a.child_id AND c.active = 1
 WHERE a.kind = 'event'
   AND a.rescinded_at IS NULL
   AND a.date BETWEEN ?1 AND ?2
 GROUP BY COALESCE(a.source_id, a.id), a.date
 ORDER BY a.date
```

The `GROUP BY` is `events-core.js:23`'s `eventKey` expressed in SQL — the same dedupe, moved to the
side of the wire where it saves rows rather than discards them.

**This route names no child, and that is consistent rather than an exception.** It is
household-scoped by nature, exactly as `/api/wall/children` is: the `JOIN children ... active = 1`
is what bounds it, and it reads no child-owned column that could be attributed to anyone. The four
bounds of `CLAUDE.md` §III.E apply to routes that *act for a named child*; this one does not act,
and does not name.

The window is capped at **62 days** per request, refused above that with a 400. A month view moving
one month at a time never approaches it, and `MAX_QUERY_ROWS` (5000, `validation.js:157`) remains
the backstop.

---

## 8. Completion

### 8.1 What is tappable

Chore chips. That is all. School blocks are read-only (§5.1), events have no completion lifecycle
(wall slice §7), and the unscheduled tray's items are draggable but not tickable until placed —
placing first is what gives a completion a time to sit at.

### 8.2 Who — answered by the column

```
[DECISION] The column a tap lands in names the child
Decided: attribution is positional. Tapping a chip inside Ellie's column acts
  for Ellie. A shared chore spans the columns of the children it is up for, is
  drawn once, and is claimed for whichever column the tap landed in.
Rationale: Ray, 2026-08-14 — "in the day view we should prob have a column per
  kid with shared time label. that would solve who right?" It does, and better
  than the PIN it replaces: the PIN answered "who" once, up to five minutes
  before the tap, and the column answers it at the moment of the tap.
Consequence: the shared-chore dedupe Ray asked for falls out for free. One
  block drawn across two columns is one chore, visibly up for two children,
  rather than the same title drawn twice.
Consequence: week and month views have no columns, so a chip tapped there opens
  the sheet with a child SELECTOR pre-filled from the chip's own row. Only a
  shared chore can present a genuine choice there; a private chore's child is
  already known.
Locked for: this slice.
```

The claim itself is unchanged: `POST /api/wall/assignments/:id/claim` with `{ childId }`, a JSON
body and a `Content-Type` header (an empty body 400s — wall slice §6.3). A losing claim shows
"Talia got there first!" and re-renders.

### 8.3 When — the completion sheet

```
[DECISION] Completion asks for the time it was done
Decided: tapping a chore opens a sheet with the completion time defaulted to
  now, adjustable in 5-minute steps, and a confirm button. `completed_at` is
  what the sheet says.
Rationale: Ray, 2026-08-14 — "I want marking complete to ask the time done, not
  assume based on click time. it should default to current time but allow
  adjustment." Chores are ticked when someone next passes the tablet, not when
  they are finished, and `completed_at` is already reported by the Management
  App in both the CSV export and the on-screen report. A tap-time stamp is a
  quietly wrong number in a place that is read as a right one.
Shape: 5-minute steps, not 15. The grid's 15-minute granularity is about how
  much space a thing occupies; this is a record of a moment, and a five-minute
  stepper is two taps from any quarter hour anyway.
Bound: a time in the FUTURE is refused — the confirm button disables above
  `Date.now()`, with a one-line reason. Nothing else validates it: a parent
  correcting yesterday evening's bins at breakfast is a legitimate entry, and
  the wall does not know enough to second-guess a backdate.
Consequence: the reward entry's `earned_at` matches the sheet, not the tap, so
  the ledger and the assignment row agree about when the work happened.
Locked for: this slice.
```

The sheet is also where **Undo** lives for an already-complete chip (§8.5), and where the "no reward
set" marker appears for a chore whose `reward_category` is `NULL` (wall slice §6.2, unchanged).

Everything else about the write path is unchanged from the wall slice: the pre-check re-poll before
writing (§6.1), `X-Outbox-Protocol: 2`, the earn entry following the completion, and
`wall.pendingEarns` with its three-answer table.

#### 8.3.1 The claim route cannot currently carry the sheet's time — and must

**This is the one place where "existing wall routes are unchanged" (§12) is false, and it fails
silently rather than loudly.** A `claim` chore is completed through the claim route, not
`/api/wall/completions` — `/api/completions` refuses a `claim_group` row outright (`index.js:1508`),
which is exactly the design `TDS_Slice_Shared_Chores.md` §5.7 intends. But that route:

- accepts only `grade` and `completionNote` (`CLAIM_BODY_KEYS`, `index.js:1524`), rejecting anything
  else with a 400 — so a sheet that sent `completedAt` would break the tick outright; and
- stamps `completed_at = ?1` from its own `Date.now()` (`index.js:1587`), with the comment above
  `CLAIM_BODY_KEYS` recording `status` and `completedAt` as "the route's own to set".

Left alone, the wall would ask *when* on a shared chore, accept the answer, and quietly discard it.
Worse than discarding it: the **earn** route already accepts a client `earnedAt` (`index.js:1663`)
and would honour the sheet, so the ledger and the assignment row would actively disagree about when
the work happened — the precise opposite of §8.3's stated consequence.

The shared chores are also the ones where this matters most. "Either of you can do the bins" is
exactly the chore that gets done at six and ticked at eight.

**The fix, and its bound:**

1. `CLAIM_BODY_KEYS` gains `completedAt`, and the claim's step-4 UPDATE binds it where present,
   falling back to `now` when absent — so the Child App's existing claim calls, which send neither,
   are unaffected.
2. `validateCompletionValue` already validates `completedAt` (`validation.js:81-84`) and is already
   applied to every claim body key, so the value check comes for free.
3. **The not-in-the-future bound is enforced server-side, not only in the sheet.** §8.3 disables the
   confirm button above `Date.now()`; that is a UI courtesy, and the rule belongs where every other
   completion rule lives. It applies to both routes, so it is one check in `validateCompletionValue`
   rather than two at the call sites.

**What does not change:** `status`, `claimed_by` and `claimed_at` stay the route's own to set. The
arbitration statement is untouched — this adds a value to the write that follows a *won* claim, not
to the race that decides it. Column ownership is unmoved: `completed_at` is already child-writable
(`ASSIGNMENT_COMPLETION_FIELDS`, `index.js:87`), and this makes the claim route agree with the
completions route about a column both already write.

This is Worker work, so it belongs in **Phase 1a**, not in Phase 6 where the sheet is built — the
route must accept the field before the UI can send it (§16).

### 8.4 Done means done, not gone

```
[DECISION] A completed chore stays exactly where it is
Decided: completion changes a chip's appearance — a check, a muted fill, a
  strike on the title, and the completion time added as a label — and changes
  nothing about its position. It is not removed, not moved to the bottom, not
  moved to its completion time, and not collected into a separate board.
Rationale: Ray, 2026-08-14 — "i DONT want anything to move offscreen when
  finished, just be visible that its done." A board that empties as the day
  goes on is at its least informative exactly when the family most wants to
  look at it.
Consequence: the Done Today board (wall slice §6.7) is REMOVED. It existed to
  show completed chores with their times, and every chip now does that in
  place. Keeping both would be two renderings of one fact.
Consequence: a chip must NOT move to its completion time either. That would
  satisfy "not offscreen" while still breaking the thing the rule protects —
  the eye's memory of where that chore lives. The planned slot is the position;
  the completion time is a label on it.
Locked for: this slice.
```

### 8.5 Undo

Unchanged from wall slice §6.5, including its two distinct paths — the ordinary chore posts a
`pending` completion and a compensating ledger row, and the shared chore calls
`DELETE …/claim` **instead of** a completion, because the release route already writes `pending`
and `/api/completions` refuses a `claim_group` row outright.

What changes is only where it is reached from: the completion sheet on an already-complete chip,
rather than a signed-in child's list. Since there is no session any more, Undo is available to
whoever is standing there — the same trade §2.3 records.

---

## 9. Collisions

```
[DECISION] Overlap is allowed; one narrow case warns
Decided: any number of things may occupy the same slot. A warning appears only
  when two PRIVATE (non-shared, `claim_group IS NULL`) chores for the SAME
  child overlap in time. It is a warning — a coloured edge on both chips and a
  line in the drag confirmation — never a refusal.
Rationale: Ray, 2026-08-14 — "I want to be able to set and see multiple things
  for the same time, only giving a warning if the request puts two private (one
  kid) chore in the same slot." Two children doing different things at 4:15 is
  the normal case. A shared chore overlapping anything is fine, because it may
  well be someone else who does it. One child physically double-booked with two
  chores only they can do is the one arrangement that cannot actually happen.
Consequence: the check is per-child and per-overlap (any intersection of
  [start, start+duration) ranges), not per-slot-row — a 30-minute chore at 4:00
  and a 15-minute one at 4:15 collide, and a slot-equality test would miss it.
Consequence: school blocks do not trigger it. A chore during a school block is
  a scheduling opinion, not a contradiction, and Ray has not asked for the wall
  to hold opinions about that.
Locked for: this slice.
```

Because a placement is a standing default (§3.3), the warning fires **once, at the drag**, rather
than reappearing every morning.

It is nonetheless computed **from the rendered day's rows, not from the placements alone**, and the
first draft of this section had that backwards. Two of the three inputs the check needs are not in
`wall_slots` and cannot be: whether a chore is private (`claim_group IS NULL`) is a column on the
assignment row, and the resolved duration is row 3 of §3.5.1's chain, which reads
`expected_duration_min` from the row as well. §14.5's "an override that shortens a chip can *clear*
a warning" is only meaningful against resolved durations. So: **evaluated at the drag, against that
day's rows, using the resolved duration** — one moment, full information.

---

## 10. Polling, cost, and the refresh button

### 10.1 The cadence

```
[DECISION] A slow ambient poll, not a stopped one
Decided: poll every 10 minutes while idle; poll immediately on any interaction
  (a tap, a view change, a date change) and after any write; offer a large
  centre refresh control. Never stop polling entirely.
Rationale: Ray asked for polling to stop after ~2 minutes of no taps, on the
  assumption it was buying free-tier headroom. It is not: wall slice §5.2
  counted the 60-second cadence at ~5,000 requests and ~5,000 row-writes a day
  against allowances of 100,000 each. What a full stop would cost is the wall's
  entire premise — at 6pm the board would show 4pm, and a chore ticked on a
  child's own tablet would not appear until someone walked over. Ray accepted
  the slow poll instead, 2026-08-14.
Arithmetic, two children, a tick being roster + 2 plans = 3 requests:
    60-second cadence  ≈ 2,950 requests/day
    10-minute cadence  ≈   380 requests/day
  ~8x, on the budget that is actually shared.
Cost note that decided the shape: every authenticated wall request also WRITES
  a row — `withDevice` updates `devices.last_seen_at` through waitUntil
  (`index.js:288`). Row-writes (100,000/day) are a tighter allowance than
  row-reads (5,000,000/day), so the poll's cost is a write cost, not a read one.
Locked for: this slice, subject to §10.2.
```

### 10.2 The allowances are account-wide

Ray raised this and it is the reason the arithmetic above matters more than it did: to the best of
this document's knowledge, Cloudflare's free-tier limits are **per account, not per database or per
Worker**. Several D1 databases on one account share one budget. Cloudflare changes these numbers,
and the dashboard shows live usage with no CLI involved — **check it there rather than trusting this
paragraph**, which is the same instruction wall slice §5.2 gave itself.

### 10.3 Rollover is a timer, not a poll

The local-midnight rollover (wall slice §5.3) fires on its own `setTimeout`, recomputed after each
firing so DST cannot drift it, and is **independent of the poll cadence**. It clears the day map,
recomputes today, resets the view to today, and forces a full fetch. A slow poll must never be able
to leave Tuesday on the screen on Wednesday morning.

### 10.4 Staleness

Unchanged: a `Last updated 14:32` stamp that turns amber past ten minutes stale — which, at a
10-minute cadence, now means roughly "one tick was missed" rather than "ten were". Reads that fail
leave the last render up with no modal (wall slice §5.4).

---

## 11. Look, motion, and sound

### 11.1 Where the personality goes

Ray asked for it to look fun. Nearly all of that is free at runtime:

- **A colour per child**, assigned by roster order, used identically in the day column header, the
  week chip, and the month cell. One child, one colour, everywhere.
- **Chunky rounded chips** with generous padding and a confident display face for titles and the
  time gutter — the wall is read from two metres, so the type scale is larger than a screen app's
  throughout.
- **An icon per chore type** (`payload.choreType`) and a distinct, quieter treatment for school
  blocks so the day reads as two textures rather than one list.
- **Warmth over admin-grey**: a soft background, real shadows on the chips, colour used for meaning
  (whose, and done-or-not) rather than decoration.
- The **night overlay** (wall slice §10.2) is unchanged and sits above all of it.

None of that costs a frame after first paint.

### 11.2 The motion budget

```
[DECISION] Motion only on interaction; nothing loops
Decided: animate `transform` and `opacity` only, 150-300ms, triggered by a
  discrete interaction and then finished. No looping animation anywhere, with
  exactly one exception: the now-line, which moves once per minute.
  `prefers-reduced-motion: reduce` disables all of it.
Rationale: this tablet runs for months, mains-powered, at 100% charge. A
  perpetual animation means the browser never idles — constant CPU on a weak
  MediaTek part, a warm device, and heat plus a permanently full battery is
  what actually destroys these tablets. It is the same reasoning wall slice
  §10.2 used to put the clock on a 15-second tick with no seconds.
Cheap, and allowed: a chip settling into its slot, a check drawing itself, the
  sheet sliding up, the sidebar sweeping out, a colour cross-fade.
Forbidden: animated gradients, pulsing glows, particles, animated `box-shadow`
  or `filter`, and anything animating `width`/`height`/`top`/`left` — that last
  class re-runs layout every frame rather than compositing.
Locked for: this slice.
```

### 11.3 Time format — 24-hour or 12-hour, household choice

```
[DECISION] A time-format setting, defaulting to 24-hour
Decided: `wall.settings.timeFormat` ∈ { '24h', '12h' }, defaulting to '24h',
  set in Settings behind the admin PIN. It governs EVERY time the wall renders
  itself: the time gutter, the clock, chip labels, completion times, the
  completion sheet's stepper, and the early/late strips.
Rationale: Ray, 2026-08-14 — "we usually do military time in our house but just
  in case." Defaulting to the house's own convention and keeping the other one
  a tap away costs one formatter and one radio pair.
Shape: one `formatTime(minutes | ms, fmt)` helper, used everywhere. No
  component formats a time itself — that is how a setting like this rots into
  a screen that is half converted.
Locked for: this slice.
```

**One thing the setting cannot reach, and the UI should not pretend otherwise.** An event's time is
`payload.time`, a **freeform, unvalidated display string** — SRS Module 07 §2.7 fixes it that way
deliberately, and `events-core.js:44-46` already notes it cannot even be sorted chronologically. An
event authored as `3:00 PM` renders as `3:00 PM` in 24-hour mode, because the wall has a string, not
a time. It is displayed verbatim rather than parsed-and-guessed: a regex that turned `3:00 PM` into
`15:00` would also turn `3:00 PM-ish, ask Grandma` into something wrong.

Making event times real is a Module 07 schema and authoring change, deferred (§17.7). Until then
the wall's own times obey the setting and events show what the parent typed.

### 11.4 Child colours — picked in Settings

```
[DECISION] Colour is chosen per child, not derived from roster order
Decided: each child's colour is picked in Settings behind the admin PIN, from a
  fixed palette of eight swatches, and stored in `localStorage` as
  `wall.childPrefs` keyed by `child_id` — the same record that carries their
  §11.5 sound toggle. Until someone picks one, a child gets a palette colour by
  roster order, so a newly-added child is never colourless.
Rationale: Ray, 2026-08-14, choosing this over roster-order assignment. Derived
  colour has a real flaw: the roster is ordered by name, so adding a child —
  or renaming one — re-colours everybody, and the colour is the thing the eye
  uses to find a kid in week and month view. A colour people have learned
  should not move because someone else joined.
Why a fixed palette and not a free picker: this is read from two metres, under
  a night overlay, by people at a glance. Eight swatches chosen for contrast
  and separation guarantee that; an arbitrary hex does not, and the failure
  mode is a wall nobody can read rather than an ugly one.
Why localStorage and not D1, when placements went to D1 (§3.2): the same test,
  answered the other way. Placements are weeks of accumulated arrangement and
  losing them is painful; picking two or three colours takes twenty seconds.
  That is the PIN's argument (wall slice §0.3) and it applies unchanged.
Consequence: colours are per-tablet. A second display would need them picked
  again — twenty seconds, once, and §17.2's promotion path exists if that ever
  stops being true.
Locked for: this slice.
```

Two swatches assigned to two children warns but is permitted — the wall says the colours clash
rather than refusing the pick, which is the same posture §9 takes with overlaps. A child's
preferences survive archive and un-archive, exactly as their PIN row used to, because nothing
deletes a `wall.childPrefs` entry except an explicit reset.

### 11.5 Sound

```
[DECISION] Two sounds, synthesized, bounded by quiet hours and a per-child toggle
Decided: the wall makes exactly two sounds — a chime when a placed chore's
  START TIME arrives and it is still pending, and a short confirmation tone
  when a chore is ticked. Both synthesized with WebAudio; no audio files.
  Silenced during the §10 night-dim window, and switchable off per child.
Rationale: Ray, 2026-08-14. The start-time chime is the sound placement makes
  possible — before this slice nothing in the schema knew when anything was
  meant to begin, so there was no moment to announce.
Declined, and recorded so they are not re-proposed as oversights: a lead-in
  warning ("5 minutes before"), an overdue nag, a one-chime-per-minute
  coalescing cap, and a never-repeat rule.
Consequence of declining the cap: three chores placed at 16:00 across two
  children produce three chimes in sequence, ~600ms apart. This is stated
  rather than quietly capped, because Ray chose it; §17.8 keeps the coalescing
  option on the shelf as a one-setting change if the room disagrees.
Consequence of declining never-repeat: none, and this is worth knowing. Without
  the overdue trigger, "the start time arrives" is a single instant per chore
  per day, so a chore cannot chime twice anyway. The rule would have been
  machinery guarding a case the trigger set makes impossible.
Locked for: this slice.
```

**Cost: nil.** The chime is a `setTimeout` over rows already in memory. No request, no D1 read, no
D1 write, no effect on §10's arithmetic. Sound is the one feature in this slice that is genuinely
free.

**"Still pending" means pending as far as the wall knows, and at a 10-minute cadence (§10.1) that
can be up to ten minutes out of date.** A chore finished on a child's own tablet at 15:55 can still
chime here at 16:00 — a noise announcing work already done, which is the failure mode most likely to
get the sound switched off for good. The cadence and the chime were decided in the same session
without being checked against each other; this is that check.

**Resolution: one poll immediately before a chime fires, not a faster cadence.** `remind-core.js`
knows the next chime instant, so `app.js` schedules the ordinary poll to land just ahead of it and
re-evaluates against the result. Cost is nil to a few extra ticks a day — far below §10.1's
arithmetic — and it buys the one moment where freshness is audible. If the poll fails, the chime
still fires on the last known state: a spurious chime is a smaller failure than a missing one, and
§10.4's staleness stamp is already the honest signal that the board is behind.

**Synthesis, not assets.** An `OscillatorNode` through a `GainNode` with a short attack-decay
envelope — two distinct tones, one rising (start), one brief and higher (confirmation). No files to
precache, nothing for the service worker to version, and no CDN, which §10.2's network-only-for-API
rule would forbid anyway. Volume rides the tablet's hardware volume; a web page cannot set system
volume and should not pretend to.

#### 11.5.1 The autoplay problem, stated as a constraint to verify

**Browsers refuse to play audio in a page the user has never touched.** This is not a bug to code
around; it is a deliberate platform rule, and it lands hardest on exactly this device:

> The tablet reboots at 03:00, the kiosk browser reloads the wall, nobody touches it, and at 07:00
> the first chore's chime does not play. Nothing is broken, nothing logs an error, and the reminder
> feature is silently absent until a human taps the glass.

So the design:

- The `AudioContext` is created lazily and **resumed on the first user gesture** of each page load.
- Until that happens, a small, permanent **"tap to enable sound"** indicator sits in the top bar.
  It is the only honest option: a wall that is quiet for a reason nobody can see is worse than one
  that is quiet and says so.
- A **Test sound** button in Settings, which doubles as the unlock gesture.
- After any tap anywhere, sound works for the rest of that page load.

**This is a constraint to confirm on the actual Fire tablet (§16, Phase 9), not verified fact.**
Silk's exact autoplay behaviour, and whether a kiosk browser's own settings can pre-authorize
audio, are things this document cannot check from here — the same honesty §10.1 of the wall slice
applied to Show Mode.

#### 11.5.2 Bounds

- **Quiet hours** reuse `dimStartHour` / `dimEndHour` (defaults 21:00–06:00) rather than inventing a
  second window. One concept, two effects: the screen dims and the wall goes quiet together.
- **Per-child toggle**, stored alongside that child's colour (§11.4), so one child's column can be
  silent while the other's is not.
- The **confirmation tone ignores both bounds**. It fires on a tap, which means someone is standing
  there, it cannot hit the autoplay problem, and a silent tick at 21:30 reads as a failed tick.

#### 11.5.3 What this hands the Alexa slice

Ray intends Alexa devices around the house to give the same reminders verbally
(`TDS_Slice_Alexa_Voice_Bridge.md`, not started). Two things here make that easier, and neither is
speculative work done in advance:

- **Placements are the "when" that slice never had.** It could answer *what are my chores*; it
  could not say *it is time to do them*, because no column knew when anything started. `wall_slots`
  is that column, it is server-side, and a voice route can read it without the wall's involvement.
- **The cost is small and countable.** A Worker cron scanning for chores due to start would be ~96
  invocations a day against a 100,000 free-tier allowance, with a query riding
  `idx_assign_child_date` over tens of rows — call it ~5,000 row reads a day against five million.
  Cloudflare is not the binding constraint. Amazon's is: a skill, proactive-event permissions, and
  endpoint configuration outside Ray's dashboard.

Explicitly **not built here**: the wall does not talk to Alexa, does not push anything anywhere, and
does not assume that slice exists. It makes a noise in a kitchen.

### 11.6 Navigation

A hamburger at top-left opens a sidebar over the content: **Day · Week · Month**, a date stepper, a
Today button, and Settings behind the admin PIN. It is dismissed by choosing, by tapping outside, or
by 20 seconds of inactivity — a menu left open on a wall display is a broken wall display.

---

## 12. Worker work

| Route | Method | Body / query | Notes |
|---|---|---|---|
| `/api/wall/slots` | GET | `?from=&to=` | Every placement, household-wide, plus any `wall_slot_days` overrides inside the window. Small: one row per chore per child, and overrides are rare. |
| `/api/wall/slots` | PUT | `{ childId, subjectKind, subjectKey, instanceKey?, startMin?, durationMin? }` | Upsert of the standing placement. Validates `childId` per the sentinel rule below; `startMin % 15 === 0` and `0 ≤ startMin < 1440`; `durationMin` a positive multiple of 15 with `startMin + durationMin ≤ 1440`, or `null` to clear the standing override. |
| `/api/wall/slots` | DELETE | `{ childId, subjectKind, subjectKey, instanceKey? }` | Un-place; the chore returns to the tray. Also deletes that subject's `wall_slot_days` rows — an override of a placement that no longer exists is unreachable garbage. |
| `/api/wall/slots/day` | PUT | `{ childId, subjectKind, subjectKey, instanceKey?, date, durationMin }` | §3.5.2's "just this one". Same validation, plus a well-formed `date`. |
| `/api/wall/slots/day` | DELETE | `{ childId, subjectKind, subjectKey, instanceKey?, date }` | Clears the per-day override; the chip falls back down the chain. |
| `/api/wall/events` | GET | `?from=&to=` | §7.2. Household-scoped, deduped, 62-day cap. |
| `/api/wall/school-blocks` | GET | `?from=&to=` | **NEW, §5.5, Phase 7.** Every block, household-wide, with its member courses, inside the window. |
| `/api/wall/school-blocks` | POST | `{ childId, startMin, durationMin, label? }` | **NEW.** Mints a block id (§5.4's "+ School"). Same `startMin`/`durationMin` validation as `/api/wall/slots` PUT; `childId` must be a member of `children WHERE active = 1` — no sentinel here, a block is always one child's. |
| `/api/wall/school-blocks/:id` | PUT | `{ startMin?, durationMin?, label? }` | **NEW.** Moves/resizes/relabels an existing block (§5.4's drag and long-press). `childId` is not patchable — moving a block between children isn't a modeled operation; delete and recreate. |
| `/api/wall/school-blocks/:id` | DELETE | — | **NEW.** Un-places the block. Cascades to its `wall_school_block_courses` rows; touches no activity row (§5's write-side rule, unchanged). |
| `/api/wall/school-blocks/:id/courses` | PUT | `{ courseName }` | **NEW.** Adds a member (§5.2's picker, checking a box). Idempotent — re-adding an existing member is a no-op, not an error. |
| `/api/wall/school-blocks/:id/courses` | DELETE | `{ courseName }` | **NEW.** Removes a member (unchecking a box). Deletes only the membership row; the course's own activity rows are untouched. |

`withWall` gates every route above; a `scope='child'` token is 401 on them and a wall token stays 401
on the device routes (wall slice §8.2).

**The `childId` rule on the four `wall_slots` routes**, stated once because it is the only place this
slice softens a validation:

> `childId` is either a member of `children WHERE active = 1`, **or** the empty-string sentinel —
> and the sentinel is accepted only when `subjectKind === 'chore'` (§3.1.2). Anything else is a 400.

**Revised 2026-08-15 (§20):** this rule no longer has a `subjectKind === 'school'` case to carve out.
`wall_slots` doesn't hold school rows at all any more — §5.5's `wall_school_blocks` routes above take
a plain `childId` with no sentinel, because a block was never a candidate for the `claim`-chore
child-less-row problem §3.1.2 solved; it's always exactly one child's board.

This is not a fourth exception to `CLAUDE.md` §III.E, and the reason is the one §III.E already
records: `wall_slots` and `wall_slot_days` sit **outside** the child-scoping scheme entirely. No
`assignments` access happens on these routes, so there is no `AND child_id = ?` clause to preserve
and no child-owned column to attribute. The four bounds govern routes that act for a named child
against the assignment table; these act against a table the wall owns.

**One existing route does change, and §8.3.1 is why.** The claim route's `CLAIM_BODY_KEYS`
(`index.js:1524`) gains `completedAt`, and its step-4 UPDATE binds it where present and falls back
to `now` where absent. That is the whole change: `status`, `claimed_by`, `claimed_at` and the
arbitration statement are untouched, the Child App's existing calls send neither key and are
unaffected, and `completed_at` is a column both completion routes already write
(`ASSIGNMENT_COMPLETION_FIELDS`, `index.js:87`). `validateCompletionValue` additionally gains the
not-in-the-future bound for `completedAt`, which applies to both routes at once.

`updated_by` on `wall_slots` is `wall:<deviceId>`, matching wall slice §8.4's provenance shape.

**Column ownership on `assignments` is untouched by this slice.** `/api/wall/completions` continues
to reuse `ASSIGNMENT_COMPLETION_FIELDS` verbatim, and **no new route writes an assignment column of
any kind** — all five write either `wall_slots`, `wall_slot_days`, or nothing.

The one existing-route change (§8.3.1) does not dent that argument, and it is worth being precise
rather than reassuring about why: `completed_at` is **already** child-writable and **already**
written by that exact statement. The change lets the caller supply the value instead of the route
minting it — the same latitude `/api/wall/completions` has had since the wall slice, and the same
latitude the earn route already has for `earned_at`. No column moves between owners, and the
parent-owned block is not approached. `expected_duration_min` in particular remains unwritten by any
wall route, which §14.15 asserts directly.

That is the whole safety argument for §18.1's amendment and should be checked against the diff
rather than taken on trust.

---

## 13. File structure

```
wall-app/
├── index.html
├── manifest.json
├── sw.js                  (CACHE_NAME bumped — the shell changes substantially)
├── css/wall.css
├── icons/
└── js/
    ├── app.js             boot, view routing, rollover timer, interaction->poll
    ├── store.js           localStorage: token, settings, pendingEarns  (wall.pins retired)
    ├── api.js             + slots, events and school-block calls (§5.5)
    ├── poll.js            10-minute cadence, day map, since-merge, month cache
    ├── setup.js           first-run wizard: admin PIN, pair the display        (unchanged)
    ├── nav-ui.js          hamburger, sidebar, date stepper, Today
    ├── events-core.js     PURE — union, dedupe, span labels                    (unchanged)
    ├── chores-core.js     PURE — the on-day rule, generalized past "today"
    ├── slots-core.js      PURE — placement lookup (per-child and claim-group),
    │                             carry-forward, duration chain, collisions
    ├── school-core.js     PURE — course grouping, the per-course completion rollup,
    │                             and the block-collapse check (§5.3, revised 2026-08-15)
    ├── remind-core.js     PURE — which chores are due to chime, and when (§11.5)
    ├── sound.js           WebAudio: the two tones, the unlock gesture, quiet hours
    ├── day-ui.js          the grid, columns, school blocks + membership picker,
    │                             now-line, tray, drag
    ├── week-ui.js         seven-day columns
    ├── month-ui.js        month grid of events
    ├── complete-ui.js     the completion sheet: time stepper, undo, claim
    ├── pin-core.js        PURE — admin PIN only                     (child PINs removed)
    └── settings-ui.js     admin PIN, re-pair, dim hours, failed earns, reload
```

Deleted: `ambient-ui.js` and `completed-core.js` — the ambient board and the Done Today selection
are both superseded (§1.2). `child-ui.js` and `session-core.js` are **never created**; they were the
unbuilt Phase 4a of the previous slice and §0.4 repeals what they were for.

Each `*-core.js` stays DOM-free and IO-free, and each mirrored rule keeps its comment naming the
file it mirrors and the section that fixes it (`CLAUDE.md` §I.B). **No file is shared with the Child
App or the Management App**, mirroring included.

---

## 14. Tests

`tests/wall-cores.test.js` extends; `tests/worker-routes.test.js` and
`tests/worker-validation.test.js` gain the route tests.

1. **On-day rule generalized (§4.5)** — deferment and overdue roll-forward on today, and
   *no* roll-forward when the rendered date is in the past.
2. **Placement lookup (§3.1)** — a chore matches on `source_id` + `instance_key`; three instances of
   one chore hold three distinct placements; an unmatched chore reports as unplaced. **Two
   occurrences sharing a label still resolve to different placements** (§3.1.1), which is the
   property minted ids exist to give and the one a reader is most likely to doubt.
   - **(2a) Shared placement (§3.1.2)** — an `each` chore for two children resolves each child's own
     placement independently, and the two may differ; a `claim` chore resolves the single child-less
     row for every participant, so one drag places it for all of them; changing a `claim` chore's
     participants leaves the placement intact and the new participant placed rather than in the
     tray; a `claim` and an `each` placement at the same subject key do not collide in the table.
3. **Carry-forward (§3.3)** — one placement answers for every future date the chore recurs on.
4. **The duration precedence chain (§3.5.1)** — a per-day override beats a standing override beats
   `expected_duration_min` beats 15 minutes; clearing the per-day override falls back exactly one
   step, not all the way. **This chain is chore-only** (revised 2026-08-15, §20) — a school block's
   span is authored directly (§5.4) and is asserted separately in (6).
5. **Collisions (§9)** — two private chores for one child overlapping warns; the same pair for two
   different children does not; a shared chore overlapping a private one does not; partial overlap
   (4:00+30min vs 4:15) is detected where a slot-equality test would miss it. The overlap is
   computed from the resolved duration, so an override that shortens a chip can *clear* a warning.
6. **School blocks, revised model (§5, §20's 2026-08-15 entry)** — a member course is checked only
   when every non-rescinded activity for that course and date is complete; waived counts as
   resolved; a member course with no activities that day is neither checked nor unchecked; rows for
   another course or another child do not contribute. **The block collapses only when every member
   is checked** — a block with one of three members still open does not collapse; a block with zero
   members, or whose members all have zero activities that day, renders empty and never collapses.
   - **(6a) Membership (§5.2)** — the picker lists exactly that child's courses with activities that
     date; checking a course adds it to the block and it appears in that block's row list on the next
     render; unchecking removes it without touching any activity row; a course absent from every
     block's membership is simply not shown anywhere on the wall that day (there is no tray fallback
     for an unassigned course — this is the deliberate consequence of §3.4's course-entry repeal).
   - **(6b) Creation and sizing (§5.4)** — "+ School" mints an empty, unlabeled block at its default
     span; dragging it sets a new standing start time carried forward per §3.3; long-press opens the
     span/label editor, not a precedence-chain sheet (item 4 above already asserts that chain doesn't
     apply here).
7. **Events dedupe (§7)** — unchanged behaviour, re-asserted against the new month window: three
   children's rows for one event on one day collapse to one; a multi-day event yields one entry per
   day with the right span label.
8. **Completion time (§8.3)** — the sheet's time lands in `completed_at` and in the earn's
   `earned_at`; a future time is refused; a backdated one is accepted.
   - **(8a) Completion time on a SHARED chore (§8.3.1)** — the same assertion through the claim
     route, which is a different code path and was the one that silently dropped the value: a
     `completedAt` in a claim body lands on the row; an absent one still falls back to `now`, so the
     Child App's existing calls are unchanged; a future one is refused **server-side**, not merely
     disabled in the sheet; and the completion's `completed_at` equals the earn's `earned_at` for a
     claim chore, which is the disagreement §8.3.1 exists to prevent. A losing claim writes no
     `completed_at` at all.
9. **Done-in-place (§8.4)** — a completed row keeps its placement position in the rendered model and
   is not filtered out of it.
10. Earn shape and the `pendingEarns` three-answer classification — unchanged from wall slice §12.10
    and §12.11, re-run.
11. **Routes** — a `scope='child'` token is 401 on `/api/wall/slots`, `/api/wall/slots/day` and
    `/api/wall/events`; a `PUT` to either slots route with an archived or unknown `childId` writes
    nothing; a `startMin` or `durationMin` that is not a multiple of 15, is negative, or overruns
    midnight is rejected; `DELETE /api/wall/slots` also clears that subject's `wall_slot_days` rows;
    `/api/wall/events` refuses a window over 62 days.
    - **(11a) The sentinel `childId` (§12)** — `''` is accepted on a `subjectKind = 'chore'` PUT and
      stores one row; `''` on a `subjectKind = 'school'` PUT is a 400; the sentinel is **not**
      treated as a wildcard by any read, i.e. a GET returns it as its own row rather than expanding
      it per child. An archived or unknown non-empty `childId` is still refused, so the softening
      reaches exactly one value.
12. **Time formatting (§11.3)** — `formatTime` renders 09:05 and 21:05 correctly in both modes,
    including the two that catch naive implementations: midnight (`00:00` / `12:00 am`) and noon
    (`12:00` / `12:00 pm`). An event's freeform `payload.time` passes through **unmodified** in both
    modes.
13. **Grid range (§4.3)** — a placement at 05:30 or 23:30 lands in the early/late strip rather than
    being clamped into the visible range or dropped; the now-line pins to an edge outside
    06:00–23:00.
14. **Reminders (§11.5)** — `remind-core.js` is pure and testable without a speaker: a pending
    chore at its placed start time is due; the same chore already complete is not; a chore with no
    placement never is; a child whose `soundOn` is false contributes none; nothing is due inside
    the quiet-hours window; and a chore whose start time passed while the page was loading is
    **not** retro-fired on boot — a chime for 08:00 arriving at 08:47 is worse than no chime.
15. **Ownership, asserted directly** — no wall route writes `expected_duration_min`, and a
    `durationMin` sent to `/api/wall/completions` is a per-row `rejected` like any other unknown
    key. §3.5.1 is the reason this test exists rather than being assumed.

---

## 15. Migration and rollout notes

- `wall.settings` gains **`timeFormat`** (§11.3), defaulting to `'24h'`. `store.js`'s
  `DEFAULT_SETTINGS` merge already handles a key absent from an existing tablet's stored object, so
  no migration of `localStorage` is needed — an installed wall picks up the default on first read.
- A new `localStorage` key, **`wall.childPrefs`** (§11.4, §11.5): `[{ childId, swatch, soundOn }]`,
  following `wall.pins`' shape and its survives-archive rule. Absent entries fall back to roster
  order for colour and to sound-on, so the key being empty is a valid steady state rather than a
  first-run task.
- `wall.pins` in `localStorage` becomes dead. It is **left in place, not deleted** — if §0.4 ever
  needs reversing, the PINs are still there, and an unread key costs nothing.
- `sw.js`'s `CACHE_NAME` must be bumped in the phase that changes the shell, or tablets serve the
  old app indefinitely. Settings' **Reload app** button is the manual escape hatch (no CLI).
- Migration `0010_wall_slots.sql` creates **both** tables — `wall_slots` and `wall_slot_days` — in
  one file, because they are one logical change (`CLAUDE.md` §III.D) and an override table without
  the table it overrides is meaningless. Registered in `management-app/worker/migrations.js` **in
  the same commit** and applied from Settings → Database in the browser.

---

## 16. Build phasing

No phase exceeds the `CLAUDE.md` §V.A 2–3 hour ceiling. Each ends with a §VI.A status update.

| Phase | Contents | Est. |
|---|---|---|
| **0** | This TDS; the `CLAUDE.md` v2.3 amendment (§18); the Module 06 and Roadmap entries. ✅ Signed off 2026-08-14. | done |
| **1a — Worker** | Migration 0010 (`wall_slots`, `wall_slot_days`) + registry; `GET/PUT/DELETE /api/wall/slots`; `PUT/DELETE /api/wall/slots/day`; `GET /api/wall/events`; the §12 sentinel `childId` rule; **§8.3.1's `completedAt` on the claim route** and its server-side not-in-the-future bound; tests §14.8a, §14.11, §14.11a, §14.15. No app changes. | ~2.5 h |
| **1b — Management App** | §3.5's chore duration: the authoring field, `validateFields`, `buildRecord`, the `assignmentFromChore` passthrough, the CSV column, and the Module 06 A2 amendment. **Declares `management-app/` in scope** — the only phase that does. | ~1.5 h |
| **2 — Shell & nav** | Hamburger, sidebar, view routing, date stepper, land-on-today, centre refresh, 10-minute cadence, interaction-triggered polls, rollover reset. Ambient board still rendering underneath. | ~2 h |
| **3 — Day view, read-only** | Column-per-child grid over 06:00–23:00 with early/late strips, sticky headers and gutter, now-line and scroll-to-now, events band, 15-minute rows, unscheduled tray, and the §11.3 time formatter with its Settings control. `chores-core.js` generalization, `slots-core.js` lookup. Replaces `ambient-ui.js`. ✅ Landed. | ~2.5 h |
| **4 — Block mode** | Collapse/expand into the four blocks, block hours, unplaced-chore placement by `block_hint`. ✅ Landed. | ~1.5 h |
| **5 — Placement writes** | Drag-and-drop and tap-to-place, 15-minute snapping, the slots API, carry-forward, collision warnings (§9 — at the drag, against that day's rows), and §3.1.2's split: per-child placements for `each`, the single child-less row for `claim`. ✅ Landed. | ~2.5 h |
| **5b — Duration adjust** | §3.5.2's fork: the adjust control, "just this one" vs "this and future", "use the assigned time", the overridden-chip marker, and the precedence chain in `slots-core.js`. ✅ Landed — the adjust control is a long-press on a placed chip (§3.5.2's own text pins the three actions but not the gesture; a plain tap was already spoken for by Phase 6's `onChipTap`). Flagged for confirmation, not signed off. | ~1.5 h |
| **6 — Completion** | The completion sheet (who by column, when by stepper), the earn entry, `pendingEarns`, Undo both paths, the claim path and "got there first" — **sending the sheet's time on both paths**, which Phase 1a made possible — and done-in-place styling. ✅ Landed. Also closes a gap found on review: `store.js`'s dead `wall.pins` key (documented as retired since §0.4 but never actually removed) is deleted, and `wall.failedEarns` is added for §6.2's `rejected` outcome, surfaced in Settings. A `waived` chip (a status §8 never named) opens a read-only sheet rather than either of the two the TDS defines, so the wall can never un-waive a chore through the completion route. | ~2.5 h |
| **6b — Sound** | `remind-core.js` and `sound.js`: the two synthesized tones, the start-time chime and its §11.5 pre-chime poll, the audio unlock and its indicator, quiet hours, the per-child toggle, and Settings' Test sound. ✅ Landed. The pre-chime poll is implemented as a cheap local 5-second no-network tick that only spends an actual `pollNow()` in the one minute a placed chore is scheduled to start, rather than a scheduled-ahead `setTimeout` at the exact instant — functionally the same "poll immediately before the chime" guarantee §11.5 asks for, at less machinery. `wall.childPrefs` is introduced now for the sound toggle, shaped so §11.4's colour picker (Phase 8) can add a field to the same per-child record rather than a second store key. | ~1.5 h |
| **7 — School blocks** | Migration 0011 (`wall_school_blocks`, `wall_school_block_courses`) + registry; the "+ School" create affordance; drag-to-move and long-press-to-resize reusing Phase 5/5b's mechanics; the membership picker sheet (§5.2); `school-core.js`'s per-course rollup and the block collapse-on-complete (§5.3); tests. **Rescoped 2026-08-15 (§20) — the tray's course entries from the original §3.4 text are gone; nothing in this phase now touches the unscheduled tray.** ✅ Landed 2026-08-15. `attachGesture` (day-ui.js) was generalized to take `onDrop`/`onTrayDrop` callbacks instead of hardcoding chore-specific writes, so a block's drag reuses the same pointer machinery without a second gesture recognizer; a block has no tray drop at all (removal goes through its own sheet, §5.4). The tray row is now always rendered (previously hidden when nothing was unplaced) so "+ School" always has somewhere to live. §18.1a's `CLAUDE.md` amendment shipped in the same commit — see `CLAUDE.md` v2.4. | ~3 h |
| **8 — Week & month** | Sunday-first seven-day columns; the month grid on `/api/wall/events`; the §11.4 colour picker in Settings, with colours carried across all three views. | ~2.5 h |
| **9 — Polish & shakedown** | The §11 look pass, remaining tests, `CACHE_NAME` bump, and the on-device shakedown (wall slice §10.3). | ~2 h |

Phases 3, 6 and 8 are each independently deployable and individually useful. The app is a working
read-only day calendar from the end of Phase 4, which is a reasonable place to hang the tablet and
live with it before building placement.

---

## 17. Deferred — decided not to build, with reasons

**17.1 Per-day *start-time* overrides.** §3.3 makes a placement's time standing. Per-day *duration*
overrides are built (§3.5.2) and their table is already keyed by date, so this is now one nullable
`start_min` column on `wall_slot_days` and one more button — but it is a different feature wearing
the same table, and Ray asked for duration. Revisit if he finds himself fighting the carry-forward
on times as well.

**17.2 Parent-side scheduling.** Ray chose wall-only (§0.2). If the Management App ever wants to
place chores, `wall_slots` is the table to promote — it is already keyed by things the Management
App knows (`child_id`, chore `source_id`), and the rename would be the hardest part.

**17.3 Configurable block hours.** §4.4's four ranges are constants. Making them settings is a small
job, deferred until the constants prove wrong in the room.

**17.4 More than four columns.** The day view's layout assumes a small roster. Beyond four the
columns stop being readable at two metres and the design would need horizontal paging — which wall
slice §10.2 forbids — or a different arrangement entirely.

**17.5 A course-instance id on activity rows.** Would make school-block membership survive a course
rename (§5.2.1 — revised 2026-08-15 to describe a membership row rather than a whole block, same
cost either way). It is a Management App change (`packet.js`) for a wall feature, so it waits for a
second reason to exist.

**17.6 Structured event times.** `payload.time` is freeform display text (Module 07 §2.7), so it
cannot be sorted chronologically, cannot be placed on the grid, and cannot obey §11.3's time-format
setting. Fixing it means giving Family Event a real time field in Module 07 — an SRS change, an
authoring change, and a decision about what to do with the strings already authored. Worth doing if
events ever want to sit *in* the grid rather than in the band above it.

**17.7 Reminder shapes Ray declined (§11.5).** A lead-in warning some minutes before a start time;
an overdue nag; a one-chime-per-minute coalescing cap; a never-repeat rule. Each was offered and
not chosen. The first three are a setting and a few lines on top of `remind-core.js` if the room
proves noisier or quieter than expected; the fourth is unnecessary while "start time arrives" is
the only reminder trigger, since that instant happens once.

**17.8 Anything that pushes sound off this tablet.** The wall does not talk to Alexa, a speaker, a
phone, or a notification service. §11.5.3 records what this slice hands the voice bridge; building
that is `TDS_Slice_Alexa_Voice_Bridge.md`'s job.

**17.9 Also not built.** Placement of events or activities; recurring-event authoring; a second wall
tablet; drag-to-resize a chip's duration (duration comes from the assignment or the 15-minute
default); any reporting surface; streaks from the wall (wall slice §15.3, unchanged).

**17.10 A "not a real child" flag on `children`.** Raised by Ray, 2026-08-14, for the `Parents`
pseudo-child (§2.2). **Not built, and not needed for what prompted it** — a shared chore spans only
the columns it is a participant on, so a pseudo-child is excluded by not ticking it, with no schema
change at all. What a flag would buy is the residual noise §2.2 lists: six pickers and the
all-children reporting aggregates.

What it would cost, if that noise ever becomes the reason to build it:

- The child **record** is JSON in `records` (`children.js:47`), so the field itself needs no
  migration.
- But D1's `children` is a flat projection — `id, name, active, updated_at` (`migrations/0001:21`),
  written at `index.js:702` — and the wall reads its roster from that projection. So the flag has to
  reach D1: one migration, one line in the projection writer.
- Then ~6–10 Management App surfaces have to respect it, or it hides the row in one picker and not
  the other five. It belongs behind a `Children.schedulableOnly()` helper, following the pattern
  `Children.activeOnly` already set — the comment at `children.js:326-330` gives the reason directly:
  eight hand-rolled copies of the check are eight chances to write one backwards and quietly hide a
  real child.

**And one thing that is easy to build backwards, recorded now because it will not be obvious then:
this flag is inside-out compared to `active`.** The pseudo-child should be **visible on the wall**
and hidden nearly everywhere else — so the wall is the one surface that does *not* filter on it,
while `active` is filtered on everywhere including the wall. A flag copied from `active`'s shape
would hide `Parents` from the only place Ray wants to see it.

Because it touches the schema and the Management App, this is its own slice under `CLAUDE.md` §V.A,
not an addition to this one.

---

## 18. Amendments required before Phase 1

**✅ Signed off by Ray in-session, 2026-08-14 — all three narrowings of §18.2, individually.
Phase 0 is complete and Phase 1 is clear to start.** What follows is the record of what was
changed and why.

### 18.1a A further amendment, from the 2026-08-15 revision — ✅ landed with Phase 7

**Applied in `CLAUDE.md` v2.4, in the same commit as Phase 7's code.** §5.5's
`wall_school_blocks`/`wall_school_block_courses` are a **second** widening of the wall's
write scope beyond the one §18.1 already covers below. `CLAUDE.md` §I.A's
scope line and Data Flow cell now name these two tables alongside `wall_slots`/`wall_slot_days`,
and §I.B's tree comment gains nothing (no new top-level directory, just two more tables in the same
migration family). Both stay outside `CLAUDE.md` §III.E's child-scoping scheme, for the same reason
`wall_slots` does: no other app reads or writes them, and they carry no child-owned or parent-owned
`assignments` column. **This was not put to Ray as its own individual sign-off**, unlike §18.2's three
narrowings — flagged here so Phase 7 doesn't ship against a stale `CLAUDE.md` the way §18 was
written specifically to prevent.

### 18.1 `CLAUDE.md` → v2.3

1. **§I.A** — the Wall Display App's scope line currently reads *"writes completions, their earn
   entries, and shared-chore claims. Nothing else."* It must gain **its own placement tables
   (`wall_slots`, `wall_slot_days`)** — and, in the same breath, restate that this widens nothing on
   `assignments`: the wall's writes there remain exactly `ASSIGNMENT_COMPLETION_FIELDS`. The read
   side gains activities, read-only, for school blocks (§5.1).
2. **§I.A** — the same table's Data Flow cell gains `GET/PUT/DELETE /api/wall/slots`,
   `PUT/DELETE /api/wall/slots/day` and `GET /api/wall/events`.
2a. **§0** — the "Column-level ownership" row gains a sentence naming the case that tested it and
   held: the wall adjusts a duration by writing an override in a table it owns, **not** by writing
   the parent-owned `expected_duration_min` (§3.5.1). The rule bent nothing; the feature was built
   around it.
3. **§III.E** — no change to the four bounds, but a sentence recording that `/api/wall/events` is
   household-scoped and names no child, like `/api/wall/children`, so the bounds that govern
   acting-for-a-named-child do not apply to it.
4. **§VII** — two rows: *Wall calendar redesign — day/week/month, wall-owned placements carried
   forward, no per-child PIN gate* (**LOCKED**), and *Per-child PIN gating on the wall*
   (**REPEALED**).
5. **§IV.B** — a row: *Wall App placement write added → writes only `wall_slots`; no `assignments`
   column touched outside `ASSIGNMENT_COMPLETION_FIELDS`.*

### 18.2 The three narrowings, each signed off individually

Each is a departure from something previously locked. Each was put to Ray with the alternative that
was considered and rejected, so the sign-off was a choice rather than a rubber stamp.

1. ✅ **The wall writes a table of its own (§3.2)** — narrows `CLAUDE.md` §I.A's "nothing else."
   *Alternative offered and declined: keep placements in `localStorage`, costing no amendment but
   losing weeks of arrangement to any browser data clear.*
2. ✅ **Per-child PIN gating is repealed (§0.4, §2.3)** — repeals wall slice §0.3/§0.4/§4.
   *Alternative offered and declined: keep the gate and answer "who" with it, at the cost of the
   shared board Ray asked for. The real consequence — any child can tick any child's chore — is
   stated in §2.3 rather than buried.*
3. ✅ **The wall reads activity rows (§5.1)** — repeals the read half of wall slice §5.1.
   *Alternative offered and declined: school blocks that show only a course name and no progress,
   which is a label rather than a block. The write half is untouched and absolute.*

### 18.3 `docs/SRS_Management_Module_06_Chore_Authoring.md`

Gains `expectedDurationMin` as an optional authored field (§3.5): an FR in §4, a row in §5's
validation table (optional; positive integer minutes; blank means the 15-minute default), and a
line in §2 recording that a chore may now carry an estimated duration for the same reason an
activity does. Amendment A2, in the style A1 already established in that document.

This is the one place where the slice's scope reaches outside `wall-app/` and the Worker.
`CLAUDE.md` §I.A forbids shared runtime *code*, not coordinated change, and no file is shared —
but the session that builds it must declare `management-app/` in scope (§16, Phase 1b).

### 18.4 `docs/TDS_Slice_Wall_Display_App.md`

Gains a header note pointing at this document as its successor, and §1.2's table as the map of what
in it still applies. It is **not** deleted — most of its architecture survives, and its reasoning is
the reason this slice could be short.

### 18.5 `docs/Roadmap_Schedule_App.md` §0

A slice entry with §16's phase table.

### 18.6 The 2026-08-14 review changes need no further `CLAUDE.md` amendment

Checked rather than assumed, because two of them touch things §18.2 had to get signed off:

- **The child-less placement row (§3.1.2)** lives in `wall_slots`, which v2.3 §III.E already places
  *outside* the child-scoping scheme. The sentinel changes which rows that wall-owned table holds; it
  does not reach `assignments`, so no bound moves.
- **`completedAt` on the claim route (§8.3.1)** writes a column that is already child-writable and
  already written by that same statement — the caller supplies the value instead of the route
  minting it. §I.A's write list is unchanged, and §IV.B's placement-write row still holds verbatim.
- **Courses in the tray (§3.4)** is a read of activity rows, which §18.2's third narrowing already
  authorized, and a write to `wall_slots`, which its first one did.

The §IV.B check to run against the diff is the one already written: *no `assignments` column touched
outside `ASSIGNMENT_COMPLETION_FIELDS`* — and `completed_at` is in it.

### 18.7 No SRS module for the wall itself

Same call wall slice §16.4 made, for the same reason: §3–§11 specify this surface more precisely
than an SRS module would. If the wall grows past a calendar, it earns one then. §18.3's Module 06
amendment is a Management App change and is unaffected by this.

---

## 19. Open questions — all closed

**All four are answered.** They are recorded here as a pointer to the sections that now own them,
rather than deleted, so a reader of an early draft can find where each landed:

1. **Week start** — Sunday-first, so the Sabbath closes the week. §6.
2. **Chip duration** — `expected_duration_min`, with a new Chore Authoring field behind it and a
   wall-owned override above it. §3.5, §3.5.1.
3. **Day-view range** — 06:00–23:00, ending at a child's bedtime, with early/late strips for
   anything placed outside. §4.3.
4. **Colour assignment** — picked per child in Settings from a fixed eight-swatch palette, with
   roster order as the until-picked default. §11.4.

Nothing in this slice is now waiting on an answer.

---

## 20. Revision log

### 2026-08-15 — §5 rewritten, before Phase 7 code

Before Phase 7 started, review found the 2026-08-14 §5 model didn't match how the family actually
schedules school: one block per course, created by dragging a single course out of the tray, versus
the real pattern of several courses sharing one sitting (`"School: 0900-1130 -- Math, Language Arts,
Geography"`) with possibly more than one sitting a day. Nothing elsewhere in the slice depended on
the old shape yet — no code existed — so this is a correction, not a migration.

| # | Changed | Section |
|---|---|---|
| 1 | A block's subject changed from one course to a minted block id holding a **set** of member courses, added/removed via a course-picker sheet opened by tapping the block, rather than created by dragging a course out of the tray. | §3.1, §3.4, §5.1, §5.2 |
| 2 | Block placements moved out of `wall_slots` (whose singleton key can't express "one span, many members") into two new tables, `wall_school_blocks` and `wall_school_block_courses` — migration 0011, additive, `wall_slots`/migration 0010 untouched. | §3.2, §5.5 |
| 3 | A block's span is now **authored directly** (drag to place, long-press to resize) instead of derived from summing member activity durations — so §3.5.1's precedence chain no longer applies to blocks. | §3.5.1, §5.4 |
| 4 | Completion became **per-course**: each member course gets its own checkmark as its activities finish, refreshed on the existing poll cadence; the block collapses to a compact done state once every member is checked, rather than the block computing one independent rollup. | §5.3 |
| 5 | A block gained an optional custom label (default "School"), since two same-day blocks for one child ("Morning School" / "Afternoon School") need something a bare time span doesn't give a reader at a glance. | §5.1.1 |
| 6 | The block-creation gesture ("+ School" affordance, then reuse Phase 5/5b's drag-to-move and long-press-to-resize) is proposed but **not put to Ray** — flagged the same way §3.5.2's gesture choice was, not asserted as settled. | §5.4 |
| 7 | This is a **second** widening of the wall's write scope beyond §18.1's `wall_slots`/`wall_slot_days` one, and it has not yet been signed off the way §18.2's three narrowings were. | §18.1a |

### 2026-08-14 — design review, before Phase 1a

The slice was read against the Worker, the migrations and both apps before any code was written.
Three gaps would each have been found the hard way — one during the build, two after the tablet was
on the wall — plus three smaller corrections. Nothing structural moved: the wall-owned table, the
carry-forward default, the duration override sitting on top of the parent's estimate, and
column-names-the-child all survive unchanged.

| # | Found | Section |
|---|---|---|
| 1 | **A shared chore had nowhere to live.** §4.2 draws a shared chore once, spanning columns, but placements are keyed by `child_id` and the PUT takes one child — so it would have been placed for one participant and left in the other's tray, which is the duplication the column layout was supposed to end. Resolved by splitting `each` (per-child, unchanged) from `claim` (one child-less row on the household sentinel). | §3.1.2, §3.2, §12, §14.2a, §16 |
| 2 | **A shared chore could not record the sheet's time.** The claim route stamps its own `Date.now()` and rejects any body key but `grade`/`completionNote`, so §8.3's promise was false on exactly the chores where it matters most — and the earn route *does* honour a client time, so the ledger and the row would have disagreed. Resolved by adding `completedAt` to `CLAIM_BODY_KEYS`, with the not-in-the-future bound moved server-side. | §8.3.1, §12, §14.8a, §16 |
| 3 | **A school block could not be created.** §5.1 defines one as a placement of a course, but the tray held chores only and no phase described placing a course — so the feature had no way in and school work would have been invisible rather than unplaced. Resolved by putting unplaced courses in the same tray. | §3.4, §5.1, §14.6a, §16 |
| 4 | §9 said collisions were evaluated against the placements; two of the three inputs it needs (private-vs-shared, and the resolved duration) live on the day's rows and cannot be in `wall_slots`. Corrected to at-the-drag, against that day's rows. | §9 |
| 5 | The start-time chime read "still pending" from data up to ten minutes stale (§10.1), so it could announce work already done — the failure most likely to get sound switched off. One poll now lands just ahead of each chime. | §11.5 |
| 6 | Three stale citations: the roll-forward is `planner-core.js:179` (`onToday`), not `:154`; the duration passthrough is `packet.js:527`, not `:526`; §20's ownership-test pointer is §14.15, not §14.12. | throughout |

**Ray's question that sharpened #1**, 2026-08-14: *"I have multiple instances of a chore, sometimes
sharing same name. do they get their own ids? how would you identify the other kid's copy?"* They do
— occurrence ids are minted 6-character tokens, never the label (`chores.js:416`), so two
occurrences called "Dishes" stay distinct and renaming one does not move its placement. §3.1.1
records that, because it is the property the whole placement key rests on and the one a reader is
most likely to doubt. The other kid's copy is found by `source_id` + `instance_key`; `claim_group`
recognises a shared chore but cannot key a placement, being minted per day and NULL on every `each`
row. That is what made the `each`/`claim` split visible.

**And the follow-up that closed §2.2**, 2026-08-14: *"I was gonna write a fake kid — 'Parents' — and
I dont want it spanning that one."* It will not, and no flag is needed: spanning follows
participation, which is ticked per chore. §2.2 says so outright so that nobody later "fixes" it with
a schema change; §17.10 records what a flag would cost if the reporting noise ever justifies one,
including the thing that is easy to get backwards — the flag is inside-out compared to `active`,
since `Parents` should be visible on the wall and hidden everywhere else.

### 2026-08-14 — sign-off, and two decisions taken during it

**Signed off by Ray, in-session:** all three narrowings of §18.2 — the wall writing a table of its
own, the repeal of per-child PIN gating, and the read of activity rows for school blocks. Phase 0
closes with this revision; Phase 1 is clear to start.

**Three things changed in the same conversation, all improvements on the draft:**

| Draft said | Ray said | Now |
|---|---|---|
| `wall_slots.duration_min`, a per-placement duration, as the only duration | *"we have an estimated activity time field we use for pacing; why not just write that into a column on the d1 assignment table and let me set it for Chores too?"* | §3.5. The column already exists and both Worker allowlists already carry it, so the authored estimate is a Management App change and nothing else. |
| — | *"do let them adjust the minutes on already assigned stuff though… and if they adjust, ask just this instance or future assigned occurances"* | §3.5.1/§3.5.2. The wall gets an override it owns, a four-step precedence chain, and the two-button fork. `wall_slots.duration_min` returns as an *override*, and `wall_slot_days` is added for the per-instance case. |
| Week view Monday-first (§19.1's default) | *"do Sunday first though. Saturday is our Sabbath and will likely always be blank so I dont want Sunday orphaned by its lonesome"* | §6, and the month grid follows it. |
| A full 24-hour grid (§19.1's default) | *"just do 0600-2200… actually 0600-2300, as that is bedtime for one kid"* | §4.3. 68 rows instead of 96, ending at a household boundary, with early/late strips so a placement outside the range is never swallowed. |
| Times always 12-hour | *"give me a military time and standard am/pm setting too lol. we usually do military time in our house but just in case"* | §11.3. `wall.settings.timeFormat`, defaulting to `24h`, through one shared formatter. Event times are the exception it cannot reach — they are freeform strings by Module 07's design. |
| Child colours derived from roster order (§19.4's default) | *"pick color in settings"* | §11.4. Eight-swatch palette, picked per child, stored locally — because a colour people have learned should not move when someone else joins the roster. |

**§19's four open questions are all closed**, three of them within an hour of the slice being
written. Nothing in this document is waiting on an answer, and Phase 1a can start cold.

**Added in the same conversation: sound (§11.5).** Ray asked whether the wall could make a noise as
a reminder, and placement is what makes that answerable — before this slice nothing in the schema
knew when anything was meant to *start*, so there was no moment to announce. Two tones, synthesized,
free of any request. He chose the start-time chime and the completion confirmation, bounded by quiet
hours and a per-child toggle, and declined the lead-in warning, the overdue nag, and the coalescing
cap; §17.7 keeps those on the shelf. §11.5.1 records the browser autoplay rule as the one thing that
can silently defeat the feature, and puts a visible indicator in front of it rather than hoping.

His follow-up — *"or is that gonna tip free tier lol"* — is answered in §11.5 (the chime costs
nothing at all) and §11.5.3 (a future Alexa cron would be ~96 invocations and ~5,000 row reads a
day, against allowances of 100,000 and 5,000,000; Amazon's requirements bind long before
Cloudflare's do).

The duration split is the better design for a reason worth keeping: **the estimate belongs to the
work, the override belongs to the wall.** The draft had one number on the placement, which would
have made "empty the dishwasher takes ten minutes" a fact re-entered every time the chore moved.

**One constraint did not move, and is worth recording as a constraint that held rather than one
that was worked around.** `expected_duration_min` is parent-owned (`migrations/0001:46`), and
`CLAUDE.md` §0 admits no credential class that widens column ownership. The obvious implementation
of Ray's request — let the wall PATCH the estimate — is exactly the thing that rule forbids, and the
override table is what the requirement looks like once it is built inside the rule instead of
through it. §14.15 asserts it in a test rather than trusting the review.

---

*Companion documents: `TDS_Slice_Wall_Display_App.md` (the app this rewrites),
`TDS_Slice_Online_Revamp.md` (controlling), `TDS_Slice_Shared_Chores.md`, `CLAUDE.md`.*
