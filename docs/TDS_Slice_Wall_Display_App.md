# Technical Design Specification — Slice

## Scope: Wall Display App — a third, always-on browser app that shows family events to the room and gates each child's chores behind a PIN

**Status:** design only. No code written under this slice yet.
**Date:** 2026-08-13
**Depends on:** `TDS_Slice_Online_Revamp.md` (controlling design), `TDS_Slice_Shared_Chores.md` (claim arbitration), `TDS_Slice_Alexa_Voice_Bridge.md` (§9 here is written to keep that slice buildable).
**Amends:** `CLAUDE.md` §I.A/§I.B/§VII → v2.2 (§16). `docs/Roadmap_Schedule_App.md` §0.

---

## 0. Decisions made in this slice

All five were put to Ray in-session on 2026-08-13 and answered; they are recorded here as
`[DECISION]` blocks in §3–§7 rather than re-argued.

1. **No new credential class.** The wall tablet holds **one ordinary device token per paired
   child**, redeemed through the existing `/api/pair` flow. It is N child devices in one chassis,
   not a new kind of thing. The parent token never touches it (`CLAUDE.md` §0), and each child's
   access is revoked independently from Management App → Devices, which already exists. This is the
   opposite call from the Alexa slice's §3.1 — and for a good reason: Alexa needed one credential
   that could read *across* the household, because the request names the child. Here the child is
   named by *which tile was tapped and which PIN was entered*, so per-child scoping costs nothing
   and buys the whole authorization model for free.

2. **Completions from the wall credit rewards.** The wall posts a `reward_entries` row exactly as
   the Child App does — `amount = reward_amount ?? 1`, `category = reward_category`, both read off
   the assignment row's own snapshot. This is option **(a)** of the three the Alexa slice §6.3 left
   open, decided here for the wall and recommended there (§9.2). A tick is a tick; where the child
   was standing when they made it is not a thing the ledger should have an opinion about.

3. **PINs live on the tablet, not in D1.** Set when a child is paired, stored salted-and-hashed in
   the wall tablet's `localStorage`. Zero schema change, zero new route — the whole app is purely
   additive to the API. The threat model is a sibling reaching for the wrong tile, not an attacker;
   §4.4 states plainly what this does and does not protect.

4. **The ambient screen shows today's events in full, plus a progress count per child.** Chore
   *titles* stay behind the PIN; "Ellie · 3 of 5" does not. A wall that shows nothing until someone
   authenticates is a clock with extra steps.

5. **Shared (`claim_group`) chores are claimable from the wall.** Behind the PIN the wall knows
   exactly which child is tapping, so it calls `POST /api/assignments/:id/claim` with that child's
   token and gets the server's arbitration, same as the Child App. This is a deliberate departure
   from the Alexa slice §6.4, which refuses shared chores — that refusal is about *voice not
   knowing who is asking in a way that can settle a race*, not about the route being unsuitable.
   The wall does not have that problem.

6. **No schema change. One optional Worker change (a two-line redirect).** §8 is empty on purpose.

---

## 1. Why a slice, not a full TDS

The wall app introduces no schema, no credential class, no column ownership, and no route. Every
byte it reads and writes travels an API path that already exists and is already exercised by the
Child App. What is genuinely new is a *composition*: several device tokens on one device, a PIN
gate in front of each, and a rendering surface designed to be looked at from six feet away.

It is a third app rather than a Child App mode because `CLAUDE.md` §I.A's isolation rule cuts that
way: the Child App is a single child's device, owns an IndexedDB cache and an outbox, and assumes
one identity for its whole lifetime. Teaching it to hold N identities, drop its outbox, and grow an
ambient mode would be a rewrite of its core assumptions wearing a feature's clothes. A separate
folder with no shared runtime code is both cheaper and what the guardrails require.

---

## 2. Architecture

