# Software Requirements Specification — Child App
## Module 5: Deferment / Waive

*Written against Domain Model §3.6b (primary source — most of this module's substance is already locked there), §3.4, §3.6a, §3.8, §4.2. This module formalizes what Module 3 (Daily Planner, FR-6) already references as an entry point.*

---

## 1. Purpose

The sanctioned way to resolve a required item the child can't or won't complete as scheduled — either push it to a new date (**Reschedule**) or drop its required status permanently (**Waive**) — without silently breaking the Streak or losing the obligation. Per §3.6b, there is no separate "excuse the day" concept; this pair of actions *is* that mechanism.

## 2. Scope notes

**2.1 — Applies to Activity or Chore alike.** Domain Model §3.6b covers "Activity or Chore" explicitly — Module 3's entry point is available on "any required, not-yet-complete item," the Completion CSV treats Chores on the same `activityId` join key as Activities (§4.2), and Module 7 (Streak) cites this module as covering Chores directly. Family Events remain excluded regardless, since they're never required or completable.

**2.2 — Reschedule has no upper date bound.** Reschedule allows any date from device-local today forward, with no upper bound tied to a packet. This reflects that import is pure-additive (Module 2): there's no single "current packet" whose range would otherwise bound the choice.

## 3. User stories

- As a parent, I want to move a required item to a later date when something legitimately came up, without it silently breaking my child's streak or getting lost.
- As a parent, I want to be able to drop a required item entirely when it's just not going to happen, and have that show up as a deliberate choice, not an "undone" mark.
- As a child, I want my streak to survive days my parent has excused, since it wasn't a day I blew off my work.

## 4. Functional requirements

**FR-1 — Entry point and PIN gate.** Triggered from the Daily Planner's entry point (Module 3, FR-6) on any required, not-yet-complete Activity or Chore (§2.1). Both operations below require the parent PIN (set up in Module 1) before proceeding — this is one of the Domain Model's three PIN-gated actions, alongside reward spend and Settings entry (Domain Model §3.2).

**FR-2 — Reschedule.** Moves the item's due date to a new date, device-local today or later (§2.2). The item:
- Remains a pending required obligation on its new date.
- Is preserved through a wipe (§3.6a).
- Reports normally in the Completion CSV whenever it's eventually completed — no special status, no new interchange field.
- Can be rescheduled again later if needed; no limit on how many times.
- Does **not** create or modify an Activity Record — this is purely a local Daily-Plan date edit on the "as received" item (§3.6b's named guardrail: not the pacing engine, no cursor, no sequence computation).

**FR-3 — Waive.** Drops the item's required status permanently. The item:
- Will not be made up — this is a one-way action, consistent with §3.6b's "will not be made up" language. No undo is specified.
- Creates an Activity Record with `status: 'waived'` (not `'complete'`) so the Completion CSV can carry `status = 'waived'` (§4.2, already reserved) when exported.
- Is treated the same as a completed/exported item for wipe purposes once its waived status has been exported — it's no longer "pending," so it's no longer exempt from the wipe (§3.6a).

**FR-4 — Streak interaction.** Both operations resolve the item's "required-and-undone" status for its **original** date, so a day rescued by either action can still qualify for the streak (§3.8) instead of breaking it. (Reschedule additionally makes the item required-and-due on its *new* date — that date's qualification depends on the item actually getting done there, same as any other required item.) This module makes the state available; the Streak module (written separately) owns the qualifying-day computation itself.

**FR-5 — No effect on Family Events.** Family Events never appear as eligible targets for either operation — they're never required or completable (§2.7).

**FR-6 — No reward earn from either action.** Neither Reschedule nor Waive triggers a Reward Ledger entry. Only actual completion (Module 4) earns.

## 5. Validation rules

| Rule | Detail |
|---|---|
| PIN | Must match the device's parent PIN before either operation is applied; wrong PIN blocks the action with no partial effect. |
| Reschedule date | Must be device-local today or later (§2.2). No upper bound applied by this module. |
| Eligible targets | Only required, not-yet-complete, not-yet-waived Activities or Chores (§2.1). Completed items, waived items, and Family Events are never eligible. |
| Waive | Irreversible through this module — no un-waive action specified. |

## 6. Permissions

**PIN required for both operations** — one of the Domain Model's three PIN-gated actions (§3.6b, alongside reward spend and Settings entry — Domain Model §3.2), reusing the PIN established in Startup Wizard (Module 1).

## 7. Inputs / Outputs

**Inputs:** the target item (Activity or Chore) from the Daily Planner's entry point; parent PIN entry; for Reschedule, a new date.

**Outputs (written to device storage):**
- **Reschedule:** the target item's due date field is updated in place. No Activity Record is created.
- **Waive:** a new Activity Record is created with `status: 'waived'`. The item no longer appears as a pending required item on the Daily Planner.
- Neither operation touches the Reward Ledger, Received Packet content for other items, or Semester/Child/Theme data.

## 8. Acceptance criteria

1. Neither Reschedule nor Waive can be triggered without the correct parent PIN.
2. Rescheduling a required item to a valid future date removes it from its original date's due list and adds it to the new date's due list, still marked required and pending.
3. A day whose only shortfall was a rescheduled-away item still qualifies for the streak.
4. Waiving a required item removes it from the Daily Planner's pending list entirely and creates an Activity Record with `status: 'waived'`.
5. A day whose only shortfall was a waived item still qualifies for the streak.
6. Neither action ever appears as available on a Family Event.
7. Neither action creates a Reward Ledger entry.
8. Attempting to reschedule an item to a date before today is rejected.
