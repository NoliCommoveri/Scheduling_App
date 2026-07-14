# Software Requirements Specification — Child App
## Module 6: Reward Economy (child-facing)

*Written against Domain Model §3.7/§3.7a/§3.9, Architecture Evaluation §10. Note on sequencing: the underlying Reward Ledger earn logic already exists as of Module 4 (M2 on the Build Roadmap) — this module is specifically the *display and spend* layer, which the Roadmap deliberately places at M3, alongside Theming. Rewards are being earned from M2; the child just can't see them until this module lands at M3.*

---

## 1. Purpose

Gives the child a read-only view of what they've earned, and gives the parent a PIN-gated way to spend/deduct it. This module owns *display and spend only* — earning itself is Module 4's responsibility (already specified), and the underlying snapshot+tail storage mechanics belong to the Reward Ledger as a data concept (§3.7), not to this module.

## 2. Scope note

**"Activities done this week" scope.** Architecture Evaluation §10 describes a completion-count reward visual (activities done this week, days streaked) alongside the Ledger display. Scope applied below:
- "This week" = the current device-local calendar week (matching the Streak's device-local day boundary, §3.8).
- The count includes both completed Activities and completed Chores — not Activities only — for consistency with the flat-earn rule already treating them identically (§2.3/§2.6).
- "Days streaked" in this visual is a read-only reference to the Streak module's live counter (Module 7, written separately) — this module doesn't compute or store it.

## 3. User stories

- As a child, I want to see how much I've earned in each reward category, in a way that feels like part of my theme rather than a spreadsheet.
- As a child, I want a quick sense of how much I've gotten done this week, separate from my currency balances.
- As a parent, I want to deduct from my child's balance when they redeem something, protected by my PIN so they can't do it themselves.

## 4. Functional requirements

**FR-1 — Balance display.** Shows the current balance for every Reward Category the child has ever earned into, computed as **snapshot + sum(tail)** at read time (§3.7 — already locked, this module just displays it). Read-only; no child-facing edit control anywhere. The tail may include an `adjust` entry — a third type alongside `earn`/`spend`, written only by the parent-PIN-gated repair form in Settings (Module 11), never by this module — which folds into the same sum identically. The zero-floor already enforced on the ledger (§5, Validation rules) applies regardless of entry type; the displayed-balance formula itself is unchanged.

**FR-2 — Theme-skinned category display.** Each category renders using its Theme/Settings display mapping (§3.9) — a friendly label/icon/color, not the internal `categoryId`, which is never shown to the child. A category with no specific mapping under the currently active theme falls back to the theme's generic default display rather than erroring or showing raw data.

**FR-3 — Completion-count visual.** A separate, non-currency display showing completions this week (§2 — scope) and a read-only reference to the current streak (Module 7). This is visually and conceptually distinct from the category balances in FR-1 — the two are never merged into one number.

**FR-4 — Parent-PIN-gated spend.** The parent selects a category, enters a whole-number amount, confirms, and a `spend` entry is written to that category's Reward Ledger tail (§3.7), immediately reducing the displayed balance. No PIN, no spend screen is reachable by the child.

**FR-5 — No cross-category conversion.** A spend only affects the category it's entered against. Categories never convert into one another (§3.7 — already locked).

**FR-6 — No child-side spend, no interchange channel.** There is no way for the child to initiate a spend, and spends never travel through the Packet or Completion CSV (§3.7).

**FR-7 — No priced-redeemable catalog.** The Reward Definition catalog (§3.7a) is deferred by decision, not by omission. This module's spend flow is free-form amount entry only — no picker of named, pre-priced items. Do not add one without an explicit decision to un-defer §3.7a.

## 5. Validation rules

| Rule | Detail |
|---|---|
| Spend amount | Whole number, greater than zero. |
| Spend ceiling | Cannot exceed the category's currently displayed balance — spend is rejected rather than allowed to go negative. |
| PIN | Must match the device's parent PIN before the spend screen is reachable at all, not just before the final confirm. |
| Category display | Every category the child has ever earned into must render with either a theme-specific or generic-default display — never a raw `categoryId`. |

## 6. Permissions

**Balance display (FR-1, FR-2, FR-3): no PIN** — this is the child's own read-only view of what they've earned. **Spend (FR-4): parent PIN required**, same PIN as Module 1/5.

## 7. Inputs / Outputs

**Inputs:** Reward Ledger snapshot + tail (read — the tail may include `adjust` entries written by Settings, Module 11), Theme/Settings category display mapping (read), Activity Records for the completion-count visual (read), Streak's current counter (read, Module 7), parent PIN entry for spend.

**Outputs (written to device storage):** a new `spend` entry in the Reward Ledger tail per FR-4. Nothing else — this module never writes to Received Packet content, Activity Records, Streak, or Semester/Child data.

## 8. Acceptance criteria

1. Every category the child has earned into displays a balance equal to snapshot + sum(tail), with no raw `categoryId` visible anywhere.
2. A category with no theme-specific display under the active theme still renders correctly via the generic default.
3. The completion-count visual and the category balances never appear merged into a single figure.
4. The spend screen is unreachable without the correct parent PIN.
5. A spend request exceeding a category's current balance is rejected before any Ledger entry is written.
6. A successful spend immediately reduces the displayed balance for that category only — no other category changes.
7. No catalog of named, pre-priced redeemables appears anywhere in the spend flow.
8. A negative `adjust` entry that would take a category's balance below zero is floored at zero rather than allowed to go negative — the same floor enforced on spend. (The entry itself is written by Settings, Module 11; this criterion verifies the shared balance/fold behavior this module displays.)
9. An `adjust` entry folds into the snapshot on the same deterministic cadence as any `earn` or `spend` entry — no special-cased fold path for corrections.
