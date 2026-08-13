# Technical Design Specification — Slice
## Chore Bulk CSV Import (Management App, Module 06)

*Covers: `SRS_Management_Module_06_Chore_Authoring.md` FR-8 (Bulk import Chores via CSV), added by Amendment A1 to that module. Written against that SRS's §2.6 (the closed `choreType` enum), §4 (FR-1's field list), §5 (the validation table), §7 (inputs/outputs); `TDS_Slice_Shared_Chores.md` §2.2–§2.4 (`childIds`/`allocation`/`childDays`/`instances`) and §4.3 (the `claim` + `childDays` exclusion); `TDS_Slice_M8_Management_App.md` §1/§4 (the Lesson/Activity CSV importer this one is modelled on, read directly rather than re-derived); and the actual `management-app/js/chores.js`, `children.js` and `courses.js` as shipped, per CLAUDE.md §II.1's verify-code-against-doc gate.*

*Does not cover: Family Event bulk import (still not offered — SRS Module 07 §2.4); any change to Chore generation, Propose, or the `assignments` table; any D1 schema or Worker change (§2).*

*Status: authored 2026-08-13, ahead of the build in the same session.*

---

## 0. Revision note

**Why this slice exists.** SRS Module 06 §2.2 recorded an *assumption*, not a
principle: chores were expected to number in the handful, so no CSV path was
built, and the passage closed with "**Flag if your actual chore list is large
enough to want bulk import — nothing here would need to change architecturally,
it just isn't built.**" That flag has now been raised. The assumption is
withdrawn; the architecture claim it made turns out to be correct, and this
slice is the evidence: no store, no index, no migration, no Worker route, no
new validation rule.

Per CLAUDE.md §II.2 a milestone with no TDS slice is a halt condition. This
document exists so that condition is resolved before code is written — the same
sequence `TDS_Slice_M8_Management_App.md` §0 records for the Lesson/Activity
importer, which was likewise authored after a pre-build audit found the design
missing. Nothing here reopens an SRS-level decision about what a Chore *is*;
it fixes the *how* for a new entry path to the record `chores.js` already owns.

**What changes in the SRS** (Amendment A1 there, landed alongside this slice):
§2.2 is rewritten from "no bulk import" to "bulk import, flat rows only";
§5's `Bulk import` row changes from "Not offered" to the rules below; FR-8 is
added; acceptance criterion 7 is inverted; a new criterion 8 covers the
subset rule of §1.

---

## 1. Decided here (TDS-level calls)

- **The CSV carries the flat fields only. `childDays` and per-occurrence
  `blockHint` are not importable.** A Chore's field set is flat except for two
  members: `childDays` (a map of child → day list) and `instances[]` (a list of
  objects). A comma-delimited flat file represents a *list* in a cell tolerably
  and a *map* not at all, and the two nested fields are exactly the ones a
  household has a handful of, not hundreds — which is to say they are outside
  the volume argument that justifies this path at all.

  Decided: **`instances` is importable as a list of labels** (§3, one cell,
  `|`-separated), and **`childDays` is not importable at all** — a bulk-created
  Chore always gives every participant the same `daysOfWeek`, and a parent who
  wants a per-child split adds it afterward in the edit form. This is the same
  shape of call `TDS_Slice_M8` §1/FR-P5 made when it kept Lesson content-plan
  fields (`pageRangeStart`, `activityCountTargets[]`) out of the Activity CSV:
  bulk import creates the bulk, hand-editing refines it. A row that would need
  `childDays` is not rejected — it is simply imported without the split, which
  is a valid Chore.

  Consequence worth stating: because `childDays` is never set by this path,
  `TDS_Slice_Shared_Chores.md` §4.3's `claim` + `childDays` rejection can never
  fire on an imported row. The rule still holds; it is unreachable from here.

