-- Online Revamp Phase 1: the relational schema for assignments, rewards,
-- streaks, and device pairing, plus the `records` mirror re-declared so a
-- fresh database gets everything in one apply. Per TDS_Slice_Online_Revamp.md
-- §3.2-§3.6; a no-op on the live database, where `records` already exists.

CREATE TABLE IF NOT EXISTS records (
  store      TEXT    NOT NULL,
  key        TEXT    NOT NULL,          -- JSON.stringify of the IndexedDB key
  value      TEXT,                      -- JSON record; NULL when deleted = 1
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,          -- server receipt time, ms since epoch
  device_id  TEXT,
  PRIMARY KEY (store, key)
);

CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records (updated_at);

-- Queryable projection of the `children` rows inside `records`, kept in sync
-- by the Worker on every sync push that touches the `children` store, so
-- reports and joins do not have to parse JSON blobs.
CREATE TABLE IF NOT EXISTS children (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- The shared assignment table: one row per child per day per thing to do.
-- Parent-owned and child-owned columns are disjoint by design (§4.2) so the
-- Worker never has to arbitrate a conflicting write.
CREATE TABLE IF NOT EXISTS assignments (
  id                    TEXT PRIMARY KEY,   -- server-minted UUID
  child_id              TEXT NOT NULL,
  date                  TEXT NOT NULL,      -- YYYY-MM-DD, the day it is due
  kind                  TEXT NOT NULL,      -- 'activity' | 'chore' | 'event'
  batch_id              TEXT,               -- the Commit that produced it

  -- parent-owned: child may read, never write
  source_id             TEXT,
  title                 TEXT NOT NULL,
  course_name           TEXT,
  activity_type         TEXT,
  sequence_no           INTEGER,
  payload               TEXT,               -- JSON: pageRange, instructions, etc.
  expected_duration_min INTEGER,
  reward_amount         REAL,
  reward_category       TEXT,
  block_hint            TEXT,
  sort_order            INTEGER,
  rescinded_at          INTEGER,            -- NULL = live

  -- child-owned: parent may read, never write
  status                TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'complete'|'waived'
  completed_at          INTEGER,
  grade                 REAL,
  deferred_to           TEXT,               -- YYYY-MM-DD, child moved it
  child_block_hint      TEXT,
  child_sort_order      INTEGER,

  -- bookkeeping
  assigned_at           INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT                -- 'parent' | 'device:<deviceId>'
);

CREATE INDEX IF NOT EXISTS idx_assign_child_date    ON assignments (child_id, date);
CREATE INDEX IF NOT EXISTS idx_assign_child_updated ON assignments (child_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_assign_batch         ON assignments (batch_id);

-- Append-only earnings ledger. Never UPDATE or DELETE a row; a correction is
-- a new compensating entry. Balance is always SUM(amount), never a stored
-- number.
CREATE TABLE IF NOT EXISTS reward_entries (
  id            TEXT PRIMARY KEY,   -- client-minted UUID on the child device -> replay-safe
  child_id      TEXT NOT NULL,
  assignment_id TEXT,               -- NULL for manual adjustments
  category      TEXT NOT NULL,
  amount        REAL NOT NULL,      -- negative permitted: spend or reversal
  reason        TEXT NOT NULL,      -- 'earned' | 'adjustment' | 'spend'
  earned_at     INTEGER NOT NULL,
  created_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reward_child_cat ON reward_entries (child_id, category);

CREATE TABLE IF NOT EXISTS streaks (
  child_id            TEXT PRIMARY KEY,
  current_streak      INTEGER NOT NULL DEFAULT 0,
  longest_streak      INTEGER NOT NULL DEFAULT 0,
  last_qualified_date TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  child_id     TEXT NOT NULL,
  label        TEXT,                    -- "Ellie's tablet"
  token_hash   TEXT NOT NULL UNIQUE,    -- SHA-256 of the bearer; plaintext never stored
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_devices_child ON devices (child_id);

-- `fail_count` is one column beyond the TDS's §3.6 listing: §4.3 requires
-- "10 failed redemptions per code, then the code is burned," and there is
-- nowhere else to keep that count. Flagged as a [DECISION] in the build
-- summary rather than silently added.
CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,   -- 8 chars, Crockford-style alphabet (no I/L/O/U/0/1)
  child_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,   -- 15 minutes from mint
  consumed_at INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
