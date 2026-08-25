# Software Requirements Specification — Management App
## Module 11: Settings & Backup

*Written against Domain Model §2.11 (App Settings — `launchPin`, single device-local record); Architecture Evaluation §9 ("Backup... Full JSON backup/restore, scoped structurally as everything in Management App storage except the App Settings record.") and principles 15/16 (simplicity first; no hidden workflow engines); Child App SRS Module 11 — Settings (sibling PIN-change pattern, mirrored here); Management SRS Module 03 §2.4 and Module 04 §2 (existing destructive-action confirmation precedents); Management SRS Module 10 §2.9 (the Generation Log, Domain Model §2.10a — this module's structural backup scope covers it automatically); Roadmap §3 ("Settings & Backup — curriculum JSON backup; library management; owns the Management App's `launchPin` set/change flow").*

---

## 1. Purpose

Owns two device-level, app-wide concerns that don't belong to any Course/Child/Curriculum-specific module: the Management App's own `launchPin` lifecycle (Domain Model §2.11) — both its one-time initial creation and every later change — and full JSON backup/restore of the Management App's authoritative data, for disaster recovery and device migration. This is the last unwritten Management SRS module. It deliberately does not duplicate any per-entity CRUD already owned elsewhere — it only exports/imports the whole dataset at once and manages the one credential that gates the app itself.

## 2. Scope notes

**2.0 — This module is split across two milestones, and the earlier half is a hard prerequisite for the entire app.**

- **FR-1 and FR-2 (`launchPin` setup and change) belong to milestone M4** — the Management app's very first milestone. `app.js` is defined as "router, **launchPin gate**" (Architecture Evaluation §7): without this flow there is no way to open the app at all. Build these two first, before Curriculum or Tiers.
- **FR-3 through FR-8 (full backup export, restore, validation, pre-restore snapshot) belong to milestone M8**, alongside the other ergonomics-and-safety work. Backup/restore protects data that does not exist until M5–M7 have authored some.

(Under the Roadmap's *original* milestone cut this module was assigned to no milestone whatsoever — an outright gap, since M4 could not have been built without FR-1/FR-2. Roadmap §5's re-cut fixes it. Noted here because a build session reading only this file would not otherwise know it is being asked for in two pieces, at two different times.)

**2.1 — No separate Management App "Startup Wizard" module exists, so this module owns `launchPin`'s entire lifecycle, not just changes.** Domain Model §2.11 describes initial `launchPin` creation as "analogous to the Child App's Startup Wizard, Module 1" — but the Roadmap's eleven-module Management SRS list has no wizard-equivalent module. The Management App has no child-facing onboarding concerns (no theme choice, no semester setup); its only first-run requirement is setting a launch credential. This module is the only reasonable home for that one-time flow, so it owns both "no PIN exists yet" (first launch) and "a PIN already exists" (change) as two branches of one lifecycle, rather than splitting them across a phantom wizard module and this one.

**2.2 — Backup scope is defined structurally, not as a hardcoded entity list, so it can't silently rot as the domain grows.** Rather than enumerate every Management-side entity by name — a list that would need updating every time a future module adds a new entity type — backup/restore is scoped as **everything in Management App storage except the App Settings record itself (§2.3)**. This automatically covers the Generation Log (Domain Model §2.10a, written by Packet Generation for Master Reporting's Roster report) without this module's SRS needing to name it specifically, the same as any future entity type added to the schema later.

**2.3 — App Settings/`launchPin` is deliberately excluded from backup content.** Domain Model §2.11 frames App Settings as "one record per Management App installation" — a device-local credential, not portable authored content. Restoring a backup onto a different device (or the same device after reinstalling) should never silently overwrite whatever `launchPin` that device's parent has already set, or force a credential migration alongside a content restore. The two lifecycles — data and device credential — stay independent, matching the existing "two independent PINs, each local to its own device" pattern already established between the two apps (Domain Model §2.11's own closing rule).

**2.4 — Restore is a full replace, never a merge, and that's a deliberate simplicity call, not an oversight.** Reconciling a backup's contents against whatever already exists on the current device — matching Curricula by name, deduplicating Children, resolving conflicting edits to the same Course — is exactly the kind of hidden workflow engine the Architecture Evaluation warns against (principles 15/16). Restore instead wholesale-replaces every in-scope entity (§2.2) with the backup's contents. This is safe specifically *because* of FR-5's automatic pre-restore snapshot — a mistaken restore is itself one more restore away from undone, so the destructiveness of "replace" is bounded, not catastrophic.

**2.5 — Restore's safeguard is an explicit confirmation, not a second PIN prompt — consistent with the rule already locked everywhere else in the Management SRS.** Domain Model §2.11 states individual modules "do not additionally gate their own actions" beyond the one-time app-launch PIN. Restore is unusually destructive, but the answer already established elsewhere for a destructive-but-legitimate action is an explicit, informative confirmation step, not a second credential check — the same treatment Child Management gives its Tier-2 delete ("requires the parent to confirm they've already exported/backed up anything they want to keep," Domain Model §2.1/Module 04 §2). This module follows that precedent rather than inventing a new, inconsistent PIN-reentry pattern just for itself.