- **Nine locked columns, exact header match, whole-file gate.** Same treatment
  and same reasoning as `TDS_Slice_M8` §1 — the header stands in for a version
  field, and a missing, extra, renamed or reordered column rejects the file
  before a single data row is read, with a message naming the nine columns it
  wants.

  **Locked column order** (mirrors FR-1's own prose order: participants →
  identity → schedule → tier → optional):
  ```
  children, title, choreType, daysOfWeek, allocation, difficultyTier,
  instances, blockHint, notes
  ```
  Required non-blank: `children`, `title`, `choreType`, `daysOfWeek`,
  `difficultyTier`. Blankable: `allocation` (⇒ `each`), `instances` (⇒ one
  unlabeled occurrence), `blockHint` (⇒ omitted), `notes` (⇒ omitted).

- **`|` is the list separator in every multi-valued cell**, and the only one.
  `children`, `daysOfWeek` and `instances` all use it. It is not a
  free-for-all: `,` is the field delimiter, `/` occurs inside a canonical
  `choreType` (`Kitchen/Dining`) and inside the day phrasings `PacingCore`
  accepts, and `;` reads as a clause separator in the pacing hint. `|` collides
  with nothing in this domain. Surrounding whitespace around each element is
  trimmed, so `Mon | Wed | Fri` and `Mon|Wed|Fri` are the same cell.

