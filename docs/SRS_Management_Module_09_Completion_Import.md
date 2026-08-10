# Software Requirements Specification — Management App
## Module 9: Completion Import
### Deferred Build — Phase 4 (milestone M10)

> ## ⚠️ CANCELLED — 2026-08-10. Never built; will not be.
>
> This module existed to reconcile a CSV coming back across the air gap. Completions are now
> rows the child writes directly into the shared `assignments` table, so there is nothing to
> import and nothing to reconcile — `GET /api/assignments` reads them directly.
> Controlling design: **`docs/TDS_Slice_Online_Revamp.md`** §5.2, §9.
>
> Reporting (Module 10) keeps its analysis; only its input changes.

*Written against Domain Model §4.2 (Completion CSV — the locked eleven-column source), §4.3 (Reconciliation — deferred build, designed now), §2.12 (Imported Completion Record), Architecture Evaluation §9 ("Once completion import ships, [Master Reports] consolidate every child's completion data"), Roadmap §3/§5. Per Roadmap §5, this module's *build* is Phase 4 — after both apps' Phase 1–3 work — but per Domain Model §4.3's own framing ("deferred build, designed now"), its contract is specified here, same treatment already given to the CSV format itself back when nothing consumed it yet.*

---

## 1. Purpose

Turns each child's exported Completion CSV back into consolidated Management-side completion records, matched to the authored Activity or Chore that produced them via the stable `activityId` join key. This module owns *import, matching, and reporting* only — it does not own Master Reporting's own aggregation/export (a separate, later module) and never mutates any authored Course, Lesson, Activity, Chore, or Course Instance record.

## 2. Scope notes

**2.1 — Deferred-build status; contract fixed now, matching precedent.** Domain Model §4.3 frames this exactly this way — designed now, built in Phase 4. The Completion CSV's own `activityId` column and reserved `waived` status carry this same "useless until Phase 4, load-bearing anyway" status (Domain Model §5.2). This module continues that pattern rather than leaving the reconciliation mechanism as a one-line aspiration.

**2.2 — Matching is by `activityId`, never by the CSV's `childName`/`semesterLabel` columns.** Both of those columns are passthrough-only on the child side (Domain Model §4.2 — `childName` sourced from "Child record (Module 1)," `semesterLabel` a pure passthrough) — they describe what the child device *believed* about itself at export time, not an authoritative claim this module should trust for routing. Since Activity and Chore IDs are minted globally-unique and never reused (Domain Model §1, §2.5, §2.6), and every currently-existing ID's ownership (which Instance, which Course, which Child, or which standalone Chore) is fully recoverable by looking the ID up against current Management-side records — for Chore rows, via the `CHR-{choreToken}` stem rather than the full occurrence ID, since only the stem is a stored record (§4/FR-3) — **this module matches every row by `activityId` lookup alone.** The owning Child (and Instance, for Activity rows) is *derived* from that lookup, never read off the row's own `childName` field.

**Consequence:** if a row's stated `childName` doesn't match the Child actually derived from its `activityId` match, that's surfaced as a non-blocking warning (§4/FR-5) — worth a parent's attention (it could mean the wrong file was selected), but never grounds to reject the row, since the ID is authoritative and the name isn't.

**2.3 — Row-level partial commit, a deliberate departure from the all-or-nothing pattern used elsewhere (Packet Import, Course Template bulk import).** Those two govern *creating new authoritative structural data* — a bad row there risks leaving genuinely ambiguous half-built state, which is why they reject the whole file. This module is different in kind: it's reconciling a report against records that already exist and are already authoritative. A row that can't be matched isn't a corruption risk to the Management data — it's exactly the case Domain Model §4.3 already names and requires: **"unmatched rows ... are reported, not silently dropped."** That phrasing only makes sense under a partial-commit model; an all-or-nothing reject would make "reported" meaningless, since nothing would ever partially land. Valid, matched rows import; unmatched or otherwise row-invalid rows are captured in an import report (§2.6) rather than either silently discarded or used to reject the whole file.

**Still whole-file-reject, distinct from the above:** a file that fails *schema-level* validation entirely — missing required columns, unparseable structure — is rejected outright before any row-level processing begins, same treatment as Packet Import's schema-version gate (Child App Module 2, FR-2). The partial-commit behavior above only applies once the file's shape itself is sound. **The CSV has no version field of its own — its eleven-column header, in the locked order (Interchange Contract §2/§7), is what stands in for one.** A header that doesn't match exactly (missing column, extra column, wrong order) is a schema-level failure and rejects the whole file with a plain message; it is never partially processed and never silently tolerated as "close enough."

