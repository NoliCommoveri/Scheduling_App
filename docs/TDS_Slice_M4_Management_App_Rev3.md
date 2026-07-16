# Technical Design Specification — Slice
## M4 Scope: Management App Shell — `launchPin` Gate, Curriculum Library, Difficulty Tier & Reward Category

*Rev 3 — closes the three defects found in the Rev 2 review. Buildable as written, **once Appendix A's two propagation edits are made** (neither is M4 code; both are documents a later session will otherwise read wrong).*

*Covers only what Roadmap §5's M4 needs: `storage.js`, the router, the `launchPin` gate (Module 11, FR-1/FR-2 only), Curriculum Library (Module 01), and Difficulty Tier & Reward Category (Module 02). Written against Domain Model §2.2/§2.3/§2.5a/§2.11, Architecture Evaluation §6/§7/§9/§10, SRS Management Modules 01/02/11, the Interchange Contract, and the normative fixtures (`packet_schema.json`, `packet_sample.json` — the latter as corrected by `TDS_Decision_Tier_Reward_ID_Scheme.md`).*

*Does not cover Courses, Lessons, Activities, Children, stamping, pacing, chores, events, packet generation, reporting, completion import, or backup/restore. Those are M5+.*

---

## 0. Revision note

**Rev 3 (this revision)** closes three items from the Rev 2 review. Rev 2's §0 resolution log for Rev 1's eleven blocking questions is retained below as §0a — those resolutions all stand, unchanged, except where Rev 3 corrects how one of them was *justified*.

1. **The sequential ID counter had no home, and "never reused" was therefore unimplementable as written.** Rev 2's §1 locked the `D0#`/`R0#` scheme and stated that a deleted tier's number is never reused, but never said where the next number comes from. A build session reading Rev 2 would implement `max(existing) + 1` — which *does* reuse numbers after a delete (seed `D01`–`D03` → add `D04` → delete `D04` → the next mint is `D04` again), silently violating the rule. **Rev 3 adds a persisted counter in a new `meta` store, and puts it explicitly inside backup scope** — because a counter that isn't in backup scope collides on the first restore-to-a-new-device. See §1 and §2.
2. **Rev 2's theming-fallback justification was wrong, and the risk it dismissed is real.** Rev 2 §1 claimed a parent-added tier "correctly falls back to Theming's generic default forever, since no theme could have anticipated it." Under a *deterministic sequential* counter that is false — `R04` is perfectly predictable, so a theme author can and eventually will ship art for it. The hazard isn't unpredictability, it's that **`R04` means different things on different installs**: one family's `R04` is "Very Hard," another's is "Trivial," and the same art renders on both. The fallback is safe only because a rule says so, not because the ID scheme enforces it. **Rev 3 states that rule** (§1) and Appendix A propagates it to where the Theming session will actually read it.
3. **Two stale-document propagation chores**, neither of them M4 code, both of which will mislead a session that reads them: the M1 Child slice's sample JSON still teaches the rejected domain-split economy, and neither the Domain Model nor the Interchange Contract records the tier/category ID scheme at all. **Appendix A.**

Nothing in Rev 2's IndexedDB shapes, gate design, or delete-guards changed. A session already reading Rev 2 needs only §1's counter rule, §2's `meta` store, and §1's theming rule.

---

## 0a. Resolution log — Rev 1's blocking questions, closed (carried forward from Rev 2)

