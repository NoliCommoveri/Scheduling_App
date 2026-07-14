# Software Requirements Specification — Child App
## Module 9: Wipe


*Written against Domain Model §3.6a (primary source), §3.6 (Activity Record, including `exported`). The trigger is a child-side button, placed alongside the Completion CSV Export action (Module 8) rather than on the main daily view — export and wipe form one small routine the child owns without it being reachable during ordinary daily work.*

---

## 1. Purpose

Keeps the child device's storage bounded by clearing historical data that's no longer needed, without ever destroying an obligation that's still outstanding. This module owns *what gets cleared and what's protected*, and the wipe's access point.

## 2. Scope notes

**2.1 — Family Event clearing.** §3.6a's clearing rule ("completed/exported Activity Records, and fully-consumed Received Packet content") maps cleanly onto Activities and Chores via Module 8's resolved-and-exported gate, but Family Events have no Activity Record and are never completable — that gate can't apply to them. A Family Event is cleared once its date is in the past (FR-4).

**2.2 — Placement, not just trigger, is part of this module's scope.** A child-side button with no PIN gate is only safe to leave unguarded because of *where* it lives: paired with Export (Module 8) rather than sitting on the Today/daily view. That placement is what keeps the action out of daily-work flow, doing the job a PIN might otherwise have been reached for (see also Settings, Module 11 FR-4, which keeps this access point outside gated Settings for the same reason).

## 3. User stories

- As a parent, I want my child's device to stay light over a school year, without ever losing track of work they still owe.
- As a child, I want my finished work to eventually clear out so my app doesn't get cluttered, once my parent already has it.
- As a parent, I want the Reward Ledger balance and streak to survive a wipe untouched — those are the things my child actually cares about day to day.

## 4. Functional requirements

**FR-1 — Child-side button, paired with Export.** The wipe is invoked by a child-side button reachable from the same area as the Completion CSV Export action (Module 8), not the daily/Today view and not inside gated Settings (Module 11 FR-4).

**FR-2 — Clears fully-resolved, exported Activity Records.** An Activity Record is cleared if and only if its `status` is `complete` or `waived` **and** it has been exported (Module 8's double gate — resolution alone is not enough).

**FR-3 — Clears the paired Received Packet entry.** An Activity or Chore's "as received" entry is cleared together with its Activity Record, as a pair, when FR-2's condition is met — never independently, and never before its record qualifies.

**FR-4 — Clears past Family Events (§2.1).** A Family Event is cleared once its date is before device-local today. A Family Event dated today or in the future is never cleared.

**FR-5 — Preserves still-pending required items, regardless of age.** Any Activity or Chore not yet `complete` or `waived` — including anything merely rescheduled (Module 5) — is never cleared, no matter how old its original due date is. This is the concrete guarantee behind "pending work survives the wipe": timing can never destroy a future obligation (§3.6a).

**FR-6 — Preserves the Reward Ledger snapshot and the Streak, unconditionally.** Both are permanent, bounded exceptions (§3.6a/§3.7/§3.8) — a wipe never touches either, under any circumstance.

**FR-7 — No effect on Child, Semester, or Theme/Settings.** The wipe only ever touches Received Packet content, Activity Records, and (per FR-4) Family Events.

**FR-8 — Confirmation, not a PIN.** Invoking the wipe requires an explicit confirmation step first (a simple "are you sure" check, not the parent PIN) since it's at least locally destructive to historical data, even though nothing outstanding is ever at risk. Placement (FR-1) plus this confirmation are together sufficient — a PIN gate isn't needed on top of them.

## 5. Validation rules

| Rule | Detail |
|---|---|
| Activity/Chore clearing | Requires both resolved (`complete`/`waived`) **and** exported — either alone is insufficient. |
| Family Event clearing | Requires the event's date to be strictly before device-local today. |
| Pending items | Never eligible for clearing, regardless of age or original due date. |
| Reward Ledger / Streak | Never eligible for clearing, unconditionally, by any wipe. |

## 6. Permissions

No PIN. FR-8's plain confirmation step, combined with FR-1's placement outside daily-work flow, is the safeguard — not the parent PIN used elsewhere.

## 7. Inputs / Outputs

**Inputs:** Activity Records (status, exported flag), Received Packet content (as-received items), Family Event dates, device-local current date. Reward Ledger and Streak are read only to confirm they're left untouched — never written by this module.

**Outputs:** deletion of eligible Activity Records and their paired as-received entries (FR-2/FR-3); deletion of past Family Events (FR-4). No writes anywhere else.

## 8. Acceptance criteria

1. A wipe clears every Activity Record that is both resolved and exported, along with its paired as-received entry.
2. A resolved-but-not-yet-exported record survives a wipe completely intact.
3. A still-pending or rescheduled required item survives a wipe, regardless of how old it is.
4. Reward Ledger balances and the Streak's value are byte-for-byte unchanged by a wipe.
5. A past Family Event is cleared; one dated today or later survives.
6. Child, Semester, and Theme/Settings data are entirely unaffected by a wipe.
7. The wipe cannot proceed without an explicit confirmation step, and its button is reachable only from the Export area — never from the daily/Today view or from inside gated Settings.
