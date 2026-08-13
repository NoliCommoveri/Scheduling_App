# TDS Slice — Lesson Recipe, Activity Record Reduction, and Card Rework

**Date:** 2026-08-13 · **Status:** authored for build · **Supersedes:** `Lesson_Recipe_Handoff.md` §§2–10

> This slice replaces the design in the handoff document. Where the two differ, this wins.
> The handoff's O1 ("should Practice Level and Quiz have different payload shapes at all?") is
> **resolved here as yes-collapse** — `reference` is deleted outright, and `title` carries what it
> used to. That decision cascades into the Activity record, the Activity Type table, the packet
> generator, the Worker, the D1 schema, and the Child App card, which is why those are all one
> slice rather than four.

---

## 1. Scope and phasing

Three apps' worth of change, built in this order. Each phase leaves the system working.

| Phase | Scope | Contents | Est. |
|---|---|---|---|
| **1** | Schema + Worker | `0008` migration, registry, three Worker sites | ~0.5h |
| **2** | Management App | Activity record reduction, type table, `packet.js` projection | ~1.5h |
| **3** | Management App | The recipe — planner, form, copy-from-lesson; per-Course title patterns and Course settings copy | ~3h |
| **4** | Child App | Card rework, lesson grouping, `bySequenceNo` deletion | ~2h |

Phases 2 and 3 are one declared scope (Management App); phase 4 is its own (Child App). No runtime
code is shared between them — only the `assignments` schema and the API, as always.

**Phase 4 subsumes the handoff's Phase A.** The `bySequenceNo` defect (handoff §11.1) is not fixed
separately: `sequence_no` ceases to exist, so the sort built on it is deleted rather than repaired,
and the lesson grouping it was standing in for is built properly.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | Expansion mints **real Activity records**, never one record carrying a count | Pacing distributes by record (`pacing.js:34`), so one record cannot span Tuesday and Wednesday. Rewards, grades, and deferment are per-record too. |
| **D2** | Rewards stay **per Activity row** | A child earns per item. Twelve practice levels are twelve earning opportunities. Unchanged behaviour. |
| **D3** | The recipe is a **one-time generator, not a live template** | After expansion the Activity records are the truth. Nothing re-syncs. |
| **D4** | The recipe is offered **only while the Lesson has zero Activities** | Makes D3 enforceable rather than merely documented. `hasActivitiesUnderLesson` (`courses.js:63`) already exists and already gates lesson-code edits. Deleting every Activity reopens the recipe; `nextActivitySeq` does not rewind, so ids simply continue. |
| **D5** | **`reference` is deleted.** `title` carries it | The `PAGE_RANGE_KEYS`/`REFERENCE_KEYS` split (`packet.js:46-47`) partitioned the canonical types **by name**, decided once, derived from nothing. "Quiz Assessment" needed a hand-typed reference exactly as much as "Practice level 3" did — not at all. With titles auto-filled per type, a second string naming the same thing is redundant. |
| **D6** | Order is stamped **once, at the course template**, and never re-asked during date-stamping | Instance stamping is `{ ...ta, id: newId, lessonId: newLesson.id }` (`children.js:194`) — the spread carries `order` byte-for-byte, so one ordering serves every child stamped from that course, including children stamped later. The generation screen gains **no** reorder control. |
| **D7** | Reordering happens on the **proposal**, before anything is written | Not a contradiction of D6: the proposal is form state, not storage. D6 is about the date-stamping screen. |
| **D8** | Titles are **prefilled per type and always editable** | Sometimes the video titles genuinely are different. Prefill, never dictate. |
| **D9** | Each page-range chunk carries **its own editorial title** | "Guided Notes" / "Fraction Detective" have no derivable pattern. |
| **D10** | One transaction; `nextActivitySeq` advanced by N once | A partial expansion leaves a Lesson half-built with no record of intent. Ids are minted **from the counter**, never `max(existing) + 1`. |
| **D11** | **A Lesson holds at most one page-range type** | Stated as fact about the curriculum: PDF is MiAcademy's, Workbook belongs to other publishers, and they never co-occur. This makes the Lesson's single `pageRangeStart`/`pageRangeEnd` budget unambiguous, gives the recipe exactly one split field, and lets two hardcoded key-lists become honest `structurePattern` tests. |
| **D12** | **Dead columns are removed, not tolerated** | `sequence_no` loses its last consumer in this slice and is dropped from D1 by migration `0008`. `blockHint`, `capturesGrade`, `lessonTitle`, `reference`, `text`, and `payload` leave the Activity record. Nothing is kept "in case". |
| **D13** | Title patterns are **overridable per Course**, in one sparse field | Courses differ in house style — a spelling curriculum names things nothing like MiAcademy — and the alternative is retyping the same override on every Lesson of an outlier course. Sparse, because a course touches 3–5 types; absent keys fall through to the built-in defaults, so improving a default still reaches every course that has not opted out. Overriding a type takes it over at every count, which keeps this one string per type rather than two. |