```
   Fire tablet on the wall, always on, house wifi
   ┌──────────────────────────────────────────────┐
   │  wall-app/  — vanilla JS, no build step        │
   │  localStorage:  [{childId, token, nickname,    │
   │                   pinHash, pinSalt}, …]        │
   │  no IndexedDB · no outbox · no packet          │
   └───────────────┬──────────────────────────────┘
                   │  N device tokens, one per child
                   │  GET /api/plan        (read, per child)
                   │  POST /api/completions (write, per child)
                   │  POST /api/rewards/entries
                   │  POST/DELETE /api/assignments/:id/claim
                   ▼
   ┌──────────────────────────────────────────────┐
   │  Cloudflare Worker — same script, same D1      │
   │  D1 `scheduling-app` = SYSTEM OF RECORD        │
   └──────────────────────────────────────────────┘
        ▲                ▲                    ▲
   Management App    Child App         (later) Alexa — §9
```

The wall is a **fourth arrow into the same Worker**, and — unlike Alexa — not even a new arrow
shape. Everything below is a client-side design.

---

## 3. Credentials, storage, and adding a child

### 3.1 The credential model

```
[DECISION] Wall credential
Decided: N ordinary device tokens, one per paired child, redeemed through the
  existing POST /api/pair. No parent token. No new secret. No new route.
Rationale: /api/pair already mints a per-child, hashed-at-rest, individually
  revocable credential (Online Revamp §4.3), and the wall's own UI already
  establishes which child is acting before any write. A household-scoped
  credential would hand one tablet read access to every child the moment it
  is paired to any of them, and would need a new Worker code path to enforce
  what per-child tokens enforce for free.
Consequence: the wall must hold several tokens at once, and physical access to
  the tablet is access to all of them (§4.4). Each is revocable on its own, and
  a revoked one degrades exactly one tile.
Locked for: this slice.
```

### 3.2 What lives on the tablet

`localStorage` only. No IndexedDB, no service-worker-cached API responses, no outbox.

```js
// wall.children — the paired set
[{ childId, token, nickname, pinSalt, pinHash, addedAt, lastError }]

// wall.settings
{ adminPinSalt, adminPinHash, dimStartHour, dimEndHour, shellVersion }

// wall.pendingEarns — §6.2's narrow retry queue, reward entries only
[{ id, childId, assignmentId, category, amount, reason, earnedAt }]
```

`wall.children[].token` is a bearer credential in plain text. So is the Child App's, in its
`syncMeta` singleton — this is the same exposure the existing design already accepts, on a device
that is by definition in a shared room. §4.4 is honest about it; §15 lists the only real
mitigation (revoke from the Management App) rather than pretending storage tricks are one.

### 3.3 Adding a child — "only those already in D1", enforced by construction

1. Management App → Devices → **Mint pair code** for the child, label it `Wall — <name>`
   (this UI exists: `management-app/js/devices.js:154`).
2. Wall app → Settings (admin-PIN gated, §4.5) → **Add child** → type the 8-character code.
3. Wall `POST /api/pair` → `{ token, childId, childName }`.
4. Wall prompts for a **nickname**, prefilled with `childName`, and a **4-digit PIN**.
5. Row appended to `wall.children`.

The "scoped only to those in the D1" requirement needs no code to satisfy: a pair code is minted
*against an existing `children` row* and is the only way in. The wall has no create-child path, no
child-name text field that reaches the server, and no route that would accept one.

The nickname is **display-only, and deliberately local**. Precedent is exact: `pairing.js:26-40`
already treats a name chosen on a device as that device's business, not something to overwrite from
the server. Forward-looking, this also matters for §9 — Alexa resolves children by
`children.name`, so a nickname that never leaves the tablet cannot drift the two surfaces apart.

Re-pairing a `childId` already present **replaces the token and keeps the nickname and PIN**.
Removing a child deletes the row locally; it does **not** revoke the device server-side, and the
Settings screen must say so and link to Management App → Devices (a local delete cannot revoke a
credential — pretending otherwise would leave a live token behind a "removed" label).

