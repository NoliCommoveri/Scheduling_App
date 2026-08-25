# TDS Slice — Subject Order, Grouped Review & Assignment Visibility (Generate + Assignments)

**Status:** Design only — authored 2026-08-25, **unbuilt**. No code in this commit.
**Scope:** Management App only. Files: `management-app/js/subject-order-core.js` (new),
`packet.js`, `assignments.js`, `settings.js`, `index.html` (one script tag),
`styles/styles.css`, `tests/management-subject-order-core.test.js` (new).
**Not in scope:** no Worker change, no migration, no D1 schema change, no new route, no
credential change, no change to what any client may write, no Child App change, no Wall App
change, no IndexedDB version bump.
**Amends:** `SRS_Management_Module_08_Packet_Generation_Export.md` (note on FR-14, new FR-17),
`SRS_Management_Module_11_Settings_Backup.md` (new FR-9),
`TDS_Slice_Online_Revamp.md` §9 (the Assignments view's presentation).
**Related:** `TDS_Slice_Generation_Scope.md` (FR-1a passes, FR-14 `sortOrder` bands),
`TDS_Slice_Shared_Chores.md` §5.4/§9/§13.7 (the claim arbitration, Reporting's `isClaimedElsewhere`,
and the missing parent-side view of who claimed what — §3.5 closes the half of §13.7 that is a
defect and leaves the claim-history screen open),
`TDS_Slice_Child_Feedback_Loop.md` §0.2 / §11.1 (subject as a grouping level — **this slice does
not close that item**; see §1.4).

> **Authoring note.** CLAUDE.md §II.2 requires a TDS slice before code is written, and none
> existed for this. Authored from Ray's in-session report of 2026-08-25, ahead of any build, so
> the §V.A "estimated build time exceeds 2–3 hours" gate is answered by §5's phasing rather than
> discovered halfway through.

---

## 0. What this is, and what it is not

**It is a presentation change plus one new stored preference.** Two screens — Generate
(`packet.js`) and Assignments (`assignments.js`) — stop rendering a day as one flat list and
start rendering it as *subject → course → items*, with chores and events in groups of their own.
The one thing that becomes durable data is the parent's **standing subject order**, a list of
subject names in the order Ray wants to see them, stored in the existing `meta` store.

**It is not a new grouping key on `assignments`.** No `subject` column is added, and Commit's
row shape is byte-identical. Both screens run *inside* the app that owns the Course records, so
subject is resolved locally at render time — see §1.4.

**It is not a change to what gets assigned.** Propose places exactly the items it places today;
Commit sends exactly the rows it sends today. What changes is the order the items sit in within
a day, and therefore the `sort_order` those rows carry — see §2.6, which is the one place this
slice has a visible effect past the screen.

**It is not a re-litigation of FR-14's merge order.** School, then Chores, then Family Events
stays fixed, and the `sortOrder` bands (0 / 1000 / 2000) are untouched. Grouping happens
*within* the School band.

**It is not an auto-rescind, a sweep, or a scheduled job.** Report 5 asked for one; §3.6 argues
against it and §3.5 delivers the outcome from data the claim arbitration already writes. Nothing in
this slice writes to an `assignments` row at all outside Commit's existing path.

**It is not a Child App feature.** The child already groups its day by course and then by
lesson (`child-app/js/planner-core.js:132-141`) and already renders `lessonTitle` under the card
title (`planner-ui.js:860`). The parent's two screens are the ones that never learned to.

### 0.1 The six reports, and what actually causes each

Ray, in-session 2026-08-25 — four on the screens, then two on what the Assignments tab shows:

| # | Report | Cause | Fixed in |
|---|---|---|---|
| 1 | "The courses all present in a random order. I have a subject field — group by subject, under a course header I can collapse, with a standing order the subjects come through in." | A day's `activities` array is built in three appends with no sort: reproduced log rows first, in log order and therefore mixed across courses (`packet.js:288-320`); then the school walk, per instance, in `instancesWithProfiles` order (`:322-347`); then anything pulled forward. Nothing ever sorts the array, and the renderer walks it as-is (`:1164-1176`). | §1, §2.2, §2.3 |
| 2 | "Pulling forward sticks new assignments at the bottom instead of with the rest of the course." | `pullForward` ends in `session.days.get(toDate).activities.push(item)` (`packet.js:533`). Array position *is* the display order, so "append" *is* "bottom". `relocate` (`:481`) has the identical behaviour and the same fix. | §2.5 |
| 3 | "I need to see the lesson title — 'Practice level 3' isn't enough." | The review row prints `activityType · activity.title` only (`packet.js:1191`). The lesson title is already in hand — `session.maps.lessonTitle` is built at Propose (`:234`) and rides into `payload.lessonTitle` at Commit (`:579-580`) — it simply is never shown to the parent who is deciding. The pending-remainder rows (`:1113-1118`), where Pull-forward is actually chosen, are worse off for the same reason. | §2.4 |
| 4 | "The Assignments page needs help too. The batch list is getting long — hide it behind a collapse, I rarely interact with it. Same deal with course expanders, and chores in their own expander." | `batchSection` renders every batch in the range as an always-open `<ul>` (`assignments.js:319-364`), and `daySection` renders a day as one flat `<ul>` sorted by `sort_order` (`:369-399`). | §3 |
| 5 | "I have a lot of 'either kid can claim' chores. I need it to auto-rescind or something from the kids who didn't complete after the day passes (to allow for undo during the same day), instead of still displaying like assigned but incomplete in the Assignments tab." | The claim arbitration writes `claimed_by` to every row in the group but `status = 'complete'` to the winner's row only (`worker/index.js:2513-2557`) — the loser's row stays `pending`, which is what makes undo possible. The Child App planner, the Child App's Completed list and Management Reporting all read `claimed_by` and treat such a row as resolved; the Assignments view is the only consumer that never learned to, because `isResolved` tests `status` alone (`assignments.js:87-89`). | §3.5, §3.6 |
| 6 | "Rescinded rows should be hidden from view unless I explicitly check to see them." | `reload()` hardcodes `includeRescinded=1` (`assignments.js:232`) and there is no control over it. | §3.7 |

Reports 5 and 6 are both about the same screen telling the truth about what is outstanding, and
report 5 needs **no write at all** — see §3.5, which is the one place in this slice where the
mechanism Ray named is not the mechanism proposed, and §3.6, which says why.

Reports 1 and 2 are the same defect seen from two angles: **nothing defines a canonical order for
a day's activities**, so the order is whatever the build sequence happened to produce. §2.2 gives
that order a definition, and both symptoms fall out of it.

### 0.2 What was checked before designing

| Constraint | Finding |
|---|---|
| Column ownership (CLAUDE.md §0, §III.B) | Untouched. `projectAssignments` emits the same fields for the same items; only the array position each item occupies changes, and position was already the source of `sortOrder`. No column changes hands. |
| No new route, credential, or D1 schema | None. Zero Worker edits. `GET /api/assignments` already returns `payload` (`worker/index.js:1427` is `SELECT *`), which is all §3.3 needs. |
| No IndexedDB version bump | None. `meta` exists since v1 (`storage.js:83`), takes out-of-line keys, and `gradingDefaults` is the exact precedent for a keyed preference record (`settings.js:151-172`). |
| Mirrors to D1 | Yes, for free. `meta` is not in `SYNC_EXCLUDED` (`storage.js:66`), `deriveKey` already handles out-of-line keys (`:230-238`), and `/api/sync/push` takes `{store, key, op, value}` generically. The standing order survives a device loss and a `restoreFromCloud`. |
| Cross-app code sharing (§I.A) | None. Everything lives in `management-app/`. The new core file is shared *within* one app, the same way `pacing-core.js` and `recipe-core.js` already are. |
| No CLI (§0) | Nothing here is operable from anywhere but the browser. |
| Free tier (§0) | No inference, no new storage surface, no new request. One extra `Storage.getAll('courses')` per Assignments render, against IndexedDB. |
| Offline posture (§III.A) | Unchanged. The subject order is a local write that drains through the outbox like every other authored record. |
| Shared-chore claim semantics (`TDS_Slice_Shared_Chores.md` §5.4/§5.5) | Preserved exactly. §3.5 is read-side only: `claimed_by` is never written, cleared, or swept, so the arbitration and the release/undo path behave identically before and after. §3.6 records why the auto-rescind that was asked for would break release. |
| Testing convention (§I.B) | The comparator lands in a DOM-free, IO-free `*-core.js` with a `node --test` file beside the five that exist. The view code stays manual-check territory, as it is today. |
| CLAUDE.md amendment needed? | **No.** Nothing is narrowed, nothing widened, no new table, no new credential class, no new route, no departure from a locked decision. §5 of this slice notes the roadmap entry instead. |

---

## 1. The standing subject order

### 1.1 Where it lives

One record, in the existing `meta` store, under the key `subjectOrder`:

```js
// Storage.put('meta', value, 'subjectOrder')
{
  order: ['Math', 'Language Arts', 'Science', 'History', 'Bible'],
  updatedAt: 1756080000000
}
```

`order` is the whole preference: an array of subject strings, most-important first. Absent
record, absent `order`, or `order: []` all mean "no standing order" and every consumer falls back
to alphabetical — which is exactly today's behaviour in `courses.js`, `instances.js` and
`weekly.js`, so an un-configured install looks the way it looks now.

**Why `meta` and not `appSettings`.** `appSettings` is device-local by design and never mirrored
(`storage.js:63-66`) — it holds the launch PIN and the sync token. A standing order that
evaporated when Ray opened the app on the other laptop would read as a bug. `meta` is mirrored,
restores with everything else, and already holds `gradingDefaults` for precisely this class of
household preference.

**Why not a field on each Course.** `subject` is free text repeated across many Course records.
A per-course rank would need re-entering on every new course and would drift the moment two
courses in one subject disagreed. The order is a property of the household's day, not of a course.

### 1.2 The matching rule

Subject is free text, so matching is deliberately forgiving and deliberately shallow:

- Compare on `String(subject).trim().toLowerCase()`. `"math"`, `"Math"` and `" Math "` are one
  subject; `"Maths"` is a different one.
- A subject present in `order` sorts by its index.
- A subject **not** in `order` sorts after every listed subject, alphabetically among its peers.
  A new course with a new subject therefore appears — at the bottom — without anyone having to
  visit Settings first.
- The empty/absent subject renders as **`No subject`** and always sorts last, ahead of nothing.
  This preserves the fallback string and the trailing-sort rule already used by `courses.js`,
  `instances.js:616-619` and `weekly.js:52-56`.
- Display uses the subject text as authored on the Course record; `order` is only ever consulted
  as a rank, never as a display source, so a casing difference cannot rename anything.

### 1.3 The editor — Settings → Subject order

A new collapsed `<details class="settings-section">` in `renderSettingsPage`
(`settings.js:87-100`), added after **Grading defaults**, built with the same `buildSection`
helper:

- The list shows the **effective** order: stored entries first in their stored positions, then
  every subject in use on a Course record that the stored list does not mention, alphabetically,
  visibly marked `not yet ordered`.
- Each row has **↑ / ↓** buttons. No drag-and-drop — it is a handful of rows, and a keyboard- and
  fat-finger-safe pair of buttons is less code and fewer ways to lose a list.
- **Save** writes the whole array in one `Storage.put('meta', {...}, 'subjectOrder')`. There is no
  per-row write; the record is the list.
- A row for a subject **no course uses any more** shows a **Remove** button. Stale entries are
  harmless (they match nothing) but they clutter the list.
- The panel states plainly what the order does: *"Sets the order subjects appear in on the
  Generate and Assignments screens. Subjects not listed here sort alphabetically after the ones
  that are."*

The Generate view's proposal header carries a one-line pointer — *"Subjects follow your standing
order (Settings → Subject order)"* — so the setting is discoverable from the screen that motivated
it, without duplicating the editor.

### 1.4 Why this needs no `assignments.subject` column

`TDS_Slice_Child_Feedback_Loop.md` §0.2 dropped subject as a grouping level, and §11.1 left it
open, because doing it *for the Child App* means threading `subject` through Commit into a new
column and re-deriving the child's grouping around it. That reasoning is sound and is untouched
here.

It does not apply to these two screens, because both of them run inside the app that **owns** the
Course records:

- **Generate** already holds `session.coursesById` (`packet.js:238`), a Map of every Course
  record including its `subject`, keyed by the same `instanceId` every placed activity carries.
  The subject of an item is one Map lookup away, at zero cost.
- **Assignments** already reads a local store to render (`children`, `assignments.js:183-190`).
  Reading `courses` alongside it gives a `course_name → subject` map (see §3.4).

So the Management App gets subject grouping without a migration, and the Child App item in §11.1
stays exactly as open as it was. If it is ever built, the column it adds would simply replace the
local lookup in §3.4 — nothing here would have to be undone.

### 1.5 `subject-order-core.js` — the one comparator

New file, `management-app/js/subject-order-core.js`, loaded in `index.html` **before**
`courses.js` (it is a leaf — it reads nothing and touches no DOM). Same shape as the app's other
cores: an IIFE assigning one global, no `Storage`, no `document`.

```js
SubjectOrderCore.NO_SUBJECT            // 'No subject'
SubjectOrderCore.label(subject)        // trimmed text, or NO_SUBJECT when blank
SubjectOrderCore.rank(order)           // -> Map(lowercased subject -> index)
SubjectOrderCore.compare(order)        // -> (a, b) => number, for subject *labels*
SubjectOrderCore.sortSubjects(list, order)
SubjectOrderCore.merge(stored, inUse)  // effective editor list (§1.3)
SubjectOrderCore.unused(stored, inUse) // entries the Remove button applies to
```

`compare(order)` is the whole contract: listed before unlisted, index order within listed,
alphabetical within unlisted, `No subject` last. Every consumer — the two views in this slice,
and any view that adopts it later (§7.1) — calls that and nothing else.

Tests: `tests/management-subject-order-core.test.js`, `node --test`, beside the five existing
management core tests. Cases: empty/absent order; listed-only; unlisted-only; mixed; casing and
whitespace; `No subject` always last; `merge` preserving stored positions; stability for two
subjects with equal rank.

---

## 2. The Generate view (`packet.js`)

### 2.1 The canonical day order

One new function is the whole of reports 1 and 2:

```js
// The order a day's activities are in IS the order they are shown in and the
// order they are numbered in. Defining it in one place is what stops the
// display order depending on which append happened to run last.
function sortDayActivities(dayObj) { ... }   // sorts dayObj.activities in place
```

Sort key, in order:

1. **Subject rank** of the item's course, via `SubjectOrderCore.compare(order)` on
   `coursesById.get(item.instanceId).subject`.
2. **Course**, by `name` (locale compare), tie-broken on `instanceId` — two instances stamped
   from one template for one child legitimately share a name (`storage.js:116-119`), and the
   tie-break keeps them from interleaving.
3. **Walk index** within the course — `walkIndex.get(instanceId).get(activityId)`, which is
   lesson `order` then activity `order` (`pacing.js:38-50`). An activity the walk does not know
   (its lesson was deleted since the log row was written) sorts after every known one.
4. **Activity id**, as a final deterministic tie-break.

It is called once per day at the end of Propose, and again on the affected day(s) after every
Review mutation that moves an item — `relocate`, `pullForward`, and the removals, which cannot
disturb the order but cost nothing to re-run. Kept as *the array's own order* rather than a
render-time `[...arr].sort()` for one specific reason: `projectAssignments` derives `sortOrder`
from array position (`packet.js:672-684`), so sorting the array means the parent's screen and the
child's plan agree, with no change to the projection at all.

Chores and events keep the order they are built in today. Their band numbering is unchanged, and
nothing about them was reported.

### 2.2 What the day looks like

```
2026-08-25  (Mon)          14 items · 5 already assigned
  ▸ Math (5)                                     [subject group]
      ▸ Saxon Algebra 1 (5)                      [course group]
          📘 Lesson 12 · Multiplying fractions — Practice level 3   [walked]  Relocate Exclude Defer
          ...
  ▸ Language Arts (3)
      ▸ Rod & Staff English 5 (3)
          ...
  ▸ No subject (1)
  ▸ Chores (4)
  ▸ Family events (1)
```

- Subject and course groups are `<details>`, reusing the `.course-subject-group` convention the
  app already uses in six places, with the item count in the summary.
- Chores and Family events each get one group per day, at the bottom, in FR-14's fixed order.
  Not reported as a problem, but a day with twelve chore occurrences on it has the same wall of
  rows the school half had, and the group costs one `<details>`.
- **Default open** for every group on this screen. Review is the act of looking at everything
  before committing it, so nothing hides itself by default; collapsing is what the parent does to
  the part they have already cleared. (Contrast §3.2, which defaults closed for the opposite
  reason. Flagged as a decision in §7.2 — it is one constant in each file.)
- **Expand all / Collapse all** buttons in the proposal bar, beside Commit and Abandon. This is
  what makes a 300-row fortnight workable, more than the individual toggles do.

### 2.3 Lesson titles (report 3)

Two rows learn the lesson title, both from `session.maps.lessonTitle`, which already exists:

- **The review row.** `📘 Lesson 12 · Multiplying fractions — Practice level 3` — lesson title
  first, then the activity title, then the activity-type label and the existing
  `origin`/`blockHint`/`already assigned` tags. The activity title alone is what Ray reported as
  not enough; the lesson is the context that makes it a decision.
- **The pending-remainder row**, where Pull-forward is actually chosen. Same prefix. This is the
  more important of the two: `Practice level 3` appearing four times in a bucket of thirty is
  unusable, and the parent is being asked to pick one of them by name.

An activity whose `lessonId` resolves to nothing renders with no prefix, exactly as today.

**No lesson-level `<details>`.** A third nesting level would be redundant: the canonical order
(§2.1) walks a course in lesson order, so a course's lessons are already contiguous runs, and the
row prefix labels each run. Revisit only if the prefix proves too quiet — noted in §7.3.

Also in this section: the **pending-remainder boxes themselves** are ordered by subject then
course name, instead of `pendingByInstance`'s Map insertion order. Same comparator, three lines.

### 2.4 Pull-forward and Relocate land where they belong (report 2)

No change to either function's logic beyond a `sortDayActivities(day)` call before it returns.
The item still appends; the sort then puts it at its walk position inside its own course group,
which is where the parent expected it. Relocate gets the same fix for free, and it had the same
bug.

### 2.5 What this does to `sort_order` — the honest part

`projectAssignments` numbers a day's School band by array position, and §6.6 of the revamp slice
has already-live items **consume** their slot without being re-emitted (`packet.js:672-684`), so
that a second pass's new rows do not renumber on top of rows already in D1.

**For a day committed in one pass** — the ordinary case — the effect is a strict improvement:
`sort_order` now encodes subject-then-course-then-walk order, the child's day groups its courses
in first-appearance order (`planner-core.js:119-122`), and so the child's course order becomes
the parent's standing subject order. Nothing in the Child App changes to get this.

**For a day committed in two passes**, one limitation survives, and it is worth stating rather
than discovering: a live row keeps the number D1 gave it on the first pass, while the second pass
numbers new rows by their *canonical* position. If the second pass inserts an item ahead of a live
row's position — which is exactly what Pull-forward onto an already-committed day does — the new
row's number can disagree with where the screen shows it relative to that live row.

This is a property of §6.6's slot rule, not something grouping introduces; grouping makes it
easier to hit, because inserting into the middle of a day is now a normal action rather than an
accident. Three things bound it: the disagreement is between the *parent's* two screens and never
inside the child's grouping (the child gathers a course into one group however the numbers fall);
the Assignments view's **Sort order** field edits the number by hand today (`assignments.js:41`);
and the ordering rule is deterministic, so two passes that place the same items produce the same
relative order.

**Not doing now, deliberately:** renumbering a whole day at Commit by PATCHing the live rows.
That would have Commit write rows the parent did not ask it to touch, on a screen whose entire
premise (§6.6) is that live rows are somebody else's business. If this bites in practice, that is
the next design conversation, not a silent fix.

### 2.6 Open/closed state

Group state lives on `session` (`openGroups: Set<string>`), not on the DOM, for the reason
`openRemainders` already does (`packet.js:1103-1112`): every Review action re-renders the whole
proposal, and a bucket that collapsed itself under the parent mid-edit is worse than no collapse
at all. Keys are `${date}::subject::${subjectLabel}`, `${date}::course::${instanceId}`,
`${date}::chores`, `${date}::events` — date-scoped, because the same course appears on fourteen
days and they are not one thing.

---

## 3. The Assignments view (`assignments.js`)

### 3.1 Batches behind a collapse (report 4a)

`batchSection` becomes a `<details class="assign-batches">`, **closed by default**, with the
count in the summary:

```
▸ Batches — 7 batches · 3 with outstanding rows
```

Inside, the newest `BATCH_PREVIEW = 10` batches (they are already sorted newest-first,
`:305-318`) with a `Show N older` button lifting the cap, mirroring `REMAINDER_PREVIEW` in
`packet.js`. Open state and the lifted cap are module-level (`let batchesOpen = false`), because
`reload()` rebuilds the results container on every action (`:217-249`).

Rescind buttons are untouched. The section is hidden, not weakened.

### 3.2 Course and chore expanders (report 4b)

Within each day section, rows are grouped exactly as §2.2 groups the proposal:

```
2026-08-25            14 rows, 9 outstanding
  ▸ Math (5)
      ▸ Saxon Algebra 1 (5)
  ▸ Language Arts (3)
  ▸ Chores (4)
  ▸ Family events (2)
```

- Activity rows group by `course_name`, courses group by resolved subject (§3.4), subjects order
  by the standing order.
- Chore rows go in one **Chores** group per day; event rows in one **Family events** group.
- Within a course, the existing sort is kept verbatim (`sort_order`, then title —
  `assignments.js:381-386`). This screen shows what D1 actually holds; re-sorting it by anything
  the parent's local records imply would be lying about the row.
- A row with no `course_name` falls into an **Uncategorised** course group under `No subject`.
- **Default closed** on this screen, with **Expand all / Collapse all** at the top. Ray's words
  for this page were "hide them behind" and "I rarely need to interact with them" — its job is
  scanning and finding one thing, not reviewing everything. See §7.2.
- Group state is module-level for the same `reload()` reason as §3.1, keyed the same way as §2.6.

### 3.3 Lesson titles here too (report 3, second half)

`GET /api/assignments` is `SELECT *` (`worker/index.js:1427`), so `row.payload` already arrives —
as a JSON **string**, D1's TEXT column, unparsed. `rowItem` parses it in a `try/catch` and, for
`kind === 'activity'`, prefixes the title with `payload.lessonTitle` the same way §2.3 does. A
malformed or absent payload yields no prefix and no error. **No Worker change.**

### 3.4 Resolving subject from a snapshot course name

`render()` already loads `children` from IndexedDB before drawing (`:184`). It also loads
`courses`, and builds `Map(course_name → subject)`:

- Instance records for the selected child win over any other record with the same name — they are
  the ones that actually produced these rows.
- Then any other Course record with that name (a template, or another child's instance) fills
  gaps.
- An unmatched name resolves to `No subject` and sorts last.

**A renamed course splits into two headers, and that is correct.** `course_name` is snapshotted
at assign time on purpose (CLAUDE.md §III.B — "a completed assignment records what it *was*"), so
a course renamed mid-term genuinely has rows under both names. The view groups what the rows say,
never what the current record says. The subject lookup simply misses for the old name, which puts
the old rows under `No subject` — visible, honest, and self-explaining once the parent sees the
old name in the header.

---

### 3.5 A sibling-claimed chore is resolved, not outstanding (report 5)

**The report.** Ray has a lot of "either kid can claim" chores. When Sam does one, Ellie's row
keeps showing on the Assignments tab as assigned-but-incomplete, forever. He asked for an
auto-rescind of the losers' rows once the day has passed, with the day's grace kept so an undo
still works.

**What is actually happening.** `handleAssignmentClaim` writes `claimed_by`/`claimed_at` to
*every* live row in the claim group — the winner's and the loser's, in one statement, so the loser
learns the outcome at the same instant — and then writes `status = 'complete'` to the **winner's
row only** (`worker/index.js:2513-2557`). The loser's row staying `pending` is not an oversight:
it is what makes release possible. Undo clears the group's claim and both rows go back to being
available (`:2576-2590`).

**Every other screen already knows this. This one never learned it.**

| Consumer | What it does with a losing row | Where |
|---|---|---|
| Child App planner | Not plannable — it leaves the sibling's plan entirely | `child-app/js/assignment-core.js:85-87` |
| Child App "Completed today" | Listed as claimed-elsewhere, read straight off `claimed_by` | `child-app/js/planner-ui.js:781-788` |
| Management Reporting | `isClaimedElsewhere` — counted in `claimedBySibling`, excluded from the completion-rate denominator, exported to CSV as `claimed-by-sibling` | `reporting.js:83-85`, `:97`, `:174` |
| **Management Assignments** | **Nothing. `isResolved` tests `status` alone (`assignments.js:87-89`), so a losing row is outstanding, editable and rescindable like any pending row.** | — |

So the fact Ray wants is already on the row, written the instant the claim was arbitrated. The
defect is one predicate missing from one view.

**The fix.** `assignments.js` gains the same predicate `reporting.js` has had since the Shared
Chores build:

```js
// Shared Chores §9, mirrored from reporting.js:83 — a `claim` row a sibling
// won. Every row here arrives from /api/assignments?childId=… carrying its own
// child_id (§5.2's SELECT *), so the row answers the question with no child id
// passed in. Copied rather than imported for the same reason the date helpers
// above are: two view modules sharing a runtime file is not worth it.
function isClaimedElsewhere(row) {
  return row.claimed_by != null && row.claimed_by !== row.child_id;
}
```

and then:

- `isResolved(row)` becomes `status(row) !== 'pending' || isClaimedElsewhere(row)`. That one line
  carries the whole change: the row drops out of every `outstanding` count (the summary line, the
  day header, and §3.2's new group headers), and out of `isEditable`/`isRescindable`, which is
  correct — there is nothing left to edit or pull back on work a sibling already did.
- `statusLabel(row)` renders **`Sam did it`** instead of `pending`, resolved through the
  `children` list `render()` already loads (`assignments.js:183-190`), passed down on `ctx`
  alongside `childName`. An unresolvable id falls back to `claimed by a sibling`.
- The row renders in the muted, locked style completed rows already use, inside its day's
  **Chores** group (§3.2).

**Nothing is written, and it works on every row already in D1.** No migration, no Worker change,
no new route, no sweep, no scheduler, no `updated_at` touched. A range Ray looks at tonight will
be right for chores claimed months ago.

### 3.6 Why not the auto-rescind Ray asked for

His instinct — that the losing rows must stop reading as outstanding, and that undo must survive —
is exactly right, and both are delivered by §3.5. The *mechanism* is the part worth arguing with,
in four places:

1. **`rescinded_at` would be a false record.** Rescind means the parent pulled the work back
   (CLAUDE.md §III.C, Revamp §6.3). Nobody pulled these back; the sibling did them. The lie would
   not stay cosmetic: `reporting.js:65-67` buckets exactly `rescinded_at != null && status ==
   'pending'` as **rescinded**, which is precisely the shape a swept loser row would have. Every
   claimed chore would silently move out of `claimedBySibling` — the count that exists to describe
   this — and into "the parent pulled it", quietly wrecking the one report that had this right.
2. **It would break undo, in the worst possible direction.** Release is
   `WHERE claim_group = ?2 AND claimed_by = ?3 AND rescinded_at IS NULL` (`worker/index.js:2576-2581`).
   A rescinded loser row does not match, so it is skipped: the winner's row returns to `pending`
   and the sibling's stays rescinded and off their plan **permanently**. The undo would hand the
   chore back to nobody. The same-day grace narrows the window but does not close it — a parent
   undoing a mis-tap on Tuesday for Monday's chore hits it.
3. **"After the day passes" is not a fact this system has.** Three clocks disagree about it: the
   Child App's device-local date (Feedback Loop §7), the wall's own rollover (Wall Display §5.3),
   and the Worker's UTC `Date.now()`. Putting a permanent, unattended state change on a boundary
   none of them agree on is how a chore disappears at 7pm for a household that is an hour off UTC.
4. **It needs machinery that does not exist, to do work the data already did.** A sweep is either
   a Cloudflare Cron Trigger — a new deploy surface and an unattended write path nobody is
   watching — or a lazy sweep on a read route, i.e. a `GET` that writes. Both are real
   infrastructure. Both are for a question `claimed_by` answered the moment the claim landed.

Recorded as a decision because Ray asked for the mechanism by name:

```
[DECISION] How a losing claim row stops reading as outstanding
Decided: presentation, from `claimed_by` — not an auto-rescind and not a scheduled sweep.
Rationale: the fact is already on the row and every other screen already reads it. Rescinding
  would misreport the outcome in Reporting, would break release/undo by making the sibling's
  row unreleasable, would depend on a day boundary three clocks disagree about, and would need
  a cron or a writing GET to do it. The presentation fix needs no write, no route and no
  migration, and it corrects rows committed months ago.
Locked for: this slice. Reopen only if a real "missed / expired" lifecycle state is wanted for
  every assignment kind (§7.8), which is a different feature with a different owner.
```

### 3.7 Rescinded rows hidden by default (report 6)

`reload()` hardcodes `includeRescinded=1` (`assignments.js:232`), and the comment above it argues
the case: *"a parent looking at a range needs to see what they already pulled back, or they will
pull it back again and wonder why nothing changed."* That reasoning survives — so the rows keep
being **fetched**, and are filtered at render:

- A **`Show rescinded`** checkbox joins the child/date controls, **off by default**, its label
  carrying the count: `Show rescinded (12)`. State is module-level, so it survives the full
  rebuild `reload()` does on every action.
- The summary line always names the number, ticked or not — that is what preserves the original
  comment's warning without the rows on screen.
- Ticked, they render struck-through and inert exactly as they do today. Nothing else changes.
- A day, subject, course or chore group whose rows are all hidden does not render at all. No empty
  headers, no count of zero.

**Why filter at render rather than dropping the query parameter.** One request either way; this
one keeps the count available for the label and the summary, makes the toggle instant with no
refetch, and keeps a single code path through `renderResults`. The cost is that rescinded rows
still consume the `MAX_QUERY_ROWS` cap, so a range with hundreds of them could truncate sooner
than it looks like it should — already covered by the truncation notice the view shows
(`assignments.js:238-242`), and the narrower date range that notice asks for is the same fix.

## 4. CSS

No new layout system. Two new class pairs following the `.course-subject-group` convention
documented at `styles.css:265-299`:

- `.review-subject-group` / `.review-course-group` — Generate.
- `.assign-subject-group` / `.assign-course-group` — Assignments.

Both reuse the existing summary chevron (`::before` on `summary`, rotated under `[open]`),
`-webkit-details-marker: none`, and the count-in-summary styling. Nested groups indent one step;
`.assign-batches` picks up the `.settings-section` collapsed-panel look it should have had from
the start. Bump `styles.css?v=9` → `?v=10` in `index.html`.

---

## 5. Phasing

Four phases, each independently shippable and separately committed. CLAUDE.md §V.A's 2–3 hour
gate is why this is not one build.

| Phase | Contents | Est. |
|---|---|---|
| **0** | This slice; the SRS amendments (Module 08 FR-17 + FR-14 note, Module 11 FR-9); the Roadmap entry; the §9 pointer in the revamp slice. No code. | ~45 min |
| **1** | `subject-order-core.js` + its `node --test` file; `meta['subjectOrder']`; the Settings → Subject order editor; the script tag. Nothing consumes the order yet. | ~1 h |
| **2** | Generate: `sortDayActivities`, the subject/course/chore/event groups, Expand-all/Collapse-all, the lesson-title prefix on review rows **and** remainder rows, remainder boxes ordered by subject. Reports 1, 2, 3. | ~1.5–2 h |
| **3** | Assignments: batches behind a collapse with the preview cap; subject/course/chore/event groups; the `payload.lessonTitle` prefix; the local `course_name → subject` map. Report 4. | ~1–1.5 h |
| **3b** | Assignments, read-side only: `isClaimedElsewhere` folded into `isResolved`, the `Sam did it` label, and the `Show rescinded` checkbox with its count. Reports 5 and 6. | ~45 min |

Phase 3b is independent of everything above it and is the cheapest fix in the slice — if the
Assignments tab is what is hurting most, land 3b first and the rest after.

Phase 1 stands alone and is worth landing on its own — the order is inert until Phase 2, and
Ray can enter it while Phase 2 is being built. Phase 3 depends only on Phase 1.

---

## 6. Acceptance checks

Manual, per CLAUDE.md §IV.C. Run against a real fortnight for one child with at least three
subjects, two courses in one subject, and chores on most days.

**Phase 1**
1. Settings → Subject order lists every subject in use, un-ordered ones marked as such.
2. ↑/↓ then Save; reload the app; the order persists.
3. With a sync token set, the outbox drains and `meta/subjectOrder` reaches D1; Restore from
   cloud on a second browser profile brings the order with it.
4. A course given a brand-new subject appears in the editor at the bottom, unprompted.
5. `npm test` passes, including the new core file's cases.

**Phase 2**
6. Propose a fortnight. Each day renders subject groups in the standing order, courses inside
   them, and activities in lesson-then-activity order inside those.
7. A subject that is not in the standing order appears after the ordered ones; a course with no
   subject appears under `No subject`, last, ahead of Chores.
8. Every activity row shows its lesson title; a lesson-less activity renders unchanged.
9. Pull an activity forward onto a date that already has that course's items — it lands inside
   that course group, in walk position, **not** at the bottom of the day.
10. Relocate an activity to another day — same.
11. Collapse a course group, then use Relocate on another item: the collapsed group is still
    collapsed after the re-render.
12. Expand all / Collapse all reach every group on the screen.
13. Commit, then read the child's plan: the day's courses appear in the standing subject order.
14. Propose the same range again: already-live items still render frozen with `already assigned`,
    inside their groups, and Commit does not re-send them (§6.6 unchanged).
15. A chores-only pass (FR-1a) still renders correctly — no empty subject groups, chores group
    present, School absent.

**Phase 3**
16. Assignments opens with the batch list collapsed; the summary counts match; opening it and
    rescinding a batch still works and the view reloads with the section closed again.
17. With more than ten batches in range, `Show N older` reveals the rest.
18. Day sections render subject → course groups, closed, with counts; chores and events each in
    their own group.
19. Activity rows show the lesson title from `payload`; a chore row is unaffected.
20. Rename a course in the Library, then reload a range containing rows committed under the old
    name: both headers appear, the old one under `No subject`, and nothing errors.
21. Edit a row's Sort order and save — unchanged behaviour, and the row re-sorts within its
    course group.

**Phase 3b**
22. Have one child claim a shared chore from the Child App. In Assignments, the sibling's row for
    that occurrence reads `<name> did it`, is not counted in the day's or the Chores group's
    outstanding count, is not counted in the summary's outstanding total, and offers no Edit or
    Rescind.
23. The winner's own row is unchanged — complete, with its reward intact.
24. Undo the claim from the Child App. Both rows return to outstanding in Assignments, and the
    chore is available to either child again. **This must work for a claim made on an earlier
    day, not just today.**
25. Look at a range containing shared chores claimed weeks ago, committed before this build: they
    read correctly with no migration and no re-commit.
26. A shared chore **nobody** claimed still shows as outstanding on both children's rows (§7.8).
27. Assignments opens with no rescinded rows visible; the summary still names how many there are.
28. Tick `Show rescinded (N)`: they appear struck-through and inert, N matches, and the toggle
    does not refetch.
29. Rescind a row with the box unticked: it disappears from view, the count on the label goes up
    by one, and the summary agrees.
30. A day whose every row is rescinded renders no day header at all while the box is unticked.

---

## 7. Deferred, and the decisions worth flagging

### 7.1 Adopting the standing order in the other subject-grouped views — deferred, cheap

`courses.js` (Course Template Library), `instances.js:616-619` (Assigned Courses) and
`weekly.js:52-56` (the weekly view) all sort subjects alphabetically with `No subject` trailing.
Each becomes one line once `SubjectOrderCore` exists. Left out of this slice because Ray asked
for two screens and consistency across five is a separate call — but the inconsistency will be
visible the moment Phase 1 lands, and this is a ~20-minute phase whenever it is wanted.

### 7.2 Default open (Generate) vs. default closed (Assignments) — a judgement call

Stated as a decision because it is one, and because it is a one-constant change in each file if
it reads wrong in practice:

```
[DECISION] Default expansion state for the new groups
Decided: Generate defaults open; Assignments defaults closed.
Rationale: Review is "look at all of it before committing", so nothing hides by default and
  collapsing is how the parent marks a part as cleared. The Assignments page is "find the thing
  I am looking for", and Ray's own words for it were "hide them behind" and "I rarely need to
  interact with them". Expand-all/Collapse-all on both screens makes either default cheap to
  overrule per session.
Locked for: this slice only. Ray flips either by changing one constant.
```

### 7.3 A lesson-level group — deferred

§2.3 uses a row prefix instead of a fourth nesting level, because the canonical order already
makes a course's lessons contiguous. If a long lesson still reads as a wall of near-identical
activity titles, the group is a small follow-up and the ordering it would need is already there.

### 7.4 Renumbering a day's live rows at Commit — deferred, deliberately

See §2.6. Not a bug this slice created and not one it should fix by having Commit write rows the
parent did not touch.

### 7.5 Subject as a real grouping level in the Child App — still open

`TDS_Slice_Child_Feedback_Loop.md` §11.1, untouched by this slice (§1.4). Nothing here makes it
harder; if it is ever built, the `assignments.subject` column would replace §3.4's local lookup
and the Generate view would not change at all.

### 7.6 A subject vocabulary — not proposed

Subject stays free text on the Course record. A real subject entity (with an id, a rank, and a
picker on the Course form) would end the casing/typo problem that §1.2 papers over, but it is a
schema change and a migration for a household with maybe eight subjects. If typos become a real
annoyance, the cheap half-step is a `<datalist>` of subjects in use on the Course form — not this
slice.

### 7.7 Rescinding a whole shared occurrence in one action — still open

`TDS_Slice_Shared_Chores.md` §13.2: two children's rows for one occurrence come from two Commits
and therefore two batches, so pulling a shared chore back is two rescind actions. §3.5 makes the
losing row non-rescindable once a sibling has claimed it, which is correct — there is nothing to
pull back — but it does not close §13.2 for an **unclaimed** occurrence, where both rows are still
live and still need two actions. Unchanged by this slice, and still worth its own answer
(whether rescind should accept a `claim_group`).

### 7.8 A real "missed" state — not proposed here

A shared chore nobody did leaves both rows `pending`, and §3.5 deliberately leaves them reading as
outstanding: nobody did the dishes is a fact worth seeing. Ray's report was about the *loser* of a
claim, which is a different case with a different answer.

If a genuine expiry is ever wanted — an assignment nobody resolved by some deadline becoming
`missed` rather than eternally pending — it is a lifecycle change for **every** kind, not a
shared-chore patch: it needs a new status value the Child App and the Worker both understand, a
decision about which of the three clocks (§3.6 point 3) owns "the day passed", and a view of what
it does to Reporting's denominator. Worth doing properly if the eternally-pending backlog becomes
the complaint; not worth reaching through the claim mechanism to fake.

### 7.9 Hiding sibling-claimed rows entirely — a one-line default

§3.5 keeps a claimed-elsewhere row **visible**, styled and counted as resolved, because it is the
record of who did the chore — the parent-side view `TDS_Slice_Shared_Chores.md` §13.7 says does
not exist anywhere. If Ray would rather not see them at all, they ride the §3.7 checkbox (renamed
`Show rescinded and resolved-elsewhere`) and the default flips in one line. Flagged rather than
assumed, because "instead of still displaying like assigned but incomplete" reads as *stop looking
outstanding*, not necessarily *disappear*.

---

**End of slice.**
