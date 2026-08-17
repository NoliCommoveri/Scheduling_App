# TDS Slice — Generation Scope (School / Chores / Events separately)

**Status:** Built 2026-08-17
**Scope:** Management App only. No Worker change, no migration, no schema change, no new route,
no credential change, no change to what any client may write.
**Amends:** `SRS_Management_Module_08_Packet_Generation_Export.md` (FR-1, new FR-1a, FR-14).

> **Authoring note.** CLAUDE.md §II.2 requires a TDS slice to exist before code is written, and
> none existed for this. It was authored in the same session as the build, from Ray's in-session
> request, rather than handed to the session pre-written. Nothing here is a departure from a locked
> decision — §0.2 lists what was checked — but the ordering is worth knowing when reading it back.

---

## 0. What this is, and what it is not

**It is a filter on what Propose places.** The Propose form gains an **Include** fieldset with
three checkboxes — School, Chores, Family events — all ticked by default. A run places only the
ticked kinds. Everything downstream of placement is unchanged.

**It is not a new generation mode.** Every step it gates was already independent: the school walk
reads pacing profiles, chore expansion reads chore recurrence, events read date overlap. A
narrowed run is the same code walking a subset, never a different algorithm. Nothing branches on
scope except the four `if`s that decide whether a step runs at all.

**It is not stored anywhere.** Scope is a property of one invocation. It is not on the Child, not
on the range, not in the Generation Log, and not on an assignment row. Nothing downstream can tell
which passes produced a day, and nothing needs to.

**It is not a way to un-assign anything.** A kind left out of a run is untouched by that run — its
log rows stand, its live assignments stand. Unticking School does not withdraw school work; it
declines to look at it.

### 0.1 Why it exists

FR-1's generation unit was "one child, one range". For a real fortnight that is one child's school
walk (a few hundred activities), every chore occurrence, and every overlapping event, all on one
screen. The proposal lives **in memory only** — Propose writes nothing, and the sole ways out are
Commit and Abandon — so the review cannot be put down and picked up. Ray's report is that a week
at a time is already too much to do in one sitting.

The axis that actually divides the work is **kind**, not date. School review is per-course pacing
judgement; chore review is a recurrence sanity check; they are different tasks with different
questions, and interleaving them per day is what makes the screen long. Narrowing the range
instead — the obvious alternative — does not help, because it shortens every kind at once and
multiplies the number of runs.

### 0.2 What was checked before building

| Constraint | Finding |
|---|---|
| Column ownership (CLAUDE.md §0, §III.B) | Untouched. Commit still emits exactly the rows `projectAssignments` built before; only *which* rows get built changes. |
| No new route, credential or schema | None. `propose()` takes one more argument; the POST body is byte-identical in shape. |
| Duplicate prevention (Revamp §6.6) | This is what makes multi-pass safe, and it already existed — see §3. |
| Cross-app code sharing (§I.A) | None. One file, `management-app/js/packet.js`, plus its stylesheet. |
| Free tier (§0) | No inference, no new storage, fewer reads on a narrowed run. |

---

## 1. The passes compose because §6.6 already made them compose

This is the whole design, and it is worth stating before the mechanics, because it is the reason
the change is four `if`s rather than a rewrite.

Revamp §6.6 made re-proposing an already-covered range safe: Propose asks D1 what is already live
in the range, marks matching items `committed`, shows them frozen with an "already assigned" tag,
and leaves them out of Commit. That was built for the parent who proposes the same fortnight twice
by accident.

A second pass with different kinds ticked **is** that same act. Propose chores-only for week 1 and
commit; then propose school-only for week 1: the school run sees no chores at all (they were not
placed), places its activities, and sends them. Propose *everything* for week 1 afterwards and the
chores and activities both come back marked `committed`, and Commit sends nothing new.

So the ordering of passes does not matter, re-running a pass does not matter, and a pass that
overlaps a previous one is the case §6.6 was written for. **No new idempotence machinery exists in
this slice.**

---

## 2. Mechanics

`propose(childId, semesterLabel, coversFrom, coversTo, include)` — `include` is
`{ school, chores, events }`. Absent means all three, which is what every pre-slice call meant.
Empty is rejected before any read.

Four gates, one per placement step:

| Step (SRS ref) | Gate |
|---|---|
| Per-instance pacing walk (setup for FR-2) | Skipped wholesale when School is out — this is a profile read and a full activity walk *per assigned course*, and nothing outside the School steps reads what it builds. |
| Step 2 — reproduce prior decisions (FR-2 replay) | Filtered per row: `row.instanceId` means School, its absence means Chores. |
| Step 3 — extend the school walk (FR-2) | Runs only when School is in. `pendingByInstance` stays empty otherwise, so the Pull-forward buckets render nothing without needing their own gate. |
| Step 4 — chore expansion (FR-3) | Runs only when Chores is in. |
| Step 5 — event fan-out (FR-4) | Runs only when Events is in. |