### 3.4 When a token stops working

Any `401` from a per-child call marks that child's row `lastError = 'revoked'`. The tile renders
as **"Needs re-pairing"**, is not tappable, and contributes no chores and no events. One revoked
child never degrades another's tile and never blanks the ambient screen.

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
remaining time shown. The counter is per child, resets on success, and persists in `localStorage`
so closing and reopening the browser does not clear a lockout. No lockout escalation beyond 60s:
this is a sibling deterrent, and a child who waits a minute five times is not the failure mode
being designed against.

### 4.4 What the PIN actually protects — stated plainly

It stops a sibling tapping the wrong tile and ticking off someone else's chores. It does **not**
protect against anyone who picks the tablet up and opens developer tools: the device tokens are in
`localStorage` in plain text, and the PIN hash is salted SHA-256 over a 4-digit space, which is
brute-forceable in milliseconds by anyone who has already got that far. Both facts are true of the
Child App today. Neither is a reason to build a heavier gate on a wall tablet in a family kitchen;
both are reasons not to describe this as security in any document or UI string.

### 4.5 The admin gate

Settings — add/remove a child, change a nickname, reset a PIN, force a shell reload — sits behind a
**separate admin PIN**, set during first run. Otherwise the child who wanted out of chores would
simply remove their own tile. First run with no children and no admin PIN opens a two-step wizard:
set admin PIN → add first child.

---

## 5. The read path

### 5.1 What is fetched

Per paired child, `GET /api/plan?from=<today>&to=<today+6>` with that child's bearer token. From
the returned rows the wall uses **only**:

| Rows | Used for |
|---|---|
| `kind='chore'`, `date = today`, `status='pending'`, `rescinded_at IS NULL` | that child's chore list and their `n of m` count |
| `kind='chore'`, `date = today`, `status='complete'` | the `m` denominator, and the undoable set (§6.5) |
| `kind='event'`, any date in range | the shared events strip (§7) — unioned across children |
| `kind='activity'` | **ignored entirely.** School work is not this app's business. |

A `claimed_by` that is neither `NULL` nor this child renders as claimed-by-a-sibling and is not
tappable (mirroring `assignment-core.js:86`, re-implemented — not shared, per §I.A).

### 5.2 Polling cadence, and why not `/api/plan/version`

```
[DECISION] Poll shape
Decided: poll GET /api/plan with a bounded date window and `since=<max updated_at
  seen>`, every 60s between 06:00 and 22:00 local, every 15 minutes overnight,
  plus immediately after any write and on day rollover. Do NOT poll
  /api/plan/version.
Rationale: /api/plan/version runs COUNT(*) and MAX(updated_at) over *every* row
  a child has ever had (index.js:1174) — no date bound, no index to narrow it.
  A child with a semester committed is a few thousand rows, and 1,440 polls a
  day each scanning them is millions of row reads per child per day, against a
  D1 free-tier allowance in the single-digit millions. The plan query with a
  7-day window rides idx_assign_child_date and touches tens of rows.
  Free tier is a LOCKED constraint (CLAUDE.md §0), so the cheap-looking route
  is the expensive one here.
Consequence: the first fetch of a session is a full window; every later poll is
  incremental and merged by id into an in-memory map. Rows that come back
  rescinded, complete, or claimed by a sibling are dropped from the live view.
Locked for: this slice. The arithmetic assumes the free-tier read allowance
  documented at build time — re-check it against Cloudflare's current limits
  during Phase 2 rather than trusting this paragraph.
```

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

`POST /api/completions`, one row, with `X-Outbox-Protocol: 2` so the §11.7 `deferred` shape is
understood rather than met as a 503:

```json
{ "completions": [ { "id": "<assignment id>", "status": "complete", "completedAt": 1755100000000 } ] }
```

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

`POST /api/rewards/entries` follows the completion, with a client-minted UUID `id` — the server's
`ON CONFLICT (id) DO NOTHING` makes a replay free.

