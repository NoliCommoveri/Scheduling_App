# Technical Design Specification — Slice

## Scope: Wall Display App — a third, always-on browser app that shows family events to the room and gates each child's chores behind a PIN

> ## ⚠️ Superseded in part (2026-08-14) — read this first
>
> **`docs/TDS_Slice_Wall_Calendar_Redesign.md` is the controlling design for the Wall App.**
> Phases 1–3 of this slice were built; Phase 4a (the PIN pad and the per-child chore list) never
> was, and is now repealed rather than deferred.
>
> Most of this document still holds — the wall token, the roster read live from `children.active`,
> online-required writes, the earn rule, the on-today rule, Undo's two paths, the Fire tablet
> constraints. What is **repealed** is the per-child PIN gate (§0.3, §0.4, §4), the Done Today board
> (§6.7), the 60-second poll cadence (§5.2), and the exclusion of activity rows from the read path
> (§5.1). What is **replaced** is the ambient screen, which becomes a day/week/month calendar.
>
> **`TDS_Slice_Wall_Calendar_Redesign.md` §1.2 is the authoritative map** of what in here survives,
> what is repealed, and what is replaced. Read it before building from any section below.

**Status:** Phases 1–3 landed. Phase 4a repealed, 4b and 5 superseded — see the banner above.
**Date:** 2026-08-13. **Revised 2026-08-13** after review — see §17 for what changed and why.
**Depends on:** `TDS_Slice_Online_Revamp.md` (controlling design), `TDS_Slice_Shared_Chores.md` (claim arbitration), `TDS_Slice_Alexa_Voice_Bridge.md` (§9 here is written to keep that slice buildable).
**Amends:** `CLAUDE.md` §0/§I.A/§I.B/§III.A/§III.E/§VII → v2.2 (§16). `docs/Roadmap_Schedule_App.md` §0.

---

## 0. Decisions made in this slice

All five were put to Ray in-session on 2026-08-13 and answered; they are recorded here as
`[DECISION]` blocks in §3–§7 rather than re-argued.

1. **One household-scoped wall credential — no per-child pairing.** The wall is paired **once, as
   a device**: a pair code minted in Management App → Devices, typed into the wall's first-run
   wizard, redeems for a `devices` row carrying **no `child_id`** and `scope = 'wall'`. From then
   on the wall reads the active-child roster straight from D1, and every child authored in the
   Management App appears automatically — nothing to pair, nothing to re-pair. The parent token
   never touches it (`CLAUDE.md` §0), and the whole wall is revoked in one click from the Devices
   UI that already exists.

   This **reverses the 2026-08-13 draft**, which held one ordinary device token per child. That
   design made the wall's child list a second copy of a fact D1 already records, and made adding a
   child a two-device ceremony. The requirement is the opposite — *all active children, period* —
   and `children.active` already records exactly that (`migrations/0001:21-26`, maintained live on
   every parent push at `index.js:557-600`, and driven by the Management App's Archive button,
   `children.js:80`). The cost is real and is paid in §8: `child_id` can no longer be derived from
   the token, so the wall gets its own small route family in which the child is named in the
   request and the credential is what authorizes acting for any active child.

2. **Completions from the wall credit rewards.** The wall posts a `reward_entries` row exactly as
   the Child App does — `amount = reward_amount ?? 1`, `category = reward_category`, both read off
   the assignment row's own snapshot. This is option **(a)** of the three the Alexa slice §6.3 left
   open, decided here for the wall and recommended there (§9.2). A tick is a tick; where the child
   was standing when they made it is not a thing the ledger should have an opinion about.

3. **PINs live on the tablet, not in D1.** Set by the parent in wall Settings, stored
   salted-and-hashed in the wall tablet's `localStorage`, keyed by `child_id`. No schema change for
   the PIN itself. The threat model is a sibling reaching for the wrong tile, not an attacker; §4.4
   states plainly what this does and does not protect. A child who appears on the roster with no
   PIN yet is shown but not openable (§4.6) — a roster that grows on its own must not open a hole
   on its own.

4. **The ambient screen shows today's events in full, plus a progress count per child.**
   **Pending** chore titles stay behind the PIN; "Ellie · 3 of 5" does not. A wall that shows
   nothing until someone authenticates is a clock with extra steps.

   *Amended 2026-08-13:* **completed** chore titles also appear ungated, on the Done Today board
   (§6.7). A pending list is a child's workload and a sibling's ammunition; a finished list is the
   household's record of a day, which is the thing a wall display exists to show.

5. **Shared (`claim_group`) chores are claimable from the wall.** Behind the PIN the wall knows
   exactly which child is tapping, so it calls `POST /api/wall/assignments/:id/claim` naming that
   child and gets the server's arbitration, same as the Child App. This is a deliberate departure
   from the Alexa slice §6.4, which refuses shared chores — that refusal is about *voice not
   knowing who is asking in a way that can settle a race*, not about the route being unsuitable.
   The wall does not have that problem: the PIN gate is what settles who is asking, and it settles
   it before the request is made.

6. **One migration, one new credential scope, five new routes.** §8 is where this slice's real
   work now lives, and it is no longer empty. The 2026-08-13 draft's "purely additive to the API"
   claim died with per-child pairing (§0.1), and the §13 phase table has grown a Worker phase to
   match.

---

## 1. Why a slice, not a full TDS

The wall app introduces **one migration, one credential class, and one route family** (§8), and no
change at all to column ownership or to the two existing apps. That is more than the first draft of
this document claimed and still small enough not to need a full TDS: the schema change is a single
`ALTER TABLE ... ADD COLUMN`, the routes are the existing handlers with `child_id` resolved from a
validated parameter instead of a token, and the field maps that decide what may be written are
reused verbatim rather than restated.

What is genuinely new is a *composition*: one household credential, a roster read live from D1, a
PIN gate in front of each child, and a rendering surface designed to be looked at from six feet
away.

It is a third app rather than a Child App mode because `CLAUDE.md` §I.A's isolation rule cuts that
way: the Child App is a single child's device, owns an IndexedDB cache and an outbox, and assumes
one identity for its whole lifetime. Teaching it to hold every identity, drop its outbox, and grow
an ambient mode would be a rewrite of its core assumptions wearing a feature's clothes. A separate
folder with no shared runtime code is both cheaper and what the guardrails require.

---

## 2. Architecture

```
   Fire tablet on the wall, always on, house wifi
   ┌──────────────────────────────────────────────┐
   │  wall-app/  — vanilla JS, no build step        │
   │  localStorage:  wallToken   (ONE, household)   │
   │                 [{childId, pinSalt, pinHash}]  │
   │  no IndexedDB · no outbox · no packet          │
   └───────────────┬──────────────────────────────┘
                   │  one wall token; the child is named per request
                   │  GET  /api/wall/children              (roster)
                   │  GET  /api/wall/plan?childId=          (read)
                   │  POST /api/wall/completions            (write)
                   │  POST /api/wall/rewards/entries
                   │  POST/DELETE /api/wall/assignments/:id/claim
                   ▼
   ┌──────────────────────────────────────────────┐
   │  Cloudflare Worker — same script, same D1      │
   │  D1 `scheduling-app` = SYSTEM OF RECORD        │
   └──────────────────────────────────────────────┘
        ▲                ▲                    ▲
   Management App    Child App         (later) Alexa — §9
```

The wall is a **fourth arrow into the same Worker** — and, unlike the 2026-08-13 draft claimed, a
new arrow shape: a credential that is household-scoped like the parent's but routed like a
device's. That is the same idea the Alexa slice §3 arrived at independently, which is why §9 now
argues the two should share one mechanism rather than avoid each other.

---

## 3. The credential, storage, and the roster

### 3.1 The credential model

