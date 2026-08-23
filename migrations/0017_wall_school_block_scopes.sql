-- Placement Scopes §2.2 — a school block's weekday schedule and its per-date
-- override. Mirrors the chore side's three levels with a block's own key
-- (block_id, not the four-part slot key) for the reason §5.5 gives for the
-- tables it already has: a block's shape does not fit wall_slots' singleton.
--
-- The WEEKDAY table carries existence as well as time (§2.2): a block renders
-- on a date only if a row exists for that date's weekday. start_min/end_min
-- are both-or-neither at every level (§2.2's pair decision) — the Worker
-- rejects one without the other, via isValidBlockSpan.
--
-- This file only CREATES. The Mon-Fri backfill that keeps existing blocks
-- visible is migrations/0018, a separate file per Online_Revamp §3.7.1 ("a
-- migration that adds a table and backfills it is two files") — which also
-- means a failed backfill leaves these tables applied and is retried by
-- pressing the button again, rather than rolling the schema back under an
-- operator who has no CLI to recover with (CLAUDE.md §0, §III.D).
--
-- NO updated_at/updated_by here, unlike wall_slots and wall_school_blocks,
-- and matching wall_school_block_courses (migrations/0011). The rule these
-- tables follow is the membership table's, not the placement table's: a row's
-- existence IS its whole content on the weekday table, and nothing in the app
-- reads either stamp — no route returns them, no view renders them, and the
-- wall has one credential per tablet so `wall:<deviceId>` distinguishes
-- almost nothing. Recorded because a reader comparing the wall's tables will
-- notice the split and should know it was chosen, not missed. §11.9 notes the
-- one row class that has an argument for keeping a stamp.
--
-- The REFERENCES clauses are documentation, not enforcement: D1 does not have
-- foreign keys on for this database — handleWallSchoolBlockDelete deletes the
-- parent row BEFORE its wall_school_block_courses children and has always
-- worked — so §3.4's explicit multi-table cleanup is what actually keeps
-- these rows from orphaning. Stated so nobody relies on a cascade that is not
-- there.
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
-- rejects occurs = 0 with start_min/end_min set, via isValidBlockDateException.
CREATE TABLE IF NOT EXISTS wall_school_block_dates (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  date          TEXT    NOT NULL,          -- YYYY-MM-DD
  occurs        INTEGER NOT NULL DEFAULT 1,-- 1 = happens (default), 0 = skipped
  start_min     INTEGER,                   -- NULL (with end_min) = weekday row, else the block's own
  end_min       INTEGER,
  PRIMARY KEY (block_id, date)
);