**2.4 — Idempotent re-import, by `activityId`.** An `activityId` that already has a successful Imported Completion Record (§2.6) from a prior import is a no-op on any later import attempt containing that same ID — not re-imported, not duplicated, not flagged as an error. This should be a rare case in practice given Completion CSV Export's own "no duplicate rows across exports" rule (Child App Module 8, FR-6), but this module doesn't rely on that upstream guarantee holding perfectly — it protects against the duplicate directly, regardless of cause (a re-selected file, overlapping manual exports, or anything else).

**2.5 — The Chore-row `course`/`activityType` convention doesn't affect matching.** A Chore row's `activityType` carries its `choreType` (one of the eleven canonical categories — `Pet Care`, `Car Care`, `Kitchen/Dining`, `Bathroom`, `Living/Main Area`, `Playroom`, `Bedroom`, `Parent's Room`, `Porch`, `Floors`, `Miscellaneous`, Domain Model §2.6 / Interchange Contract §1b) and `course` is blank (Domain Model §4.2) — but matching in this module is purely `activityId`-based, and Chore IDs live in their own non-colliding namespace from Activity IDs (Module 6 §2.4). This module matches Chore rows correctly without inspecting either column, so `activityType` being real, informative data for Chore rows (rather than a placeholder) has no bearing on how this module works — it simply means those two columns are worth reading for reporting purposes elsewhere (Master Reporting), not for reconciliation here. **Because chore rows carry per-occurrence IDs, `activityId` remains a complete identity for idempotency (FR-6)** — two completions of the same recurring chore on different dates are two distinct `activityId` values, both imported.

**2.6 — The Imported Completion Record holds this module's output.** Domain Model §2.12 names the entity that holds the reconciliation result. Settled shape (exact storage indexing/detail remains a TDS-level concern, but the entity itself and its required fields are locked here):
- One record per successfully-matched row: `{ activityId, date, status, grade? (if present), plannedBlock? (if present), resolvedChildId, resolvedInstanceId? (Activity rows only — absent for Chores, which have no Instance), importedAt }`.
- A separate, retained list of unmatched-row reports: `{ rawRow, reason, importedAt }` — surfaced to the parent, never auto-discarded (§2.3).

## 3. User stories

- As a parent, I want to import the CSVs my kids hand back to me so the Management App has a real completion history, not just the plan I generated.
- As a parent, I want a row that can't be matched to still be shown to me, not silently thrown away, so I know something needs my attention.
- As a parent, I want re-importing a file I already processed to be harmless, not create duplicate history.
- As a parent, I want one bad or unmatched row in an otherwise-good file to not cost me the rest of that file's real data.

## 4. Functional requirements

**FR-1 — Select file(s) for import.** Manual file selection, one CSV at a time. Same swappable-acquisition treatment already established for Packet Import (Child App Module 2 §2.1) and Packet Generation's own export destination (Module 8 §2.4) — a Drive-backed picker can replace or augment this later with zero change to matching/reporting logic.

**FR-2 — Whole-file schema validation.** The file is checked against Domain Model §4.2's locked eleven-column shape before any row is processed. A file missing required columns, or that isn't parseable as CSV at all, is rejected in its entirety with a clear message — no partial interpretation of a malformed file (§2.3).

**FR-3 — Per-row matching by `activityId`.** For each row in a schema-valid file, look up `activityId` against every currently-known Management-side Activity and Chore record, across all Children and Instances. A match resolves the owning Child (always) and Instance (for Activity rows only — Chores have no Instance to resolve). Activity rows resolve by whole-ID lookup, unchanged. For Chore rows, an `activityId` bearing the `CHR` prefix resolves by its `CHR-{choreToken}` stem (first two segments) to the owning Chore record; the trailing date segment identifies the occurrence and is not part of the lookup.

**FR-4 — Unmatched-row reporting.** A row whose `activityId` matches no current Activity or Chore produces an entry in the import's unmatched-row report (§2.6) rather than being imported or dropped. Common, expected causes include the row belonging to a since-deleted Course Instance (same "gone but not an error" treatment as a deleted template's `sourceTemplateId`, Module 3 §2.4) — this module doesn't distinguish *why* a row is unmatched, it just reports that it is.

