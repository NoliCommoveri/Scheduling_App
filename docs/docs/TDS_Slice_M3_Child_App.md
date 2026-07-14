# Technical Design Specification — Slice
## M3 Scope: Theming, Reward *Display* + Spend, Settings + Repair Form (Child App)

*This is a deliberately narrow TDS slice — it covers only what's needed to build the Build Roadmap's M3 milestone: "theming + reward display" — the CSS-variable theme system, the palette and signature themes, the per-Reward-Category display mapping with generic-default fallback, the parent-PIN spend/deduct UI, and the PIN-gated repair form (balance adjust + streak set). It is the **final Child App milestone**: after M3 the Child App SRS is fully realised (Modules 1–11), and everything remaining (M4+) is Management App, out of this app's scope entirely. Written against SRS Modules 6 (display + spend), 10 (Theming), and 11 (Settings), the Interchange Contract, and Domain Model §3.7/§3.7a/§3.8/§3.9. Builds directly on top of `TDS_Slice_M2_Child_App.md` Rev 1 and `TDS_Slice_M1_Child_App.md` Rev 5; **nothing in this document changes an M1 or M2 store shape, key path, ID format, or validation rule**, and — as §2 shows — it introduces no new IndexedDB store and no schema version bump at all.*

---

## 0. Revision note

**Rev 2 (this revision).** Folds in the reward-category expansion from 3 to 4 and pins down the concrete per-signature-theme reward-icon mapping the SRS defers to this document. Three changes — none touches a store shape, ID format, or validation rule:

1. **Reward categories/tiers expanded 3 → 4 (ids `R01`–`R04`).** The Difficulty Tier & Reward Category reference table is now seeded with 4 base tiers, the 4th being **"Very Hard"** (Domain Model §2.3, Roadmap M4 — both seeded Management-side, with labels/order deferred to the TDR). This is **Management-scope seed data**; on the Child App side it has **zero schema impact** — `rewardCategoryId` is a value carried on received items and on `rewardLedgerTail` entries, so more distinct category ids means more data, never a different shape (§2). The child never sees the tier label (`internalLabel` is kid-invisible, Domain Model §2.3) — it sees only the active theme's art for that category id.
2. **The concrete per-category icon mapping for both signature themes is specified here (§3).** SRS Module 10 §2 and AC-9 explicitly defer "the specific per-category design (labels, icons, visual treatment)" to the TDR, so it lands in this slice rather than the SRS. Stable uses **ribbons** (R01 white, R02 yellow, R03 red, R04 blue) — reserved for the reward icons and **not reused elsewhere in that theme's visuals** — and Builder uses **resources** (R01 leather, R02 iron, R03 gold, R04 diamond).
3. **The generic-default fallback is reframed as a beyond-base safety net (§4).** With both signature themes now naming all 4 base categories bespoke, the generic default is never what a child sees for R01–R04 under a signature theme; it only catches a category *outside* the seeded base set — e.g. a parent adds a 5th tier Management-side. This matches Module 10's new AC-9 ("no base category falls through to the generic default in either theme") without weakening FR-3's "never breaks when a new tier is added."

**Rev 1.** First TDS coverage of M3. Two open items were carried in from the earlier slices and are closed here; two scoping decisions were made explicitly.

Closed from prior slices:

1. **The Theme display-mapping for Reward Categories** (Domain Model §3.9; flagged open in M2 §10). Resolved in §3/§4 below — it lives in the build-time theme bundle, not in IndexedDB, so it adds no store and cannot drift a persisted schema.
2. **The recovery note's `themeDisplayName` placeholder** (M2 §7 wrote `categoryId` into that field as an admitted temporary gap "for M3 to revisit"). Resolved in §9 — the note now resolves each category's display name through the active theme's mapping, with the same generic-default fallback the on-screen display uses.

Decisions made in this slice:

