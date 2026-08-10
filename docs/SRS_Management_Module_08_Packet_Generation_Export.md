# Software Requirements Specification — Management App
## Module 8: Packet Generation & Export
*Written against Domain Model §2.10 (Generated Packet — the Propose/Review/Commit flow, primary source), §2.10a (Generation Log — decision record and generation source of truth), §2.4 (Course/Instance — no pacing cursor; pending remainder derived from the log), §2.9 (Pacing Profile, `daysOfWeek[]`/`pacingMode`), §2.6 (Chore), §2.7 (Family Event), §4.1 (the Packet interchange shape), Interchange Contract §1/§1a/§1b/§4, Architecture Evaluation §5/§8/§11, SRS Management Modules 04 (Child Management — `excludeFromGeneration`, instance content), 05 (Pacing Configuration), 06 (Chore Authoring), 07 (Family Event Authoring), and 03 §8 (authored payload shape).*

---

## 1. Purpose

Turns a Child's paced School content, recurring Chores, and in-range Family Events into one **reviewed, exportable Packet** for a given child and date range — the Management App's half of the interchange (Domain Model §4.1). This module owns *aggregation, the Propose/Review/Commit flow, the Generation Log, merge order, and export*. It does not author Courses/Chores/Family Events (Modules 3/6/7), does not own pacing rules themselves (Module 5 owns the Pacing Profile's fields), and does not import anything back (Completion Import, a separate deferred module).

## 2. Scope notes

**2.0 — This module is milestone M7: the seam. Its exit criterion is not met inside this app.** Packet Generation is where the Management App and the Child App — built by two sessions that never see each other's code — meet for the first time. This module is **not** "done" when it emits a packet that validates against `packet_schema.json`. It is done when a packet it emitted has been imported, clean and end to end, by the actual Child App (Child SRS Module 2; Interchange Contract §8, which makes the fixtures normative for exactly this reason). That is a two-account event this session cannot observe. Produce the packet, hand it to Jen, and stop. A failure at this checkpoint is the single most valuable finding the two-app design can produce, and far cheaper here than at the end of the build.

**2.1 — There is no pacing cursor. The Generation Log is the record of truth.** An Instance stores no pointer into its own content (Domain Model §2.4). What has already gone out, and what is still pending, is *derived* from the Generation Log (Domain Model §2.10a): an Activity is **sent** when a `sent` log row carries its `id`, and **pending** otherwise. This module is the **sole writer** of the Generation Log, and it writes only at **Commit** (§4, FR-8/FR-9). Because the record is keyed by item `id`, reordering, deferring, or pulling an Activity out of sequence never corrupts a walk position — there is no high-water mark to fall out of step (this dissolves the reorder-after-pacing ambiguity Module 05 §2.4 raised).

**2.2 — Generation is one interactive session: Propose → Review → Commit.** The parent triggers a run for one (child, range); the engine **Proposes** a set; the parent **Reviews** and adjusts it; the parent **Commits**, which writes and exports. Propose and Review are in-memory only — abandoning before Commit leaves storage untouched. There is no saved-draft lifecycle: a run is completed in one sitting or discarded.

**2.3 — `daysOfWeek[]` is an explicit weekday set, consulted directly.** School-day determination checks a date's weekday against the Instance's `daysOfWeek[]` and `skipDates[]` — no anchor-day or ordering logic once it is an explicit set. (Review may override this per item — FR-7 relocate — but the *proposal* honors it.)

**2.4 — Export destination is a swappable back end**, mirroring Packet Import (Child Module 2 §2.1). This module specifies the assignment content and structure (§4); *where* Commit writes is a swappable back end with zero effect on the Propose/Review logic above it.

> **Amended 2026-08-10.** This clause was written anticipating a Drive picker. What actually
> landed is the substitution it allowed for: **Commit posts rows to `POST /api/assignments`**
> (`TDS_Slice_Online_Revamp.md` §6.1). There is no committed *file*, so the "manual file-save
> path is permanent" guarantee is repealed along with the constraint that justified it.
> Propose and Review are untouched — only Commit's final act changed.

**2.5 — Each Course Instance paces independently against its own Pacing Profile; there is no shared cross-instance daily cap.** A child with two active Instances can have both contribute Activities to the same School day, each governed only by its own `daysOfWeek[]`/`pacingMode`/budget, never combined into one shared per-day ceiling.

**2.6 — Chores have no `skipDates[]` equivalent.** `skipDates[]` belongs to the Pacing Profile (School-only, Domain Model §2.9). A Chore's `daysOfWeek[]` recurrence has no standing exclusion mechanism — the one way to suppress a single chore date is a Review **drop** (FR-7), which is per-occurrence and does not touch recurrence.

**2.7 — Generation is manually triggered, per (child, range); no scheduled or automatic generation exists.** The parent explicitly selects a child and a range each time. Still true, and still a deliberate choice: `TDS_Slice_Online_Revamp.md` §0 keeps the pacing engine in the parent's browser for this round, so assignments materialize only when the Management App is open. Scheduled server-side generation is deferred, not forbidden — the schema is built to accept it without a migration.

**2.8 — Three distinct removals, never conflated.** Taking an Activity out of a day at Review is not one action but a choice among three, and the difference is the whole point:

| Action | What it means | What Commit writes | Comes back? |
|---|---|---|---|
| **Defer** | Not this run — reschedule implicitly by leaving it queued | *nothing* (no row, no flag) | **Yes** — pending, re-proposed on a later run |
| **Exclude** | Never generate this Activity, for any run | the standing `excludeFromGeneration` flag (Mgmt SRS 04) | **No** — permanent, all future runs |
| **Drop** (Chore only) | Not on *this date* — skip one occurrence | a `dropped` Generation Log row for that occurrence | **No** for that date; recurrence otherwise untouched |

Conflating Defer with Exclude is the bug that either deletes work the parent meant to push a week, or keeps re-proposing work they meant to kill. They are separate verbs with separate storage outcomes.

**2.9 — Reproduction re-derives content, not just placement.** When a re-generated range overlaps an already-committed one, each reproduced item takes its **placement** (its `assignedDate`, and its `sent`/`dropped` disposition) from the log, but its **content** (title, `payload`, `difficultyTier`, `courseName`, `rewardCategoryId`, `sequenceNumber`, etc.) is re-derived from the *current* Management-side records at each Propose. So a corrected title or a renamed Course flows into the reproduced entry — which is exactly what the child's refresh-on-pending import expects (Interchange Contract §1d) and what Module 04 FR-12's rename story describes. The log stores **decisions, never content snapshots**, which is why its rows stay tiny.

## 3. User stories

- As a parent, I want to generate the next stretch of work for one of my kids — paced schoolwork, chores, upcoming events — in one action, instead of assembling it by hand.
- As a parent, I want to **see the proposed week and adjust it before it ships** — move a thing to a different day, skip something this week, pull the next lesson forward — because no auto-pacer gets a real semester exactly right up front.
- As a parent, I want a child with only chores and no active coursework to still get a normal packet, so a light week isn't treated as an error.
- As a parent, I want to re-run a range I already sent without it double-assigning work, and without losing the adjustments I already made to it.
- As a parent, I want each day's list to show schoolwork before chores before events, consistently.

## 4. Functional requirements

### Trigger

**FR-1 — Trigger a run.** The parent selects one Child and a date range (`coversFrom` ≤ `coversTo`, both valid calendar dates). This is the generation unit — one child, one range, per invocation. A UI may batch-select several children for convenience, but each child gets an independent run; nothing about generation is shared or merged across children.

### Propose (writes nothing)

**FR-2 — Propose the School pacing walk (reproduce, then extend).** For the selected Child, the proposed School set is built in two parts:
- **Reproduce.** Every Generation Log row whose `assignedDate` is in range is replayed: each `sent` Activity reappears on its recorded date (a relocated or pulled-forward item on the date it was moved to); each `dropped` Chore occurrence stays suppressed. Reproduced content is re-derived from current records (§2.9).
- **Extend.** For every Course Instance belonging to the Child that has a Pacing Profile (Module 5), determine that Instance's School days in range — any date whose weekday is in `daysOfWeek[]` and not in `skipDates[]` (§2.3). Then distribute the Instance's **pending remainder** — its Activities in pacing-walk order (Lessons in `Lesson.order`, Activities in `Activity.order`), skipping any already `sent` or flagged `excludeFromGeneration` — into those School days, in walk order, up to each day's remaining budget after reproduction:
  - `pacingMode: activityCount` — up to `activitiesPerDay` Activities per day.
  - `pacingMode: minutesBudget` — Activities whose `expectedDurationMin` (or the 15-minute fallback for those missing it, Module 5 §2.3) sum to no more than `minutesPerDay`.
  An Instance whose content is exhausted before the range ends simply contributes nothing further — not an error, no effect on any other source. The pending remainder is a **set membership** question, so an out-of-order pull or a prior defer never skips or double-counts an Activity.

**FR-3 — Propose Chore expansion.** For every Chore belonging to the Child, include one occurrence on every in-range date whose weekday is in that Chore's `daysOfWeek[]` (Module 6) that carries **no prior decision** (no `sent` and no `dropped` log row) — with no start/end scheduling and no standing skip mechanism (§2.6). Each occurrence is emitted under its deterministic per-occurrence ID, `CHR-{choreToken}-{YYYYMMDD}`.

**FR-4 — Propose Family Event filtering and fan-out.** Include every Family Event whose `[startDate, endDate]` overlaps the range **and** whose `childIds[]` includes the Child. Fan-out is this same per-child filter, re-applied whenever a run is triggered for a different named child on the same multi-child event — no separate propagation or copy step. Events carry no log row and no disposition; they are re-derived by overlap on every run.

**FR-5 — `blockHint` defaulting for paced Activities.** If a contributing Instance's Pacing Profile has a non-empty `blockLayout[]` (Module 5 FR-4), cycle through it round-robin to assign a `blockHint` to each newly-paced Activity from that Instance. This is a default only, never enforced, always overridden the moment the child uses the Daily Planner's move-between-blocks action (Child App Module 3). Chores use whatever `blockHint` the parent authored (Module 6), never engine-assigned. Family Events carry no `blockHint`. A Review **relocate** changes an item's date, never its block.

**FR-6 — Stamp interchange-only fields.** On every proposed entry, this module computes fields that are Packet-format, not authored — nothing in Modules 3/6/7 needs new input to produce them (Interchange Contract §1a/§1b):
- Every Activity entry: `payload.kind` (`pageRange` | `reference` | `none` | `freeText`), per the fixed per-type mapping (§4, FR-12); `courseName`, copied from the owning Course's current `name`; `rewardCategoryId`, resolved from the Activity's `difficultyTier` against Module 2's Tier table; `capturesGrade`, the boolean already stored on the Activity at authoring (Mgmt SRS 03 FR-10 — required on every entry, never absent).
- Every Chore occurrence: `required: true` (unconditional — a chore has no optional state) and `rewardCategoryId`, resolved from the Chore's `difficultyTier` the same way.

### Review (writes nothing — in-memory edits to the proposed set)

**FR-7 — Review the proposed set.** Before Commit, the parent may adjust the proposal with the following actions. None of them edits a Pacing Profile record; the profile describes the standing pattern a run *starts* from, never where a one-off adjustment is made (Module 05 §2.8).
- **Relocate** — move one proposed Activity or Chore occurrence to a different date **within `[coversFrom, coversTo]`**, including a date outside the Instance's `daysOfWeek[]`. The target day is created in `days[]` if not already present. The item's block is unchanged.
- **Exclude** — flag a proposed Activity `excludeFromGeneration` (the same standing field settable from Module 04 §2.7 — one field, two doors). It leaves this proposal and every future run. Never available on a Chore or Event.
- **Defer** — remove a proposed Activity from *this* run only. It stays pending and re-proposes on a later run covering an eligible date. No flag, no row.
- **Pull forward** — add an Activity the walk did not propose: the next pending one, or one out of sequence from the same Instance's pending remainder. It takes a date in range the parent chooses.
- **Drop** — remove a single proposed Chore occurrence for its date. Permanent for that date; the Chore's recurrence is untouched and other dates are unaffected. Never available on an Activity or Event.

The day's pacing budget is **advisory** at Review: the parent may leave any day heavier or lighter than `activitiesPerDay`/`minutesPerDay`, and these actions override it with no warning or block. Family Events are informational here and are not individually adjustable.

### Commit (the only stage that writes)

**FR-8 — Commit.** Committing the reviewed set performs, together:
- **Generation Log writes** (FR-9): one `sent` row per Activity and Chore occurrence in the reviewed set, on its final `assignedDate`; one `dropped` row per Chore occurrence dropped in Review; **no row** for a deferred Activity (its absence is what keeps it pending); an excluded Activity's `excludeFromGeneration` flag is persisted (a Module 04 field write) and it gets no row.
- **Packet export** (FR-11): the reviewed `sent` set only, in the Domain Model §4.1 shape.
- **No Instance field is written** — there is no cursor to advance.

If a committed run overlaps a range already committed, each affected log row is **updated in place** (FR-9), never duplicated.

**FR-9 — Write the Generation Log.** One row per decided `(childId, itemId)` (Domain Model §2.10a): `{ childId, instanceId? (Activity rows only), itemId, assignedDate, disposition (sent | dropped), generatedAt }`. For a Chore row, `itemId` is the occurrence ID minted in FR-3; the date is inside the ID, so one row per occurrence per date. For an Activity, `itemId` is its stable `id` and exactly one row exists however many runs touch it — relocating or re-committing updates that row's `assignedDate`/`generatedAt` in place. `sent` rows feed Master Reporting's Roster and produce Packet entries; `dropped` rows produce neither and exist only to keep a dropped Chore occurrence from being re-proposed.

**FR-10 — Idempotent regeneration.** Re-running a range already fully covered, with no Review changes, reproduces the identical Packet and rewrites its log rows identically — it never double-assigns and never re-proposes an item already recorded `sent`, `dropped`, or `excludeFromGeneration`. Re-running a range that extends past covered content walks the pending remainder (FR-2) only across the newly-covered dates. The log — not a cursor — is what makes this exact.

**FR-11 — Export.** The committed Packet is written in the Domain Model §4.1 shape (`schemaVersion: 1`, `childId`/`childName`, `semesterLabel` passthrough, `generatedAt`, `coversFrom`, `coversTo`, `days[]`). Destination is the swappable back end of §2.4. The filename follows the locked convention `packet_{childSlug}_{coversFrom}_{coversTo}.json` (Interchange Contract §7) — `childSlug` is the child's `name`, lowercased, non-alphanumerics collapsed to `-`. The filename is a convenience only; neither this module nor Packet Import ever parses it to decide behavior, and manual file selection is a permanent fallback.

### Output shape (cross-cutting)

**FR-12 — Payload `kind` mapping and projection, not blind copy.** The Packet's `activityEntry` schema is closed (`additionalProperties: false`); an emitted entry carries **only** the fields Interchange Contract §1a lists. This module therefore **projects** each Activity onto that allow-list rather than copying its stored record wholesale — the stored fields `lessonId`, `order`, and `excludeFromGeneration` are not Packet fields and never appear in an entry. Onto the allow-list it adds the FR-6 stamped fields and transforms the authored `payload` into the tagged union, by a fixed per-type map (Interchange Contract §1a; Mgmt SRS 03 §8):

| `payload.kind` | Inner fields | Emitted for |
|---|---|---|
| `pageRange` | `pageRangeStart`, `pageRangeEnd` (from the authored page range) | PDF, Reading Pages |
| `reference` | `reference` (from the authored selector reference) | Video, Quiz, Test, Report, Workbook, Project, Drill |
| `none` | — (Practice Level's `sequenceNumber` is its payload) | Practice Level |
| `freeText` | `text` (from the authored free-text field) | **every** parent-added custom type, any `structurePattern` |

The map is keyed by the canonical Activity Type, **not** derivable from `structurePattern` alone (Practice Level and Quiz are both `count`, yet map to `none` and `reference`). `sequenceNumber` rides as its own top-level field, copied from the authored Activity, and is **required whenever `payload.kind` is `reference` or `none`** (Interchange Contract §1a). All other authored display fields present on the allow-list (`title`, `expectedDurationMin`, `blockHint`, `lessonTitle`, `instructions`) ride through as authored. Every Activity/Chore/Event `id` is carried unchanged — for Chores, the FR-3 occurrence ID — never regenerated beyond that fixed derivation.

**FR-13 — Emit-side structural validation (binding on the generator).** Before a Packet is written, this module verifies it against the structural rules the JSON Schema cannot express (Interchange Contract §1), and must never emit one that violates them:
- `coversFrom` ≤ `coversTo`; every `days[].date` falls inside `[coversFrom, coversTo]`.
- No duplicate `days[].date`. A date with nothing due is omitted, never repeated.
- No duplicate `id` across all three arrays and all days — the one exception being a multi-day Family Event repeating its `EVT-` id once per in-range day (Interchange Contract §1c).
- Each `choreEntry.date` equals its enclosing day's `date`.
- `pageRangeEnd` ≥ `pageRangeStart`.
- `sequenceNumber` present whenever `payload.kind` is `reference` or `none` (schema-invisible — the schema marks it optional — so this pass is the only thing that catches its absence).
- Every `eventEntry` overlaps `[coversFrom, coversTo]`.

**FR-14 — Fixed merge order.** Within each day, content is ordered School Activities, then Chores, then Family Events — never reordered or interleaved differently, regardless of counts.

**FR-15 — Empty-source rule.** A valid Packet is produced whenever at least one source (paced Activities, Chores, in-range Events) yields content for the (child, range) — a child with active Chores but zero currently-paced Instances still receives a normal packet, not an error or empty-packet warning.

**FR-16 — No Reward Ledger visibility.** This module never reads or writes Reward Ledger data (Architecture Evaluation §5/§11 guardrail 6). Nothing about proposing, reviewing, committing, or exporting depends on or reports reward balances. `rewardCategoryId` is a category definition flowing *to* the child, not ledger data.

## 5. Validation rules

| Rule | Detail |
|---|---|
| Date range | `coversFrom` ≤ `coversTo`; both required, valid calendar dates (FR-1). |
| Child | Must reference an existing Child (Module 4). |
| School day determination | Per-Instance: weekday in `daysOfWeek[]`, not in `skipDates[]` (FR-2). |
| Pacing walk order | Lessons in `order`; within a Lesson, Activities in `Activity.order` (Module 5 §2.4) — consulted, not redefined. |
| Pending remainder | An Activity is pending unless it has a `sent` log row or `excludeFromGeneration`; membership by `id`, never by position (FR-2). |
| Minutes-budget fallback | An Activity missing `expectedDurationMin` counts as 15 minutes for budget only (Module 5 §2.3); never written onto the Activity. |
| Chore inclusion | In-range dates whose weekday is in the Chore's `daysOfWeek[]` and that carry no prior decision (FR-3). |
| Relocate target | A date within `[coversFrom, coversTo]`; may lie outside `daysOfWeek[]` (FR-7). |
| Family Event inclusion | `[startDate, endDate]` overlaps the range **and** the Child's `id` is in `childIds[]` (FR-4). |
| Merge order | School, then Chores, then Events — fixed (FR-14). |
| Empty-source | Zero content from all three sources is the only no-packet condition (FR-15). |
| Log identity | One row per `(childId, itemId)`; relocate/re-commit updates in place (FR-9). |
| Structural emit rules | The full FR-13 list is verified before any Packet is written. |

## 6. Permissions

No *additional* per-action PIN. The Management App's `launchPin` (Domain Model §2.11) gates the whole app once per session; this module adds no further gate.

## 7. Inputs / Outputs

**Inputs:** the selected Child and date range (FR-1); reads Course Instances + Pacing Profiles (Modules 4/5), Chores (Module 6), Family Events (Module 7), and the Child's Generation Log rows (to reproduce prior decisions and compute each Instance's pending remainder). Reads current authored content at each Propose (§2.9). Writes to none of these source tables at Propose or Review.

**Outputs (written only at Commit):**
- Generation Log rows — one `sent` per exported Activity/Chore occurrence, one `dropped` per dropped Chore occurrence, updated in place on overlap (FR-8/FR-9). This module is the sole writer of the Generation Log anywhere in the system.
- The exported Packet file (FR-11), in the Domain Model §4.1 shape, to the destination §2.4 resolves to.
- Persisted `excludeFromGeneration` flags for Activities excluded in Review (a Module 04 field), FR-7/FR-8.
- **No** Instance pacing field (there is none), and **no** change to any Course Template, Curriculum, Difficulty Tier/Category, Chore, or Family Event *content*.

## 8. Acceptance criteria

1. Triggering a run for a Child with two active Instances proposes a set whose School days can include Activities from both Instances on the same date, each governed only by its own budget.
2. A proposed set is displayed for Review and **nothing is written** until Commit; abandoning the run leaves the Generation Log, all `excludeFromGeneration` flags, and storage generally untouched.
3. Relocating a proposed Activity to a date outside its Instance's `daysOfWeek[]`, then committing, places it on that date in the Packet and records that date as its `assignedDate`; re-running the same range reproduces it there, not on a pacing-default date.
4. **Deferring** a proposed Activity and committing writes no row and no flag for it; the next run covering an eligible date re-proposes it. **Excluding** it writes the flag and it never re-proposes. The two are observably different outcomes from the same starting proposal.
5. **Dropping** one Chore occurrence and committing writes a `dropped` log row for that `(choreToken, date)`; re-running the range does not re-propose that occurrence, and the Chore's other dates are unaffected.
6. **Pulling forward** an out-of-sequence Activity and committing records it `sent`; the earlier pending Activities it jumped ahead of remain pending and are proposed on the next run, in walk order.
7. Regenerating the same (child, range) with no Review changes produces an identical Packet and leaves the log rows identical — no duplicate rows, no double-assignment.
8. A child with active Chores but zero Course Instances still produces a non-empty Packet.
9. Within any generated day, School Activities precede Chores, which precede Family Events, regardless of counts.
10. A `minutesBudget` Instance with an Activity missing `expectedDurationMin` includes it using the 15-minute fallback for budget math, without writing any duration onto the Activity record.
11. An emitted `activityEntry` contains only allow-list fields — the stored `lessonId`, `order`, and `excludeFromGeneration` never appear — and carries a `payload` matching the FR-12 map (a Quiz → `reference`, a Practice Level → `none`, a custom type → `freeText`), plus non-null `courseName`, `rewardCategoryId`, and `capturesGrade`.
12. A proposed Activity whose `payload.kind` is `reference` or `none` and which somehow lacks a `sequenceNumber` fails FR-13's emit-side check and no Packet is written — even though `packet_schema.json` alone would accept it.
13. Committing a run of 5 Activities and 2 Chore occurrences writes 7 `sent` Generation Log rows, each with the correct `itemId` and `assignedDate` — not one summary row.
14. No Reward Ledger data of any kind is read, referenced, or written anywhere in this module.
15. Reordering an Instance's Activities between two runs changes only the order in which its still-pending Activities are proposed next — never which Activities have already gone out, and never a duplicate or a skip.
