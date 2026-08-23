# TDS Slice — Placement Scopes: standing, weekday, occurrence

**Status:** **PHASE 1 BUILT** 2026-08-23 (migrations 0015–0018, validation helpers, tests).
Phases 2–6 unbuilt. Nothing in Phase 1 changes behaviour — see §9. `CLAUDE.md` still records this
slice as "authorized, unbuilt" and stays that way until Phase 6 (§10).
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

**0.4 — And sometimes the week's rule is simply wrong for one day.** Ray, on Sunday: *"it's a backup
school day but not regularly scheduled."* On a skip: *"yes a skip would be awesome."* A weekly
schedule with no per-date exception cannot express either — it can only be edited, which means
changing next week to fix this week and remembering to change it back.

These are one feature. A placement needs **three scopes**, and both kinds of placeable thing —
a chore and a school block — need all three. For a school block the most specific scope carries
**existence** as well as time (§2.2.1), which is what makes §0.4's two cases one column.

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

**Row 3 is a gate, not just the last resort** (added Phase 2, from §11.6's and §11.7's answers). A
chore is placed **if and only if** a `wall_slots` row exists for it. Rows 1 and 2 are overrides
*on* a placement; neither can create one. A `wall_slot_weekdays` row with a `start_min` and no
standing row under it resolves to **unplaced**, not to "on the grid on Fridays only".

This is not a rule invented for §11.6 — it is the shipped behaviour of the level that already
exists, stated. `resolveChip` reads `startMin` from the standing row alone, so a `wall_slot_days`
row with no placement above it is inert today. The weekday level inherits that, which is what makes
un-placing a chore safe to keep standing-scoped (§3.4) and what answers §11.7 in the negative.

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

**Independence has one cost, and it is a shipped invariant.** `handleWallSlotPut` rejects
`startMin + durationMin > 1440` — a placement may not run past midnight — and it can enforce that
because today one row carries both numbers. Once the two chains resolve independently, no single
write sees the pair: a weekday row moving the dishes to 11:45 PM validates fine against its own
`durationMin: null`, and the standing row's 60-minute duration then composes a chip that ends at
00:45. The check cannot be dropped (it is what keeps a chip inside the grid it is absolutely
positioned in) and it cannot be enforced per-write (the other half lives in another row).

```
[DECISION] The past-midnight rule is a resolver rule, enforced at render
Decided: each override route keeps validating what its OWN row carries
  (`isValidStartMin`, `isValidSlotDuration`), and drops the cross-column
  check. `resolveChip` clamps instead: `durationMin = min(durationMin,
  1440 - startMin)`, returning the clamped value and a `clamped: true` flag.
  `handleWallSlotPut` keeps its existing check unchanged, because a standing
  row does carry both numbers and rejecting the pair there is free.
Rationale: the alternative is a read-modify-write on every override PUT — the
  Worker fetching the other levels to compose the resolved pair before
  accepting one number — which makes a placement write depend on rows the
  client did not send, exactly the coupling §4.1's full-row contract exists
  to avoid, and still cannot stop a LATER write to a different level from
  composing the same overrun.
Rationale: clamping degrades honestly. A chore that would run past midnight
  ends at midnight, which is what the grid can draw, rather than 400-ing a
  drag the family made for a good reason.
Consequence: `resolveChip` is the only place the 1440 bound is applied to a
  composed pair, so it is the only place to test it (§8, test 4a).
Locked for: this slice.
```

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
Consequence: the weekday list is the RULE, and a rule needs an exception for
  one date in both directions — see §2.2.1. A weekday list alone cannot
  express "no school today, we're out" or "not normally Sundays, but this
  Sunday yes."
Locked for: this slice.
```

#### 2.2.1 The date row decides that date, in both directions

Ray, 2026-08-23, on whether Sunday should be in the backfill: *"it's a backup school day but not
regularly scheduled."* And, on a skip: *"yes a skip would be awesome."*

Those are the same feature. A backup day is a skip run backwards — one date that disagrees with the
weekday rule — and building them as two mechanisms (an exclusion flag here, an ad-hoc addition
there) would give the wall two ways to answer one question.

```
[DECISION] A date row states the outcome for that date, overriding the weekday rule entirely
Decided: `wall_school_block_dates` carries `occurs INTEGER NOT NULL DEFAULT 1`
  alongside its optional span. The weekday list decides every date that has
  no row; a date WITH a row is decided by the row:
    occurs = 1, span set    -> happens, at that span            ("just this once, later")
    occurs = 1, span NULL   -> happens, at the weekday or default span
                               ("backup Sunday" — even if Sunday has no weekday row)
    occurs = 0              -> does not happen                  ("no school today")
  no row at all             -> the weekday list decides         (the normal case)
Rationale: Ray's two answers arrived as separate requests and are one
  mechanism. Modelling them separately costs a second column, a second
  button, and a reader who has to know which of two tables to look in to
  answer "is there school on the 14th."
Rationale: it also makes the Sunday question stop mattering. Sunday stays OUT
  of the Mon-Fri backfill (§3.3) because it is not regularly scheduled — and
  a backup Sunday is then one tap on the Sunday itself, not a permanent
  schedule change that has to be undone next week.
Consequence: `occurs = 0` with a span set is meaningless and the Worker
  rejects it (§4.3). A skipped day has no time.
Consequence: an `occurs = 1` row on an unscheduled weekday is the ONLY way a
  block appears on a day its weekday list excludes. §2.2's row-0 rule is
  otherwise absolute, so there is exactly one door and it is this one.
Consequence: this does NOT apply to chores. A chore exists on a date because
  it was assigned; the wall cannot conjure one for a Sunday or suppress one
  on a Friday, and §2.1's tables stay time-only. See §11.3 for the one
  half of this a chore might still want.
