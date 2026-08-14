-- Wall Calendar Redesign §3.2 — placements, the core new mechanism.
--
-- A placement binds a recurring thing (a chore occurrence, or a course acting
-- as a school block) to a time of day for one child, standing until it is
-- moved again (§3.3 — carry-forward is the default, there is no per-day time
-- override in v1). `wall_slot_days` is the one exception: a per-day DURATION
-- override only (§3.5.2's "just this one"), created in the same file because
-- an override table without the table it overrides is meaningless.
--
-- Written only by the wall, read only by the wall. Neither table is reached
-- by `assignments` column ownership at all — the wall's writes there remain
-- exactly ASSIGNMENT_COMPLETION_FIELDS, unchanged by this migration.
--
-- `child_id`: '' is the household sentinel `migrations/0009` already
-- established for the wall's own `devices` row — a real id is always a
-- server-minted UUID, so '' can never collide with one. Here it means "this
-- placement belongs to a `claim` chore's whole group rather than to one
-- child" (§3.1.2: `each` places per child, `claim` places once, child-less).
-- The Worker accepts the sentinel only when `subject_kind = 'chore'`; a
-- school placement is always per child.
--
-- `instance_key` is NOT NULL DEFAULT '' for the reason `migrations/0006`
-- gives at length: `NULL = NULL` is never true in SQLite, so a nullable
-- component of a natural key silently disables every comparison that uses
-- it. A chore with no occurrences carries the same empty default.
--
-- `subject_key`: for `subject_kind = 'chore'` this is the chore's `source_id`
-- (stable across days, packet.js:544); for `subject_kind = 'school'` this is
-- `course_name` (an activity's own `source_id` differs every day and cannot
-- key a standing arrangement — course_name is the only course identity the
-- row carries, packet.js:521, and the cost of that denormalization is §5.2).
--
-- `duration_min` on both tables is an OVERRIDE, never the truth: row 3 of
-- §3.5.1's precedence chain is `assignments.expected_duration_min`, which
-- this migration does not touch and no wall route ever writes.

CREATE TABLE IF NOT EXISTS wall_slots (
  child_id      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,          -- 'chore' | 'school'
  subject_key   TEXT    NOT NULL,
  instance_key  TEXT    NOT NULL DEFAULT '',
  start_min     INTEGER NOT NULL,          -- minutes from local midnight, % 15 == 0
  duration_min  INTEGER,                   -- NULL = fall through to the assignment's own estimate (§3.5.1)
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,          -- 'wall:<deviceId>'
  PRIMARY KEY (child_id, subject_kind, subject_key, instance_key)
);

-- The per-day duration override: "just this instance" (§3.5.2). Same key as
-- wall_slots plus a date, so one precedence chain covers chores and school
-- blocks alike. `duration_min` stays nullable at the schema level, but a NULL
-- row is meaningless — the Worker deletes the row to clear an override
-- rather than ever writing NULL into it.
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