Step 6 (§6.6's already-live marking) is **not** gated. It measures whatever is in `days` against
the live plan; a narrower `days` simply means fewer items to mark. The D1 query it makes is
range-scoped and kind-agnostic, so its key set is a harmless superset.

Commit is unchanged in mechanism. `sentRows`, `droppedRows` and `excludeIds` are all derived from
what is on screen, so they narrow with the proposal for free — which is exactly the property that
makes "a kind left out is a kind left alone" true rather than merely intended.

### 2.1 Reproduction is filtered, and that is not the same as forgetting

Step 2 replays prior `sent` decisions so the parent sees the whole range. On a chores-only run it
replays chore decisions and not school ones. Those school log rows are not lost, reset, or
re-decided: Commit's log write is built from what is on screen, so a decision this run does not
reproduce is also a decision it does not touch. The next run with School ticked replays them
normally.

---

## 3. `sortOrder` bands (FR-14)

The one place a narrowed run needed more than a gate.

`sortOrder` was a single counter per day across all three kinds, with already-live items consuming
a slot without emitting a row (Revamp §6.6 — skipping the slot would renumber new rows on top of
existing ones). That made an item's number depend on **how many items of the other kinds the same
proposal placed** — invisible while every run placed all three, because the count was then the
same every time.

Narrowed runs break the assumption. A day with five live activities and three live chores,
re-proposed chores-only to pick up a newly authored chore: the chores now start at 0 instead of 5,
and the new chore lands at 3 — above chores committed on the earlier pass, where a full re-run
would have put it at 8, below them.

**Fix:** each kind numbers within its own band — School from 0, Chores from 1000, Events from 2000.
A kind's numbering depends only on that kind, so a narrowed pass and a full pass give the same item
the same slot.

**Why the gaps are free:** nothing compares across bands. `planner-core.js` `filterView` splits
School from Chores into separate views, and its day view builds `school` and `chores` as separate
arrays; events sort on their own by date and id. Within a kind the numbers stay dense and
ascending. The child's manual reorder writes `child_sort_order` by **midpoint** between
neighbours, so it is relative and indifferent to magnitude.

**Rows committed before this change keep their old numbers**, and no backfill is needed: old rows
sit at low numbers and stay correctly ordered among themselves, and the bands only ever place
newer rows after them — which is the right relative order for something added later anyway.

---

## 4. UI

- **Include fieldset** on the Propose form: three checkboxes, all ticked by default, with a line
  explaining that omitted kinds are untouched and safe to propose later. Uses the existing
  `fieldset`/`legend`/checkbox-label convention already styled for the app (Module 06's day picker,
  Module 07's child picker) — the only new CSS is a full-width basis for the hint line and the
  scope tag's type scale.
- **Last-used scope is remembered for the session** (a module-level variable, not persisted), so
  proposing chores-only for one child and then the next does not mean re-unticking School each
  time.
- **Scope tag in the proposal heading** — "Chores only", "School and Chores", or the full set. A
  chores-only proposal and a full one are indistinguishable once the school walk happens to be
  short, and Commit is one press away.
- **Both empty-source messages name the scope** when it is narrowed. "Nothing to generate for this
  range" is actively misleading after a chores-only run over a fortnight with a full school walk in
  it: the parent's next move should be to re-propose with School ticked, not to go hunting for why
  their courses produced nothing.

---

## 5. Acceptance checks

Manual — `packet.js` is not in `tests/`, which covers the pure layers only (CLAUDE.md §I.B).

1. Propose with all three ticked over a range with school, chores and events → identical to the
   pre-slice proposal, same items, same order.
2. Untick everything → rejected, nothing read.
3. Chores-only over a range with an active course → chores only; no Pending remainder buckets; the
   heading reads "Chores only".
4. Commit that, then propose school-only over the same range → activities only, none of them
   tagged already-assigned; commit succeeds.
5. Then propose all three over the same range → everything appears, all of it tagged already
   assigned, and Commit is blocked with the "already assigned … nothing new to send" message.
6. Reverse the order of 3–5 (school first, then chores) → same end state.
7. Chores-only over a range with no chores → "Proposal is empty … within chores only. Abandon and
   propose again with the other kinds ticked to see them."
8. On the child's tablet after 4: the day shows school and chores in their own views, each in
   authored order, with nothing duplicated and nothing out of sequence.
9. Author a new chore, re-propose chores-only over an already-committed range → only the new
   chore's occurrences are sendable, and on the child's tablet it sorts *after* the chores
   committed earlier (the §3 band check).

---

## 6. Deferred

- **Per-course scope.** "Propose Math only" is the same idea one level down and would help a parent
  whose school walk alone is too long. Not built: the Include filter is on kind, which is a fixed
  set of three, and per-course means a variable-length picker plus a decision about what the
  pending-remainder buckets mean when some courses were not walked. Worth revisiting only if
  school-only runs are still too big in practice.
- **Resumable proposals.** The real constraint behind §0.1 is that the proposal is in memory and
  cannot be put down. Scope narrows the sitting; it does not make one interruptible. Persisting a
  proposal is a genuinely larger change (it would need a store, a staleness rule against
  re-authored content, and an answer for two devices holding proposals for the same range) and is
  not proposed here.
