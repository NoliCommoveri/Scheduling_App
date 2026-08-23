-- BACKFILL (§2.2's consequence), split from 0017 per Online_Revamp §3.7.1.
-- Every block that exists today has no weekday rows; once the day view filters
-- on them (Phase 3's blockOccursOn), a block with no rows renders NOWHERE.
-- Without this INSERT, that phase would make every existing block disappear
-- from every day rather than just from weekends.
--
-- THIS MIGRATION IS INERT ON APPLY. Nothing reads wall_school_block_weekdays
-- until Phase 3 rewrites day-ui.js's blocksForChild(), which filters on
-- child_id alone today. Applying 0015-0018 changes nothing a family can see —
-- not the weekend blocks either. §0.1's reported bug is fixed in Phase 3, and
-- this file is what stops that fix from taking the weekdays with it.
--
-- Mon-Fri (1..5), chosen by Ray in-session 2026-08-23. Saturday is the
-- family's Sabbath (§6). Sunday is left off deliberately, not pending a
-- decision: it is "a backup school day but not regularly scheduled" (Ray,
-- same session), which is a per-DATE fact, not a weekly one — §2.2.1's
-- occurs = 1 row is how a backup Sunday happens, one tap on the day itself
-- rather than a standing schedule change that has to be undone next week.
--
-- NULL span on each row = inherit the block's own start_min/end_min, so
-- nothing MOVES here, now or in Phase 3.
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
