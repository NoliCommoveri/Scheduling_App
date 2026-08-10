# Technical Design Specification — Slice
## M8 Scope: Management App — Course Template Library, Bulk CSV Import & Lesson Content Planning

*Covers: SRS_Management_Module_03_Course_Template_Library.md FR-5 (Bulk import Lessons + Activities via CSV) and FR-P1–FR-P6 (Lesson Content Planning presets). Written against that SRS's §2 (scope split), §4 (entity fields), §6 (content planning rationale), §8 (payload shape reference), §9 (validation rules); Domain Model §2.4/§2.5/§2.8; Architecture Evaluation §7 (14-file list — `courses.js` is the sole owner, no new file); `TDS_Slice_M5_Management_App_Rev7.md` §1/§2 (store table, ID scheme, `by_lessonId`/`by_courseId` indexes this slice reads) and `TDS_Slice_M7_Management_App_Rev1.md` (current schema version, confirmed unchanged by this slice); the actual `management-app/js/courses.js` and `storage.js` as shipped at M5/M7 (ID-minting format, payload shapes, reserved-code list — read directly, not re-derived from the SRS prose, per CLAUDE.md §II.1's "verify code matches doc" gate).*

*Does not cover: Chore/Family Event bulk import (not offered, by design — SRS Modules 06 §2.2/07 §2.4), Master Reporting (M9), Completion Import (M10), Settings/Backup (Module 11, remainder of M8 per the Roadmap — a separate TDS slice), Activity Type CRUD (Module 12, already built at M5).*

*Status: buildable as written. No IndexedDB schema or version change — see §2.*

---

## 0. Revision note