```
[DECISION] Wall credential
Decided: ONE household-scoped wall token, minted by a pair code and stored as a
  `devices` row with child_id NULL and scope 'wall'. The Worker restricts it to
  the five /api/wall/* routes of §8 and nothing else. It is not SYNC_TOKEN and
  it is not a device token.
Rationale: the requirement is "all active children from D1, period" (Ray,
  2026-08-13). A per-child token cannot express that — it names one child by
  construction, so the roster would have to be assembled by pairing each child
  in turn, which is a local copy of a fact D1 already holds and a ceremony
  repeated every time a child is added. Reading `children WHERE active = 1`
  needs a credential that is not scoped to a child, and once the credential is
  not scoped to a child, every downstream call has to name one.
  NOT SYNC_TOKEN: `CLAUDE.md` §0 says the parent token never goes on a child
  device, and a tablet on the kitchen wall is a child device by any reading —
  it would carry whole-database scope and every parent route into a shared
  room. A separately-minted credential with a five-route allowlist costs almost
  nothing and keeps that non-negotiable intact.
NOT A WORKER SECRET EITHER: the wall token is minted at runtime by redeeming a
  pair code, exactly as a child device token is, and is stored hashed in
  `devices`. There is NOTHING for Ray to set in the Cloudflare dashboard for
  this app, and no value to type anywhere except the 8-character pair code on
  the tablet once. A `WALL_TOKEN` dashboard secret was considered and rejected:
  it cannot be revoked without a dashboard visit AND a re-type on the tablet,
  where a minted device row is revoked with one click in a UI that exists.
Consequence: `child_id` comes from the request, not the token, on the wall
  routes only. This is a genuine narrowing of Online Revamp §4.2. It is
  contained by the route family: the wall routes are the only ones that accept
  a wall token, and the device routes are unchanged, so the Child App's
  guarantee is untouched.
Signed off: Ray, in-session 2026-08-13. Carried into CLAUDE.md 2.2 §III.E,
  which states the four bounds (§8.3) a wall route may not drop.
Locked for: this slice.
```

**What this credential may do is bounded by the routes, not by trust.** Column-level ownership —
the load-bearing rule of `CLAUDE.md` §0 — is enforced by the handler, exactly as it is for a device
token: the wall's completion route writes `status`, `completed_at`, `grade` and `completion_note`
and nothing else, and its reward route appends to `reward_entries` and nothing else. A
household-scoped credential widens *which child* may be acted for. It must never widen *what may be
written*, and §8.3 states the check that keeps it honest.

### 3.2 Pairing the wall — once, as a device

1. Management App → Devices → **Pair wall display** → a code, same 8-character Crockford alphabet
   and same 15-minute TTL as a child pair code (`PAIR_CODE_TTL_MS`, `index.js:31`).
2. Wall first-run wizard → type the code → `POST /api/wall/pair` → `{ token }`.
3. Stored in `localStorage` as `wall.token`. The wall sets its own `devices.label` on redemption
   (`Wall display`) — the label travels in the pair request body, as `handlePair` already accepts
   it (`index.js:1119`) and the Management App's mint form does not send one (`devices.js:140-168`).

That is the entire setup. There is no per-child step, and adding a child later is a Management App
action with no wall-side counterpart at all.

**Revocation** is the existing Devices UI, one row, one click. A revoked wall token 401s on every
route; the wall shows a single **"This display has been unpaired"** screen with the first-run
wizard behind it, and the parent re-pairs with a new code. There is no partial state to reason
about — the 2026-08-13 draft's per-tile "needs re-pairing" degradation (its §3.4) is deleted along
with the per-child tokens that made it necessary.

### 3.3 The roster

`GET /api/wall/children` → `{ children: [{ id, name }] }`, from
`SELECT id, name FROM children WHERE active = 1 ORDER BY name`. Polled on the §5.2 cadence
alongside the plan.

- A child **archived** in the Management App (`children.js:80` writes `active: false`) disappears
  from the wall within one poll. Their PIN row is kept in `localStorage`, not deleted, so
  un-archiving restores the tile with the PIN intact.
- A child **added** in the Management App appears within one poll, PIN-less, per §4.6.
- `name` is the server's, and the wall renders it verbatim. **There are no local nicknames.** The
  2026-08-13 draft had them; they are dropped, because a roster whose whole point is to be D1's
  answer should not carry a second, local naming authority. This also keeps §9.4's property —
  Alexa resolves children by `children.name`, and now so does the wall, so the two surfaces cannot
  drift.

### 3.4 What lives on the tablet

`localStorage` only. No IndexedDB, no service-worker-cached API responses, no outbox.

```js
// wall.token — the one household-scoped bearer credential
"…"

// wall.pins — keyed by child_id, never a name; survives archive/un-archive
[{ childId, pinSalt, pinHash, failCount, lockedUntil }]

// wall.settings
{ adminPinSalt, adminPinHash, dimStartHour, dimEndHour, shellVersion }

// wall.pendingEarns — §6.2's narrow retry queue, reward entries only
[{ id, childId, assignmentId, category, amount, reason, earnedAt, attempts }]
```

`wall.token` is a bearer credential in plain text, as the Child App's is in its `syncMeta`
singleton. The difference worth naming: this one acts for **every** active child rather than one,
so the blast radius of the tablet itself is larger than a child tablet's even though the storage
exposure is identical. What keeps that bounded is §3.1's route allowlist — the token cannot read
curriculum, cannot list devices, cannot mint a pair code, and cannot write a parent-owned column.
§4.4 is honest about the rest.

---

## 4. The PIN gate and the session

### 4.1 Flow

Ambient → tap a child tile → PIN pad (4 digits, large keys) → that child's chore list → idle 5
minutes, or **Done**, → ambient.

### 4.2 The five minutes

```
[DECISION] Session expiry
Decided: five minutes of *inactivity*, not five minutes absolute. Any touch,
  tap, or key inside the app resets the timer. A "Done" button ends the session
  immediately, and is the primary exit.
Rationale: "log them out after 5 mins" reads two ways. Absolute would kick a
  child out mid-list while they are actively working through eight chores,
  which turns the gate into an obstacle to the thing it is gating. Idle
  achieves what the requirement is for — nobody walks away leaving their
  chores open to a sibling — without that.
Consequence: a child who keeps tapping stays signed in indefinitely. Acceptable:
  they are standing at the tablet, which is the condition the gate is about.
Locked for: this slice; revisit only if it proves wrong in the room.
```

A one-line signed-in bar shows `Ellie · Done`, plus a subtle countdown in the last 30 seconds so
the return to ambient is never a surprise. Session state is in memory only — a reload signs out.

### 4.3 Wrong PINs

Five consecutive wrong entries for one child → that tile is locked for 60 seconds, with the
remaining time shown. The counter is per child (`wall.pins[].failCount` / `lockedUntil`, §3.4),
resets on success, and persists in `localStorage` so closing and reopening the browser does not
clear a lockout. No lockout escalation beyond 60s: this is a sibling deterrent, and a child who
waits a minute five times is not the failure mode being designed against.

### 4.4 What the PIN actually protects — stated plainly

It stops a sibling tapping the wrong tile and ticking off someone else's chores. It does **not**
protect against anyone who picks the tablet up and opens developer tools: the wall token is in
`localStorage` in plain text, and the PIN hash is salted SHA-256 over a 4-digit space, which is
brute-forceable in milliseconds by anyone who has already got that far. Both facts are true of the
Child App today, with one difference this design should not hide — the wall's token acts for every
active child, so extracting it is worth more than extracting a child tablet's. What bounds that is
§3.1's route allowlist and one-click revocation, not the PIN.

Neither fact is a reason to build a heavier gate on a wall tablet in a family kitchen. Both are
reasons not to describe this as security in any document or UI string.

### 4.5 The admin gate

Settings — set or reset a child's PIN, re-pair the display, change dim hours, force a shell reload
— sits behind a **separate admin PIN**, set during first run. Otherwise the child who wanted out of
chores would simply clear their own PIN. First run with no wall token and no admin PIN opens a
two-step wizard: set admin PIN → pair the display (§3.2). There is no third step; the roster
arrives on its own.

### 4.6 A child on the roster with no PIN

A child added in the Management App appears on the wall within one poll, and the wall has never
been told a PIN for them. That tile renders normally in the ambient view — name and `n of m`, so
the family screen is complete the moment the child exists — but tapping it says **"Ask a parent to
set a PIN"** and opens nothing.

The alternative, opening a PIN-less tile freely until someone sets one, was rejected: it makes the
gate silently absent exactly when nobody is looking for it, and a roster that grows by itself would
then open holes by itself. The parent sets the PIN in Settings behind the admin PIN, once, and
adding a child is rare enough that the extra step costs nothing.

---

## 5. The read path

### 5.1 What is fetched

