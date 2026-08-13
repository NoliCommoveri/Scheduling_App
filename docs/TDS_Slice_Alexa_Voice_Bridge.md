# Technical Design Specification — Slice

## Scope: Alexa Voice Bridge — spoken schedule/reward queries, and a gated voice-triggered completion, via a third Worker credential and one new route

**Status:** Drafted 2026-08-13, in-session with Ray, out of a curiosity conversation about voice
assistants. Per `CLAUDE.md` §II this document is what makes the feature buildable — nothing here
should be implemented until §13's open items are confirmed and §0.4's Phase 2 gate is authorized.
Phase 1 (read-only) has no such gate and is buildable once §0.2's endpoint-secret design is
confirmed.

**Applies to:** the Worker only (`management-app/worker/`). No change to either browser app.
This is a **third HTTP client** of the existing API — like the Child App and Management App, it
only ever talks to `/api/*` — not a third app in the `CLAUDE.md` §I.A sense, and it shares no JS
file with either.

**Builds on:** `TDS_Slice_Online_Revamp.md` §3.3 (`assignments`), §3.4 (`reward_entries`), §4
(the two-credential authorization model this slice extends to three), §5 (route shape and
rejection conventions). `TDS_Slice_Shared_Chores.md` §5.6 (the precedent for a write that must
not go through the ordinary batch-completion path).

**Adds:** one Worker secret, one route, one small new file of pure helpers
(`management-app/worker/voice.js`, mirroring `validation.js`'s DOM-free split so it stays
testable under `tests/`). **No migration.** Every column this slice touches already exists.

---

## 0. Decisions made in this slice

1. **A third credential class.** Not `SYNC_TOKEN` (whole-database, never leaves a parent device
   per `CLAUDE.md` §0) and not a device token (scoped to one child, minted by pairing). A **voice
   bridge secret** — household-scoped like the parent token, but restricted by the Worker to a
   fixed, small set of read routes (and, if Phase 2 is authorized, one narrow write). It is never
   entered into either browser app; it lives only in the Worker's secrets and in the Alexa
   Developer Console's endpoint configuration (§3).

2. **The authenticity check is a secret in the endpoint URL, not Amazon's request-signature
   scheme.** Real signature verification (validating `SignatureCertChainUrl` against a
   certificate chain) is what Amazon requires for a *published* skill, and this one is not
   published — it is enabled only on Ray's own developer account, per the flow discussed with him
   already. §3 states the design and §13 records the accepted risk precisely, so it cannot quietly
   widen if this skill is ever made public.

3. **Child selection is by spoken name against `children.name`,** resolved through the Alexa
   interaction model's custom slot synonyms (so "Lyra" and any nicknames Ray configures all
   resolve to one canonical value before the Worker ever sees the request). No new column, no
   fuzzy matching server-side. Ambiguity (two children with the same or confusable names) is
   listed in §13, not solved here.

4. **Phase 1 is read-only and needs no reward-crediting decision.** Phase 2 (voice-triggered
   completion) is gated — **AUTHORIZATION REQUIRED** — on §6.3's question: reward crediting for a
   completion happens today entirely in `reward-core.js`, on the device, at the moment of the tap
   (Online Revamp §7). A completion this route writes has no device and no tap, so nothing runs
   that logic. Building Phase 2 without deciding this first would either silently under-pay a
   child or require the Worker to re-implement reward math it does not otherwise own.

5. **No schema change.** Reads go through `children`, `assignments`, `reward_entries`, `streaks`
   — all already queried elsewhere in the Worker. Phase 2's write reuses
   `ASSIGNMENT_COMPLETION_FIELDS` (`index.js:77`) exactly as `/api/completions` does, scoped by a
   resolved `child_id` instead of a device token's.

---

## 1. Why a slice, not a full TDS

The whole surface is one new route and one new secret. Nothing about `assignments`' column
ownership (Online Revamp §4.2), the outbox/drain model, or the two-app split changes. The one
genuinely new idea — a credential that is household-scoped like the parent's but *routed* like a
device's — is small enough to state in §3 without a document the size of the Shared Chores slice.

---

## 2. Architecture

```
Amazon Alexa (Echo device, Ray's account only — skill never published)
      │  POST, JSON, over HTTPS — Amazon's servers, not the device directly
      ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker  —  same script, same D1 binding          │
   │  NEW: POST /api/voice/alexa/:bridgeToken                     │
   │  D1 `scheduling-app`  =  SYSTEM OF RECORD (unchanged)         │
   └────────────────────────────────────────────────────────────┘
      ▲                                                 ▲
      │  existing parent routes                          │  existing device routes
 Management App                                     Child App
```

