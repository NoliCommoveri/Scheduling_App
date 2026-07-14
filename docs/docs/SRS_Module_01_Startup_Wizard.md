# Software Requirements Specification — Child App
## Module 1: Startup Wizard

*Written against Domain Model §3.1/§3.2/§3.9, Architecture Evaluation, Documentation Roadmap.*

---

## 1. Purpose

First-run setup for the Child App. Runs exactly once per device profile, before any packet import or daily-plan use is possible. Produces the minimum data needed for the app to be usable: a Child record, a parent PIN, and a semester label. Does not touch curriculum, pacing, or content — that all arrives later via Packet Import (Module 2).

## 2. Scope notes

**2.1 — Theme step sequencing.** The wizard captures a `theme` field and shows a chooser, but at M1 that chooser offers only whatever theme(s) exist at build time (minimally, one default). This mirrors the Reward Ledger's own M2/M3 distinction (earning exists from M2, display doesn't arrive until M3) — the wizard's *data capture* is real from M1, and the *richness of the picker* grows at M3 with no schema change.

**2.2 — PIN storage.** The parent PIN's home is `pin` on Child (Domain Model §3.2), alongside `name`. A separate, independent Management App PIN (`launchPin`, Domain Model §2.11) also gates the entire Management App at launch — a different credential on a different app/device, not related to this module.

The parent PIN is stored in plaintext in the device's IndexedDB. No encryption or hashing is applied; this app runs entirely offline on a parent-controlled device. Encryption is not a security measure for this environment.

## 3. User stories

- As a parent setting up a new device for my child, I want to set a PIN so that parent-gated actions (deferment, reward spend) are protected from the start.
- As a parent, I want to enter my child's name once so it appears throughout the app without re-entry.
- As a parent, I want to give the current semester a label so the child's daily view has a human-readable heading, without that label controlling any app logic.
- As a child using the app for the first time, I want the setup to be quick and simple so I can get to my first daily plan.

## 4. Functional requirements

**FR-1 — Single run.** The wizard runs when no Child record exists on the device. Once a Child record is created, the wizard is not re-enterable through normal navigation. (Re-running setup, if ever needed, is a distinct future capability — e.g. profile reset — not part of this module.)

**FR-2 — Step 1: Parent PIN.**
- Parent enters a PIN and repeats it for confirmation.
- On match, the PIN is stored and becomes the credential for every parent-gated action defined elsewhere in the domain (deferment/waive, reward spend, and any other PIN-gated action named in later modules).
- This module does not define *what* the PIN gates beyond noting it's the same PIN reused by those other modules — one PIN per child device, not one per feature. Stored as `pin` on Child (Domain Model §3.2).

**FR-3 — Step 2: Child name.**
- Parent (or child, with parent present) enters the child's first name (or preferred display name).
- Stored as `name` on the Child record. Used for display throughout the app (e.g., "Morning, Nora!").

**FR-4 — Step 3: Semester label.**
- Parent enters a free-text label (e.g., "Fall 2025").
- Stored as `label` on Semester (Domain Model §3.1). Per §3.1, this is a **passthrough display label only** — it does not scope the wipe, gate packet import, or drive any lifecycle logic. It rides along in the Packet interchange (Domain Model §4.1) with no auto-reject on mismatch against whatever the parent later generates.

**FR-5 — Step 4: Theme confirm.**
- Child (or parent) selects a starting theme from whatever themes are available at build time.
- Stored as `theme` on Theme/Settings (Domain Model §3.9).
- See §2.1 above — this step's available options grow at M3 without requiring a schema or flow change.

**FR-6 — Completion.** On finishing all steps, the wizard creates the Child record, PIN, semester label, and theme selection, then transitions directly to the Daily Planner (which, at M1, will show an empty state until a packet is imported — see Module 2).

**FR-7 — No content in this module.** The wizard never touches Curriculum, Course, Activity, Chore, Family Event, or any Received Packet data. Those arrive exclusively through Packet Import (Module 2). Packet acquisition, schema-version handling, all-or-nothing validation, and merge are that module's responsibility, not the wizard's.

## 5. Validation rules

| Field | Rule |
|---|---|
| PIN | Minimum 4 digits; numeric; must match its confirmation entry before proceeding. |
| Child name (`name`) | Non-empty; reasonable max length for display (e.g., truncation-safe in headers). |
| Semester label | Non-empty; free text; no format constraint (it's display-only). |
| Theme | Must resolve to a valid, available `theme`; a default is pre-selected so the child can proceed without deliberating. |

## 6. Permissions

- The wizard itself requires no PIN to *run* (there is no PIN yet at Step 1 — it's being created).
- Once complete, all subsequent entry into "parent" surfaces (e.g., the Settings module) requires the PIN just created.

## 7. Inputs / Outputs

**Inputs:** parent/child keyboard entry only. No file import, no network, no Drive access in this module.

**Outputs (written to device storage):**
- Child record: `{ name, pin }`
- Semester: `{ label }`
- Theme/Settings: `{ theme, ...future settings }`

These three outputs are the complete data footprint of this module. Nothing else in the domain model is created here.

## 8. Acceptance criteria

1. On a device with no existing Child record, opening the app presents the wizard and nothing else (no Daily Planner, no Settings access).
2. The wizard cannot be completed with a PIN under 4 digits, a mismatched PIN confirmation, or an empty child name.
3. On completion, a Child record, semester label, and theme selection all exist in device storage, and the app transitions to the Daily Planner.
4. Reopening the app after completion goes straight to the Daily Planner (or profile/picker flow, if multi-profile is in scope — not addressed by this module) and never re-shows the wizard.
5. The semester label displays somewhere in the child-facing UI but is not referenced by any validation, gating, or wipe logic.
6. `gradeLabel` and `timeZone` do not appear anywhere in the data model produced by this module.
7. The Child record's name field is written as `name`.