**FR-5 — `childName` cross-check, non-blocking (§2.2).** If a matched row's stated `childName` doesn't equal the resolved owning Child's current `name`, the import summary surfaces a warning naming both values — this never blocks the row's import; the `activityId` match is what's authoritative.

**FR-6 — Idempotent by `activityId` (§2.4).** A row whose `activityId` already has a successful Imported Completion Record from any prior import is a no-op: not re-imported, not duplicated, not counted as an error in the summary — counted separately as "already imported."

**FR-7 — Status and grade, passthrough only.** `status` (`complete` | `waived`) and `grade` (if present) are stored on the Imported Completion Record exactly as received. This module performs no business-logic reinterpretation of either — that already happened on the child device (Child App Module 4) before export.

**FR-8 — No write-back to authored content.** Import never creates, edits, or deletes any Course, Lesson, Activity, Chore, or Course Instance record. Its only write is a new Imported Completion Record per matched row (§2.6) — a separate, reconciliation-only data set, never merged into or confused with authored/template data.

**FR-9 — Import summary.** Every import operation produces a summary shown to the parent: counts of newly-imported (matched) rows, already-imported (FR-6 no-op) rows, unmatched rows (FR-4), and any `childName`-mismatch warnings (FR-5). This is not a silent background operation — the parent sees the outcome of every import.

## 5. Validation rules

| Rule | Detail |
|---|---|
| File schema | Must contain all eleven locked columns (Domain Model §4.2); malformed/unparseable ⇒ whole-file reject before any row processing. |
| Row match | `activityId` must resolve against a currently-known Activity or Chore record; unmatched ⇒ reported, not imported, not silently dropped (§2.3/FR-4). |
| `childName` | Passthrough only; a mismatch against the resolved owning Child is a non-blocking warning (§2.2/FR-5), never a rejection. |
| `status` | Must be one of `complete` \| `waived`; any other value on an otherwise-matched row is treated the same as an unmatched row — reported, not imported (a malformed row, not a structural file failure). |
| Duplicate `activityId` | A row matching an `activityId` already present in a prior successful import is a no-op (FR-6), not an error, not a duplicate record. |
| Authored data | Never written to by this module, under any outcome (FR-8). |

## 6. Permissions

No *additional* per-action PIN. The Management App's `launchPin` (Domain Model §2.11) gates the whole app once per session; this module adds no further gate.

## 7. Inputs / Outputs

**Inputs:** one Completion CSV file per import action (parent-selected, FR-1); reads current Activity and Chore records across all Children/Instances (for FR-3's matching) and current Child records (for FR-5's cross-check) — does not write to either.

**Outputs (written to Management App storage):**
- New Imported Completion Records, one per newly-matched row (§2.6/FR-8) — a distinct data set from authored Course/Lesson/Activity/Chore/Instance content.
- An unmatched-row report per import (FR-4), retained for parent review, not auto-discarded.
- An import summary (FR-9), not persisted beyond the session unless the parent chooses to keep it (a TDS-level detail, not specified further here).
- No change whatsoever to any Course, Lesson, Activity, Chore, Course Instance, Curriculum, Difficulty Tier/Category, or Child record.

## 8. Acceptance criteria

1. Importing a well-formed CSV whose every row matches a current Activity or Chore produces one Imported Completion Record per row, and a summary reporting zero unmatched rows.
2. A CSV missing one or more of the eleven locked columns is rejected in its entirety before any row is processed — no partial import results.
3. A CSV with all required columns, where one row's `activityId` matches nothing current (e.g., its Instance was since deleted), imports every other valid row normally and reports that one row as unmatched — never rejecting the whole file over it.
4. A row whose `childName` doesn't match the Child actually owning its matched `activityId` still imports, with a warning surfaced in the summary naming both values.
5. Re-importing the exact same file a second time produces zero new Imported Completion Records and a summary reporting every row as "already imported," not as an error.
6. A row with a `status` value other than `complete` or `waived` is treated as unmatched/reported, not imported, even if its `activityId` would otherwise resolve.
7. After any import, no Course, Lesson, Activity, Chore, Course Instance, or Child record shows any change whatsoever.
8. A Chore row imports and matches correctly based purely on `activityId`, regardless of the `choreType`-derived `activityType` value or the blank `course` cell (§2.5) — matching never inspects those two columns; and two rows for the same recurring Chore on different dates import as two distinct Imported Completion Records.
9. The import summary always distinguishes newly-imported, already-imported, and unmatched counts as three separate numbers — never collapsed into one "processed" figure.
