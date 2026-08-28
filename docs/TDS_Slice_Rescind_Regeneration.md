# TDS Slice — Rescind and regenerate: pulled-back school work returns to the walk

**Status:** **BUILT — all three phases landed 2026-08-28, amended the same day (§2.2a).**
Authorized by Ray in-session. Reported as "my rescinded school tasks
aren't feeding back into the generator", then narrowed by Ray in the same session into the rule this
slice builds: *school work returns, chores do not.*
**Extends:** `TDS_Slice_Online_Revamp.md` §6.3 (rescind is `rescinded_at`, never a delete), §6.6
(the natural key and what Propose marks as already live), `SRS_Management_Module_08_Packet_Generation_Export.md`
(Propose/Review/Commit, the Generation Log).
**Supersedes:** nothing. No locked decision bends, no narrowing is asked for.
**App scope:** the **Worker** (one new read-only parent route) and **`management-app/`**
(`packet.js` Propose). No migration. No schema change. No Child App or Wall App change. Nothing is
written that was not written before.

---

## 0. Why this exists

### 0.1 The report

Ray, 2026-08-28, with two screenshots — the Assignments view for 2026-08-27 showing four Math E rows
struck through as `rescinded`, and a Propose run for the next range whose Math E items begin at
`MIAMATHE-eyu58x-L07-04`. The three rescinded lessons before it are nowhere in the proposal. He is
assigning **daily** while the family settles into the system, and the workflow he needs is:

> if my kid fails to complete a school assignment on the date originally sent, I need to be able to
> reassign it to today and push what would have been today out. I thought I could rescind then
> regenerate.

He rescinded. He regenerated. The generator walked straight past the work he had just pulled back.

### 0.2 Why it walks past — two gates, neither of which can see a rescind

Propose decides what school work is still owed from **local history**, not from D1:

```js
const logRows = await Storage.getAllByIndex('generationLog', 'by_child', childId);   // packet.js:333
const sentActivityIds = new Set(                                                     // :334
  logRows.filter((r) => r.disposition === 'sent' && r.instanceId).map((r) => r.itemId)
);
...
const pending = walk.filter((a) => !sentActivityIds.has(a.id) && !a.excludeFromGeneration); // :403
```

`generationLog` is keyed `['childId','itemId']` (`storage.js:162`) and is written **only at Commit**.
Rescind is a Worker call (`POST /api/assignments/rescind`, `worker/index.js:1362`) that stamps
`rescinded_at` on the D1 row and touches nothing local. So the log still says `sent`, the activity
stays out of `pending`, and no later Propose will ever offer it again. The work is not "late" — as
far as the generator is concerned it was delivered and the walk has moved on.

The second gate is quieter and only bites when the rescinded date is **inside** the proposed range.
Step 2 reproduces in-range `sent` decisions from the log (`packet.js:365-395`) so the parent sees the
whole period rather than a hole. A rescinded row is exactly a hole, and reproduction fills it back
in — as an *uncommitted* item, because §6.6.2 is explicit that rescinded rows do not block the
natural key. Commit would then insert it again on the day it was pulled from, which is the one place
Ray does not want it.

### 0.3 The fact that this was foreseen

`loadCommittedKeys` already carries the reason in its own comment (`packet.js:164-172`):

> D1 is asked first because it is the system of record and the only source that knows about a
> **rescind**: pulling a batch back leaves its 'sent' log rows behind, **and those items must become
> assignable again.**

The read was built; the second half of the sentence was never wired to anything. `loadCommittedKeys`
asks D1 for the **range** and uses the answer for one purpose only — marking items already live
(§6.6.3). Nothing has ever asked D1 the question that matters here, which is about work outside the
range: *what did we pull back and never re-assign?*

### 0.4 The asymmetry Ray drew, in his words

> chores are different. chores are daily, if they fail to mark it yesterday then its lost. I also
> want to be able to rescind those so they CAN'T interact with yesterday's chores, but not have them
> queue up for regeneration since there is a new identical copy for today anyways and they cant
> sweep the floor twice today since they missed yesterday

This is not a special case bolted on. It falls out of what the two things **are**:

