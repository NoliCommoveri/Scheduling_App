# Software Requirements Specification — Management App
## Module 1: Curriculum Library
*Written against Domain Model §2.2 (Curriculum), Architecture Evaluation, Documentation Roadmap.*

---

## 1. Purpose

Lets the parent author and maintain the Curriculum library — the publisher/source-level layer above Course (e.g., "MiAcademy," "Saxon Math," "Mom's Homemade History Unit"). This module owns Curriculum records only: create, edit, delete, and the reference integrity that protects Courses depending on them. It does not author Courses, Lessons, or Activities (Course Template Library, a separate module) and does not touch any child-scoped or instanced data.

## 2. Scope notes

**2.1 — Delete is blocked while referenced.** The Domain Model doesn't specify delete behavior. A Curriculum is referenced by Course via `curriculumId` (§2.4), and Courses are never left pointing at nothing. This module blocks deletion of any Curriculum with one or more referencing Courses (template or instance), and surfaces which Courses are blocking it so the parent knows what to reassign or retire first.

**2.2 — Curriculum name is unique.** Not specified in the Domain Model. Since a Curriculum is selected by name when authoring a Course, duplicate names would be a source of real mistakes (assigning a Course to the wrong "Saxon Math"). Uniqueness is enforced case-insensitively at creation and edit time.

**2.3 — `suggestedActivityTypes` covers the full canonical 10-type list.** The enum offers all ten Activity Types, including Drill, matching Domain Model §2.5a's canonical seed data.

## 3. User stories

- As a parent, I want to set up a Curriculum once (its name, type, and suggested activity types) so every Course I author under it starts from sensible defaults.
- As a parent, I want to edit a Curriculum's details freely, so correcting or expanding it later never requires touching every Course built on it.
- As a parent, I want to be stopped from deleting a Curriculum that's still in use, so I don't accidentally orphan Courses I've already built.

## 4. Functional requirements

**FR-1 — Create Curriculum.** The parent creates a Curriculum with a `name` (required, unique) and optionally `publisherNote`, `defaultCurriculumType` (Website | App | Offline), and `suggestedActivityTypes[]` (multi-select from the full Activity Type enum — Video, PDF, Practice Level, Quiz, Test, Report, Reading Pages, Workbook, Project, Drill).

**FR-2 — Edit Curriculum.** Any field on an existing Curriculum can be edited at any time. Because Curriculum is never stamped or duplicated (§1 of the Domain Model), there are no instances to desync — an edit is immediately and uniformly visible everywhere the Curriculum is referenced, including the live `suggestedActivityTypes` pass-through to Course authoring (Domain Model §1, the one sanctioned propagation exception in the system).

**Editing is never reference-guarded, and FR-4's delete guard is not evidence to the contrary.** A Curriculum with live Courses under it is exactly the Curriculum most worth correcting: a publisher's real mix of Activity Types is learned by using it for a term, not by guessing at setup. FR-4 blocks *delete* because a deleted record would leave a Course pointing at nothing; an edit leaves it pointing at a better record. Stated here because the library list originally shipped with Delete as its only per-row action, so the only way to change a Curriculum's `suggestedActivityTypes` was to delete and re-create it — which FR-4 then blocked, making the one field FR-3 calls "soft" the one field in the module that could not be changed.

**FR-3 — Suggested Activity Types are always soft.** `suggestedActivityTypes` pre-fills/suggests during Activity authoring under any Course referencing this Curriculum, but never constrains — any Activity Type remains manually selectable regardless of what's suggested here. This module does not enforce the list as a whitelist anywhere.

**FR-4 — Delete Curriculum, reference-guarded.** A Curriculum can be deleted only if no Course (template or instance) currently references it via `curriculumId`. Attempting to delete a referenced Curriculum is rejected with a list of the blocking Courses; no partial or forced delete path exists.

**FR-5 — List / browse.** The parent can view all Curricula in the library, showing at minimum `name`, `defaultCurriculumType`, and the current `suggestedActivityTypes[]` — the last so the list answers "what will a new Lesson under this publisher open with?" without opening the record. Every row carries **Edit** (FR-2, opening the row as an inline form pre-filled with the record's current values) and **Delete** (FR-4, reference-guarded).

## 5. Validation rules

| Rule | Detail |
|---|---|
| Name required | Non-empty, whitespace-trimmed. |
| Name unique | Case-insensitive uniqueness check on create and on edit (excluding the record being edited). |
| Curriculum Type | If provided, must be one of Website \| App \| Offline. |
| Suggested Activity Types | If provided, each entry must be one of the ten canonical Activity Type enum values (§4), including Drill. Never validated against any other Curriculum's list — each Curriculum's suggestions are independent. |
| Delete guard | Rejected if `curriculumId` is referenced by any Course, template or instance. |

## 6. Permissions

No *additional* per-action PIN. The Management App requires its own `launchPin` once per session (Domain Model §2.11) — the parent authenticates once at app launch, not per module. This module doesn't add a further gate on top of that; none of the Child App's per-action PIN-gating rules (deferment/waive, reward spend) are relevant here regardless.

## 7. Inputs / Outputs

**Inputs:** parent-entered form data (name, publisher note, curriculum type, suggested activity types); on delete, a reference check against the Course table.

**Outputs (written to Management App storage):**
- New, updated, or deleted Curriculum records.
- No change to any Course, Lesson, Activity, Child, or child-scoped data — this module touches the Curriculum table only.

## 8. Acceptance criteria

1. Creating a Curriculum with only a `name` succeeds; all optional fields are absent without error.
2. Attempting to create or rename a Curriculum to a name that already exists (case-insensitive) is rejected with a clear message.
3. Editing a Curriculum's `suggestedActivityTypes` is immediately reflected the next time Activity authoring is opened under any Course referencing that Curriculum — no propagation delay, no per-Course update needed.
4. Attempting to delete a Curriculum referenced by at least one Course is rejected, and the blocking Course(s) are named in the message.
5. Deleting a Curriculum referenced by zero Courses succeeds and removes it from the library list.
6. Selecting an Activity Type not present in a Curriculum's `suggestedActivityTypes` during Activity authoring is never blocked — suggestions never become a whitelist.
7. Drill is offered as a `suggestedActivityTypes` option, alongside the other nine canonical types.
8. Editing a Curriculum referenced by one or more Courses **succeeds** — including changing `suggestedActivityTypes` alone — and the same record still blocks deletion afterwards. Editing and deleting are guarded differently on purpose (FR-2/FR-4).
9. A `suggestedActivityTypes` entry naming an Activity Type that has since been deleted from Module 12's table keeps its (checked) box on the edit form and survives an edit of any other field — Module 12 §2.6's inert-historical-reference treatment, never a silent cleanup.
10. Cancelling an edit leaves the record byte-identical; a rename colliding with another Curriculum's name (case-insensitively) is rejected on edit exactly as on create, and the record is unchanged.
