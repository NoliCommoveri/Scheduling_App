-- Child Feedback Loop TDS §6.1 — assignment messages, one-way (child → parent).
--
-- A table rather than a column: many messages can reference one assignment,
-- and this is an append-only log, not a mutable field. It follows the exact
-- pattern `reward_entries` established — client-minted id, idempotent insert,
-- one parent-owned exception column.
--
-- Ownership (§8): every column here is child-owned and written once, except
-- `read_at`, which only the parent sets. Same shape as `devices.revoked_at`
-- and `assignments.rescinded_at`: a nullable timestamp that goes from NULL to
-- a value and, per SRS Module 13 FR-4, is never cleared again.
--
-- Ordering: this migration ships alongside the routes that use it rather than
-- one release ahead (the §5.5 sequence 0004 needed), because at this point
-- nothing calls them — neither the Child App composer nor the Management App
-- inbox exists yet. The first client write is a later release, by which time
-- this is long applied. If that ordering ever changes, §11.7's containment
-- means a device meets a per-row deferral rather than a drain-wide stall.

CREATE TABLE IF NOT EXISTS assignment_messages (
  id            TEXT PRIMARY KEY,   -- client-minted UUID, replay-safe (Online Revamp §5.5)
  child_id      TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,      -- 'device:<deviceId>'
  read_at       INTEGER             -- NULL = unread. The one parent-owned column.
);

-- The inbox's own query: one child's messages, newest first.
CREATE INDEX IF NOT EXISTS idx_messages_child_created ON assignment_messages (child_id, created_at);

-- "What was asked about this assignment", and the join the inbox uses to put a
-- title and a date beside a message body.
CREATE INDEX IF NOT EXISTS idx_messages_assignment ON assignment_messages (assignment_id);