- **`children` names Children by *name*, with the record id as an escape
  hatch — a deliberate divergence from `TDS_Slice_M8` §1's keys-over-labels
  rule.** That rule was chosen because a household has dozens of Activity Types
  and `activityTypes.js` FR-2 guards label uniqueness only at create time, so a
  duplicate label is both plausible and silent. Neither half holds here: a
  household has two to five Children, and this file is rejected as a whole on
  any row failure, so an ambiguous name is *reported*, never guessed at.

  Resolution, per cell element:
  1. If the element matches `^CHI-` it is looked up as a record id directly.
  2. Otherwise it is matched case-insensitively against the `name` of every
     **active** Child (`Children.isActive`).
  3. Zero matches ⇒ row invalid. **Two or more matches ⇒ row invalid**, with a
     message naming the ambiguity and the `CHI-…` ids to disambiguate with.

  Archived Children do not resolve by name, matching the create form, which
  offers only active Children (`buildParticipationFieldset`'s `eligible`). An
  archived Child can still be named by explicit id — the escape hatch is
  literal, and the manual path likewise keeps an already-participating archived
  Child rather than silently dropping them.

- **`difficultyTier` is the `tierId`** (e.g. `D01`), matching both the stored
  field and `TDS_Slice_M8` §1's identical call for the Activity CSV. Tier
  labels are not accepted; there is no reason for the two importers to disagree
  about how a tier is named.

- **`choreType` is the canonical value verbatim**, one of the eleven of SRS
  §2.6 — `Kitchen/Dining`, `Parent's Room`, and the rest, spelled and cased
  exactly. Not a key, because `choreType` has no key: the enum *is* the stored
  value. Comparison is exact, not case-folded, so a spreadsheet that
  title-cases or lowercases a value fails loudly rather than writing a value
  that would later fail whole-packet validation on the child device (§2.6).

- **No whole-file consistency check, and no dedup.** The Activity CSV has one
  (`lessonTitle`/`lessonOrder` must agree across rows sharing a `lessonCode`)
  because its rows *group*. Chore rows do not group — each row is one whole,
  independent record with no shared parent and no natural key. So the only
  whole-file rule is the all-or-nothing commit itself. Re-importing the same
  file creates a second full set of Chores, exactly as `TDS_Slice_M8` §5.13
  states for Activities; this path claims no idempotency and implies none.

- **File: `chores.js` for the wiring, plus one new pure file,
  `chores-csv-core.js`, for the parse and per-row validation.** Module 06's
  ownership is unchanged — `chores.js` remains the only writer of the `chores`
  store, and no other module gains a Chore code path. The split is the one
  `recipe-core.js` and `pacing-core.js` already established in this app: the
  logic worth testing (CSV lexing, cell splitting, enum and shape checks, the
  child-name resolution rule) is DOM-free and IO-free, takes plain lookup data
  as an argument, and returns plain data, so `tests/` can exercise it directly
  per CLAUDE.md §I.B. Everything that touches `Storage` or the DOM stays in
  `chores.js`.

- **The importer never writes a record the manual form would reject.** Every
  candidate `chores-csv-core.js` produces is passed through `chores.js`'s
  **existing** `validateFields()` before anything is written, and built with
  its **existing** `buildRecord()`. The core's own checks are there to produce
  a good per-row error message and to fail the whole file early; they are not a
  second, parallel definition of a valid Chore. If the two ever disagree,
  `validateFields()` wins by construction, because it runs last and its
  rejection aborts the import.

---

## 2. Storage — unchanged

No IndexedDB store added, removed, or reshaped; no index added; **no schema
version change**. `chores` is already a `keyPath: 'id'` flexible-shape store
(`storage.js` `EMPTY_STORES`), and an imported Chore is byte-for-byte the same
record shape `createChore()` writes — `buildRecord()` is the one builder for
both paths.

**No migration, and no Worker change.** Chores are Management-App authoring
records; they reach D1 only as generated `assignments` rows through Propose
(`packet.js`), which is untouched. Nothing in this slice goes near a migration
file, `management-app/worker/`, or a credential — so CLAUDE.md §III.D and
§III.E have nothing to enforce here.

---

## 3. The `instances` column

`TDS_Slice_Shared_Chores.md` §2.2–§2.4: `instances` is an optional list of
occurrences per day, absent meaning one unlabeled occurrence, each entry
`{ id, label?, blockHint? }` with `id` unique within the Chore and containing
no `-` (the Generation Log's occurrence id parses on `-`, §3.2 there).

The column carries **labels only**, `|`-separated:

```
Breakfast|Lunch|Dinner
```

- Blank ⇒ the property is omitted entirely ⇒ one unlabeled occurrence per day,
  which is today's behaviour and the overwhelmingly common case.
- Non-blank ⇒ one occurrence per element, in the cell's own order, each with a
  freshly minted `id` (`randomToken()`, the same minter the Add-occurrence
  button uses) and the element as its `label`.
- **`id`s are minted, never authored.** There is no column for them and no way
  to supply one. This is what makes the "no `-`" and "unique within the Chore"
  rules unfailable from this path rather than merely checked: `randomToken()`
  draws from `[a-z0-9]`, and the minter re-rolls within the row until the row's
  ids are distinct.
- **Per-occurrence `blockHint` is not importable** (§1). The row's single
  `blockHint` column applies to the Chore as a whole, which is the field
  `instancesOf()` consumers fall back to anyway.
- An empty element (`Breakfast||Dinner`) or a duplicate label is a row-level
  failure — the first is almost always a stray separator, and the second would
  produce two occurrences a parent cannot tell apart on the plan.

---

## 4. Import flow

### 4.1 File selection & parse

Manual `<input type="file">` + `FileReader.readAsText`, and a **Download blank
template** button beside Import — both mirroring `courses.js`'s bulk-import
section, including the template being emitted from the same `CSV_COLUMNS`
constant the header gate validates against, so the two cannot drift. The
template is a header row only: it is itself a valid import that writes nothing.

The CSV parser is the same hand-rolled RFC4180-ish reader (comma-delimited,
`""` → `"` inside quoted fields, `\n` or `\r\n`, blank lines dropped). It is
**re-implemented in `chores-csv-core.js`, not imported from `courses.js`** —
the two modules do not share runtime code, and a ~20-line lexer is the cheaper
side of that trade against a cross-module dependency between two SRS modules.
(This is intra-app, so CLAUDE.md §I.A's cross-*app* prohibition is not what is
being weighed; the module boundary in §I.B is.)

Header row is checked first, exact match to the nine locked columns in the
locked order — any deviation rejects the whole file before a data row is read.

### 4.2 Per-row validation (`chores-csv-core.js`, pure)

Given a row object and a lookup bundle `{ children, tierIds }` (plain arrays,
resolved once by `chores.js` before any row is read), each row is checked in
this order, first failure reported:

| Column | Rule |
|---|---|
| `children` | Non-blank; splits to ≥1 element; every element resolves per §1 (id form, else unique active name); no duplicate resolved id within the row |
| `title` | Non-blank after trim |
| `choreType` | Exactly one of the eleven canonical values (§2.6) |
| `daysOfWeek` | Non-blank; every element one of `Sun`–`Sat`; no duplicates |
| `allocation` | Blank ⇒ `each`; otherwise exactly `each` or `claim` |
| `difficultyTier` | Resolves to an existing `tierId` |
| `instances` | Blank ⇒ omitted; else every element non-empty and distinct (§3) |
| `blockHint` | Blank ⇒ omitted; else one of `morning`/`afternoon`/`evening`/`night` |
| `notes` | Free text; blank ⇒ omitted |

Every failing row is collected, not just the first, so a parent fixes a
spreadsheet in one pass — same as `TDS_Slice_M8` §4.3. The outcome is still
binary.

### 4.3 Write (`chores.js`, only once every row passes)

1. Each candidate's fields go through the existing `validateFields()` (§1's
   last-gate rule). Any error ⇒ the whole import is rejected, nothing written.
2. One `Storage.runTransaction(['chores'], 'readwrite', …)`:
   - `getAll()` once, building the set of tokens already in use
     (`c.id.slice(4)`, the stem after the fixed `CHR-` prefix, exactly as
     `createChore()` reads it).
   - For each candidate in file order, mint a token not in that set **and not
     already minted in this batch**, adding it to the set as it goes; bounded
     at 10 attempts per row as `createChore()` is, and an exhausted budget
     aborts the transaction so nothing is written.
   - `put()` each `buildRecord('CHR-' + token, fields)`.

   Reading existing tokens once inside the write transaction is what makes the
   batch safe in the way `createChore()` is safe individually: the read and
   every write are in one exclusive transaction, so two concurrent imports
   cannot both observe the same token free.

### 4.4 Import summary

Surfaced after every attempt, success or reject, per `TDS_Slice_M8` §4.5:

- **On reject:** the full list of failing rows, one reason each, and a plain
  statement that nothing was written.
- **On success:** the count of Chores created, and the count of Children they
  were authored against.

---

## 5. Acceptance checks (build-session verifiable)

1. The IndexedDB schema version is unchanged by this slice, and no migration
   file is added — a device already on the current version needs no upgrade to
   use chore bulk import.
2. A CSV whose header omits, adds, renames or reorders any of the nine locked
   columns is rejected before any row is parsed, with a message naming the nine.
3. The downloaded template's single line matches the locked header byte for
   byte; re-uploading it unchanged is accepted and reports 0 Chores written
   rather than erroring.
4. A file where one row names a Child that matches no active Child is rejected
   in its entirety — zero Chores written, confirmed by a `chores` count before
   and after.
5. A file naming a Child whose name matches two active Children is rejected,
   and the message names both `CHI-…` ids; the same file with those ids
   substituted for the ambiguous name imports cleanly.
6. A row naming an **archived** Child by name is rejected; the same row naming
   that Child by `CHI-…` id succeeds.
7. A row whose `choreType` is `kitchen/dining` (wrong case) is rejected — the
   comparison is exact, and no value outside the eleven is ever written.
8. A row with `allocation` blank produces `allocation: 'each'`; a row with two
   participants and `allocation: claim` produces a `claim` Chore, and no
   imported Chore ever carries a `childDays` property (§1).
9. `instances: Breakfast|Lunch|Dinner` produces three occurrences in that
   order, with distinct minted ids containing no `-`, and those labels; a blank
   `instances` cell produces a record with **no** `instances` property at all
   (absent, not `[]`).
10. A row with `instances: Breakfast||Dinner`, and one with
    `instances: Dishes|Dishes`, are both rejected.
11. Every Chore written by import has the identical key set a hand-authored
    Chore of the same shape has — `buildRecord()` is the only builder, so an
    imported record carries no extra property and no `null` placeholder.
12. Every imported `id` matches `CHR-` + a six-character `[a-z0-9]` token, all
    distinct within one import and none colliding with a pre-existing Chore.
13. Importing the same valid file twice creates two full sets of Chores; no
    idempotency is claimed (mirrors `TDS_Slice_M8` §5.13).
14. A file with one valid row and one invalid row writes **nothing** — the
    valid row is not partially committed.
