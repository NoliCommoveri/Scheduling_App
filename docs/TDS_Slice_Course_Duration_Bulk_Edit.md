# TDS Slice — Bulk Activity Durations

**Status:** Built 2026-08-17
**Scope:** Management App only. No Worker change, no migration, no schema change, no new route,
no credential change.
**Amends:** `SRS_Management_Module_03_Course_Template_Library.md` (FR-11),
`SRS_Management_Module_04_Child_Management.md` (FR-15).

---

## 0. What this is, and what it is not

**It is a bulk edit.** One line per Activity Type present beneath a Course, each with a minutes
box. Saving writes `expectedDurationMin` onto every Activity of that type in that Course.

**It is not a new field.** Nothing is stored on the Course record. There is no
"the Course says a Quiz takes 20 minutes" anywhere in the data — only forty Activities that were
each written `20`. Every consumer reads the Activity exactly as it always has, and the
single-Activity form (Mgmt SRS 03 FR-4) still writes and overrides the same field on the same
rows.

**It is not a default, and not inheritance.** An Activity created after a bulk save gets nothing
from it; the parent re-runs the panel, or types the number on the create form. Inheritance would
mean a second place the number can live and a rule for which one wins — a permanent cost, paid to
save one re-run of a screen that takes four seconds.

### 0.1 Why it exists

`expectedDurationMin` is what Packet Generation adds up against a `minutesBudget` Pacing Profile
(Mgmt SRS 05 §2.3; `packet.js` `durationOf`). It is optional, and an Activity without one is
counted as **15 minutes** — a fallback, never a stored value.

Until now the only ways to set it were the single-Activity form, three clicks down inside a
Lesson, and the bulk CSV import column (Mgmt SRS 03 FR-5), which is a whole-course re-import.
A real course is ~300 Activities across five or six types. The parent's knowledge, though, is
per-type and fits on one line — *a Practice takes ten minutes, a Quiz takes twenty* — so the
field went unset, and a whole course paced at the 15-minute fallback while the parent's actual
estimate sat unrecorded. This closes the gap between the shape of the knowledge and the shape of
the form.

### 0.2 Why per **type**, not per Lesson or per Course

