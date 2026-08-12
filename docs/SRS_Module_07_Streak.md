# Software Requirements Specification — Child App
## Module 7: Streak

*Written against Domain Model §3.8 (primary source — qualifying rule, gap catch-up, and day boundary are already fully locked there) and Architecture Evaluation §11 guardrail 19.*

---

## 1. Purpose

Maintains a live counter of consecutive qualifying days, independent of whether the Activity Records behind any given day still exist. This module owns the counter's computation exclusively; other modules (Reward Economy's completion-count visual, Module 6; potentially the Daily Planner) may read and display it, but none of them increment or reset it.

## 2. Definitions

- **Qualifying day:** a device-local date that had required Activities/Chores due to it, and all of them ended that day either **complete** or **waived** (Module 5). A day rescued by rescheduling every required item away also qualifies, since nothing required-and-undone remains on it (Module 5, FR-4).
- **Neutral day:** a device-local date with no required items due at all. Neither extends nor breaks the streak.
- **Breaking day:** a device-local date that had required items due, and at least one was neither completed, waived, nor rescheduled away by the time the app next reconciles it.

## 3. User stories

- As a child, I want my streak to go up the moment I finish everything required for today, not after some delay.
- As a parent, I want the streak to be honest — if my child ignores the app for a week and skips required work, the streak should reflect that once they come back.
- As a child, I want a day with nothing required on it (like a weekend) to never cost me my streak.
- As a child, if I undo something I completed by mistake, I don't want to keep credit for a streak day I didn't actually finish.

## 4. Functional requirements

**FR-1 — Live increment on same-day qualification.** The moment today's required items all become resolved (complete or waived) while the app is open, and today is not already recorded as the current `lastQualifyingDate`, `currentStreak` increments by 1 and `lastQualifyingDate` is set to today. This happens live, in-session — the child doesn't have to wait until the next app open to see it reflected.

**FR-2 — Neutral days never trigger a change.** A day with no required items due never increments or breaks the streak, regardless of whether the app was opened that day.

**FR-3 — Gap catch-up reconciliation, on every app open.** The app walks device-local dates from the day after `lastQualifyingDate` up to (not including) today:
- A neutral date in that range is skipped — no effect.
- A non-neutral date that was already fully resolved (per FR-1, this would only happen if the app was open and the last item was completed that same day) is treated as already accounted for.
- A non-neutral date left unresolved is a **breaking day** — `currentStreak` resets to **0**.

This reconciliation is what makes the "live counter" honest — it's the only reason a week of ignoring the app can't be mistaken for an unbroken streak.

**FR-4 — Today itself is only ever evaluated as a breaking day in retrospect.** Today can't be judged a "breaking day" while it's still today — that judgment only happens once it's in the past, during a future FR-3 reconciliation pass.

**FR-5 — Persistence and wipe exemption.** `currentStreak` and `lastQualifyingDate` persist indefinitely, exempt from the wipe (Module 9, written separately) and from semester re-scoping — one of the three named bounded exceptions to "the child app is dumb" (Architecture Evaluation §11, guardrail 19).

**FR-6 — Device-local day boundary, no timezone modeling.** A child adjusting the device clock could manipulate the streak. This is accepted as low-stakes for a reward toy (§3.8) — not something to "fix" later without a deliberate decision to revisit it.

**FR-7 — Sole owner of live computation.** No module other than this one writes `currentStreak` or `lastQualifyingDate` as part of ordinary, automatic play — the one sanctioned manual exception is the parent-PIN-gated repair form in Settings (Module 11, new FR), which may set both fields together for recovery or correction. Modules that display the streak (Module 6, and potentially the Daily Planner) read it only. This module still owns FR-1 through FR-6 (live increment, neutral days, gap catch-up, day boundary) unconditionally — the repair form never runs reconciliation logic, it only writes the two stored values. FR-8's reversal is likewise triggered from outside this module (Module 4's Undo) but, like every other write, goes through this module's own function — the invariant this FR states is preserved, not bypassed.

**FR-8 — Live reversal of a same-day advance ("Undo").** Added for the Child Feedback Loop slice (TDS_Slice_Child_Feedback_Loop.md §3.4), which introduces Undo: un-completing an item Module 4 previously marked done. Because FR-1 already caps the live path at one advance per device-local day ("already counted today" — no second advance to unwind can exist within that day), a reversal needs to walk back at most the one advance the day made.

The reversal function writes only when **both** hold:
- `lastQualifyingDate` equals today (today was the day most recently counted), **and**
- today's `dayStatus` (§ this module's own computation) is no longer `'resolved'` (today no longer qualifies, because the item just undone was required for it).

Undoing a non-required item, or a required one on a day that is still fully resolved by its other items, correctly writes nothing — neither changes whether today qualified.

