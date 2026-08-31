# TDS Slice — Course Structure Expander

**Status:** Built.
**Scope:** Management App (`management-app/`) only. No schema, no migration, no Worker route, no credential class, no D1 write.
**Supersedes:** nothing. **Amends:** nothing.
**Date:** 2026-08-31

---

## 0. What this is, and what it is not

Ray builds a Course's Lessons and Activities from a MiAcademy curriculum in a
four-step chain. Steps 1, 2 and 4 are LLM passes done outside this app. Step 3
was a standalone HTML page that was lost. This slice rebuilds step 3 **inside
the Management App**, and moves most of step 4's mechanical work into it.

The chain, as it stands after this slice:

| Step | Where | Produces |
|---|---|---|
| 1 | ChatGPT, from curriculum screenshots | a **counts sheet** — Unit Name, Lesson Name, Activity Type, Activity Count |
| 2 | claude.ai, from the counts sheet + the ~700-page course PDF | a trimmed PDF and a **page map** — trimmed_page, original_page, Unit Name, Lesson Name |
| 3 | **this slice**, `#/expander` | a **proposal** in the bulk importer's own 12-column format, every mechanical column filled |
| 4 | claude.ai, from the proposal + the trimmed PDF | the same file with each `pdf` row split into named sub-ranges |
| — | `#/courses` → Bulk Import | Lessons and Activities in the app |

**This is a file converter, not a writer.** It reads four stores and produces a
download. Nothing here creates a Lesson or an Activity. That door stays exactly
one wide — `Courses.importActivitiesCsv()` — and the proposal has to leave for
the step-4 pass regardless, so a direct-write path here would only be a second,
less-validated importer. See §6.

### 0.1 Why inside the Management App rather than a fourth app

The three things this slice automates all need data only this app has:

- **`courseCode`** is a field on a Course Template, and the importer *rejects* a
  row whose code matches no template (`courses.js`, `templatesByCode`). A
  standalone page would have to ask for it to be typed.
- **`lessonCode` / `lessonOrder`** must not collide with the Lessons a Course
  already has. Only this app knows what those are.
- **`activityType`** must be one of the live `activityTypes` keys, and
  **`difficultyTier`** one of the live `tiers` ids. A standalone page would need
  its own copy of both, which would drift the first time a type is added.

A fourth app would also mean rewriting CLAUDE.md §I.A and §I.B. A module inside
an existing app needs neither. **No guardrail is amended by this slice.**

### 0.2 What is deliberately still an LLM's job

Splitting a Lesson's page range into named sections — `Guided Notes/Read and
Respond`, `Language Lab/Dig Deeper`, `Unit 4 Study Guide` — requires reading the
PDF. Nothing about it is derivable from the two input files, so the expander
emits **one `pdf` row per Lesson carrying the whole span and a blank title**,
and stops there. Duration outliers (a 25-minute project PDF against the
10-minute default) are the same kind of judgement and are left to the same pass.

---

## 1. Files

| File | Role |
|---|---|
| `management-app/js/expander-core.js` | Pure layer: workbook reading, the join, expansion. DOM-free, IO-free, no Storage. |
| `management-app/js/expander.js` | The `#/expander` page. Reads files and stores, renders, downloads. Computes no row. |
| `tests/management-expander-core.test.js` | `node --test`. 37 cases, including four real upstream artifacts. |
| `tests/fixtures/counts-general-science.xlsx` | A real counts workbook out of step 1. |
| `tests/fixtures/page-map-math-level-e.csv` | A real page map out of step 2. |
| `tests/fixtures/counts-math-level-h.xlsx` | A second real counts workbook — the one that failed in the field, kept as the regression. |
| `tests/fixtures/page-map-math-level-h.csv` | Its page map, missing one whole unit the counts sheet has. |

`tests/` is already excluded from the public asset bundle by `.assetsignore`, so
the fixtures are not served. They are unrelated to the repo-root `fixtures/`
deleted in Phase 5, which was packet-era interchange data (CLAUDE.md §I.B).

---

## 2. Reading the inputs

### 2.1 CSV

A hand-rolled RFC4180-ish lexer, mirroring the ones in `courses.js` and
`chores-csv-core.js`. Quoted fields, `""` escaping, `\n` or `\r\n`, and a
leading BOM stripped — Excel round-trips add one, and it would otherwise become
part of the first header cell and break the by-name lookup in §2.3.

Lesson titles routinely contain commas (`"Points, Lines, and Rays"`), so
`split(',')` is not an option anywhere in this slice.

### 2.2 XLSX

Step 1's output is a workbook, so the expander reads `.xlsx` directly rather
than asking for a manual re-save. A `.xlsx` is a ZIP of XML, and the inflate
comes from the platform: **`DecompressionStream('deflate-raw')`**, native in the
browser and in Node 18+. No library, no vendored code, **no build step** —
CLAUDE.md §0's vanilla-JS rule holds unchanged.

Three details that are load-bearing:

- **The central directory is the preferred path, not the local headers.** A
  local header may declare zero sizes and defer them to a data descriptor
  *after* the payload, which cannot be located without already knowing where
  the payload ends. (§2.2a adds a local-header fallback for the case where the
  central directory is gone because the file arrived truncated.)
- **Every `<t>` in a cell is concatenated.** A run-formatted cell splits one
  visible string across several `<r><t>` children; taking only the first would
  silently truncate a lesson title at a stray italic.
- **Cells are placed by their `r=` column letter, not by arrival order.** A row
  that omits an empty cell entirely would otherwise shift every column after the
  gap one place left.

Both shared strings (`t="s"`) and inline strings (`t="inlineStr"`) are handled —
the samples in hand use inline, most other producers use shared.

### 2.2a A workbook that arrives damaged

Reported from the field on Android: a file picked from a cloud folder rather
than local storage can reach the page as a **short read** — the picker states
the real size, the bytes stop early. The symptom is an unreadable workbook with
no other clue, and the natural error blames the file.

Three defences, in the order they fire:

1. **`File.size` is compared against what actually arrived.** A shortfall is
   reported as one — with both numbers and the fix (download it to the device
   first) — rather than as a parse failure.
2. **A missing or unusable central directory falls back to walking the local
   file headers from the front.** The sheet XML sits near the front of every
   workbook, so a file cut short at the end usually still reads in full. Entries
   whose sizes are deferred to a data descriptor (general-purpose bit 3) cannot
   be located this way and stop the walk rather than being guessed at.
3. **Whatever is left says how many bytes it got**, so a report from a phone
   carries enough to tell an environment problem from a parser one.

### 2.3 Neither file is read by column position

Both inputs come from an LLM reading screenshots and a PDF. Column order is not
a contract, and neither is capitalisation. Columns are located **by header
name**, squashed to lowercase alphanumerics, with a short alias list per field.
A missing column names itself in the error rather than reading as blank.

The file type is decided by **sniffing the first four bytes** for the ZIP
signature, not by the extension: a sheet saved as `.csv` but exported as a
workbook still reads.

---

## 3. Expansion

### 3.1 The join

`Unit Name` + `Lesson Name`, **exactly as written**, NUL-separated so no pair of
values can collide by concatenation.

Deliberately *not* normalised. Both files derive from the same source material
and carry the same curly apostrophes and en dashes (`Show, Don't Tell`,
`Context Clues – Synonyms`). Matching loosely would paper over a real
disagreement between the two files. **Every mismatch is reported, never
resolved** — see §4.

A Lesson's page range is the **lowest and highest `original_page`** the map
gives it. Interior gaps are dropped on purpose: they are the divider pages the
trim removed, and the span is a budget for step 4 to subdivide, not a page list.
Page numbers stay in **original** numbering throughout, matching what step 4
expects.

### 3.2 Row order within a Lesson

```
video → pdf → practice-level → online-sim → quiz
```

Video opens, the PDF carries the page budget, practice levels climb, the Online
Sim sits with the practice, and the assessment closes. A type not in this list
is emitted after these, in the order the counts sheet listed it.

Lessons themselves keep **first-appearance order** — the counts sheet is already
in curriculum order, and that order is not recoverable by sorting (unit numbers
are text; lessons are not ordered at all). A Lesson split across non-adjacent
rows sums rather than becoming two Lessons.

### 3.3 Column by column

| Column | Filled with |
|---|---|
| `courseCode` | the chosen Course Template's code |
| `lessonCode` | auto — see §3.4 |
| `lessonTitle` | Lesson Name, verbatim |
| `lessonOrder` | the same integer as the code |
| `activityType` | the seeded `activityTypeKey` — see §3.5 |
| `title` | `video`/`online-sim`: the Lesson name · `practice-level`: `Level N` · `quiz`: `Assessment` · **`pdf`: blank** |
| `required` | `TRUE`, always |
| `pageRangeStart` / `End` | the Lesson's span on the `pdf` row; **blank on every other row** |
| `difficultyTier` | per-type default, editable — `D02` for `quiz`, `D01` otherwise |
| `expectedDurationMin` | per-type default, editable — video 5, practice 5, pdf 10, sim 10, quiz 20 |
| `instructions` | empty, always |

The defaults are measured off the shipped `MIALANGARTSE` import. They are a
starting point, not a rule: the page shows them in an editable table, and the
outliers are what the step-4 pass is for.

An `Activity Count` above 1 for a type that normally appears once **numbers the
rows** (`Assessment 1`, `Assessment 2`) rather than emitting duplicates. None of
the sample courses does this; the alternative was two identical rows.

A blank `Activity Count` reads as 1. Zero is rejected with the row number — a
one-off activity with an empty cell is a likelier slip than an intended zero,
and zero would silently drop the row.

### 3.4 Lesson codes

`L` + the number, zero-padded to the width of the highest number in the batch —
two digits until a course outgrows them, then three (`L01`…`L99`, `L100`), so
codes in one file sort as text the way they sort as numbers.

