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

**FR-7 — Sole owner of live computation.** No module other than this one writes `currentStreak` or `lastQualifyingDate` as part of ordinary, automatic play — the one sanctioned manual exception is the parent-PIN-gated repair form in Settings (Module 11, new FR), which may set both fields together for recovery or correction. Modules that display the streak (Module 6, and potentially the Daily Planner) read it only. This module still owns FR-1 through FR-6 (live increment, neutral days, gap catch-up, day boundary) unconditionally — the repair form never runs reconciliation logic, it only writes the two stored values.

## 5. Validation rules

| Rule | Detail |
|---|---|
| `currentStreak` | Integer, always ≥ 0. |
| `lastQualifyingDate` | A valid device-local date, or absent/null if no day has ever qualified yet. |
| Reconciliation ordering | FR-3's walk must process dates in order and stop at the first breaking day found — a break resets to 0 regardless of how many further dates in the range would also have broken it. |

## 6. Permissions

No PIN, and no manual control **from within this module** — there is no child- or parent-facing way to directly edit, reset, or "fix" the streak through Module 7's own UI. The sole exception lives outside this module: a parent-PIN-gated repair form in Settings (Module 11) may set `currentStreak` and `lastQualifyingDate` together, for recovery after data loss or a device switch (Domain Model §3.8, §5.9). Framed in-UI as recovery/repair, not a general editor.

## 7. Inputs / Outputs

**Inputs:** Activity Record completion state, Received Packet required-item due dates, Deferment/Waive state (Module 5 — waived and rescheduled-away items), device-local current date.

**Outputs (written to device storage):** `currentStreak` (integer), `lastQualifyingDate` (date). Nothing else.

## 8. Acceptance criteria

1. Completing the last required item for today, while the app is open, increments the streak immediately — visible in the same session, no app restart needed.
2. A day with zero required items never changes the streak, whether or not the app was opened that day.
3. Reopening the app after several days away resets the streak to 0 if any intervening non-neutral day was left with required-and-undone work; leaves it unchanged if every intervening non-neutral day was resolved or every intervening day was neutral.
4. The streak value is unaffected by a wipe or a semester re-scoping.
5. A day where every required item was waived or rescheduled away (Module 5) still qualifies and can increment the streak.
6. No manual control inside this module's own UI lets the child or parent directly set `currentStreak` or `lastQualifyingDate`. The sole exception — the parent-PIN-gated repair form in Settings (Module 11) — is out of this module's scope and is verified under Module 11's own acceptance criteria instead.