| # | Resolution | Landed in |
|---|---|---|
| **Q1** | **Option A** — a Reward Category is per-**tier**, never per-domain. The model was right; the fixture was wrong. `packet_sample.json` corrected (verified: `D01`→`R01` on a Chore *and* on an Activity, `D02`→`R02`, `D03`→`R03`). Shipped as `TDS_Decision_Tier_Reward_ID_Scheme.md`. | §1, §2 |
| **Q2** | **Option (c)** — `internalLabel` is a purely internal, never-rendered string. Set once from the tier's `label` at creation, never updated on rename, never read outside a debug view. | §2 |
| **Q3** | Confirmed — the three seeded `categoryId`s are fixed literal constants, identical on every install. **Deviates from Rev 1's literal proposal:** Rev 1 suggested semantic slugs (`cat-easy`); superseded by the opaque `D0#`/`R0#` scheme, because an ID must not encode a `label` that Module 02 FR-3 lets the parent rename freely. | §1, §2 |
| **Q4** | **Option A** — `storage.js` seeds the `activityTypes` store with §2.5a's 10 canonical rows at M4. Module 01 reads it; M5's Module 03 adds CRUD on top of an already-populated store. | §2 |
| **Q5** | Confirmed — `Curriculum.suggestedActivityTypes[]` stores `activityTypeKey` values, never `label`s. | §2 |
| **Q6** | **Option A** — `storage.js` declares the full Management schema at v1. Most stores empty until their owning milestone; no per-milestone version bump. | §2 |
| **Q7** | Confirmed — `launchPin` stored plaintext, as a documented accepted risk under the stated threat model. | §3 |
| **Q8** | Confirmed — session = one page-load lifetime; the unlocked flag is in-memory only. No idle timeout. | §3 |
| **Q9** | Confirmed — no failed-attempt limit, no lockout, no throttle. | §3 |
| **Q10** | **Accepted risk — Option (a).** No backup and no PIN recovery between M4 and M8; the mitigation is a one-time warning at initial PIN setup, made an explicit FR-1 requirement. | §3 |
| **Q11** | Confirmed — `navigator.storage.persist()` requested at initial `launchPin` setup completion; fire-and-proceed, denial never surfaced. | §3 |

---

## 1. Decided here (TDS-level calls)

- **Database:** `managementAppDB`, version 1. Entirely separate from `childAppDB` (Domain Model §5.3).
  - **Superseded at M5 — version 2.** The intent behind declaring every store at v1 (Q6) was to avoid ever bumping. That held for *stores*; it did not hold for **indexes**, which IndexedDB can only create inside `onupgradeneeded`, and which M5 needs the moment `activities` becomes the first unbounded store in the app. M5 bumps to **version 2** and adds indexes only — no store is added, removed, or reshaped. See `TDS_Slice_M5_Management_App_Rev5.md` §2. Nothing in M4's own behavior changes.
- **Curriculum ID:** `CUR-{token}`, `token` a short random base36 string. Alphanumeric segments, `-` delimiter. Never crosses the interchange, so nothing external constrains it, and it needs no well-known constants — which is why it uses a *different* minting strategy from tiers, deliberately and without inconsistency.

### Difficulty Tier / Reward Category ID scheme (Q1/Q3 — locked)

Opaque, sequential, zero-padded, minted in pairs.

