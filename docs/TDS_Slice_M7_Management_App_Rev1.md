# Technical Design Specification — Slice
## M7 Scope: Management App — Pacing Configuration, Packet Generation & Export (THE SEAM)

*Covers: Pacing Configuration (SRS Module 05, FR-1–FR-8) and Packet Generation & Export (SRS Module 08, FR-1–FR-16). Written against Domain Model §2.4/§2.9/§2.10/§2.10a/§4.1, the Interchange Contract §1/§1a/§1b/§4/§7 and the normative `packet_schema.json`/`packet_sample.json`, Architecture Evaluation §5/§7/§8, SRS Modules 05/08 (and 03 §8, 04, 06, 07 for the records this slice reads), and `TDS_Slice_M4_Management_App_Rev3.md`/`TDS_Slice_M5_Management_App_Rev7.md`/`TDS_Slice_M6_Management_App_Rev2.md` (store table, ID scheme, index precedent).*

*Does not cover: bulk CSV import or content-planning presets (Module 03, M8), backup/restore (Module 11, M8), Master Reporting (M9), Completion Import (M10). Drive integration is a swappable export front end (§2.4 of Module 08) and is **not** required to pass M7 — the manual file-save path is what this slice ships and what the seam is proved on.*

*Status: buildable as written. **This is the seam checkpoint (Module 08 §2.0): M7 is not complete until a packet this slice emits is imported clean, end to end, by the actual Child App.** That is a two-account event; produce the packet, hand it over, and stop.*

---

## 0. Revision note

**Rev 1 — the initial M7 slice.** It lands on the corpus edits made the same session: Domain Model §2.10/§2.10a (the Propose/Review/Commit flow and the Generation Log as generation source of truth), §2.4 (pacing cursor retired), the Module 08 rewrite, and the propagated edits to Modules 04/05 and the Architecture Evaluation. Everything below is the *how* for those now-settled *whats*. No decision here reopens the flow; the open items are storage-level and named in §1.

---

## 1. Decided here (TDS-level calls)

- **File list:** `pacing.js` (Module 05) and `packet.js` (Module 08) — both already in Architecture Evaluation §7's fixed 14-file list. `pacing.js` reads/writes `pacingProfiles` and reads `courses`/`lessons`/`activities`/`generationLog` (for FR-8's progress display). `packet.js` reads `pacingProfiles`/`courses`/`lessons`/`activities`/`activityTypes`/`tiers`/`chores`/`familyEvents`/`generationLog`, and writes `generationLog` and `activities` (the `excludeFromGeneration` flag at Commit) — it is the **sole writer of `generationLog` anywhere in the system**.