Numbering **continues from the Lessons the Course already has**: the next free
`L`-number, computed from the existing codes, shown on the page and editable.
The sample import started at `L03` for exactly this reason. Codes that are not
`L`-numbers are ignored rather than guessed at.

### 3.5 Activity types

Counts-sheet labels are squashed (lowercased, non-alphanumerics dropped) and
looked up in an alias table onto the keys seeded in `storage.js` — so
`Practice Level`, `practice-level` and `PracticeLevel` all reach
`practice-level`.

An unrecognised label passes through kebab-cased **with a warning**, rather than
failing here. Deciding which Activity Types exist is the importer's job, and it
already names the offending row; this layer's job is to say so early.

**A `PDF` row in the counts sheet is ignored, with a warning.** Page ranges come
from the page map and a Lesson gets exactly one `pdf` row; honouring the count
would emit page-less rows the importer would reject.

---

## 4. Mismatches are reported, never resolved

| Case | Behaviour |
|---|---|
| Lesson in the counts sheet, absent from the page map | no `pdf` row; listed in a warning |
| Lesson in the page map, absent from the counts sheet | **no rows at all**; warned individually with its page range, because this is the case that silently loses work |
| Activity Type not in the app | row emitted, warning names the type and where to add it |
| `PDF` in the counts sheet | ignored in favour of the page map, warned |
| Malformed row (blank Lesson, non-positive count, non-numeric page) | **nothing is generated**; every offending row is listed by its sheet row number |

The last one mirrors the importer's own all-or-nothing posture. A proposal with
one row quietly missing is worse than no proposal: the gap surfaces months later
as a Lesson the child never gets.

---

## 5. The page (`#/expander`)

Under the **Library** hub, beside Course Templates. Three numbered sections —
Course, Files, Defaults — then Generate.

The result panel shows: a count of Lessons and rows with the code range, a tally
per Activity Type, the warnings (or an explicit "no mismatches"), the **first
Lesson** as a sanity check that the join landed, and the download button. The
blank `pdf` title renders as *(blank — for the LLM to name)* so the preview is
not mistaken for a half-finished file.

Downloads as `{courseCode}_lesson_activity_import_proposed.csv`.

With no Course Templates yet, the page says so and links to `#/courses` instead
of offering a form that could only produce a rejected file.

---

## 6. Write scope

**This module writes nothing.** It reads `courses` (templates), `lessons`
(existing codes), `activityTypes` and `tiers`. It creates no record, mints no
id, and touches no store.

This is the property to preserve. If a future session is tempted to add "import
it directly from here", the reasons not to are: the proposal is incomplete by
design (blank `pdf` titles) and must leave for step 4 anyway; and
`importActivitiesCsv()` carries per-row validation, whole-file Lesson
consistency checks and an all-or-nothing write that would have to be duplicated
or bypassed.

---

## 7. Acceptance

Automated — `npm test`, `tests/management-expander-core.test.js`:

1. CSV lexing: quoted commas, escaped quotes, CRLF, BOM.
2. `CSV_COLUMNS` still matches `courses.js`'s array exactly. **This is the test
   that fails first if the importer's contract is ever reordered.**
3. The real `.xlsx` fixture reads to 55 rows with correct headers and values.
4. The real page-map fixture reads to 169 rows with `Points, Lines, and Rays`
   intact through the quoting.
5. Run-formatted cells, shared strings, absent cells, XML entities.
5a. §2.2a: a short read is named as such; a workbook with its central directory
    chopped off still reads all 190 rows through the local-header walk; a file
    that is not a workbook reports its byte count.
6. Header lookup by name regardless of order/casing; a missing column is named.
7. Emission order; titles per type; counts above one numbered.
8. `pdf` row carries the span with a blank title; page columns blank elsewhere.
9. Each of the four mismatch cases in §4 produces its warning.
10. Lesson codes continue, pad, and stay in curriculum order.
11. End to end on both fixtures, with the output re-parsed and the header
    checked against `CSV_COLUMNS`.
11a. End to end on a second real course (Math Level H, 91 Lessons, 605 rows)
     where a whole unit is present in the counts sheet and absent from the page
     map — the join lands, and §4's warning names it.

Manual, once, on the deployed app:

12. `#/expander` renders under Library with the Course Template list populated.
13. Choosing a Course with existing Lessons shows the correct next number.
14. A generated file imports cleanly at `#/courses` → Bulk Import once its `pdf`
    titles are filled in — and is **rejected** with a per-row message if they
    are not, which is the intended safety net.

---

## 8. Open

- **Unit names are dropped.** The 12-column import format has no unit concept,
  and Lessons carry a flat course-wide order. The unit column is used only for
  the join key. If units ever need to survive into the app, that is a Course
  Template question, not an expander one.
- **`online-sim` titles are the Lesson name.** The counts sheet gives a type and
  a count but no name; the real names in the sample (`Writing to Inform:
  Research`) came from the screenshots. Renaming them is part of the step-4 pass.