**2.6 — "Library management," named in the Roadmap alongside backup, is not a new bulk-editing surface — it's this module's framing of *what* the backup covers, not an additional feature.** Architecture Evaluation §9 names the target directly: "the Curriculum/Course library, instances, and pacing." Every entity in that library already has its own authoring module (Curriculum Library, Course Template Library, Child Management, Pacing Configuration, etc.). Inventing a second, parallel bulk-CRUD console here would duplicate those modules' ownership for no benefit — this module's only touch on "the library" is exporting and restoring it wholesale.

## 3. User stories

- As a parent, I want to set up a launch PIN the first time I open the Management App, and change it later if I want to.
- As a parent, I want a backup file I can save somewhere safe, so a lost or broken device doesn't cost me a semester's worth of authored courses and history.
- As a parent, I want to move my whole library to a new computer without re-authoring everything by hand.
- As a parent, I want restoring a backup to be safe to attempt — if I pick the wrong file, or realize afterward I didn't want to, I want a way back.

## 4. Functional requirements

**FR-1 — Initial `launchPin` setup (first launch, §2.1).** On first launch, before any `launchPin` exists, the app presents a one-time setup screen requiring a new PIN entered twice for confirmation (minimum 4 digits, numeric — same minimum as the Child App's PIN, Child App Module 11 FR-3). The app is unusable until this completes; there is no "skip" path, since Domain Model §2.11 requires `launchPin` as a required field with no default.

**FR-2 — Change `launchPin` (already inside the gated app).** Requires the current PIN entered correctly, then a new PIN entered twice for confirmation, same minimum as FR-1. An incorrect current PIN blocks the change entirely, with no partial effect. On success, the new PIN immediately becomes the only credential that unlocks the app going forward — the old PIN stops working the moment the change succeeds.

**FR-3 — Full backup export.** Produces one JSON file containing a `schemaVersion` field plus every entity in scope (§2.2) — Curricula, Courses (Templates and Instances, with nested Lessons and Activities), the Activity Type table, Difficulty Tier & Reward Category, Children, Chores, Family Events, Pacing Profiles, and Imported Completion Records (once Module 09 has any) — generated on demand, at any time, with no PIN gate beyond the one already covering the whole app.

**FR-4 — Backup validation on restore, all-or-nothing.** A selected backup file is checked for a compatible `schemaVersion` and structural/referential soundness (e.g., every Course's `curriculumId` resolves within the file itself) before anything is written. A file that fails either check is rejected whole, with a clear message — no partial restore, matching the all-or-nothing precedent already used for Packet Import (Child App Module 02) and Course Template's bulk CSV import (Management Module 03).

**FR-5 — Automatic pre-restore safety snapshot (§2.4).** Immediately before a validated restore is applied, the app automatically generates a backup of the current on-device data (FR-3's own format) and offers it for download, so the about-to-be-overwritten state is never lost without the parent's own choice to discard it.

**FR-6 — Restore confirmation, explicit and informative, not a second PIN (§2.5).** After FR-4/FR-5, the parent must explicitly confirm a clearly-worded warning that restoring will replace every in-scope entity (§2.2) with the backup's contents, and that this cannot be undone except via FR-5's just-created snapshot. Restore proceeds only after this confirmation.

**FR-7 — Restore is a full, wholesale replace (§2.4).** Every currently-existing in-scope entity is discarded and replaced by the backup's contents in one operation; nothing merges, and nothing outside the backup file survives in scope. App Settings/`launchPin` is never touched by a restore (§2.3).

**FR-8 — No additional PIN beyond the app-launch gate.** Backup export, and restore's own destructive path, both rely on FR-6's confirmation rather than a second credential check, consistent with every other Management SRS module's Permissions section.

**FR-9 — Standing subject order.** *(Added 2026-08-25 by `TDS_Slice_Subject_Order_Grouped_Review.md`. Design only — unbuilt at the time of writing.)* Settings offers an editor for the order the household's **subjects** appear in on every screen that groups by subject: the Course Template Library, Assigned Courses and the weekly view — which all sorted subjects alphabetically before this FR and adopt the order in the same build as the editor — and then Generate (Module 08 FR-17) and the Assignments view, which gain subject grouping for the first time.

- The stored value is a single record, one array of subject names, most-important first. It is a **household preference, not a device one**: it lives with the other authored records (alongside the grading defaults), so it mirrors to D1 and comes back with a restore. It is never part of `appSettings`, which holds device-local credentials and is deliberately never mirrored (§2.3).
- The editor lists the **effective** order — stored entries in their stored positions, then every subject in use on a Course record that the stored list does not mention, alphabetically and visibly marked as not yet ordered. Moving an entry and saving rewrites the whole array; there is no per-entry record.
- **A subject need not be listed to be usable.** An unlisted subject sorts alphabetically after every listed one, so a Course given a brand-new subject appears everywhere immediately, without a visit to this screen. An absent or empty list means every consumer sorts alphabetically — the behaviour before this FR existed.
- Matching is on the trimmed, case-insensitive subject text; the Course record's own text is what is ever displayed. An entry no Course uses any more may be removed, and matches nothing until then.
- This FR stores and edits an ordering. It does not create a subject entity, does not constrain what may be typed into a Course's subject field, and does not write to any Course record.


## 5. Validation rules

| Rule | Detail |
|---|---|
| Initial/new PIN | Minimum 4 digits, numeric; must match its confirmation entry (FR-1/FR-2). |
| Current PIN (for change) | Must match the stored `launchPin` exactly before any change is accepted (FR-2). |
| Backup file schema | Must carry a `schemaVersion` this app recognizes, and pass internal referential checks; either failure ⇒ whole-file reject before any write (FR-4). |
| Restore scope | Every entity in §2.2's scope is replaced; App Settings/`launchPin` is never included or touched (FR-7/§2.3). |
| Restore confirmation | Required, explicit, and worded to describe full replacement — restore never proceeds silently or on an ambiguous click (FR-6). |
| Pre-restore snapshot | Always generated and offered before a restore is applied, with no way to skip it (FR-5). |
| Subject order entries | Free text matching a Course's subject, trimmed and compared case-insensitively; an unlisted or unmatched subject is legal and sorts alphabetically after the listed ones (FR-9). |

## 6. Permissions

The Management App's `launchPin` (Domain Model §2.11) already gates entry to this screen, like every other module — no *additional* per-action PIN for backup export or library viewing. Restore is the one exception worth naming explicitly: it adds no second PIN check, but does require FR-6's explicit destructive-action confirmation before proceeding — a deliberate, non-PIN safeguard consistent with §2.5.

## 7. Inputs / Outputs

**Inputs:** current and new PIN values (FR-1/FR-2); a parent-selected backup JSON file for restore (FR-4); reads every in-scope entity (§2.2) for export (FR-3) — does not write to any of them outside a restore operation.

**Outputs (written to Management App storage):**
- The `launchPin` field on the App Settings record (FR-1/FR-2) — the only write this module makes outside a restore.
- On a confirmed restore, every in-scope entity (§2.2) replaced wholesale (FR-7).
- A downloadable backup JSON file, both on-demand (FR-3) and automatically pre-restore (FR-5) — handed to the parent as an artifact, not written back into app storage.

## 8. Acceptance criteria

1. On a fresh install, the app is unusable until an initial `launchPin` is set; no skip path exists anywhere.
2. Setting an initial PIN under 4 digits, or one that doesn't match its confirmation, is rejected.
3. Changing the `launchPin` with an incorrect current PIN is rejected with no partial effect.
4. Immediately after a successful PIN change, the new PIN — and only the new PIN — unlocks the app; the old PIN no longer works.
5. Exporting a backup at any time produces a single JSON file containing every in-scope entity and a `schemaVersion`, with no PIN prompt beyond the app's existing launch gate.
6. A backup file with an unrecognized `schemaVersion` is rejected before any data is read or written.
7. A backup file whose internal references don't resolve (e.g., a Course pointing at a `curriculumId` absent from the same file) is rejected whole — not partially applied.
8. Attempting a restore always produces a downloadable pre-restore snapshot of current data before the replacement is applied, with no way to bypass that step.
9. A restore is never applied without the parent explicitly confirming the full-replacement warning; declining the confirmation leaves all current data untouched.
10. After a successful restore, every in-scope entity matches the backup file's contents exactly, and the device's `launchPin` is unchanged from whatever it was immediately before the restore.
11. Restoring an older, schema-compatible backup after authoring new Curricula/Courses on the current device replaces those newer records entirely — nothing from the pre-restore state survives in scope except via the FR-5 snapshot the parent chose to keep.
12. No screen in this module exposes per-entity editing (renaming a single Curriculum, editing a single Child, etc.) — those remain owned exclusively by their own existing modules (§2.6).

---

## Management App SRS — complete

All eleven Management modules are now written: Curriculum Library, Difficulty Tier & Reward Category, Course Template Library, Child Management, Pacing Configuration, Chore Authoring, Family Event Authoring, Packet Generation & Export, Completion Import, Master Reporting, Settings & Backup. Combined with the Child App's eleven modules, the SRS layer for both apps is complete.

Per the Roadmap, the next document in sequence is the **Technical Design Specification** — file structure, IndexedDB schema (Management's multi-student, template-library shape vs. the Child App's single-child shape), the exact Packet/Completion-CSV JSON shapes, the Activity ID delimiter, ledger checkpoint cadence, and this module's own backup-file `schemaVersion`/shape.
