-- Grading Assistant §1.1 — the grader's own proposal rows. One row per grading
-- attempt, one live row per assignment: a re-grade replaces it, because a
-- proposal is a draft with no ledger property to protect (§1.1, §11.5).
--
-- This table never feeds `assignments.grade` directly (§0.1). The score
-- reaches `grade` only through the existing completion path, using exactly
-- ASSIGNMENT_COMPLETION_FIELDS — the Wall App's own-your-own-tables pattern
-- (CLAUDE.md §0) applied here.

CREATE TABLE IF NOT EXISTS grading_reviews (
  assignment_id   TEXT PRIMARY KEY,   -- one live proposal per assignment
  child_id        TEXT NOT NULL,      -- denormalized for query; always matches the assignment's
  photo_key       TEXT NOT NULL,      -- R2 object key, pages/{assignment_id}
  proposed_score  REAL,               -- content score; never copied to assignments.grade by this route
  items           TEXT,               -- JSON: per-item verdict, transcription, reason
  feedback        TEXT,               -- text addressed to the child
  rubric_digest   TEXT,               -- hash of the resolved rubric that produced this (§2.3)
  model           TEXT,               -- model id that graded it, for accuracy attribution
  state           TEXT NOT NULL DEFAULT 'proposed',  -- 'proposed'|'accepted'|'overridden'|'failed'
  created_at      INTEGER NOT NULL,
  reviewed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_grading_reviews_child ON grading_reviews (child_id);