Locked for: this slice.
```

**Span**, resolved per block per rendered date:

**Does it happen at all?**

| # | Source | Outcome |
|---|---|---|
| 0 | `wall_school_block_dates` row for this date | **the row decides** — `occurs = 1` yes, `occurs = 0` no (§2.2.1) |
| 1 | no date row, `wall_school_block_weekdays` row for weekday W exists | yes |
| 2 | no date row, no weekday row | **no — the block does not render** |

**And if it happens, at what span?**

| # | Source | Meaning |
|---|---|---|
| 1 | `wall_school_block_dates` for this date, span set | "just this one" |
| 2 | `wall_school_block_weekdays` for weekday W, span set | "every Friday" |
| 3 | `wall_school_blocks.start_min` / `end_min` | the block's default span (§5.4) |

Row 2 is skipped when the date is a backup day — there is no weekday row to read — so a backup
Sunday with no span of its own lands on the block's default span, which is the sensible reading of
"we're doing Thursday's school on Sunday."

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

**Two copies of this function already exist and must be collapsed into the new one, not joined by a
third.** `nav-ui.js:54` and `week-ui.js:52` are the same three lines, and both already get it right
(`new Date(parts[0], parts[1] - 1, parts[2]).getDay()` — local components, never the string).
`month-core.js:59` gets the same answer through its own `parseIso`. That is three places the
Sunday-first numbering is decided today, none of them tested, and this slice makes the number
load-bearing for the first time — a weekday that means "which column" is cosmetic, a weekday that
means "does school happen" is not. Phase 3 adds `TimeCore.weekdayOf` and rewrites those two call
sites to use it; `month-core.parseIso` stays as it is (it builds Date objects for date arithmetic,
not weekday numbers) but is checked against the same test.

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
-- 0010 is not edited (CLAUDE.md §III.D, §II.4): a new file, forward-only.
-- (0010 is where wall_slot_days is created; 0011 is the school blocks.)
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
--
-- NO updated_at/updated_by here, unlike wall_slots and wall_school_blocks,
-- and matching wall_school_block_courses (migrations/0011). The rule these
-- tables follow is the membership table's, not the placement table's: a row's
-- existence IS its whole content on the weekday table, and nothing in the app
-- reads either stamp — no route returns them, no view renders them, and the
-- wall has one credential per tablet so `wall:<deviceId>` distinguishes
-- almost nothing. Recorded because a reader comparing the four wall tables
-- will notice the split and should know it was chosen, not missed. §11.9
-- notes the one row class that has an argument for keeping a stamp.
CREATE TABLE IF NOT EXISTS wall_school_block_weekdays (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  weekday       INTEGER NOT NULL,          -- 0=Sun .. 6=Sat
  start_min     INTEGER,                   -- NULL (with end_min) = the block's own span
  end_min       INTEGER,
  PRIMARY KEY (block_id, weekday)
);

-- §2.2.1 — this table is the exception to the weekday rule, in BOTH
-- directions. A row here decides its date outright: occurs = 0 is "no school
-- today" (a field trip, a sick day), occurs = 1 on a weekday the block is not
-- scheduled for is a backup day (Ray, 2026-08-23: Sunday is "a backup school
-- day but not regularly scheduled"). A skipped day has no span — the Worker
-- rejects occurs = 0 with start_min/end_min set.
CREATE TABLE IF NOT EXISTS wall_school_block_dates (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  date          TEXT    NOT NULL,          -- YYYY-MM-DD
  occurs        INTEGER NOT NULL DEFAULT 1,-- 1 = happens (default), 0 = skipped
  start_min     INTEGER,                   -- NULL (with end_min) = weekday row, else the block's own
  end_min       INTEGER,
  PRIMARY KEY (block_id, date)
);
```

### 3.3a `migrations/0018_wall_school_block_weekday_backfill.sql`

**A separate file from 0017, deliberately.** The runner strips comments, splits on `;`, and hands
every statement of one migration to `env.DB.batch()` as a single transaction
(`validation.js:211`, `index.js:694`). No migration in this repo has ever put a `CREATE TABLE` and
an `INSERT` **into that same new table** in one batch — 0002 backfills a table 0001 created, 0006 /
0009 / 0014 are bare `ALTER`s — so whether D1 prepares the INSERT against a table that does not
exist until the statement before it is untested here. It probably works. "Probably" is the wrong
confidence level for a migration Ray applies from a browser button with no CLI to recover from
(`CLAUDE.md` §0, §III.D): a failed batch rolls back, 0017 is then unapplied, and the operator sees
an error with no next step. Two files cost nothing and the failure mode disappears — and if 0017
applies and 0018 fails, the recovery is to press the button again.

```sql
-- BACKFILL (§2.2's consequence). Every block that exists today renders on
-- every day of the week; after 0017 a block renders only where it has a
-- weekday row. Without this INSERT, applying 0017 makes every existing block
-- disappear from every day.
--
-- Mon-Fri (1..5), chosen by Ray in-session 2026-08-23. Saturday is the
-- family's Sabbath (§6). Sunday is left off deliberately, not pending a
-- decision: it is "a backup school day but not regularly scheduled" (Ray,
-- same session), which is a per-DATE fact, not a weekly one — §2.2.1's
-- occurs = 1 row is how a backup Sunday happens, one tap on the day itself
-- rather than a standing schedule change that has to be undone next week.
--
-- NULL span on each row = inherit the block's own start_min/end_min, so
-- nothing MOVES here. The only behaviour change on apply is that weekend
-- blocks stop rendering, which is §0.1's reported bug.
--
-- The NOT EXISTS guard is redundant on a first apply (0017 just created the
-- table empty) and is kept anyway: it makes the file idempotent, which is
-- what lets a half-applied migration pair be fixed by pressing the button
-- again rather than by a CLI nobody has.
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
through to the standing placement", which is today's behaviour exactly.

**And all four migrations are inert on apply — including 0018.** Corrected 2026-08-23 during the
Phase 1 build; the first draft of this section said 0018 "makes weekend blocks stop rendering",
which it does not. Nothing reads `wall_school_block_weekdays` until **Phase 3** rewrites
`day-ui.js:316`'s `blocksForChild()`, which filters on `child_id` alone today. §0.1's bug is fixed
in Phase 3, and 0018's job is to stop that fix from taking the weekdays with it — a block with no
weekday rows renders nowhere (§2.2), so without the backfill Phase 3 would hide *every* block, not
just the weekend ones. See §9 for what this means for the phase order.

### 3.4 Deleting a subject — and why the two sides differ

**Amended at Phase 2 by §11.6's answer.** The first draft of this section said "deleting a subject
cleans up all three levels" on both sides. That is right for a block and wrong for a chore, and the
difference is not a nicety — it is the whole of §11.6.

**Blocks: cleanup, as designed.** `handleWallSchoolBlockDelete` gains `wall_school_block_weekdays`
and `wall_school_block_dates` alongside the `wall_school_block_courses` cleanup it already does.
Deleting a block genuinely *is* the subject disappearing: nothing can reach those rows again, and a
new block gets a newly minted id, so nothing can inherit them either. Orphans here are invisible,
un-clearable garbage. The `REFERENCES` clauses in `0017` do not do this work — D1 has foreign keys
off for this database — so the explicit cleanup is the only thing keeping the rows from orphaning.

**Chores: no cleanup, because there is no subject-disappeared event.** `handleWallSlotDelete` now
deletes the `wall_slots` row and **nothing else** — it no longer sweeps `wall_slot_days`, which it
used to, and it does not gain `wall_slot_weekdays`. Two facts forced this:

1. **The route's only caller is the tray gesture** (`day-ui.js:505`, plus the same call in its own
   Undo path). There is no "the chore was deleted" caller to move the sweep to, and there cannot
   be: a chore's existence is the assignment row's fact (§1), and the wall is never told one went
   away. §11.6's proposed third shape therefore had no trigger at all on this side.
2. **The sweep had no honest undo.** Un-placing offers Undo, and Undo restores the standing row's
   start and duration only — so every per-day override the sweep destroyed was already gone for
   good, behind a button that said otherwise. That defect is shipped, pre-dating this slice;
   §3.4's first draft would have widened it from date rows to weekday rows.

What makes leaving the rows safe is §2.1's gate: an override level cannot place a chore by itself,
so orphaned rows render nothing. They are not garbage, they are dormant — re-placing the same chore
restores its Friday time, which Ray chose (2026-08-23) over a gesture that quietly destroys a
year of deliberate work. Clearing a level is its own explicit act:
`DELETE /api/wall/slots/weekday`, `DELETE /api/wall/slots/day`.

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
Consequence: the day view must send both fields on every override write —
  and each field must be THAT LEVEL'S OWN VALUE, which is `null` when the
  level does not override it. NOT the resolved number the chip is rendering
  with. The two differ constantly: a chip drawn at 30 minutes because the
  parent authored 30 has a weekday `duration_min` of NULL, and writing the
  resolved 30 into the weekday row freezes it there — the parent's later
  change to `expected_duration_min` would stop reaching Fridays, and the
  §3.5.1 override marker would light up on a chip nobody re-timed. The
  shipped standing-level write already states this rule in a comment
  (`day-ui.js:449`, `// preserved, never guessed (§3.5.1)`); the override
  levels inherit it verbatim.