**Ordering, and the only queue in the app.** The completion goes first; the earn follows. If the
earn fails after the completion landed, the child is short and the wall must not forget. So:
reward entries — *and only reward entries* — get a small persisted retry list
(`wall.pendingEarns`), drained on the next poll. This is safe precisely because the entry is
idempotent on its client-minted id, so a retry that was actually delivered the first time is a
no-op. Completions get no such list, deliberately: the tick either happened or it did not, and a
completion that lands ten minutes later from a device nobody is standing at is a worse outcome than
an honest "try again".

**Residual risk, named:** a chore ticked *simultaneously* on the wall and on the child's own tablet
— inside the same poll window, before §6.1's pre-check can see the other — credits twice. That is
the exposure the ledger already carries between any two child devices, the ledger is append-only,
and `POST /api/rewards/adjust` exists. §15.1 works through why the obvious fix (a unique index)
cannot be applied to an append-only table and what the real one looks like.

### 6.3 Shared chores

`POST /api/assignments/:id/claim` with an empty body, that child's token.

- `{ claimed: true, assignment }` → tick it, patch the cache from the returned row, post the earn.
- `{ claimed: false }` → **"Talia got there first!"**, cheerful, three seconds, then the row
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
Consequence: this is a genuine narrowing of a LOCKED decision and needs Ray's
  sign-off (§16). It applies to the wall app only; nothing about the Child App
  changes.
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
the server reports `complete`. It mirrors the Child App's reversal shape exactly
(`completion.js:157-198`), re-implemented:

1. `POST /api/completions` → `{ status: 'pending', completedAt: null, grade: null }`
   (`'pending'` is in `COMPLETION_STATUSES`, `validation.js:26`).
2. A compensating `reward_entries` row: same category, `-(reward_amount ?? 1)`,
   `reason: 'adjustment'`, same `assignment_id`. **Never a delete** — the ledger is append-only.
3. For a shared chore, `DELETE /api/assignments/:id/claim` **first**, and only reverse locally if
   `{ released: true }` — a release the server refuses must not un-tick a claim it still holds.

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

---

## 7. Events

Events are read from the same rows, but they are the one thing on the screen that is not scoped to
a child.

**The union.** Every paired child's `kind='event'` rows are merged and deduplicated by
`source_id || id` **per date** — the same key `planner-core.js:172` uses, re-implemented. An event
assigned to three children yields three rows in D1 and exactly one line on the wall.

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

## 8. Column and route ownership — additions to Online Revamp §4.2

**None.** The wall writes `status`, `completed_at`, and appends to `reward_entries` — all
child-owned, all through routes that already enforce that ownership, all using a device token whose
`child_id` the Worker derives from the token itself. `updated_by` gains no new shape: a wall write
is `device:<deviceId>` like any other, and the *device* is distinguishable after the fact by its
`devices.label` ("Wall — Ellie"), which the pairing flow sets. That is a better provenance record
than a new `updated_by` value would be, and it costs nothing.

The only Worker edit in the whole slice is optional: adding `/wall` → `/wall-app/` to
`staticRedirect` (`index.js:121`), alongside the `/kid` redirect it mirrors.

`.assetsignore` needs **no** change — `wall-app/` is public static assets exactly like
`child-app/`. Re-read that file before assuming so during Phase 1; it is a security boundary
(`CLAUDE.md` §I.B).

---

## 9. Designing for the Alexa voice bridge

Ray intends to connect Alexa to this Worker and eventually mark chores done by voice. Nothing in
this slice should make that harder, and three things here make it easier.

### 9.1 The wall does not consume the design space voice needs

The wall uses per-child device tokens (§3.1). Voice cannot — a spoken request names the child, so
it needs the household-scoped bridge secret the Alexa slice §3 already specifies. The two
credential designs are complementary, not competing, and neither has to be revisited when the other
is built. `ALEXA_BRIDGE_TOKEN` remains a Worker secret; the wall never sees it.

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

