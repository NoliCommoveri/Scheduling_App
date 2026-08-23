# TDS Slice — Placement Scopes: standing, weekday, occurrence

**Status:** DESIGN ONLY — authorized by Ray in-session 2026-08-23, no code written.
**Supersedes:** `TDS_Slice_Wall_Calendar_Redesign.md` §3.3 (start times are standing only),
§5.4's "no per-day override for a block's span in v1", and §17.1 (per-day start overrides deferred).
**Extends:** that slice's §3.5.1 duration chain, §5.5 school-block tables, §12 route table.
**App scope:** `wall-app/` and the Worker. No Child App or Management App change of any kind.

---

## 0. Why this exists

Two complaints, one shape.

**0.1 — School blocks appear on Saturdays.** Reported by Ray, 2026-08-23. A block renders on every
date the day view is pointed at, weekends included, with its member courses listed underneath.
The cause is not a bug in a filter; it is the absence of one. `wall_school_blocks` carries no date
and no weekday (`migrations/0011`), `handleWallSchoolBlocksGet` returns every row household-wide
(`management-app/worker/index.js:1802`), and `day-ui.js:316`'s `blocksForChild()` filters on
`child_id` alone. A block is a *standing* placement (§3.3), and the design never asked what a
standing placement means on a day with no school.

**0.2 — Friday is not Tuesday.** Ray, same session: *"Fridays we do things earlier to finish before
sunset."* The household's week is not seven identical days. School sits at one time Monday to
Thursday and earlier on Friday; chores do the same. §3.3 made every placement standing and §17.1
put per-day start times on the shelf with an explicit condition attached — *"Revisit if he finds
himself fighting the carry-forward on times as well."* That condition is now met.

**0.3 — And sometimes it is just today.** Ray, same session: both subjects *"would benefit from a
'only this occurrence' ability."* Duration already has this for chores (§3.5.2's **Just this one**,
writing `wall_slot_days`); start time does not, and school blocks have neither.

These are one feature. A placement needs **three scopes**, and both kinds of placeable thing —
a chore and a school block — need all three.

```
[DECISION] One placement mechanism, three scopes, both subjects
Decided: every placement fact (a start time, a duration, a block's span)
  resolves through the same three-level chain, most specific first:
    1. THIS OCCURRENCE  — keyed by date
    2. THIS WEEKDAY     — keyed by day-of-week
    3. STANDING         — keyed by nothing; today's behaviour
  Chores and school blocks each get all three levels, in their own tables.
Rationale: §3.3 rejected per-day placement on a cost argument — "a date-keyed
  second table, a UI that asks 'this day or every day?' on every drag, and a
  rule for what happens when the standing time later changes — three costs
  for a case Ray has not asked for." Ray has now asked for it, and two of
  the three costs are already paid: `wall_slot_days` exists and is
  date-keyed (§3.5.2), and §3.5.2's two-button fork is the UI precedent.
  The third cost — what happens when the standing time changes — is
  answered by the chain itself: the more specific level keeps winning, and
  §7.2's write rule keeps a drag from silently destroying it.
Rationale: building it for chores only, or for blocks only, would leave the
  wall with two different answers to "when does this happen" — and the day
  view draws both on the same grid, a chore chip indented inside a block
  frame (§20's Phase 6 entry, item 5). One chain, read two ways.
Consequence: §3.5.1's duration chain grows from four rows to five.
Consequence: for a SCHOOL BLOCK, the weekday level also decides EXISTENCE,
  not just time — see §2.2. That is the one place the two subjects differ,
  and it is what fixes §0.1.
Locked for: this slice.
```

---

## 1. What does not change

Stated first, because this slice adds two tables to a table set `CLAUDE.md` §2.4 already had to
amend the guardrails for, and the boundary is the thing worth being boring about.

