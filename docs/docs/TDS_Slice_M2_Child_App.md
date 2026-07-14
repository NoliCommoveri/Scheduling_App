# Technical Design Specification — Slice
## M2 Scope: Activity & Chore Completion, Deferment/Waive, Reward Ledger (earn), Streak, Completion CSV Export, Wipe (Child App)

*This is a deliberately narrow TDS slice — it covers only what's needed to build the Build Roadmap's M2 milestone: "complete/log activities and chores, Activity Records, deferment/waive, Reward Ledger earning (checkpointed) + Streak counter, completion CSV export with end-of-week reminder and recovery-note companion file, manual wipe (preserving pending work + ledger + streak)." It does not cover theming, reward *display*, or the parent-PIN spend/repair UI (all M3) — those are separate TDS work, done when their milestone is reached. Written against SRS Modules 4/5/6 (earn only)/7/8/9, the Interchange Contract, and Domain Model §3.6/§3.6a/§3.6b/§3.7/§3.8/§4.2 — reconciled against `packet_sample.json` and `completions_sample.csv`. Builds directly on top of `TDS_Slice_M1_Child_App.md` Rev 5; nothing in this document changes an M1 store shape, ID format, or validation rule.*

---

## 0. Revision note

**Rev 1 (this revision).** First TDS coverage of M2. Resolves the four items the Documentation Roadmap §4 named as open for this milestone:

1. IndexedDB additions for `activityRecords`, the Reward Ledger's two stores, and `streak` — a version 2 schema bump, additive only (M1 §4's note that these stores were "reserved for M2" is now fulfilled).
2. Reward Ledger checkpointing — snapshot shape, tail shape, and a concrete fold cadence (N = 100 tail entries per category, or on wipe — see §4).
3. Wipe's exact storage-level mechanics — which stores a wipe transaction touches, in what order, and the explicit guarantee that the Reward Ledger and Streak stores are never opened by it.
4. Streak's gap-catch-up algorithm — how "non-neutral day" and "resolved" are actually computed from stored data, since the Daily Plan itself is derived, not stored (M1 §4).

---

## 1. Why a slice, not the full TDS

M1's slice fixed the packet shape, ID formats, and the three-module IndexedDB layout needed before Modules 1–3 could be coded. M2 introduces four new stores and three modules (5, 8, 9) whose logic reads across stores M1 already defined (`activities`, `chores`, `plannerMeta`) plus the new ones below. This slice fixes only the concrete things M2's code needs to exist before it can be written:

1. The exact shape of `activityRecords`, the Reward Ledger's two stores, and `streak` (Modules 4/6/7 need these to exist before they can read or write anything).
2. The fold mechanics that keep the Reward Ledger bounded on a budget device (Domain Model §3.7 locks the *concept*; this slice locks the *number* and the *trigger*).
3. The wipe's transactional scope (Domain Model §3.6a locks *what* is preserved; this slice locks *how* that's enforced at the storage layer so it can't drift).
4. The streak's gap-catch-up computation (Domain Model §3.8 locks the *rule*; this slice locks how "day had required items" and "day was resolved" are actually derived from `activities`/`chores`/`plannerMeta`/`activityRecords`, since no day-level record exists anywhere in this app).

Everything else — theming, reward display, the parent-PIN spend/repair UI, Settings — remains open, for M3 and beyond.

---

## 2. IndexedDB schema additions (`childAppDB`, version 1 → 2)

A version bump adds four stores. No M1 store's key path, shape, or content changes.

