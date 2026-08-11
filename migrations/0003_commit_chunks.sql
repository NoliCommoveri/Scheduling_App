-- Makes a Commit replay-safe, which TDS_Slice_Online_Revamp.md §6.1 has always
-- claimed ("a client-side UUID, so the Commit is replay-safe") without anything
-- in the Worker implementing it.
--
-- A Commit posts its rows in chunks of 500, every chunk carrying the same
-- batch_id (§6.2). Nothing recorded which chunks had landed, so a response lost
-- after the server committed left the client believing the POST failed: pressing
-- Commit again re-inserted every row under a fresh batch_id and the child saw
-- the work twice.
--
-- One row here per (batch_id, chunk_index) accepted. The insert rides in the
-- same env.DB.batch() as the assignment rows it accounts for, so the primary key
-- is what enforces the guarantee: a replay collides, the implicit transaction
-- rolls back, and not one duplicate assignment lands. `row_count` is what the
-- replay is answered with, so a retry can report what the first attempt applied.

CREATE TABLE IF NOT EXISTS commit_chunks (
  batch_id    TEXT    NOT NULL,
  chunk_index INTEGER NOT NULL,
  child_id    TEXT    NOT NULL,
  row_count   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (batch_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_commit_chunks_child ON commit_chunks (child_id, created_at);