- **Tiers:** `D01`, `D02`, `D03`, … **Categories:** `R01`, `R02`, `R03`, … A tier and its paired category are always minted in the **same creation call** (Module 02 FR-2/FR-6). The numbers stay in lockstep as a byproduct of that, never as a rule anything reads — no code derives one ID from the other.
- **The four seeded tiers are fixed literal constants**, identical on every install: Easy → `D01`/`R01`, Medium → `D02`/`R02`, Hard → `D03`/`R03`, **Very Hard → `D04`/`R04`** *(fourth tier added at M5; a device that already ran M4's three-tier seed is backfilled by the v2 upgrade — `TDS_Slice_M5_Management_App_Rev5.md` §2)*.
- **IDs are never derived from `label`, and never re-derived when a `label` changes** (Module 02 FR-3). This is the property the whole scheme exists to protect.
- **Zero-padding is a minimum width of two, not a ceiling.** `D09` → `D10` → … → `D99` → `D100`. IDs are opaque strings; nothing parses them, nothing sorts on them, and a three-digit tier is legal. Do not cap the counter at 99.

### The counter (Rev 3 — this is the piece Rev 2 was missing)

**Numbers are never reused, so the next number cannot be computed from the tiers that currently exist.** Deleting `D04` must not make the next mint `D04` again. A `max(existing) + 1` implementation is therefore **wrong** and is the single most likely way to build this incorrectly.

- **One shared, persisted counter**, `nextSeq`, in the `meta` store (§2), key `"idCounters"`. Tiers and categories share it because they are always minted together; two counters would only create a way for them to drift.
- Minting a tier: read `nextSeq` (seeded at `5`, since `D01`–`D04` are taken), format `D{pad2(nextSeq)}` and `R{pad2(nextSeq)}`, write both rows and `nextSeq + 1` **in one IndexedDB transaction**. Never mint outside a transaction that also advances the counter.
- **`meta` is inside backup scope** (Module 11 §2.2 — everything except the App Settings record). This is load-bearing, not a filing decision: if the counter lived in `appSettings` — which §2.3 permanently excludes from backup — then restoring a library onto a fresh device would give it `nextSeq: 4` while the restored data already occupied `D04`–`D07`, and the next tier the parent created would collide with an existing one. **The counter must travel with the data it numbers.**

### Theming may only key art to `R01`–`R03` (Rev 3 — corrects Rev 2's reasoning)

Rev 2 justified the generic-default fallback by claiming no theme could anticipate a parent-added category's ID. **That is false under a sequential scheme** — `R04` is entirely predictable. The real constraint is that **`R04` is not the same thing on two different devices**: it's whatever tier that particular parent happened to add fourth, so it might be "Very Hard" in one family and "Trivial" in another. Art keyed to `R04` would render correctly on one and nonsensically on the other.

So the rule is stated, not inferred:

> **A theme may ship reward art keyed only to `R01`, `R02`, and `R03` — the three seeded, install-invariant categories. Every other `categoryId` renders the generic default, always, no exceptions.**

This is not M4 code — M4 mints the same IDs either way — but it is an M4-originated constraint on the Child App's Theming module, and it must be written where that session will read it (Appendix A.2).

### Everything else

- **Name-uniqueness comparison (Module 01 §2.2/§5):** compare `name.trim().toLocaleLowerCase()`. Store the name as the parent typed it (trimmed); compare case-folded. On edit, exclude the record being edited.
- **Tier `order`:** contiguous integers from `0`, system-maintained (Module 02 §2.3). Seed is Easy=0, Medium=1, Hard=2, Very Hard=3. Move-up/move-down swaps two adjacent tiers' `order` values only. **`order` is display sequence and has nothing to do with `tierId`** — after a reorder, `D03` may sit at `order: 0`. Never sort by, or infer rank from, the ID.
- **Seeding runs in `onupgradeneeded` for v1**, atomically with store creation — including `meta`'s `nextSeq: 5` (four tiers seeded). A one-time seed, not a reset-able default: a parent who deletes all four tiers gets an empty table on reload, not a resurrection, because the upgrade never runs again. A wholesale restore (M8) can't re-trigger it either.
- **Router:** hash-based (`#/curriculum`, `#/tiers`, `#/settings`), a flat route→module-render map in `app.js`. Unknown or empty hash ⇒ Curriculum Library. Reachable only after the gate resolves (§3).
- **No `utils.js` at M4.** Architecture Evaluation §7 permits one for pure formatting helpers if a genuine cross-module need arises; M4 has none. Not created speculatively. (`pad2` is three characters of code inside `tiers.js`; it is not a cross-module need.)

---

## 2. IndexedDB schema — `managementAppDB`, version 1

Stores M4 actually reads or writes:

| Store | Key path | Shape | Written by |
|---|---|---|---|
| `appSettings` | fixed key `"appSettings"` (singleton) | `{ launchPin }` — Domain Model §2.11. **Excluded from backup forever** (Module 11 §2.3). | `settings.js` (Module 11, FR-1/FR-2) |
| `meta` | fixed key `"idCounters"` (singleton) | `{ nextSeq }` — the shared tier/category mint counter (§1). Seeded to `5` (four tiers seeded: `D01`–`D04`). **Inside backup scope** (Module 11 §2.2), unlike `appSettings` — see §1 for why that distinction is load-bearing. | `storage.js` (seed); `tiers.js` (advance, in the same transaction as a mint) |
| `curricula` | `id` | `{ id, name, publisherNote?, defaultCurriculumType?, suggestedActivityTypes? }` — optional fields **omitted, never `null`**. `suggestedActivityTypes[]` (Q5) stores **`activityTypeKey`** values, never `label`s. | `curriculum.js` (Module 01) |
| `tiers` | `tierId` | `{ tierId, label, order, rewardCategoryId }` — Domain Model §2.3. `tierId` uses the `D0#` scheme (§1); the three seeded rows are the fixed constants `D01`/`D02`/`D03`. | `tiers.js` (Module 02) |
| `rewardCategories` | `categoryId` | `{ categoryId, internalLabel }` — Domain Model §2.3. A separate store, not a nested field: Module 02 FR-5's immutable-mapping rule is structurally harder to violate by accident this way. `categoryId` uses the `R0#` scheme; seeded rows are `R01`/`R02`/`R03`. `internalLabel` (Q2) is set once from the tier's `label` at creation, never updated on rename, never read outside a debug view. | `tiers.js` (Module 02, at tier creation only) |
| `activityTypes` | `activityTypeKey` | `{ activityTypeKey, label, capturePattern, structurePattern }` — seeded at M4 (Q4) with Domain Model §2.5a's 10 canonical rows. Module 01's Curriculum authoring reads this store for its `suggestedActivityTypes[]` picker. M5's Module 03 adds CRUD on top of the already-populated store — a custom type added there appears in Curriculum authoring automatically, no rewiring. | `storage.js` (seed); `courses.js`/`activityTypes.js` (CRUD, M5) |

Stores declared at v1 but **empty until their milestone** (Q6): `courses`, `lessons`, `activities`, `children`, `pacingProfiles`, `chores`, `familyEvents`, `generationLog`, `importedCompletions`, `unmatchedRows`. M4 code touches exactly two of these — `courses`, `activities`/`chores` — read-only, for its delete-guards (§4).

**Notes**
- **Backup scope, restated because M4 is where it first bites (Module 11 §2.2/§2.3):** *everything except `appSettings`*. That includes `meta`. `appSettings` is the device-local credential; `meta` is data about the data, and it must move with it. When M8 is built, this is the store most likely to be forgotten — the structural scope rule already covers it, which is exactly why §2.2 was written structurally rather than as a hardcoded list.
- **Indexing: none at M4.** Consistent with Architecture Evaluation §6 and the M1 precedent. Delete-guards are full scans over stores that are empty at M4 and small for a long time after. If a guard on a large `activities` store is ever slow (M5+ volumes), adding a `difficultyTier` index is an additive version bump, not a redesign.
- **`internalLabel` never crosses the boundary.** Interchange Contract §5: no tier `label` crosses at all, and the child displays theme-skinned categories. Nothing in `rewardCategories` is child-facing; only the bare `categoryId` string travels, stamped onto packet entries at M7.

---

## 3. The `launchPin` gate (Module 11, FR-1/FR-2)

`app.js` owns the gate; `settings.js` owns the PIN's lifecycle. The gate runs **before the router**, and no module's view is rendered, and no store other than `appSettings` is read, until it resolves.

Boot sequence:

1. Open `managementAppDB` (creates + seeds on first ever run — schema, tiers, categories, activity types, and `meta.nextSeq: 4`, all in the one `onupgradeneeded` transaction).
2. Read `appSettings`.
3. **Absent ⇒ first-launch branch (FR-1).** Render the one-time setup screen: new PIN, entered twice. ≥4 digits, numeric (matching Child Module 11 FR-3). No skip path exists — not a hidden one, not a keyboard shortcut, not a URL that bypasses it. **The setup screen also displays a one-time, persistent-until-dismissed warning: "Write this PIN down somewhere safe. There is currently no way to recover it if forgotten, and forgetting it means losing everything you've authored."** (Q10 — this is the entire mitigation; no technical recovery path exists between M4 and M8, and none is being added now.) On success, write `{ launchPin }`, request `navigator.storage.persist()` (Q11 — fire-and-proceed; the browser's answer is never surfaced to the parent), and fall through to step 5 unlocked.
4. **Present ⇒ gate branch.** Prompt for the PIN. Compare against the stored value. No attempt limit (Q9 — unlimited attempts, no lockout, no delay). Nothing below the gate renders until it matches.
5. Unlocked. Set the in-memory flag (Q8 — a plain JS variable in `app.js`, written to nothing persistent: not `sessionStorage`, not `localStorage`, not IndexedDB), start the router.

**FR-2 (change PIN)** lives inside the gated app, on the Settings view: current PIN → new PIN → confirm new PIN. An incorrect current PIN rejects the whole change with no partial effect (no write, no state change, no "half-changed" PIN). On success the new value replaces the old in `appSettings` immediately; the old PIN stops working on the next gate check. No second gate, no re-prompt, no logout.

**No module below the gate re-checks it.** Domain Model §2.11 is explicit that "No PIN" in a module's Permissions section means *no additional* gate, not an unprotected app. Curriculum and Tier actions — including both deletes — are ungated beyond the launch PIN. The reference-guard *is* the safety mechanism; don't add a confirmation-PIN to a delete.

**`launchPin` storage (Q7):** plaintext, stored as entered. Accepted risk, not an oversight — the threat model is a curious child on a parent's device, not an attacker with disk access, and anyone who can open DevTools can read IndexedDB (or delete the record outright) regardless of hashing.

**Session lifetime (Q8):** one page-load lifetime. Reload, new tab, or reopened browser ⇒ re-prompt. No idle timeout.

---

## 4. The two delete-guards, and what they read

Both are reference checks against stores M4 doesn't own, and at M4 both always pass. Written as real code now — they become live the moment M5/M6 lands, and a guard that was stubbed and forgotten is exactly how a Course ends up pointing at a deleted Curriculum.

| Guard | Reads | Blocks when | Message must name |
|---|---|---|---|
| Curriculum delete (Module 01 FR-4) | `courses` — **both** `state: template` and `state: instance` | any Course's `curriculumId` matches | the blocking Courses **by name** (AC-4) |
| Tier delete (Module 02 FR-7) | `activities` **and** `chores` | any Activity's or Chore's `difficultyTier` matches `tierId` | a **count summary**, e.g. "Used by 12 Activities, 3 Chores" (FR-7) |

**The tier guard does not read Reward Ledger data, and this is not a gap.** The Management App structurally cannot see ledger data (Architecture Evaluation §5, guardrail 6, Module 02 §2.2). A deleted tier's category can still be referenced by a child's already-earned ledger entries, and that's fine and accepted — currency already earned is fungible and doesn't retroactively depend on the tier that minted it. Do not add a check for it, and do not import completion data to "improve" this guard.

**On a successful tier delete, the paired Reward Category row is deleted too** (Module 02 AC-6). Nothing else in the Management App references `categoryId`, so this leaves nothing dangling on this side of the boundary. **The counter is not rolled back** — `nextSeq` only ever advances (§1).

---

## 5. What this slice deliberately leaves open

- **The Roadmap §8 question — whether Activity Type gets split out of Module 03 into its own module and its own `activityTypes.js`.** Still open, still due before M5. Q4's resolution doesn't decide it: seeding the `activityTypes` *store* in `storage.js` is orthogonal to which module file owns its *CRUD*.
- **Everything M5+ owns:** stamping and `instanceToken` minting, `progressCursor`, the pacing walk, chore expansion, the Generation Log's write path, the backup file's own `schemaVersion` and shape, and the Completion CSV read path.
- **The `courseCode` uniqueness rule.** Not an M4 question — Module 03 owns it — but unanswered, and it will block M5. Flagged here so it doesn't surface mid-build.

---

## 6. Acceptance check for this slice

1. On a fresh origin (no IndexedDB), the app renders the FR-1 setup screen — including the write-it-down warning (Q10) — and **nothing else**: no router, no Curriculum list, no Tier list, no reachable view of any kind.
2. A PIN under 4 digits, a non-numeric PIN, and a PIN not matching its confirmation are each rejected, and no `appSettings` record is written.
3. After setup, `managementAppDB` exists at version 1 and contains **exactly three tiers** — Easy, Medium, Hard, in `order` 0/1/2 — with IDs `D01`, `D02`, `D03`, each paired to its own distinct `categoryId` (`R01`, `R02`, `R03`), with three matching rows in `rewardCategories` — **and a `meta` record of `{ nextSeq: 4 }`.**
4. **The counter never reuses a number.** Create a tier (mints `D04`/`R04`), delete it, create another: the new tier is **`D05`/`R05`**, not `D04`. Reload between steps and repeat — the result is unchanged, because the counter is persisted, not recomputed from the surviving rows. *(This is the single check most likely to fail on a first build — a `max() + 1` implementation passes every other test in this list and fails only this one.)*
5. A tier mint is atomic: if the `tiers` write, the `rewardCategories` write, or the `meta` advance fails, none of the three is committed and the counter has not moved.
6. Reloading the page re-prompts for the PIN. The unlocked state appears in no persistent store — verify by inspecting `sessionStorage`, `localStorage`, and IndexedDB after unlocking: nothing about the unlock is written to any of them.
7. An incorrect PIN at the gate renders no module view and reveals no data. Repeated wrong entries neither lock the app nor throttle it.
8. Changing the PIN with an incorrect current PIN is rejected with no write; immediately after a successful change, the new PIN — and only the new PIN — unlocks the app on the next reload.
9. Creating a Curriculum with only a `name` succeeds, and the stored record has **no keys** for the absent optional fields (not `null` values, absent keys).
10. Creating or renaming a Curriculum to an existing name differing only in case or surrounding whitespace ("saxon math " vs "Saxon Math") is rejected with a clear message.
11. Deleting a Curriculum succeeds at M4 (nothing can reference it yet) — and the guard code that will block it is present and executed, reading the `courses` store, not skipped or stubbed.
12. Creating a new tier mints a **new** `categoryId` that appears nowhere as a selectable option for any other tier, and no UI path anywhere allows changing an existing tier's `rewardCategoryId`.
13. Renaming a tier leaves its `tierId` and `rewardCategoryId` byte-identical; reordering tiers leaves every tier's `tierId` and `rewardCategoryId` byte-identical, and changes only `order`.
14. Deleting a tier succeeds at M4 and removes its paired `rewardCategories` row with it. The guard reads `activities` and `chores` and **never** reads or requests any ledger or completion data.
15. Deleting all three seeded tiers and reloading the app does **not** resurrect them — the seed is one-time, not a restored default. The counter is unaffected by the deletion.
16. The Curriculum authoring form offers all ten canonical Activity Types **including Drill**, sourced from the seeded `activityTypes` store (Q4), and selecting types is never enforced as a whitelist anywhere.
17. `curriculum.js`, `tiers.js`, and `settings.js` each render their own UI inline. There is no `ui.js`, and no `utils.js`.

---

## Appendix A — Propagation edits (not M4 code; make these before the build session starts)

Per the Roadmap §6 standing rule and Interchange Contract §6: a decision that lives in only one document is not decided. Three documents currently disagree with, or are silent on, what Rev 3 locks.

### A.1 — `TDS_Slice_M1_Child_App.md` §2 teaches the rejected economy

Its illustrative packet JSON still reads `"difficultyTier": "tier-medium", "rewardCategoryId": "cat-schoolwork"` on the Activity and `"tier-easy"` / **`"cat-chores"`** on the Chore — i.e. the exact per-domain split that Q1 rejected, in a live build document that a Child App session reads before writing its validator. It now contradicts the corrected golden fixture.

**Edit:** in the §2 sample, Activity → `"difficultyTier": "D02"`, `"rewardCategoryId": "R02"`; Chore → `"difficultyTier": "D01"`, `"rewardCategoryId": "R01"`. Add a Rev 5 note: *"Sample tier/category values corrected to the locked `D0#`/`R0#` scheme (`TDS_Decision_Tier_Reward_ID_Scheme.md`). The prior values also encoded a per-domain reward split that the model never permitted. No child-side behavior changes — the Child App never resolves either field (Interchange §1a) — and no `schemaVersion` bump."*

### A.2 — Theming has no rule saying which category IDs it may key art to

This is the one with a real failure mode attached (§1). It belongs in **Architecture Evaluation §10** (theme's role regarding the Reward Ledger) and in the Child App's Theming SRS module, not only here — M4's TDS is a document the Theming session has no reason to open.

**Add:** *"A theme may ship reward-category art keyed only to `R01`, `R02`, and `R03` — the three seeded, install-invariant categories (`TDS_Slice_M4` §1). Every other `categoryId` renders the generic default, always. Parent-added categories are sequential (`R04`, `R05`, …) and therefore predictable, but a given number means a different tier on every family's device — art keyed to one would render correctly on one install and nonsensically on the next."*

### A.3 — The ID scheme is recorded in neither the Domain Model nor the Interchange Contract

Domain Model §2.3 gives the shape of Tier and Category but no ID format, and Interchange Contract §4's ID table covers only item IDs (`Activity`, `Chore record`, `Chore occurrence`, `Family Event`) — even though `difficultyTier` and `rewardCategoryId` are values that cross the boundary on every packet entry. A future session has nothing stopping it from inventing a second scheme.

**Domain Model §2.3, add:** *"`tierId` and `categoryId` are opaque, sequential, minted-in-pairs IDs — `D01`/`R01`, `D02`/`R02`, … — never derived from `label` (which FR-3 lets the parent rename freely). The seeded three are fixed on every install: Easy `D01`/`R01`, Medium `D02`/`R02`, Hard `D03`/`R03`. Numbers are never reused after a delete."*

**Interchange Contract §4, add a bullet:** *"`difficultyTier` and `rewardCategoryId` are opaque strings (`D01`, `R01`, …), minted Management-side. Neither side parses them; the child mints its earn entry from `rewardCategoryId` verbatim and resolves `difficultyTier` against nothing. They are not part of the composite-ID grammar above and take no reserved prefix."*