| | What the row is an instance of | What identity it carries | What a rescind means |
|---|---|---|---|
| **School activity** | a position in a course's walk — Lesson 7 Level 1 exists once | the activity id, stable for the life of the course | *not delivered.* The walk still owes it. |
| **Chore occurrence** | a day — sweeping the floor on the 27th | `CHR-{token}-{YYYYMMDD}[-{instance}]`, minted per date (§2.4) | *that day's copy is un-assigned.* It can be offered again **for the 27th**, never for any other day. |

A chore's identity **contains the date**, so a rescinded chore day can never be owed by any later
day: the 28th's occurrence is a different item, already generated by the ordinary recurrence rule.
An activity's identity does not, so the only record that it is still owed is the walk itself.

```
[DECISION] What a rescind means to the generator
Decided: a rescinded assignment is not a delivered assignment, for either subject. School work
  whose activity has no live row anywhere returns to the pending walk and is re-placed by the
  ordinary pacing budget, pushing later work out. A rescinded chore occurrence is offered again
  ONLY for its own date — the one date its id can ever name — and never migrates to a later day.
Rationale: the school walk owes an activity exactly once and tracks that in one place, so a
  rescind puts it back in the queue; a chore's identity is per-day, so a rescind un-assigns that
  day's copy and nothing else. Ray stated both halves explicitly (§0.1, §0.4, §2.2a). The
  alternative — a "reassign to today" button on the Assignments view — was considered and
  rejected in §0.5.
Locked for: this slice; the generator's read of D1 in Propose.
```

### 0.5 The alternative, and why this slice does not build it

The direct reading of "reassign it to today" is a **Move** on the Assignments view: `PATCH
/api/assignments/:id` already changes a live row's `date` (§6.5), and the view already offers it.
That is one press, it writes no new row, and it keeps the child's completion history attached to the
same id.

It is not what Ray asked for and it does not do the second half of the job. Moving a row to today
does nothing about *"push what would have been today out"* — today's budget is now over-full, and
the pacing engine, which is the thing that knows what a day holds, was never consulted. Rescind →
regenerate hands the whole day back to the pacing engine, which is precisely why Ray reached for it.
Move stays available and unchanged for the case it fits: a single row, on a day the parent is not
otherwise re-planning.

---

## 1. What does not change

- **Rescind is still `rescinded_at`, never a delete** (§6.3, CLAUDE.md §III.C). This slice adds no
  write of any kind.
- **The append-only ledger.** Rescinding never claws back earnings; nothing here touches
  `reward_entries`.
- **`excludeFromGeneration` still wins.** An activity the parent deliberately Excluded at Review
  stays excluded after a rescind: the returning set is filtered by the same flag as every other
  pending item (`packet.js:403`), and this slice only ever shrinks `sentActivityIds`.
- **The natural-key guard** (§6.6.2) is untouched, in the Worker and in the client. A rescinded row
  still does not block re-assignment; a live row still does.
- **The Generation Log stays local, and `packet.js` stays its sole writer.** Nothing in the rescind
  path writes it, and no other module gains a write.
- **Chores, events, the Child App, the Wall App, and every credential rule.** No route changes
  scope, no column changes owner, no new credential class.

---

## 2. The model

**A rescinded assignment is not a delivered assignment.** Three questions follow from that, and each
is answered by whichever store actually knows:

| Question | Answered by | Why not the other one |
|---|---|---|
| Is this item already live on the plan? | D1, for the proposed range (`loadCommittedKeys`, unchanged) | The log cannot see a rescind (§0.2) |
| Was this prior decision pulled back? | D1, for the proposed range — the same call, now asked to include rescinded rows | Same |
| Is this school activity still owed? | D1, **for the child's whole history** — the new route in §4 | The rescinded date is normally *outside* the range being proposed. Ray rescinds yesterday and proposes today. |

### 2.1 School: return to the walk

An activity is **reassignable** when the child has at least one row for it and **none of them are
live** — every row carries `rescinded_at`. That definition, rather than "has a rescinded row":

- rescinded Monday, re-assigned Wednesday → the Wednesday row is live → **not** reassignable. It is
  already owed on a day that exists; returning it to the walk would place a second copy.
- rescinded Monday, re-assigned Wednesday, completed Wednesday → still live (`complete` is live,
  §6.6.2) → **not** reassignable. Right answer for the strongest reason: the child did the work.
- rescinded Monday, nothing since → reassignable. This is Ray's case.

