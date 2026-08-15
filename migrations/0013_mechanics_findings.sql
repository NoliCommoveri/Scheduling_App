-- Grading Assistant §1.2 — append-only remediation feed. Never UPDATE or
-- DELETE a row, same discipline as reward_entries (0001:70). Shaped for the
-- query that justifies it: which words does this child keep getting wrong?
-- The (child_id, intended) index below *is* the remediation report.
--
-- A finding is written regardless of whether the household's rubric counts it
-- against the child (`counted`) — §0.4: recording is decoupled from counting,
-- because the axis exists to design remedial work, and remediation needs data
-- from courses that don't penalise. Same "projection over JSON blob" reasoning
-- migration 0002's header gives for the `children` table (§1.2's own note).

CREATE TABLE IF NOT EXISTS mechanics_findings (
  id            TEXT PRIMARY KEY,   -- server-minted
  child_id      TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  kind          TEXT NOT NULL,      -- 'spelling' | 'grammar'
  as_written    TEXT NOT NULL,      -- what the child wrote
  intended      TEXT NOT NULL,      -- what the model believes was meant
  counted       INTEGER NOT NULL,   -- 0/1 — whether the rubric made it affect the child's feedback
  source        TEXT NOT NULL,      -- 'list' | 'model' — which arm of §4.2 decided it
  found_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mechanics_child_intended ON mechanics_findings (child_id, intended);
CREATE INDEX IF NOT EXISTS idx_mechanics_assignment ON mechanics_findings (assignment_id);
