# Software Requirements Specification — Child App
## Module 1: Startup Wizard

*Written against Domain Model §3.1/§3.2/§3.9, Architecture Evaluation, Documentation Roadmap.*

---

## 1. Purpose

First-run setup for the Child App. Runs exactly once per device profile, before any daily-plan use is possible. Produces the minimum data needed for the app to be usable: a paired device token, a Child record, a parent PIN, and a semester label. Does not touch curriculum, pacing, or content — that arrives from `GET /api/plan` once the parent commits assignments.

> **Amended 2026-08-11.** "before any packet import" and "via Packet Import (Module 2)" are
> obsolete — Module 2 is retired (`TDS_Slice_Online_Revamp.md` §11) and content now arrives
> over the API. The substantive change to this module is FR-3, which becomes the pairing
> step; see there.

## 2. Scope notes

**2.1 — Theme step sequencing.** The wizard captures a `theme` field and shows a chooser, but at M1 that chooser offers only whatever theme(s) exist at build time (minimally, one default). This mirrors the Reward Ledger's own M2/M3 distinction (earning exists from M2, display doesn't arrive until M3) — the wizard's *data capture* is real from M1, and the *richness of the picker* grows at M3 with no schema change.

**2.2 — PIN storage.** The parent PIN's home is `pin` on Child (Domain Model §3.2), alongside `name`. A separate, independent Management App PIN (`launchPin`, Domain Model §2.11) also gates the entire Management App at launch — a different credential on a different app/device, not related to this module.

The parent PIN is stored in plaintext in the device's IndexedDB. No encryption or hashing is applied; it is a device-local speed bump on a family device, not a security boundary.

> **Amended 2026-08-10.** The original justification — "this app runs entirely offline" — is
> obsolete. The reasoning that replaces it: the PIN is **never transmitted and never
> mirrored** (`appSettings` is excluded from sync), so it remains device-local even though
> the app is now networked. What *does* leave the device is the child device token, and that
> is hashed at rest server-side (`TDS_Slice_Online_Revamp.md` §3.6). Do not extend the
> plaintext-is-fine reasoning to any credential that reaches the network.

## 3. User stories

- As a parent setting up a new device for my child, I want to set a PIN so that parent-gated actions (deferment, reward spend) are protected from the start.
- As a parent handing a device to my child, I want to link it to that child once, so it receives their plan and nothing else — and so the app knows whose it is without my typing it.
- As a parent, I want to give the current semester a label so the child's daily view has a human-readable heading, without that label controlling any app logic.
- As a child using the app for the first time, I want the setup to be quick and simple so I can get to my first daily plan.

## 4. Functional requirements

**FR-1 — Single run.** The wizard runs when no Child record exists on the device. Once a Child record is created, the wizard is not re-enterable through normal navigation. (Re-running setup, if ever needed, is a distinct future capability — e.g. profile reset — not part of this module.)

**FR-2 — Step 1: Parent PIN.**
- Parent enters a PIN and repeats it for confirmation.
- On match, the PIN is stored and becomes the credential for every parent-gated action defined elsewhere in the domain (deferment/waive, reward spend, and any other PIN-gated action named in later modules).
- This module does not define *what* the PIN gates beyond noting it's the same PIN reused by those other modules — one PIN per child device, not one per feature. Stored as `pin` on Child (Domain Model §3.2).

**FR-3 — Step 2: Pair this device.**

> **Amended 2026-08-11.** This step previously read "Child name": someone typed the child's
> first name and it was stored locally. That existed because there was nothing else to ask.
> Under `TDS_Slice_Online_Revamp.md` §4.3 there is — the pairing exchange returns
> `childName` — so the step now redeems a pairing code and the name arrives with the token.
> §7 below had already recorded that the wizard is where a device is paired; this is the
> functional requirement catching up to it. The offline-vs-online exemption in CLAUDE.md
> §V.A covers the change: the typed name existed only because the device could not ask.

- Parent mints an 8-character code in the Management App (**Settings → Devices → Pair a
  device**) for the child this device belongs to. The code is valid 15 minutes and single-use
  (Revamp §4.3).
- Child (or parent) types the code, optionally labelling the device ("Ellie's tablet").
- Separators a person adds while transcribing — spaces, dashes — and lower case are
  normalized away before the request; the alphabet excludes `I`/`L`/`O`/`U`/`0`/`1` so the
  usual transcription confusions cannot arise.
- On success the Worker returns `{ token, childId, childName }`. The token is stored in
  `syncMeta` and never displayed again; `childName` is stored as `name` on the Child record
  and used for display throughout the app (e.g., "Morning, Nora!").
- **The step is not skippable.** An unpaired device has no plan to render and no upload
  path, and its only route to a code form would be the PIN-gated Settings screen. See the
  `[DECISION]` block at the head of `child-app/js/wizard.js`.