---

## 3. The Activity record

`activities`, IndexedDB, Management App. **Twelve fields**, down from fourteen plus a JSON blob.

| Field | Type | Required | Purpose |
|---|---|---|---|
| `id` | string | ✔ | PK. `{courseCode}-{TPL\|instanceToken}-{lessonCode}-{NN}`, minted from `lesson.nextActivitySeq`, never reused, never recomputed |
| `lessonId` | string | ✔ | FK. Grouping key; `by_lessonId` |
| `activityType` | string | ✔ | Card line 2, left. Decides whether a page range applies |
| `title` | string | ✔ | Card line 2, right. Carries what `reference` used to |
| `order` | int | ✔ | Pacing walk order and within-lesson display order |
| `difficultyTier` | string | ✔ | → `rewardCategoryId` → what the completion earns |
| `required` | bool | ✔, **default true** | Streak gate (`streak-core.js:20`) and overdue roll-forward (`planner-core.js:167`) |
| `pageRangeStart` | int | — | Card line 3 |
| `pageRangeEnd` | int | — | Card line 3 |
| `instructions` | string | — | Opens the modal. Present ⇒ button renders |
| `expectedDurationMin` | int | — | Pacing `minutesBudget`; Instructional Hours |
| `excludeFromGeneration` | bool | — | Set at Commit (`packet.js:781`), filters the pending remainder (`packet.js:269`), stripped before sync (`sync.js:349`). Never written by the recipe |

Indexes unchanged: `by_lessonId` (grouping), `by_activityType` and `by_difficultyTier` (the delete-guards in Modules 12 and 02).

### 3.1 What leaves, and why

| Dropped | Reason |
|---|---|
| `payload` | One shape survives D5. A JSON wrapper around a single possible shape is two nullable columns wearing a hat. `pageRangeStart`/`pageRangeEnd` are promoted to top-level. |
| `reference` | D5. |
| `text` | The same field under another name for `AT-` types. Custom types now use title + instructions like everything else, which deletes the custom/canonical branch from `buildPayload` (`courses.js:360`), its CSV twin (`:576`), `renderPayloadFields` (`:1229`), and `children.js:938`/`:963`. |
| `blockHint` | Dead on arrival. Collected, validated against the canonical four, stored — and never read. `placeActivity` (`packet.js:226`) sets a row's hint only from `blockHintFor()`, which round-robins the pacing profile's `blockLayout`. Dropping the field changes no emitted row. |
| `capturesGrade` | A pure function of `activityType`, and `capturePattern` is immutable, so it cannot drift. Computed at projection instead, which deletes three copies that currently have to stay in sync (`courses.js:451`, `courses.js:701`, `children.js:428`). |
| `lessonTitle` | Derivable from `lessonId`. The snapshot that matters is the committed D1 row, which still freezes it. **Consequence:** renaming a Lesson now flows into future commits instead of leaving templates stuck on the old name. |
| `sequenceNumber` | See §3.2. |

### 3.2 `sequenceNumber` and the three numbers

The ordinal now lives **in the title** ("Level 1", "Assessment 1"), which removes three of its four
consumers:

- the ordinal chip (`planner-ui.js:645`, `:773`) — the new card has no chip;
- `bySequenceNo` (`planner-core.js:76`, `:109`) — the handoff §11.1 defect, deleted;
- `canReorder` (`planner-core.js:128`) — gated reorder arrows off the presence of `sequence_no`; with the field gone every row is reorderable again.

