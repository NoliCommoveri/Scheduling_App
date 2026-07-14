# Software Requirements Specification — Child App
## Module 4: Activity & Chore Completion / Logging

*Written against Domain Model §2.3/§2.5/§2.5a/§2.6/§3.5/§3.6/§3.7/§4.2, Architecture Evaluation §9/§13, Documentation Roadmap §2/§3.*

---

## 1. Purpose

Captures completion of an Activity or a Chore from the Daily Planner's entry point (Module 3, FR-7), creating the Activity Record, triggering the flat Reward Ledger earn, and feeding the Streak's qualifying-day check. This module owns *what gets captured at the moment of completion* — it does not own how items are displayed (Module 3) or how the streak/ledger derive their state from records (their own modules).

## 2. The Activity Type → capture-field matrix, and the runtime mechanism

**Grade format:** where a grade is captured, it is a **percentage, 0–100, optional** — the child can complete the item and leave it blank.

| Activity Type | Capture beyond completion timestamp |
|---|---|
| Quiz | Optional grade (0–100%) |
| Test | Optional grade (0–100%) |
| Project | Optional grade (0–100%) |
| Report | Optional grade (0–100%) |
| PDF | Optional grade (0–100%) |
| Drill | Optional grade (0–100%) |
| Workbook | Optional grade (0–100%) |
| Video | None |
| Practice Level | None |
| Reading Pages | None |

**Chores are not on this matrix.** Activity Type is a field on Activity (§2.5), not on Chore (§2.6) — the domain model never gives Chores a type at all. Chore completion is therefore always the simple case: timestamp only, no grade, regardless of what the chore is. See FR-2.

**This table is authoring-time reference documentation, not the Child App's runtime branching mechanism.** Domain Model §2.5a is explicit that Activity Type as an entity **does not exist on the Child App side at all**: the Child App only ever reads the boolean `capturesGrade` already carried on each Activity/Packet entry — it never needs type names or the managed table.

The table above exists so a reader can see which of the ten canonical types are grade-optional — useful for understanding *why* `capturesGrade` ends up `true` or `false` for a given Activity at authoring time (Management App, Domain Model §2.5/§2.5a). But **this module branches on the `capturesGrade` boolean already present on the received item (Domain Model §3.5), never on the Activity Type name itself.** This is why a parent-added custom Activity Type (Domain Model §6 item 4) needs **zero** change to this module: whatever `capturePattern` the parent chose for their custom type at creation flows into `capturesGrade` on every Activity of that type, and this module reads that boolean exactly like it would for any of the ten canonical types. See FR-1.

## 3. Scope notes

**3.1 — Activity Record field names match the Domain Model exactly.** This module produces a record shaped `{ activityId, date, status, exported, grade? }`, matching Domain Model §3.6:

| Field | Detail |
|---|---|
| `activityId` | The stable join key (Activity or Chore; both use the same convention, §2.5/§2.6). |
| `date` | The device-local date the item was marked complete — see FR-5. |
| `status` | `'complete'` on creation through this module. `waived` is written by a different flow entirely (Module 5's Waive, not this one). |
| `exported` (boolean) | Written `false` at creation (FR-5) — it is the one field on the record this module writes that isn't set to its final value here; Module 8 flips it to `true` on successful export. |
| `grade` (optional) | Present only for grade-capture Activity Types when a value was entered; absent (not blank) otherwise. |

**3.1a — `exported` is the one deliberately-mutable field.** Every other field this module writes (`activityId`, `date`, `status`, `grade`) is set once, at creation, and never touched again by any module. `exported` is different: this module writes it `false` and never revisits it, but Module 8 later flips it `true`. That's not a violation of this record's immutability (Domain Model §3.6 Rules carries the same carve-out) — it's the one deliberately-mutable field, and only Module 8 is allowed to write to it after creation.

**3.2 — Time-tracking or notes at completion would be a new feature to scope deliberately, not a gap to quietly fill.

**3.3 — Grade is a standing Completion CSV column.** Domain Model §4.2 lists `grade` as a standing column in the locked, authoritative list.

**3.4 — `status` value spelling is `complete`.** Domain Model §3.6 uses the value `complete`, matching this module, Module 8, Module 9, and Module 5.

## 4. User stories

- As a child, I want to mark my work done with one tap for things like videos or drills, without being forced to enter a score I don't have.
- As a child, I want to optionally record my score on a quiz or test if I know it, without it blocking me from finishing.
- As a parent, I want a grade I see recorded to actually mean something — captured once, not silently changeable later.

## 5. Functional requirements

**FR-1 — Completing an Activity.** From the Daily Planner's completion entry point, behavior branches on the item's `capturesGrade` boolean (Domain Model §3.5 — carried on the received Activity, never looked up by Activity Type name; see §2):
- **`capturesGrade: false`** (the ten canonical types map to this as shown in §2's reference table — Video, Practice Level, Reading Pages, and any custom type the parent gave a `no-capture` pattern): tapping complete immediately marks the item done, capturing only the completion date. No further step.
- **`capturesGrade: true`** (Quiz, Test, Project, Report, PDF, Drill, Workbook in §2's table, and any custom type given a `grade-optional` pattern): tapping complete offers a grade entry (0–100%); the child may enter a value or skip it, and either way the item is marked complete — grade entry never blocks completion.

This module never inspects `activityType` itself to decide capture behavior — only `capturesGrade`. §2's table is what determines that boolean's value at authoring time (Management App side); this module doesn't re-derive it. **The same discipline applies to whatever reference material the completion screen shows alongside an item** (a page range, a platform selector reference, free text): it renders by the item's `payload.kind` (`pageRange` | `reference` | `none` | `freeText`, Interchange Contract §1a), never by `activityType` — a parent-added custom Activity Type needs zero change here for the same reason it needs none for `capturesGrade`.

**FR-2 — Completing a Chore.** Always the simple case: mark complete, capture the completion date only. Chores carry no `activityType` and no `capturesGrade` field at all (§2.6) — this isn't a `capturesGrade: false` case, it's the field being entirely absent, and this module treats "absent" the same as "false." No grade is ever offered (§2).

**FR-3 — Grade capture rules.** When provided, grade is a whole number 0–100. It is captured once, at the moment of completion, and — consistent with the Activity Record being immutable (§3.6) — is not editable after that moment through this module. (A parent-PIN-gated correction path for a mis-entered grade would be a small, deliberate addition, not something assumed here.)

**FR-4 — Reward Ledger earn is unaffected by grade.** Completing an item — with or without a grade, and regardless of the grade's value — earns exactly **1** unit into the item's `rewardCategoryId` category, per the flat-earn rule locked in §2.3/§3.7. `rewardCategoryId` is carried directly on the received item (Domain Model §3.5/§3.5a) — this module never resolves `difficultyTier` against a lookup table, since none exists on the Child App side. Grade is a record, not a performance multiplier; nothing in this module scales the reward by score.

**FR-5 — Activity Record creation.** Completing an Activity or Chore creates its Activity Record, matching Domain Model §3.6 exactly:
```
{ activityId, date, status: 'complete', exported: false, grade? }
```
- `activityId` — the completed item's stable ID (Activity or Chore; both use the same join-key convention, §2.5/§2.6).
- `date` — the device-local date the completion was recorded. (Not a timestamp with time-of-day precision beyond what device-local "today" requires — no `actualStart`/`actualFinish` exists to need finer granularity, §3.2.)
- `status` — `'complete'` on creation through this module. `waived` is written by a different flow entirely (Module 5's Waive, not this one). `incomplete` and `excused` are not values in this enum — pending-ness is represented by record-absence, not a status value (§3.1a).
- `exported` — always `false` at creation (§3.1a). This module never writes `true`; only Module 8 does, on a successful export.
- `grade` — present only for grade-capture Activity Types when a value was entered; absent (not blank) otherwise.

**FR-6 — Completion CSV sourcing.** The Completion CSV export (Module 8) reads `grade` directly from the Activity Record this module writes — no additional column or new field is introduced by grade capture; it's already part of Domain Model §4.2's locked list.

**FR-7 — No effect on required status by itself.** Marking an item complete resolves its "required and undone" status for the Streak's qualifying-day check (§3.8, a separate module) — this module doesn't compute the streak, it just makes the completion fact available.

## 6. Validation rules

| Rule | Detail |
|---|---|
| Grade range | If entered, must be a whole number 0–100 inclusive; otherwise rejected with a clear message, item remains not-yet-completed until corrected or left blank. |
| Grade applicability | Offered if and only if the item's `capturesGrade` is `true`; never offered when `false` or absent (Chores). Never determined by inspecting `activityType` directly (§2). |
| Completion | Always achievable without a grade, for every type that offers one. |
| Immutability | Once an Activity Record is written, its `grade` and `date` are not altered by this module. |
| Field shape | Every Activity Record this module writes has exactly `activityId`, `date`, `status`, `exported` (always `false` at creation), and (optionally) `grade` — no `actualStart`, `actualFinish`, `durationMin`, or `notes` (§3.2). |

## 7. Permissions

No PIN required. Completion — with or without a grade — is a child-initiated action on the child's own work, distinct from the PIN-gated actions named elsewhere (deferment/waive, reward spend).

## 8. Inputs / Outputs

**Inputs:** the Daily Planner's completion entry point (Module 3, FR-7); the item's Activity Type (for Activities) or the fact that it's a Chore; optional child-entered grade.

**Outputs (written to device storage):**
- A new Activity Record per FR-5 — `{ activityId, date, status, exported: false, grade? }`.
- A Reward Ledger `earn` entry, amount 1, category per the item's `rewardCategoryId` (§3.7, triggered here but owned by that module).
- No change to Received Packet content, Semester, Child, or Theme/Settings data.

**Implementation note (non-contractual):** distinguishing an Activity Record's source (Activity vs. Chore) for internal lookups, if needed, can be done by checking which "as received" table `activityId` matches — Activity and Chore IDs never collide (§2.5/§2.6) — rather than by storing a redundant `type` tag on the record itself. This keeps the stored record identical to the Domain Model's contract; it's a TDS-level implementation choice, not a requirement of this SRS.

## 9. Acceptance criteria

1. Completing a Video, Practice Level, or Reading Pages item — each carrying `capturesGrade: false` — captures only a completion date; no grade prompt ever appears. The same holds for any parent-added custom Activity Type given a `no-capture` pattern (§2), with no change to this module.
2. Completing a Quiz, Test, Project, Report, PDF, Drill, or Workbook item — each carrying `capturesGrade: true` — offers a grade entry, and completes successfully whether or not a grade is entered. The same holds for any parent-added custom Activity Type given a `grade-optional` pattern (§2), with no change to this module.
3. Entering a grade outside 0–100 is rejected with a clear message; the item is not marked complete until the value is fixed or left blank.
4. Completing a Chore never offers a grade entry — Chores carry no `capturesGrade` field at all (§2.6), treated as absent-equals-false, regardless of any Activity Type the parent might have set on unrelated Activities.
5. Two completions of the same `difficultyTier` earn the same Reward Ledger amount (1 each) regardless of whether one has a grade of 100 and the other has no grade at all.
6. Once written, an Activity Record's `grade` value cannot be changed through this module.
7. Every Activity Record produced by this module has exactly the fields `activityId`, `date`, `status`, `exported` (set `false`), and optionally `grade` — never `id`, `completedAt`, `type`, `actualStart`, `actualFinish`, `durationMin`, or `notes`.
8. A parent-added custom Activity Type — not present in §2's ten-row reference table — is completable through this module with correct grade-prompt behavior (present or absent, matching whatever `capturePattern` the parent gave it), requiring no change to this module's own logic.