| Store name | Key path | Shape | Written by |
|---|---|---|---|
| `activityRecords` | `activityId` (same value as the source `activities`/`chores` entry's `id` — 1:1, Domain Model §3.6) | `{ activityId, date, status, exported, grade? }` — `status` is `'complete'` \| `'waived'`; `exported` defaults `false`; `grade` present only when captured | Module 4 (create, `status: 'complete'`); Module 5 (create, `status: 'waived'`); Module 8 (`exported` flip only, `false → true`) |
| `rewardLedgerSnapshot` | `categoryId` | `{ categoryId, balance, asOfDate }` — one record per Reward Category the child has ever earned into | Module 4/5 fold logic (create on first earn into a new category; update on fold, §4 below) |
| `rewardLedgerTail` | `id` (autoIncrement integer) | `{ id, type, categoryId, amount, date, sourceId?, note? }` — `type` is `'earn'` \| `'spend'` \| `'adjust'` (only `'earn'` is written by anything in M2 scope; `'spend'`/`'adjust'` are M3/M11 writers, the store exists now so no further version bump is needed then) | Module 4 (`earn`, on every completion); Module 11 (`spend`/`adjust` — later milestone) |
| `streak` | fixed key `"streak"` (singleton) | `{ currentStreak, lastQualifyingDate }` — `lastQualifyingDate` absent/null until the first day ever qualifies | Module 7 (live increment, gap-catch-up reset); Module 11 (repair-form set — later milestone) |

**Notes:**

- `activityRecords` uses `activityId` as its own primary key rather than an autoIncrement key, because the relationship to the source item is exactly 1:1 (Domain Model §3.6) — a recurring Chore's many occurrences already have distinct occurrence IDs (`CHR-{choreToken}-{YYYYMMDD}`, M1 §3), so there is never a collision to resolve and never a need for a compound key.
- `rewardLedgerTail` is the one new store using an autoIncrement key rather than a natural one — tail entries have no natural unique field (`categoryId` repeats, `date` repeats, `sourceId` is only present for earns and is itself just the completed item's id, which can in principle recur across the app's lifetime only if a store were ever reused, which it isn't). AutoIncrement is the simplest correct choice.
- `streak` follows the same singleton-fixed-key pattern M1 established for `child`/`semester`/`themeSettings` — there is exactly one record, ever.
- This is a genuine `onupgradeneeded` version bump (1 → 2), not a fresh database. Existing `child`/`semester`/`themeSettings`/`activities`/`chores`/`events`/`plannerMeta` data and content are untouched by the upgrade; the four new object stores are simply created if absent.

---

## 3. Activity & Chore Completion (Module 4) — mechanics

**Write path.** Completing an item from the Daily Planner's entry point (M1 Module 3, FR-7) does three things in one logical operation (not necessarily one IndexedDB transaction, since the ledger fold in step 3 may itself span two stores — see §4):

1. Writes `{ activityId: id, date: todayLocal, status: 'complete', exported: false, grade? }` to `activityRecords`, keyed by the item's own `id`.
2. Appends `{ type: 'earn', categoryId: item.rewardCategoryId, amount: 1, date: todayLocal, sourceId: id }` to `rewardLedgerTail`, and runs the fold check (§4).
3. Signals Module 7 (Streak) to re-evaluate today — see §5's "live path."

**Grade capture** happens before step 1, gated on the item's stored `capturesGrade` boolean (never on `activityType` — M1 doesn't store Activity Type as an entity, only this boolean, per Domain Model §2.5a). An invalid grade (outside 0–100, non-integer) blocks the whole write; the item remains uncompleted.

**Idempotency guard.** Before writing, check whether `activityRecords` already has a record for this `id`. It shouldn't be reachable twice from the UI (a completed item leaves the pending list), but the write path itself defends against a double-tap race by treating an existing record as a no-op rather than double-earning.

---

## 4. Reward Ledger — fold mechanics

Domain Model §3.7 locks the *shape* (snapshot + tail) and the *concept* (fold on N entries or on wipe); this slice locks the number and the exact trigger, since a budget-device store needs a concrete bound.

**Fold cadence: N = 100.** After every tail append, count the tail entries currently stored **for that entry's `categoryId`** (a single-index scan — cheap at M1/M2 volumes, consistent with Architecture Evaluation §6's "no indexing needed yet" call). If the count reaches 100, fold immediately:

1. Read the category's current `rewardLedgerSnapshot` record (or treat balance as 0 if none exists yet — a category's first-ever earn).
2. Sum every `rewardLedgerTail` entry for that `categoryId` (respecting the zero-floor: a negative `adjust` can't take the running sum below 0 — not reachable in M2 scope since only `earn` is written here, but the fold logic is written once and must already hold for M3's `spend`/`adjust`).
3. Write the new snapshot: `{ categoryId, balance: newSum, asOfDate: todayLocal }`.
4. Delete every folded tail entry for that `categoryId` (their `id` keys, via a cursor over the `categoryId` values already read in step 2 — no secondary index needed, a linear scan is fine at this volume).

**Fold-on-wipe is a Module 6 concern triggered by the wipe event, not a Module 9 write.** Domain Model §3.7 ties folding to "on a wipe, or every N entries," but Wipe's own FR-6 (Module 9) is explicit that the Reward Ledger is *never touched* by the wipe transaction — preserved unconditionally, byte-for-byte. These two statements are reconciled as follows: when the child's wipe-and-export routine runs, the Reward Ledger's own fold routine (§4 above) is invoked as a **separate, independent operation**, alongside the wipe but not inside its transaction and not as one of its writes. The fold *compacts* the tail into the snapshot — it changes storage shape, never balance — so it's consistent with "never cleared" even though it does write to `rewardLedgerSnapshot`/`rewardLedgerTail`. If this distinction ever needs to be re-litigated, treat Module 9's FR-6 (no wipe-transaction writes to the ledger) as controlling over any implementation convenience; do not fold *inside* the wipe transaction.

**Balance read (used by the recovery note, §6, and by M3's display, not built here):** `balance = snapshot.balance + sum(tail entries for that categoryId)`. Read-time computation, never stored directly — Domain Model §3.7's rule.

---

## 5. Streak (Module 7) — gap catch-up mechanics

No day-level record exists anywhere in this app (M1 §4: the Daily Plan is derived, never persisted). Module 7 therefore needs its own way to answer, for an arbitrary past device-local date: *did this date have required items, and were they all resolved?* — without a `dailyPlan` store to consult.

**Effective due date, reused from M1.** As already defined in M1 §4 for the Daily Planner: an item's effective due date is `plannerMeta.deferredDate` when present, else the item's own `date` (`activities`/`chores`). Streak reconciliation uses this same effective date, not the raw one — a rescheduled item's *original* date is judged only on whether it was rescued (§5's "resolved" test below), and its *new* date is where it counts as due.

**"Had required items due" for date D:** at least one `activities` or `chores` record where (a) `required` is `true`, and (b) its effective due date equals `D`.

**"Was resolved" for date D:** every item matching the above test for `D` has, as of the moment reconciliation runs, either:
- an `activityRecords` entry (`status: 'complete'` or `status: 'waived'`), **or**
- an effective due date that is no longer `D` (i.e., it was rescheduled away from `D` — Module 5's Reschedule updates `plannerMeta.deferredDate`, which moves the item out of `D`'s due set entirely by the time reconciliation looks at it).

This matches Domain Model §3.8 and Module 5 FR-4 exactly: a day rescued by completion, waiver, *or* reschedule-away all count as resolved, because rescheduling changes which date the item is "due-and-required" against — reconciliation for `D` simply no longer finds it there.

**Live path (FR-1, same-day).** On every completion or waive (Module 4/5), after the write, check today: does today have any required item whose effective due date is today and which lacks a resolving `activityRecords` entry? If none remain, and `lastQualifyingDate` is not already today, increment `currentStreak` and set `lastQualifyingDate` to today. This is a live check, not a stored flag — cheap at M1/M2 volumes (a handful of items per day).

