# Software Requirements Specification — Management App
## Module 4: Child Management
*Written against Domain Model §2.1 (Child — including the two-tier deletion guard), §2.4 (Course — template/instance split; instances carry no pacing cursor), §1 (the central modeling decision — stamping regenerates Activity IDs, no propagation), §2.5 (Activity ID scheme, `instanceToken`, `excludeFromGeneration`), §2.9 (Pacing Profile — its dependency on this module's stamping action, §2.5/§2.6 below), §2.10 (Generated Packet — Propose/Review/Commit), §5.1 (no-propagation tradeoff), Architecture Evaluation §4/§5/§8, Documentation Roadmap §3/§8 item 1.*

---

## 1. Purpose

Lets the parent add and maintain Child records, and assign (stamp) Course Templates to a specific child, producing an independent Child Course Instance. This module owns the *Child entity itself* and the *stamping action* — it does not own Course/Lesson/Activity authoring (Course Template Library, Module 3), pacing (Pacing Configuration), or anything Chore/Family-Event-related (their own authoring modules).

## 2. Scope notes

**2.1 — Archivable-as-template remains open; this module does not attempt it.** "Can a diverged Child Course Instance be promoted back into the library?" is a real, acknowledged open question (Domain Model §6 item 1 / Roadmap §8 item 1). No promote-instance-to-template capability exists anywhere in this module. It stays tracked as open in the Domain Model/Roadmap until a future module or the TDS takes it up.

**2.2 — Child deletion is a two-tier guard.**
- **Tier 1 — hard block while any Course Instance exists.** A Child cannot be deleted while stamped Course Instances still belong to them, full stop. The parent must remove each instance first (§2.3, FR-6) — no override, no forced cascade past this point.
- **Tier 2 — warn-and-confirm-export, then prune-or-cascade.** Once zero Course Instances remain, deleting the Child surfaces an explicit warning that this permanently removes the Child's remaining Management-side data (Family Events, Pacing history, and any Chore the Child solely participates in), and asks the parent to confirm they've already exported/backed up anything they want to keep (Master Reports, once that module exists; today, this is simply an honesty checkpoint, not a system-verified check — the Management App cannot verify an export actually happened). Only after that explicit confirmation does deletion proceed. *Amended, `TDS_Slice_Shared_Chores.md` §4.4:* a Chore is no longer necessarily deleted outright — a Chore this Child shares with a sibling is pruned (the Child removed from `childIds`) and survives for the remaining participant(s); only a Chore left with zero participants is deleted. Family Events and Pacing history are unaffected by this amendment and still cascade-delete as before.

**2.3 — This module owns deleting/un-assigning a Course *Instance*, distinct from Module 3's Course *Template* deletion.** Module 3's FR-2 covers deleting a Course **Template** from the library — explicitly unguarded, since instances are independent copies. That's a different action from removing a specific Child's **Instance**, which is inherently child-scoped and therefore belongs here, alongside the assignment action that creates it in the first place (FR-4/FR-6 below). Deleting a Template (Module 3) never touches any instance; deleting an Instance (this module) never touches the Template it was stamped from.

**2.4 — Deleting a Course Instance cannot recall anything already delivered to the child device.** Per the one-way interchange (Architecture Evaluation §5/§6, guardrail 6), a Packet already exported to a child's device is gone — there is no bidirectional sync to un-send it. Deleting the Instance here stops **future** packet generation from it; any already-delivered content, and any Activity Records the child has already produced against it, are unaffected on the child's device and simply become unmatched-by-source on the Management side (consistent with the accepted handling of a since-deleted template's `sourceTemplateId`, Module 3 §2.4, and of unmatched Completion CSV rows generally, Domain Model §4.3).

**2.5 — Stamping (FR-4) has a required next step this module doesn't itself perform.** Domain Model §2.9 states a Pacing Profile is "set at instance creation," meaning a freshly-stamped Instance isn't actually usable by generation until pacing is configured too. This module doesn't own that step — Module 5 does — but FR-4 below is explicit that pacing setup is the expected immediate next action, so a parent (or an AI session building the UI later) doesn't treat stamping alone as "done."

**2.6 — Deleting a Course Instance (FR-6) cascades its Pacing Profile.** A Pacing Profile has no independent existence apart from its Instance (Module 5 has no "delete Pacing Profile" action of its own). FR-6 and §7's Outputs below state this explicitly.

**2.7 — This module is one of two entry points for `excludeFromGeneration`.** `excludeFromGeneration` (Domain Model §2.5) is a standing per-Activity toggle, settable here directly against any Instance Activity, independent of Packet Generation's Propose/Review/Commit cycle (M7) — a parent flagging something as "never generate this" doesn't need to open Packet Generation to do it. The other entry point is Packet Generation's Review stage (Mgmt SRS 08) — same field, no second mechanism, just a second door to the same room.

**2.8 — This module owns editing a stamped Instance's *content*, not just its existence.** Domain Model §2.5 has always permitted an Activity ID to be minted "during a later instance edit," but no module owned that path — the capability was asserted in the model and specified nowhere. It lands here, alongside stamping and instance deletion, because instance rules genuinely differ from template rules (already-shipped content, already-completed work, a standing generation history in the log), and folding them into Module 03 would mean one module holding two rule sets for the same three stores. **Consequence, named deliberately:** `children.js` and `courses.js` both write the `courses`/`lessons`/`activities` stores, partitioned by `state`. This is the first place in either app where two modules share stores.

**2.9 — An Instance's Course-level fields are editable, on the same rules as its Lessons (FR-13).** Divergence is the point of an Instance; there is no principled reason a parent may rename an Instance's *Lesson* but not the Instance's *Course*. So the rule is aligned rather than special-cased: **freely editable, except what is frozen by an existing rule.**

- **`name` and every optional field** (`subject`, `description`, `coreElective`, `defaultPacingHint`) — freely editable, exactly as a Lesson's `title` is under FR-9.
- **`courseCode`** — frozen. Not by a rule invented for instances, but by the same rule that freezes it on a template (Mgmt SRS 03 FR-2): it freezes once any Activity exists beneath the Course. A stamped Instance has Activities beneath it from its first instant, so its code is frozen on arrival, permanently. Nothing new to implement — the existing guard already produces this.
- **`mainCategory`, `sourceTemplateId`, `childId`, `instanceToken`** — never editable by any path. `instanceToken` in particular is baked into every Activity ID beneath it; editing it would orphan the lot.
- **The source template is never touched.** Identical guarantee to FR-9/FR-10.

## 3. User stories

- As a parent, I want to add a new child to the system once, so I can start assigning coursework to them.
- As a parent, I want to stamp a Course template to a specific child and get an independent copy I can pace and adjust just for them.
- As a parent, I want to be stopped from accidentally deleting a child who still has active coursework assigned.
- As a parent, I want a clear warning — not a silent wipe — before permanently removing a child's remaining data.

## 4. Functional requirements

**FR-1 — Create Child.** The parent creates a Child with `name` (required). Optional fields: `gradeLabel` (parent record-keeping only — distinct from, and unaffected by, the Child App's own cut `gradeLabel`, Domain Model §0/§3.1/§3.2), `notes`, `themeHint` (advisory only — never binding on the Child App's fully ungated theme selection, Domain Model §3.9 / SRS Module 10).

**FR-2 — Edit Child.** Any field on an existing Child can be edited freely at any time.

**FR-3 — List / browse Children.** The parent can view all Children, each showing at minimum `name`, for selection when assigning Courses or authoring Chores/Family Events elsewhere.

**FR-4 — Assign (stamp) a Course to a Child.** The parent selects an existing Course Template and a Child. This creates a new **Child Course Instance**: a full independent copy of the template's Lessons and Activities, tagged with `childId` and `sourceTemplateId`, with every Activity ID regenerated. No propagation link to the template exists after this moment beyond `sourceTemplateId`'s provenance value. The copy proceeds as:

1. **Mint one `instanceToken`** — short random base36, minted once for the whole stamp. Uniqueness-checked against every `instanceToken` already in use and re-rolled on collision; re-rolled also if it equals `tpl`, `chr`, or `evt` case-insensitively (Interchange Contract §4).
2. **Copy the Course** with a new `id` (`COU-{token}`), `state: "instance"`, `sourceTemplateId`, `childId`, and **`instanceToken` stored on the record** (Domain Model §2.4). Storing it is not an optimization — it is the only thing that lets FR-10 mint an ID for a later-added Activity **without parsing an existing Activity ID**, which nothing in this system is permitted to do. The fresh Instance has no generation history: nothing sent yet.
3. **Copy each Lesson** with a new `id` (`LSN-{token}`), same `lessonCode`/`order`/`title`, `courseId` pointing at the new Instance. **`nextActivitySeq` is copied forward from the template Lesson's current value — not reset to `1`.**
4. **Copy each Activity**, minting `id` = `{courseCode}-{instanceToken}-{lessonCode}-{seq}` and **reusing the exact `seq` the template Activity already carried**. Every other field is copied verbatim, including `order`, `capturesGrade`, `sequenceNumber`, and `lessonTitle`. `excludeFromGeneration` is absent on the copy, same as on the template. **Only segment 2 of the ID changes** — which makes "did every ID get regenerated?" a question answerable by eye, and makes a template↔instance diff trivial. Disjointness is guaranteed by the `instanceToken` alone; it does not need the `seq` to differ.
5. Write the Course, its Lessons, and its Activities **in one transaction**.

**A newly-stamped Instance has no Pacing Profile yet (§2.5) — this module surfaces Pacing Configuration (Module 5) as the required immediate next step, without itself owning that setup.**

**FR-5 — List a Child's Course Instances.** The parent can view every Course Instance currently stamped to a given Child, including which template each came from (`sourceTemplateId` — displayed as "template no longer available" if that template has since been deleted, matching Module 3 §2.4).

**FR-6 — Un-assign / delete a Course Instance.** The parent can permanently remove a single Course Instance from a Child. Requires an explicit confirmation step (destructive — stops all future pacing/generation from this instance). Per §2.4, this has no effect on content already delivered to the child's device or on any Activity Records the child has already produced against it. **This also removes the Instance's Pacing Profile (§2.6) — a Profile has no existence independent of its Instance, and Module 5 offers no separate deletion path for it.**

**FR-7 — Delete Child, Tier 1 (hard block).** Attempting to delete a Child who has one or more Course Instances currently assigned (FR-5) is rejected outright, listing the blocking instances. The parent must remove each one (FR-6) before Child deletion becomes possible. No override path exists.

**FR-8 — Delete Child, Tier 2 (warn, confirm, prune-then-cascade).** Once a Child has zero Course Instances, attempting to delete them surfaces a warning describing what will be permanently removed (the Child record itself, all remaining Family Events and Pacing history, and any Chore the Child solely participates in) and asks the parent to explicitly confirm they've already exported or backed up anything they want to keep. Only on that explicit confirmation does the system delete the Child and cascade: every Chore is pruned of this Child's participation, and only those left with zero participants are deleted; Family Events and Pacing history scoped to the Child are removed as before. *Amended, `TDS_Slice_Shared_Chores.md` §4.4* — a shared Chore is never deleted out from under the sibling still doing it.

**FR-9 — Create / Edit / Delete a Lesson on an Instance.** The parent can add, edit, or remove a Lesson within a stamped Instance. A new Lesson mints `LSN-{token}` and its own `nextActivitySeq` starting at `1`. `lessonCode` is subject to the same uniqueness-within-Course and freeze-once-Activities-exist rules as the template path (Mgmt SRS 03 §9). Deleting a Lesson cascades to its Activities. **The source template is never touched.**

**FR-10 — Create / Edit / Delete an Activity on an Instance.** A **new** Activity mints an ID from **that Instance's existing `instanceToken`** and its Lesson's `nextActivitySeq` — never reusing a number a deleted Activity once held (Domain Model §2.5). **Editing an existing Activity's fields never re-mints its ID.** `capturesGrade` is copied from the Activity Type at creation, exactly as in the template path (Mgmt SRS 03 FR-10).

**FR-11 — Reorder Activities within an Instance's Lesson.** Same mechanism as Mgmt SRS 03 FR-9; changes `order` only.

**FR-12 — Divergence warnings (warn, never block).** Two things this module permits cannot be undone by the app, and the parent is told so plainly at the point of action:
- **Editing or deleting an Activity the child has already received** changes nothing on their device. The interchange is one-way; a packet already exported cannot be recalled (§2.4). The edit affects only what is generated *next*.
- **Deleting an Activity the child has already completed** means their Completion CSV row will arrive with an `activityId` matching nothing, and will land as an unmatched row at import (Domain Model §4.3, Module 09). The work is not lost on their side; it is simply unattributable on this one.

Neither is blocked. Both are warned. The app cannot verify either condition without importing completion data, which it must not do to answer a UI question (Architecture Evaluation §5).

**FR-13 — Edit an Instance's Course-level fields.** The parent edits a stamped Instance's `name` and optional fields directly, on the rules in §2.9 — freely, except `courseCode` (frozen by the existing Activity-exists guard) and the four never-editable identity fields. The source template is never touched.

**One divergence consequence, and it is the `lessonTitle` story one level up:** a packet entry carries a required `courseName`, resolved by Packet Generation **at export time** (Domain Model §3.5). So renaming an Instance's Course changes what the child sees on **every packet generated afterward**, while items already on their device keep the name they shipped with. The child ends up seeing both names — old work under the old name, new work under the new one. This is not a defect and is not blocked; it is the same one-way-interchange consequence as FR-12's, and it is warned in the same way, once, at the point of rename.

**FR-14 — Set/clear `excludeFromGeneration` on an Instance Activity.** The parent may flag or unflag any Instance Activity as excluded from generation, at any time, independent of Packet Generation's Propose/Review/Commit cycle (Domain Model §2.5, §2.10). Setting the flag removes the Activity from the **pending remainder**: every future Propose skips it (Mgmt SRS 08 FR-2). Clearing it before the Activity has been sent restores ordinary pacing; clearing it after it was already sent does nothing, since a sent Activity is never re-proposed. There is no cursor to move in either direction. Never available on a template Activity.

## 5. Validation rules

| Rule | Detail |
|---|---|
| Child name | Non-empty, whitespace-trimmed. |
| Course assignment | Must reference an existing Course Template (`state: template`) and an existing Child; produces one new Instance per assignment, never edits an existing one. |
| Instance deletion | Requires explicit confirmation; irreversible; does not touch the source template or any child-device data. |
| Child deletion — Tier 1 | Rejected outright if any Course Instance references this `childId`; no partial or forced delete. |
| Child deletion — Tier 2 | Only reachable once zero Course Instances remain; requires explicit export/backup confirmation before cascading. |
| Archive-as-template | No such capability exists in this module (§2.1) — not a validation gap, a deliberate absence. |
| Instance Activity mint | New Activity IDs on an Instance use that Instance's existing `instanceToken` and the Lesson's persisted `nextActivitySeq`. Never a fresh token; never `max(existing) + 1`. |
| Instance edit ≠ re-mint | No edit path re-mints an existing Activity's `id`, in a template or an instance. |
| Template isolation | No instance-editing path writes to any row with `state: template`. |
| `excludeFromGeneration` | Bool, default `false`; settable only on Instance Activities (`state: instance`); no UI path exposes it on a template Activity. |

## 6. Permissions

No *additional* per-action PIN. The Management App requires its own `launchPin` once per session (Domain Model §2.11) — the parent authenticates once at app launch, not per module. This module doesn't add a further gate on top of that.

## 7. Inputs / Outputs

**Inputs:** parent-entered form data (Child create/edit fields; Lesson/Activity create/edit/delete/reorder within a stamped Instance, FR-9–FR-11, FR-13–FR-14); a selected Course Template + Child pairing for assignment (FR-4); reads the Course Template Library (Module 3) to validate the template exists, and Module 12's Activity Type table for `capturePattern` copy-through (FR-10) — does not write to either.

**Outputs (written to Management App storage):**
- New, updated, or deleted Child records.
- New Child Course Instances (full copies, regenerated Activity IDs) on assignment (FR-4).
- Deleted Course Instances, along with their Pacing Profile (FR-6, §2.6).
- New, updated, or deleted Lesson and Activity rows with `state: instance` (FR-9–FR-11, FR-13–FR-14) — read this as extending "Child Course Instances" below to include the Instance's own Lessons and Activities, not just its Course row.
- On a Tier 2 Child deletion (FR-8): cascade-deletion of the Child record, all remaining Family Events and Pacing history scoped to that `childId`, and any Chore left with zero participants after this Child is pruned from `childIds`; a Chore still shared with a sibling survives, pruned.
- No change to any Course *Template*, Curriculum, or Difficulty Tier/Category data — this module touches Child records and Child Course Instances only, now including their Lessons and Activities (rows with `state: instance` in the `lessons`/`activities` stores).

## 8. Acceptance criteria

1. Creating a Child with only a `name` succeeds; all optional fields are absent without error.
2. Assigning a Course Template to a Child produces a new Instance whose Activity IDs are all distinct from the template's and from any other Instance ever stamped from that template.
3. Editing a Course Template after it has been stamped to a Child has no effect on that Child's already-created Instance.
4. Deleting a Course Instance requires an explicit confirmation step and does not alter or delete the source template; its Pacing Profile is removed along with it, leaving no orphaned Profile behind.
5. Attempting to delete a Child who has at least one Course Instance is rejected outright, and the blocking instance(s) are named in the message.
6. Deleting a Child with zero Course Instances surfaces a warning and requires an explicit export/backup confirmation before anything is removed.
7. Confirming a Tier 2 deletion removes the Child record and all remaining Family Events/Pacing data scoped to that child, prunes the Child from every Chore's `childIds`, and deletes only the Chores left with no participants; a Chore shared with a sibling survives with the sibling as its sole remaining participant. Nothing is removed before that confirmation is given.
8. No UI path anywhere in this module offers to promote a Course Instance back into the Course Template library (§2.1).
9. Adding an Activity to a stamped Instance produces an ID carrying that Instance's original `instanceToken` — not a new one — and a `seq` no Activity in that Lesson has ever held, including deleted ones.
10. Editing the `title` of an Activity inside an Instance leaves its `id` byte-identical.
11. No instance-editing action alters the source template in any way.
12. Deleting an Activity from an Instance surfaces the FR-12 warning and proceeds on confirmation.
13. Renaming a stamped Instance's Course `name` succeeds, warns per FR-13, and leaves the source template's `name` byte-identical.
14. A stamped Instance's `courseCode` cannot be edited by any UI path, from the first instant it exists — no separate instance-only guard is implemented to achieve this; the template freeze rule already produces it.
15. No UI path anywhere edits an Instance's `sourceTemplateId`, `childId`, or `instanceToken`.
16. Flagging an Instance Activity `excludeFromGeneration` succeeds independent of whether a Propose/Review cycle is currently open, and the same field is readable/settable from inside Packet Generation's Review stage (Mgmt SRS 08) — one field, two entry points, never a divergent second mechanism.
17. No UI path anywhere offers `excludeFromGeneration` on a template Activity.