When it does write, it **restores the exact record the advance replaced** — `currentStreak`, `lastQualifyingDate`, and `longestStreak` together — rather than decrementing. `lastQualifyingDate - 1 day` is not a safe substitute: FR-3's gap catch-up walk can carry `lastQualifyingDate` forward across an arbitrary run of neutral days (a school holiday, a weekend), so the day to return to is whatever it actually was immediately before the advance, not "yesterday." The value is therefore snapshotted at the moment of the live advance (FR-1) and consumed, once, by this FR — see §7's `priorStreak` output. `longestStreak` is restored verbatim rather than recomputed, so an advance-then-undo cannot leave an inflated high-water mark behind in the one field the Management App's reporting reads and the child cannot see.

This FR is a second, narrower rule alongside FR-1 through FR-4, not a replacement for any of them: it is the only case in which this module writes on a day whose `dayStatus` is `'breaking'`, and it does so precisely because that day was, until the moment of the Undo, the day FR-1 had already counted.

**FR-9 — Reversal caller.** FR-8 is called by Module 4's `Completion.undoItem`, in the same action as that feature's reward clawback — never on its own. This module exposes the function; Module 4 decides when un-completing an item warrants calling it. This mirrors FR-1's own relationship to Module 4's `completeItem` (this module reacts to a trigger from Module 4; it does not watch for completions on its own).

## 5. Validation rules

| Rule | Detail |
|---|---|
| `currentStreak` | Integer, always ≥ 0. |
| `lastQualifyingDate` | A valid device-local date, or absent/null if no day has ever qualified yet. |
| Reconciliation ordering | FR-3's walk must process dates in order and stop at the first breaking day found — a break resets to 0 regardless of how many further dates in the range would also have broken it. |
| `priorStreak` (FR-8) | Present only immediately after a live same-day advance (FR-1); one level deep (never a record that itself carries a `priorStreak`); cleared the moment it is either consumed by FR-8's restore or superseded by any other write (a gap-catch-up reset, FR-3, or a manual repair, Module 11) — none of which are advances, so none of them leave anything for a later Undo to walk back to. |

## 6. Permissions

No PIN, and no manual control **from within this module** — there is no child- or parent-facing way to directly edit, reset, or "fix" the streak through Module 7's own UI. The sole exceptions are the parent-PIN-gated repair form in Settings (Module 11), which may set `currentStreak` and `lastQualifyingDate` together for recovery after data loss or a device switch (Domain Model §3.8, §5.9), framed in-UI as recovery/repair rather than a general editor; and FR-8/FR-9's reversal, which needs no PIN because it only ever restores what a same-day advance itself just wrote (Child Feedback Loop TDS §0.1 — the no-PIN decision holds only while both the reward clawback and this reversal stay intact).

## 7. Inputs / Outputs

**Inputs:** Activity Record completion state, Received Packet required-item due dates, Deferment/Waive state (Module 5 — waived and rescheduled-away items), device-local current date. FR-8 additionally reads its own `priorStreak` output (below) at the moment of a reversal.

**Outputs (written to device storage):** `currentStreak` (integer), `lastQualifyingDate` (date), and `priorStreak` (FR-8 — an object holding the same two fields plus `longestStreak`, one level of history, local-only). `priorStreak` is never uploaded: the Online Revamp's §3.5 server row and the outbox's `buildStreakOp` both name only `currentStreak`, `longestStreak`, and `lastQualifiedDate` on the wire, so a device that never runs FR-8 uploads exactly as it always has.

## 8. Acceptance criteria

1. Completing the last required item for today, while the app is open, increments the streak immediately — visible in the same session, no app restart needed.
2. A day with zero required items never changes the streak, whether or not the app was opened that day.
3. Reopening the app after several days away resets the streak to 0 if any intervening non-neutral day was left with required-and-undone work; leaves it unchanged if every intervening non-neutral day was resolved or every intervening day was neutral.
4. The streak value is unaffected by a wipe or a semester re-scoping.
5. A day where every required item was waived or rescheduled away (Module 5) still qualifies and can increment the streak.
6. No manual control inside this module's own UI lets the child or parent directly set `currentStreak` or `lastQualifyingDate`. The sole exception — the parent-PIN-gated repair form in Settings (Module 11) — is out of this module's scope and is verified under Module 11's own acceptance criteria instead.
7. Un-completing the single required item that made today qualify, immediately after completing it, restores the streak to exactly what it was beforehand — same `currentStreak`, same `lastQualifyingDate`, same `longestStreak` — not merely `currentStreak` minus one.
8. Un-completing an item that did not itself make today qualify (another required item is still unresolved, or today was not the day most recently counted) leaves the streak untouched.
9. After an Undo, reconciliation on the next app open treats today on its own merits: if the undone item is completed again before the day rolls over, today still counts as resolved; if it is left undone, the day is judged `'breaking'` at the next open and the streak resets — the same outcome an ordinary breaking day produces, with no special case for having once been advanced and undone.