- **No `assignments` column is touched.** The wall's writes there remain exactly
  `ASSIGNMENT_COMPLETION_FIELDS`. Not `expected_duration_min`, which stays parent-owned (§0 of
  `CLAUDE.md`, §3.5.1's row 3 of the chain) — every new table here is an **override the wall owns**,
  resolved at render time, exactly as `wall_slots.duration_min` already is.
- **No new credential class.** These are `/api/wall/*` routes on the existing wall token.
- **No new §III.E exception.** The new tables are wall-owned in the same sense
  `wall_slots`/`wall_school_blocks` already are: written only by the wall, read only by the wall,
  carrying no child-owned or parent-owned assignment data. They sit outside the child-scoping scheme
  entirely, and writing them is never a substitute for writing a column the wall does not own.
- **No activity row is written, ever.** §18.2's third narrowing is untouched.
- **The Child App and the Management App are unaffected.** Neither reads `wall_*` tables. Pacing
  continues to use the parent's estimate, untouched. The wall's opinion about when Friday starts
  does not leak into next term's schedule.
- **Online-required, no outbox** (§6.4 of the wall display slice) applies to every new write here,
  same as every other wall write.

---

## 2. The model

### 2.1 Chores: three levels of *when*, three of *how long*

A chore's existence on a date is decided by the assignment row, as it always has been —
`ChoresCore.choresForChild(state.rows, child.id, date, state.today)`. The placement tables only ever
answer **when** and **how long**. Nothing here can make a chore that was assigned stop existing, or
make one that was not assigned appear.

**Start time**, resolved per chip per rendered date (weekday `W` = that date's local day-of-week):

| # | Source | Meaning |
|---|---|---|
| 1 | `wall_slot_days.start_min` for this subject **and this date**, non-NULL | "just this one" |
| 2 | `wall_slot_weekdays.start_min` for this subject **and weekday W**, non-NULL | "every Friday" |
| 3 | `wall_slots.start_min` | the standing placement (§3.3) |
| 4 | *(none of the above)* | unplaced — the chore is in the tray (§3.4) |

**Duration** — §3.5.1's existing chain, with one row inserted at position 2:

| # | Source | Meaning |
|---|---|---|
| 1 | `wall_slot_days.duration_min` | "just this one" (§3.5.2, built) |
| 2 | `wall_slot_weekdays.duration_min` | **NEW** — "every Friday" |
| 3 | `wall_slots.duration_min` | the standing wall override |
| 4 | `assignments.expected_duration_min` | what the parent authored (§3.5) |
| 5 | 15 minutes | `packet.js:43`'s own fallback |

**The two chains resolve independently, column by column.** A Friday row may carry a `start_min` and
leave `duration_min` NULL, in which case Friday's start comes from row 2 and Friday's duration from
row 3 or 4. This is deliberate and it is how the built duration chain already behaves: a start time
and a length are separate facts about a chore, and the family that moves Friday earlier is not
thereby saying Friday's dishes take a different amount of time.

### 2.2 School blocks: the weekday list *is* the schedule

A block has no assignment row underneath it. Nothing else can tell it which days it happens on, so
the weekday level carries that fact too.

```
[DECISION] A block renders only on weekdays it has a row for
Decided: `wall_school_block_weekdays` presence — not a flag, not a bitmask, not
  a default — determines whether a block appears on a given date at all. No
  row for Saturday, no block on Saturday.
Rationale: it makes the schedule one thing rather than two. The alternative
  considered was "occurs every day, with an exclusion list", which needs a
  second concept (an anti-row) to express the common case (a five-day
  school week) and reads backwards in the sheet: seven checkboxes where
  checked means "not".
Rationale: it also makes §0.1's bug disappear as a consequence of the feature
  rather than as a separate patch. There is no code path left that draws a
  block on a day it was not scheduled for, because there is no such thing as
  a block without a weekday list.
Consequence: EXISTING BLOCKS MUST BE BACKFILLED, or they vanish on the
  migration. See §3.3 — Ray chose Mon-Fri, 2026-08-23.
Consequence: a block with an EMPTY weekday list renders nowhere. That is a
  reachable state (uncheck all seven) and it is not an error — but the sheet
  says so plainly rather than letting a block quietly disappear (§6.2).
Consequence: this is the one asymmetry between the two subjects. A chore's
  weekday row cannot suppress the chore, because the assignment row already
  decided it exists. Stated in both directions in §2.1 and here, because a
  reader who learns one half and assumes the other will be wrong.
Locked for: this slice.
```

**Span**, resolved per block per rendered date:

| # | Source | Meaning |
|---|---|---|
| 0 | no `wall_school_block_weekdays` row for weekday W | **the block does not render at all** |
| 1 | `wall_school_block_dates` for this block **and this date**, span set | "just this one" |
| 2 | `wall_school_block_weekdays` for weekday W, span set | "every Friday" |
| 3 | `wall_school_blocks.start_min` / `end_min` | the block's default span (§5.4) |

```
[DECISION] A block's span resolves as a PAIR, not column by column
Decided: at every level, `start_min` and `end_min` are both set or both NULL.
  The Worker rejects a body that supplies one without the other, and the
  resolver takes the whole span from the first level that has one.
Rationale: the two columns are not independent facts the way a chore's start
  and duration are — they are two ends of one span, and mixing levels can
  produce `end_min <= start_min`, which every consumer of a block (the grid's
  absolute positioning, §4.4's block bucketing, the early/late strips) treats
  as impossible. Resolving as a pair makes that unrepresentable rather than
  merely validated-against.
Consequence: "Friday school ends at the same time but starts earlier" is
  expressed by writing both numbers on the Friday row, not by writing one.
  The sheet pre-fills both from the level below, so this costs nothing to
  author.
Locked for: this slice.
```

### 2.3 Weekday numbering, and the timezone trap

`weekday` is **0 = Sunday … 6 = Saturday**, matching §6's Sunday-first week and the month grid's
column order, so the number in the table and the column on screen are the same number.

**The date → weekday conversion must be local, and it is the one place this slice can silently
produce a wrong answer.** `new Date("2026-08-23")` parses as **UTC midnight**, which in every
timezone west of Greenwich is the previous day — so `.getDay()` on it returns Saturday for a Sunday
in Ray's timezone, and every weekday override lands one day off for exactly the users who never see
it fail in a test run in UTC. The conversion is:

```js
// time-core.js — parse the components, never the string.
function weekdayOf(date) {            // date: "YYYY-MM-DD"
  var p = date.split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]).getDay();   // local midnight, 0=Sun
}
```

This lives in `time-core.js` (pure, already the wall's date/time formatting layer) and is used by
both `slots-core.js` and `school-core.js`. **The Worker never computes a weekday** — it stores and
returns what the client sends, so there is no second implementation to disagree with this one, and
no server-side timezone to be wrong about. A test asserting `weekdayOf("2026-08-23") === 0` under
`TZ=America/Chicago` is a required check (§8).

---

## 3. Schema

Three new tables, one new column, one backfill. Forward-only, browser-applied (`CLAUDE.md` §III.D),
registered in `management-app/worker/migrations.js` in the same commit that adds them.

### 3.1 `migrations/0015_wall_slot_weekdays.sql`

```sql
-- Placement Scopes §2.1 — the weekday level of the placement chain, for
-- chores. Same key as wall_slots (migrations/0010) plus a weekday, exactly as
-- wall_slot_days is that key plus a date. Three tables, one chain: date beats
-- weekday beats standing.
--
-- Both override columns are nullable and independent (§2.1): a Friday row may
-- move the chore without changing how long it takes. A row with BOTH columns
-- NULL is meaningless and the Worker deletes the row rather than writing one.
--
-- `weekday`: 0 = Sunday .. 6 = Saturday, matching §6's Sunday-first week.
-- Computed CLIENT-side from the rendered date in local time (§2.3) — the
-- Worker stores what it is given and never derives a weekday itself.
--
-- Written only by the wall, read only by the wall. Touches no `assignments`
-- column; the wall's writes there remain exactly ASSIGNMENT_COMPLETION_FIELDS.
CREATE TABLE IF NOT EXISTS wall_slot_weekdays (
  child_id      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,          -- 'chore' (SLOT_SUBJECT_KINDS)
  subject_key   TEXT    NOT NULL,
  instance_key  TEXT    NOT NULL DEFAULT '',
  weekday       INTEGER NOT NULL,          -- 0=Sun .. 6=Sat
  start_min     INTEGER,                   -- NULL = fall through to wall_slots
  duration_min  INTEGER,                   -- NULL = fall through (§2.1 row 3)
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,          -- 'wall:<deviceId>'
  PRIMARY KEY (child_id, subject_kind, subject_key, instance_key, weekday)
);
```

### 3.2 `migrations/0016_wall_slot_days_start.sql`

```sql
-- Placement Scopes §2.1 — the occurrence level gains a start time. This is
-- exactly the column TDS_Slice_Wall_Calendar_Redesign.md §17.1 sketched and
-- deferred ("one nullable start_min column and one more button"), built now
-- that Ray is fighting the carry-forward on times (§0.2/§0.3).
--
-- wall_slot_days already carries duration_min and is already keyed by date;
-- this adds the second overridable column beside it. A row with both NULL is
-- meaningless — the Worker deletes rather than writing one — which is the
-- same rule migrations/0010 states for duration_min alone.
--
-- 0011 is not edited (CLAUDE.md §III.D, §II.4): a new file, forward-only.
ALTER TABLE wall_slot_days ADD COLUMN start_min INTEGER;
```

### 3.3 `migrations/0017_wall_school_block_scopes.sql`

```sql
-- Placement Scopes §2.2 — a school block's weekday schedule and its per-date
-- override. Mirrors the chore side's three levels with a block's own key
-- (block_id, not the four-part slot key) for the reason §5.5 gives for the
-- tables it already has: a block's shape does not fit wall_slots' singleton.
--
-- The WEEKDAY table carries existence as well as time (§2.2): a block renders
-- on a date only if a row exists for that date's weekday. start_min/end_min
-- are both-or-neither at every level (§2.2's pair decision) — the Worker
-- rejects one without the other.
CREATE TABLE IF NOT EXISTS wall_school_block_weekdays (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  weekday       INTEGER NOT NULL,          -- 0=Sun .. 6=Sat
  start_min     INTEGER,                   -- NULL (with end_min) = the block's own span
  end_min       INTEGER,
  PRIMARY KEY (block_id, weekday)
);

CREATE TABLE IF NOT EXISTS wall_school_block_dates (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  date          TEXT    NOT NULL,          -- YYYY-MM-DD
  start_min     INTEGER,
  end_min       INTEGER,
  PRIMARY KEY (block_id, date)
);

-- BACKFILL (§2.2's consequence, and the whole reason this file is not just
-- two CREATEs). Every block that exists today renders on every day of the
-- week; after this migration a block renders only where it has a weekday row.
-- Without this INSERT, applying the migration makes every existing block
-- disappear from every day.
--
-- Mon-Fri (1..5), chosen by Ray in-session 2026-08-23. Saturday is the
-- family's Sabbath (§6) and Sunday is left off pending his per-block choice —
-- both are one checkbox away in the block sheet (§6.2).
--
-- NULL span on each row = inherit the block's own start_min/end_min, so
-- nothing MOVES here. The only behaviour change on apply is that weekend
-- blocks stop rendering, which is §0.1's reported bug.
INSERT INTO wall_school_block_weekdays (block_id, weekday, start_min, end_min)
SELECT b.id, d.weekday, NULL, NULL
  FROM wall_school_blocks b
  JOIN (SELECT 1 AS weekday UNION ALL SELECT 2 UNION ALL SELECT 3
        UNION ALL SELECT 4 UNION ALL SELECT 5) d
 WHERE NOT EXISTS (
   SELECT 1 FROM wall_school_block_weekdays w
    WHERE w.block_id = b.id AND w.weekday = d.weekday
 );
```

**Chores need no backfill.** Absence of a weekday row and absence of a date row both mean "fall
through to the standing placement", which is today's behaviour exactly. Applying 0015 and 0016
changes nothing a family can see until they use the new controls.

### 3.4 Deleting a subject cleans up all three levels

`handleWallSlotDelete` already deletes from `wall_slots` **and** `wall_slot_days` in one handler; it
gains `wall_slot_weekdays`. `handleWallSchoolBlockDelete` gains `wall_school_block_weekdays` and
`wall_school_block_dates` alongside the `wall_school_block_courses` cleanup it already does.
Orphaned override rows keyed to a subject that no longer exists are invisible, un-clearable from any
UI, and would silently re-apply if the same `source_id` were ever placed again.

---

## 4. Worker API

### 4.1 The full-row PUT contract

```
[DECISION] A PUT to an override row states that row IN FULL
Decided: `PUT /api/wall/slots/weekday` (and the day and block equivalents)
  replaces every overridable column on the row with exactly what the body
  supplies. A field the body omits is written NULL — cleared, not left alone.
  A PUT whose fields are ALL null is a 400; DELETE is how a row goes away.
Rationale: the alternative — patch semantics, where an absent field means
  "leave whatever was there" — makes "clear just the start override, keep the
  duration one" unexpressible without a third verb or a sentinel, and makes
  every write's outcome depend on a row state the client has to have fetched
  first. Full-row PUT is idempotent, has one meaning, and the client always
  has the row: it just rendered from it.
Consequence: the day view must send both fields on every override write. It
  resolves the chain to render anyway, so it already holds both numbers.
Locked for: this slice.
```

### 4.2 Routes

Six new, two widened. **No new route pattern beyond `/api/wall/*`**, and every one of them 401s on a
device token exactly as the existing wall routes do (§III.E's fourth bound).

| Route | Method | Body / query | Notes |
|---|---|---|---|
| `/api/wall/slots` | GET | `?from=&to=` | **Widened**: response gains a third array, `slotWeekdays`. Unbounded by the window, like `slots` — a weekday row carries no date. |
| `/api/wall/slots/weekday` | PUT | `{childId, subjectKind, subjectKey, instanceKey?, weekday, startMin, durationMin}` | **NEW.** Both override fields required by §4.1; either may be `null`, not both. |
| `/api/wall/slots/weekday` | DELETE | `{childId, subjectKind, subjectKey, instanceKey?, weekday}` | **NEW.** Clears the weekday level; the chip falls to the standing row. |
| `/api/wall/slots/day` | PUT | `{…, date, startMin, durationMin}` | **Widened**: `startMin` joins `durationMin`. Today `durationMin` is required non-null; under §4.1 it becomes "both present, not both null". |
| `/api/wall/school-blocks` | GET | — | **Widened**: response gains `blockWeekdays` and `blockDates` beside `blocks` and `blockCourses`. |
| `/api/wall/school-blocks/:id/weekdays` | PUT | `{weekday, startMin, endMin}` | **NEW.** Creates or updates the weekday row — **this is what schedules the block on that day.** Span both-or-neither (§2.2). |
| `/api/wall/school-blocks/:id/weekdays` | DELETE | `{weekday}` | **NEW.** Unschedules that weekday. The block stops rendering there. |
| `/api/wall/school-blocks/:id/dates` | PUT | `{date, startMin, endMin}` | **NEW.** "Just this one" for a block's span. Span both-or-neither. |
| `/api/wall/school-blocks/:id/dates` | DELETE | `{date}` | **NEW.** Clears the occurrence override. |

`GET /api/wall/school-blocks` stays unwindowed for the reason its comment already gives — blocks
carry no date — but `blockDates` **does** carry one, and is returned in full rather than filtered
to the poll's 14-day window. Per-date span overrides are rare by construction (they are the
"just today" escape hatch), and `MAX_QUERY_ROWS` already caps the response. If that ever stops being
true, windowing `blockDates` alone is a one-line change and does not alter the resolver.

### 4.3 Validation (`worker/validation.js`)

- `isValidWeekday(v)` — `Number.isInteger(v) && v >= 0 && v <= 6`.
- `isValidStartMin` — reused unchanged, and now accepts `null` at the override levels (the existing
  helper rejects null; the routes check `value === null || isValidStartMin(value)`, matching how
  `isValidSlotDuration` already handles a nullable override).
- `isValidBlockSpan(startMin, endMin)` — both null, or both valid `startMin`s with
  `endMin > startMin`. This is the pair rule from §2.2 in one function, called by both block routes.
- The existing `parseSlotKey` / `resolveSlotChildId` are reused verbatim by the weekday routes —
  including the `claim`-chore household sentinel and the active-child check (§III.E bound 1).

---

## 5. The pure layer

### 5.1 `slots-core.js` — the chain becomes real

`resolveChip(slotsIndex, daysIndex, row, date)` gains a weekdays index and a resolved weekday:

```js
resolveChip(slotsIndex, weekdaysIndex, daysIndex, row, date)
  -> { startMin, durationMin, overridden, scope }
```

New: `indexWeekdays()` (keyed like `indexDays`, with the weekday appended instead of the date),
`weekdayOverrideFor()`, and `resolveStartMin(slot, weekdayOverride, dayOverride)` implementing
§2.1's four rows. `resolveDurationMin` gains the weekday row at position 2.

**`scope` is new and load-bearing for the UI**: `'day' | 'weekday' | 'standing' | null` — which level
supplied the start time actually being rendered. §7.2's write rule and §6.1's sheet both read it, so
the question "which level am I looking at?" is answered once, in the pure layer, with tests.

`isOverridden` (the italic-with-a-dot marker, §3.5.1) becomes true when *any* of the three levels
carries a duration override, unchanged in spirit.

### 5.2 `school-core.js` — placement joins the rollups

The file gains a placement section beside its existing completion rollups, with a comment saying so:

```js
blockOccursOn(weekdaysIndex, blockId, weekday)      -> boolean     // §2.2 row 0
resolveBlockSpan(block, weekdayRow, dateRow)        -> { startMin, endMin, scope }
scheduledWeekdays(weekdaysIndex, blockId)           -> [0..6]      // the sheet's checklist
```

`day-ui.js`'s `blocksForChild()` — the function §0.1 identified — becomes
`blocksForChildOn(state, childId, date)`, filtering by `child_id` **and** `blockOccursOn`. All three
call sites (`day-ui.js:1642`, `:1683`, `:1789`) change together.

### 5.3 The member-course fix rides along

Independent of the scopes work, and a spec violation today: `schoolBlockChipHtml` renders an `<li>`
for every member course including those with `total === 0`, while §5.2 says a course whose
activities are absent *"simply disappears from that block's row list on the next render"* and §5.3
says such a member *"has nothing to show that date."* `memberRollups` already returns
`checked: null` for exactly this case, so the fix is to drop null-checked rollups at the render
boundary — and a block whose members all have nothing that day then correctly reads as the empty
"No courses yet" shell rather than a phantom course list.

Kept in this slice rather than shipped separately because §2.2 changes which days a block renders on
at all, and the two want testing together: a scheduled school day with nothing assigned is now the
case that produces the empty shell, and it should look deliberate.

---

## 6. UI

### 6.1 The chore sheet: one more stepper, three scope buttons

§3.5.2's long-press sheet is the natural home — it already exists, already forks by scope, and
already carries the "Use the assigned time (N)" reset. It grows from a duration editor into a
placement editor:

```
┌─ Adjust ────────────────────────────────┐
│  Dishes                                 │
│                                         │
│  Starts    −   4:00 PM   +              │   ← NEW
│  Takes     −    30 min   +              │   ← the built stepper
│                                         │
│  Use the assigned time (15 min)         │   ← unchanged, when overridden
│                                         │
│  [ Only today ] [ Every Friday ] [ Every day ]   ← replaces the two-button fork
│  [ Cancel ]                             │
└─────────────────────────────────────────┘
```

The three buttons write levels 1, 2 and 3 respectively. **"Every Friday" names the rendered date's
own weekday** — standing at the tablet on a Friday, the button says Friday. **The button for the
level currently in force is marked**, and tapping a *different* one moves the override down or up
the chain: it writes the new level and deletes the one it came from, so a chore never ends up with
two overrides saying different things and the more specific one silently winning forever.

"This and future" is gone as a label — it was always "standing", and with three scopes on screen the
old wording would be the only one of the three that describes time rather than recurrence.

### 6.2 The block sheet: a week, not an end time

§5.4's long-press sheet (end time + label) becomes the block's schedule:

```
┌─ School block ──────────────────────────┐
│  Label   [ Morning School            ]  │
│  Default  9:00 AM – 11:30 AM            │   ← wall_school_blocks
│                                         │
│  Sun  ○                                 │
│  Mon  ●   9:00 – 11:30                  │   ← "default" until tapped
│  Tue  ●   9:00 – 11:30                  │
│  Wed  ●   9:00 – 11:30                  │
│  Thu  ●   9:00 – 11:30                  │
│  Fri  ●   8:00 – 10:30    (changed)     │   ← its own weekday row
│  Sat  ○                                 │
│                                         │
│  Just today: 10:00 – 12:30   [ Clear ]  │   ← only when a date row exists
│  [ Remove block ]           [ Done ]    │
└─────────────────────────────────────────┘
```

A toggle writes or deletes the weekday row; tapping a scheduled day's time opens the same
15-minute stepper the duration sheet uses, pre-filled from the level below so both ends of the span
are always written together (§2.2). **A block with no days checked shows an inline warning in the
sheet** — *"Not scheduled on any day — this block won't appear."* — because that state is reachable
and otherwise invisible the moment the sheet closes.

### 6.3 Where the "+ School" default comes from

`createSchoolBlock` (`day-ui.js:953`) mints the block and must now also mint its weekday rows.
**A new block is scheduled Mon–Fri**, matching §3.3's backfill, so the two paths agree and a family
never meets a freshly-created block that renders nowhere. It is created scheduled on the day you are
standing on even if that day is a weekend — creating a block on Saturday and having it vanish would
be indistinguishable from a crash.

---

## 7. The gesture problem

§3.3 named this as one of the three costs of per-day placement: *"a UI that asks 'this day or every
day?' on every drag."* That cost is real and this slice does not pay it.

### 7.1 A drag writes the level that is already winning

```
[DECISION] A drag writes at the scope currently in force for that day
Decided: dragging a chip writes the level `resolveChip().scope` reports —
  standing if nothing overrides it (today's behaviour, unchanged), the
  weekday row if a weekday override is what put the chip where the finger
  found it, the date row if an occurrence override did.
Rationale: the alternative rules are both worse. "Always write standing"
  means a drag on a Friday that has its own time appears to do nothing —
  the write lands on a level the Friday row is still overriding — which is
  the worst failure a direct-manipulation gesture can have. "Always ask"
  is the friction §3.3 refused, on the common path, forever, to serve the
  rare case.
Rationale: it also states one honest principle: YOU MOVE WHAT YOU SEE. The
  chip is where it is because some level put it there; the drag edits that
  level.
Consequence: a family that has never used the scope controls sees no change
  whatsoever. Every chip resolves at `scope: 'standing'`, and every drag
  writes `wall_slots.start_min`, exactly as it does today.
Locked for: this slice.
```

### 7.2 The toast is where scope becomes visible

The move toast already exists, already survives the re-render that a write kicks off, and already
carries an action button (§20's Phase 6 entry, item 1; `day-ui.js:464`'s Undo). It gains the scope,
in words, plus the two other levels as buttons:

> **Dishes moved to 4:00 PM — every day**  ·  [Only today] [Only Fridays] [Undo]

Tapping a scope button re-homes the write that just happened: it restores the level the drag wrote
to whatever it held before (the toast's own closure already holds that value — it is what Undo
restores, `day-ui.js:475`'s `wasAt`) and writes the new level instead. Two taps total for "actually,
Fridays only", on the gesture you were already making, with no dialog in the common path.

The toast's 8-second life is the one weakness: miss it, and a drag meant for Friday has changed every
day. Mitigated by §7.1 — once a Friday row exists, later drags on Fridays stay on Fridays — and by
the sheet (§6.1), which can always fix it. Recorded rather than solved.

---

## 8. Tests

`tests/wall-cores.test.js` and `tests/worker-validation.test.js` extend; the pure layers are DOM-free
and IO-free precisely so this is possible (`CLAUDE.md` §I.B).

1. **`weekdayOf` under a non-UTC TZ.** `TZ=America/Chicago node --test` — `weekdayOf("2026-08-23")`
   is `0` (Sunday), not `6`. The §2.3 trap, pinned.
2. **Start-time chain, all four rows**, including a date row that overrides a weekday row that
   overrides a standing row, and each level's `scope` value.
3. **Duration chain, all five rows** — the existing four-row assertions must still pass unchanged
   with the weekday row absent.
4. **Independence** — a weekday row with `start_min` set and `duration_min` NULL takes its duration
   from the standing row, not from the weekday row's null.
5. **`blockOccursOn`** — a block with Mon–Fri rows renders Monday, not Saturday; a block with no
   rows renders nowhere.
6. **Block span resolves as a pair** — a date row with a span beats a weekday row with a span beats
   the block's own; a weekday row with a NULL span does not contribute half of one.
7. **`isValidBlockSpan`** rejects one-of-two, rejects `end <= start`, accepts both-null.
8. **`isValidWeekday`** rejects `7`, `-1`, `"1"`, `1.5`.
9. **Route tests** (`worker-routes.test.js`): each new route 401s on a device token; the weekday
   routes reject an inactive `childId`; a PUT with both fields null is a 400; DELETE of a subject
   clears all three levels (§3.4).
10. **Member-course fix** — `memberRollups` output with a `checked: null` member does not render an
    `<li>`; this one is asserted at the core boundary (the rollup list the renderer is handed),
    since the renderer itself is not pure.

Manual acceptance (§13 of the redesign slice's own checks still apply):

11. On a Saturday, no school block renders in the day view. On Monday, it does. **This is §0.1.**
12. Move a chore on Friday, tap "Only Fridays", navigate to Thursday — Thursday is unchanged.
13. Apply the migrations on a copy of live data: no block moves, weekend blocks stop appearing,
    every weekday block keeps its time.

---

## 9. Build phasing

Over `CLAUDE.md` §V.A's 2–3 hour gate, so it is phased. **No code is written until Ray has read this
document** (his instruction, 2026-08-23: design first, code next session).

| Phase | Work | Est. |
|---|---|---|
| **1** | Migrations 0015–0017 + registry; validation helpers + their tests. Apply on an empty DB and on a copy of live data. | ~1 h |
| **2** | Worker: the six new routes, the two widened ones, §3.4's delete cleanup, route tests. | ~1.5 h |
| **3** | Pure layer: `time-core.weekdayOf`, `slots-core` chain + `scope`, `school-core` placement, `blocksForChildOn`, tests 1–8 and 10. | ~1.5 h |
| **4** | Chore UI: §6.1's sheet, §7.1's drag rule, §7.2's toast. | ~1.5 h |
| **5** | Block UI: §6.2's sheet, §6.3's creation default, §5.3's member fix. | ~1.5 h |
| **6** | `CACHE_NAME` bump, §8's manual checks on the tablet, doc reconciliation: `CLAUDE.md` §I.A/§III.E/§VII amended from "authorized, unbuilt" to shipped, redesign slice §3.3/§5.4/§17.1 pointers, this file's status line. | ~1 h |

**~8 hours.** Phases 1–3 are shippable on their own — they change no behaviour, since nothing writes
the new tables until Phase 4 — so the natural break is after Phase 3.

---

## 10. Guardrail amendments this requires

Recorded here so the next session does not have to re-derive them. Following the precedent
`CLAUDE.md` §I.A set for the Grading Assistant's §12 (*"the Data Flow cell names shipped routes and
stays accurate until the phases land; the session that builds them updates all of them in the same
commit"*), the route lists are **not** rewritten today — only the authorization is recorded.

- **§I.A Data Flow, Wall column** — gains `PUT/DELETE /api/wall/slots/weekday`,
  `PUT/DELETE /api/wall/school-blocks/:id/weekdays`, `PUT/DELETE /api/wall/school-blocks/:id/dates`.
  **At Phase 6, not now.**
- **§I.A wall-owned tables** — the list of four becomes seven: `wall_slot_weekdays`,
  `wall_school_block_weekdays`, `wall_school_block_dates`.
- **§III.E, "the wall's own tables" bullet** — same three names. No new bound, no fifth exception:
  these carry no child-owned or parent-owned assignment data, and the `assignments` writes stay
  exactly `ASSIGNMENT_COMPLETION_FIELDS`.
- **§IV.B "Wall App placement write added"** — the check gains the weekday and date levels.
- **§VII** — a "Placement scopes" row, and `TDS_Slice_Wall_Calendar_Redesign.md` §17.1 moves from
  deferred to built.

**This is the same class of widening §2.4 already recorded, not a new kind of departure**: more
wall-owned tables, outside the child-scoping scheme, widening nothing on `assignments`. It is
recorded as such rather than re-litigated as a fresh narrowing.

---

## 11. Open items — flagged for Ray, not settled

Per `CLAUDE.md` §VI.C. None of these blocks Phase 1.

**11.1 Is Sunday a school day?** The backfill is Mon–Fri (Ray, 2026-08-23), but §6 of the redesign
slice says Sunday-first was chosen so *"the busy days [are] contiguous and [the] quiet one close[s]
the week"* — which reads as though Sunday carries something. If school happens on Sundays, the
backfill should be `0..5` rather than `1..5`. One character in `migrations/0017`, and only until it
is applied.

**11.2 "No school today" — a skip, not a move.** §2.2 gives a block a per-date *span* override but
no way to say "not today" (a field trip, a sick day). The table is the right home for it — a
`skipped INTEGER NOT NULL DEFAULT 0` on `wall_school_block_dates`, one more button in §6.2's sheet —
but Ray asked for time overrides, and a skip is a different feature wearing the same table (the
argument §17.1 made about start times on `wall_slot_days`, which is now the argument for asking
rather than assuming). **Not built. Worth ~20 minutes if wanted.**

**11.3 Should a chore's weekday row be able to unplace it?** §2.1 says the weekday level answers
only *when*, never *whether* — a chore exists because it was assigned. But "on Fridays this one goes
back in the tray" is expressible in the same table (a weekday row meaning "unplaced" rather than
"unset"), and a family that finishes early on Friday might want exactly that. It needs a third state
per column, not just a nullable one, so it is genuinely more than a checkbox. **Not built.**

**11.4 Does a weekday override survive the standing time changing?** As designed, yes — the more
specific level keeps winning, silently. §6.1's sheet marks which level is in force, so it is
discoverable from the chip; but a family that moves the standing time and does not notice Friday
staying put has a confusing five minutes. The alternative (clear all weekday rows when the standing
time changes) is worse — it throws away deliberate work — so this is recorded as accepted rather
than solved.

**11.5 Week and month views do not show placements at all.** §6's week view shows Chores/School
tokens per day and the month grid shows events only, so neither can display a weekday-specific time
and neither needs to change. Noted so the next session does not go looking.

---

## 12. Revision log

| Date | Change |
|---|---|
| 2026-08-23 | Written. Prompted by Ray reporting school blocks on weekends (§0.1), then asking for per-weekday times on blocks and chores alike (§0.2) and a "only this occurrence" scope for both (§0.3). Answers captured in-session: existing blocks backfill to **Mon–Fri**; per-day times are **overrides on a default span**, not seven independent spans; **design first, code next session**. Supersedes redesign slice §3.3, §5.4's no-per-day-span note, and §17.1. |
