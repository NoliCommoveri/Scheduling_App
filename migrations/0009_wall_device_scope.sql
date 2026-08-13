-- Wall Display App §8.1 — the credential class the wall runs on.
--
-- `devices` gains a scope. Existing rows are child device tokens and read as
-- 'child' through the DEFAULT, so this is inert until something mints a wall
-- row: the Worker's withDevice() accepts 'child' only and withWall() accepts
-- 'wall' only, which is what makes a wall token 401 on the Child App's routes
-- and a device token 401 on /api/wall/*.
--
-- Why a column rather than a second table: `devices.child_id` is NOT NULL
-- (0001:96) and SQLite cannot drop a NOT NULL constraint in place. A wall row
-- stores the sentinel `child_id = ''` — never a real id, since those are
-- server-minted UUIDs — and `scope` is what actually distinguishes it. The
-- same sentinel marks a wall pair code in `pair_codes.child_id`, which is how
-- a child's code is stopped from redeeming into a household-scoped credential.
-- `idx_devices_child` is unaffected.

ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'child';
