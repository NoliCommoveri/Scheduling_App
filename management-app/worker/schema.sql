-- D1 schema for the Management App durable mirror.
-- Per TDS_Slice_D1_Sync_Management_App.md §4.
--
-- Apply with:
--   wrangler d1 execute homeschool-management --remote --file=worker/schema.sql

-- One row per IndexedDB record, keyed structurally rather than per-entity
-- (§1.1) so a future object store is mirrored with no migration here.
CREATE TABLE IF NOT EXISTS records (
  store      TEXT    NOT NULL,
  key        TEXT    NOT NULL,          -- JSON.stringify of the IndexedDB key (§3.1)
  value      TEXT,                      -- JSON record; NULL when deleted = 1
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,          -- server receipt time, ms since epoch
  device_id  TEXT,
  PRIMARY KEY (store, key)
);

-- Supports since-based pull and the status endpoint's MAX(updated_at).
CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records (updated_at);
