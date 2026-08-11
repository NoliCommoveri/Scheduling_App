-- Fills the `children` projection (§3.2) from the `records` mirror, so the
-- table stops being empty for every child authored before the Worker started
-- maintaining it. Forward-only and idempotent: re-applying it re-derives the
-- same rows from the same source.
--
-- This is NOT the backfill §12 forbids. That one was about curriculum authored
-- before a sync token existed, which never reached D1 at all and is genuinely
-- unrecoverable. This reads rows that are already in `records` on this same
-- database and denormalises them one table over.
--
-- `active` is a real field on the child record as of this migration; a record
-- written before it existed has no such key, json_extract returns NULL, and the
-- CASE reads that as active — matching isActive() in the Management App, where
-- absent also means active.

INSERT INTO children (id, name, active, updated_at)
SELECT
  json_extract(value, '$.id'),
  json_extract(value, '$.name'),
  CASE WHEN json_extract(value, '$.active') = 0 THEN 0 ELSE 1 END,
  updated_at
FROM records
WHERE store = 'children'
  AND deleted = 0
  AND json_extract(value, '$.id') IS NOT NULL
  AND json_extract(value, '$.name') IS NOT NULL
ON CONFLICT (id) DO UPDATE SET
  name       = excluded.name,
  active     = excluded.active,
  updated_at = excluded.updated_at;
