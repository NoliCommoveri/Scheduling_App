-- Shared Chores TDS §5.2 — arbitration for allocation: 'claim'.
--
-- Three nullable columns on assignments. NULL claim_group means an
-- ordinary, unshared row, which is every row that exists today.
ALTER TABLE assignments ADD COLUMN claim_group TEXT;
ALTER TABLE assignments ADD COLUMN claimed_by   TEXT;      -- child_id of the winner
ALTER TABLE assignments ADD COLUMN claimed_at   INTEGER;

CREATE INDEX IF NOT EXISTS idx_assign_claim_group
  ON assignments (claim_group) WHERE claim_group IS NOT NULL;

-- The group identity, minted and owned by the server.
--
-- This table exists so that claim_group can be an opaque server-minted UUID
-- (§3.3.1) rather than a key derived from the chore and the date. A derived
-- key would be simpler by one table — and would be the exact pattern the
-- revamp repealed: CHR-{token}-{date} was a chore id and a date
-- concatenated, and §3.3.1 repealed it. Re-introducing that shape under a
-- new column name is not a smaller change, it is the same mistake with
-- better manners.
--
-- The primary key is what makes two independent per-child Commits agree on
-- one group without coordinating: both INSERT OR IGNORE the same triple,
-- and SQLite arbitrates. Either order, any number of re-runs, one group.
CREATE TABLE IF NOT EXISTS claim_groups (
  source_id    TEXT NOT NULL,  -- the chore's curriculum id
  date         TEXT NOT NULL,  -- YYYY-MM-DD, the occurrence
  instance_key TEXT NOT NULL,  -- §3; '' for a chore with one occurrence a day
  id           TEXT NOT NULL,  -- server-minted UUID — the value in assignments.claim_group
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (source_id, date, instance_key)
);