A reassignable activity is dropped from `sentActivityIds`, which puts it back in `pending` at its
**walk position** — Lesson 7 Level 1 returns ahead of Level 2, not at the end of the course. Step 3
then places it by the ordinary pacing budget, so it lands on the first school day of the range and
everything behind it shifts out by exactly what it costs. *"Reassign it to today and push what would
have been today out"* is the pacing engine doing its normal job, once it is told the truth about
what is owed.

### 2.2 Chores: only ever on their own date

A chore occurrence is proposed for exactly one date — the one inside its id — and a rescind
un-assigns *that* copy. So the rule has two halves, and they are the same sentence read forwards
and backwards:

- **The day being proposed offers its own rescinded occurrence again.** A rescind is not a
  suppression; the parent pulled the work back and is now planning that day afresh.
- **No other day ever gets it.** Yesterday's occurrence is not in today's range, and its id belongs
  to no other date, so nothing can carry it forward. A parent who genuinely wants yesterday's chore
  done today has the Move (§0.5).

Step 4 refuses to re-emit an occurrence that has any prior decision (`decisionItemIds`), which is
what makes a **deliberate Drop** at Review stick and what stops a second pass over the same range
double-assigning. That test now has one exception: an occurrence D1 says is **rescinded** for the
date being proposed. Step 2 does not reproduce it (§2.3), so exactly one of the two steps places it,
and a live row for that day still freezes it as already-assigned (§6.6).

### 2.2a The amendment, and the case that forced it

The first build of this slice stated the chore half as *"a rescinded chore occurrence is never
re-proposed"* and implemented it by closing reproduction (§2.3) while leaving `decisionItemIds`
alone. Ray hit the hole within the hour: he had committed a **fortnight** at the start of the week,
rescinded all of it to go back to assigning daily, and then found chores would not generate at all —
`Proposal is empty — nothing to commit for this child and range within chores only`, for 2026-08-28,
a day whose own occurrence he had just pulled back.

Both gates were shut on the same day's copy: the log row said `sent` so Step 4 suppressed it, and
the D1 row said rescinded so Step 2 would not reproduce it. Before this slice, reproduction was the
accidental escape hatch — the item came back as a ghost of a decision that no longer existed, which
is precisely why §2.3 closed it. Closing it without opening the front door made the day
un-assignable.

His own correction, in-session:

> it should only bring back rescinded chores where original assignment date was … the day being
> proposed, day it would drip into assignment via generator. I tried to assign two weeks worth at
> the beginning of the week then rescinded it all to do it daily instead

That is the rule in §2.2, and it is *more* uniform than what it replaces, not less: a rescind
un-assigns for both subjects. The asymmetry that remains is only the one the identities dictate —
school work re-enters a queue that spans days, a chore is un-assigned on the single day it names.

### 2.3 Reproduction: a pulled-back decision is not reproduced

Reproduction exists to show the parent the whole period rather than a hole where last week's work
was. A pulled-back row **is** a hole; putting it back on screen as a live-looking item is how a
rescinded row gets re-committed onto the day it was pulled from. So Step 2 skips a prior `sent`
decision when either is true:

1. its exact natural key `(date, kind, source_id, instance_key)` is rescinded in D1 — which is what
   keeps a rescinded **chore** day from being put back on screen and re-committed; or
2. it is an activity in the reassignable set — which catches the case where the log's date and the
   row's date have drifted apart, because the parent moved the row with `PATCH` (§6.5) before
   rescinding it. The log is not updated by a Move; the activity id still matches.

Both tests are D1-derived, so both are skipped wholesale when D1 could not be reached (§2.4).

Skipping reproduction is not the same as suppressing the item: a chore whose date is being proposed
comes back through Step 4 (§2.2) and a school activity comes back through the walk (§2.1). What is
gone is only the *ghost* — an item on screen that exists because of a decision D1 no longer holds.

### 2.4 Offline, and why the fallback is the old behaviour

Every judgement above needs D1. When the parent device has no token or no network,
`loadCommittedKeys` already falls back to the log and marks the proposal `committedSource: 'log'`,
which the Review screen already discloses (`packet.js:1202`). The reassignable read follows it
exactly: **no D1, no returns.** The generator then behaves precisely as it does today — conservative
in the safe direction, because believing something is still assigned after a rescind costs the
parent a Propose, while the opposite would put a duplicate on a child's plan.

---

## 3. Schema