`GET /api/wall/children` for the roster (§3.3), then per active child
`GET /api/wall/plan?childId=<id>&from=<today-7>&to=<today+6>`, all with the one wall token. The
response is the same body `/api/plan` returns: `{ assignments, from, to, truncated?, limit? }`
(`capRows`, `validation.js:163`) — the key is `assignments`, not `rows`.

From the returned rows the wall uses **only**:

| Rows | Used for |
|---|---|
| `kind='chore'`, **on today** (§5.1.1), `status='pending'`, `rescinded_at IS NULL` | that child's chore list, and the `n` of their `n of m` |
| `kind='chore'`, **on today**, `status='complete'` | the `m` denominator, and the undoable set (§6.5) |
| `kind='event'`, any date in range | the shared events strip (§7) — unioned across children |
| `kind='activity'` | **ignored entirely.** School work is not this app's business. |

A `claimed_by` that is neither `NULL` nor this child renders as claimed-by-a-sibling and is not
tappable (mirroring `assignment-core.js:85-88`, re-implemented — not shared, per §I.A).

#### 5.1.1 "On today" is not `date = today`

The 2026-08-13 draft said `date = today`. That is not what today means in this codebase, and
building it would have put two screens in one house into visible disagreement. `planner-core.js`
decides day membership with two rules, and the wall mirrors **both**:

- **Deferment.** `effectiveDueDate(row) = row.deferred_to || row.date` (`planner-core.js:48`). A
  chore the child rescheduled to tomorrow on their own tablet still has `date = today` and
  `status = 'pending'`, so `date = today` would keep showing it on the wall — and let a sibling
  tick a chore that has already been moved. The wall reads `deferred_to` even though §6.6 forbids
  it from ever *writing* one.
- **Overdue roll-forward.** `onToday` (`planner-core.js:154`) also keeps any still-pending
  *required* chore whose effective date is in the past, and chores are always required
  (`assignment-core.js:120` — absent reads as `true`). So yesterday's un-done bins appear on the
  child's tablet today. Under `date = today` they would never appear on the wall, and the tile's
  `n of m` would contradict the tablet standing next to it.

This is why §5.1's window reaches **backward** seven days rather than starting at today: a
roll-forward rule cannot roll forward rows that were never fetched. It matches the Child App's own
window (`plan-sync.js:33`), for the same reason.

`chores-core.js` (§11) owns both rules and carries a comment naming `planner-core.js:48` and `:154`
as what it mirrors — the same discipline §11 already requires for the event key and the
plannability rule.

### 5.2 Polling cadence, and why not `/api/plan/version`

```
[DECISION] Poll shape
Decided: poll GET /api/wall/plan with a bounded date window and `since=<max
  updated_at seen>`, every 60s between 06:00 and 22:00 local, every 15 minutes
  overnight, plus immediately after any write and on day rollover. The roster
  (GET /api/wall/children) rides the same tick. Do NOT poll /api/plan/version
  or add a wall equivalent of it.
Rationale: /api/plan/version runs COUNT(*) and MAX(updated_at) over *every* row
  a child has ever had (index.js:1175) — no date bound, no index to narrow it.
  A child with a semester committed is a few thousand rows, and 1,440 polls a
  day each scanning them is millions of row reads per child per day, against a
  D1 free-tier allowance in the single-digit millions. The plan query with a
  14-day window rides idx_assign_child_date and touches tens of rows.
  Free tier is a LOCKED constraint (CLAUDE.md §0), so the cheap-looking route
  is the expensive one here.
Consequence: the first fetch of a session is a full window; every later poll is
  incremental and merged by id into an in-memory day map (§5.2.1).
Locked for: this slice. The arithmetic assumes the free-tier allowance
  documented at build time — re-check it against Cloudflare's current limits
  during Phase 2 rather than trusting this paragraph.
```

**The watermark is `max(updated_at)` over rows actually received**, not a separately-read version
number. That is safe here for the reason the Child App needs `/api/plan/version` to be careful
about (`plan-sync.js:116-121`): anything written after the response was assembled necessarily
carries a higher `updated_at` than any row in it, so the next poll picks it up. A `since` delta is
only sound while the window is unchanged, so a moved window forces a full fetch — which is once a
day, on rollover (§5.3), exactly as `plan-sync.js:135-139` reasons.

**Cost, counted honestly.** Every wall request also writes a row: `withDevice` updates
`devices.last_seen_at` through `waitUntil` (`index.js:288`), and the wall routes inherit that. At
four children the poll is five requests a tick (roster + four plans), ≈ 5,000 requests and ≈ 5,000
D1 row writes a day, against free-tier allowances of 100,000 Workers requests and 100,000 D1 row
writes. Comfortable — but the whole §5.2 decision rests on arithmetic, so the write side belongs in
it rather than being left implied by a read-only analysis.

#### 5.2.1 What the merge keeps

The in-memory structure is a **day map of every row in the window**, keyed by assignment id, and a
`since` response patches it in place. It is *not* a list of pending chores:

- A row that comes back `complete` **stays in the map.** It is the `m` in `n of m`, and it is the
  entire input to Undo (§6.5). It is removed from the *pending list* and from nothing else.
- A row that comes back `rescinded_at != NULL`, or `claimed_by` set to another child, is dropped
  from the map outright — it is neither actionable nor countable.
- Rows outside the window after a rollover are dropped by the full fetch that rollover triggers.

The 2026-08-13 draft said complete rows were "dropped from the live view", which contradicted its
own §5.1 (complete rows are the denominator and the undoable set) and would have made §6.5
unbuildable. Stated here once so the two sections cannot disagree again.

### 5.3 Day rollover

An always-on page must not still be showing Tuesday on Wednesday morning. A timer set for the next
local midnight (recomputed after each fire, so DST cannot drift it) clears the in-memory cache,
recomputes `today`, and does a full fetch. This is `Roadmap §0`'s still-open Child App item §11.9,
answered here for the app that actually cannot avoid it.

### 5.4 Losing the network

Reads simply fail and the last render stays up, with a small `Last updated 14:32` stamp that turns
amber past ten minutes stale. Nothing is queued, nothing is cleared, and no modal appears — a wall
display that throws up an error dialog nobody dismisses is worse than a slightly stale one. Writes
behave differently; see §6.4.

---

## 6. The write path

The wall writes exactly three things: a completion, its earn entry, and — for shared chores — a
claim. It writes nothing else, ever (§6.6).

### 6.1 An ordinary chore

`POST /api/wall/completions`, one row, with `X-Outbox-Protocol: 2` so the §11.7 `deferred` shape is
understood rather than met as a 503. The child is named in the body, and the Worker checks the row
belongs to them (§8.3):

```json
{ "childId": "<child id>",
  "completions": [ { "id": "<assignment id>", "status": "complete", "completedAt": 1755100000000 } ] }
```

`completedAt` is the moment of the tap, from the tablet's clock. It lands in
`assignments.completed_at` (`migrations/0001:54`), which the Management App already reports —
both in the CSV export (`reporting.js:175`) and on screen (`reporting.js:431`). A chore ticked at
the wall therefore carries the time it was actually done, with no new column and no new work.

`applied: 1` → tick it. A `rejected` row → show the server's message and refresh that child's
window. A `deferred` row → "Couldn't save that — try again in a moment", and **nothing is
queued**: see §6.4.

Immediately before the write, the wall re-polls that child's today window (a `since=` call, tens of
rows) and refuses to complete a row that is no longer `pending`. This is what keeps a chore already
ticked on the child's own tablet from being credited twice.

### 6.2 The earn entry — the Alexa §6.3 gap, answered for the wall

The **earn rule**, stated once here so that every surface that implements it cites one sentence:

> A completion credits one `reward_entries` row: `amount` = the assignment row's snapshotted
> `reward_amount`, or `1` when that is `NULL`; `category` = the row's `reward_category`;
> `assignment_id` = the row; `reason = 'earned'`; `earned_at` = the moment of the tap.

That is exactly what `completion-core.js:113` does today, restated as a rule rather than borrowed
as code. It is snapshot-based by design (Online Revamp §7): a tier edited next month never changes
what was already earned.

`POST /api/wall/rewards/entries` follows the completion, with a client-minted UUID `id` — the
server's `ON CONFLICT (id) DO NOTHING` (`index.js:1489`) makes a replay free.