**Initial M8 slice**, authored on request after a pre-build audit found no TDS slice existed for bulk import (`courses.js:4`'s own header comment flags both FR-5 and FR-P1–P6 as "M8 scope — not built here"; `docs/Roadmap_Schedule_App.md` confirms M7 is the latest completed milestone). Per CLAUDE.md §II, this document exists so the halt condition is resolved before any code is written. Nothing here reopens an SRS-level decision — it fixes the *how* for FR-5/FR-P1–P6's already-locked *what*.

---

## 1. Decided here (TDS-level calls)

- **File: `courses.js` only.** Both FR-5 and FR-P1–P6 govern Course/Lesson/Activity records this file already owns exclusively (Architecture Evaluation §7's 14-file list has no separate bulk-import file). No new file, no new module boundary.

- **No IndexedDB store or version change.** `courses`, `lessons`, `activities` are already `keyPath: 'id'`, flexible-shape stores (`storage.js` `EMPTY_STORES`) at schema version 3 (unchanged since M7). Every field this slice adds — Lesson's `pageRangeStart`/`pageRangeEnd`/`activityCountTargets[]` — is optional and read only by direct Lesson-id lookup or via the existing `by_lessonId` index (created at M5, TDS_Slice_M5 §2). Bulk-imported Activities reuse the exact same record shape and `by_lessonId` index manual Activities already use. **DB stays at version 3.**

- **CSV format: comma-delimited, RFC4180-style quoting, 16 locked columns, exact header match required.** Per SRS §2.3's precedent (Completion Import's eleven-column header standing in for a version field), this file's header is validated as a whole-file gate before any row is read: missing column, extra column, or wrong order ⇒ reject the whole file with a plain message, no partial interpretation. No external CSV library (locked: vanilla JS, no build step) — a small hand-rolled parser handles double-quote-escaped fields (`""` → `"`) so `title`/`instructions` may contain commas.

  **Locked column order** (mirrors FR-5's own prose order: identity → payload → tier → conditional/optional):
  ```
  courseCode, lessonCode, lessonTitle, lessonOrder, activityType, title, required,
  pageRangeStart, pageRangeEnd, reference, text,
  difficultyTier, sequenceNumber, expectedDurationMin, instructions, blockHint
  ```
  `activityType` is the type's `activityTypeKey` (e.g. `pdf`, `quiz`, or a custom `AT-xxxxxx`) — the same machine key `courses.js` already stores on the Activity record, **not** the human-facing `label`. `difficultyTier` is the `tierId` (e.g. `D01`), matching the stored field. This is a TDS-level pick: the SRS says "payload fields per type" and "difficultyTier" without naming the CSV's exact reference form; keys were chosen over labels because keys are what the record actually stores and labels have no uniqueness guarantee to key off of (`activityTypes.js` FR-2 only guards label uniqueness at create time, not permanently).

- **Payload columns are populated per-type, per §8's existing map — a direct CSV projection of `buildPayload()`'s existing branching, not a new rule:**

  | `activityType` resolves to... | populated columns | blank columns |
  |---|---|---|
  | non-custom, `structurePattern: page-range` (`pdf`, `reading-pages`) | `pageRangeStart`, `pageRangeEnd` | `reference`, `text` |
  | non-custom, `structurePattern: count`, key ≠ `practice-level` (`video`, `quiz`, `test`, `report`, `workbook`, `project`, `drill`) | `reference` | `pageRangeStart`, `pageRangeEnd`, `text` |
  | non-custom, `practice-level` | *(none — payload is `{}`, §8)* | `pageRangeStart`, `pageRangeEnd`, `reference`, `text` |
  | custom (`AT-*`), any `structurePattern` | `text` | `pageRangeStart`, `pageRangeEnd`, `reference` |

  A row with the wrong columns populated for its resolved type (e.g. `reference` filled on a `pdf` row) is a row-level validation failure (§4 below), same severity as a missing required column.

- **Appending to an existing Lesson never edits that Lesson's stored `title`/`order`.** FR-5 requires `lessonTitle`/`lessonOrder` to be identical across every row *within the file* sharing a `lessonCode` (§9's "Bulk: Lesson consistency" — enforced, whole-file reject on mismatch), but is silent on whether an appending row's values must also match an *already-stored* Lesson's current `title`/`order`. Decided here: **they are not compared.** Bulk import only ever creates new Lessons or appends new Activities to existing ones (§2.1's own framing) — never mutates an existing Lesson record. Requiring the CSV's values to match a possibly-since-hand-edited Lesson would reject valid, otherwise-correct appends over what could be pure staleness in the parent's spreadsheet. The row's `lessonTitle` is still copied onto each newly-created Activity's own `lessonTitle` field regardless (FR-5, §4's copied-at-creation precedent) — that copy is independent of what the Lesson record itself currently says.

- **One IDB transaction per import, scoped `['lessons', 'activities']`** — same store scope `createActivity()` already uses, just batched. `courses` is read-only during import (courseCode resolution happens before the transaction opens; Course records are never written by this module, §11) so it is not part of the write transaction.

---

## 2. IndexedDB schema — unchanged

No store added, removed, or reshaped. No index added. Schema stays at **version 3** (`TDS_Slice_M7_Management_App_Rev1.md` §2). Two optional fields are added to the **Lesson** record shape (still `keyPath: 'id'`, no index touches them):

| Store | New optional fields | Written by |
|---|---|---|
| `lessons` | `pageRangeStart?`, `pageRangeEnd?` (integers, shared PDF+Reading-Pages budget, §6) | `courses.js`, manual Lesson create/edit only (FR-P1) |
| `lessons` | `activityCountTargets?` (`[{ activityTypeKey, targetCount }]`) | `courses.js`, manual Lesson create/edit only (FR-P2) |

Neither field is ever written by bulk import (FR-P5 — a CSV-created Lesson has no content plan until the parent adds one by hand).

---

## 3. Lesson Content Planning (`courses.js`, FR-P1–FR-P6)

All of this is manual-authoring UI logic — no new store, no new file, reuses the existing `by_lessonId` index (`storage.js`, created at M5).

**FR-P1/FR-P2 — capture on Lesson create/edit.** Extend the existing Lesson form (`createLesson`/`editLesson`, courses.js:195/207) with two optional groups: a page-range budget (`pageRangeStart`, `pageRangeEnd` — both-or-neither, `start ≤ end` if both present) and a repeatable count-target list (`activityTypeKey` + `targetCount`, one row per type, `targetCount` a non-negative integer). Extend `buildLessonRecord()` (courses.js:168) the same way the Activity path already handles optional fields (`normalizeOptionalActivityFields`/`applyOptionalActivityFields`, courses.js:249/280): present-and-blank ⇒ omit the property entirely, never store `null`/`""`/`0`-as-placeholder.

**FR-P3 — page-range pre-fill on manual Activity creation, `pdf`/`reading-pages` only.** When the Activity-create form's selected type resolves to non-custom `pdf` or `reading-pages` and the owning Lesson has both `pageRangeStart`/`pageRangeEnd` set:
1. `Storage.getAllByIndex('activities', 'by_lessonId', lessonId)`, filter to Activities whose `activityType` is `pdf` or `reading-pages` (both types draw from one shared budget, §6 — filtering by lesson alone is not enough).
2. Build the set of pages already covered, unioning each Activity's `[payload.pageRangeStart, payload.pageRangeEnd]`.
3. Pre-fill the form's `pageRangeStart` field with the lowest integer in `[pageRangeStart, pageRangeEnd]` not in the covered set; if the whole budget is covered, pre-fill `pageRangeEnd + 1` (past-budget extension, no warning — §6/FR-P3).
4. Never pre-fill `pageRangeEnd`. The value is a suggestion only — submitting a `buildPayload()` payload outside the budget, or overriding the start entirely, is never blocked or warned (existing `buildPayload()` page-range branch, courses.js:304, is otherwise unchanged — it still only checks `start ≤ end`).

A **custom** type given `structurePattern: page-range` never gets this pre-fill (§8) — its payload is the free-text branch (courses.js:321), which has no `pageRangeStart` field to pre-fill in the first place.

**FR-P4 — count-target display, read-only.** When rendering a Lesson's detail view or the Activity-create form for a `count`-structured type, if the Lesson has an `activityCountTargets` entry for that `activityTypeKey`, compute the current count (`by_lessonId` Activities filtered to that type, `.length`) and show `"{current} of {target}"`. No field this reads or writes participates in any validation path — purely a progress label.

**FR-P6 — `sequenceNumber` pre-fill for `count`-structured types.** When the Activity-create form's selected type has `structurePattern: count` (this already governs whether the form shows a `sequenceNumber` field at all, per the existing type-switch render logic, courses.js:704–730), pre-fill it with `(max sequenceNumber among by_lessonId Activities of that same activityType) + 1`, or `1` if none exist. This is a form-render default only — `createActivity()`'s actual write path (courses.js:328) already takes `fields.sequenceNumber` verbatim from the submitted form with no uniqueness check, so no change to `createActivity()` itself is needed; the pre-fill is purely what the empty form field initially contains before the parent can override it.

**FR-P5 is a non-requirement for this section** — it's the reason §1 and §4 below both state plainly that bulk-imported Lessons and Activities never read or write `pageRangeStart`/`pageRangeEnd`/`activityCountTargets`, and CSV rows carry no `sequenceNumber` pre-fill logic (they carry an explicit, required-when-applicable `sequenceNumber` column instead, §1).

---

## 4. Bulk CSV Import (`courses.js`, FR-5)

### 4.1 File selection & parse

Manual file selection (`<input type="file">`, `FileReader.readAsText`) — same swappable-acquisition treatment as Packet Import and Completion Import. The hand-rolled CSV parser splits on commas outside double-quoted fields, unescapes `""` → `"` inside quoted fields, and accepts either `\n` or `\r\n` line endings. **Header row is checked first, exact match to the 16 locked columns in the locked order (§1) — any deviation rejects the whole file before a single data row is read**, same severity and same reasoning as SRS §2.3's schema-level gate for Completion Import.

### 4.2 Per-row parse into a candidate record

For each data row, resolve (read-only, no writes yet):
- `course` = the Course template whose `courseCode.toLocaleUpperCase()` equals the row's `courseCode` (reusing the same comparison `courseCodeExists()` already uses, courses.js:48–52) — **unmatched ⇒ row invalid.**
- `type` = `Storage.get('activityTypes', row.activityType)` — **unresolved ⇒ row invalid** (FR-8).
- `tier` = `Storage.get('tiers', row.difficultyTier)` — **unresolved ⇒ row invalid** (FR-7).
- `lessonCode` — must pass the same `isAlphanumeric`/`isReserved` checks `validateLessonCode()` already applies (courses.js:184) — **fails either ⇒ row invalid.**
- `title` non-empty; `required` parses as exactly `"true"` or `"false"` (case-insensitive) or is blank (⇒ `false`) — any other literal value ⇒ row invalid.
- Payload columns populated/blank exactly per the §1 table for `type`'s resolved category — mismatch (wrong columns filled, or a required numeric field non-numeric, or `pageRangeStart > pageRangeEnd`) ⇒ row invalid, reusing `buildPayload()`'s own numeric/ordering checks (courses.js:303–326) against the CSV-sourced values instead of a form's.
- `sequenceNumber` required and must parse as an integer whenever `type.structurePattern === 'count'` (the same condition `createActivity()` already checks, courses.js:334) — present-but-not-required is not an error, just ignored on write for `page-range` types.
- Optional columns (`expectedDurationMin`, `instructions`, `blockHint`) run through the **existing** `normalizeOptionalActivityFields()` unchanged (courses.js:249) — same positive-integer and closed-block-hint-set rules as manual entry, blank ⇒ omitted.

### 4.3 Whole-file consistency checks (after every row parses individually)

- **Lesson consistency (§9):** group parsed rows by `(course.id, lessonCode)`; within each group, every row's `lessonTitle` and `lessonOrder` must be identical — **any mismatch ⇒ reject the whole file.**
- These two checks, plus every per-row check in §4.2, are **all evaluated before any write** — the import collects every failing row (not just the first) into a single report so the parent can fix a spreadsheet in one pass, but the outcome is still binary: **one or more failures ⇒ nothing is written, existing data is untouched** (§9's "Bulk: whole-file" rule — this module does not adopt Completion Import's partial-commit model, §2.3 of that SRS explicitly contrasts the two).

### 4.4 Write (only once every row and every group passes §4.2–4.3)

One `Storage.runTransaction(['lessons', 'activities'], 'readwrite', ...)`:

1. For each `(course, lessonCode)` group, resolve the target Lesson:
   - **Exists already** (matched by `lessonCode` under that `course.id`, same lookup as `lessonCodeExists()`) → append to it. Its stored `title`/`order`/`nextActivitySeq` are read as-is and **never overwritten** (§1's decided rule).
   - **Doesn't exist** → build a new Lesson record the same shape `buildLessonRecord()` produces (courses.js:168): `{ id: 'LSN-' + randomToken(), courseId: course.id, lessonCode, order: Number(row.lessonOrder), title: row.lessonTitle, nextActivitySeq: 1 }` — no content-plan fields (FR-P5).
2. Within each group, in the CSV's own row order (row order is the intended pacing walk order, same as manual `order`, §4 of the SRS's Three-Numbers table): for each row, mint
   `id = \`${course.courseCode}-TPL-${lesson.lessonCode}-${pad2(seq)}\`` using the target Lesson's running `nextActivitySeq` (starting from its current stored value — `1` for a just-created Lesson, whatever is persisted for an appended-to one), assign `order` from a running counter starting at the target Lesson's current Activity count (`0` for a new Lesson, `max(existing order) + 1` for an append — identical to `createActivity()`'s own `order` computation, courses.js:347–349), then increment both counters for the next row in the group.
3. Build each Activity record with the **same field set `createActivity()` writes** (courses.js:360–373): `id`, `lessonId`, `activityType`, `title`, `required`, `payload`, `difficultyTier: tier.tierId`, `capturesGrade: type.capturePattern === 'grade-optional'`, `order`, `lessonTitle: row.lessonTitle` (the row's own value, per FR-5 — not the Lesson's current stored `title`, and not re-read after step 1's Lesson resolution), plus `sequenceNumber` and any present optional fields.
4. `put()` every new/updated Lesson record and every new Activity record inside the one transaction; `put()` each touched Lesson exactly once at the end of its group (its final `nextActivitySeq`), not once per row — an internal batching choice, behaviorally identical to putting after every row since the transaction is exclusive and nothing else can observe the intermediate counter values.

### 4.5 Import summary

Surfaced to the parent after every import attempt (success or reject) — reusing the "always show the outcome" principle from Completion Import FR-9 even though this module's commit is all-or-nothing, not partial:
- **On reject:** the full list of failing rows with a reason per row (courseCode/lessonCode/activityType/tier unresolved, payload mismatch, lesson-consistency mismatch, etc.) — nothing was written.
- **On success:** counts of new Lessons created, existing Lessons appended to, and total Activities written.

---

## 5. Acceptance checks (build-session verifiable)

1. DB stays at version 3 across this change — no `onupgradeneeded` block added; a device already at v3 needs no upgrade to use bulk import.
2. A CSV whose header omits or reorders any of the 16 locked columns is rejected before any row is parsed.
3. A CSV with a valid header where one row's `courseCode` matches no existing template is rejected in its entirety — zero Lessons/Activities written, confirmed by re-reading `lessons`/`activities` counts before and after.
4. A CSV where two rows share a `lessonCode` but differ in `lessonTitle` is rejected in its entirety, even if every other check on both rows passes.
5. A CSV with a `pdf` row that has `reference` populated instead of `pageRangeStart`/`pageRangeEnd` is rejected (payload/type mismatch), not silently coerced.
6. A fully valid CSV creates the exact expected number of new Lessons and Activities, each Activity's `id` matching the `${courseCode}-TPL-${lessonCode}-{seq}` format with no gaps or reuse.
7. Re-running a valid CSV that adds rows under an already-existing `lessonCode` appends Activities to that Lesson (new `id`s continuing its `nextActivitySeq`) without creating a duplicate Lesson and without altering that Lesson's stored `title`/`order`.
8. A newly bulk-imported Lesson has no `pageRangeStart`/`pageRangeEnd`/`activityCountTargets` fields at all (absent, not empty/zero) until the parent edits it manually.
9. A Lesson with `pageRangeStart: 45`/`pageRangeEnd: 60` and one existing `pdf` Activity covering 45–47: the manual Activity-create form for a new `reading-pages` Activity under that Lesson pre-fills starting page 48.
10. A Lesson with a `video` `activityCountTargets` entry of `3` and 2 existing Video Activities shows "2 of 3" in its detail view; this number never blocks adding a 3rd, 4th, or stopping at 2.
11. Manually creating a 3rd `quiz` Activity under a Lesson with two existing `quiz` Activities numbered `sequenceNumber` 1 and 2 pre-fills `3`, freely overridable to any integer including a duplicate.
12. A CSV row for a `practice-level` Activity with `pageRangeStart`/`pageRangeEnd`/`reference`/`text` all populated is rejected (none of those columns are valid for `practice-level`).
13. Importing the same valid CSV file twice creates two full sets of Lessons/Activities the second time (no idempotency/dedup is claimed or implied by FR-5 — unlike Completion Import, §2.4 of that module, this path has no re-import no-op rule).