**None.** No migration, no new table, no new column. Every fact this slice reads is already in
`assignments`, and `idx_assign_child_date` already covers the one query it adds.

---

## 4. Worker API

One route, read-only, parent-only:

```
GET /api/assignments/reassignable?childId=<id>   →  { activityIds: [ "MIAMATHE-…-L07-01", … ] }
```

```sql
SELECT source_id
  FROM assignments
 WHERE child_id = ?1 AND kind = 'activity' AND source_id IS NOT NULL
 GROUP BY source_id
HAVING SUM(CASE WHEN rescinded_at IS NULL THEN 1 ELSE 0 END) = 0
 LIMIT <MAX_QUERY_ROWS + 1>
```

- **Why a route and not a wider `GET /api/assignments`.** The question spans the child's whole
  history, not a date range, and the existing query answers with `SELECT *`. Asking it for a school
  year to extract one column would move thousands of full rows over the wire on every Propose, and
  `includeRescinded=1` alone still cannot answer "is it live *anywhere*". One aggregate returns a
  handful of ids.
- **Why `GROUP BY … HAVING` and not `NOT EXISTS`.** One scan of the child's rows instead of a
  correlated subquery per candidate, and it states the definition in §2.1 literally: no live row in
  the group.
- **`kind = 'activity'` is in the SQL, not in the caller.** The route answers a question about the
  school walk; a chore has no walk to return to (§2.2), so the asymmetry is enforced where it cannot
  be forgotten.
- **Capped like every other query** (`capRows`, `MAX_QUERY_ROWS`), so a truncated answer says so
  rather than silently under-reporting.
- **Credential:** `withParent`, same as every other `/api/assignments*` route. A device token and a
  wall token are both 401 — no new credential class, no new scope, and nothing here is writable.

---

## 5. Propose (`management-app/js/packet.js`)

1. `loadCommittedKeys` asks with `includeRescinded=1` and returns **two** sets — `keys` (live rows,
   filtered on `rescinded_at == null`, exactly what it returned before) and `rescindedKeys`. Its log
   fallback returns an empty `rescindedKeys`, per §2.4.
2. A new `loadReassignableActivities(childId, source)` returns a `Set` of activity ids, or `null`
   when `source === 'log'` (D1 unreachable) or the request fails.
3. Both reads move **above** Step 2, which now needs them. Nothing else moves.
4. Step 2 skips reproduction per §2.3.
5. Step 3 deletes the reassignable ids from `sentActivityIds` before the `pending` filter, and marks
   each returned placement `origin: 'returned'`.
6. `session.returnedCount` records how many came back, for §6.

The one-line summary: **Propose keeps using the Generation Log for what it knows, and lets D1
correct it about what it cannot know.**

---

## 6. UI

Two touches, both on the Review screen, both reusing what is there:

- Each returned item's origin already renders beside its type (`Practice · walked`, `packet.js:1448`).
  A returned item reads **`Practice · returned`**.
- When `returnedCount > 0`, a notice above the day list, in the same place and class as the
  already-live notice:

  > *3 items are back in this proposal because they were rescinded and never re-assigned. They are
  > placed at their position in the course, so work behind them moves later.*

No new screen, no new control, no new setting. The parent already decided the outcome when they
pressed Rescind; this tells them it landed.

---

## 7. Tests

**`tests/worker-routes.test.js`** (the fake-D1 harness):

1. `GET /api/assignments/reassignable` with a device token → 401; with the wall token → 401.
2. With no `childId` → 400.
3. With the parent token → 200, `{ activityIds: [...] }`, and the recorded SQL binds the child id,
   filters `kind = 'activity'`, and carries the `HAVING SUM(...) = 0` clause.

The three-case logic of §2.1 (rescinded-only / re-assigned / re-assigned-and-completed) is real
SQLite semantics, which the fake does not execute — it belongs to §7.1's manual checks, per the
harness's own note.

**Not unit-tested:** `packet.js` is not a pure layer (it reads IndexedDB and the network), so it has
no home in `tests/`. Its behaviour is covered by §7.1.

### 7.1 Manual acceptance

1. Assign a day of school. Leave one Math activity un-done. Rescind it from Assignments. Propose the
   next day: **the rescinded activity is in the proposal, marked `returned`, ahead of the lesson
   that follows it**, and the day's last item has moved out of the day.