The fourth is `export-core.js:50`, a `sequenceNumber` column in the completion CSV. It emits the
title instead, which now contains the number.

**Cost, stated plainly:** the "Level {n}" autofill on the single-Activity path derives `n` by
counting same-type Activities in the Lesson, and counting is not `max + 1`. Delete Level 2 from
1/2/3 and the next suggestion is "Level 3", not "Level 4". It is an editable prefill on the rare
hand-add path — the recipe generates the whole run at once — and the alternative is parsing
integers back out of titles.

This retires the handoff's "three numbers, do not conflate" footgun down to two:

| Field | Counts | Scope | Mutable |
|---|---|---|---|
| `order` | position across all types | Lesson | yes (reorder) |
| `seq` | id segment across all types | Lesson | **never**, never reused |

---

## 4. The Activity Type table

`ACTIVITY_TYPE_SEED`, `storage.js:10-21`. **Eleven rows.**

| Key | Label | `capturePattern` | `structurePattern` | Change |
|---|---|---|---|---|
| `quiz` | Quiz | grade-optional | count | — |
| `test` | Test | grade-optional | count | — |
| `project` | Project | grade-optional | count | — |
| `report` | Report | grade-optional | count | — |
| `drill` | Drill | grade-optional | count | — |
| `workbook` | Workbook | grade-optional | **page-range** | **changed** |
| `pdf` | PDF | grade-optional | page-range | — |
| `video` | Video | no-capture | count | — |
| `online-sim` | **Online Sim** | no-capture | count | **new** |
| `practice-level` | **Practice** | no-capture | count | **label changed** |
| `reading-pages` | Reading Pages | no-capture | page-range | — |

**`practice-level` keeps its key.** It is load-bearing in `packet.js`, `courses.js` (three sites),
and `children.js` (two sites); only the label changes, and labels reference nothing.

**No `DB_VERSION` bump and no upgrade block.** `seedDefaults()` (`storage.js:380`) upserts the whole
seed array with `put()` and runs after Settings → Database "Reset everything". Edit the array, reset,
done.

### 4.1 `structurePattern` collapses to one question

With `reference` and `sequenceNumber` both gone, a `count` type asks for **zero** type-specific
fields. The pattern now answers only: *does this type take a page range?* Two hardcoded key-lists
become honest tests:

- `renderPayloadFields:1257` gates the page-range prefill on `pdf || reading-pages` → becomes `structurePattern === 'page-range'`, correct for Workbook and anything added later.
- `computePageRangePrefill:386` filters the same two keys, then reads `a.payload` → with `payload` gone and only one page-range type per Lesson (D11), the type check disappears entirely: any Activity in the Lesson carrying a `pageRangeStart` counts toward coverage.

---

## 5. The recipe

### 5.1 What a recipe is

**Not stored.** Form state, consumed once by §6's expansion. Afterwards the only durable artifacts
are ordinary Activity records plus the Lesson's existing `pageRangeStart`/`pageRangeEnd`. A stored
recipe would be a fifth entity in a four-level hierarchy and would immediately raise the re-sync
question D3 exists to avoid.

Mounted in `renderLessonDetail` (`courses.js:1069`), gated on `hasActivitiesUnderLesson` (`:63`).

### 5.2 Stage 1 — "What does this lesson consist of?"

```
Adding Fractions · pages 10–17  [edit]

  Pages:  [PDF ▾]   split at [10, 14]   → 2 chunks
          (•) first page of each chunk   ( ) last page of each chunk

  Video       [2]
  Practice    [4]
  Online Sim  [1]
  Quiz        [1]
  [+ add type ▾]

  [Copy from lesson ▾]           [ Propose 10 activities ]
```

- The **page-range slot is structurally singular** (D11) and optional — a video-only Lesson leaves it empty. Its dropdown lists only `page-range` types.
- The Lesson's budget is editable inline, so a missing one does not send the parent back to the Lesson form.
- **Count types get a plain number box.** No reference, no sequence number, no per-row anything.
- The submit button carries the **live total**, recomputed on every input event. A parent who types `120` instead of `12` sees "Propose 125 activities" before pressing. Deliberately a visible number rather than a confirmation dialog.