Alexa is a fourth arrow into the same Worker the two apps already share — not a fourth
`assignments` writer with new rules, a fourth *caller* of rules that already exist.

---

## 3. The voice bridge credential

### 3.1 Why not `SYNC_TOKEN`, and why not a device token

`SYNC_TOKEN` is explicitly the one credential `CLAUDE.md` singles out as never leaving a parent
device (§0's non-negotiables table). Amazon's servers holding it — even for a private skill —
is "leaves a parent device" by any reasonable reading: it would be sitting in Amazon's endpoint
configuration, outside Ray's control, with full database scope. A device token is the wrong shape
for the opposite reason: it is scoped to *one* child, and "show me Lyra's schedule, show me
Talia's" needs one credential that can read across the household, the way `GET /api/assignments`
already lets the parent do (`index.js:992`).

### 3.2 Design — a secret in the URL, checked before anything else runs

```
[DECISION] Voice bridge authenticity
Decided: a new Worker secret ALEXA_BRIDGE_TOKEN, entered via the Cloudflare dashboard
  the same way SYNC_TOKEN is today (DEPLOY.md, no CLI). The Alexa skill's HTTPS
  endpoint, configured once in the Developer Console, is
  https://<worker-domain>/api/voice/alexa/<the same value>.
  The Worker's route match extracts the path segment and rejects with 404
  (not 401 — an unrecognized path segment should not confirm that a voice
  route exists at all) unless it timingSafeEqual-matches the secret.
Rationale: Amazon does not let a "Provision your own" HTTPS endpoint carry a
  static Authorization header, so the credential has to travel in the URL
  Amazon is configured to call. A long random path segment is the same trick
  used for unlisted webhook URLs generally, and pairs with `timingSafeEqual`
  (validation.js:208, already used for SYNC_TOKEN and the device pairing
  compare) so a timing attack cannot narrow it down.
Consequence: the endpoint is a bearer credential embedded in a URL, not a
  header. That is weaker than the pairing-code + hashed-device-token design
  §4.3 of Online Revamp uses, and is accepted only because this skill is
  never published (§13.1).
Locked for: this slice.
```

`context.System.application.applicationId` — the skill's own id, which every ASK request
carries — is checked as a second, cheap gate once the URL token has already passed: not because
it is secret (it is not; it would appear in a leaked interaction-model export), but because it
costs nothing and catches a misconfigured second skill pointed at the same URL by mistake.

### 3.3 Route allowlist

A `withVoice` wrapper, alongside `withParent` (`index.js:285`) and `withDevice` (`index.js:292`):

```js
async function withVoice(request, env, pathBridgeToken, handler) {
  if (!env.ALEXA_BRIDGE_TOKEN || !timingSafeEqual(pathBridgeToken, env.ALEXA_BRIDGE_TOKEN)) {
    return json({ error: 'Not found.' }, 404);
  }
  const body = await request.json().catch(() => null);
  const appId = body && body.context && body.context.System && body.context.System.application
    && body.context.System.application.applicationId;
  if (!env.ALEXA_SKILL_ID || appId !== env.ALEXA_SKILL_ID) {
    return json({ error: 'Not found.' }, 404);
  }
  return await handler(body);
}
```

Everything this credential can do is enumerated in §4–§6. It cannot rescind, cannot mint pair
codes, cannot revoke a device, cannot adjust rewards, cannot apply a migration — the same
column/route discipline `CLAUDE.md` §0 requires of the two existing credentials applies to the
third: **the Worker decides what it may do; nothing about the shape of the request does.**

---

## 4. Route

One entry point, because Alexa's console configures exactly one endpoint URL per skill and
dispatches every request type to it:

```
POST /api/voice/alexa/:bridgeToken
```

```js
const voiceMatch = /^\/api\/voice\/alexa\/([^/]+)$/.exec(pathname);
if (voiceMatch && method === 'POST') {
  return withVoice(request, env, voiceMatch[1], (body) => handleVoiceRequest(body, env));
}
```

`handleVoiceRequest` dispatches on `body.request.type`:

| `request.type` | Handling |
|---|---|
| `LaunchRequest` | Speak a prompt: *"Whose schedule do you want?"* Keep session open. |
| `IntentRequest`, `intent.name === 'AMAZON.HelpIntent'` | Speak usage. Keep session open. |
| `IntentRequest`, `'AMAZON.StopIntent'` / `'AMAZON.CancelIntent'` | Empty response, `shouldEndSession: true`. |
| `IntentRequest`, `'GetScheduleIntent'` | §5.1. |
| `IntentRequest`, `'GetRewardBalanceIntent'` | §5.2. |
| `IntentRequest`, `'MarkItemDoneIntent'` | §6 — **Phase 2 only; 501 until authorized.** |
| `SessionEndedRequest` | `{}`, no `response` key required by ASK. |
| anything else | Speak a fallback ("I didn't understand that"), keep session open. |

All response building (the `{version, response: {outputSpeech, shouldEndSession}}` envelope) is a
pure function — `buildAskResponse(speechText, { endSession })` — in `voice.js`, so `tests/` can
assert the shape without a `Request`/`Response` in scope, the same split `validation.js`'s header
already explains for the rest of the Worker.

---

## 5. Read path (Phase 1 — no gate)

### 5.1 `GetScheduleIntent`

Slots: `ChildName` (custom slot type, required), `Day` (`AMAZON.DATE`, optional — defaults to
today, Worker-side, in the Worker's own clock since Alexa's device timezone is not something this
design threads through).

```
resolveChild(env, slotValue) → { id, name } | null
```

```sql
SELECT id, name FROM children WHERE active = 1 AND lower(name) = lower(?1)
```

The slot value handed to this query is Alexa's *resolved* value — `intent.slots.ChildName
.resolutions.resolutionsPerAuthority[0].values[0].value.name` — not the raw transcript, so
nickname synonyms are already folded by the time the Worker compares. No match → speak "I don't
have a child named {name}." and end there; no further query runs.

On a match, this is `handlePlan`'s query (`index.js:1198`) narrowed to one day and reusing its
ordering, not a new shape:

```sql
SELECT title, kind, status FROM assignments
WHERE child_id = ?1 AND date = ?2 AND rescinded_at IS NULL
ORDER BY sort_order LIMIT 20
```

Spoken form caps at 6 items regardless of the SQL limit — nobody wants Alexa to read twenty
titles — and says "and N more" past that, the same truncation-is-reported-never-silent principle
`capRows` (`validation.js:163`) already applies to JSON responses:

> "Lyra has 4 things today: Math Lesson 12, Reading, Breakfast Dishes, and Piano Practice. Math
> Lesson 12 is done."

Completed items are named as done, not omitted — a parent asking "what's on Lyra's plate" usually
wants to know what's *left*, but omitting finished work silently would read as "nothing was
assigned" on a day everything is already done, which is a worse answer.

### 5.2 `GetRewardBalanceIntent`

Slot: `ChildName`, resolved the same way. Query is Online Revamp §3.4's balance query verbatim,
narrowed to nothing more than the categories:

```sql
SELECT category, SUM(amount) AS balance FROM reward_entries WHERE child_id = ?1 GROUP BY category
```

> "Talia has $4.50 in Allowance and 12 points in Screen Time."

---

## 6. Write path (Phase 2 — gated, not built until authorized)

### 6.1 `MarkItemDoneIntent`

Slots: `ChildName` (required), `ItemTitle` (`AMAZON.SearchQuery`, required — free text, since
authoring a custom slot type enumerating every possible assignment title is not maintainable).

### 6.2 Item resolution

```sql
SELECT id, title FROM assignments
WHERE child_id = ?1 AND date = ?2 AND status = 'pending'
  AND rescinded_at IS NULL AND claim_group IS NULL
```

(today's date; `claim_group IS NOT NULL` excluded per §6.4). Match `ItemTitle` case-insensitively
as a substring against `title`. Zero matches → "I couldn't find that on {child}'s plan today."
More than one match → "I found more than one thing matching that — can you be more specific?" and
stop; no attempt at a "best" match, because guessing wrong here means telling a parent something
was done that was not.

### 6.3 The reward-crediting gap — AUTHORIZATION REQUIRED

Online Revamp §7 is explicit: *"Earning is a side effect of completion, computed on-device by
the existing `reward-core.js` and posted as a `reward_entries` row … in the same outbox drain as
the completion."* A completion this route writes comes from neither device's outbox — there is no
tap, no `reward-core.js` invocation, nothing to drain. Three ways to close that gap, none of them
free:

- **(a) The Worker posts a flat `reward_entries` row** from the assignment's own snapshotted
  `reward_amount`/`reward_category` (already on the row per Online Revamp §3.3.2) at the moment of
  the voice completion. Simple, and correct for the common case — but if `reward-core.js` ever
  grows logic beyond a flat snapshot (a grade-scaled amount, say), this path silently diverges
  from it, because it does not call that code and cannot: `reward-core.js` is a Child App file,
  not something the Worker imports.
- **(b) The write sets `status='complete'` and posts nothing.** The balance is wrong — quietly
  short — until a parent notices and runs `POST /api/rewards/adjust` (§5.3 of Online Revamp) by
  hand. Safer to build, worse for the child, and easy to forget.
- **(c) Voice cannot mark reward-bearing work done at all** — only chores/activities whose
  snapshotted `reward_amount` is `NULL` or `0`. Narrowest, but "mark the dishes done" is exactly
  the case Ray is likely to want, and dishes usually pay something.

This slice does not choose among them. §11 makes deciding this the entry condition for Phase 2.

### 6.4 Why a `claim_group` row is out of scope here, always

Shared Chores §5.6 already drew this line for the ordinary batch-completion route: a shared chore
needs server-side arbitration (`POST /api/assignments/:id/claim`), not a blind status write,
because two children's rows for one occurrence are linked and only one may win. Voice inherits the
same rule and does not attempt to replicate the arbitration: a `MarkItemDoneIntent` that resolves
to a `claim_group` row is refused —

> "That one's shared with {sibling} — whoever gets to it first on their own tablet gets credit,
> so I can't mark it for you."

— which is a real answer, not a technical limitation stated as an apology: arbitrating a claim by
voice would mean deciding a race between two children from a request that only names one of them,
with no way to ask "did your sibling already do this" that means anything.

### 6.5 The write, once resolved

Exactly `handleCompletions`' single-row shape (`index.js:1256`–`1270`), with `updated_by =
'voice:alexa'` in place of `` `device:${device.deviceId}` ``, and the same `claim_group IS NULL`
guard already in that `UPDATE`'s `WHERE` clause — so §6.4 is enforced by the same SQL condition
that already exists, not a second check that could drift from it.

---

## 7. Column and route ownership — additions to Online Revamp §4.2

| What | Owner | Written by |
|---|---|---|
| Nothing new. Phase 2 writes only `status`/`completed_at`/`grade` — already child-owned columns. | child-owned (unchanged) | the voice route, using the household bridge credential instead of a device token, subject to the same `claim_group IS NULL` restriction every other completion path has. |
| `assignments.updated_by` | bookkeeping (unchanged) | gains a third value shape, `'voice:alexa'`, alongside `'parent'` and `'device:<id>'`. Anything in either app or in reporting that pattern-matches this column (none currently does, per a repo search before Phase 2 starts) must treat it as informational only, per Online Revamp §3.3. |

No column changes ownership. No new ownership class is introduced — unlike `claimed_by` in
Shared Chores §7, this credential writes columns that already belong to the child; it does not
arbitrate anything.

---

## 8. Management App

Nothing required to build Phase 1 or Phase 2. Optional, not part of this slice: a read-only
Settings panel showing whether `ALEXA_BRIDGE_TOKEN` and `ALEXA_SKILL_ID` are set (booleans only,
never their values, the same pattern `GET /api/migrations` already uses for state without leaking
secrets) so Ray has a browser-visible confirmation the bridge is configured, without a CLI check.
Deferred — listed in §13 rather than built, since nothing about Phase 1 depends on it.

---

## 9. Tests

`tests/` covers pure layers only (`CLAUDE.md` §I.B / repo convention). A new
`tests/worker-voice.test.js` exercises `voice.js` directly:

- `buildAskResponse` produces the exact envelope shape ASK expects, with and without
  `shouldEndSession`.
- The spoken-schedule formatter: 0 items, 1 item, exactly 6 items (no "and more"), 7+ items (the
  "and N more" branch), and a mix of pending/complete items reading correctly.
- The item-title substring matcher (§6.2): zero matches, one match, and the ambiguous-match case,
  as pure functions over an in-memory row list — no D1 involved, same reasoning
  `worker-validation.test.js` already applies to `validateCompletionValue`.

The credential check (`withVoice`) and the two live queries are exercised as acceptance checks
against a real database (§12), the same split Shared Chores draws in its own §10 between what
tests cover and what only a live D1 can confirm.

---

## 10. Build phasing

**Phase 1 — read-only.** `ALEXA_BRIDGE_TOKEN` and `ALEXA_SKILL_ID` secrets; `withVoice`;
`POST /api/voice/alexa/:bridgeToken`; `GetScheduleIntent`, `GetRewardBalanceIntent`,
`LaunchRequest`, `Help`/`Stop`/`Cancel`, `SessionEndedRequest`; the Alexa skill's interaction
model and a private (unpublished) endpoint registration in the Developer Console. Needs §3.2
confirmed; needs nothing else authorized.

**Phase 2 — voice-triggered completion.** `MarkItemDoneIntent`; the item-title resolver; the
`claim_group` refusal (§6.4). **Requires §6.3 decided first** — which of (a)/(b)/(c) the reward
gap resolves to — the same "do not build the client half until the hazard is named" discipline
Shared Chores' §11 used for its own Phase 3/Phase 4 split.

---

## 11. Acceptance checks

Run against a real database and a real Alexa Developer Console test session (the console's
built-in simulator, per the earlier conversation — free, no device needed), per `CLAUDE.md` §IV.C.

1. A request to `/api/voice/alexa/<wrong-token>` returns `404`, indistinguishable from a path that
   does not exist at all.
2. A request with the right URL token but an `applicationId` that does not match
   `ALEXA_SKILL_ID` returns `404`.
3. `GetScheduleIntent` for a child with nothing assigned today speaks a "nothing today" answer,
   not an empty or malformed response.
4. `GetScheduleIntent` for an unrecognized name speaks a clear "no child by that name" answer and
   issues no query beyond the name lookup.
5. `GetScheduleIntent` for a day with 8 live items caps the spoken list at 6 and says "and 2
   more."
6. `GetRewardBalanceIntent` for a child with entries in two categories speaks both.
7. (Phase 2) `MarkItemDoneIntent` against a `claim_group` row is refused with the shared-chore
   message (§6.4) and writes nothing.
8. (Phase 2) `MarkItemDoneIntent` matching two titles asks for clarification and writes nothing.
9. (Phase 2) A successful mark-done sets `status='complete'`, `updated_by='voice:alexa'`, and
   resolves §6.3 the way it was decided — a reward entry appears only if (a) was chosen.
10. The child's own device, polling `GET /api/plan/version` afterward, sees the row's bumped
    `updated_at` and reflects the completion — a voice completion is not invisible to the app the
    child actually uses.

---

## 12. Open items — deferred, not decided here

1. **Full Alexa request-signature verification.** §3.2's URL-secret design is accepted because
   the skill stays unpublished on Ray's own account. If it is ever submitted for certification or
   shared beyond this household, Amazon requires validating `SignatureCertChainUrl` and the
   `Signature` header against Amazon's certificate — real work, not done here, and a hard
   prerequisite for publishing, not an enhancement.
2. **Ambiguous or duplicate child names.** §0.3's exact-match-on-resolved-slot-value approach has
   no answer for two children whose names resolve to the same slot value. Not a concern for a
   two-child household with distinct names; flagged for whenever that stops being true.
3. **§6.3, the reward-crediting choice**, restated from §6.3: this is the one decision that
   actually blocks Phase 2, not a nice-to-have.
4. **Timezone.** §5.1's "today" is the Worker's clock (UTC, by default on Cloudflare), not
   necessarily the household's. Not a problem for a same-day query asked out loud, but worth
   naming before a "what's due tomorrow" intent is ever added.
5. **Rate limiting / abuse of the bridge route.** It is internet-reachable, gated only by
   `timingSafeEqual` against one secret. Free-tier D1 and Workers have generous limits, but
   nothing here throttles repeated wrong-token guesses beyond what Workers itself absorbs. Low
   risk for an unpublished, unlisted URL; noted rather than mitigated.
6. **§8's optional Settings visibility panel.** Not built; not blocking Phase 1.
7. **Multi-turn dialog.** Every intent above is answered in one turn. Alexa's dialog model
   supports follow-ups ("which one did you mean?" listening for a second reply) — not designed
   here; the ambiguous-match cases (§6.2, §12.2) currently just end the exchange and ask the human
   to try again.

---

## 13. SRS amendments required

None. This slice adds no user-facing surface to either browser app's SRS modules — it is a new
external client of the existing API, and the API's contract (Online Revamp §5) is extended, not
changed. If Phase 2 ships, `SRS_Management_Module_06_Chore_Authoring.md` and
`SRS_Module_04_Activity_Chore_Completion.md` may want a one-line note that a completion can
originate from `updated_by='voice:alexa'` in addition to a device — cosmetic, not a contract
change, and left for whoever builds Phase 2 to add alongside the code.