**Gap catch-up (FR-3, on every app open).** Walk device-local dates from `lastQualifyingDate + 1` up to (not including) today:
- If a date has no required items due (per the test above), skip it — neutral.
- If a date has required items due, check whether it was resolved (per the test above, evaluated *at open time*, i.e. reflecting anything since resolved, including a later waive or reschedule). If resolved, continue. If not, **`currentStreak` resets to 0** and the walk stops immediately (Module 7 §5's ordering rule — the first breaking day found is authoritative, no need to keep walking).
- If the walk completes without finding a breaking day, `currentStreak` is unchanged; `lastQualifyingDate` is *not* advanced to yesterday just because the gap was clean — it only ever advances via the live same-day path (FR-1) or this reconciliation's own reset-to-0 case, matching FR-4 ("today is only ever evaluated as a breaking day in retrospect" — the walk never touches today).

**Cost note.** The walk is bounded by however many days elapsed since `lastQualifyingDate`, times a full scan of `activities`/`chores`/`plannerMeta`/`activityRecords` per candidate date — acceptable at M1/M2 volumes per the same no-indexing call as Architecture Evaluation §6. If this ever needs to scale (a child not opening the app for months), the fix is a `date` index on `activities`/`chores`, not a redesign of the algorithm above.

---

## 6. Deferment / Waive (Module 5) — mechanics

**Reschedule** writes only to `plannerMeta`: `{ id: item.id, deferredDate: newDate }` (merging with any existing `sortOrder`/`blockHint` on that same `plannerMeta` record — this is an upsert into a store M1 already defined, not a new store). No `activityRecords` write, matching FR-2's "does not create or modify an Activity Record."

**Waive** writes `{ activityId: id, date: todayLocal, status: 'waived', exported: false }` to `activityRecords` — the same store and shape Module 4 writes to, just a different `status` value and no `grade` (Chores never capture one; Activities being waived rather than completed never captures one either, since no completion happened). No Reward Ledger write (FR-6 — neither action earns).

Both actions require the parent PIN entered correctly immediately before the write (FR-1); a wrong PIN aborts with no partial write to `plannerMeta` or `activityRecords`.

---

## 7. Completion CSV Export (Module 8) — mechanics

**Eligible-record query.** Scan `activityRecords` for entries where `status` is `'complete'` or `'waived'` **and** `exported` is `false`. At M1/M2 volumes this is a full scan (no index defined on `status`/`exported` — same no-indexing call as elsewhere in this slice; if volumes ever justify it, a compound index is an additive change).

**Row assembly.** For each eligible record, look up the source item by `activityId` in `activities` first, then `chores` if not found (an `activityId` belongs to exactly one of the two stores, never both, since `activities`/`chores` share no ID namespace overlap — M1 §3's prefix patterns are disjoint by construction). Populate the locked eleven columns (Interchange Contract, Domain Model §4.2) exactly as Module 8 §3 specifies:

- `activityId`, `date`, `status`, `grade` — straight from the `activityRecords` entry.
- `course`, `activity`, `activityType`, `plannedBlock`, `sequenceNumber` — from the source item (`courseName`, `title`, `activityType`/`choreType`, `blockHint`, `sequenceNumber`), with `course` and `sequenceNumber` left blank for Chore rows and page-range Activities respectively, per Module 8 §3's table.
- `childName`, `semesterLabel` — read once from the `child`/`semester` singleton stores, reused for every row in the file (not a per-row lookup).

**Write, in one pass.** All eligible rows are assembled into a single in-memory CSV (header row first, exactly the locked eleven column names, RFC 4180) and offered as one file save. Only after the save succeeds does a second pass flip `exported: true` on every included `activityRecords` entry — this ordering is what makes FR-4's "a failed export leaves every record's eligibility exactly as it was" true by construction: if the save never completes, the flip-pass never runs.

**Filename**, per Interchange Contract §7 (already locked, not re-decided here): `completions_{childSlug}_{YYYYMMDD-HHmm}.csv`, device-local timestamp at the moment of export.

**Recovery note**, written as a second file in the same user-facing save action (not gating the CSV's success — FR-8/note-write independence): plain text containing device-local date, `streak.currentStreak` (read, not recomputed), and for every category present in `rewardLedgerSnapshot` (plus any category with tail-only entries not yet folded — the same `snapshot + sum(tail)` read as §4's balance formula), `{ categoryId, themeDisplayName, balance }`. **`themeDisplayName` is a placeholder/internal-name value in M2** — the actual Theme display-mapping table (Domain Model §3.9) doesn't exist until M3's theming module lands; until then the note may show `categoryId` itself in that field. This is a deliberate, temporary gap, not an M2 defect — flagged here so M3's theming work knows to revisit this one line once the display-mapping store exists. Filename: `recovery_{childSlug}_{YYYYMMDD-HHmm}.txt`, sharing the CSV's exact timestamp stem.

**End-of-week reminder (FR-7).** On app open, if `today − lastSuccessfulExportDate ≥ 7` days **and** at least one eligible record exists (the same query as above, cheaply short-circuited — stop scanning at the first match), show the reminder. `lastSuccessfulExportDate` is not a new store — it's derived as `max(date)` over any `activityRecords` entry with `exported: true`, or, if none exist yet, treated as "never," which always satisfies the ≥7-day condition once any record is eligible. No new store needed for this derivation at M2 volumes.

---

## 8. Wipe (Module 9) — mechanics

**Transactional scope, stated explicitly (the concrete thing Domain Model §3.6a leaves to the TDS).** A wipe runs as a single IndexedDB transaction opened against exactly four stores: `activityRecords`, `activities`, `chores`, `events`. **`rewardLedgerSnapshot`, `rewardLedgerTail`, and `streak` are never included in the transaction's scope at all** — not read, not opened — which is what makes Module 9 FR-6's "never touches either, under any circumstance" a structural guarantee rather than a discipline the code has to remember.

**Deletion pass, within that transaction:**

1. Cursor over `activityRecords`. For each entry where `exported` is `true` (status is necessarily `'complete'` or `'waived'` already, by construction — nothing else is ever written there): delete the `activityRecords` entry, then delete the matching-`id` entry from whichever of `activities`/`chores` holds it (FR-2/FR-3 — cleared as a pair, never independently).
2. Cursor over `events`. For each entry where `endDate` (or `startDate` if no `endDate` — the same field the Daily Planner already reads for a Family Event's date, M1 §2/§4) is strictly before device-local today: delete it (FR-4).

**Everything else is untouched by construction**, not by a rule that has to be separately checked: still-pending items are never visited (their `activityRecords` entry doesn't exist yet, or exists with `exported: false`, either of which fails step 1's condition); `child`/`semester`/`themeSettings`/`plannerMeta` stores are never opened by this transaction at all (FR-7 — a `plannerMeta` record for an item that just got deleted becomes an orphan pointing at a no-longer-existent id, which is harmless: nothing ever looks up `plannerMeta` except by starting from an `activities`/`chores` id that still exists, so an orphaned `plannerMeta` row is simply never read again. It is left in place rather than hunted down and deleted, since deleting it would mean opening a fifth store for a cleanup that buys nothing observable).

**Confirmation (FR-8).** A single client-side "are you sure" step gates the call into this transaction. No PIN.

---

## 9. Cross-module interaction summary (for a future single-module edit)

- **Module 4 writes `activityRecords` and `rewardLedgerTail`, and triggers Module 7's live check.** A future edit to Module 4 that adds a new completion path must still perform all three, or Streak/Ledger will silently desync.
- **Module 5's Reschedule writes only `plannerMeta`; its Waive writes only `activityRecords`.** Neither ever touches `rewardLedgerTail` (FR-6) — a future edit adding some other "resolution" action must preserve this, or the flat-earn rule (Domain Model §3.7) is silently broken.
- **Module 7 reads `activities`/`chores`/`plannerMeta`/`activityRecords`, and writes only `streak`.** It never writes to any store it reads from.
- **Module 8 reads `activityRecords`/`activities`/`chores`/`child`/`semester`/`rewardLedgerSnapshot`/`rewardLedgerTail`/`streak`, and writes only `activityRecords.exported`.** This is the one module with a read dependency on nearly everything else in M2 scope — noted in SRS Module 8 §8 already, restated here because it's the concrete list a future edit to any of those stores needs to check against.
- **Module 9 reads/writes `activityRecords`/`activities`/`chores`/`events` only**, and structurally cannot touch the Ledger or Streak stores (§8 above) — this is the strongest guarantee in this slice, enforced by transaction scope rather than by a check in the code.
- **The Reward Ledger's fold (§4) is invoked from two places:** Module 4's earn path (count-triggered) and the wipe-adjacent routine mentioned in §4 (still a separate call, never inside Module 9's transaction). Both call the same fold function; there is exactly one fold implementation, not two.

---

## 10. What this slice deliberately leaves open

- The Theme display-mapping table for reward categories (Domain Model §3.9) — M3. The recovery note's `themeDisplayName` placeholder (§7) is the one concrete spot in M2 that's waiting on it.
- The parent-PIN-gated spend/`adjust` UI (Module 11/Settings) — M3+. The `rewardLedgerTail` store already has a `type` field wide enough for `'spend'`/`'adjust'` so no version bump is needed when that lands.
- The parent-PIN-gated Streak repair form (`currentStreak`/`lastQualifyingDate` direct set, Module 11) — M3+. `streak`'s shape already supports it.
- Any secondary IndexedDB index (on `activityRecords.status`/`exported`, or on `activities`/`chores.date`) — not needed at M1/M2 volumes per Architecture Evaluation §6's standing call; noted at each relevant point above (§5, §7) as the specific place a future volume-driven change would land.
- Completion Import (Management-side) — Phase 4/M10, out of Child App scope entirely.

---

## 11. Acceptance check for this slice

Before handing Modules 4/5/7/8/9 to a build session, confirm:

1. `childAppDB`'s version bump from 1 to 2 creates exactly the four stores in §2, with no change to any M1 store's key path or content, verified by opening a database seeded with M1 data and confirming it upgrades without data loss.
2. Completing an Activity with `capturesGrade: true` and a valid grade writes an `activityRecords` entry with that grade; completing one with `capturesGrade: false`, or any Chore, writes an entry with no `grade` key at all (not `null`, not blank — absent).
3. Completing an item appends exactly one `rewardLedgerTail` entry with `amount: 1` and the item's own `rewardCategoryId`; completing 100 items in the same category triggers exactly one fold, leaving a single `rewardLedgerSnapshot` record for that category and zero remaining `rewardLedgerTail` entries for it.
4. Rescheduling a required item updates only `plannerMeta.deferredDate`; no `activityRecords` or `rewardLedgerTail` entry is created. Waiving one creates an `activityRecords` entry with `status: 'waived'` and no `grade`, and still no ledger entry.
5. A day whose only required item was rescheduled away, waived, or completed all independently satisfy the Streak's "resolved" test (§5) and are confirmed, by test, not to break the streak.
6. Reopening the app after a simulated multi-day gap that included at least one unresolved required day resets `currentStreak` to 0; a gap with only neutral and/or resolved days leaves it unchanged.
7. A triggered Completion CSV export produces a file matching `completions_sample.csv`'s exact column order and per-row shape (including the Chore row's blank `course` and populated `activityType`), given equivalent underlying records, and flips `exported: true` only on the records included.
8. Simulating a failed CSV write leaves every candidate record's `exported` flag unset, and a retry afterward includes those same records.
9. A wipe run against a mixed dataset (pending items, resolved-not-exported items, resolved-and-exported items, past and future Family Events) clears only the resolved-and-exported items (with their paired as-received entries) and past Family Events — verified by asserting, in the same test, that `rewardLedgerSnapshot`, `rewardLedgerTail`, and `streak` are byte-for-byte unchanged before and after.
10. No code path in Modules 4/5/7/8/9 opens the `rewardLedgerSnapshot`, `rewardLedgerTail`, or `streak` stores from within the wipe's own IndexedDB transaction (inspectable directly from the transaction's declared store list, not just by behavioral test).