2. Commit that proposal. Propose the same range again: the returned item is now **live** and frozen,
   not returned a second time.
3. Rescind an activity, re-assign it by Commit, then complete it on the child device. Propose again:
   it does **not** come back.
4. Rescind yesterday's chore. Propose today: today's occurrence of that chore is present exactly
   once, and yesterday's is not in the proposal at all.
5. **The fortnight case (§2.2a).** Commit two weeks of chores, rescind the whole batch, then propose
   a single day inside it, chores only: that day's occurrences are all present, exactly once each,
   and Commit sends them. Repeat for the next day and nothing from the first day appears.
6. Rescind an occurrence and then Commit it again on the same day. Propose that day a third time:
   the occurrence is shown **frozen** as already live, not offered twice.
7. **Drop** a chore at Review (not a rescind — it was never committed), then propose that day again:
   it stays suppressed, because a Drop is a decision and this slice does not touch it.
8. With the sync token cleared in Settings → Sync, Propose: no item is marked `returned`, no
   rescinded chore is re-offered, the already-live notice says the count came from the Generation
   Log, and nothing is lost.
9. Rescind an activity the parent had previously **Excluded** at Review: it stays out of the
   proposal (§1).

---

## 8. Build phasing

| Phase | Scope | Contents |
|---|---|---|
| 1 | Worker | The route, its SQL, and the three route tests (§4, §7). |
| 2 | `management-app/` | `loadCommittedKeys` returns both sets; the reassignable read; Steps 2 and 3; `origin: 'returned'`; the notice (§5, §6). |
| 3 | Docs | This slice's status, CLAUDE.md §I.A + §VII + §IX (§9). |

Phases 1 and 2 are one sitting, well inside the 2–3 hour gate. Phase 1 alone changes nothing a
parent can see; phase 2 without phase 1 would fail its fetch and fall back to today's behaviour, so
neither order can break a running app.

---

## 9. Guardrail amendments this requires

`CLAUDE.md` gains, in one commit with the code:

- §I.A's Management App **Data Flow** cell: `GET /api/assignments/reassignable`.
- §VII: a "Rescind feeds the generator" row — school returns, chores do not.
- §IX: version 2.10 and its entry.

**No narrowing is authorized here and no locked decision bends.** The route is a parent-credentialed
read of a table the parent already reads in full; it writes nothing, owns nothing, and adds no
credential class. Recorded, per §V.B, so the next session does not have to re-derive that this was
deliberate.

---

## 10. Open items

1. **A Move does not update the Generation Log.** `PATCH /api/assignments/:id` changes a live row's
   date; the log row keeps the date the item was committed on. §2.3's second test contains the
   consequence *for a rescinded row*, but a moved-and-still-live row can still be reproduced at its
   old date on a re-Propose of that range — where §6.6's live-key check catches it and freezes it,
   on the wrong day. Not a regression from this slice and not fixed by it. Worth a look if a parent
   starts using Move heavily.
2. **A rescinded *completed* row returns.** `POST /api/assignments/rescind` defaults to
   `status = 'pending'` and rescinding completed work takes a deliberate widening (§6.3). If a
   parent does that, the activity has no live row and comes back to the walk. That reads as correct
   — pulling back finished work is a statement that it did not count — but it has not been put to
   Ray, and no acceptance check covers it.
3. **Range-scoped `reassignable`.** The route reads a child's whole history each Propose. At two
   children and a nine-month year that is a few thousand rows in one aggregate — fine, and the cap
   reports truncation if it ever is not. If Propose ever gets slow, the fix is a `since=` bound,
   not a wider client-side read.

---

## 11. Revision log

| Date | Change |
|---|---|
| 2026-08-28 | Written. Ray's report (§0.1), the two gates (§0.2), the school/chore asymmetry in his own words (§0.4), one new read-only route (§4), Propose's two corrections (§5). Authorized in-session; no narrowing requested. |
| 2026-08-28 | **Amended within the hour, by Ray, against the first build (§2.2a).** "Chores are never re-proposed" was too strong and made a day whose own chores had been rescinded un-assignable — he had rescinded a committed fortnight to go back to daily assigning, and chores-only Propose came back empty. §2.2 now reads: a rescinded occurrence is offered again **for its own date and no other**. One condition in Step 4, no new read, no route change; §2.3 and everything about school are unchanged. New acceptance checks 5–7. |
