# Technical Design Specification — Slice

## Scope: Wall Calendar — the Wall Display App becomes a shared family calendar with 15-minute chore placement, block collapse, week and month views

**Status:** design only. No code written under this slice yet. **Awaiting Ray's sign-off on §18.**
**Date:** 2026-08-14.
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

7. **School blocks are read-only aggregates.** A school block is a placement whose subject is a
   *course*, not a single assignment. It renders the day's activities for that course, cannot be
   ticked, and shows as complete when every activity for that course on that day is complete. §5.

8. **Overlap is normal.** Two things may share a slot. The only warning is two **private**
   (non-shared) chores for the **same child** overlapping, and it is a warning, never a block. §9.

9. **The ambient poll slows to 10 minutes**, polls immediately on any interaction, and offers a
   large centre refresh. The midnight rollover stays on its own timer and is not a poll. §10.

10. **Motion is spent only on interaction.** Transform and opacity only, 150–300ms, nothing loops —
    with one exception, the now-line, which moves once a minute. §11.

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
| §0.5, §6.3 — shared chores claimable from the wall | **Survives**, with the column-tap replacing the PIN as the thing that names the claimant (§8.2). |
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

Two ordinary consequences ride along, neither of them this slice's problem to solve: the row appears
in Management App reporting, and chores assigned to it append `reward_entries` like anyone else's.
Recorded here so that neither is discovered later as a surprise.

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
| School block | `course_name` | An activity's `source_id` is the *activity's* id and differs every day, so it cannot key a standing arrangement. `course_name` is the only course identity on the row (`packet.js:521`). §5.2 states the cost of that honestly. |
| Event | — | Events are not placeable. They carry their own freeform `payload.time` and are family-wide. §7.1. |

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
  child_id      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,          -- 'chore' | 'school'
  subject_key   TEXT    NOT NULL,          -- chore: source_id; school: course_name
  instance_key  TEXT    NOT NULL DEFAULT '',
  start_min     INTEGER NOT NULL,          -- minutes from local midnight, % 15 == 0
  duration_min  INTEGER NOT NULL DEFAULT 15,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,          -- 'wall:<deviceId>'
  PRIMARY KEY (child_id, subject_kind, subject_key, instance_key)
);
```

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

### 3.4 Chores with no placement yet

A chore the wall has never been told a time for is **not hidden and not guessed at**. It goes in an
**unscheduled tray** at the top of its child's column — a compact, always-visible strip reading
`Not scheduled · 3`, expanding to the list, each item draggable into the grid.

The alternative — deriving a slot from `block_hint` (morning → 9:00 and so on) — was rejected. It
would put chores on the grid at times nobody chose, and since a placement is a standing default
(§3.3) the first drag of a mis-derived chore would look like a correction rather than a first
placement. The tray makes placement a deliberate act exactly once per chore.

In **block mode** (§4.4) an unplaced chore appears inside its `block_hint` block instead of the
tray, since that is precisely the information a block hint carries. `child_block_hint` is read as an
override where present, mirroring `planner-core.js:55` — the wall reads it and, as ever, never
writes it.

### 3.5 Placement writes are online-required

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
  increments". A chip's height is its `duration_min`.
- **Default duration is 15 minutes** for a chore with no `expected_duration_min`, matching the
  pacing engine's own fallback (`packet.js:43`, `DEFAULT_MINUTES = 15`). Where the column carries a
  duration it is used.
- **The now-line** is a single horizontal rule across all columns at the current time, and the grid
  **scrolls to it on load** so the tablet opens on the part of the day that is actually happening.
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
roll-forward for still-pending required rows (`planner-core.js:154`). A chore the child deferred to
tomorrow on their own tablet is absent from the wall's today, and yesterday's un-done bins are
present on it.

The roll-forward only applies when the rendered date **is** today. Rendering *last* Tuesday must
show what was due last Tuesday, not everything still pending from before it — otherwise scrolling
back through the week would show the same overdue chore on every day at once.

---

## 5. School blocks

### 5.1 What they are

```
[DECISION] School blocks are read-only course aggregates
Decided: a placement of `subject_kind = 'school'` whose subject is a course
  name. It renders that course's activities for that day, is never tappable,
  and renders as complete when every one of that day's non-rescinded activities
  for that course is complete.
Rationale: Ray, 2026-08-14 — "I want to be able to set School 'blocks' that
  they can pull in course level information on. it should be read only on wall
  app, but move to complete when all assignments for a particular course are
  finished."
Consequence: this REPEALS the read half of wall slice §5.1's "kind='activity'
  is ignored entirely." The write half is untouched and absolute: the wall has
  no code path, no button, and no route that writes anything to an activity
  row. School work is still completed on the child's own tablet.