### 5.3 The split rule

N numbers give N chunks, in either mode. Let `B₀ = lesson.pageRangeStart`, `B₁ = lesson.pageRangeEnd`.

| Mode | Input | Chunk *i* | On 10–17 |
|---|---|---|---|
| first page | `s₁ … sₙ` | `[sᵢ, sᵢ₊₁ − 1]`; last chunk ends at `B₁` | `10, 14` → 10–13, 14–17 |
| last page | `e₁ … eₙ` | `[eᵢ₋₁ + 1, eᵢ]`; first chunk starts at `B₀` | `13, 17` → 10–13, 14–17 |

An **explicit toggle**, not inference from whether the first number equals `B₀` — inference breaks on
a single chunk, where one number is simultaneously the first and last page.

| Check | Rule |
|---|---|
| Ascending | Strictly increasing, no duplicates |
| In budget | Every value in `[B₀, B₁]` |
| Front gap | first mode, `s₁ > B₀` ⇒ **warn**, generate anyway |
| Back gap | last mode, `eₙ < B₁` ⇒ **warn**, generate anyway |

Gaps and overlaps warn and never block — the budget has always been a suggestion. The chunk count is
**derived** from the split list and displayed read-only; there is no second number to disagree with it.

### 5.4 Copy from lesson

A dropdown of other Lessons in the same Course that have Activities. Copies:

| Copied | Not copied |
|---|---|
| Types and counts | Page ranges and split numbers — this Lesson has its own budget |
| **The accepted order** | — |
| Hand-typed chunk titles, as editable defaults | — |
| — | Pattern-driven titles — regenerated against the new Lesson's title |

Carrying the order is the point. It is what makes stage 2's reordering a one-time cost per course
rather than per lesson: pick source, type the split numbers, accept.

### 5.5 Stage 2 — the proposal

N rows, each showing type · generated title · page range where applicable. Titles editable inline,
rows reorderable (↑↓, same affordance as `courses.js:1175`). **Nothing is written.**

Initial order is the order the types were added, each type's instances consecutive — so the worked
example proposes PDF, PDF, Video, Video, Practice×4, Sim, Quiz, and the parent drags it into shape.
A copied recipe arrives already ordered.

### 5.6 Title patterns

Two layers: a built-in default per type, and an optional **per-Course override**.

**Tokens:** `{lesson}` the Lesson's title · `{n}` the ordinal within the type · `{type}` the type's
label · `{start}` / `{end}` the chunk's page range, page-range types only.

**Built-in defaults:**

| Type | Pattern | Yields |
|---|---|---|
| Video | `{lesson}` when count is 1; `{lesson}: Part {n}` when more | "Adding Fractions" / "…: Part 2" |
| Practice | `Level {n}` | "Level 3" |
| Quiz | `Assessment {n}` | "Assessment 1" |
| Test / Project / Report / Drill | `{type} {n}` | "Drill 2" |
| Online Sim | `{lesson}` | editorial — expect a retype |
| PDF / Workbook / Reading Pages | `Pages {start}–{end}` | editorial — expect a retype |

**Video's count-1 collapse is a rule with a reason:** omit the ordinal when it carries no
information. "Part 1" of a single part says nothing. Practice and Quiz keep their number at count 1
because there the ordinal *is* the name — "Level 1" is what the item is called, not where it sits in
a list.

Every type has a pattern because `title` is required and `reference` is gone; no generated Activity
may arrive blank.

#### 5.6.1 The per-Course override

The Course record gains **one optional field**:

```js
titlePatterns: { 'practice-level': 'Round {n}', video: '{lesson} — Lesson {n}' }
```

Sparse: keyed by `activityTypeKey`, holding only the types the parent actually overrode. A course
usually touches 3–5 types, so most courses store a handful of keys and most store none. An absent
key falls back to the built-in default, which means a later change to the defaults reaches every
course that has not opted out.

**Overriding a type takes ownership of it at every count.** One box per type, one string, no
second slot — so a course whose Video pattern is overridden no longer gets the count-1 collapse.
That is the trade for keeping this a single field: the collapse is a property of the *default*, not
a per-course toggle. A parent overriding Video is doing it for an outlier course whose shape they
already know.