Consequence: so the client holds THREE numbers per column, not two — the
  resolved value (for drawing), the target level's own override (for
  writing), and the level below's value (for pre-filling a stepper). §5.1's
  `resolveChip` returns the first; `weekdayOverrideFor`/`dayOverrideFor`
  return the second.
Locked for: this slice.
```

### 4.2 Routes

Six new, four widened. **BUILT 2026-08-23 (Phase 2).** **No new route pattern beyond
`/api/wall/*`**, and every one of them 401s on a device token — and on a `SYNC_TOKEN` — exactly as
the existing wall routes do (§III.E's fourth bound), asserted by extending the `WALL_ROUTES` table
the credential-matrix tests already iterate.

| Route | Method | Body / query | Notes |
|---|---|---|---|
| `/api/wall/slots` | GET | `?from=&to=` | **Widened**: response gains a third array, `slotWeekdays`, and a third cap flag, `slotWeekdaysTruncated` — the handler caps each array separately for the reason its own comment gives (`capRows`' single `truncated` key would collide across arrays). Unbounded by the window, like `slots` — a weekday row carries no date. |
| `/api/wall/slots/weekday` | PUT | `{childId, subjectKind, subjectKey, instanceKey?, weekday, startMin, durationMin}` | **NEW.** Both override fields required by §4.1; either may be `null`, not both. |
| `/api/wall/slots/weekday` | DELETE | `{childId, subjectKind, subjectKey, instanceKey?, weekday}` | **NEW.** Clears the weekday level; the chip falls to the standing row. |
| `/api/wall/slots/day` | PUT | `{…, date, startMin, durationMin}` | **Widened**: `startMin` joins `durationMin`. Today `durationMin` is required non-null; under §4.1 it becomes "both present, not both null". Backward-compatible with the shipped client, which sends a non-null `durationMin` and no `startMin`. |
| `/api/wall/slots` | DELETE | `{childId, subjectKind, subjectKey, instanceKey?}` | **Narrowed, not widened** (§11.6's answer, §3.4): deletes the `wall_slots` row only. It no longer sweeps `wall_slot_days`, and it does not sweep `wall_slot_weekdays`. Un-placing is standing-scoped and non-destructive; the override levels go dormant under §2.1's gate. |
| `/api/wall/school-blocks` | GET | — | **Widened**: response gains `blockWeekdays` and `blockDates` beside `blocks` and `blockCourses`, each with its own cap flag. |
| `/api/wall/school-blocks` | POST | `{…, weekdays: [1,2,3,4,5]}` | **Widened**: the body names the block's weekday schedule and the handler writes the block row and its weekday rows in ONE `env.DB.batch()`. See §6.4 — without this, creating a block is six online-required writes with no outbox behind them. Omitted or empty → the same Mon–Fri default, applied server-side. |
| `/api/wall/school-blocks/:id/weekdays` | PUT | `{weekday, startMin, endMin}` | **NEW.** Creates or updates the weekday row — **this is what schedules the block on that day.** Span both-or-neither (§2.2). |
| `/api/wall/school-blocks/:id/weekdays` | DELETE | `{weekday}` | **NEW.** Unschedules that weekday. The block stops rendering there. |
| `/api/wall/school-blocks/:id/dates` | PUT | `{date, occurs, startMin, endMin}` | **NEW.** The date-level exception (§2.2.1): a move, a skip (`occurs: 0`), or a backup day (`occurs: 1` on an unscheduled weekday). Span both-or-neither, and forbidden when `occurs` is 0. |
| `/api/wall/school-blocks/:id/dates` | DELETE | `{date}` | **NEW.** Clears the exception; the date falls back to the weekday rule. |

`GET /api/wall/school-blocks` stays unwindowed for the reason its comment already gives — blocks
carry no date — but `blockDates` **does** carry one, and is returned in full rather than filtered
to the poll's 14-day window. Date rows are rare by construction (they are the exception to the
weekly rule, one per unusual day), and `MAX_QUERY_ROWS` already caps the response. **A row is worth
keeping after its date passes** — it is the record of why last Tuesday looked odd, and the day view
can be pointed backwards — but they accumulate at maybe a few dozen a school year, which is nothing.
If that ever stops being true, windowing `blockDates` alone is a one-line change and does not alter
the resolver.

### 4.3 Validation (`worker/validation.js`)

**Built in Phase 1** (2026-08-23), so Phase 2's routes call them rather than restating the rules
inline:

- `isValidWeekday(v)` — `Number.isInteger(v) && v >= 0 && v <= 6`.
- `isValidStartMinOverride(v)` — `v === null || isValidStartMin(v)`. `isValidStartMin` itself is
  reused unchanged and still rejects null, because `wall_slots.start_min` is `NOT NULL` and its
  presence IS the placement; only the override levels may say nothing. Named rather than written
  inline at each route, matching how `isValidSlotDuration` already handles a nullable override.
- `isValidBlockSpan(startMin, endMin)` — both null, or both on the 15-minute grid with
  `endMin > startMin`. This is the pair rule from §2.2 in one function, called by both block routes.
  `endMin` may be `1440`: it is an END, and the shipped `handleWallSchoolBlockPost` already accepts
  a block that finishes at midnight (`startMin + durationMin > 1440` is what it rejects). That is
  why it is not `isValidStartMin` twice.
- `isValidOccurs(v)` — strictly `0` or `1`, not merely truthy: a JSON body carrying `"0"` or
  `false` should be a 400, not a silently coerced skip that hides a client bug.
- `isValidBlockDateException(occurs, startMin, endMin)` — the one rule here that spans columns:
  valid `occurs`, valid span, and **`occurs: 0` carrying a span is rejected** (§2.2.1 — a skipped
  day has no time). It is a named helper rather than an inline route check so the cross-field rule
  is testable at the same boundary as the ones beside it (§8, test 7a), which is also the only way
  Phase 1 could ship 7a at all: the routes are Phase 2.
- **No cross-column past-midnight check on the override routes** (§2.1's decision) — each row is
  validated for what it carries, and the composed pair is clamped in `resolveChip`.
  `handleWallSlotPut`'s existing `startMin + durationMin > 1440` check stays exactly as it is.
- The existing `parseSlotKey` / `resolveSlotChildId` are reused verbatim by the weekday routes —
  including the `claim`-chore household sentinel and the active-child check (§III.E bound 1).

---

## 5. The pure layer

### 5.1 `slots-core.js` — the chain becomes real

**BUILT 2026-08-23 (Phase 3).**

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

**BUILT 2026-08-23 (Phase 3).** One addition beyond the four functions below:
`resolvePlacement(weekdaysIndex, datesIndex, block, date, weekday)` returns
`{occurs, startMin, endMin, spanScope}` in one call. `blockOccursOn` and `resolveBlockSpan` read
the *same two rows*, and a caller that fetches them twice can be given a span from one date and an
occurrence from another if the indexes are rebuilt in between. One call, one pair of rows.

The block side's `scope` vocabulary is `'date' | 'weekday' | 'block'`, deliberately not §5.1's
`'day' | 'weekday' | 'standing'`: a block's base level is the block row itself rather than a
placement row, and §2.2.1 calls the exception level "the date row". Two tables, two vocabularies,
each named after what it actually is.

The file gains a placement section beside its existing completion rollups, with a comment saying so:

```js
blockOccursOn(weekdaysIndex, datesIndex, blockId, date, weekday)  -> boolean   // §2.2's first table
resolveBlockSpan(block, weekdayRow, dateRow)        -> { startMin, endMin, scope }
scheduledWeekdays(weekdaysIndex, blockId)           -> [0..6]      // the sheet's checklist
dateExceptionFor(datesIndex, blockId, date)         -> row | null  // §2.2.1, for the sheet's banner
```

`blockOccursOn` takes both indexes and both keys because §2.2.1 makes the date row authoritative:
the weekday list is consulted only when no date row exists. Getting that precedence backwards would
make a skip look like it worked on scheduled days and silently fail on backup days, which is the
subtle direction of the bug — hence tests 5 and 5a.

`day-ui.js`'s `blocksForChild()` — the function §0.1 identified — becomes
`blocksForChildOn(state, childId, date)`, filtering by `child_id` **and** `blockOccursOn`.

**There are FOUR call sites, not three.** Corrected 2026-08-23 during the Phase 1 build: the three
render paths (`day-ui.js:1642`, `:1683`, `:1789`) plus **`:933`, inside `nextFreeBlockStart`**,
which scans a child's other blocks for the first free 60-minute gap when `+ School` mints one. That
one is not a render path and it is easy to miss, but it should take the date-filtered set too —
otherwise a block created on a Saturday dodges the span of a block that only happens on Mondays,
and lands lower down the grid than it needed to. Harmless when it happens, invisible when it does,
and cheap to get right while the function is being renamed anyway.

### 5.3 The member-course fix rides along

**BUILT 2026-08-23 (Phase 3), not Phase 5.** §9 listed the fix under Phase 5 while listing its test
(§8, test 10) under Phase 3, and a test without its implementation is not a test. Phase 3 is the
right half: the filter lives in the pure layer as `SchoolCore.renderableRollups`, which is the only
way test 10 can assert it "at the core boundary" as §8 asks, since the renderer is not pure. It has
a second consequence §8 names and this section did not: `blockEntry` computes `collapsed` from the
renderable rollups, so a block whose only unfinished member has nothing that date now collapses,
where a phantom `checked: null` member used to hold it open.

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
level currently in force is marked**, and tapping a *different* one moves the placement down or up
the chain: it writes the new level and clears the one it came from, so a chore never ends up with
two overrides saying different things and the more specific one silently winning forever.

**"Clears the one it came from" never means deleting the `wall_slots` row.** Stated as its own
paragraph because the obvious reading of the sentence above is a chore-destroying bug:
`wall_slots.start_min` is `NOT NULL` (`migrations/0010`) and the presence of the row IS the
placement — §2.1's row 4 says a chore with no row is in the tray. So "standing → Only today" read
as *write the date row, delete the standing row* would take the chore off the grid on every other
day of the year, and the family would discover it next Tuesday.

The rule is therefore asymmetric, and the asymmetry is the same one §2.1 already draws:

| Moving | What is written | What is cleared |
|---|---|---|
| standing → weekday | the weekday row | **nothing** — the standing row stays, and stays the fallback |
| standing → occurrence | the date row | **nothing** |
| weekday → occurrence | the date row | the weekday row |
| occurrence → weekday | the weekday row | the date row |
| weekday → standing | `wall_slots` (PUT, §4.1) | the weekday row |
| occurrence → standing | `wall_slots` (PUT) | the date row |

Only levels 1 and 2 are *overrides*, and only an override can be cleared. Level 3 is the placement
itself: it is written, never deleted, and the one thing that deletes it is unplacing the chore
(§11.6).

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
│  Today, Sun 30 Aug                      │   ← §2.2.1, always shown
│   ( ) Not today                         │
│   (•) As scheduled  ·  9:00 – 11:30     │
│   ( ) Just today…   ·  10:00 – 12:30    │
│                                         │
│  [ Remove block ]           [ Done ]    │
└─────────────────────────────────────────┘
```

**The "Today" group is §2.2.1 made visible**, and it is three radio options rather than a hidden
override that only appears once it exists:

- **Not today** writes `occurs: 0`. On a day the block is scheduled, this is the skip.
- **As scheduled** deletes the date row — the weekday rule takes over again.
- **Just today…** opens the span stepper and writes `occurs: 1` with a span.

On a day the block is **not** scheduled by weekday (a Sunday), the same group reads **Not today
(selected) · Add for today · Add at a different time** — the identical three writes, worded for the
direction the family is going. This is the backup-day control, and it is on the block itself, which
is where someone looking at "Morning School" would think to find it.

A toggle writes or deletes the weekday row; tapping a scheduled day's time opens the same
15-minute stepper the duration sheet uses, pre-filled from the level below so both ends of the span
are always written together (§2.2). **A block with no days checked shows an inline warning in the
sheet** — *"Not scheduled on any day — this block won't appear."* — because that state is reachable
and otherwise invisible the moment the sheet closes.

### 6.3 Reaching a block that is not on screen

§6.2's control lives in the block's own long-press sheet — which works for a skip, since the block
is right there, but **not for a backup Sunday: the block is not drawn, so there is nothing to press.**

The tray header's existing `+ School` button (`day-ui.js:898`) grows to cover it. Today it mints a
new block unconditionally. It becomes: if that child has blocks **not scheduled on this date**, a
small sheet listing them —

```
┌─ Add school — Ellie ────────────────────┐
│  Morning School    9:00 – 11:30   [Add] │   ← occurs = 1 for this date
│  Afternoon School  1:00 – 2:00    [Add] │
│  ─────────────────────────────────────  │
│  [ New block… ]                         │   ← today's behaviour
└─────────────────────────────────────────┘
```

— and if there are none (or the child has no blocks at all), it goes straight to minting a new one,
exactly as it does now. A family that never uses backup days never sees the sheet.

**Why not a new block each Sunday instead?** Because a block carries its member courses (§5.2), and
a fresh block starts empty — so "do Thursday's school on Sunday" would mean re-checking every course
by hand, on the day, for a session that already exists. Reusing the block is the whole point.

### 6.4 Where the "+ School" default comes from

`createSchoolBlock` (`day-ui.js:953`) mints the block, which must now also have weekday rows.
**A new block is scheduled Mon–Fri**, matching §3.3a's backfill, so the two paths agree and a family
never meets a freshly-created block that renders nowhere. It is created scheduled on the day you are
standing on even if that day is a weekend — creating a block on Saturday and having it vanish would
be indistinguishable from a crash. (On a Saturday that means six rows, Mon–Fri plus Saturday; the
family that did it deliberately keeps it, and the sheet's toggles are right there.)

**The weekday rows are written by the POST, not by five follow-up PUTs.** Every wall write is
online-required with no outbox and no retry (§1, wall slice §6.4), so a client-side loop of six
writes has five places to stop halfway — and the halfway state is a block scheduled Monday and
Tuesday, which looks like a deliberate schedule rather than a failure. There is nothing to drain and
nothing to reconcile it against. So `POST /api/wall/school-blocks` takes the weekday list in its
body and writes the block row and its weekday rows in one `env.DB.batch()`, which is atomic; the
client sends one request and gets one answer. This is the only route widening in §4.2 that is not
strictly required by the model, and it is here because the alternative is a partial write the design
has no mechanism to detect.

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
4a. **The composed pair is clamped** (§2.1) — a weekday `start_min` of 1425 over a standing
   `duration_min` of 60 resolves to 15 minutes with `clamped: true`, not to a chip ending at 00:45.
   Neither write could have caught this; the resolver is the only place it exists.
4b. **An override write carries the level's own value, not the resolved one** (§4.1) — asserted at
   the boundary the day view calls: given a chip resolving its duration from
   `assignments.expected_duration_min`, the weekday PUT body's `durationMin` is `null`.
5. **`blockOccursOn`, weekday level** — a block with Mon–Fri rows renders Monday, not Saturday; a
   block with no rows renders nowhere.
5a. **`blockOccursOn`, date level beats weekday level, both ways** (§2.2.1) — an `occurs: 0` row on a
   scheduled Monday suppresses it; an `occurs: 1` row on an unscheduled Sunday renders it; and a
   backup Sunday with no span of its own takes the block's DEFAULT span, not a weekday row's
   (there isn't one to read). The precedence is the thing being pinned: a date row wins even when
   the weekday list disagrees, in whichever direction it disagrees.
6. **Block span resolves as a pair** — a date row with a span beats a weekday row with a span beats
   the block's own; a weekday row with a NULL span does not contribute half of one.
7. **`isValidBlockSpan`** rejects one-of-two, rejects `end <= start`, accepts both-null.
7a. **`occurs`** rejects `"0"`, `false`, `2`, `null`; rejects `occurs: 0` carrying a span.
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
12a. On a scheduled Monday, "Not today" — the block goes, and Tuesday still has it. On a Sunday,
    `+ School` → Add — the block appears at its default span with its member courses intact, and
    the following Sunday does not have it.
13. Apply the migrations on a copy of live data: no block moves, weekend blocks stop appearing,
    every weekday block keeps its time.

---

## 9. Build phasing

Over `CLAUDE.md` §V.A's 2–3 hour gate, so it is phased. **No code is written until Ray has read this
document** (his instruction, 2026-08-23: design first, code next session).

| Phase | Work | Est. |
|---|---|---|
| **1** | Migrations 0015–0018 + registry; validation helpers + tests 7, 7a, 8, the migration-shape tests, and `tests/migrations-apply.test.js`. Apply on an empty DB and on a copy of live data. **BUILT 2026-08-23.** | ~1 h |
| **2** | Worker: the six new routes, the **four** widened ones (§4.2), §3.4's delete cleanup, route tests. Answer §11.6 first. **BUILT 2026-08-23**, with §11.6 and §11.7 answered by Ray first. | ~2 h |
| **3** | Pure layer: `time-core.weekdayOf`, `slots-core` chain + `scope`, `school-core` placement, `blocksForChildOn`, tests 1–6 (incl. 5a) and 10. **BUILT 2026-08-23**, plus the `CACHE_NAME` bump moved here from Phase 6 and §9's predicted create-block flicker closed. | ~1.5 h |
| **4** | Chore UI: §6.1's sheet, §7.1's drag rule, §7.2's toast. | ~1.5 h |
| **5** | Block UI: §6.2's sheet including the Today group, §6.3's add-for-today sheet, §6.4's creation default, §5.3's member fix. | ~2 h |
| **6** | ~~`CACHE_NAME` bump~~ (done in Phase 3 — see below), §8's manual checks on the tablet, doc reconciliation: `CLAUDE.md` §I.A/§III.E/§VII amended from "authorized, unbuilt" to shipped, redesign slice §3.3/§5.4/§17.1 pointers, this file's status line. | ~1 h |

**~9 hours.** Corrected 2026-08-23 during the Phase 1 build — the first draft of this paragraph
got the visible phase wrong in one direction and missed a real hazard in the other.

**Phase 1 is entirely silent.** All four migrations are inert on apply, 0018 included. Nothing
reads the new tables until Phase 3 rewrites `blocksForChild()`; today it filters on `child_id`
alone. Ray can apply 0015–0018 from Settings → Database and see nothing change, which is the right
thing to tell him.

**Phase 3 is where §0.1's bug goes away — and Phase 3 must not ship without Phase 2.** Once the day
view filters on `blockOccursOn`, a block with no weekday rows renders nowhere (§2.2). 0018 covers
every block that exists when it applies, but `createSchoolBlock` (`day-ui.js:953`) does not write
weekday rows until **Phase 5**. So a Phases-1–3 release on its own turns `+ School` into a button
that mints an invisible block — §6.4's "indistinguishable from a crash", arriving through the gap
between phases instead of through a partial write.

What closes it is already in the design, and this is what makes it load-bearing rather than a
convenience: §4.2's `POST /api/wall/school-blocks` applies the **Mon–Fri default server-side** when
`weekdays` is omitted or empty. An unmodified Phase-3 client sends no `weekdays` and gets a
correctly scheduled block anyway. Phase 2 must therefore land with Phase 3, and Phase 2's route
work is not optional groundwork — it is the thing that keeps Phase 3 safe to ship.

**So the natural break is after Phase 3, with Phase 2 in it** — Phases 1–3 together still change no
behaviour a family can see except the one they asked for: blocks stop appearing on Saturdays.

**Two corrections from the Phase 3 build, both about that break actually working.**

- **The `CACHE_NAME` bump belongs to Phase 3, not Phase 6.** `wall-app/sw.js` is cache-first for the
  shell (`caches.match(canonical).then(cached => cached || fetch(...))`, and its own line 8 says
  "bump `CACHE_NAME` on any shell file change"). Without the bump the tablet keeps serving the old
  scripts, so a Phase 2+3 release changes nothing a family can see — which is the single thing this
  break exists to deliver. Bumped to `wall-display-shell-v17` in the Phase 3 commit; Phase 6's row
  keeps the manual checks and the doc reconciliation.
- **The loose end this paragraph predicted is closed, in Phase 3 rather than Phase 5.**
  `createSchoolBlock`'s optimistic append writes no weekday rows, so `blocksForChildOn` filters the
  new block straight back out and it flickers away until the next poll returns. It cost four lines
  here because **Phase 2's `POST /api/wall/school-blocks` already answers with the weekday list it
  applied** — including the Mon–Fri default when the body named none — so the client appends what
  the server actually stored rather than guessing.

**§11.6 must be answered before Phase 2 starts.** It decides whether
`DELETE /api/wall/slots` keeps one meaning or grows a scope, which is a route signature Phase 2
writes and Phase 4 calls.

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

## 11. Open items

Per `CLAUDE.md` §VI.C — flagged rather than settled. **§11.1, §11.2, §11.6 and §11.7 are now
answered**; §11.6 and §11.7 were answered together on 2026-08-23, before Phase 2 wrote the routes
they govern, and their answers are folded into §2.1 and §3.4.

**11.1 and 11.2 — ANSWERED 2026-08-23, folded into the design.** Sunday is *"a backup school day
but not regularly scheduled"* and a skip is wanted. Both are now §2.2.1's single mechanism: the
backfill stays Mon–Fri, and `wall_school_block_dates.occurs` decides any date that disagrees with
the weekly rule, in either direction. They are recorded here only so the numbering below stays
stable against the first draft of this file.

**11.3 Should a chore's weekday row be able to unplace it?** §2.1 says the weekday level answers
only *when*, never *whether* — a chore exists because it was assigned. But "on Fridays this one goes
back in the tray" is expressible in the same table (a weekday row meaning "unplaced" rather than
"unset"), and a family that finishes early on Friday might want exactly that. It needs a third state
per column, not just a nullable one, so it is genuinely more than a checkbox. **Not built.** See
also §11.7, which is the same table read the other way round — a weekday row that *places* a chore
with no standing placement underneath it, which the chain already permits.

Note that §2.2.1 makes this asymmetry sharper than it was in the first draft: a school block can now
be added to or removed from a single date, and a chore cannot. That is defensible — a chore's
existence is the Management App's fact, and the wall inventing or hiding one would be the wall
disagreeing with the parent about what was assigned, which is the line §1 exists to hold. But it is
the kind of asymmetry that reads as an oversight to whoever meets it next, so it is written down.

**11.4 Does a weekday override survive the standing time changing?** As designed, yes — the more
specific level keeps winning, silently. §6.1's sheet marks which level is in force, so it is
discoverable from the chip; but a family that moves the standing time and does not notice Friday
staying put has a confusing five minutes. The alternative (clear all weekday rows when the standing
time changes) is worse — it throws away deliberate work — so this is recorded as accepted rather
than solved.

**11.5 Week and month views do not show placements at all.** §6's week view shows Chores/School
tokens per day and the month grid shows events only, so neither can display a weekday-specific time
and neither needs to change. Noted so the next session does not go looking.

**11.6 — ANSWERED 2026-08-23 (before Phase 2). Unplacing is standing-scoped, and the override
levels are left dormant beneath it.** Ray's decision, from three options put to him with the code
read against this section. `DELETE /api/wall/slots` deletes the `wall_slots` row and nothing else:
it no longer sweeps `wall_slot_days` either, so the gesture became *less* destructive than it
shipped, not more. §3.4 is rewritten around it and §2.1 gains the gate that makes it safe. Two
findings from the Phase 2 build decided it, neither of them visible from this document alone:

- **The "third shape" this item recommended cannot be built.** It proposed moving §3.4's cleanup off
  the tray gesture and onto "the subject disappearing" — but `DELETE /api/wall/slots` has exactly
  one caller in the whole wall app (`day-ui.js:505`, plus the same call in its own Undo path), and
  the wall is never told a chore was deleted, because a chore's existence is the assignment row's
  fact (§1). There is no second caller to distinguish, and no event to hook. That option would have
  left the override levels with no cleanup path at all.
- **The sweep already had no honest undo, before this slice.** Un-placing offers Undo;
  `revertPlacement` restores the standing row's start and duration only. Every `wall_slot_days`
  override the shipped sweep destroyed was therefore already unrecoverable, behind a button
  promising otherwise. "Unplace is total" was never the neutral status quo this item took it for.

What makes dormancy safe rather than merely tidy is §2.1's gate — an override level cannot place a
chore, so leftover rows render nothing. The accepted cost, which §3.4's first draft called a hazard:
re-placing the same chore later restores its weekday and date times. Ray chose that over a gesture
that silently destroys a year of deliberate work. **The original text follows, for the record.**

**11.6 (original) Unplacing a chore is not scope-aware, and §3.4 makes that worse. NEEDS AN ANSWER
BEFORE PHASE 2.** Dragging a chip to the tray calls `unplace` (`day-ui.js:505`), which is
`DELETE /api/wall/slots` — the same route §3.4 is about to teach to clear `wall_slot_weekdays` and
`wall_slot_days` as well. So after this slice ships, dragging a chip to the tray **on a Friday**
deletes the standing placement and every weekday and date override the chore has, for every day of
the year. That is the exact failure §7.1 was written to prevent, arriving through the one gesture
§7.1 does not cover, and §3.4's cleanup — which is correct for its own purpose — is what sharpens it.

The two readings, neither of which the current text settles:

- **Unplace is standing-scoped** (what the route does today, and what §3.4 assumes). Consistent with
  "a chore is placed or it is not"; inconsistent with §7.1's *you move what you see*, and destructive
  in a way no toast can honestly summarise.
- **Unplace follows `resolveChip().scope`, like a drag does.** On a Friday whose time comes from a
  weekday row, dragging to the tray deletes the weekday row — and the chip reappears at its standing
  time, which is *not* the tray, so the gesture visibly fails to do what it looks like it did.

Neither is right, which is why it is flagged rather than decided. The shape that probably works is a
third one: unplace stays standing-scoped and total (one meaning, no surprises), and §3.4's
multi-level cleanup is triggered by the **subject disappearing**, not by the tray gesture — which
means `handleWallSlotDelete` needs to distinguish the two callers, or the tray gesture needs its own
route. Recommend deciding this with Ray before **Phase 2**, since it changes a route signature Phase 2
writes — the heading of this item said "Phase 4" in the first two drafts and §9 and §12 said
Phase 2; §9 was right, and the heading is corrected to match (2026-08-23, Phase 1 build).

**11.7 — ANSWERED 2026-08-23 (with §11.6). Not a feature: a weekday row cannot place a chore.**
§2.1 now states the gate — a chore is placed if and only if a `wall_slots` row exists, and rows 1
and 2 are overrides *on* a placement rather than sources of one. A `wall_slot_weekdays` row with a
`start_min` and nothing under it resolves to **unplaced**.

This costs nothing that was reachable: as this item already noted, no §6.1 button path can create
that state. It buys §11.6's answer, since dormant override rows are exactly what un-placing now
leaves behind, and it is the shipped behaviour of the level that already exists rather than a new
rule — `resolveChip` reads `startMin` from the standing row alone, so a `wall_slot_days` row with
no placement above it is already inert. Phase 3 says so in `slots-core`'s comment, as this item
asked. **The original text follows, for the record.**

**11.7 (original) A weekday row can place a chore that has no standing placement, and §2.1 does not
say whether that is a feature.** The chain reads level 2 before level 3, so a `wall_slot_weekdays` row with a
`start_min` and no `wall_slots` row underneath it renders the chore on Fridays and leaves it in the
tray the rest of the week. That is a genuinely useful state — "this only happens on Fridays" — and
it falls out of the model for free. But nothing in §6.1 can create it (every button path goes
through a chip that is already placed), nothing in the UI would explain a chore that is in the tray
on Thursday and on the grid on Friday, and §11.6's unplace question decides whether it is reachable
by accident. **Not built, not forbidden.** If it stays unreachable, say so in `slots-core`'s comment
rather than leaving the next reader to discover the chain permits it.

**11.8 §7.2's toast is the only affordance for scope on the common path, and it expires.** Already
recorded in §7.2. Restated here only because §11.6's answer may add a second gesture to the same
toast, and the 8-second budget is already carrying three buttons.

**11.9 The date rows carry no `updated_at`.** §3.3's comment explains why the block scope tables
follow `wall_school_block_courses` rather than `wall_slots`, and for the weekday table that is
plainly right. `wall_school_block_dates` is the weaker case: an `occurs = 0` row is a decision about
a specific day ("no school on the 14th") that someone may later want to date. It is still not read
by anything, so adding the columns now would be storing a fact with no reader. Recorded as a
deliberate omission that a future reporting need would reverse with one `ALTER`.

---

## 12. Revision log

| Date | Change |
|---|---|
| 2026-08-23 (Phase 3 build) | **The pure layer, and §0.1's bug is gone.** `TimeCore.weekdayOf` (§2.3) is now the one place a date becomes a day-of-week — `nav-ui.js`'s and `week-ui.js`'s identical copies both call it, and §8's test 1 springs the trap under `TZ=America/Chicago` rather than describing it (the suite's own default is UTC, so the assertion that a string-parsed `2026-08-23` reads Saturday only passes because the TZ change takes effect). `slots-core.js` gains `indexWeekdays`, `weekdayOverrideFor`, `resolveStartMin` and a five-row duration chain, and `resolveChip` gains the weekday index, `scope`, and §2.1's clamp; `school-core.js` gains a placement section (`blockOccursOn`, `resolveBlockSpan`, `scheduledWeekdays`, `dateExceptionFor`, plus `resolvePlacement` and `renderableRollups`); `day-ui.js`'s `blocksForChild` becomes `blocksForChildOn` at all four call sites and every block render reads the RESOLVED span off the block entry; `api.js`/`poll.js` carry the three new arrays. §8's tests 1–6 (incl. 4a, 4b, 5a) and 10; 610 green. **Corrections and additions this build made, all recorded above:** **(a)** the `CACHE_NAME` bump moves from Phase 6 to here — `sw.js` is cache-first, so without it a Phase 2+3 release changes nothing a family can see, which is the one thing that break exists to deliver (`wall-display-shell-v17`); **(b)** §9's predicted create-block flicker is closed here rather than in Phase 5, in four lines, because Phase 2's POST already answers with the weekday list it applied; **(c)** §5.3's member fix belongs to Phase 3, not Phase 5 — §9 scheduled its test here and its implementation there, and the filter has to be in the pure layer for test 10 to assert it "at the core boundary" at all; it also makes a block collapse where a phantom `checked: null` member used to hold it open; **(d)** `school-core` gains `resolvePlacement` beyond §5.2's four functions, so occurrence and span always come from the same two rows; **(e)** `resolveDurationMin` and `isOverridden` take the weekday row at its CHAIN position, and the shipped tests were updated to pass it explicitly as null — a three-argument call would have delivered the per-day row into the weekday slot and still produced the old answers, leaving the tests passing while asserting something else; **(f)** one shipped defect fixed in passing: `buildDurationSheet` called `isOverridden` with the old arity, which would have left the override marker reading only two of the three levels; **(g)** `nextFreeBlockStart` takes the date-filtered set AND resolved spans, per §5.2. **Not done, and correctly Phase 4/5:** the block WRITE paths (`moveSchoolBlock`, the block sheet) still address `block.start_min` directly. That is §7.1's "write the level that is winning" rule, and there is no live divergence today because nothing yet creates a weekday or date row with a non-null span — `createSchoolBlock`'s Mon–Fri rows are all NULL/NULL, which resolve to the block's own span. |
| 2026-08-23 (Phase 2 build) | **The Worker API.** Six new routes (`PUT`/`DELETE /api/wall/slots/weekday`, `PUT`/`DELETE /api/wall/school-blocks/:id/weekdays`, `PUT`/`DELETE /api/wall/school-blocks/:id/dates`), four widened (`GET /api/wall/slots` gains `slotWeekdays`; `PUT /api/wall/slots/day` gains `startMin` under §4.1's full-row contract; `GET /api/wall/school-blocks` gains `blockWeekdays` and `blockDates`; `POST /api/wall/school-blocks` takes a `weekdays` list and writes the block with its schedule in one `batch()`, defaulting to Mon–Fri server-side), and §3.4's cleanup on the block side. §8's test 9 plus 22 route tests; 598 tests green. **§11.6 and §11.7 were put to Ray and answered before any of it was written**, per §9's gate. §11.6: un-placing a chore is **standing-scoped and non-destructive** — it deletes the `wall_slots` row and nothing else, having *stopped* sweeping `wall_slot_days` too. Two findings decided it, neither visible from the design alone: **(a)** this item's own recommended "third shape" cannot be built, because `DELETE /api/wall/slots` has exactly one caller in the wall app and the wall is never told a chore was deleted — there is no subject-disappeared event to move the cleanup to, so that option would have left the override levels with no cleanup path at all; **(b)** the sweep already had no honest undo before this slice, since `revertPlacement` restores only the standing row, so every per-day override the shipped sweep destroyed was already unrecoverable behind a button promising otherwise. §11.7 is answered in the same stroke and is what makes (a) safe: §2.1 gains a **gate** — a chore is placed iff a `wall_slots` row exists, and the weekday and date levels are overrides *on* a placement, never sources of one — which is the shipped behaviour of `wall_slot_days` stated rather than a new rule. Accepted cost, recorded because §3.4 first called it a hazard: re-placing a chore restores its weekday and date times. §3.4 is rewritten around the asymmetry (a deleted **block** really is the subject disappearing, so its cleanup ships as designed; a chore is not). Also corrected: `isValidSlotDuration`'s comment claimed `wall_slot_days` never stores null, which §4.1 changes. Two Phase 4/5 loose ends, neither visible today: `applyOptimisticUnplace` (`day-ui.js:389`) still drops `slotDays` locally where the server now keeps them — invisible, since dormant rows render nothing, but it should stop; and the day view must send each level's OWN value on an override write, never the resolved one (§4.1). |
| 2026-08-23 (Phase 1 build) | **First code.** Migrations `0015_wall_slot_weekdays`, `0016_wall_slot_days_start`, `0017_wall_school_block_scopes`, `0018_wall_school_block_weekday_backfill`, all registered; `isValidWeekday`, `isValidStartMinOverride`, `isValidBlockSpan`, `isValidOccurs`, `isValidBlockDateException` in `worker/validation.js`; §8's tests 7, 7a and 8, migration-shape tests in the repo's existing style, and a new `tests/migrations-apply.test.js` that applies every migration to a real in-memory SQLite database. Six corrections to this document, found by reading it against the shipped code before writing any of it: **(a)** §9 and §3.3a both claimed 0018 makes weekend blocks stop rendering on apply — it does not, nothing reads the new tables until Phase 3's `blocksForChildOn`, so Phase 1 is entirely silent and §0.1's fix lands in Phase 3; **(b)** §9's "Phases 1–3 are shippable on their own" hid a real hazard in the Phase 3 → 5 gap — once the day view filters on `blockOccursOn`, `createSchoolBlock` mints a block with no weekday rows and it renders nowhere, which is what makes §4.2's server-side Mon–Fri default load-bearing and Phase 2 a prerequisite for shipping Phase 3; **(c)** §3.2's comment said "0011 is not edited" where `wall_slot_days` is created in **0010**; **(d)** §4.2 said "six new, two widened" over a table listing **four** widened, which is where Phase 2's estimate came from; **(e)** §5.2 said `blocksForChild` has three call sites — there are four, the missing one being `day-ui.js:933`'s `nextFreeBlockStart`; **(f)** §11.6's heading said Phase 4 where §9 and §12 said Phase 2 — §9 was right. Also recorded: 0018's split from 0017 is not merely prudent, `Online_Revamp` §3.7.1 requires it ("a migration that adds a table and backfills it is two files"); D1 does not enforce the `REFERENCES` clauses on this database, so §3.4's explicit cleanup is the only thing keeping scope rows from orphaning; and `handleWallSlotsGet`'s `SELECT *` means 0016 alone starts returning `start_min` in the `days[]` array with no Worker change. |
| 2026-08-23 | Written. Prompted by Ray reporting school blocks on weekends (§0.1), then asking for per-weekday times on blocks and chores alike (§0.2) and a "only this occurrence" scope for both (§0.3). Answers captured in-session: existing blocks backfill to **Mon–Fri**; per-day times are **overrides on a default span**, not seven independent spans; **design first, code next session**. Supersedes redesign slice §3.3, §5.4's no-per-day-span note, and §17.1. |
| 2026-08-23 (third pass) | **Design review against the shipped code, before any of it is built.** Five corrections, one route widening, four new open items — no change to the model in §2. Corrections: (a) §6.1's "deletes the level it came from" would have deleted the `wall_slots` row when moving *standing → only today*, unplacing the chore on every other day — `start_min` is `NOT NULL` and the row's presence IS the placement, so only levels 1–2 are ever cleared, now stated as a six-row table; (b) §4.1's "it already holds both numbers" would have written the **resolved** duration into a new override row, freezing a chip against the parent's `expected_duration_min` and lighting the override marker on a chip nobody re-timed — the shipped standing write already says `// preserved, never guessed`, and the override levels now inherit that rule; (c) independent start/duration chains silently break `handleWallSlotPut`'s `startMin + durationMin > 1440` invariant, since no single write sees the pair — resolved by clamping in `resolveChip` rather than by a read-modify-write on every PUT; (d) `weekdayOf` already exists twice (`nav-ui.js:54`, `week-ui.js:52`) and §2.3 would have added a third — Phase 3 collapses them; (e) the Mon–Fri backfill moves out of 0017 into its own **0018**, because no migration in this repo has yet put a `CREATE TABLE` and an `INSERT` into that same table in one `env.DB.batch()`, and a browser-applied migration with no CLI behind it is the wrong place to find out. Widened: `POST /api/wall/school-blocks` takes the weekday list and writes the block and its rows in one batch — six online-required writes with no outbox have five places to stop halfway, and the halfway state is indistinguishable from a deliberate schedule. New open items §11.6–§11.9, of which **§11.6 needs Ray's answer before Phase 2 writes the delete route**: unplacing a chore is not scope-aware, and §3.4's multi-level cleanup means a tray drag on a Friday would destroy every override the chore has. Tests 4a, 4b. |
| 2026-08-23 (second pass) | §11.1 and §11.2 answered, and the answers merged into one mechanism rather than two features. Sunday is *"a backup school day but not regularly scheduled"* and a skip is *"awesome"* — which are the same fact pointing opposite ways, so `wall_school_block_dates` gains **`occurs`** (§2.2.1) and decides its own date outright: `0` skips a scheduled day, `1` adds an unscheduled one, absent defers to the weekday list. The Mon–Fri backfill therefore stands unchanged — a backup Sunday is a per-date act, not a standing schedule. New: §2.2.1's decision, the split existence/span tables in §2.2, the `occurs` column and its validation, §6.2's three-way **Today** group, and §6.3's add-for-today sheet on `+ School` (without which a backup Sunday has no affordance at all — the block is not drawn, so there is nothing to long-press). Tests 5a, 7a, 12a. Phase 5 grows ~30 min. |