- **`pacingProfiles` store — keyPath `instanceId` (1:1 with the Instance).** A Pacing Profile has exactly one owner and is only ever fetched by it, so the Instance's own id is the natural key: `get(instanceId)` is the whole access pattern, in both `pacing.js` and `packet.js`. Domain Model §2.9's separate `id` field is carried as a stored value `PAC-{instanceToken}` (deterministic from the Instance's own token — no new token minted) for model conformance and readability; nothing keys on it. **No index** — a 1:1 store fetched by its own key needs none.
  - Shape: `{ id: "PAC-{instanceToken}", instanceId, daysOfWeek[], pacingMode, activitiesPerDay?, minutesPerDay?, startDate, skipDates?, blockLayout?, weighting? }`. Optional fields **omitted, never `null`** (M4 precedent). `weighting` is reserved, unwritten (Module 05 FR-5).

- **`generationLog` store — keyPath `["childId","itemId"]` (one row per decision, updated in place).** The composite key is the identity Domain Model §2.10a fixes: an Activity appears once (relocate/re-commit `put()`s over the same key); a Chore occurrence's date is inside its `itemId`, so it is naturally one row per date. `put()` gives idempotent reproduction for free.
  - Shape: `{ childId, itemId, instanceId?, assignedDate, disposition, generatedAt }`. `disposition` ∈ `"sent" | "dropped"`. `instanceId` present on Activity rows only. `assignedDate`/`generatedAt` are strings (calendar date, ISO instant).
  - **Indexes (this is why M7 bumps the DB — see §2): `by_child` on `childId`** (read a child's whole decision history at Propose — the store grows per-item across a semester, the same unbounded-growth-read-every-run profile that justified indexing `activities` at M5), and **`by_instance` on `instanceId`** (FR-8 progress and, later, Curriculum Progress — count `sent` rows per Instance). The in-range date filter runs in application code over the small per-child result; no date index.

- **Schema version → 3.** M5/M6 sat at version 2. Indexes can only be created in `onupgradeneeded`, so adding `generationLog`'s two indexes requires a bump. The v3 upgrade **drops and recreates `pacingProfiles` and `generationLog`** with the keyPaths/indexes above. This is deliberate and lossless: the M4 TDS declared both stores empty and **never pinned their keyPath**, and neither has ever been written (M5 §2 / M6 confirm both still empty), so recreating them is the clean way to own their shape from M7 rather than inheriting an undocumented placeholder keyPath. No other store is touched; the M4 seed and all M5/M6 data are untouched.
  - `onupgradeneeded` guards on `oldVersion` (M5 precedent): `oldVersion < 3` runs the drop-and-recreate for these two stores; `oldVersion === 0` additionally does everything M4/M5 already specify (stores, indexes, one-time seed). The M4 seed **never re-runs** on an upgrade path.

- **Stored `payload` shape — pinned here, and a verification point against the shipped M5 build.** M5 authored `payload` "branching on canonical-vs-custom type" but never pinned its internal field names. M7 is the first reader, so it pins them:

  | Authored type | Stored `payload` | 
  |---|---|
  | `pdf`, `reading-pages` | `{ pageRangeStart, pageRangeEnd }` |
  | `video`, `quiz`, `test`, `report`, `workbook`, `project`, `drill` | `{ reference }` |
  | `practice-level` | `{}` (empty — `sequenceNumber` is the payload) |
  | any parent-added key | `{ text }` |

  **Verification (the one retroactive item this slice carries):** confirm `courses.js`/`children.js` (M5) persist `payload` in exactly these shapes. If the M5 build stored different inner field names, that is a small M5 correction, not an M7 redesign — flag it rather than silently adapting the projection to whatever M5 happened to write.

- **No new tokens minted.** M7 uses existing item ids (Activity `id`, Chore occurrence `CHR-{choreToken}-{YYYYMMDD}` derived per Module 08 FR-3). `pacingProfiles` keys on `instanceId`; `generationLog` on a composite. Nothing here touches `meta.nextSeq`.

- **Export back end: manual file save.** `packet.js` writes the committed packet as a downloaded `.json`. Destination is the swappable front end of Module 08 §2.4; Drive is a later, optional addition and is out of scope for the seam.

---

## 2. IndexedDB schema — `managementAppDB`, **version 3**

### `onupgradeneeded` (guard on `oldVersion`)

- **`oldVersion === 0` (fresh install):** create every store and index M4/M5 specify, run the one-time seed (tiers/categories/activity types, `meta.nextSeq`), **and** create `pacingProfiles`/`generationLog` per the table below.
- **`oldVersion === 1` (ran M4 only) / `=== 2` (ran M5/M6):** create nothing seeded, do not re-run the seed. Apply the M5 `activities` indexes if `oldVersion < 2`. For all `oldVersion < 3`: **`deleteObjectStore` then `createObjectStore`** for `pacingProfiles` and `generationLog` with the shapes below (both guaranteed empty — lossless).

### Stores added/owned by this slice (additions to M5 §2 / M6 §2 tables)

| Store | Key path | Shape | Written by |
|---|---|---|---|
| `pacingProfiles` | `instanceId` | `{ id: "PAC-{instanceToken}", instanceId, daysOfWeek[], pacingMode, activitiesPerDay?, minutesPerDay?, startDate, skipDates?, blockLayout?, weighting? }` | `pacing.js` (Module 05) |
| `generationLog` | `["childId","itemId"]` | `{ childId, itemId, instanceId?, assignedDate, disposition: "sent"\|"dropped", generatedAt }` | `packet.js` (Module 08) |

| Store | Index | On | Serves |
|---|---|---|---|
| `generationLog` | `by_child` | `childId` | Propose (reproduce in-range + compute pending); read every run |
| `generationLog` | `by_instance` | `instanceId` | FR-8 progress; Curriculum Progress (M9) — `sent` count per Instance |

**Notes**
- `courses` instance rows carry **no** pacing field (the M5 store table's `progressCursor` was retired; corrected in M5 TDS Rev7). "How far walked" is a `generationLog` query, never a stored value.
- `packet.js` is the only writer of `generationLog`. `pacing.js` reads it (FR-8) and writes nothing to it.
- `familyEvents` and `chores` are read by `packet.js` at generation and never written here (M6 §2).

---

## 3. Pacing Configuration (`pacing.js`, Module 05, FR-1–FR-8)

Owned entirely by `pacing.js`. This module writes only `pacingProfiles`.

**Create / Edit (FR-1/FR-2).** A Profile is created for one Instance — the natural next step after stamping (Module 04 FR-4), but a stamped Instance with no Profile yet is a valid transient state, not an error (Module 05 §2.6). Required: `daysOfWeek[]` (non-empty subset of the seven abbreviations `Sun`–`Sat`, no duplicates — the same shape and picker as Chore's field, M6 §1), `pacingMode` (`activityCount` | `minutesBudget`, exactly one), the mode's budget value (`activitiesPerDay` or `minutesPerDay`, positive integer), and `startDate`. Optional: `skipDates[]` (valid calendar dates, duplicates ignored not rejected), `blockLayout[]` (ordered, from the closed four-value block set `morning`/`afternoon`/`evening`/`night` — same closed picker as Chore's `blockHint`, M6 §0; an out-of-set label is not emittable here). `weighting` shows a reserved placeholder, no behavior. Edit may change any field at any time; per FR-2 it re-shapes only the pending remainder — nothing already `sent` is recalled.

Write is a single `put()` keyed by `instanceId` (create and edit are the same operation — one Profile per Instance). No counter, no token mint (`id` is `PAC-` + the Instance's existing `instanceToken`).

**Delete.** No independent delete (FR-7). Deleting the Instance (Module 04 FR-6) cascades the Profile — `children.js` deletes the `pacingProfiles` row keyed by that `instanceId` as part of its instance-delete transaction.

**Progress display (FR-8, read-only).** For a given Instance, read `generationLog` via `by_instance` for that `instanceId`, count `disposition === "sent"` rows → "*n* of *N* sent" against the Instance's total Activity count (`activities` filtered by the Instance's Lessons). Activities flagged `excludeFromGeneration` are excluded from the *pending* figure and may be shown as a separate tally. `pacing.js` writes nothing during this read.

**Validation** (Module 05 §5) is enforced in `pacing.js`: mode-specific budget presence, positive integers, non-empty `daysOfWeek[]`, valid dates. No per-action PIN (the `launchPin` gates the app once).

---

## 4. Packet Generation & Export (`packet.js`, Module 08, FR-1–FR-16)

Owned entirely by `packet.js`. Three stages — **Propose → Review → Commit** — held in one in-memory session; **only Commit writes.**

### 4.1 The in-memory proposal

A plain object, never persisted until Commit:
```
proposal = {
  childId, childName, semesterLabel, coversFrom, coversTo,
  days: Map<dateStr, { activities: [item], chores: [item], events: [item] }>
}
```
Each `item` carries its source reference and edit state — `{ kind: "activity"|"chore"|"event", sourceId, instanceId?, assignedDate, disposition, origin: "reproduced"|"walked"|"pulled", … resolved display fields }` — enough for Review to move/remove/add it and for Commit to project it. `origin` is bookkeeping only; the packet never carries it.

### 4.2 Propose (FR-1–FR-6) — writes nothing

1. **Load the child's decision history:** `generationLog` via `by_child` for `childId`. Partition by `assignedDate ∈ [coversFrom, coversTo]`.
2. **Reproduce (FR-2 step 1):** for each in-range `sent` row, place the item on its `assignedDate`, **re-deriving content from current records** (Module 08 §2.9) — a relocated/pulled item lands on its logged date, not a pacing-default date. In-range `dropped` chore rows are held as suppressions (their occurrence is not re-proposed).
3. **Extend — School (FR-2 step 2):** for each Instance of the child with a Pacing Profile, compute School days in range (weekday ∈ `daysOfWeek[]`, date ∉ `skipDates[]`); compute the **pending remainder** = the Instance's Activities in walk order (`lessons` by `order`, then `activities` by `order`) **minus** those with a `sent` log row **minus** those flagged `excludeFromGeneration` (membership by `id`, never by position); distribute the remainder into School days that still have budget after reproduction, per `pacingMode` (`activityCount`: count ≤ `activitiesPerDay`; `minutesBudget`: Σ `expectedDurationMin` — or the 15-min fallback for missing — ≤ `minutesPerDay`).
4. **Extend — Chores (FR-3):** for each Chore of the child, for each in-range date whose weekday ∈ the Chore's `daysOfWeek[]` that carries **no** prior decision (no `sent`/`dropped` row), add an occurrence with id `CHR-{choreToken}-{YYYYMMDD}`.
5. **Extend — Events (FR-4):** each Family Event whose `[startDate,endDate]` overlaps the range **and** whose `childIds[]` includes the child, on every in-range day it covers. Events carry no log row and no disposition.
6. **Stamp interchange fields (FR-5/FR-6)** onto each item as it is placed (see §4.5), including `blockHint` round-robin from the Instance's `blockLayout[]` for newly-paced Activities.

### 4.3 Review (FR-7) — writes nothing

Mutations on the in-memory `proposal`. None edits a Pacing Profile.
- **Relocate** an Activity/Chore occurrence to another in-range date (create the day if absent; block unchanged).
- **Exclude** an Activity — mark it for `excludeFromGeneration`; the flag is persisted at Commit, not now.
- **Defer** an Activity — remove from the proposal; write nothing at Commit (absence keeps it pending).
- **Pull forward** an Activity from the same Instance's pending remainder onto a chosen in-range date.
- **Drop** a Chore occurrence — mark it `dropped`; a `dropped` log row is written at Commit.
Budget is advisory here — the review overrides `activitiesPerDay`/`minutesPerDay` with no block. Events are informational, not adjustable.

### 4.4 Commit (FR-8–FR-11) — the only writes

Order matters (a structurally invalid packet must write nothing):
1. **Project** the reviewed `proposal` to the packet JSON (§4.5) and to the decision set.
2. **Validate** the packet against `packet_schema.json` **and** the FR-13 structural pass (§4.6). On any failure: surface a plain error, **write nothing**, do not export.
3. **Write, in one `readwrite` transaction** over `generationLog` + `activities`: `put()` one `sent` row per sent item (on its final `assignedDate`); `put()` one `dropped` row per dropped chore occurrence; set `excludeFromGeneration = true` on each excluded Activity. Deferred Activities: no write. `put()` on the composite key makes reproduction idempotent and relocation an in-place update (FR-10). No write to any Instance (no cursor — FR-8/§2.1 of Module 08).
4. **Export** the packet file (§4.7) after the transaction commits. Export is retriable and outside IDB — a failed file write leaves committed decisions intact; re-running reproduces the identical packet (FR-10) and re-exports.

### 4.5 Projection & interchange fields (FR-6/FR-12) — not a blind copy

The packet `activityEntry` schema is closed (`additionalProperties: false`). `packet.js` **projects** each Activity onto the Interchange Contract §1a allow-list — the stored `lessonId`, `order`, `excludeFromGeneration` **never appear** — and adds/derives:
- **`payload`** (tagged union) from the stored payload (§1) by the fixed per-key map:

  | `activityTypeKey` | `payload.kind` | inner fields |
  |---|---|---|
  | `pdf`, `reading-pages` | `pageRange` | `pageRangeStart`, `pageRangeEnd` |
  | `video`, `quiz`, `test`, `report`, `workbook`, `project`, `drill` | `reference` | `reference` |
  | `practice-level` | `none` | — |
  | any other (parent-added) | `freeText` | `text` |

  The map is keyed by the canonical `activityTypeKey`, **not** by `structurePattern` (Quiz and Practice Level are both `count`, yet map to `reference` and `none`). A key not in the ten canonical seeds → `freeText`.
- **`activityType`** = the type's current `label` (resolved from `activityTypes` by key — never the key itself; Interchange Contract §1a).
- **`courseName`** = the owning instance Course's current `name`.
- **`rewardCategoryId`** = resolved from the Activity's `difficultyTier` via the `tiers` store (`tiers[difficultyTier].rewardCategoryId`).
- **`capturesGrade`** = the boolean already stored on the Activity (never absent — Module 03 FR-10).
- **`sequenceNumber`** rides through as authored, and is **required whenever `payload.kind` is `reference` or `none`** (FR-13).
- Pass-through allow-list fields as authored: `title`, `expectedDurationMin?`, `blockHint?` (round-robin default for paced Activities), `lessonTitle?`, `instructions?`.
- **`id`** unchanged. Chore entries: project to §1b (`id`, `choreType`, `title`, `date` = enclosing day, `difficultyTier`, `rewardCategoryId`, `required: true`, `notes?`, `blockHint?` as authored). Event entries: §1c (`id`, `title`, `startDate`, `endDate`, `notes?`, `time?`).

### 4.6 Emit-side structural validation (FR-13) — binding on the generator

Before any write, verify (Interchange Contract §1 — the rules the JSON Schema can't express; the schema pass runs alongside):
- `coversFrom ≤ coversTo`; every `days[].date ∈ [coversFrom, coversTo]`; no duplicate `days[].date`.
- No duplicate `id` across all arrays/days, **except** a multi-day Family Event repeating its `EVT-` id once per in-range day.
- Each `choreEntry.date` == its enclosing day's `date`.
- `pageRangeEnd ≥ pageRangeStart`.
- **`sequenceNumber` present whenever `payload.kind` is `reference` or `none`** — schema-invisible (schema marks it optional), so this pass is the only thing that catches its absence.
- Every `eventEntry` overlaps `[coversFrom, coversTo]`.

### 4.7 Export (FR-11)

Serialize the validated packet (Domain Model §4.1 shape: `schemaVersion: 1`, `childId`/`childName`, `semesterLabel`, `generatedAt`, `coversFrom`, `coversTo`, `days[]`). Filename `packet_{childSlug}_{coversFrom}_{coversTo}.json` (Interchange Contract §7; `childSlug` = `name` lowercased, non-alphanumerics → `-`). Manual save (§1). Never parse the filename to decide behavior.

### 4.8 No Reward Ledger visibility (FR-16)

`packet.js` reads/writes no Reward Ledger data anywhere. `rewardCategoryId` is a category definition flowing to the child, not ledger data.

---

## 5. Acceptance checks (build-session verifiable, ahead of the two-account seam test)

1. DB opens at **version 3** on all three entry paths; `pacingProfiles` (keyPath `instanceId`) and `generationLog` (keyPath `["childId","itemId"]`, indexes `by_child`/`by_instance`) exist and are empty; the M4 seed did not re-run (verify by deleting a seeded tier on a v2 device, upgrading, confirming it stays deleted).
2. Creating a Pacing Profile writes one `pacingProfiles` row keyed by `instanceId`; deleting its Instance removes it.
3. FR-8 progress reads `generationLog` by `by_instance` and shows "*n* of *N* sent" without writing anything.
4. A Propose for a child with two paced Instances can place Activities from both on one School day, each within its own budget; **nothing is written** until Commit, and abandoning leaves `generationLog`/`activities` untouched.
5. Relocating a proposed Activity to a non-`daysOfWeek[]` date and committing writes its `sent` row with that `assignedDate`; re-proposing the range reproduces it there.
6. **Defer** vs **Exclude**: deferring writes no row/flag and the Activity re-proposes next run; excluding sets `excludeFromGeneration` and it never re-proposes — two different storage outcomes from the same proposal.
7. Dropping one Chore occurrence writes a `dropped` row for that `(choreToken, date)`; re-proposing does not resurface it; other dates unaffected.
8. Pulling an out-of-sequence Activity forward records it `sent`; the earlier pending Activities stay pending and propose next run in walk order.
9. Re-committing an unchanged, already-covered range produces a byte-identical packet and leaves `generationLog` rows identical (no duplicates — `put()` on the composite key).
10. An emitted `activityEntry` contains only allow-list fields (`lessonId`/`order`/`excludeFromGeneration` absent) and a `payload` matching the §4.5 map (Quiz → `reference`, Practice Level → `none`, custom → `freeText`), with non-null `courseName`/`rewardCategoryId`/`capturesGrade`.
11. A `reference`/`none` Activity missing `sequenceNumber` fails FR-13 and no packet is written — even though `packet_schema.json` alone would accept it.
12. `packet_sample.json`-equivalent records produce a packet that validates against `packet_schema.json`.
13. Committing 5 Activities + 2 Chore occurrences writes 7 `sent` `generationLog` rows, correct `itemId`/`assignedDate` each — not one summary row.
14. Reordering an Instance's Activities between two runs changes only the order pending Activities are proposed next — never which already went out, never a duplicate or skip.
15. **Seam (cannot be closed in this session):** hand the emitted packet to the Child App account; M7 passes only when it imports clean, end to end (Module 08 §2.0, Interchange Contract §8).
