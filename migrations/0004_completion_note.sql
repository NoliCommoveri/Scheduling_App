-- Child Feedback Loop TDS §5.1 — one nullable, child-owned column: a note the
-- child can attach to a completion ("did problems 1-10, skipped 11, wasn't
-- sure how"). Parent reads, never writes — same tier as `grade`.
--
-- §5.5: this migration ships and is applied on its own, before any Worker or
-- Child App code reads or writes it. A device posting `completionNote`
-- against a database that has not yet run this ALTER stalls that device's
-- whole outbox drain (D1 throws, the Worker's per-row rejection design in
-- handleCompletions never gets a chance to catch it — see §5.5's write-up).
-- Apply this from Settings → Database (or /admin/migrations) before
-- deploying the code that follows it.

ALTER TABLE assignments ADD COLUMN completion_note TEXT;