**`reward_category` can be `NULL`, and the route rejects that.** The earn rule gives `reward_amount`
a `?? 1` fallback and gave `category` none, but `packet.js:541` sets
`rewardCategory: session.maps.rewardCat.get(c.difficultyTier)` — `undefined` for a chore with no
difficulty tier or an unmapped one — and `handleRewardEntries` answers a categoryless entry with a
permanent `rejected` (`index.js:1467`). So the rule needs its missing clause:

> A chore whose `reward_category` is `NULL` **credits nothing, and says so**: the completion still
> lands, and the row ticks with a small "no reward set" marker. The wall does not invent a
> category.

Inventing one would file earnings under a category the parent never created and cannot see in the
reward UI, which is worse than visibly crediting nothing. The marker is what makes it a fixable
authoring gap rather than a silent short-payment.

**Ordering, and the only queue in the app.** The completion goes first; the earn follows. If the
earn fails after the completion landed, the child is short and the wall must not forget. So:
reward entries — *and only reward entries* — get a small persisted retry list
(`wall.pendingEarns`), drained on the next poll. This is safe precisely because the entry is
idempotent on its client-minted id, so a retry that was actually delivered the first time is a
no-op. Completions get no such list, deliberately: the tick either happened or it did not, and a
completion that lands ten minutes later from a device nobody is standing at is a worse outcome than
an honest "try again".

**The queue must distinguish the route's three answers**, or it is not a queue but a loop. This
display runs for months unattended, so a permanently-failing row retried every 60 seconds forever
is a real outcome, not a hypothetical:

| Answer | Meaning | `wall.pendingEarns` |
|---|---|---|
| `applied` | landed (or was already there) | remove |
| `rejected` | permanent — malformed, no category, bad amount | **remove**, and surface it in Settings as a failed earn with its id and reason |
| `deferred` | transient — a database fault (§11.7) | keep, retry next poll |
| network error / 5xx | transient | keep, retry next poll |

`rejected` is `outbox.js`'s discard class too (`outbox.js:181`), for the same reason: a row that
will never work is not made more likely to work by asking again. Surfacing it rather than dropping
it silently is the difference that matters in an append-only ledger — the parent can write the
compensating entry with `POST /api/rewards/adjust`.

**Residual risk, named:** a chore ticked *simultaneously* on the wall and on the child's own tablet
— inside the same poll window, before §6.1's pre-check can see the other — credits twice. That is
the exposure the ledger already carries between any two child devices, the ledger is append-only,
and `POST /api/rewards/adjust` exists. §15.1 works through why the obvious fix (a unique index)
cannot be applied to an append-only table and what the real one looks like.

### 6.3 Shared chores

`POST /api/wall/assignments/:id/claim`, body `{ "childId": "<child id>" }`.

**Send a JSON body, not an empty request.** `handleAssignmentClaim` opens with
`await request.json()` and answers a parse failure with `400 Body must be JSON.`
(`index.js:1326-1330`), so the 2026-08-13 draft's "with an empty body" would have 400'd every
claim. `claim.js:32-38` gets this right today and is the shape to copy: a JSON body and a
`Content-Type: application/json` header.

- `{ claimed: true, assignment }` → tick it, patch the cache from the returned row, post the earn.
- `{ claimed: false }` → **"Talia got there first!"**, cheerful, then the row
  re-renders as claimed. No earn, no local state, nothing to unwind — `handleAssignmentClaim`
  arbitrates the whole group in one statement, so the loser's view is right immediately.