- The token is committed as soon as the server answers, ahead of the remaining steps. A
  wizard abandoned after this point and reopened **recognises its own pairing** and offers
  Continue rather than asking for a code that has already been consumed.
- A failed redemption (unknown, expired, or already-used code; unreachable server) leaves
  the step in place with the reason shown, and is retryable.
- A **re-pair** from Settings overwrites the local `name` only when the device holds no name
  yet, or when the token now scopes to a *different* `childId`. A display name set through
  Module 11 FR-1 survives re-pairing the same child.

**FR-4 — Step 3: Semester label.**
- Parent enters a free-text label (e.g., "Fall 2025").
- Stored as `label` on Semester (Domain Model §3.1). Per §3.1, this is a **passthrough display label only** — it does not scope the wipe, gate packet import, or drive any lifecycle logic. It rides along in the Packet interchange (Domain Model §4.1) with no auto-reject on mismatch against whatever the parent later generates.

**FR-5 — Step 4: Theme confirm.**
- Child (or parent) selects a starting theme from whatever themes are available at build time.
- Stored as `theme` on Theme/Settings (Domain Model §3.9).
- See §2.1 above — this step's available options grow at M3 without requiring a schema or flow change.

**FR-6 — Completion.** On finishing all steps, the wizard creates the Child record, PIN, semester label, and theme selection, then transitions directly to the Daily Planner, which shows its empty state until the parent commits assignments for this child.

The PIN is written by this final step alone. Because FR-3 commits the device token — and the name — several steps earlier, "setup is complete" is tested as **both a name and a PIN on the Child record**, not a name alone (`app.js`). A wizard abandoned midway therefore re-enters at step 1 rather than dropping into a planner whose parent-gated actions could never be unlocked.

**FR-7 — No content in this module.** The wizard never touches Curriculum, Course, Activity, Chore or Family Event data. Assignments arrive exclusively from `GET /api/plan` (Revamp §5.5) once this device is paired and the parent has committed a batch. The wizard's one job on that front is to obtain the credential that makes the fetch possible.

## 5. Validation rules

| Field | Rule |
|---|---|
| PIN | Minimum 4 digits; numeric; must match its confirmation entry before proceeding. |
| Pairing code | Non-empty after normalization (case, spaces and dashes stripped). Validity is the server's to judge — unknown, expired and already-consumed all come back `409` and are shown as-is. |
| Child name (`name`) | Not entered here. Supplied by the pairing response; the Worker holds it `NOT NULL` (Revamp §3.2). Editable afterwards through Module 11 FR-1. |
| Semester label | Non-empty; free text; no format constraint (it's display-only). |
| Theme | Must resolve to a valid, available `theme`; a default is pre-selected so the child can proceed without deliberating. |

## 6. Permissions

- The wizard itself requires no PIN to *run* (there is no PIN yet at Step 1 — it's being created).
- Once complete, all subsequent entry into "parent" surfaces (e.g., the Settings module) requires the PIN just created.

## 7. Inputs / Outputs

**Inputs:** parent/child keyboard entry only. No file import in this module.

> **Amended 2026-08-10.** "No network" no longer holds: the wizard is where a child device
> is paired, so it accepts an 8-character pairing code and exchanges it for a device token
> via `POST /api/pair` (`TDS_Slice_Online_Revamp.md` §4.3). This is the module's one network
> call, and it happens once per device.

**Outputs (written to device storage):**
- `syncMeta`: `{ deviceToken, childId, childName, pairedAt }` — written at FR-3, ahead of the rest
- Child record: `{ name, pin }` — `name` from the pairing response, `pin` from FR-2
- Semester: `{ label }`
- Theme/Settings: `{ theme, ...future settings }`

These four outputs are the complete data footprint of this module. Nothing else in the domain model is created here.

## 8. Acceptance criteria

1. On a device with no existing Child record, opening the app presents the wizard and nothing else (no Daily Planner, no Settings access).
2. The wizard cannot be completed with a PIN under 4 digits, a mismatched PIN confirmation, or without a redeemed pairing code.
3. On completion, a device token, a Child record, semester label, and theme selection all exist in device storage; the app transitions to the Daily Planner and the child's plan appears there without a further prompt.
4. Reopening the app after completion goes straight to the Daily Planner (or profile/picker flow, if multi-profile is in scope — not addressed by this module) and never re-shows the wizard.
4a. A code typed as `ab2c-3d4e` pairs exactly as `AB2C3D4E` does.
4b. An expired or already-used code leaves the step in place with the server's reason shown, and a fresh code entered afterwards succeeds.
4c. Closing the app after the pairing step but before the last one, then reopening: the wizard restarts at step 1, and its pairing step reports the device already linked — with the child's name — rather than asking for another code.
5. The semester label displays somewhere in the child-facing UI but is not referenced by any validation, gating, or wipe logic.
6. `gradeLabel` and `timeZone` do not appear anywhere in the data model produced by this module.
7. The Child record's name field is written as `name`.