A single Course-wide number would be wrong for every type at once — a Drill and a Test do not take
the same time, and averaging them is worse than the 15-minute fallback because it looks
deliberate. Per Lesson is the wrong axis in the other direction: lessons vary in *how many*
Activities they hold, not in how long one of them takes. Activity Type is the axis the estimate
actually varies along, and it is already the axis the parent thinks in (it is what FR-P2's count
targets and FR-P8's title patterns are keyed by too).

---

## 1. Placement

| Page | Where | Owner |
|---|---|---|
| Course Template detail (`courses.js`) | Below the Course edit form, above **Lessons** | Mgmt SRS 03 FR-11 |
| Assigned Course detail (`instances.js`) | Directly below the Pacing card | Mgmt SRS 04 FR-15 |

Both pages get the same panel from the same module — the panel branches on nothing, because an
Activity's `expectedDurationMin` means the same thing under `state: 'template'` and
`state: 'instance'`, and a stamped Instance's Activities are a byte copy of the template's
(Mgmt SRS 04 FR-4 step 4). Setting durations on a template before stamping and fixing them on the
Instance afterward are the same action against different rows.

On the Assigned Course page it sits under Pacing deliberately: the Profile above sets the
minutes-per-day budget, and this sets the per-Activity minutes that budget is spent against. They
are two halves of one question and are read together.

The panel renders **nothing at all** on a Course with no Activities — there would be no rows in
it, and an empty disclosure on a freshly created Course is one more thing to scroll past to reach
the Lessons form.

---

## 2. What a row shows

One row per Activity Type **present beneath the Course** — never the whole Activity Type table. A
type nobody authored is not a line to skip past.

| Row state | Line reads | Input opens |
|---|---|---|
| Every Activity carries the same number | `8 Activities · all 20 min` | pre-filled `20` |
| Some set, some not | `8 Activities · 20 min · 3 with none` | blank, placeholder `mixed` |
| Several different numbers | `8 Activities · 10, 20, 30 min` | blank, placeholder `mixed` |
| None set | `8 Activities · no duration set` | blank, **Clear** disabled |

Rows follow Activity Type table order (as `Storage.getAll('activityTypes')` returns it) — the same
order FR-P9's seeded target rows use. A key that no longer resolves to a type still gets a row,
labelled with the raw key and marked *(type no longer exists)*, sorted after every known type: a
Course whose type was deleted stays repairable rather than silently losing Activities from the
panel.

A mixed row never pre-fills a winner. Picking the most common value would make Save look like a
no-op while it silently rewrote the minority.

---

## 3. Semantics

### 3.1 Save

Every row with a number is applied in one run; **rows left blank are not touched**. Activities
already carrying the target value are skipped, so re-saving an unchanged panel writes nothing and
queues no outbox rows. A single invalid value rejects the whole run — nothing is written, including
the valid rows beside it, matching the all-or-nothing convention every other bulk path in this app
uses (FR-5, the recipe's FR-P7).

Validation mirrors `normalizeOptionalActivityFields` in `courses.js`/`instances.js` exactly:
positive whole number, or blank. Deliberately mirrored rather than given its own bound — a value
the single-Activity form accepts must not be rejected here, and vice versa. The input also carries
`min="1"`, so the browser's own constraint check is the first thing a parent hits; the JS rule is
the backstop.

### 3.2 Blank means "leave alone" — clearing is its own action

Blank could plausibly mean *clear this type's durations*. It does not, and this is the one decision
in the slice worth stating out loud.

The panel saves **every row at once**. Under a blank-clears rule, a parent who opens a
five-type panel to set Quiz to 20 and presses Save wipes the durations on the four types they had
not got to yet — a destructive edit with no gesture behind it. So blank is inert, and removing a
type's durations is a per-row **Clear** button: confirmed, disabled when there is nothing to clear,
and reported in its own words (*Cleared the duration on 2 Activities*) rather than as an update.

Clear removes the key outright — absent, never `null`, never `0`. That is the optional-field
convention this record has always used (Mgmt SRS 03 §4, `applyOptionalActivityFields`), and it is
load-bearing: `0` would be a stored duration of nothing, where absent means "count it as 15".

### 3.3 What a save touches

Exactly one field. Records are written back spread from the row that was read, so `id`, `order`,
`activityType`, `difficultyTier`, `title`, `required`, the page range, `instructions`,
`excludeFromGeneration` — and any field this module has never heard of — survive a save byte for
byte. Nothing is minted, nothing is deleted, `nextActivitySeq` is never advanced.

### 3.4 Effect on work already sent

None, in either direction. `expectedDurationMin` is snapshotted onto the `assignments` row at
Commit (`packet.js`), so changing it here moves **future** Propose runs only; a row already
committed keeps the number it was sent with. This is the same rule as renaming a Lesson or a
Course, and it needs no warning of its own — nothing already delivered changes, and nothing a
child holds is recalled.

---

## 4. Code

| File | Role |
|---|---|
| `management-app/js/course-durations-core.js` | Pure. `normalizeDuration`, `summarize`, `describeRow`, `planUpdates`, `describeResult`. No DOM, no Storage — the same split as `pacing-core.js` / `recipe-core.js`. |
| `management-app/js/course-durations.js` | The panel. Reads the Course's Activities, renders the rows, performs the write. |
| `tests/management-course-durations-core.test.js` | 21 cases over the pure layer. |

`CourseDurations.renderInto(container, course)` is the whole surface, called by both Course pages —
the same arrangement as `Pacing.renderInto` and for the same reason: what it edits belongs to the
Course you are already looking at, so a page of its own could only be a second index of the Course
list.

### 4.1 Write scope — the bound on a third writer

`course-durations.js` is a **third writer to the `activities` store**, alongside `courses.js`
(templates) and `instances.js` (instances), and it is bounded to **one optional field**:
`expectedDurationMin`, set or removed, per §3.3. Structural writes — minting, deleting, reordering,
retyping, the page range, the exclusion flag — stay with the two owners. Anything beyond the one
field belongs there, not here.

This is a module-ownership convention inside one app, not an architectural constraint: CLAUDE.md
§I.A forbids sharing runtime code **between** the three apps, which this does not do. `pacing.js`
rendering into a page `instances.js` owns is the existing precedent.

### 4.2 Sync

One `Storage.runTransaction(['activities'], 'readwrite', …)` for the whole run, so a bulk edit
either lands or does not, and its outbox rows commit atomically with it
(`TDS_Slice_D1_Sync_Management_App.md` §1.6). A 300-Activity save queues 300 outbox rows; the drain
loop already batches (`sync.js` `BATCH_SIZE`), and the Worker's `records` upsert is idempotent, so
a dropped response re-pushes harmlessly.

---

## 5. Acceptance checks

1. A Course with 8 Quizzes and 12 Practices shows exactly two rows (plus any other type present),
   in Activity Type table order.
2. Typing `20` on the Quiz row and saving sets `expectedDurationMin: 20` on all 8 Quizzes and
   leaves all 12 Practices untouched.
3. Saving again immediately reports no changes and writes nothing.
4. A row whose Activities hold 10, 20 and 30 opens blank with a `mixed` placeholder and reads
   `10, 20, 30 min`; leaving it blank and saving another row does not change any of them.
5. Clear on a row removes the key from every Activity of that type — the reloaded records have no
   `expectedDurationMin` property at all, not `null` and not `0`.
6. Clear is disabled on a row where no Activity has a duration.
7. A value of `0`, `-5` or `2.5` is rejected and nothing is written, including on a valid row
   filled in beside it.
8. An Activity carrying `pageRangeStart`/`pageRangeEnd`, `instructions` and
   `excludeFromGeneration` keeps all of them, unchanged, across a bulk save.
9. A Course whose Activities include a type since deleted from the Activity Type table still shows
   that row, labelled with the raw key, and can still be set and cleared.
10. Setting durations on a **template**, then stamping it, produces an Instance whose Activities
    carry those durations; editing them on the Instance afterward never touches the template.
11. A Propose run under a `minutesBudget` Profile, taken before and after a bulk save, packs a
    different number of Activities into a day — the durations reach generation.
12. The panel does not appear on a Course with no Activities.

---

## 6. Deliberately not built

- **A Course-level default.** §0 — a second place the number can live.
- **A per-Lesson override.** Wrong axis (§0.2), and it would need a precedence rule against the
  Activity's own value.
- **Bulk duration across *all* Courses at once.** A Quiz in Saxon Math and a Quiz in Apologia
  Biology are not the same length; the Course is the smallest scope where a per-type number is
  actually true.
- **A column in the bulk CSV keyed by type.** The CSV already carries `expectedDurationMin`
  per row (FR-5), and a second, type-keyed way to set the same field in the same file would be two
  sources of truth inside one import.