**Where it is set.** A disclosure block on the Course create and edit forms — one row per Activity
Type, each input's **placeholder showing the built-in default** so the parent can see what they
would get before typing. Blank stores nothing; it does not store an empty string.

**Validation, at save:**

| Check | Rule |
|---|---|
| Tokens | Every `{…}` is one of the five. `{lessson}` is rejected rather than shipped into a title |
| Page tokens | `{start}` / `{end}` only on `page-range` types |
| Non-empty | A key present in the map has a non-blank value; blank means absent |
| Type resolves | Every key exists in `activityTypes` |

**Editing patterns never renames anything.** Same copy-at-creation shape as the rest of the slice —
patterns are read once, at expansion.

**Not carried to instances.** `titlePatterns` is deliberately omitted from the instance stamp
(`children.js:152`): the recipe is template-only (D4), so an instance would carry a field nothing
reads. Same reasoning as `excludeFromGeneration`'s deliberate `delete` at `children.js:195`, and it
needs an explicit line because both `buildCourseRecord` (`courses.js:97`) and `newCourse` build
their records from explicit field lists rather than a spread.

**Interaction with §5.4.** Copy-from-lesson is within a Course, so source and destination always
share the same patterns. Nothing to reconcile.

### 5.7 Copy settings from another Course template

The Course create form gains a **"Copy settings from"** dropdown listing existing template Courses.
Selecting one pre-fills the form; every value stays editable before save.

| Copied | Not copied |
|---|---|
| `titlePatterns` — the reason this exists | `name` — always typed |
| `subject` | `courseCode` — must be unique, minted or typed per course |
| `coreElective` | `id`, `state`, and everything instance-related |
| `description` | Lessons and Activities — this copies **configuration, not structure** |
| `defaultPacingHint` | — |
| `curriculumId`, as a pre-selection the parent can change | — |

It is a **form pre-fill, not a link**. The new Course holds its own values from the moment it is
saved; editing the source afterwards changes nothing. No `sourceTemplateId` is written — that field
means "instance stamped from template" and must not be overloaded to mean "settings were copied
once".

Deliberately excludes Lessons and Activities. A structural clone would arrive with Activities
already present, which is exactly the state D4 uses to withhold the recipe — every cloned Lesson
would have to be emptied before it could be authored. Copying configuration leaves the new Course
empty and ready.

---

## 6. Expansion

### 6.1 Validation — all-or-nothing, before the transaction opens

A single failure writes nothing and leaves `nextActivitySeq` unmoved.

| Check | Rule |
|---|---|
| Type resolves | Every `activityTypeKey` exists in `activityTypes` |
| Tier resolves | The lesson-level tier exists in `tiers` |
| One page-range type | At most one page-range row (D11) |
| Counts | Non-negative integers; rows resolving to 0 records are dropped silently |
| Splits | §5.3's ascending / in-budget rules; gaps warn only |
| Titles | Non-empty for every record generated |
| `expectedDurationMin` | Omitted when blank; a positive integer otherwise |
| Total | At least one record would be generated |

Titles resolve **Course override → built-in default** (§5.6.1), read once when the proposal is
built. Patterns are validated at Course save, so expansion treats them as trusted input and needs no
second check.

> There is deliberately **no** "a type may appear at most once" check for count types, and no
> per-type ordering constraint. Types interleave; that is the entire point.

### 6.2 The write

One `Storage.runTransaction(['lessons','activities'], 'readwrite', …)`:

1. Read the Lesson **inside the transaction**. Let `seq₀ = lesson.nextActivitySeq`.
2. Walk the reordered proposal in display order, maintaining a running `order` from 0 and a running `seq` from `seq₀`.
3. Build each record per §3's shape: `id` = `` `${courseCode}-TPL-${lessonCode}-${pad2(seq)}` ``, plus `lessonId`, `activityType`, `title`, `required`, `difficultyTier`, `order`, and `pageRangeStart`/`pageRangeEnd`/`instructions`/`expectedDurationMin` where supplied.
4. `put` each record.
5. `put` the Lesson with `nextActivitySeq = seq₀ + N`.