Locked for: this slice.
```

The block shows: the course name, the count (`3 of 5 done`), and the day's activity titles listed
beneath at a smaller size. It is a window onto the course, not a control for it.

### 5.2 The `course_name` key, and what it costs

An activity row's `source_id` is the *activity's* id and differs every day, so it cannot key a
standing placement. `course_name` is the only course identity the row carries (`packet.js:521`
snapshots it from `session.maps.courseName`), and it is a **denormalized text snapshot** by design
(`CLAUDE.md` §III.B).

The cost, stated rather than discovered later: **renaming a course in the Management App orphans
its school block.** Old rows keep the old snapshot, new rows carry the new name, and the placement
matches whichever string it was created with. The block does not break or error — it simply stops
matching new rows and shows as empty, and the fix is to place it again.

This is accepted because renaming a course mid-year is rare, the failure is visible rather than
silent, and the alternative (threading a course-instance id through `payload` in `packet.js` and
into every activity row) is a Management App change for a wall feature, which §I.A's isolation rule
points away from.

### 5.3 Completion rollup

A school block is complete when, for its child, its course, and the rendered date, every
non-rescinded `kind='activity'` row is `status='complete'`. Waived rows count as resolved, not as
outstanding. A block with **no** activities that day renders as empty, not as complete — an empty
set is not an achievement.

This is computed in `school-core.js` (§13), pure, from rows already in hand. It costs no new fetch:
the plan window already returns activity rows and the wall has simply been discarding them.

---

## 6. Week view

Seven day-columns, Monday-first, with the same sticky-header treatment — the day names freeze at the
top. The kid-per-column trick is unavailable here (columns are days), so **attribution moves to
colour plus name**: each child gets a stable colour assigned by roster order, carried identically
across day, week and month, and each chip carries the child's name.

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

Because a placement is a standing default (§3.3), the warning is evaluated against the *placements*,
not against a particular day's rows — so it fires once, at the drag, rather than reappearing every
morning.

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

## 11. Look and motion

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

### 11.3 Navigation

A hamburger at top-left opens a sidebar over the content: **Day · Week · Month**, a date stepper, a
Today button, and Settings behind the admin PIN. It is dismissed by choosing, by tapping outside, or
by 20 seconds of inactivity — a menu left open on a wall display is a broken wall display.

---

## 12. Worker work

| Route | Method | Body / query | Notes |
|---|---|---|---|
| `/api/wall/slots` | GET | — | Every placement, household-wide. Small: one row per chore per child. |
| `/api/wall/slots` | PUT | `{ childId, subjectKind, subjectKey, instanceKey?, startMin, durationMin }` | Upsert. Validates `childId` against `children WHERE active = 1`; `startMin % 15 === 0`, `0 ≤ startMin < 1440`; `durationMin` a positive multiple of 15, `startMin + durationMin ≤ 1440`. |
| `/api/wall/slots` | DELETE | `{ childId, subjectKind, subjectKey, instanceKey? }` | Un-place; the chore returns to the tray. |
| `/api/wall/events` | GET | `?from=&to=` | §7.2. Household-scoped, deduped, 62-day cap. |

Existing wall routes are unchanged. `withWall` gates all four; a `scope='child'` token is 401 on
them and a wall token stays 401 on the device routes (wall slice §8.2).

`updated_by` on `wall_slots` is `wall:<deviceId>`, matching wall slice §8.4's provenance shape.

**Column ownership on `assignments` is untouched by this slice.** `/api/wall/completions` continues
to reuse `ASSIGNMENT_COMPLETION_FIELDS` verbatim, and no new route writes an assignment column of
any kind. That sentence is the whole safety argument for §18.1's amendment and should be checked
against the diff rather than taken on trust.

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
    ├── api.js             + slots and events calls
    ├── poll.js            10-minute cadence, day map, since-merge, month cache
    ├── setup.js           first-run wizard: admin PIN, pair the display        (unchanged)
    ├── nav-ui.js          hamburger, sidebar, date stepper, Today
    ├── events-core.js     PURE — union, dedupe, span labels                    (unchanged)
    ├── chores-core.js     PURE — the on-day rule, generalized past "today"
    ├── slots-core.js      PURE — placement lookup, carry-forward, collisions
    ├── school-core.js     PURE — course grouping and the completion rollup
    ├── day-ui.js          the grid, columns, blocks, now-line, tray, drag
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
   one chore hold three distinct placements; an unmatched chore reports as unplaced.
3. **Carry-forward (§3.3)** — one placement answers for every future date the chore recurs on.
4. **Collisions (§9)** — two private chores for one child overlapping warns; the same pair for two
   different children does not; a shared chore overlapping a private one does not; partial overlap
   (4:00+30min vs 4:15) is detected where a slot-equality test would miss it.
5. **School rollup (§5.3)** — complete only when every non-rescinded activity for that course and
   date is complete; waived counts as resolved; **no activities that day renders empty, not
   complete**; rows for another course or another child do not contribute.
6. **Events dedupe (§7)** — unchanged behaviour, re-asserted against the new month window: three
   children's rows for one event on one day collapse to one; a multi-day event yields one entry per
   day with the right span label.
7. **Completion time (§8.3)** — the sheet's time lands in `completed_at` and in the earn's
   `earned_at`; a future time is refused; a backdated one is accepted.
8. **Done-in-place (§8.4)** — a completed row keeps its placement position in the rendered model and
   is not filtered out of it.
9. Earn shape and the `pendingEarns` three-answer classification — unchanged from wall slice §12.10
   and §12.11, re-run.
10. **Routes** — a `scope='child'` token is 401 on `/api/wall/slots` and `/api/wall/events`; a
    `PUT /api/wall/slots` with an archived or unknown `childId` writes nothing; a `startMin` that is
    not a multiple of 15, is negative, or overruns midnight is rejected; `/api/wall/events` refuses a
    window over 62 days.

---

## 15. Migration and rollout notes

- `wall.pins` in `localStorage` becomes dead. It is **left in place, not deleted** — if §0.4 ever
  needs reversing, the PINs are still there, and an unread key costs nothing.
- `sw.js`'s `CACHE_NAME` must be bumped in the phase that changes the shell, or tablets serve the
  old app indefinitely. Settings' **Reload app** button is the manual escape hatch (no CLI).
- Migration `0010_wall_slots.sql` is registered in `management-app/worker/migrations.js` **in the
  same commit** and applied from Settings → Database in the browser.

---

## 16. Build phasing

No phase exceeds the `CLAUDE.md` §V.A 2–3 hour ceiling. Each ends with a §VI.A status update.

| Phase | Contents | Est. |
|---|---|---|
| **0** | This TDS; the `CLAUDE.md` v2.3 amendment (§18); the Roadmap entry. **Ray's sign-off on §18 before Phase 1.** | done on approval |
| **1 — Worker** | Migration 0010 + registry; `GET/PUT/DELETE /api/wall/slots`; `GET /api/wall/events`; tests §14.10. No app changes. | ~2 h |
| **2 — Shell & nav** | Hamburger, sidebar, view routing, date stepper, land-on-today, centre refresh, 10-minute cadence, interaction-triggered polls, rollover reset. Ambient board still rendering underneath. | ~2 h |
| **3 — Day view, read-only** | Column-per-child grid, sticky headers and gutter, now-line and scroll-to-now, events band, 15-minute rows, unscheduled tray. `chores-core.js` generalization, `slots-core.js` lookup. Replaces `ambient-ui.js`. | ~2.5 h |
| **4 — Block mode** | Collapse/expand into the four blocks, block hours, unplaced-chore placement by `block_hint`. | ~1.5 h |
| **5 — Placement writes** | Drag-and-drop and tap-to-place, 15-minute snapping, the slots API, carry-forward, collision warnings. | ~2.5 h |
| **6 — Completion** | The completion sheet (who by column, when by stepper), the earn entry, `pendingEarns`, Undo both paths, the claim path and "got there first", done-in-place styling. | ~2.5 h |
| **7 — School blocks** | `school-core.js`, course grouping, the read-only block, the rollup. | ~1.5 h |
| **8 — Week & month** | Seven-day columns; the month grid on `/api/wall/events`; child colours carried across all three views. | ~2.5 h |
| **9 — Polish & shakedown** | The §11 look pass, remaining tests, `CACHE_NAME` bump, and the on-device shakedown (wall slice §10.3). | ~2 h |

Phases 3, 6 and 8 are each independently deployable and individually useful. The app is a working
read-only day calendar from the end of Phase 4, which is a reasonable place to hang the tablet and
live with it before building placement.

---

## 17. Deferred — decided not to build, with reasons

**17.1 Per-day placement overrides.** §3.3 makes a placement standing. A one-day override needs a
date-keyed second table, a "this day or every day?" prompt on every drag, and a precedence rule when
the standing time later moves. Revisit if Ray finds himself fighting the carry-forward.

**17.2 Parent-side scheduling.** Ray chose wall-only (§0.2). If the Management App ever wants to
place chores, `wall_slots` is the table to promote — it is already keyed by things the Management
App knows (`child_id`, chore `source_id`), and the rename would be the hardest part.

**17.3 Configurable block hours.** §4.4's four ranges are constants. Making them settings is a small
job, deferred until the constants prove wrong in the room.

**17.4 More than four columns.** The day view's layout assumes a small roster. Beyond four the
columns stop being readable at two metres and the design would need horizontal paging — which wall
slice §10.2 forbids — or a different arrangement entirely.

**17.5 A course-instance id on activity rows.** Would make school blocks survive a course rename
(§5.2). It is a Management App change (`packet.js`) for a wall feature, so it waits for a second
reason to exist.

**17.6 Also not built.** Placement of events or activities; recurring-event authoring; a second wall
tablet; drag-to-resize a chip's duration (duration comes from the assignment or the 15-minute
default); any reporting surface; streaks from the wall (wall slice §15.3, unchanged).

---

## 18. Amendments required before Phase 1

**These need Ray's sign-off. Phase 1 does not start until they are signed.**

### 18.1 `CLAUDE.md` → v2.3

1. **§I.A** — the Wall Display App's scope line currently reads *"writes completions, their earn
   entries, and shared-chore claims. Nothing else."* It must gain **its own placement table
   (`wall_slots`)** — and, in the same breath, restate that this widens nothing on `assignments`:
   the wall's writes there remain exactly `ASSIGNMENT_COMPLETION_FIELDS`. The read side gains
   activities, read-only, for school blocks (§5.1).
2. **§I.A** — the same table's Data Flow cell gains `GET/PUT/DELETE /api/wall/slots` and
   `GET /api/wall/events`.
3. **§III.E** — no change to the four bounds, but a sentence recording that `/api/wall/events` is
   household-scoped and names no child, like `/api/wall/children`, so the bounds that govern
   acting-for-a-named-child do not apply to it.
4. **§VII** — two rows: *Wall calendar redesign — day/week/month, wall-owned placements carried
   forward, no per-child PIN gate* (**LOCKED**), and *Per-child PIN gating on the wall*
   (**REPEALED**).
5. **§IV.B** — a row: *Wall App placement write added → writes only `wall_slots`; no `assignments`
   column touched outside `ASSIGNMENT_COMPLETION_FIELDS`.*

### 18.2 The three narrowings needing individual sign-off

Each is a departure from something previously locked. Each is listed with the alternative that was
considered and rejected, so the sign-off is a choice rather than a rubber stamp.

1. **The wall writes a table of its own (§3.2)** — narrows `CLAUDE.md` §I.A's "nothing else."
   *Alternative offered: keep placements in `localStorage`, costing no amendment but losing weeks of
   arrangement to any browser data clear.*
2. **Per-child PIN gating is repealed (§0.4, §2.3)** — repeals wall slice §0.3/§0.4/§4. *Alternative:
   keep the gate and answer "who" with it, at the cost of the shared board Ray asked for. The real
   consequence — any child can tick any child's chore — is stated in §2.3 rather than buried.*
3. **The wall reads activity rows (§5.1)** — repeals the read half of wall slice §5.1. *Alternative:
   school blocks that show only a course name and no progress, which is a label rather than a block.
   The write half is untouched and absolute.*

### 18.3 `docs/TDS_Slice_Wall_Display_App.md`

Gains a header note pointing at this document as its successor, and §1.2's table as the map of what
in it still applies. It is **not** deleted — most of its architecture survives, and its reasoning is
the reason this slice could be short.

### 18.4 `docs/Roadmap_Schedule_App.md` §0

A slice entry with §16's phase table.

### 18.5 No SRS module

Same call wall slice §16.4 made, for the same reason: §3–§11 specify this surface more precisely
than an SRS module would. If the wall grows past a calendar, it earns one then.

---

## 19. Open questions for Ray

Not blockers for sign-off — each has a stated default that Phase 3 or later will implement unless
Ray says otherwise.

1. **Week view start day.** Default: Monday-first.
2. **Chip duration.** Default: `expected_duration_min` where present, else 15 minutes
   (`packet.js:43`). Chores rarely carry one, so most chips will be a single 15-minute row. If
   Ray wants chores to occupy a *visible* block of time, the alternative is a per-placement
   `duration_min` set at drop time — the column already exists in §3.2's schema.
3. **Day-view scroll range.** Default: the full 24 hours, scrolled to now. The alternative is to
   render only 06:00–22:00 and put anything outside it in an "early/late" strip.
4. **Colour assignment.** Default: by roster order (alphabetical by name, which is what
   `/api/wall/children` returns). This means adding a child can re-colour the others. The
   alternative is a colour picked per child in Settings and stored locally.

---

*Companion documents: `TDS_Slice_Wall_Display_App.md` (the app this rewrites),
`TDS_Slice_Online_Revamp.md` (controlling), `TDS_Slice_Shared_Chores.md`, `CLAUDE.md`.*