3. **Field name: `theme`, not `themeId`.** The theme selection field is `theme` throughout — the name already used by the Domain Model (§3.9, and Child's optional field), Module 1 (capture and storage), and the M1 slice's `themeSettings` store (`{ theme }`). Module 10's SRS text calls the same field `themeId`; that is one module's local wording for the identical field, and this slice standardises on `theme` so no code inherits a two-name ambiguity (§8).
4. **Two signature themes, not one.** The Roadmap's M3 one-liner says "one signature theme," but SRS Module 10 §2 specifies two being built (Horse Lover "Stable" and the Builder theme), and Architecture Evaluation §10 allows "one or two." This slice builds **both** (§3). This is a Roadmap-summary refinement, not a design change — the parent runs two kids on two independent single-child devices, and each child picks either signature theme (or any palette theme) on their own device; both must therefore ship in the bundle. It has **zero** data-model impact: a theme is a bundle asset, and the `theme` field simply holds whichever id was chosen.

---

## 1. Why a slice, not the full TDS

M1 fixed the packet shape, ID formats, and the Modules 1–3 store layout. M2 added the four completion/ledger/streak stores and their write mechanics, and — deliberately — pre-provisioned the two things M3 needs to *write* without touching the schema again: the `rewardLedgerTail.type` field was made wide enough for `'spend'` and `'adjust'` at M2, and the `streak` singleton's shape (`{ currentStreak, lastQualifyingDate }`) was made repair-form-ready at M2. As a result M3 is almost entirely a **presentation-and-write-path milestone over stores that already exist**, plus build-time theme assets.

This slice therefore fixes only the concrete things M3's code needs before it can be written:

1. That M3 adds **no** IndexedDB store and **no** version bump, and *why* that is correct rather than an oversight (§2).
2. Where the per-Reward-Category display mapping lives, and how the generic-default fallback resolves (§3, §4) — the one genuinely new data structure in M3, and the reason it is bundle-resident rather than persisted.
3. The exact **balance-read computation** now that decreasing entry types (`spend`, `adjust`) actually get written — refining M2's `snapshot + sum(tail)` into the ordered, per-step zero-floored fold the two entry types require, and proving it agrees with M2 wherever M2 applies (§4).
4. The spend, adjust, and streak-set write paths and their gating (§5, §6).
5. The Settings screen's PIN-gate-on-entry, and the structural rule that the theme switcher and the Wipe button must have their own **ungated** entry points so they are not incidentally gated by nesting (§7).

---

## 2. IndexedDB — no change (`childAppDB` stays at version 2)

**M3 adds no object store and performs no `onupgradeneeded` version bump. `childAppDB` remains at version 2 (M2's version).** This is a positive design result, not an omission — every value M3 persists already has a home:

| What M3 writes | Where it goes | Provisioned by |
|---|---|---|
| `spend` ledger entry (Module 6 FR-4) | `rewardLedgerTail`, `type: 'spend'` | M2 §2 — `type` union already includes `'spend'` |
| `adjust` ledger entry (Module 11 FR-7a) | `rewardLedgerTail`, `type: 'adjust'` | M2 §2 — `type` union already includes `'adjust'` |
| Streak repair set (Module 11 FR-7b) | `streak` singleton — `currentStreak` + `lastQualifyingDate` | M2 §2 — shape already supports a direct set |
| Child name edit (Module 11 FR-1) | `child` singleton — `name` | M1 §4 — Module 11 named as later editor |
| Semester label edit (Module 11 FR-2) | `semester` singleton — `label` | M1 §4 — Module 11 named as later editor |
| PIN change (Module 11 FR-3) | `child` singleton — `pin` | M1 §4 / Domain Model §3.2 |
| Theme selection change (Module 10) | `themeSettings` singleton — `theme` | M1 §4 — Module 10 named as later editor |

**The 3 → 4 category expansion (Rev 2) changes nothing here either.** `rewardCategoryId` is a value on received items and on `rewardLedgerTail` entries; going from three category ids to four (`R01`–`R04`) adds data, never a store or a shape. Nothing in M1/M2's schema hard-codes a category count, so no migration and no version bump follows from the expansion.

**The per-Reward-Category display mapping is not stored in IndexedDB at all** — it is part of each theme's build-time bundle (§3). This is deliberate and load-bearing: category ids are minted on the Management side and arrive on items; a parent can add a new difficulty tier (and its paired category) at any time (Module 10 FR-3). Persisting a child-side mapping keyed by those ids would (a) require a store that must stay in step with ids the child device never authors, and (b) add a fourth persisted "intelligence" concept to an app whose bounded-intelligence budget is fixed at exactly three named exceptions (Domain Model §5.7). Keeping the mapping in the bundle, with a generic default for any unmapped id, satisfies Module 10 FR-3's "must never break when a new tier is added" **structurally** — an unknown id simply falls to the default — with nothing to migrate and nothing to drift.

*(Optional, non-blocking: Domain Model §3.9 lists a "reminder cadence preference" as an optional Theme/Settings field, consumed by M2's export reminder. If ever built, it folds into the existing `themeSettings` singleton object as an added optional key — a singleton value gaining a field needs no `onupgradeneeded` bump. It is out of M3's required scope and listed in §11.)*

---

## 3. Theming (Module 10) — bundle structure

A theme is a **build-time bundle**, not persisted data. The only theme-related value in IndexedDB is the selected `theme` id on the `themeSettings` singleton (set first by Module 1, edited here). Each bundle supplies four parts (Module 10 §2, Architecture Evaluation §10):

1. **Palette** — a set of CSS custom properties. Semantic variable names are constant across every theme; only the *values* change, so switching themes is a variable swap, never a re-layout (Module 10 FR-1/FR-7).
2. **Emoji-icon set** — the functional icons, reskinned.
3. **Copy pack** — microcopy/tone strings.
4. **Signature reward visual** — the bespoke progress/reward rendering.

**Two tiers, defined by how many of the four a bundle customises:**

- **Palette themes** customise the Palette only; they share generic versions of the icon set, copy pack, and reward visual. 2–3 of these ship (e.g. a simple swatch row).
- **Signature themes** customise all four. **Two ship (§0 decision 4):**
  - **Stable** (Horse Lover) — ribbon-rail signature reward visual, warm hay/leather palette, horse iconography.
  - **Builder** — build-grid signature reward visual, blocky/voxel-adjacent styling, pickaxe iconography.

**Per-category reward icons — the four base categories (Rev 2).** Each signature theme names all four base Reward Category ids bespoke (Module 10 AC-9). The category ids `R01`–`R04` arrive on items from Management; on the Child side they are opaque keys into the theme's mapping, ordered by the tier weights seeded Management-side (`R01` lowest through `R04` = the new **Very Hard** tier — that ordering is Management seed context, not decided here, and the child never renders the tier label itself). The icons:

| Category id | Stable (ribbons) | Builder (resources) |
|---|---|---|
| `R01` | white ribbon | leather |
| `R02` | yellow ribbon | iron |
| `R03` | red ribbon | gold |
| `R04` | blue ribbon | diamond |

The **label** each icon carries in the mapping follows the icon's plain name (e.g. "White Ribbon", "Leather"); it is the friendly display string Module 6 shows in place of the raw `categoryId`, and is adjustable art direction, not a data contract.

**Stable's ribbons are reserved for the reward icons only — they must not appear anywhere else in the Stable theme's visuals** (icon set, copy-pack decoration, or the ribbon-rail visual's non-reward chrome). This keeps a ribbon an unambiguous signal of an earned category rather than generic decoration, and is a hard art-direction constraint on that bundle. Builder carries no equivalent reservation — its resource icons are the reward set, but resources may also appear as ordinary Builder-world iconography elsewhere.

**Each bundle carries the per-Reward-Category display mapping (§4).** Palette themes carry only the generic-default mapping; signature themes carry the bespoke four-entry mapping above and fall back to the generic default only for a category *beyond* the seeded base set — i.e. one they don't name (Module 10 FR-3; §4).

**Hard constraints on the bundles (Module 10 FR-4/FR-5), stated so a build session cannot regress them:**

- **Licensed-IP guardrail (FR-4).** No bundle may use, reference, or closely evoke a real trademarked character, franchise, or brand. The Builder theme is the live case, not a hypothetical: it may evoke the voxel-builder *genre* (blocky shapes, pickaxe iconography, that general aesthetic) through original art, but must never surface the name "Minecraft," any Mojang/Microsoft trademark, official block/mob textures, or the real typeface/logo treatment. "Builder" is the only name that appears anywhere a child or reviewer can see.
- **Reliability (FR-5).** Plain DOM/CSS only — no canvas, no WebGL, no animation library; no continuous or repaint-costly animation; every interactive touch target ≥ 44px, in every theme, on every screen. This is a budget-Android constraint, load-bearing for the signature reward visuals in particular.

**Theme switching is ungated and live (FR-2/FR-7):** any child, any theme, any time, no PIN, no confirmation beyond the switch itself, applied immediately across the whole app with no reload. §7 explains why this forces the switcher's entry point to sit *outside* the PIN-gated Settings screen.

---

## 4. Reward display (Module 6 FR-1/FR-2/FR-3) — read mechanics

This module is read-only except for spend (§5); it writes nothing here.

**Balance read — the refinement M3 forces.** M2 §4 gave the displayed balance as `snapshot.balance + sum(tail)`. That is correct wherever the running total never dips below zero, which is *always* true in M2, because M2 writes only `earn`. M3 introduces the two entry types that can decrease a category — `spend` and `adjust` — so the read must be stated precisely:

> **Displayed balance = the ordered fold of the tail onto the snapshot, floored at zero at each step.** Starting from `snapshot.balance` (or 0 if no snapshot exists yet for that category), apply each `rewardLedgerTail` entry for that `categoryId` **in ascending `id` order** (which is chronological, since `id` is the autoIncrement key — M2 §2), adding `earn`/positive-`adjust` amounts and subtracting `spend`/negative-`adjust` amounts, and after each step clamp the running total up to 0 if it went negative.

This is the **same computation M2 §4's fold performs** ("respecting the zero-floor: a negative entry can't take the running sum below 0") — read-time display and fold-time snapshot are deliberately the identical accumulation so they can never disagree about what a category's balance is. Two consequences worth stating, because the naive `sum(tail)` gets both wrong at the edge:

- It is **order-sensitive at the floor.** Balance 30, then a −50 `adjust` (floors to 0), then a +10 `earn` → **10**, not 0. A plain `max(0, 30 − 50 + 10)` would wrongly yield 0. The per-step floor is what Domain Model §3.7's "running sum" wording requires, and it is why the fold and the read must share one implementation.
- It **agrees with M2 exactly** on any earn-only tail: with no decreasing entries the running total never hits the floor, so the ordered floored fold equals the plain sum. This slice refines M2's formula; it does not contradict it.

There is exactly one balance function, called by the on-screen display, the spend ceiling check (§5), the adjust preview (§6), and the recovery note (§9). It is the same function M2's fold uses internally.

**Theme-skinned category display (FR-2).** Each category renders through the active theme's mapping (§3) — friendly label + icon — never the raw `categoryId`. Under a **signature** theme, all four base categories (`R01`–`R04`) resolve to bespoke art, so the generic default is never seen for them (Module 10 AC-9); it is a safety net for a category *beyond* the base four — for example a 5th tier a parent adds Management-side, which arrives with a category id no bundled theme names yet. Under a **palette** theme, every category resolves to the shared generic-default art by design (palette themes carry only that). Either way every category the child has ever earned into resolves to *something* — a raw id or blank render is a defect (Module 6 AC-1/AC-2, validation rules; Module 10 FR-3's "never breaks when a new tier is added" is exactly this beyond-base path).

**Completion-count visual (FR-3).** A separate, non-currency display: completions **this week** and a read-only reference to the streak. Neither is stored; both are derived:

- **Completions this week** = a count of `activityRecords` entries with `status: 'complete'` **and** `date` within the current device-local calendar week (the same day-boundary the Streak uses — Domain Model §3.8). It counts completed Activities *and* Chores (Module 6 §2), consistent with the flat-earn rule. Waived records are not completions and are excluded. A full scan of `activityRecords`, filtered by date — no index at M1/M2/M3 volumes (Architecture Evaluation §6), the same call every prior slice makes.
- **Days streaked** = a read of `streak.currentStreak` (Module 7). This module never computes or writes it.

The count and the category balances are **never merged into one figure** (FR-3, AC-3) — they are conceptually distinct and rendered distinctly.

---

## 5. Parent-PIN spend (Module 6 FR-4) — write mechanics

**Gate.** The spend screen is unreachable without the correct parent `pin` — checked before the screen is reachable at all, not only at final confirm (Module 6 validation, Permissions). Same single Child-App `pin` as deferment/waive and Settings.

**Flow.** Parent picks a category, enters a whole number greater than zero, confirms. Validation, in order:

1. Amount is a whole number > 0 (reject otherwise).
2. Amount ≤ the category's **currently displayed balance** (§4's balance function). **A spend exceeding the balance is rejected outright — no entry is written** (Module 6 validation "spend ceiling"; FR-4; AC-5). Spend never drives a balance negative; it is refused first.

**Write.** On pass, append exactly one entry to `rewardLedgerTail`:

```
{ type: 'spend', categoryId, amount, date: todayLocal, note? }
```

Then run the **same fold check M2 §4 defines** (count this category's tail entries; if the count reaches N = 100, fold). Spend uses the identical fold path as earn — there is no spend-specific fold (Module 6 AC-9). The displayed balance for that category (and only that category — FR-5, no cross-category conversion) drops immediately, because the next read re-runs §4 over the now-larger tail.

**No catalog, no child-side spend, no interchange (FR-6/FR-7).** The flow is free-form amount entry — no picker of named, pre-priced redeemables (the Reward Definition catalog, Domain Model §3.7a, is deferred by decision). The child has no spend affordance anywhere, and a spend never travels in the Packet or Completion CSV.

---

## 6. Repair form — adjust + streak set (Module 11 FR-7) — write mechanics

The repair form is the third layer of the Ledger/Streak survival design (Domain Model §5.9) — the only layer that writes. It never reads the recovery note; the parent keys values in by eye from the note file (Module 11 §2.5, FR-7). It sits behind the same Settings PIN gate (§7, FR-0).

**(a) Balance adjust (FR-7a).** Parent selects a category and enters a **signed whole number**. Append one entry:

```
{ type: 'adjust', categoryId, amount /* signed */, date: todayLocal, note? }
```

then run the same fold check (§5). A **negative** adjust that would take the category below zero is **floored, not rejected** — the entry is written as entered, and the zero-floor in §4's ordered fold clamps the displayed (and, on fold, the snapshotted) balance to 0 (Module 11 FR-7a, Domain Model §3.7). This is the deliberate asymmetry with spend: **spend over-balance is refused; a below-zero adjust is accepted and floored.** Both paths honour the same hard floor — no category is ever displayed or snapshotted negative — but they honour it at different moments, and the slice preserves both exactly as the SRS states them. Writing the adjust as entered (rather than clamping the stored amount) keeps the tail raw and auditable, per Domain Model §3.7's rule that corrections stay on the audit record rather than overwriting it.

**(b) Streak set (FR-7b).** Parent enters a non-negative integer for `currentStreak`. Write `currentStreak` **and** `lastQualifyingDate` **together** to the `streak` singleton, with `lastQualifyingDate` **defaulting to device-local today** unless the parent supplies another date (Module 11 FR-7b, Domain Model §3.8). The default-to-today is load-bearing: it stops M2's on-open gap catch-up (M2 §5) from immediately re-zeroing the restored value, because the catch-up walk starts from `lastQualifyingDate + 1` and would otherwise treat the whole restored gap as unqualified.

**Framing.** Presented in-UI as recovery/repair, naming the latest recovery note (Module 8 FR-8) as the expected source of values — never as a general-purpose Ledger/Streak editor (Module 11 FR-7, AC-12). It adds no clearing capability; Module 9's Wipe remains the sole clearing mechanism (FR-6, AC-14).

---

## 7. Settings screen (Module 11) — gating and the two ungated exceptions

**PIN gate on entry (FR-0).** The Settings screen is unreachable without the correct parent `pin` — the gate is on *entry*, so it covers every field inside: name edit, semester label edit, PIN change, and the repair form (§6) alike. This is one of the Domain Model's three PIN-gated surfaces, alongside deferment/waive and spend (Domain Model §3.2).

**Editable fields, all writing to existing singletons:**

- **Name (FR-1)** → `child.name`; same validation as Module 1 (non-empty, reasonable length). Reflected everywhere the name shows.
- **Semester label (FR-2)** → `semester.label`; free text. A passthrough display value only — editing it changes no validation, gating, wipe behaviour, or the interchange beyond the `semesterLabel` column's value.
- **PIN (FR-3)** → `child.pin`. Requires the *current* PIN entered correctly a second time (beyond the entry gate), then the new PIN twice, meeting Module 1's rule (≥ 4 digits, numeric). A wrong current PIN aborts with no partial write. On success the new PIN immediately becomes the credential for every gated surface (Settings, deferment/waive, spend) and the old one stops working at once.

**The two structural non-members — the subtle part of this module.** Theme switching (§3) and the Wipe button (M2 §8 / Module 9) must each have their **own entry point outside** the gated Settings screen:

- The **theme switcher** reaches from the child's home/daily view, ungated (FR-4). Module 10 locks theming as *always* ungated; if its only route were a link inside PIN-gated Settings, nesting would silently make it gated — contradicting Module 10. So the switcher lives outside, and Settings must not become its only doorway.
- The **Wipe button** lives alongside Completion CSV Export (M2 §7 / Module 8), ungated beyond its own confirmation (Module 9's no-PIN, confirmation-only design). Same reasoning: routing it only through gated Settings would incidentally PIN-gate it. Its placement outside daily work — next to Export, not on the daily view — is what keeps it from being stumbled into, not a PIN (Module 11 §2.2, FR-4).

Settings *implements* neither action; it must simply not be the gated sole path to either. And it exposes **no** multi-child/profile-switch capability (FR-5, single-child design) and **no** reset beyond Module 9's Wipe (FR-6).

---

## 8. Field-name reconciliation — `theme`

The theme-selection field is **`theme`** everywhere in this app. It is the same field across:

- `themeSettings` singleton value `{ theme }` (M1 §4);
- Module 1's capture-and-store ("stored as `theme` on Theme/Settings");
- Domain Model §3.9 (`theme` as a required Theme/Settings field) and the Child record's optional `theme`.

SRS Module 10 refers to the identical field as `themeId` (in FR-6 and its acceptance criteria). That is one module's local wording, not a second field. **This slice standardises on `theme`.** Module 10's `themeId` references — "the `themeId` field Module 1 first set," "no separate or duplicated theme-selection data model" — are satisfied by the single `themeSettings.theme` value with no code change; only the name in prose differs. A build session should read Module 10's `themeId` as `theme` and never create a second field.

---

## 9. Closing the M2 recovery-note placeholder

M2 §7 wrote the raw `categoryId` into the recovery note's `themeDisplayName` field as an admitted temporary gap, because no display mapping existed yet. With §3/§4's mapping in place, the note's per-category line now resolves `themeDisplayName` through the **active theme's** mapping, using the **same generic-default fallback** the on-screen display uses (§4) — never a raw id when a mapping (specific or default) can name the category. Everything else about the note is unchanged from M2 §7: it remains write-only (no module ever reads it — Domain Model §3.7), it is not part of the interchange, and it still carries device-local date, `streak.currentStreak` (read, not recomputed), and per-category `{ categoryId, themeDisplayName, balance }` using §4's balance function. This is the single line M2 flagged for M3 to revisit; it is now revisited.

---

## 10. Cross-module interaction summary (for a future single-module edit)

- **Module 6 (display) writes only `rewardLedgerTail` (`spend`), and only behind the parent PIN.** Its reads span `rewardLedgerSnapshot`/`rewardLedgerTail` (balance), the active theme bundle (category display), `activityRecords` (this-week count), and `streak` (days-streaked read). A future edit adding another spend path must keep the ceiling check (§5) before the write, or the hard floor is bypassed.
- **Module 10 (theming) writes only `themeSettings.theme`.** It persists nothing else; the per-category mapping is bundle-resident (§2/§3). Adding a new theme is a bundle addition with no schema impact.
- **Module 11 (settings) writes `child` (`name`/`pin`), `semester` (`label`), `rewardLedgerTail` (`adjust`), and `streak` (repair set).** It reads a category's current balance and the current streak so the parent can see what they're correcting. It must never become the sole, gated entry point for theming or Wipe (§7).
- **The balance function is single-sourced (§4).** Display, spend ceiling, adjust preview, recovery note, and M2's fold all call the one ordered-floored fold. A future change to how a category totals must change it in exactly one place, or read and fold will disagree.
- **The fold (M2 §4) is unchanged and now has three writers feeding its trigger:** earn (Module 4, M2), spend (Module 6, here), adjust (Module 11, here). All three append to the tail and run the identical count-triggered fold; there is still exactly one fold implementation.
- **Nothing in M3 touches the Wipe transaction or the Streak's live/gap-catch-up paths from M2** — M3 only *reads* streak (display) and *sets* it (repair form, a direct singleton write outside any reconciliation walk).

---

## 11. What this slice deliberately leaves open

- **The Reward Definition catalog (Domain Model §3.7a)** — named, priced redeemables. Deferred by decision, not omission (Module 6 FR-7). Spend stays free-form amount entry until it is explicitly un-deferred. Do not add a picker without that decision.
- **The optional reminder-cadence preference (Domain Model §3.9)** — if built, an added optional key on the existing `themeSettings` singleton, no version bump (§2). Not required for M3.
- **Any secondary IndexedDB index** (e.g. on `activityRecords.date`/`status` for the this-week count, or on `rewardLedgerTail.categoryId` for the fold/read scan) — still not needed at these volumes (Architecture Evaluation §6); the this-week count and the balance fold are full/linear scans, as every prior slice's equivalents are. The specific spot a future volume-driven index would land is the `activityRecords` date filter (§4) and the per-category tail scan (§4/§5).
- **Everything M4+** — the entire Management App. Out of the Child App's scope under the split-build boundary; not this session's to write.

---

## 12. Acceptance check for this slice

Before handing Modules 6/10/11 to a build session, confirm:

1. `childAppDB` opens at **version 2 unchanged** — M3 triggers no `onupgradeneeded`, creates no store, and alters no M1/M2 store's key path, shape, or content (verified by opening a database seeded with M1+M2 data and confirming M3 code reads and writes it with no upgrade event firing).
2. Under each signature theme, **all four base categories `R01`–`R04` render bespoke** theme-specific art with **no generic-default fallthrough** (Module 10 AC-9); a synthetic 5th category id no theme names renders via the generic default rather than blank or a raw id (Module 6 AC-1/AC-2, Module 10 AC-2, FR-3). No raw `categoryId` is ever visible under any theme.
2a. The signature-theme reward icons match §3 exactly: Stable → `R01` white / `R02` yellow / `R03` red / `R04` blue ribbons; Builder → `R01` leather / `R02` iron / `R03` gold / `R04` diamond.
2b. In the Stable theme, a ribbon appears **only** as a reward-category icon — no ribbon in the icon set, copy-pack decoration, or the ribbon-rail visual's non-reward chrome (§3's reservation).
3. Switching themes changes the full presentation immediately with no PIN, no confirmation, and no reload, and reads/writes the **same `theme` field** Module 1 first set — never a second field (Module 10 AC-1/AC-6; §8).
4. The balance function computes an **ordered, per-step zero-floored fold**: with a category at 30, a −50 `adjust` then a +10 `earn` yields a displayed balance of **10**, not 0 — and on any earn-only tail it equals the plain `snapshot + sum(tail)` M2 produced (§4).
5. The completion-count visual counts completed Activities **and** Chores dated within the current device-local week, excludes waived records, and is rendered distinctly from — never merged into — the category balances (Module 6 FR-3, AC-3).
6. The spend screen is unreachable without the parent PIN; a spend exceeding a category's current balance is **rejected with no tail entry written**; a valid spend appends exactly one `spend` entry, drops only that category's displayed balance, and runs the same fold as earn (Module 6 AC-4/AC-5/AC-6/AC-9).
7. A signed balance **adjust** appends one `adjust` entry; a negative adjust that would go below zero is **written and floored to a 0 displayed/snapshotted balance**, not rejected — the deliberate opposite of spend's over-balance rejection (Module 11 AC-10, Module 6 AC-8; §6).
8. A streak **set** writes `currentStreak` and `lastQualifyingDate` together, `lastQualifyingDate` defaulting to device-local today, and the next on-open gap catch-up (M2 §5) does **not** re-zero the restored value (Module 11 AC-11; §6).
9. Settings is entirely unreachable without the parent PIN — including to view or edit name or semester label — while the **theme switcher and the Wipe button are each reachable without the PIN**, via entry points outside Settings (Module 11 AC-1/AC-8/AC-9; §7).
10. A PIN change with a wrong current PIN is rejected with no partial effect; immediately after a successful change, only the new PIN works for Settings entry, deferment/waive, and spend (Module 11 AC-3/AC-5).
11. The recovery note's per-category display name resolves through the active theme's mapping with the generic-default fallback — no raw `categoryId` where a mapping can name it — while the note remains write-only and outside the interchange (§9).
12. No code path adds a Reward Definition catalog, a child-side spend affordance, a multi-child/profile switch, or any clearing mechanism beyond Module 9's Wipe (Module 6 FR-6/FR-7, Module 11 FR-5/FR-6).

---

*With M3 specified, the Child App's TDS coverage is complete: M1 (shell + import + planner), M2 (completion, deferment/waive, ledger earn, streak, CSV export, wipe), and M3 (theming, reward display + spend, settings + repair). All eleven Child App SRS modules now have a build-ready slice. Milestones M4 and beyond are Management App scope and are not written here.*