`createActivity` (`courses.js:428`) currently reads `lessonBefore` *outside* its transaction and the
Lesson again inside. The batched writer must not inherit that seam — read once, inside.

---

## 7. The packet generator

`management-app/js/packet.js`. Read-only against curriculum; the sole writer of `generationLog`.

### 7.1 `projectPayload` — three lines

```js
function projectPayload(a) {
  if (typeof a.pageRangeStart !== 'number') return {};
  return { pageRangeStart: a.pageRangeStart, pageRangeEnd: a.pageRangeEnd };
}
```

`PAGE_RANGE_KEYS` and `REFERENCE_KEYS` (`:46-47`) are deleted. **The `kind` discriminator goes with
them** — with one content shape left it names nothing, and the Child App tests for
`pageRangeStart` directly.

### 7.2 New maps

`propose()`'s `Promise.all` (`:172`) gains `Storage.getAll('lessons')`, and `maps` (`:179`) gains two
entries:

```js
capturesGrade: new Map(activityTypes.map((t) => [t.activityTypeKey, t.capturePattern === 'grade-optional'])),
lessonTitle:   new Map(lessons.map((l) => [l.id, l.title])),
```

Both replace fields the Activity record no longer stores. `activityTypes` was already loaded for
`typeLabel`; only `lessons` is a new read.

### 7.3 `assignmentFromActivity`

| Line | Change |
|---|---|
| `:506` | `projectPayload(a.activityType, a.payload \|\| {})` → `projectPayload(a)` |
| `:508` | `capturesGrade: !!a.capturesGrade` → `session.maps.capturesGrade.get(a.activityType) === true` |
| `:511` | `if (a.lessonTitle)` → read from `session.maps.lessonTitle.get(a.lessonId)` |
| `:526` | `if (a.sequenceNumber != null) row.sequenceNo = …` — **deleted** |

`sortOrder` (`:586-589`) is unchanged: activities, then chores, then events, numbered from 0 in
array order. Because the day's activity array comes from `instanceActivitiesInWalkOrder`
(`pacing.js:34`), which sorts lessons by `lesson.order` then activities by `activity.order`, the
emitted `sort_order` **already encodes course → lesson number → within-lesson order**. That is the
required downstream ordering, achieved with no new column and no reorder UI (D6).

`blockHint` (`:527`) is unchanged — it reads `item.blockHint`, the engine-assigned value, never the
authored one. Dropping the authored field changes nothing here.

---

## 8. Schema and Worker

### 8.1 `migrations/0008_drop_sequence_no.sql`

```sql
-- sequence_no lost its last consumer when the ordinal moved into the title.
-- Plain column: no index, no constraint, no view references it.
ALTER TABLE assignments DROP COLUMN sequence_no;
```

Registered in `management-app/worker/migrations.js` in the same commit — import at line 14, registry
entry at line 23. Applied from Settings → Database.

`/api/admin/reset` issues `DELETE FROM` per table (`index.js:493`); it does not drop or recreate
them. The schema survives every reset, so editing `0001` would change nothing on a live database —
a new migration is the only thing that actually removes the column.

### 8.2 Worker

`sequenceNo` appears at three sites in `management-app/worker/index.js`, all removed:

| Line | What |
|---|---|
| `:57` | camelCase → snake_case column map |
| `:73` | second column map |
| `:769` | `row.sequenceNo ?? null` in the INSERT bind list |

The bind list and its column list must stay aligned; removing one without the other silently shifts
every subsequent value.

---

## 9. The Child App

`child-app/`. Its own declared scope, built after phases 1–3 are live.

### 9.1 The card

Current (`planner-ui.js:760-800`) versus target:

```
BEFORE                          AFTER
[type-tag] [No. 3]              Adding Fractions        ← lesson group header
course_name                     ─────────────────────
title                           Video · Adding Fractions
lessonTitle                     Practice · Level 1
pages 10–13  /  reference       PDF · Guided Notes
▸ instructions (details)          pages 10–13
                                  [Instructions]        ← button → modal
```

