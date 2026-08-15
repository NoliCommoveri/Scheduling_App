-- Wall Calendar Redesign §5.5 — school blocks: a placement of a TIME SPAN for
-- one child, holding a checklist of member courses (§5.1, revised 2026-08-15
-- from the original one-block-per-course model — §20). Sits beside
-- wall_slots/wall_slot_days (migration 0010), not inside them: a block's
-- shape (one span, many members) doesn't fit wall_slots' singleton
-- (child_id, subject_kind, subject_key, instance_key) key, and forcing it in
-- would need one wall_slots row per member course — the same "N copies of a
-- fact with one value" shape §3.1.2's `claim` decision already rejected, for
-- a different reason.
--
-- Written only by the wall, read only by the wall — outside CLAUDE.md
-- §III.E's child-scoping scheme entirely, for the same reason wall_slots is:
-- no other app reads or writes these tables, and they carry no child-owned
-- or parent-owned `assignments` column. A block is always one child's; there
-- is no household sentinel here the way a `claim` chore's placement has one
-- (§3.1.2) — that problem doesn't exist for a block.
--
-- `label` is cosmetic only (§5.1.1) — NULL renders as "School". It carries
-- no identity: two same-day blocks for a child are distinguished by their
-- (possibly overlapping) time spans, not by title.
--
-- `end_min` rather than a `duration_min` column, unlike wall_slots — a
-- block's span is authored directly (§5.4), with no assignment-authored
-- estimate underneath it to express as an override the way a chore's
-- duration_min does (§3.5.1 does not apply to blocks, §20).

CREATE TABLE IF NOT EXISTS wall_school_blocks (
  id            TEXT    PRIMARY KEY,       -- server-minted, like every other id
  child_id      TEXT    NOT NULL,
  label         TEXT,                      -- NULL = render as "School"
  start_min     INTEGER NOT NULL,          -- minutes from local midnight, % 15 == 0
  end_min       INTEGER NOT NULL,          -- > start_min, % 15 == 0
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL           -- 'wall:<deviceId>'
);

-- Membership: which courses a block holds (§5.2). `course_name` is the same
-- denormalized text snapshot an activity row's own course_name is
-- (packet.js:521) — the only course identity either row carries. Renaming a
-- course in the Management App orphans a membership row rather than moving
-- it (§5.2.1); the fix is to re-check it in the picker. Not a foreign key to
-- any course table — there isn't one; `course_name` is the whole identity.
CREATE TABLE IF NOT EXISTS wall_school_block_courses (
  block_id      TEXT    NOT NULL REFERENCES wall_school_blocks(id),
  course_name   TEXT    NOT NULL,
  PRIMARY KEY (block_id, course_name)
);