- **Nicknames stay local (§3.3).** Voice resolves children through `children.name` and the Alexa
  interaction model's slot synonyms. If the wall's nickname were pushed to D1 it would become a
  second, silently-competing naming authority.
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
    ├── store.js          localStorage: children, tokens, nicknames, PIN hashes, pending earns
    ├── api.js            fetch wrappers, per-child bearer, 401 → needs-re-pairing
    ├── poll.js           cadence, since-merge, staleness stamp
    ├── pairing.js        add / re-pair / remove a child
    ├── events-core.js    PURE — union, dedupe, sort, span labels
    ├── chores-core.js    PURE — today filter, counts, shared/claimed classification
    ├── session-core.js   PURE — idle-timer and lockout state machines
    ├── pin-core.js       salt/hash/verify (crypto.subtle), attempt counting
    ├── ambient-ui.js     clock, events, child tiles, night overlay
    ├── child-ui.js       PIN pad, chore list, complete/undo/claim
    └── settings-ui.js    admin PIN, add/remove child, nicknames, reload app
```

`*-core.js` files are DOM-free and IO-free so `tests/` can exercise them directly — the same split
`CLAUDE.md` §I.B requires and the Child App already follows. **No file is shared with either
existing app**, including the ones whose logic is deliberately mirrored (`events-core.js` against
`planner-core.js`'s event key, `chores-core.js` against `assignment-core.js`'s plannability rule).
Each such file carries a comment naming the file it mirrors and the section of this TDS that fixes
the rule, so a future divergence is a decision someone makes rather than a drift nobody notices.

---

## 12. Tests

`tests/wall-cores.test.js`, `node --test`, no runtime dependency (`CLAUDE.md` §I.B):

1. Event union — three children's rows for one event on one day collapse to one line; two distinct
   events on one day stay two; a multi-day event yields one line per day with the right span label.
2. Chore filtering — activities excluded; rescinded excluded; sibling-claimed excluded; complete
   counted in the denominator and offered to Undo.
3. Counts — `n of m` against a mixed pending/complete/claimed set.
4. Session state machine — idle reset on activity, expiry at 300s, immediate end on Done.
5. Lockout — five failures locks, the sixth attempt is refused, expiry unlocks, success resets.
6. PIN hash — verify round-trips; a different salt with the same PIN gives a different hash.
7. Poll merge — a `since=` response updates changed rows, leaves others, and removes rows that came
   back complete/rescinded/claimed.
8. Earn shape — `reward_amount: null` → 1; `reward_amount: 3` → 3; the reversal is the exact
   negative with `reason: 'adjustment'` and the same `assignment_id`.

Everything above the pure layer stays on the §14 manual checks, as `CLAUDE.md` §I.B requires.

---

## 13. Build phasing

Each phase ends with a `CLAUDE.md` §VI.A status update. No phase is estimated past the §V.A
2–3 hour ceiling.

| Phase | Contents | Est. |
|---|---|---|
| **0** | This TDS; the `CLAUDE.md` v2.2 amendment (§16); the Roadmap §0 entry. **Ray's sign-off on §6.4 and §16 before Phase 1.** | done / ~30 min |
| **1** | Shell, `store.js`, admin PIN, first-run wizard, pairing, Settings. Ambient renders tiles from local state with no data behind them. | ~2 h |
| **2** | `api.js`, `poll.js`, `events-core.js`, `chores-core.js`; the ambient screen becomes real — events, counts, staleness, day rollover, night dim. | ~2 h |
| **3a** | PIN pad, session/lockout, the per-child chore list. Read-only: nothing is tappable yet. | ~1.5 h |
| **3b** | Completion, the earn entry, `wall.pendingEarns`, Undo, the claim path and its "got there first" state. | ~2 h |
| **4** | Tests (§12), then the on-device shakedown (§10.3) and whatever it turns up. | ~2 h |

Phases 1–3b are each independently deployable; the app is useful (events + counts, no ticking)
from the end of Phase 2, which is a reasonable place to hang the tablet and live with it for a few
days before building 3.

---

## 14. Acceptance checks

1. A wall with nothing paired opens the first-run wizard, not a blank screen or an error.
2. A pair code minted for a child, redeemed on the wall, produces a tile bearing the nickname
   typed on the wall — and Management App → Devices shows a new, revocable device row.
3. Revoking that device makes the tile read **Needs re-pairing** within one poll; other children's
   tiles are unaffected; no chore is tappable for the revoked child.
4. Five wrong PINs lock one tile for 60 seconds with the remaining time visible; other tiles still
   open normally; the lockout survives a page reload.
5. A correct PIN opens the chore list; five minutes untouched returns to ambient; **Done** returns
   immediately; a reload signs out.
6. Ticking a chore removes it from the list, increments that tile's count, and — checked in the
   Management App — sets `status='complete'` and appends exactly one `reward_entries` row with the
   snapshotted amount (or 1 where the snapshot is `NULL`).
7. Undo returns the row to `pending` and appends a compensating `adjustment` entry of the exact
   negative amount. **No ledger row is ever deleted** (verify by row count, not by balance).
8. A shared chore already claimed by a sibling shows "got there first", writes nothing, and leaves
   no ledger row.
9. Undo of a *won* shared claim releases it server-side first, and the sibling's device can then
   claim it.
10. Wifi off: the ambient screen keeps rendering the last poll with an amber staleness stamp; a
    chore tap refuses visibly; nothing is queued; nothing is silently applied when wifi returns.
11. A reward entry whose POST failed is retried on the next poll and lands **exactly once**
    (idempotent on its client-minted id).
12. An event assigned to two children appears once. A multi-day event shows the correct span on
    each of its days.
13. `grep -rE "waiv|deferredTo|deferred_to|childSortOrder|child_block_hint|/api/streak|/api/messages|SYNC_TOKEN" wall-app/` returns nothing (§6.6).
14. The wall never calls a parent route: a network log across a full session shows only `/api/pair`,
    `/api/plan`, `/api/completions`, `/api/rewards/entries`, and `/api/assignments/:id/claim`.
15. Left running overnight, the display shows the new day's events and an empty chore count by
    morning, with no manual reload — and the overnight poll cadence is visibly the slower one.
16. `/wall` redirects to `/wall-app/` (if §8's optional redirect is built).

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

1. **`CLAUDE.md` → v2.2**, authorized by Ray in-session:
   - **§I.A** — the app-isolation table becomes three columns. The Wall App's scope is: read
     chores and events, write completions and their earn entries, nothing else. Runtime code
     sharing with either existing app stays **FORBIDDEN**, including the mirrored rules of §11.
   - **§I.B** — the repository structure gains `wall-app/`. Note explicitly that it is public
     assets and needs no `.assetsignore` entry, so the next reader does not "fix" that.
   - **§III.A** — a second narrowing, alongside the `claim_group` one: the Wall App's writes are
     online-required (§6.4). Scoped to that app; the Child App's local-first guarantee is untouched.
   - **§VII** — a locked-decision row: *Wall Display App — N per-child device tokens, local PINs,
     complete-only, online-required writes.*
2. **`docs/Roadmap_Schedule_App.md` §0** — a slice entry with its phase table (§13).
3. **No SRS module** is written for v1: the surface is one ambient screen, one PIN pad, and one
   chore list, and §5–§7 specify it more precisely than a new SRS module would. If the wall grows
   past this scope, it earns SRS modules then — recorded here so the omission is a decision rather
   than an oversight.

---

*Companion documents: `TDS_Slice_Online_Revamp.md` (controlling), `TDS_Slice_Shared_Chores.md`,
`TDS_Slice_Alexa_Voice_Bridge.md`, `CLAUDE.md`.*
