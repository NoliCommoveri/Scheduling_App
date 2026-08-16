-- Grading Assistant §12.2 — multi-page assignments. grading_reviews stays one
-- row per assignment (a proposal is still one draft, §1.1) but now spans a
-- captured set of pages rather than one photo. `photo_key` changes meaning in
-- code from an object key to a prefix (pages/{assignment_id}/{n}, 1-based) —
-- no column change for that, since it was already TEXT — but page_count is
-- new: it says how many of that prefix's objects belong to the live proposal.
--
-- Default 1 so this reads correctly against nothing: nothing from this slice
-- reaches real use until every §12.10 phase is complete (Ray, in-session
-- 2026-08-16), so there is no pre-existing row this default needs to describe
-- accurately — it exists for schema hygiene, not backward compatibility.

ALTER TABLE grading_reviews ADD COLUMN page_count INTEGER NOT NULL DEFAULT 1;