| Change | Detail |
|---|---|
| Lesson title | Moves from a subline **below** the title (`:786`) to a **group header above** the cards. Cards from one Lesson share one header. |
| Type and title | Merge onto one line, separated by a middot. `activity_type` still carries the parent's label, never the key. |
| Ordinal chip | Deleted (`:645`, `:773`). The number is in the title. |
| Content line | Only the page range survives. `renderContent` (`:880`) loses its `reference`, `freeText`, and `kind` branches and tests for `pageRangeStart`. |
| Instructions | `<details>` → a **button** that opens a modal, rendered only when `instructions` is present. |
| Course name | Stays as the outer grouping level. |

### 9.2 Sorting and grouping

`planner-core.js`:

| Symbol | Change |
|---|---|
| `bySequenceNo` (`:76`) | **Deleted.** It sorted a course group by `sequence_no` whenever every item had one — but that was the per-type ordinal within a Lesson, so a day drawing Video 1, Practice 1–2 and Quiz 1 sorted to `Video 1 · Practice 1 · Quiz 1 · Practice 2`. |
| `everySequenced` (`:109`) | **Deleted** with it. |
| `byCourseThenLesson` (`:87`) | Groups by `course_name`, then sub-groups by `lessonTitle` in first-appearance order, then sorts by `effectiveSortKey` throughout. Finally does what its name always claimed. |
| `canReorder` (`:128`) | **Deleted.** Every row is reorderable; nothing authoritative is being overridden any more. |
| Reorder scope | Within the **lesson** group. An interpolated key computed against a neighbour in a different lesson cannot move the row there — the grouping runs before the sort, exactly as it already did for courses. |

`effectiveSortKey` (`:62`) is unchanged and becomes the only sort.

### 9.3 Elsewhere

- `assignment-core.js:55` — `PROMOTED` keeps `lessonTitle` and `instructions` (still payload fields with no column). `contentOnly` now yields `{pageRangeStart, pageRangeEnd}` or `{}`.
- `export-core.js:50` — the `sequenceNumber` CSV column emits `assignmentRow.title`.

---

## 10. What does not change

- **No reward change.** `reward_entries` stays append-only; `reward_amount` stays NULL and the Child App keeps its fallback (`completion.js:170`). Parked for the earning phase.
- **Chores and events.** Untouched, including shared-chore claims.
- **`createActivity` / `editActivity` / `moveActivity` / `deleteActivity`** keep working; the batched writer is additive, and the single-Activity path remains the only way to amend a Lesson after expansion (D4).
- **Pacing.** No change to distribution, profiles, or the generation log.
- **Auth.** No new route, no credential change.

---

## 11. Tests (`tests/`, `node --test`)

The expansion planner is written **DOM-free and IO-free** — a pure function from a validated recipe
to an ordered array of Activity records, with the transaction as its only caller. Same split
`worker/validation.js` and the Child App's `*-core.js` files already use.

Cover:

- `order` contiguity 0…N−1 across the reordered proposal
- `seq` continuity from an arbitrary `seq₀`
- both split modes producing identical chunks from the worked example
- single-chunk splits in both modes (the case that defeats inference)
- front-gap and back-gap warnings that do not block
- a zero-count row dropping without erroring; an all-zero recipe rejected as empty
- a second page-range row rejected (D11)
- every title pattern, including the Video count-1 collapse
- copy-from-lesson preserving order while regenerating pattern titles against the new Lesson

`planner-core.js`'s new grouping is already covered by the existing suite's shape; extend it for
course → lesson → `effectiveSortKey`.

---

## 12. Acceptance checks

Against the worked lesson — PDF split at 10, 14 · Video ×1 · Practice ×4 · Online Sim ×1 · Quiz ×1,
reordered to interleave.

