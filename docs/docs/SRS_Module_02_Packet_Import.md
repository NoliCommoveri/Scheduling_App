# Software Requirements Specification — Child App
## Module 2: Packet Import

*Written against Domain Model §3.3/§4.1, Architecture Evaluation, Documentation Roadmap.*

---

## 1. Purpose

Brings a Generated Packet (Management App output) onto the child device, populating the Received Packet — the source data for the Daily Planner (Module 3) and Activity & Chore Completion (Module 4). This module owns acquisition, validation, and merge of packet content. It does not generate content (that's the Management App's Pacing/Packet Generation module) and does not decide what's due today (that's the Daily Planner).

**Completion state is out of this module's scope.** This module never marks anything complete or waived; it only receives content and merges it. The completion-state lifecycle and the `activityRecords` store are introduced by Module 4 (Activity & Chore Completion, Milestone M2), which adds them without altering the store shape this module writes. At Milestone M1 every imported item is *pending* by definition — the consequence of that for this module's same-`id` merge branches is spelled out in §2.3.

## 2. Scope notes

**2.1 — Acquisition is a swappable front door.** At M1, there is no Drive-connected Management App to pull from yet (the Build Roadmap's M1 line specifies "packet import (hand-authored packet)"). Acquisition is therefore treated as a swappable front door, separate from validation/merge (which is the real substance of this module and is source-independent). The requirements below specify **"select a packet file"** as the acquisition step; a Drive-backed picker is one implementation of that step, arriving whenever Drive integration lands, with zero change to validation or merge logic. Manual file selection remains available **permanently**, even after Drive integration ships — the standing offline-guarantee fallback required by Architecture Evaluation §1 (neither app depends on a network call to function), not a stopgap that gets removed once Drive exists.

**2.2 — Import is pure-additive, never a replace.** Import never removes or overwrites anything already on the device. Once an Activity, Chore, or Family Event has been received, it stays until it's completed or explicitly waived — never because a later packet simply stopped mentioning it. Domain Model §3.3 states this rule explicitly: additive with refresh-on-pending, never touching days outside its range or completion records already made.

Cleanup of a stale delivered item (parent re-paced and no longer wants it done) is handled entirely by the **existing Deferment/Waive module** (Domain Model §3.6b) — the parent uses the child device's PIN-gated waive action on that specific item. No new status value, no new packet field, and no change to the Completion CSV contract are needed for this — `waived` already exists for exactly this purpose.

**Per-ID idempotency:** if a packet re-sends an item whose stable `id` the device already has, behavior depends on that item's status:
- If the existing item is still **pending**, its display fields, due date, and `difficultyTier` are refreshed from the incoming copy. This lets a parent correct a typo or reschedule an item before it's done, without any new mechanism on the Management side — a later packet simply re-emits the item under its existing `id`.
- If the existing item is already **completed or waived**, the incoming copy is a full no-op — nothing about it is altered. Resolved items' history is never touched by import, full stop.

No new packet field, schema version, or ID scheme is required for this — it's a change to how this module handles a same-`id` match, not to the packet format itself.

Recurring chores arrive as distinct **per-occurrence** items, each with its own ID (TDS §3), so add-vs-refresh-vs-resolved is decided per occurrence with no special chore handling — the same-`id` logic above applies identically whether the `id` belongs to an Activity or a Chore occurrence.

**2.3 — "Pending by definition" at Milestone M1, and what it means for the merge branches.** Completion records are first created by Module 4 (Activity & Chore Completion), which ships in Milestone M2. Until then, nothing on the device can be *completed* or *waived* — every item is pending. That makes FR-4's two same-`id` branches behave asymmetrically at M1: the **refresh-on-pending** branch always fires, and the **resolved-no-op** branch is structurally unreachable, because there is no resolved item for it to protect. Both branches are still written now, exactly as specified, so that when Module 4 lands the resolved-no-op branch goes live with no change to this module's code and no change to the M1 store shape. The mirror-image consequence on the read side — Module 3's completion filters being no-ops at M1 — is stated in that module (SRS Module 3 FR-1). This is the reason the acceptance criteria below still exercise the resolved-item cases: they define the contract Module 4 must satisfy, even though no M1-only test can put an item into a resolved state.

## 3. User stories

- As a parent, I want to hand my child a new packet (via Drive, or a file, in early builds) so their device has the next stretch of school work, chores, and events.
- As a child, I want importing a new packet to not lose anything I haven't finished yet, so falling behind one week doesn't erase work I still owe.
- As a parent, I want a bad or corrupted packet to be rejected outright, not partially applied, so I never end up with a half-updated schedule I have to debug.

## 4. Functional requirements

**FR-1 — Acquisition.** The child (or parent) selects a packet to import. Manual file selection is always available; a Drive-backed picker augments it once Drive integration exists (§2.1), without ever replacing it. Either path produces the same JSON payload for the steps below.

**FR-2 — Schema version check.** The packet declares an integer `schemaVersion` (current value `1`). If the device doesn't support that version, the import is rejected before any parsing of content, with a clear message ("This packet was made by a newer Management App") — no attempt to partially interpret an unsupported schema (Interchange Contract §1, §7).

**FR-3 — All-or-nothing validation.** The entire packet is validated before anything is written:
- Every `days[]` entry has a valid date, **falling inside `[coversFrom, coversTo]` inclusive**, and **no date appears twice** in `days[]`. (A date with nothing due may be omitted entirely; it may not be listed twice.)
- **No `id` appears twice anywhere in the packet** — across all three arrays and all days — with the single sanctioned exception of a multi-day Family Event, which legitimately repeats its `EVT-` id once per in-range day (Interchange Contract §1c). A repeated Activity or Chore occurrence id inside one packet is a malformed packet, not a merge to resolve.
- Every Activity entry has its required fields (stable `id`, `required`, `payload` matching one of the four recognized `kind` values — `pageRange`, `reference`, `none`, `freeText`, each with that kind's own required sub-fields, Interchange Contract §1a — `difficultyTier`, `rewardCategoryId`, `courseName`, `capturesGrade`). Every Chore entry has its required fields (`id`, `choreType`, `title`, `date`, `difficultyTier`, `rewardCategoryId`, `required`). `rewardCategoryId` is validated only for presence and non-empty string shape — this module never resolves it against a lookup table, since no Difficulty Tier entity exists on the Child App side (Domain Model §3.7).
- The packet's date range is well-formed (start ≤ end).

If **any** entry fails validation, the **entire packet is rejected** — nothing is written, and the device's existing Received Packet content is untouched.

**FR-4 — Additive merge, with refresh for pending same-`id` items.** On a valid packet:
- Every Activity, Chore, and Family Event whose stable `id` is **not already present** on the device is added to the Received Packet content on its stated date.
- Every item whose stable `id` **is already present and still pending** has its display fields, due date, `difficultyTier`, and `rewardCategoryId` refreshed from the incoming copy (§2.2).
- Every item whose stable `id` is already present and **completed or waived** is left untouched — a full no-op.
- **Child-side overrides are never overwritten by a refresh** (Interchange Contract §1d). There are exactly two, and both survive every import cycle:
  - the child's **block override** (`blockHint`), and
  - a **deferred due date** set by the PIN-gated Deferment/Waive action (Module 5, Milestone M2).

  The refresh rewrites the item's *received* `date`; it does **not** touch a deferred date. An item the parent already rescheduled on the device therefore keeps that date through any number of re-imports — a re-import can never silently un-defer. (The Daily Planner reads the item's **effective due date**: the deferred date when one exists, the received `date` otherwise — Module 3 FR-1.) This branch is written now, at M1, even though Module 5 does not yet exist to produce a deferred date; it goes live unchanged when M5 lands.
- **Receipt order is recorded at import.** Each newly-added item is stamped with its position in the packet's traversal order (days in array order; within a day, `activities[]` then `chores[]`). This is the Daily Planner's default ordering for any item the child has never reordered (Module 3 FR-1). A refresh of an existing item does **not** restamp it — an item's receipt position is set once, when it first arrives.

Import never removes existing content, and never alters a resolved (completed/waived) item, on any date, whether inside or outside the incoming packet's range.

*Clarifying note (no new requirement):* `lessonTitle` and `instructions` on Activity entries are display fields, already covered by this FR's generic "display fields... refreshed" language and by acceptance criterion #4 below — no separate criterion is needed for them. Chore `notes` refresh is likewise already implied by the Chore's wholesale field refresh under the same rule.

**FR-5 — No automatic removal; cleanup is via Waive.** If a parent drops a planned item from future pacing, an already-delivered pending copy of it is **not** auto-removed by any later import — it remains on the child's Daily Plan until completed or explicitly waived through the existing PIN-gated Deferment/Waive action (§3.6b, a separate module). This module has no removal behavior of its own.

**FR-6 — No effect on Activity Records.** Import never deletes or edits an existing Activity Record (§3.6). A completed item's history stands regardless of what a later packet does or doesn't include.

**FR-7 — Semester label passthrough.** The packet's `semesterLabel`, if present, is display-only and never validated against the device's own stored semester label (no auto-reject on mismatch, per §4.1).

**FR-8 — `childId` / `childName` passthrough; no child-matching gate.** Both are required Packet fields, and this module **neither stores nor validates either one**. The Child App is single-child and holds no `childId` of its own, so it has nothing authoritative to match against; a packet generated for a different child imports without complaint. This is a deliberate, accepted behavior, not an oversight — the parent controls which file reaches which device, and the Completion CSV reconciles on `activityId` alone, never on `childName` (Interchange Contract §1, §3). **Do not add a child-mismatch reject or gate to this module** without a cross-app decision; it would be a contract change.

## 5. Validation rules

| Check | Rule |
|---|---|
| Schema version | Integer, current value `1`; must match a version this build of the app supports; unsupported ⇒ reject whole packet. |
| Date range | `start` ≤ `end`; both valid calendar dates. |
| Activity entries | Non-empty stable `id`; `payload.kind` one of `pageRange`\|`reference`\|`none`\|`freeText` with that kind's required sub-fields present; non-empty `difficultyTier`, `rewardCategoryId`, `courseName`; `capturesGrade` present. **`sequenceNumber` (integer ≥ 1) is required when `payload.kind` is `reference` or `none`** — those kinds are the canonical count-structured types, whose ordinal the child must display (a `none`/Practice Level entry with no `sequenceNumber` would have nothing to show at all). It is optional for `freeText` (a custom type may be count- or page-range-structured, and `kind` alone can't tell), and not used for `pageRange`. This enforces Interchange §1a's "required for count-structured types" at the seam, where `structurePattern` is not visible. This module never inspects `activityType` to decide how to render `payload` — it renders by `kind` alone. |
| Chore entries | Non-empty stable `id`, `choreType` (must be one of: Pet Care, Car Care, Kitchen/Dining, Bathroom, Living/Main Area, Playroom, Bedroom, Parent's Room, Porch, Floors, Miscellaneous), `title`, `date`, `difficultyTier`, `rewardCategoryId`; `required` present and `true`. A Chore entry's `id` must match the occurrence pattern `CHR-{alnum}-{8 digits}` (Interchange Contract §4) — the bare `CHR-{alnum}` record form never appears in a Packet. An incoming chore with a choreType outside this set fails validation. `lessonTitle` and `instructions` are optional display fields on Activity entries — not required to validate; if present, stored as-is, never stripped. |
| Family Event entries | Non-empty stable `id`, matching pattern `EVT-{alnum}` (Interchange Contract §4); valid date within (or overlapping) the packet's range; display fields present. No completion-related fields required (events are never completable). |
| Packet structure | `coversFrom` ≤ `coversTo`; every `days[].date` inside that range, inclusive; no duplicate `days[].date`; no duplicate `id` across the whole packet, except a multi-day Family Event's intentional per-day repeat of the same `EVT-` id. |
| `childId` / `childName` | Present per the schema, then ignored. Never stored, never matched, never a reason to reject. |
| Whole-packet | Any single failure anywhere ⇒ reject the entire packet; no partial commit. |

## 6. Permissions

**No PIN gate.** The Domain Model's PIN-gated actions are deferment/waive (§3.6b), reward spend (§3.7), and Settings entry (§3.9/§3.2) — Packet Import isn't among them. Import is treated as ungated — reasonable given it's a receive-only action bringing in parent-authored content, and the all-or-nothing validation already protects against garbage input. (A parent PIN before an import can be applied — e.g., to stop a child from re-importing an old packet to dodge new work — would be a deliberate addition, FR-8, not assumed here.)

## 7. Inputs / Outputs

**Inputs:** one packet JSON file, acquired via manual selection (always available) or Drive picker (once available).

**Outputs (written to device storage):**
- New Activities, Chores, and Family Events (by stable `id`, not already present) added to Received Packet content, per FR-4.
- Display fields, due date, `difficultyTier`, and `rewardCategoryId` refreshed on existing **pending** items whose `id` matches an incoming item, per FR-4.
- No change whatsoever to **resolved** (completed/waived) items, and no removal of any existing content, by this module.
- No change to Activity Records, Reward Ledger, Streak, Child, or Semester/Theme data — this module touches Received Packet content only.
- No change to any child-side override — block label, sort position, or deferred due date — on any item, new or refreshed.

## 8. Acceptance criteria

1. Selecting a well-formed packet whose schema version is supported results in its content being visible on the Daily Planner for the covered date range, and no error is shown.
2. Selecting a packet with an unsupported schema version, or with any single invalid entry anywhere in it, results in **no change whatsoever** to existing Received Packet content, and a clear rejection message.
3. Re-importing a packet that omits an item already on the device (by stable `id`) leaves that item exactly as it was — still present, still pending or completed as it already stood.
4. Re-importing a packet containing an item whose stable `id` already exists on the device and is **still pending** updates that item's display fields, due date, `difficultyTier`, and `rewardCategoryId` to match the incoming copy — completion status is untouched (it was already pending, still pending).
5. Re-importing a packet containing an item whose stable `id` already exists on the device and is **completed or waived** does not alter the existing copy in any way — full no-op, regardless of what the incoming copy says.
6. Dates outside the imported packet's range are unaffected by the import, and so are dates inside it that only contain items the device already has.
7. The device's stored `semesterLabel` is never altered or validated by an import.
8. A packet whose `days[]` contains a date outside `[coversFrom, coversTo]`, the same date twice, or the same Activity/Chore `id` twice is rejected whole. A packet whose multi-day Family Event repeats the same `EVT-` id across several days imports cleanly — that repeat is not a duplicate.
9. Re-importing a packet containing a still-pending item the child has moved to a different block leaves that block override in place; re-importing one containing a still-pending item that has been **deferred** leaves the deferred date in place, even though the incoming copy carries the original `date`.
10. A packet whose `childId`/`childName` do not match the device's child imports normally, with no warning and no rejection.
11. `packet_sample.json` imports cleanly end to end, and every one of its Activity and Chore entries lands with the `blockHint` it carried.
