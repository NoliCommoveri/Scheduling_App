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
-- Worker stores what it is given and never derives a weekday itself, so there
-- is no second implementation with its own timezone to disagree with.
--
-- `child_id`, `subject_kind`, `subject_key`, `instance_key` carry exactly the
-- meanings migrations/0010 documents at length, including the '' household
-- sentinel for a `claim` chore's group-wide placement. This table inherits
-- them rather than restating them; if that file's key changes, this one moves
-- with it.
--
-- Written only by the wall, read only by the wall. Touches no `assignments`
-- column; the wall's writes there remain exactly ASSIGNMENT_COMPLETION_FIELDS,
-- and `expected_duration_min` stays parent-owned and unwritten (CLAUDE.md §0).
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
