# Technical Design Specification — Slice
## M6 Scope: Management App — Chore Authoring, Family Event Authoring

*Covers: Chore Authoring (SRS Module 06, FR-1–FR-7) and Family Event Authoring (SRS Module 07, FR-1–FR-7). Written against Domain Model §2.6/§2.7/§3.5a/§3.5b, the Interchange Contract §4, Architecture Evaluation §5/§7/§8, SRS Modules 06/07, and `TDS_Slice_M4_Management_App_Rev3.md`/`TDS_Slice_M5_Management_App_Rev7.md` (store table and ID-scheme precedent).*

*Does not cover: Pacing Configuration or Packet Generation itself (SRS Module 05/08 — M7, including chore expansion and event fan-out, which read but do not write this slice's records), bulk CSV import (not offered for either module by design), reporting (M9), completion import (M10), backup/restore (M8), or anything Course/Lesson/Activity/Child (M5).*

*Status: buildable as written.*

---

## 0. Revision note

**Rev 2 — changes from Rev 1.**

1. **Token uniqueness: Rev 1's decision is reversed.** Rev 1 resolved the `choreToken`/`eventToken` uniqueness question as "no check, no re-roll — an accepted risk." That resolution contradicted two normative documents and is withdrawn. Both tokens are now **uniqueness-checked and re-rolled at mint**, matching the `instanceToken` precedent (M5 §1). See §1.

   - **Interchange Contract §3** states plainly that IDs are *minted globally-unique and never reused*, and that Completion Import's matching rule recovers a Chore row's ownership **by looking up the `CHR-{choreToken}` stem** — described there as "the one sanctioned ID parse anywhere in either app." Rev 1's premise that "Completion Import reconciliation is not relied upon here" was therefore false: the stem lookup *is* the reconciliation mechanism, and it is only sound if the stem is unique.
   - **`TDS_Slice_M1_Child_App.md` §2 (point 7) / §6 (check 9)** sanction exactly one duplicate-`id` exception — a multi-day Family Event repeating its `EVT-` id — and state that *a repeated Activity or Chore-occurrence id is always malformed*, with such a packet **rejected whole**. A same-child `choreToken` collision on a shared date therefore does not degrade gracefully; it fails that child's entire packet import.
   - The tradeoff Rev 1 claimed to buy ("simpler reschedule-after-a-collision handling") does not exist. At the household volume both SRS modules assume, and with full-store scans already the norm (§1, no-new-indexes), a mint-time uniqueness check is one scan plus a re-roll loop.

2. **`eventToken` follows `choreToken`.** Uniqueness is genuinely lower-stakes for Family Events (Module 07 §2.6 — no Activity Record, no CSV row, no Reward Ledger entry), but Interchange Contract §3's globally-unique rule is stated without carve-out, and the check costs the same. Checked and re-rolled, no special case. Note that the Child App's duplicate-`id` tolerance for `EVT-` ids (M1 §2, point 7) exists to permit a *multi-day repeat of one event*, not to absorb a collision between two different events — Rev 1 leaned on it for the latter, which it was never meant to cover.

3. **`blockHint` is a closed picker.** Rev 1 §3 both constrained `blockHint` to four values and said any other value "is accepted here without rejection." Only the first is true: it is a picker over `morning`/`afternoon`/`evening`/`night`, with no free-text path. Interchange Contract §1d's out-of-set → `morning` fallback is a defensive rule on the *child* side; this module cannot emit a value that triggers it.

4. **Acceptance checks 8 and 13 removed and replaced.** Rev 1's checks asserted that two mints "may legitimately produce the same token" — untestable as stated (a random collision cannot be deterministically provoked), and written expressly to stop a later session from correcting the defect. Replaced with checks that the re-roll path exists and works (§7, checks 8 and 13).

**No propagation required.** Rev 1 was the sole document out of step; the Domain Model, Interchange Contract, and Child App slices already assume unique tokens. Rev 2 brings this slice into line with them rather than changing them.

---

## 1. Decided here (TDS-level calls)

- **File list:** `chores.js` (Module 06, FR-1–FR-7) and `events.js` (Module 07, FR-1–FR-7) — both already named in Architecture Evaluation §7's fixed 14-file list. Neither file touches Course/Lesson/Activity/Curriculum/Difficulty-Tier/Reward-Category data; each reads only what its own validation needs (the `children` store, and for Chores, the `tiers` store).
- **ID minting:** `CHR-{choreToken}` (`chores.js`) and `EVT-{eventToken}` (`events.js`) — same short random base36 minting convention as `instanceToken`/`CUR-`/`COU-`/`LSN-`/`CHI-` (roughly 4 characters, e.g. `b4n1`, `t9x2`).
  - **Both tokens are uniqueness-checked at mint and re-rolled on collision** (Rev 2, §0). The check is *within the token's own namespace only*: mint a candidate, scan the store (`chores` or `familyEvents` respectively — a full scan, consistent with the no-new-indexes call below and cheap at this volume), and re-roll if the candidate is already in use. Bound the loop (e.g. 10 attempts) and surface a hard error rather than writing a duplicate if it somehow exhausts — a condition that should never occur at household scale and, if it ever does, means something is wrong that must not be papered over with a duplicate ID.
  - The check is performed inside the same transaction as the insert, so two rapid creations cannot both read "free" and then both write.
  - This is *not* about cross-namespace collision, which remains impossible regardless: the fixed `CHR`/`EVT` prefixes, combined with Module 03's reserved-literal guard on `courseCode`/`lessonCode`, already make every namespace disjoint from every other (Interchange Contract §4). What the check buys is **within-namespace** uniqueness, which Interchange Contract §3 requires ("minted globally-unique and never reused") and on which Completion Import's `CHR-{choreToken}` stem lookup depends.
- **No schema version bump.** `chores` and `familyEvents` were declared at v1 (`TDS_Slice_M4` §1, Q6) and have sat empty since. This slice is the first to write real rows into either — no store shape changes, no index changes, `managementAppDB` stays at version 2.
- **No new indexes.** Both SRS modules assume household-scale volume — "a handful of recurring chores per child, not hundreds" (Module 06 §2.2) and "a short list per child" (Module 07 §2.4) — the same reasoning that kept M4 index-free before `activities` forced M5's hand (M5 §2). A full scan of either store, filtered by `childId` in application code, is the right call at this volume; adding an index here would be solving a problem this app doesn't have. Revisit only if actual usage proves the assumption wrong (both SRS modules already flag this as a place to speak up if so).
- **`daysOfWeek[]` storage shape:** an array of the literal weekday abbreviations already used throughout the SRS and Domain Model — `"Sun"`, `"Mon"`, `"Tue"`, `"Wed"`, `"Thu"`, `"Fri"`, `"Sat"` — stored verbatim, non-empty, no duplicates. This is a Management-only field; it never crosses the interchange (Interchange Contract §5), so nothing external constrains its representation — this is simply the most direct encoding of the SRS's own vocabulary, not a value inferred from a fixture.

---

## 2. IndexedDB schema — `managementAppDB`, version 2 (unchanged)

No `onupgradeneeded` changes. Both stores already exist; this slice starts writing to them.

### Store table (additions to `TDS_Slice_M5_Management_App_Rev7.md` §2's table)

| Store | Key path | Shape | Written by |
|---|---|---|---|
| `chores` | `id` (`CHR-{choreToken}`) | `{ id, childId, title, choreType, daysOfWeek[], difficultyTier, notes?, blockHint? }` | `chores.js` (Module 06) |
| `familyEvents` | `id` (`EVT-{eventToken}`) | `{ id, title, startDate, endDate, childIds[], notes?, time? }` | `events.js` (Module 07) |

Both stores' rows are read (never written) by Packet Generation (M7) and by M4's Tier delete-guard (`chores` only, via `difficultyTier`).

**Notes**

- Neither store carries a `required` field — it is system-stamped by Packet Generation at expansion time (Module 06 §2.7), never authored here.
- `chores.daysOfWeek[]` and `familyEvents`'s date range never cross the interchange in their Management-side form; Packet Generation evaluates them once, at generation time, and emits dated occurrences/entries instead (Interchange Contract §5).
- `familyEvents.childIds[]` is a plain array field, not a multiEntry index — consistent with §1's no-new-indexes call, a list render filters in application code.

---

## 3. Chore Authoring (Module 06, FR-1–FR-7)

Owned entirely by `chores.js`.

**Create (FR-1).** The parent creates a Chore against a selected Child with `childId` (must resolve to an existing `children` row — read-only reference select, no on-the-fly Child creation), `title` (non-empty, trimmed), `choreType` (picker over the closed eleven-value enum — `Pet Care`, `Car Care`, `Kitchen/Dining`, `Bathroom`, `Living/Main Area`, `Playroom`, `Bedroom`, `Parent's Room`, `Porch`, `Floors`, `Miscellaneous` — never free text, no path to any other value), `daysOfWeek[]` (non-empty, subset of the seven abbreviations, §1, no duplicates), and `difficultyTier` (must resolve against the `tiers` store — Module 2, no create-on-the-fly). Optional: `notes`, `blockHint` — a **picker over the closed four-value set** `morning`/`afternoon`/`evening`/`night`, with no free-text path, exactly as `choreType` is a picker (Rev 2, §0). Leaving it unset is valid; emitting an out-of-set value is not possible from this module. (Interchange Contract §1d's "out-of-set `blockHint` displays under `morning`" is a defensive rule on the *child* side, for robustness against a malformed packet from any source; nothing in `chores.js` can trigger it. Do not build a fallback here.) On creation: mint `choreToken` with the uniqueness check and re-roll (§1), write `id = CHR-{choreToken}`, single-record write, no counter.

**Edit (FR-2).** Every field — including `choreType`, `daysOfWeek[]`, and `difficultyTier` — is editable at any time. `id` never changes. Changing `difficultyTier` affects only future occurrences' reward category (never retroactive to an Activity Record already produced — Domain Model §3.7's immutable-ledger-entry design). Changing `daysOfWeek[]` affects only future recurrence generation; already-delivered occurrences are untouched (§2.5 of the SRS).

**Delete (FR-3).** Explicit confirmation required (destructive: stops all future recurrence generation). Deleting a Chore row here does **not** touch anything already delivered to a child device, and does not alter any Activity Record already produced against one of its occurrence IDs — those become unmatched-by-source on the Management side going forward, the same accepted handling already given to a deleted Course Template's `sourceTemplateId` (Module 03 §2.4) and to unmatched Completion CSV rows generally (Domain Model §4.3).

**List/browse (FR-4).** Filtered by `childId` (application-level filter over a full scan of `chores`, §1 — no index). Shows at minimum `title`, `daysOfWeek[]`, `choreType`.

**Reference resolution (FR-5).** `difficultyTier` must resolve against `tiers`; rejected otherwise. No on-the-fly tier creation.

**No template/instance concept (FR-6).** A Chore is authored once, directly, against one Child. No stamping, no library, no "assign" action distinct from creation — `chores.js` has no code path resembling `children.js`'s stamp logic.

**Single-child only (FR-7).** `childId` is a single reference, not an array. No UI path in this module assigns one Chore record to more than one Child — a shared household chore is two separate records, one per child.

**Token minting (§0/§1).** `choreToken` is minted once at creation, **uniqueness-checked against existing `chores` rows and re-rolled on collision**, in the same transaction as the insert. It never changes thereafter — an edit, including a change of `childId`, never re-mints it.

Why this is not optional: the Chore *record* ID (`CHR-{choreToken}`, Management-side only) is the stem of every Chore *occurrence* ID (`CHR-{choreToken}-{YYYYMMDD}`), which is what Packets, Activity Records, and Completion CSV rows all carry (Interchange Contract §3). Two Chores sharing a token would produce (a) colliding occurrence IDs on any shared date, which the Child App treats as malformed and **rejects the whole packet** for (`TDS_Slice_M1_Child_App.md` §2 point 7), and (b) an ambiguous stem on Completion Import, whose matching rule resolves a Chore row's owning record by parsing exactly that stem (Interchange Contract §3) — misattributing rewards and corrupting Master Reporting. Occurrence-ID *determinism* per `(choreToken, date)` — which is what keeps re-generation idempotent — is only safe because the stem is unique.

---

## 4. Family Event Authoring (Module 07, FR-1–FR-7)

Owned entirely by `events.js`.

**Create (FR-1).** The parent creates a Family Event with `title` (non-empty, trimmed), `startDate`/`endDate` (both required, valid calendar dates, `startDate ≤ endDate`; equal values represent a single-day event — no separate single-day code path), and `childIds[]` (non-empty array, every entry must resolve against `children` — no on-the-fly Child creation). Optional: `notes`, `time` (freeform display string, unvalidated against span length — §2.7 of the SRS; no end-time field, no duration modeling). On creation: mint `eventToken` (§1), write `id = EVT-{eventToken}`, single-record write.

**Edit (FR-2).** Every field is editable at any time. Per the one-way interchange, an edit affects only future packet generation; a copy already delivered to a child device is unaffected and cannot be recalled or updated remotely.

**Delete (FR-3).** A lightweight confirmation step only — user-error protection, not a data-integrity guard, since nothing else in the system ever references a Family Event's `id` (Module 07 §2.6 — no Activity Record, no CSV row, no Reward Ledger entry is ever produced from one). Contrast explicitly with Chore or Course Instance deletion, which do carry dependent-data checks.

**List/browse (FR-4).** Filterable by child (application-level filter over a full scan of `familyEvents`, §1 — no index). Shows at minimum `title`, `startDate`–`endDate`, and the list of children it applies to.

**Reference resolution (FR-6).** Every entry in `childIds[]` must resolve against `children`; rejected otherwise.

**No completion concept (FR-7).** `events.js` introduces no mechanism that could ever produce an Activity Record, a CSV row, or a Reward Ledger entry for a Family Event.

**No recurrence (FR-5).** No "repeat weekly/monthly" option anywhere in this module's UI. A recurring real-world event is represented either as one record per occurrence or as a single date-range record, at the parent's discretion — this module doesn't distinguish or enforce either interpretation.

**Token minting (§0/§1).** `eventToken` is minted once at creation, **uniqueness-checked against existing `familyEvents` rows and re-rolled on collision**, mirroring `choreToken`.

The stakes are lower here — no Activity Record, no CSV row, no Reward Ledger entry is ever produced from a Family Event (Module 07 §2.6), so a collision could not corrupt reconciliation. It is checked anyway for two reasons. First, Interchange Contract §3 states the globally-unique/never-reused rule without carve-out, and a silent exception in one module is exactly the kind of thing that gets rediscovered as a bug later. Second — and this is the trap Rev 1 fell into — the Child App's duplicate-`id` validator *does* tolerate a repeated `EVT-` id, but only because a multi-day Family Event legitimately repeats **its own** id once per in-range day (`TDS_Slice_M1_Child_App.md` §2, point 7; Interchange §1c). That tolerance would silently swallow a collision between two *different* events, which is worse than rejecting it: the child device would show one event's title on the other's dates with nothing anywhere reporting an error. Check at mint; do not rely on downstream validation that was designed for a different case.

---

## 5. Permissions

No *additional* per-action PIN for either module. The Management App's `launchPin` gates the whole app once per session (Domain Model §2.11); neither `chores.js` nor `events.js` adds a further gate.

---

## 6. What this slice deliberately leaves open

- **No start/end scheduling for a Chore's recurrence** — a Chore recurs indefinitely on its `daysOfWeek[]` pattern until deleted (Module 06 §2.3, an explicit assumption in the SRS, not decided here). Flag if a scheduled end date turns out to be wanted.
- **No recurrence mechanism for Family Events** — each occurrence is its own record (Module 07 §2.3/FR-5, likewise an SRS-level assumption carried forward unchanged).
- **No bulk import for either module** — both SRS modules apply the same household-scale-volume reasoning (Module 06 §2.2, Module 07 §2.4). Architecturally additive if the assumption proves wrong; not built here.
- **Chore expansion and Family Event date-range fan-out** — still M7's Packet Generation (Module 08 FR-3/FR-4). This slice authors the definitions Packet Generation will read; it does not expand, filter, or emit anything itself.

---

## 7. Acceptance checklist for this slice

1. Creating a Chore with all seven days selected in `daysOfWeek[]` succeeds and behaves as an every-day chore; creating one with six days (e.g., every day except Saturday) succeeds identically, with no special-casing anywhere in validation.
2. Creating or editing a Chore with a `childId` that doesn't resolve to an existing Child is rejected; likewise for a `difficultyTier` that doesn't resolve to an existing Tier row.
3. Attempting to author a `choreType` outside the eleven-value enum is rejected at entry — the field is a picker with no free-text path.
4. No UI path in `chores.js` assigns one Chore record to more than one Child.
5. No UI path in `chores.js` offers a bulk/CSV import option.
6. Editing a Chore's `difficultyTier` or `daysOfWeek[]` at any time succeeds and has no effect on any Activity Record already produced against that Chore's already-minted occurrence IDs.
7. Deleting a Chore requires an explicit confirmation step and does not alter any already-delivered content or Activity Record.
8. **`choreToken` uniqueness holds.** With the token generator stubbed to return a fixed value, creating two Chores in succession still yields two rows with **distinct** `id`s — the second mint detects the collision, re-rolls, and writes a different token. No `chores` row ever shares a `choreToken` with another. (Test via the stub; a natural collision cannot be provoked on demand.)
9. Creating a Family Event with `startDate` equal to `endDate` succeeds (single-day); `startDate` before `endDate` succeeds (multi-day); `startDate` after `endDate` is rejected.
10. Creating a Family Event with an empty `childIds[]` is rejected; one with two or more children succeeds.
11. No UI path in `events.js` offers a recurrence/repeat option or a bulk/CSV import option.
12. Deleting a Family Event requires only a lightweight confirmation, with no dependent-data check of any kind.
13. **`eventToken` uniqueness holds** — same stubbed-generator test as check 8, against `familyEvents`. Two Family Events never share an `eventToken`.
14. `blockHint` is a picker with no free-text path; leaving it unset is accepted, and there is no code in `chores.js` that coerces or defaults an out-of-set value (that fallback lives in the Child App, not here).
15. `managementAppDB` still opens at version 2; no migration path is exercised by this slice, since `chores` and `familyEvents` already existed as empty stores.
16. `chores.js` contains no Family Event code and no Course/Lesson/Activity/Curriculum/Tier/Category CRUD; `events.js` contains no Chore code and no Course/Lesson/Activity/Curriculum/Tier/Category CRUD. Both read `children`; only `chores.js` also reads `tiers`.
17. Deleting a Tier referenced by at least one existing Chore is rejected by M4's Tier delete-guard (`activities`/`chores` scan) — the first time this guard has had real `chores` rows to find.