1. A Lesson with no Activities offers the recipe; the same Lesson after expansion does not. Deleting every Activity offers it again.
2. Expansion creates exactly **9** Activities with `order` 0–8 contiguous in the reordered proposal's sequence.
3. Ids end `-01` … `-09`; `nextActivitySeq` is 10.
4. The two PDF Activities carry `pageRangeStart`/`pageRangeEnd` of 10/13 and 14/17, and titles "Guided Notes" and "Fraction Detective".
5. Splitting at `13, 17` in last-page mode produces byte-identical page ranges to `10, 14` in first-page mode.
6. The four Practice Activities are titled "Level 1" … "Level 4" and carry no page range.
7. The single Video is titled "Adding Fractions", not "Adding Fractions: Part 1". Re-running with count 2 yields "Part 1" and "Part 2".
8. No Activity record anywhere carries `payload`, `reference`, `text`, `blockHint`, `capturesGrade`, `lessonTitle`, or `sequenceNumber`.
9. A recipe naming an unresolvable tier writes nothing — no partial Lesson, `nextActivitySeq` unmoved.
10. A second page-range row is rejected before the transaction opens.
11. Overlapping chunks (10–13 and 12–17) warn and generate.
12. Copy-from-lesson reproduces types, counts, and order; titles regenerate against the new Lesson's title; page ranges are blank.
13. A course stamped to two children gives both the same within-lesson order, and reordering the template afterwards does not disturb either instance.
14. Committed assignment rows carry no `sequence_no`; the column does not exist after `0008`.
15. `capturesGrade` on a committed row matches its type's `capturePattern`, with nothing stored on the Activity.
16. Renaming a Lesson changes the `lessonTitle` on rows committed *after* the rename and none committed before.
17. The Child App groups a day's work by course, then lesson, then `sort_order`, with one header per lesson.
18. A day drawing Video 1, Practice 1–2 and Quiz 1 renders in walk order, not `Video · Practice 1 · Quiz · Practice 2`.
19. Reorder arrows appear on every row and move rows only within their lesson group.
20. An Activity with `instructions` renders a button that opens a modal; one without renders neither.
21. A Course with no `titlePatterns` generates the §5.6 built-in titles, including Video's count-1 collapse.
22. A Course overriding `practice-level` to `Round {n}` generates "Round 1" … "Round 4"; every other type in that Course still uses its default.
23. A Course overriding `video` generates that pattern at count 1 as well — the collapse does not apply to an overridden type.
24. A pattern containing an unknown token is rejected at Course save, not at expansion; `{start}` on a count type is rejected too.
25. Clearing a pattern back to blank removes the key rather than storing an empty string, and the type reverts to its default.
26. "Copy settings from" pre-fills patterns and metadata, leaves `name` and `courseCode` empty, creates no Lessons or Activities, and writes no `sourceTemplateId`.
27. Editing the source Course after a settings copy changes nothing on the copy.
28. A Course stamped to a child carries no `titlePatterns` on the instance record.

---

## 13. Amendments to shipped documents

| Document | Change |
|---|---|
| `SRS_Management_Module_03` | New **FR-P7** (recipe expansion). New **FR-P8** — per-Course `titlePatterns` and "Copy settings from" on the Course create form (§5.6.1, §5.7). FR-P4 unchanged in substance — the count target remains display-only and participates in no validation. FR-4's Activity form loses `reference`, `blockHint`, and `sequenceNumber`. |
| `SRS_Management_Module_12` | §4 both tables → 11 rows; Workbook `page-range`; Practice relabelled; Online Sim added. |
| `TDS_Slice_M5_..._Rev7` | §1a table and prose; §174 acceptance item 2 ("10 rows") → 11. |
| `TDS_Slice_M7_..._Rev1` | §37/§141 payload projection tables → one shape. |
| `TDS_Slice_M8` | §39/§40/§142 CSV column validity per type. |
| `TDS_Slice_Child_Feedback_Loop` | §4.1/§4.3 — `sequence_no` sorting and the `canReorder` gate, both deleted. |
| `CLAUDE.md` | §VII gains "Ordinal in title, `reference` repealed" and "One page-range type per Lesson". |

---

## 14. Open

- **`reward_amount`** is a genuinely dead D1 column today (always NULL; the Child App falls back to `1` at `completion.js:170`). It is reserved for the earning phase rather than unused-forever, so this slice leaves it. If that phase is far enough out, it belongs in `0008` alongside `sequence_no` and comes back when it is actually populated.
- **Curriculum-level pattern defaults.** §5.6.1 puts the override on the Course. If a Curriculum ends up holding many Courses that all share MiAcademy's conventions, a Curriculum → Course inheritance step would remove the remaining repetition — §5.7's settings copy is the cheaper answer for now and may be enough.
