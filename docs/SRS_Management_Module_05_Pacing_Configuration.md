# Software Requirements Specification — Management App
## Module 5: Pacing Configuration
*Written against Domain Model §2.9 (Pacing Profile — primary source, including `daysOfWeek[]` and `pacingMode`), §2.10 (Generated Packet — Propose/Review/Commit, the consumer of pacing output), §2.10a (Generation Log — where pacing progress is now read from), §2.4 (Child Course Instance — no pacing cursor; pending remainder derived from the log), §2.5 (Activity — `expectedDurationMin`, `sequenceNumber`, `excludeFromGeneration`), §2.8 (Lesson — `order`, and the distinct Content Planning fields), Architecture Evaluation §4/§8/§12, Documentation Roadmap §3/§4/§8, and SRS Management Module 04 (Child Management — the stamping action this module's setup step follows).*

---

## 1. Purpose

Lets the parent configure how one Child Course Instance's Activities get distributed across days — the input the (not-yet-written) Packet Generation module consults on every run. This module owns the Pacing Profile itself: its fields, validation, and edit lifecycle. It does not perform generation, does not touch Chores or Family Events (out of scope for pacing entirely — Domain Model §2.9), and does not decide *what* Activities exist (Course Template Library, Module 3) or *which* Instance they belong to (Child Management, Module 4).

## 2. Scope notes

**2.1 — Pacing progress is derived, not stored (Domain Model §2.4/§2.10a).** An Instance carries no pacing cursor. How far its content has been walked is read from the **Generation Log**: an Activity is **sent** when a `sent` log row carries its `id`, **excluded** when flagged `excludeFromGeneration` (Mgmt SRS 04 FR-14), and **pending** otherwise. The pending set is what a future run distributes; sent and excluded Activities are both accounted for and no longer pending. **This module only reads the log for display (FR-8) — it never writes it. The log is written exclusively by Packet Generation (Management SRS Module 08), and only at Commit.**

**2.2 — `pacingMode` (Pacing Profile, Domain Model §2.9).** Every Pacing Profile has exactly one `pacingMode` — `activityCount` or `minutesBudget` — chosen at setup, changeable later (§2.9's "adjustable through the semester" already covers this).

**2.2a — `daysOfWeek[]`.** A Pacing Profile carries a required, non-empty subset of `{Sun, Mon, Tue, Wed, Thu, Fri, Sat}`, no duplicates — the same shape and validation already established for Chore (Management SRS Module 06 §2.1). This is what tells the (future) generation engine which specific weekdays a Profile's days fall on, rather than leaving it to infer an anchor day from a bare count.

**2.3 — Minutes-budget fallback duration, a working assumption.** Under `minutesBudget` mode, the (future) generation engine needs a duration per Activity to know when a day's budget is spent — but `expectedDurationMin` is optional on Activity (§2.5) and may be absent. **Assumption applied:** an Activity missing `expectedDurationMin` is treated as **15 minutes** for budget-consumption purposes only; this never writes a value back onto the Activity itself, it's a generation-time fallback. Flag if you'd rather use a different default, or block `minutesBudget` mode entirely until every Activity in the Instance has a real duration set.

**2.4 — Pacing walk order.** Lessons are walked in `Lesson.order`; within each Lesson, Activities are walked in **`Activity.order`** ascending. A per-Activity `order` field exists (Domain Model §2.5) precisely so that this walk has something to read: the storage layer is relational (`activities` keyed by `id`), and IndexedDB returns records in **key order — alphabetical by composite ID — not authored order**. `order` is contiguous from `0`, system-maintained, and reorderable by the parent (Mgmt SRS 03 FR-9). This governs pacing consumption order only; it has no effect on the Daily Planner's own child-facing reorder capability (Child App Module 3, cosmetic and independent).

**Reordering after pacing is a non-issue.** With progress derived from the Generation Log by item `id` (§2.1) rather than a stored position, reordering an Instance's Activities after some have been sent cannot leave a pointer stranded — sent Activities stay sent, pending ones stay pending, and `order` simply re-sequences the pending remainder for the next run. (This was an open question while a cursor existed; retiring the cursor closed it.)

**2.5 — `weighting` remains an unspecified, open field — this module does not implement it.** Domain Model §2.9 lists `weighting` as an optional field with no defined shape, and no user story anywhere has asked for one yet. Same treatment as the still-open custom Activity Type payload shape (Domain Model §6 item 4): the field name is reserved, but this module builds no mechanics around it. Flag if you want this scoped now instead of left open.

**2.6 — Pacing Profile setup is the natural companion step to Module 4's stamping action.** Domain Model §2.9 states a Pacing Profile is "set at instance creation" — meaning a freshly-stamped Instance (Module 4 FR-4) isn't really usable by generation until this module's setup also runs. Module 4's FR-4 flags pacing setup as the required next step. This module treats "Instance exists with no Pacing Profile yet" as a valid, expected transient state (not an error) — the parent completes pacing setup as the very next step in the same flow, but nothing here assumes it happens atomically.

**2.6a — A stamped Instance now arrives with a starting Pacing Profile, derived from the Course's pacing hint.** §2.6's transient "Instance with no Profile" state stays *valid* — nothing here treats it as an error, and Instances stamped before this change still have none — but it is no longer the *normal* outcome of stamping. Module 4 FR-4 step 6 calls this module's `ensureDefaultProfile`, so the write still happens here and `pacingProfiles` still has exactly one writer.

The source is `defaultPacingHint` (Mgmt SRS 03 §4), a free-text field that until now nothing read. Its documented form is one or more labelled clauses — `Activities Per Day - 2`, `Minutes Per Day - 60`, `Days - Mon/Wed/Fri` — separated by `;` or a newline, with commas free for use inside a day list. Looser phrasings already typed into the field are read too (`45 min a day, Mon-Thu`; `three lessons per day`; `MWF`), and a per-*week* figure is deliberately not read as a per-day budget.

Three rules keep the derivation honest:

- **The hint never decides anything the parent can't see.** The stamp confirmation states the resulting pace and which half of it came from the hint; the Profile is then editable exactly as any other (FR-2).
- **Silence takes a default, not a guess.** A hint stating no days gets Mon–Fri; a hint stating no budget gets `activityCount` with `activitiesPerDay: 1` — the conservative direction, since under-pacing shows up as a thin packet at Review while over-pacing shows up as an overwhelmed child. A hint naming both a count and a minutes figure is read as a count with commentary attached.
- **Nothing is ever overwritten.** `ensureDefaultProfile` is a no-op when a Profile already exists, and a failure leaves the Instance profile-less (§2.6) rather than half-paced.

`startDate` cannot come from a hint; the seed uses the date the Course was stamped.

**2.7 — Deleting an Instance (Module 4 FR-6) implicitly deletes its Pacing Profile too.** A Pacing Profile is 1:1 with its Instance and has no independent existence; this module offers no separate "delete Pacing Profile" action. Module 4's FR-6 and §7 Outputs state the cascade explicitly.

**2.8 — This module owns the standing pacing rules; it does not own per-item, per-run decisions.** Excluding a specific Activity from ever being generated (`excludeFromGeneration`, Domain Model §2.5) is set directly on the Activity (Mgmt SRS 04 FR-14) or from within Packet Generation's Review stage (Mgmt SRS 08, before Commit) — never here. Likewise, every per-run adjustment — relocating a proposed item's date (including onto a day outside `daysOfWeek[]`), deferring an Activity out of one run, pulling one forward, dropping a single Chore occurrence — happens inside that same Review stage (Mgmt SRS 08 FR-7) and never edits a Pacing Profile record. This module's fields describe the standing pattern a generation run *starts* from; they are never the place a one-off, per-run adjustment gets made.

## 3. User stories

- As a parent, I want to tell the app how many days a week and how much work per day my child should get, so their daily plan feels appropriately paced, not overwhelming.
- As a parent, I want to exclude specific dates (holidays, trips) from pacing without having to touch `daysOfWeek[]` itself.
- As a parent, I want to adjust the pace mid-semester without it silently rewriting work my child has already been assigned.
- As a parent, I want to see at a glance how far along an Instance's content has already been walked.

## 4. Functional requirements

**FR-1 — Create Pacing Profile.** Set up immediately after (or as part of the same flow as) stamping a Course to a Child (Module 4 FR-4, §2.6). Required: `daysOfWeek[]` (§2.2a — a non-empty subset of Sun–Sat, same shape as Chore's field), `pacingMode` (§2.2) with its corresponding budget value (`activitiesPerDay` if `activityCount`, `minutesPerDay` if `minutesBudget`), `startDate`.

**FR-1a — Seed a Pacing Profile at stamp time (§2.6a).** When Module 4 stamps a Course to a Child, this module creates that Instance's starting Profile from the Course's `defaultPacingHint`: `daysOfWeek[]` and the mode's budget from whatever the hint states, the defaults in §2.6a for whatever it does not, and `startDate` = the stamp date. The result is an ordinary Profile — it passes the same FR-6 validation, and FR-2 edits it like any other. No-op if the Instance already has one.

**FR-2 — Edit Pacing Profile.** Any field can be changed at any time through the semester. Per Domain Model §2.9's own rule, an edit affects only *future* generation — it re-shapes how the pending remainder (§2.1) is distributed; anything already recorded `sent` in the Generation Log is untouched. This module does not retroactively re-pace or recall anything already generated.

**FR-3 — Skip dates.** The parent may add or remove specific calendar dates (`skipDates[]`) excluded from generation for this Instance, independent of the `daysOfWeek[]` pattern (e.g., a holiday that happens to fall on an otherwise-scheduled day).

**FR-4 — Block layout (optional, advisory).** The parent may optionally set an ordered list of block labels (`blockLayout`) that the future generation engine can cycle through when assigning a generated Activity's `blockHint`. Purely a default-assignment convenience — never enforced, never validated against anything the child later does with it (the Daily Planner's own move-between-blocks action, Child App Module 3, always wins). **`blockLayout` should use only the four canonical block labels** — `morning`, `afternoon`, `evening`, `night` (Interchange Contract §1d). On the child device the block **is** the outer grouping axis of the Today view (Domain Model §3.4), so a label outside the four is not rejected but is not honored either: the child displays that item under `morning`.

**FR-5 — Weighting field reserved, not implemented (§2.5).** The Pacing Profile form may show a placeholder/reserved spot for `weighting`, but no behavior is built around it in this module.

**FR-6 — Mode-specific validation.** `activityCount` mode requires a positive-integer `activitiesPerDay`. `minutesBudget` mode requires a positive-integer `minutesPerDay`; Activities without their own `expectedDurationMin` fall back to the 15-minute assumption (§2.3) for budget purposes only, never writing that value onto the Activity.

**FR-7 — One Profile per Instance, no independent delete.** A Pacing Profile is created once per Instance (FR-1) and edited thereafter (FR-2) — this module has no "delete Pacing Profile" action separate from deleting the Instance itself (Module 4 FR-6/FR-7, which cascades the Profile — §2.7).

**FR-8 — Progress display (read-only).** The parent can view, for a given Instance, how far its content has been accounted for — e.g., "12 of 40 Activities sent" — derived from the **Generation Log** (§2.1): the count of the Instance's Activities carrying a `sent` row, against its total Activity count. Activities flagged `excludeFromGeneration` are removed from the *pending* count the same way sent ones are (they will never be proposed), so the display may present them as a distinct "excluded" tally rather than folding them into "sent." This module only reads the log for this figure; it writes nothing. The log is written exclusively by Packet Generation, and only at Commit.

## 5. Validation rules

| Rule | Detail |
|---|---|
| `daysOfWeek[]` | Required; non-empty subset of {Sun, Mon, Tue, Wed, Thu, Fri, Sat}; no duplicates. Same shape and validation language as Chore's field (§2.6). |
| `pacingMode` | Required; exactly one of `activityCount` \| `minutesBudget` (§2.2). |
| `activitiesPerDay` | Required if `pacingMode: activityCount`; positive integer. |
| `minutesPerDay` | Required if `pacingMode: minutesBudget`; positive integer. |
| `startDate` | Required; valid calendar date. |
| `skipDates[]` | Each entry a valid calendar date; duplicates ignored, not rejected. |
| `blockLayout` | Optional; if provided, a non-empty ordered list of labels — never validated against anything the child does downstream. |
| `weighting` | No validation — field not implemented (§2.5). |
| Pacing progress | Derived read-only from the Generation Log (§2.1/FR-8); this module writes and validates no generation state. |

## 6. Permissions

No *additional* per-action PIN. The Management App's `launchPin` (Domain Model §2.11) gates the whole app once per session; this module adds no further gate.

## 7. Inputs / Outputs

**Inputs:** parent-entered Pacing Profile fields (create/edit); reads the target Instance's Activity set and its `sent` Generation Log rows (for FR-8's display) — writes to neither.

**Outputs (written to Management App storage):**
- New or updated Pacing Profile fields, scoped to one Instance.
- No change to any Course, Lesson, Activity, Curriculum, Chore, Family Event, or Child data. No write to the Generation Log or any generation state under any circumstance — that remains Packet Generation's responsibility alone, and only at Commit.

## 8. Acceptance criteria

1. Creating a Pacing Profile with `pacingMode: activityCount` succeeds when `activitiesPerDay`, `daysOfWeek[]`, and `startDate` are all provided; omitting `minutesPerDay` in this mode is not an error.
2. Creating a Pacing Profile with `pacingMode: minutesBudget` succeeds when `minutesPerDay`, `daysOfWeek[]`, and `startDate` are all provided; omitting `activitiesPerDay` in this mode is not an error.
3. Editing any Pacing Profile field never alters a Generation Log decision or anything already sent by a prior Commit.
4. Adding a date to `skipDates[]` excludes that date from future generation without changing `daysOfWeek[]` or any other field.
5. An Instance with no Pacing Profile yet is not treated as an error state by this module — a valid state for anything stamped before §2.6a, and for a stamp whose seed failed.
5a. Stamping a Course whose `defaultPacingHint` reads `Activities Per Day - 2; Days - Mon/Wed/Fri` yields a Profile of exactly those values, `startDate` = the stamp date, and no `minutesPerDay` key; stamping one with no hint yields Mon–Fri, `activityCount`, `activitiesPerDay: 1` (§2.6a). Both are then editable under FR-2, and neither writes anything to the Generation Log.
6. The progress display (FR-8) reflects the Generation Log accurately and is never editable from this module's UI.
7. No mechanism anywhere in this module allows deleting a Pacing Profile independent of deleting its Instance.
