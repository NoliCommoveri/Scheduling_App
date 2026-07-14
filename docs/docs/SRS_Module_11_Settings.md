# Software Requirements Specification — Child App
## Module 11: Settings

*The Roadmap lists "Settings" with no further elaboration — genuinely a catch-all. Scoped below from what every other module already implies needs a home.*

---

## 1. Purpose

Houses the low-stakes profile edits and the PIN-change flow that don't belong to any more specific module already written. This module does not own the theme switcher (Module 10) or the Wipe action (Module 9) — both have their own access points outside gated Settings, per §2.2.

## 2. Scope notes

**2.1 — Editing `name` and `label` (Semester) after setup.** Module 1's wizard runs once and is never re-enterable. Without an edit path somewhere, the semester label — meant to be a rotating passthrough display ("Fall 2025" → "Spring 2026") — would be stuck at whatever the parent typed on day one forever, defeating its own purpose. Both are editable here, since Settings is the natural home for them.

**2.2 — Settings is PIN-gated as a whole.** Editing name/semester and changing the PIN all require the parent PIN just to enter the screen — not only an intrinsic check on the PIN-change action alone. This is one of the Domain Model's three PIN-gated surfaces, alongside deferment/waive and reward spend (Domain Model §3.2).

**Consequence: theme switching cannot live inside gated Settings.** Theme is *not* a parent setting — Module 10 locks in zero gating for it, ever. So the theme switcher needs its **own independent entry point outside the gated Settings screen** (e.g., directly from the child's home/daily view) — it can't be reached only via a link inside a PIN-gated area, or it would become gated by nesting. FR-4 below reflects this.

**Same applies to the Wipe action.** Module 9's button lives alongside Completion CSV Export (Module 8), not inside gated Settings — if its only access point were inside gated Settings, it would become incidentally PIN-gated too, quietly overriding Module 9's no-PIN, confirmation-only design. That placement, not a PIN, is what keeps Wipe from being stumbled into during ordinary daily work.

**2.3 — No PIN-recovery mechanism.** No recovery flow is built — this remains a real risk for anyone else using this app, but it's an accepted, deliberate call.

**2.4 — PIN storage on Child.** §7's outputs list `pin` alongside `name` as fields written to the Child record, matching Domain Model §3.2, which lists `pin` as a required field on Child. A separate, independent Management App PIN (`launchPin`, Domain Model §2.11) also exists — a different app, different device, different credential, not something this module touches.

**2.5 — The repair form is this module's home for Ledger/Streak recovery.** Domain Model §5.9 and Architecture Evaluation §10 establish a three-layer survival design for the Reward Ledger and Streak (persistent-storage request, a write-only recovery note bundled into Completion CSV Export, and a repair form). This module owns the third layer only — a parent-PIN-gated form to key recovery-note values back in. It never reads the note itself; the note is for the parent's eyes.

## 3. User stories

- As a parent, I want to update the semester label each term without having to re-run the whole setup wizard.
- As a parent, I want to change the PIN periodically, or if I think my child has learned it.
- As a child, I want to fix my name if I typed it wrong during setup, without needing my parent.

## 4. Functional requirements

**FR-0 — PIN gate on entry.** The Settings screen itself is not reachable without the correct parent PIN. This applies to every field in this module — name edit, semester label edit, and PIN change alike.

**FR-1 — Edit child name.** Same validation as Module 1 (non-empty, reasonable display length). Updates `name` (Child record, Domain Model §3.2) everywhere it's shown throughout the app.

**FR-2 — Edit semester label.** Free text, same as Module 1. Updates `label` (Semester, Domain Model §3.1) — exported as the `semesterLabel` column in the Packet/Completion CSV interchange, but stored as `label` on the entity itself. Remains a passthrough display value only — editing it never affects validation, gating, wipe behavior, or anything else (§2.1; consistent with Module 1's original constraint on this field).

**FR-3 — Change PIN.** Once inside the PIN-gated Settings screen (FR-0), still requires the current PIN entered correctly a second time, then a new PIN entered twice for confirmation, meeting the same minimum (4 digits, numeric) rule as initial setup (Module 1). An incorrect current PIN blocks the change entirely — no partial effect. On success, the new PIN immediately becomes the credential for every PIN-gated surface across the app (Settings itself, deferment/waive, reward spend) — the old PIN stops working the moment the change succeeds.

**FR-4 — Theme and Wipe get independent access points, outside gated Settings.** The theme switcher (Module 10) must have its own entry point reachable without the Settings PIN — nesting it inside a gated screen would silently override Module 10's "always ungated" decision. The Wipe action (Module 9) — a child-side button paired with Completion CSV Export (Module 8) — has its own access point outside gated Settings too, preserving Module 9's no-PIN, confirmation-only design. This module doesn't implement either action — it just must not become their only, gated, doorway.

**FR-5 — No multi-child or profile-switching capability.** This app is single-child, child-scoped per device (§3, throughout every module). Settings never exposes an "add another child" or profile-picker capability — that would contradict the locked single-child design.

**FR-6 — No reset capability beyond Module 9's Wipe.** Settings doesn't add a separate, more destructive "factory reset" or "delete everything" action. Module 9 already defines the one sanctioned clearing mechanism. This is unaffected by FR-7 below — the repair form is a targeted `adjust`/set on two specific values, not a reset, and doesn't create a second clearing mechanism.

**FR-7 — Repair form (Ledger/Streak recovery).** Behind the same Settings PIN gate (FR-0), the parent can:
- (a) apply a signed balance adjust to any Reward Category — written as an `adjust` tail entry in that category's Reward Ledger (Module 6, Domain Model §3.7). A negative adjust that would take the balance below zero is floored at zero, not rejected outright.
- (b) set the streak — writing `currentStreak` and `lastQualifyingDate` together (Module 7, Domain Model §3.8), `lastQualifyingDate` defaulting to device-local today so the on-open gap catch-up doesn't immediately re-zero the restored value.

Framed in-UI as recovery/repair, with the latest recovery note (Module 8, FR-8) named as the expected source of values — not presented as a general-purpose editor. This form never reads the note itself; the parent supplies the values by eye.

## 5. Validation rules

| Field | Rule |
|---|---|
| Child name | Non-empty; same length constraint as Module 1. |
| Semester label | Non-empty; free text, no format constraint. |
| New PIN | Minimum 4 digits, numeric; must match its confirmation entry. |
| Current PIN (for change) | Must match the stored PIN exactly before any change is accepted. |
| Balance adjust amount | Signed whole number; a negative adjust cannot take the category's balance below zero — floored at zero, not rejected (Domain Model §3.7). |
| Streak value (`currentStreak`) | Non-negative integer. |
| `lastQualifyingDate` (repair) | Required whenever `currentStreak` is set via the repair form; defaults to device-local today. |

## 6. Permissions

**Parent PIN required just to enter Settings** (FR-0) — this applies to name edit and semester label edit too, not just the PIN-change action. Theme switching and Wipe are explicitly **not** part of this gate — see FR-4. The repair form (FR-7) sits behind this same gate and uses the same single Child-App `pin` as every other gated action — no new or separate credential.

## 7. Inputs / Outputs

**Inputs:** current `name`, `label` (Semester), and `pin` values; new values entered by the parent or child; for the repair form (FR-7) — the target Reward Category's current displayed balance (read, Module 6, so the parent can see what they're correcting) and the current `currentStreak`/`lastQualifyingDate` (read, Module 7); the recovery-note values themselves are never read by the app — the parent supplies them by eye from the note file.

**Outputs (written to device storage):** updated `name` (Child record), `label` (Semester), and/or `pin` (Child record) — whichever field was edited; an `adjust` entry in the target category's Reward Ledger tail (FR-7a, Module 6's data); `currentStreak` and `lastQualifyingDate` together (FR-7b, Module 7's data). No other module's data is touched by this one.

## 8. Acceptance criteria

1. Settings is entirely unreachable without the correct parent PIN — including just to view or edit the child name or semester label.
2. Editing the semester label updates the display value only — no validation, gating, or wipe behavior anywhere in the app changes as a result.
3. Changing the PIN with an incorrect current PIN is rejected with no partial effect.
4. A new PIN under 4 digits, or one that doesn't match its confirmation, is rejected.
5. Immediately after a successful PIN change, the new PIN — and only the new PIN — works for Settings entry, deferment/waive, and reward spend.
6. Settings contains no multi-child, profile-switching, or "add another child" capability anywhere.
7. Settings contains no reset/clear capability beyond linking to Module 9's existing Wipe action.
8. The theme switcher is reachable without ever entering the parent PIN, via an access point outside Settings.
9. Wipe's button is reachable without the parent PIN, via an access point outside Settings (alongside Completion CSV Export, not the daily view).
10. Behind the Settings PIN gate, the parent can apply a signed balance adjust to any Reward Category; a negative adjust that would take the balance below zero is floored at zero rather than rejected outright.
11. Behind the Settings PIN gate, the parent can set the streak; doing so writes `currentStreak` and `lastQualifyingDate` together, with `lastQualifyingDate` defaulting to device-local today.
12. The repair form is presented as recovery/repair — referencing the recovery note as the expected source of values — not as a general-purpose editor for the Ledger or Streak.
13. No PIN other than the single Child-App `pin` gates the repair form — using the same PIN that gates every other action in this module.
14. The repair form adds no reset/clear capability beyond what FR-6 already excludes — Module 9's Wipe remains the sole clearing mechanism.

---

## Child App SRS — complete

All eleven modules are written: Startup Wizard, Packet Import, Daily Planner, Activity & Chore Completion/Logging, Deferment/Waive, Reward Economy (child-facing), Streak, Completion CSV Export, Wipe, Theming, Settings.

**A second, independent PIN exists at the Management App level.** The Management App has its own `launchPin` (Domain Model §2.11), gating the whole app once per session — separate from the Child App's `pin`. This doesn't affect this module directly (Settings is Child App only), but it affects the Management SRS modules' Permissions sections and the Management Settings & Backup module, which owns the launch PIN's set/change flow.

Per the Roadmap, the next document in sequence is the **Technical Design Specification** — file structure, IndexedDB schema, the exact packet/CSV JSON shapes, the Activity ID delimiter, and ledger checkpoint cadence.