The claim is synchronous by design (`CLAUDE.md` §III.A's narrowed exception, Shared Chores §5.7).
The wall is a mains-powered device on house wifi; this is the surface where that constraint costs
least.

### 6.4 Online-required writes — a declared narrowing

```
[DECISION] The wall does not queue completions
Decided: every write is synchronous. A failure leaves the chore un-ticked, shows
  a message, and the child taps again. No outbox, no IndexedDB, no drain.
Rationale: CLAUDE.md §III.A's "local writes never block on the network" is a
  Child App guarantee, built for a tablet carried around a house on patchy
  wifi and expected to work through a router reboot. The wall is a fixed,
  mains-powered device three metres from the access point, holding no local
  database at all. An outbox on it would buy an edge case its physical
  situation makes rare, and cost a whole subsystem plus a window in which a
  chore ticked at 4pm lands at 4:10pm — after the sibling standing at the same
  tablet has already been told it is theirs to do.
Consequence: this is a genuine narrowing of a LOCKED decision. It applies to the
  wall app only; nothing about the Child App changes.
Signed off: Ray, in-session 2026-08-13. Carried into CLAUDE.md 2.2 §III.A as
  "Narrowed exception 2".
Locked for: this slice.
```

### 6.5 Undo — required, and only the wall can offer it

A mis-tap on a wall tablet is not a hypothetical. It also cannot be fixed anywhere else:

- The **parent cannot** un-complete anything — `status` is child-owned and absent from
  `ASSIGNMENT_PATCH_FIELDS` (`index.js:71`). By design.
- The **Child App cannot**, either: its Undo is gated on a local `activityRecords` row
  (`completion.js:159`), and a wall completion never creates one. The row simply never appears in
  the child's Completed view.

So the wall carries its own Undo, available while that child is signed in, for any of today's rows
the server reports `complete` (§5.2.1 is what keeps those rows in hand). It mirrors the Child App's
reversal shape (`completion.js:157-198`), re-implemented — but the two row classes take **different
paths**, and conflating them was a bug in the 2026-08-13 draft.

**An ordinary chore:**

1. `POST /api/wall/completions` → `{ status: 'pending', completedAt: null, grade: null,
   completionNote: null }` (`'pending'` is in `COMPLETION_STATUSES`, `validation.js:26`).
2. A compensating `reward_entries` row: same category, `-(reward_amount ?? 1)`,
   `reason: 'adjustment'`, same `assignment_id`. **Never a delete** — the ledger is append-only.
   A chore that credited nothing under §6.2's `NULL` category clause reverses nothing, and the
   Undo is step 1 alone.

**A shared (`claim_group`) chore — step 1 is skipped, not reordered:**

1. `DELETE /api/wall/assignments/:id/claim`. Proceed only on `{ released: true }` — a release the
   server refuses must not un-tick a claim it still holds.
2. The compensating ledger row, exactly as above.

There is no completion call in the shared path, because the release route has already made it:
`handleAssignmentClaimRelease` writes `status = 'pending', completed_at = NULL, grade = NULL,
completion_note = NULL` on the caller's own row (`index.js:1425-1430`). Worse than redundant,
sending one would fail visibly — `/api/completions` carries `AND claim_group IS NULL` in its UPDATE
(`index.js:1268`) and answers a claim row with
`rejected: "This assignment is shared; use /api/assignments/:id/claim instead."` The draft read as
1→2→3 with the release folded in last, which would have produced that error on every shared Undo
and been found only at acceptance check §14.9.

Note this makes the wall's Undo strictly *more* capable than the Child App's, since it works from
server state rather than a local record. That asymmetry is worth knowing about; it is not worth
fixing here.

### 6.6 What the wall never writes

Reschedule (`deferred_to`), waive (`status='waived'`), grades, completion notes, messages,
`child_block_hint`, `child_sort_order`, streaks, and anything at all on an `activity` row. Ray
asked for complete-only and the app should not quietly grow the rest. Enforced by there being no
code path, no button, and — checkably — no occurrence of those field names in `wall-app/`
(acceptance check §14.13).

Streaks are the one omission with a visible consequence: a child who only ever ticks chores on the
wall never advances a streak, because the streak is computed and PUT by the Child App from its own
local records. §15.3.

### 6.7 The Done Today screen

Requested by Ray, 2026-08-13: *"a completed screen showing the time for Chores completed that
day."*

**The data is already there and already in hand.** `assignments.completed_at` is an INTEGER
millisecond timestamp (`migrations/0001:54`), written by every completion path — the Child App
(`completion.js:26`), the claim route (`index.js:1392`), and the wall (§6.1). §5.2.1 keeps today's
`complete` rows in the day map for the `m` denominator and for Undo, so this screen needs **no new
fetch, no new route, and no new column**. It is a rendering of rows the wall is already holding.

**What it shows.** One line per chore completed today, across all active children:

```
   4:12 pm    Take the bins out          Ellie
   3:48 pm    Feed the cat               Talia
  11:20 am    Tidy the playroom          Ellie
```

- Sorted by `completed_at` **descending** — the most recently finished chore is the one someone
  walking past wants to see.
- Time is local, 12-hour, no seconds, on §10.2's 15-second clock tick.
- Chores only. Activities are out of scope everywhere in this app (§5.1), and events have no
  completion lifecycle (§7).
- A `complete` row with `completed_at IS NULL` renders as **"earlier today"** rather than being
  hidden. Nothing in the current code writes one, but the column is nullable and a row completed by
  a future surface that forgets to set it should degrade to a missing time, not a missing chore.
- Empty state before anyone has done anything: **"Nothing done yet today."**
- Cleared by the §5.3 day rollover along with everything else, so the board is the day's record and
  not a running log.

**It is display-only.** Undo stays behind the PIN in the child's own view (§6.5) — the Done screen
is a record, and a record a passing sibling can tap is not one. This preserves §7's rule that
nothing on the ambient surface is tappable except a child tile.

```
[DECISION] Where Done Today lives
Decided: on the ambient rotation, family-wide — the wall alternates between the
  events board and Done Today, or shows Done Today as a panel beside the child
  tiles where the layout allows (§10.2's 960×600 baseline decides which; Phase 2
  picks one on the device).
Rationale: the point of a wall display is the household seeing what got done and
  when, without anyone authenticating. Behind the PIN it would be a per-child
  history that the Child App's own Completed view already gives that child, on a
  device they already have — which is the one place it adds nothing.
Consequence: this NARROWS §0.4, which put chore titles behind the PIN. Completed
  titles go on the ambient screen; pending ones stay gated. The distinction is
  deliberate rather than a loophole — a pending list is a child's workload and a
  sibling's ammunition, and a finished list is the household's record of a day.
Signed off: Ray, in-session 2026-08-13, including the §0.4 narrowing. §0.4 now
  reads "pending chore titles stay behind the PIN"; completed ones do not.
Locked for: this slice.
```

`completed-core.js` (§11) owns the selection, sort, and time-bucketing, DOM-free and IO-free, so
the surface question above is a rendering decision and not a rebuild.

---

## 7. Events

Events are read from the same rows, but they are the one thing on the screen that is not scoped to
a child.

**The union.** Every **active** child's `kind='event'` rows are merged and deduplicated by
`source_id || id` **per date** — the same key `planner-core.js:172` uses, re-implemented. An event
assigned to three children yields three rows in D1 and exactly one line on the wall.

§0.1's roster is what makes this trustworthy. Under the 2026-08-13 draft the union spanned *paired*
children, so an event assigned only to a child nobody had paired — or whose token had been revoked
— silently vanished from a screen that calls itself the family's events. Now the union spans
exactly the set D1 calls active, and the only way an event goes missing is if every child it was
assigned to has been archived. That is a defensible answer rather than an accident of which tablets
happened to be set up.

**The consequence, stated because it is a design choice and not an accident:** an event assigned to
*one* child still appears on the wall as a family event. There is no "everyone" flag to read —
SRS Module 07 requires at least one child and stores a `childIds[]`, so "shared" is not a property
the schema records. Ray's framing ("events are always shared") matches how they are used, and the
wall takes him at his word. §15.4 lists what a stricter reading would cost.

**Rendering.** Today's events in full — title, `payload.time` if set, `payload.notes` if short —
sorted by time, untimed last. Then a quieter *Coming up* strip for the rest of the 7-day window,
grouped by day. A multi-day event shows its span (`Day 2 of 4`) from `payload.startDate` /
`payload.endDate`, which `assignmentFromEvent` (`packet.js:566`) already snapshots for exactly this
reason.

Events have no completion lifecycle and are never tappable. Nothing on the ambient screen is,
except a child tile.

---

## 8. The Worker work — a fourth credential class and a wall route family

This section was empty in the 2026-08-13 draft. Dropping per-child pairing (§0.1) is what filled
it: a credential that is not scoped to a child cannot let the Worker derive `child_id` from the
token, so the wall needs routes that take the child as a parameter and a credential the Worker
trusts to name one.

### 8.1 Migration `0009_wall_device_scope.sql`

```sql
ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'child';
```

`devices.child_id` is `NOT NULL` (`migrations/0001:96`), and SQLite cannot drop a NOT NULL
constraint in place. Rather than rebuild the table, a wall row stores the **sentinel
`child_id = ''`** — never a real id, since ids are server-minted UUIDs — and `scope = 'wall'` is
what actually distinguishes it. `idx_devices_child` is unaffected. Registered in
`management-app/worker/migrations.js` in the same commit (`CLAUDE.md` §III.D), applied from
Settings → Database in the browser.

### 8.2 Credential resolution

`resolveDevice` (`index.js:275`) returns `{ deviceId, childId, scope }`. `withDevice` keeps its
current meaning and additionally **rejects any row whose `scope` is not `'child'`**, so a wall
token presented to `/api/plan` or `/api/completions` is a 401 — the existing device routes get
strictly no new callers. A new `withWall` wrapper accepts `scope = 'wall'` only, and is the sole
gate on the routes below.

### 8.3 The routes

| Route | Method | Body / query | Notes |
|---|---|---|---|
| `/api/wall/pair` | POST | `{ code, label }` | Mints a `scope='wall'` device. Unauthenticated, like `/api/pair`. |
| `/api/wall/children` | GET | — | `SELECT id, name FROM children WHERE active = 1 ORDER BY name` |
| `/api/wall/plan` | GET | `?childId=&from=&to=&since=` | `handlePlan`'s body, `childId` from the query |
| `/api/wall/completions` | POST | `{ childId, completions[] }` | `handleCompletions`' logic and field list |
| `/api/wall/rewards/entries` | POST | `{ childId, entries[] }` | `handleRewardEntries`' logic |
| `/api/wall/assignments/:id/claim` | POST · DELETE | `{ childId, … }` | `handleAssignmentClaim` / `…Release` |

**Every one of them validates `childId` against `children WHERE active = 1` before touching
`assignments`,** and every SQL statement keeps its existing `AND child_id = ?` clause with the
resolved id substituted for the token-derived one. A wall token therefore cannot act for an
archived child, cannot act for an id that is not a child at all, and cannot reach a row belonging
to a different child than the one it named.

**Column ownership is unchanged and stays route-enforced.** The wall completion route reuses
`ASSIGNMENT_COMPLETION_FIELDS` (`index.js:77`) verbatim — the same allowlist, the same per-row
`rejected` on an unknown key. The credential widens *which child may be acted for*; it must never
widen *what may be written*, and reusing the existing field maps rather than writing new ones is
what makes that true by construction instead of by review.

This is the narrowing that needs sign-off (§16): Online Revamp §4.2's "the Worker derives
`child_id` from the token, never from the request body" now has an exception, scoped to
`/api/wall/*` and to a credential class that exists only on the wall.

### 8.4 Provenance

`updated_by` becomes `wall:<deviceId>` on these routes — not `device:<deviceId>`. The device-label
trick the draft relied on ("Wall — Ellie") is gone with per-child pairing, and one wall device now
writes for every child, so the row itself has to say where a completion came from. It is the cheap
half of §15.3's streak question and of any later "who ticked this" report, and it costs one string
literal. `reward_entries.created_by` follows the same shape.

### 8.5 Assets

Adding `/wall` → `/wall-app/` to `staticRedirect` (`index.js:121`), alongside the `/kid` redirect
it mirrors. `.assetsignore` needs **no** change — `wall-app/` is public static assets exactly like
`child-app/`. Re-read that file before assuming so during Phase 1; it is a security boundary
(`CLAUDE.md` §I.B).

---

## 9. Designing for the Alexa voice bridge

Ray intends to connect Alexa to this Worker and eventually mark chores done by voice. Nothing in
this slice should make that harder, and three things here make it easier.

### 9.1 The wall and voice now need the same thing — build it once

**This section is reversed from the 2026-08-13 draft**, which argued the wall did not consume the
design space voice needs. Under per-child tokens that was true. Under §0.1 it is not: the wall now
needs precisely what Alexa §3.1 identified — *a credential that is household-scoped like the
parent's but routed like a device's*, with the child named in the request. Two slices arrived at
the same requirement independently, which is usually a sign the requirement is real.

The recommendation is therefore to **build §8.2's `withWall` and the child-resolution check as the
general mechanism**, and have the voice route be its second caller rather than a parallel
invention. Concretely, what should be shared when Alexa is built:

- the `scope` column and its resolution in `resolveDevice` (§8.1/§8.2) — voice gets
  `scope = 'voice'`, or keeps `ALEXA_BRIDGE_TOKEN` as a secret and reuses only the wrapper shape;
- the "resolve `childId`, verify it is an active child, substitute it into the existing
  `AND child_id = ?` clause" pattern (§8.3), which is the whole of the safety argument;
- the reuse of `ASSIGNMENT_COMPLETION_FIELDS` rather than a per-caller field list (§8.3).

**They stay two credentials, not one — and they are not the same kind of thing.** The wall's is
*minted* by redeeming a pair code, lives in `localStorage` on a tablet in Ray's kitchen, and is
revoked from the Devices UI. Alexa's is a *Worker secret*, lives in Amazon's endpoint
configuration outside Ray's control, and is rotated from the Cloudflare dashboard. Different
exposure, different lifetime, different revocation path — one mechanism, two credential
instances. `ALEXA_BRIDGE_TOKEN` remains a Worker secret; the wall never sees it, and the wall's
token is not a secret Ray ever sets or handles.

### 9.2 §6.3's reward gap now has an answer to point at

The Alexa slice gates Phase 2 on choosing between (a) the Worker credits from the snapshot, (b) it
credits nothing, and (c) voice cannot mark paying work done. Ray has now chosen **(a)** for the
wall. The recommendation for voice is the same choice, implemented server-side, citing §6.2's
**earn rule** verbatim — one sentence, three implementations, no divergence to discover later.
That is not free of the objection §6.3(a) raised (the rule is stated in prose rather than shared as
code, because `reward-core.js` is a Child App file the Worker cannot import and `CLAUDE.md` §I.A
forbids making it importable). Stating it once in a TDS and citing that statement from each
implementation is the containment available under the guardrails, and it is worth writing the
citation comment in each file when it is built.

### 9.3 The idempotency primitive voice should use — and why the wall cannot

When the Worker itself performs a completion (voice has no client to do it), it should make the
credit conditional on *having caused the transition*:

```sql
UPDATE assignments
   SET status = 'complete', completed_at = ?1, updated_at = ?1, updated_by = 'voice:alexa'
 WHERE id = ?2 AND child_id = ?3 AND claim_group IS NULL AND status = 'pending'
```

`changes > 0` means this call moved the row from pending, so credit exactly once; `changes = 0`
means it was already done, so credit nothing. This is naturally correct under Undo — a reversal
returns the row to `pending`, so a later re-completion transitions again and credits again, matching
the compensating entry the reversal wrote.

This shape is available to voice because the voice route writes its own `UPDATE`. It is **not**
available to the wall, because `/api/completions` is a shared route whose `UPDATE` deliberately has
no `status = 'pending'` guard — the Child App's own Undo depends on writing `pending` over
`complete`. Adding the guard to the shared route to serve the wall would break Undo in the app that
already has it. Hence §6.1's client-side pre-check, and §15.1's honest note that it narrows rather
than closes the double-credit window.

### 9.4 Two smaller things voice will be glad of

- **One naming authority (§3.3).** Voice resolves children through `children.name` and the Alexa
  interaction model's slot synonyms. The wall now renders `children.name` verbatim and has no local
  nicknames at all — the draft's nicknames were dropped with per-child pairing — so there is no
  second, silently-competing naming authority for voice to disagree with. Renaming a child in the
  Management App moves both surfaces at once.
- **Shared chores.** The wall claims them (§6.3); voice refuses them (Alexa §6.4). Both are right
  for their surface, and after a voice completion the wall reflects it within one poll — worth an
  acceptance check when Phase 2 of that slice is built.

---

## 10. The Fire tablet

### 10.1 Show Mode — a caveat to settle before hardware is mounted

Ray plans a Fire tablet "in Show Mode hung on the wall". Show Mode is Amazon's own docked
full-screen Alexa interface; it presents Amazon's UI, not an arbitrary web page, and a browser
cannot be pinned inside it. The practical options are therefore:

1. **Show Mode off, Silk (or a kiosk browser) full-screen**, with the tablet on charge and screen
   timeout disabled. A kiosk browser from the Amazon Appstore additionally handles auto-restart
   after a reboot and locks the child out of the address bar — the closest thing to what "always
   on" means in practice.
2. **Show Mode on, wall app opened manually** when someone wants it. Then it is not an always-on
   display and most of §5.2's polling design is wasted.

Option 1 is what the rest of this slice assumes. **This is stated as a constraint to confirm on the
actual device, not as verified fact** — Fire OS version, Silk's capabilities, and which Appstore
apps are available are all things this design cannot check from here.

### 10.2 What the app does and does not rely on

- `navigator.wakeLock` is used **if present** and never depended on; keeping the screen awake is a
  device setting (charging + timeout), not something a web page can be trusted to win.
- Baseline layout target **960 × 600 CSS px, landscape** (a Fire HD 10 at 1920 × 1200 with dpr 2),
  fluid rather than fixed. Touch targets ≥ 64 px. No horizontal scrolling anywhere; only the
  per-child chore list scrolls vertically.
- **Night dimming in CSS**, not device brightness: a full-page overlay ramping in after
  `dimStartHour` and out at `dimEndHour` (defaults 21:00 / 06:00, both in Settings). Any touch
  clears it for the session's duration.
- Clock updates on a 15-second tick with no seconds displayed — a calmer surface, and one that is
  not repainting every frame on a tablet that will be running for months.
- A minimal, shell-only service worker, mirroring `child-app/sw.js`: cache-first for the precached
  shell, **network-only for `/api/*`, never cache an API response**. It exists so a wifi blip
  during a reload does not white-screen the wall, and for no other reason. `CACHE_NAME` is bumped
  on any shell change, per the discipline that file's header documents at length, and Settings
  carries a **Reload app** button that unregisters and re-registers it (no CLI, `CLAUDE.md` §0).

### 10.3 Shakedown — a real build step, not a formality

Phase 4 (§13) is on the actual tablet, and it is where this design finds out what it got wrong:
does the screen stay on for 24 hours; does `localStorage` survive a Silk restart and a reboot; does
the service worker register at all; is the PIN pad comfortable at arm's length; does the night
overlay read as "dimmed" or as "broken"; does a day rollover actually fire on a page that has been
open since Tuesday.

---

## 11. File structure

```
wall-app/
├── index.html            (one shell; views are DOM, not pages)
├── manifest.json         (display: fullscreen, orientation: landscape)
├── sw.js                 (§10.2 — shell only)
├── css/wall.css
├── icons/
└── js/
    ├── app.js            boot, view routing, day-rollover timer
    ├── store.js          localStorage: wall token, PIN hashes, settings, pending earns
    ├── api.js            fetch wrappers, the one wall bearer, childId per call, 401 → unpaired
    ├── poll.js           cadence, roster + plan, since-merge, staleness stamp
    ├── setup.js          first-run wizard: admin PIN, pair the display, re-pair
    ├── events-core.js    PURE — union, dedupe, sort, span labels
    ├── chores-core.js    PURE — on-today rule (§5.1.1), counts, shared/claimed classification
    ├── completed-core.js PURE — §6.7's done-today selection, sort, time bucketing
    ├── session-core.js   PURE — idle-timer and lockout state machines
    ├── pin-core.js       salt/hash/verify (crypto.subtle), attempt counting
    ├── ambient-ui.js     clock, events, child tiles, Done Today, night overlay
    ├── child-ui.js       PIN pad, chore list, complete/undo/claim
    └── settings-ui.js    admin PIN, child PINs, re-pair display, failed earns, reload app
```

`*-core.js` files are DOM-free and IO-free so `tests/` can exercise them directly — the same split
`CLAUDE.md` §I.B requires and the Child App already follows. **No file is shared with either
existing app**, including the ones whose logic is deliberately mirrored:

| File | Mirrors | Fixed by |
|---|---|---|
| `events-core.js` | `planner-core.js:172` (`eventKey`) | §7 |
| `chores-core.js` | `planner-core.js:48` (`effectiveDueDate`), `:154` (`onToday`), `assignment-core.js:85-88` (`isPlannable`) | §5.1.1 |
| `completed-core.js` | `completion.js`'s Completed view selection | §6.7 |
| `pin-core.js` | nothing — the wall is the only surface with a PIN | §4 |

Each carries a comment naming the file it mirrors and the section of this TDS that fixes the rule,
so a future divergence is a decision someone makes rather than a drift nobody notices.

`pairing.js` from the 2026-08-13 draft is gone; `setup.js` replaces it, and it pairs a *display*
rather than a child (§3.2).

---

## 12. Tests

`tests/wall-cores.test.js`, `node --test`, no runtime dependency (`CLAUDE.md` §I.B):

1. Event union — three children's rows for one event on one day collapse to one line; two distinct
   events on one day stay two; a multi-day event yields one line per day with the right span label.
2. Chore filtering — activities excluded; rescinded excluded; sibling-claimed excluded; complete
   counted in the denominator and offered to Undo.
3. **The on-today rule (§5.1.1)** — a row with `deferred_to = tomorrow` is *absent* from today
   despite `date = today`; a row with `deferred_to = today` is *present* despite `date` being
   earlier; a pending chore dated yesterday rolls forward; a pending chore dated yesterday whose
   `required` is explicitly `false` does not; a *complete* row dated yesterday does not.
4. Counts — `n of m` against a mixed pending/complete/claimed set.
5. **Done Today (§6.7)** — only `kind='chore'`, only `status='complete'`, only today; sorted by
   `completed_at` descending; a `completed_at: null` row still appears, last; children are
   interleaved by time rather than grouped.
6. Session state machine — idle reset on activity, expiry at 300s, immediate end on Done.
7. Lockout — five failures locks, the sixth attempt is refused, expiry unlocks, success resets.
8. PIN hash — verify round-trips; a different salt with the same PIN gives a different hash. A
   child with no PIN row is reported as gated-but-unopenable (§4.6), never as "no PIN required".
9. Poll merge (§5.2.1) — a `since=` response updates changed rows and leaves others; a row that
   comes back `complete` is **retained** in the day map and removed only from the pending list; a
   row that comes back rescinded or sibling-claimed is dropped outright.
10. Earn shape — `reward_amount: null` → 1; `reward_amount: 3` → 3; **`reward_category: null` →
    no entry at all** (§6.2), not an entry with a null category; the reversal is the exact negative
    with `reason: 'adjustment'` and the same `assignment_id`.
11. Pending-earn queue classification (§6.2) — `applied` and `rejected` both remove; `deferred` and
    a thrown network error both retain.

The Worker side extends `tests/worker-routes.test.js` and `tests/worker-validation.test.js`:

12. A `scope='wall'` token is 401 on `/api/plan`, `/api/completions`, `/api/rewards/entries` and
    the claim routes (§8.2) — the existing device routes gain no new callers.
13. A `scope='child'` token is 401 on every `/api/wall/*` route.
14. `/api/wall/completions` with a `childId` that is archived, unknown, or belongs to a different
    child than the assignment → no row written.
15. `/api/wall/completions` with a parent-owned key in a completion row → per-row `rejected`, same
    as `/api/completions` (§8.3's field-map reuse is the thing being tested).

Everything above the pure layer stays on the §14 manual checks, as `CLAUDE.md` §I.B requires.

---

## 13. Build phasing

Each phase ends with a `CLAUDE.md` §VI.A status update. No phase is estimated past the §V.A
2–3 hour ceiling.

| Phase | Contents | Est. |
|---|---|---|
| **0** | This TDS; the `CLAUDE.md` v2.2 amendment (§16); the Roadmap §0 entry. **Ray's sign-off on §6.4, §6.7's §0.4 narrowing, and §16 before Phase 1.** | ~30 min |
| **1 — Worker** | Migration 0009 + registry; `scope` in `resolveDevice`; `withWall`; the six `/api/wall/*` routes; the `staticRedirect` entry. Tests §12.12–15. **No wall app yet** — verified by curl-equivalent from the browser and by the Devices UI showing a wall row. | ~2.5 h |
| **2** | Shell, `store.js`, admin PIN, first-run wizard, `setup.js` pairing, Settings. Ambient renders tiles from the live roster with no plan data behind them. | ~2 h |
| **3** | `api.js`, `poll.js`, `events-core.js`, `chores-core.js`, `completed-core.js`; the ambient screen becomes real — events, counts, Done Today, staleness, day rollover, night dim. | ~2.5 h |
| **4a** | PIN pad, session/lockout, §4.6's PIN-less tile, the per-child chore list. Read-only: nothing is tappable yet. | ~1.5 h |
| **4b** | Completion, the earn entry, `wall.pendingEarns` and its three answers, Undo (both paths), the claim path and its "got there first" state. | ~2 h |
| **5** | Remaining tests (§12.1–11), then the on-device shakedown (§10.3) and whatever it turns up. | ~2 h |

**Phase 1 is new**, and it is the whole cost of §0.1. It is also the phase with no visible output,
which makes it the one most likely to be skipped or merged into another — it should not be. Every
later phase depends on routes that do not exist yet, and the credential narrowing (§8.3) is the
part of this slice most worth reviewing on its own rather than inside a diff that also moves CSS
around.

Phases 2–4b are each independently deployable; the app is useful (events, counts, Done Today, no
ticking) from the end of Phase 3, which is a reasonable place to hang the tablet and live with it
for a few days before building 4. No phase exceeds the §V.A 2–3 hour ceiling.

---

## 14. Acceptance checks

1. An unpaired wall opens the first-run wizard, not a blank screen or an error.
2. Pairing the display once produces tiles for **every active child**, with no per-child step —
   and Management App → Devices shows one new revocable row labelled `Wall display`.
3. **Adding a child in the Management App makes a tile appear within one poll**, with no wall-side
   action at all. Archiving that child makes the tile disappear within one poll. Un-archiving
   restores it *with its PIN intact* (§3.3).
4. A child with no PIN set shows a tile with a live `n of m`, and tapping it says "Ask a parent to
   set a PIN" rather than opening (§4.6).
5. Revoking the wall device shows one "This display has been unpaired" screen — not a broken
   ambient view — and re-pairing with a fresh code restores everything, PINs included.
6. Five wrong PINs lock one tile for 60 seconds with the remaining time visible; other tiles still
   open normally; the lockout survives a page reload.
7. A correct PIN opens the chore list; five minutes untouched returns to ambient; **Done** returns
   immediately; a reload signs out.
8. **A chore the child deferred to tomorrow on their own tablet is absent from the wall's today
   list**, and a pending chore from yesterday is present on it — the wall and the tablet agree on
   what is due (§5.1.1).
9. Ticking a chore removes it from the list, increments that tile's count, and — checked in the
   Management App — sets `status='complete'` and appends exactly one `reward_entries` row with the
   snapshotted amount (or 1 where the snapshot is `NULL`).
10. **A chore whose `reward_category` is `NULL` completes, credits nothing, shows the "no reward
    set" marker, and leaves `wall.pendingEarns` empty** — it must not queue a doomed entry (§6.2).
11. Undo returns the row to `pending` and appends a compensating `adjustment` entry of the exact
    negative amount. **No ledger row is ever deleted** (verify by row count, not by balance).
12. A shared chore already claimed by a sibling shows "got there first", writes nothing, and leaves
    no ledger row.
13. Undo of a *won* shared claim releases it server-side first, and the sibling's device can then
    claim it. **No `/api/wall/completions` call is made on that path** (§6.5) — check the network
    log, since the symptom of getting this wrong is a rejection the UI may swallow.
14. **Done Today** lists that day's completed chores newest-first with local times, spans all
    children, is not tappable, and is empty again after the §5.3 rollover (§6.7).
15. Wifi off: the ambient screen keeps rendering the last poll with an amber staleness stamp; a
    chore tap refuses visibly; nothing is queued; nothing is silently applied when wifi returns.
16. A reward entry whose POST failed transiently is retried on the next poll and lands **exactly
    once** (idempotent on its client-minted id). One rejected permanently is dropped from the queue
    and listed in Settings.
17. An event assigned to two children appears once. A multi-day event shows the correct span on
    each of its days. An event assigned only to an **archived** child does not appear (§7).
18. `grep -rE "waiv|deferredTo|childSortOrder|child_block_hint|/api/streak|/api/messages|SYNC_TOKEN" wall-app/` returns nothing (§6.6). Note `deferred_to` is **no longer** in this list — §5.1.1 requires reading it; the check is that it is never written, which §14.19's route log covers.
19. The wall never calls a parent or child-device route: a network log across a full session shows
    only `/api/wall/*` paths.
20. A wall token pasted into the Child App's pairing flow, or a child device token used against
    `/api/wall/plan`, is rejected (§8.2).
21. Left running overnight, the display shows the new day's events and an empty chore count by
    morning, with no manual reload — and the overnight poll cadence is visibly the slower one.
22. `/wall` redirects to `/wall-app/` (§8.5).

---

## 15. Deferred — decided not to build, with reasons

### 15.1 Server-side earn idempotency

The tidy fix for §6.2's residual double-credit is a unique index on `reward_entries (assignment_id)
WHERE reason = 'earned'`. It cannot simply be applied: creating a unique index fails if the live
table already holds a duplicate pair, and the only way to clear one would be to **delete a ledger
row** — which `CLAUDE.md` §III.C forbids outright, for reasons that are much more load-bearing than
this problem is. A non-unique index plus a `WHERE NOT EXISTS` guard in `handleRewardEntries` would
avoid the delete, but silently breaks the Undo→redo cycle: the reversal is an `adjustment`, so the
original `earned` row still exists and would block the re-credit the child has legitimately earned
back. The correct shape is §9.3's transition-based guard, which is only available to a route that
writes its own `UPDATE` — i.e. the voice route, when it is built. Left open deliberately, with the
narrowing pre-check of §6.1 as the interim answer.

### 15.2 PINs in D1

Would let a PIN follow a child to a second wall tablet and be managed from the Management App.
Costs a migration, a route, a parent UI, and a decision about where the hash is computed. Revisit
if a second display ever exists.

### 15.3 Streaks from the wall

A wall-only child never advances a streak (§6.6). The wall could recompute one from server rows and
`PUT /api/streak`, but it would then race the Child App, which computes the same number from local
records — two writers, one column, no arbitration, which is exactly the shape Online Revamp §4.2
exists to prevent. Wants a decision about which surface owns the streak before either writes it.

### 15.4 A genuine "everyone" flag on events

§7's union treats any event as family-wide. A strict reading would need Management Module 07 to
distinguish "all children" from "these children", which is an SRS change and a schema change for a
distinction Ray may well not want.

### 15.5 Also not built

Per-child theming on the wall; messages to the parent from the wall (Module 13's composer is the
Child App's, and a wall is the wrong place to type a question); school activities on the display;
a second wall tablet; any reporting surface.

---

## 16. Amendments required before Phase 1

**✅ Both amendments landed 2026-08-13, and all three narrowings are signed off. Phase 0 is
complete; Phase 1 is clear to start.** What follows is the record of what was changed and why.

1. **`CLAUDE.md` → v2.2** ✅, authorized by Ray in-session:
   - **§I.A** — the app-isolation table becomes three columns. The Wall App's scope is: read the
     active-child roster, chores and events; write completions, their earn entries, and claims;
     nothing else. Its credential is the **wall token**, not a device token. Runtime code sharing
     with either existing app stays **FORBIDDEN**, including the mirrored rules of §11.
   - **§I.B** — the repository structure gains `wall-app/`. Note explicitly that it is public
     assets and needs no `.assetsignore` entry, so the next reader does not "fix" that.
   - **§III.A** — a second narrowing, alongside the `claim_group` one: the Wall App's writes are
     online-required (§6.4). Scoped to that app; the Child App's local-first guarantee is untouched.
   - **§0 and §III.E** — the **new one, and the one that matters most**: "the Worker derives
     `child_id` from the token, never from the request body" gains an exception for `/api/wall/*`,
     where a household-scoped credential names the child in the request and the Worker validates it
     against `children WHERE active = 1` (§8.3). Column-level ownership is **not** narrowed — it
     stays route-enforced through the same field maps. Both halves need saying, because the second
     is what makes the first safe.
   - **§VII** — a locked-decision row: *Wall Display App — one household-scoped wall token, roster
     from `children.active`, local PINs, complete-only, online-required writes.*
2. **`docs/Roadmap_Schedule_App.md` §0** ✅ — a slice entry with its phase table (§13), plus
   entries for the Shared Chores and Alexa slices that were missing from the same list.
3. **Ray's sign-off, itemized.** Three things in this document are narrowings of locked decisions
   rather than applications of them. Each was put to Ray individually on 2026-08-13 with its
   alternatives, and each was approved as recommended:
   - ✅ §6.4 — the wall does not queue completions (narrows `CLAUDE.md` §III.A). *Alternative
     offered and declined: build an outbox on the wall.*
   - ✅ §8.3 — `child_id` from the request on `/api/wall/*` (narrows Online Revamp §4.2).
     *Alternatives offered and declined: a read-only wall with no write routes at all; reverting
     to per-child pairing.*
   - ✅ §6.7 — completed chore titles on the ambient screen (narrows this slice's own §0.4).
     *Alternatives offered and declined: gating Done Today behind the PIN; building both surfaces.*
4. **No SRS module** is written for v1: the surface is one ambient screen, one PIN pad, one chore
   list, and one Done Today board, and §5–§7 specify it more precisely than a new SRS module would.
   If the wall grows past this scope, it earns SRS modules then — recorded here so the omission is
   a decision rather than an oversight.

---

---

## 17. Revision log

### 2026-08-13 — post-review revision

Ray reviewed the 2026-08-13 draft and rejected its central premise. Recorded here rather than
silently rewritten, because the first design was internally coherent and someone will otherwise
wonder why it was abandoned.

**The reversal.** *"This isn't supposed to have pairing at all. It's supposed to pull all active
children from the D1, period."* The draft held one device token per child, which made the wall's
roster a local copy of a fact D1 already records and made adding a child a two-device ceremony.
§0.1, §3, §5, §6 and §8 are rewritten around one household-scoped wall credential; §9.1 is reversed
outright, since the wall and the voice bridge turn out to need the same mechanism.

**Correctness fixes found by reading the draft against the Worker and the Child App:**

| Draft said | Code says | Now |
|---|---|---|
| Chores are `date = today` | `planner-core.js:48`/`:154` — deferment and overdue roll-forward | §5.1.1, and a backward window |
| Complete rows are "dropped from the live view" (§5.2) while also being the denominator and the Undo set (§5.1) | — | §5.2.1 |
| Undo posts a completion, then releases the claim | `/api/completions` has `AND claim_group IS NULL` (`index.js:1268`); the release route already writes `pending` (`index.js:1425`) | §6.5, two separate paths |
| Claim with "an empty body" | `await request.json()` → 400 (`index.js:1326`) | §6.3 |
| The earn rule has no `reward_category` fallback | `packet.js:541` can leave it `NULL`; `index.js:1467` rejects that permanently | §6.2 |
| `wall.pendingEarns` retries until it lands | `rejected` is permanent; retrying it forever is a loop on an always-on display | §6.2's table |
| Pair codes are labelled at mint | `devices.js:140-168` sends only `childId`; the label rides the pair request (`index.js:1119`) | §3.2 |
| §5.2's free-tier arithmetic | `withDevice` also writes `last_seen_at` (`index.js:288`) | §5.2, write side counted |

**Dropped as not applicable to this household:** the draft's §4.4 concern about a child extracting
tokens via developer tools. Ray's assessment of his own kids settles it; §4.4 keeps the honest
statement of what the PIN does and does not do, without the escalation argument.

**Added:** §6.7, the Done Today screen, requested during the revision — completed chores with the
time they were finished, from a column (`assignments.completed_at`) that already exists and is
already reported.

---

*Companion documents: `TDS_Slice_Online_Revamp.md` (controlling), `TDS_Slice_Shared_Chores.md`,
`TDS_Slice_Alexa_Voice_Bridge.md`, `CLAUDE.md`.*
