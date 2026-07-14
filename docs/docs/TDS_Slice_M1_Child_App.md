# Technical Design Specification — Slice
## M1 Scope: Startup Wizard, Packet Import, Daily Planner (Child App)

*This is a deliberately narrow TDS slice — it covers only what's needed to build the Build Roadmap's M1 milestone: "startup wizard, IndexedDB, packet import (hand-authored packet), daily view with School/Chores/Events." It does not cover completion/logging (M2), the Reward Ledger, Streak, Deferment/Waive, theming, the wipe, or any Management App schema — those are separate TDS work, done when their milestone is reached. Written against SRS Modules 1/2/3, the Interchange Contract, and Domain Model §2.5/§2.6/§2.7/§3.1–§3.5b/§4.1 — and now reconciled against the normative fixtures: `packet_schema.json`, `packet_sample.json`, `completions_sample.csv`.*

---

## 0. Revision note

**Rev 5 (this revision):** completes the fixture reconciliation Rev 4 left half-done and cleans up the acceptance list. Three fixes — no rule, ID format, or store-shape change:

1. **The §2 inline packet sample was stale.** It still carried the *previous* fixture — child "Nora", "Fall 2025", a July date range, a "Dentist appointment" event `EVT-9j2m`, and Activity id `SAXMATH5-f3k9-L03-02` as a `Quiz`/`reference`. The current normative `packet_sample.json` is child "Ada", "Fall 2026", `2026-09-14`…`2026-09-15`, a "Piano recital" event `EVT-t9x2`, and makes `SAXMATH5-f3k9-L03-02` a `Reading Pages`/`pageRange` (Pages 22–27), with the Quiz at a *different* id, `SAXMATH5-f3k9-L03-03`. The old sample contradicted the fixture, this slice's own §3 example (which already cited `EVT-t9x2`), and its own payload-rendering acceptance check (which already called `SAXMATH5-f3k9-L03-02` a pageRange "Pages 22–27"). §2 now reproduces **day one of `packet_sample.json` verbatim**, and the stale chore-token example in §3 (`CHR-8kd2-…`) is corrected to the fixture's `CHR-b4n1-…`.
2. **The §6 acceptance list was two revisions' lists concatenated without renumbering** — it ran 1–13, then restarted at 8–16, so checks 8–13 existed twice. Renumbered to a single **1–20** sequence, with the two genuine content duplicates merged (absent/out-of-set `blockHint` → `morning`; block-move-and-reorder surviving a re-import).
3. **The header's "reconciled against … `packet_sample.json`" claim is now actually true.** Rev 4 updated the acceptance checks to the current fixture but never brought the §2 sample along; Rev 5 does.

A build session already in flight against Rev 4 needs no code change — the store shapes, ID patterns, validator keyword list, and every validation rule are byte-identical. The only things that moved are the illustrative sample values and the acceptance-check numbering.

**Rev 4:** closes the items found in the pre-build review. All are in §2/§4/§6:

1. **The Today view's ordering is now unambiguous: block outer, category nested, position innermost.** Three documents previously said three different things (Domain Model §2.10 said `blockHint` was "unused for ordering"; SRS Module 3 FR-1 asserted both block-grouping *and* category-sectioning without saying which nested inside which; this slice implied category-outer). Locked as: block (`morning` → `afternoon` → `evening` → `night`) → School-then-Chores inside each block → sort position innermost. Absent **or** out-of-set `blockHint` displays under `morning`. Propagated to Domain Model §2.10/§3.4/§6, Interchange Contract §1d, SRS Module 3 FR-1/FR-4/FR-5/§5/AC, and Architecture Evaluation §13. See §4.
2. **Sort key unified and made deterministic** — `receiptIndex` stamped at import, `sortOrder` a float in the same number space, tie-break on `id`. See §4.
3. **Validator keyword list corrected.** The Rev 3 list omitted `properties`, `items`, and `$ref`/`definitions` — without which the validator cannot traverse the schema at all — and left `format` unaddressed. See §4.
4. **Three structural checks added** to the second pass: day dates inside the packet range, no duplicate day date, no duplicate `id` (with the multi-day-event exception). See §2.
5. **`childId`/`childName` given an explicit disposition** — passthrough, not stored, not matched, never a gate. See §4.
6. **Deferred due date locked as a `plannerMeta` override**, so a re-import can never un-defer. `plannerMeta` gains `deferredDate` at M1 (written by Module 5 at M2, read by Module 3 from M1). See §4.
7. **Daily Plan confirmed derived, never persisted** — no `dailyPlan` store, no `blocks[]`. See §4.
8. **A silent-failure trap in the hand-written validator, found by running the Rev 3 spec against the golden fixture:** `payload`'s `oneOf` branches carry no `type`, so a `type`-dispatching walker passes *every* payload without error. `packet_schema.json`'s branches now state `type: "object"` explicitly (no packet's validity changes; no `schemaVersion` bump), and the trap is written up in §4.
9. **Cross-app: the superseded two-value `choreType` (`housework` | `outside`) was still live in Management SRS Module 06 (Chore Authoring) and Module 09, and in Child SRS Module 08.** Management would have authored chores the child device rejects on every import. All three corrected to the closed eleven-value enum.
10. **Fixtures corrected:** `packet_sample.json` now carries a `blockHint` on every Activity and Chore entry; `completions_sample.csv`'s chore row now reads `Kitchen/Dining` in the `activityType` column, not the stale `housework` (which the locked `choreType` enum rejects).

**Rev 3:** caught the slice up to decisions that were made elsewhere but never propagated here — this document had gone stale against the normative fixtures and the M2/M3 SRS. Changes, all in §2/§3/§4/§6:

1. **`choreType` is a closed enum, and the sample was invalid.** The sample chore carried `"choreType": "housework"`, which is *rejected* by the current `packet_schema.json` (its `choreEntry.choreType` is an `enum` of eleven canonical chore categories, not free text). Corrected the sample to a valid value and added a field note naming the enum and pointing at the source of truth (Interchange Contract §1b / `packet_schema.json`). See §2.
2. **Event `time` was 12-hour; the contract is 24-hour.** The sample used `"3:00 PM"`; the fixture and Interchange §1c use 24-hour `HH:MM` (`"16:30"`). Corrected, and stated that `time` is display-only and never parsed.
3. **Canonical block-label set named.** SRS Module 3 §5 delegates the exact block set to "a TDS/UI concern"; this slice now fixes it — `morning`, `afternoon`, `evening`, `night` — and says what happens to an out-of-set `blockHint` (the schema permits any string, so it is stored as received but falls back to `morning` for display). See §4.
4. **Effective-`blockHint` precedence and default sort order specified** in §4, so a build session doesn't guess: the child override in `plannerMeta` wins for display, a re-import never clobbers it, and never-reordered items fall back to packet-receipt order.
5. **Cross-field constraints the schema can't express are gathered** as an explicit validator second pass (§2): `coversFrom ≤ coversTo`, `pageRangeEnd ≥ pageRangeStart`, chore `date` == enclosing day's `date`, each event overlapping the packet range, and `sequenceNumber` present for count-structured kinds (`reference`/`none`) so the child can display the "which one" ordinal (SRS Module 3 FR-10).
6. **Validation mechanism and indexing cross-referenced to Architecture Evaluation §6** (the hand-written validator that walks `packet_schema.json` at runtime; full scans acceptable at M1 volumes) so this slice states *how* validation stays in sync with the schema rather than leaving it open.

None of the above changes a store shape or an ID format; Rev 2's §2/§4 structure is intact. A build session already in flight against Rev 2 only needs to (a) use a valid `choreType` in test packets, (b) read the new §4 display-precedence/sort note before writing the Daily Planner, and (c) add the four cross-field checks to the validator.


## 1. Why a slice, not the full TDS

The full Documentation Roadmap TDS needs to cover both apps, the Completion CSV, the Activity ID delimiter, ledger checkpointing, and the wipe trigger. Locking all of that now would mean guessing at decisions M1 doesn't need yet (e.g., the wipe trigger has zero bearing on whether Packet Import works). This slice fixes only the concrete things Module 1/2/3 code needs to exist before it can be written:

1. The exact packet JSON shape (Packet Import can't validate or parse against an undefined shape).
2. The Activity/Chore/Family Event ID format (the delimiter question the Domain Model explicitly leaves open).
3. The IndexedDB store layout for M1's three modules.

Everything else in the eventual full TDS remains open and undecided by this document.

---

## 2. The Packet JSON shape

Matches Interchange Contract §1/§1a/§1b/§1c, Domain Model §4.1, and **`packet_schema.json`, the normative machine-checkable form — where this document and the schema ever disagree, the schema wins.** The example below is **day one of the two-day `packet_sample.json`, reproduced verbatim** (the fixture's second day — a second `Unload dishwasher` occurrence and a `Water the garden` chore, with no activities or events — is omitted here only for length, not because anything about it differs):

```json
{
  "schemaVersion": 1,
  "childId": "child-ada-001",
  "childName": "Ada",
  "semesterLabel": "Fall 2026",
  "generatedAt": "2026-09-13T14:32:00Z",
  "coversFrom": "2026-09-14",
  "coversTo": "2026-09-15",
  "days": [
    {
      "date": "2026-09-14",
      "activities": [
        {
          "id": "SAXMATH5-f3k9-L03-02",
          "activityType": "Reading Pages",
          "title": "Lesson 3 Reading",
          "required": true,
          "payload": { "kind": "pageRange", "pageRangeStart": 22, "pageRangeEnd": 27 },
          "difficultyTier": "D02",
          "rewardCategoryId": "R02",
          "courseName": "Saxon Math 5",
          "capturesGrade": false,
          "expectedDurationMin": 20,
          "blockHint": "morning",
          "lessonTitle": "Multiplying Fractions",
          "instructions": "Read carefully and work the examples in your head before checking the answer key."
        },
        {
          "id": "SAXMATH5-f3k9-L03-03",
          "activityType": "Quiz",
          "title": "Lesson 3 Quiz",
          "required": true,
          "payload": { "kind": "reference", "reference": "Saxon Math 5 - Unit 2 - Quiz 3" },
          "difficultyTier": "D03",
          "rewardCategoryId": "R03",
          "courseName": "Saxon Math 5",
          "capturesGrade": true,
          "blockHint": "morning",
          "sequenceNumber": 1,
          "lessonTitle": "Multiplying Fractions"
        },
        {
          "id": "MIAHIST3-k7q2-L01-01",
          "activityType": "Practice Level",
          "title": "Timeline Practice",
          "required": false,
          "payload": { "kind": "none" },
          "difficultyTier": "D01",
          "rewardCategoryId": "R01",
          "courseName": "MiAcademy History",
          "capturesGrade": false,
          "sequenceNumber": 4,
          "lessonTitle": "Ancient Civilizations",
          "blockHint": "afternoon"
        },
        {
          "id": "HOMEART1-p8j5-L02-01",
          "activityType": "Sketchbook Page",
          "title": "Draw a Still Life",
          "required": false,
          "payload": { "kind": "freeText", "text": "Set up three objects on the kitchen table and sketch them from one angle." },
          "difficultyTier": "D01",
          "rewardCategoryId": "R01",
          "courseName": "Homemade Art Study",
          "capturesGrade": false,
          "blockHint": "afternoon"
        }
      ],
      "chores": [
        {
          "id": "CHR-b4n1-20260914",
          "choreType": "Kitchen/Dining",
          "title": "Unload dishwasher",
          "date": "2026-09-14",
          "difficultyTier": "D01",
          "rewardCategoryId": "R01",
          "required": true,
          "blockHint": "morning"
        }
      ],
      "events": [
        {
          "id": "EVT-t9x2",
          "title": "Piano recital",
          "startDate": "2026-09-14",
          "endDate": "2026-09-14",
          "time": "16:30",
          "notes": "Bring the black folder."
        }
      ]
    }
  ]
}
```

**Field notes:**
- Every `day` object **must include all three of `activities`, `chores`, `events` as keys**, even when one or more is an empty array (`packet_schema.json`'s `day` definition requires all three) — an entirely absent key fails schema validation, but an empty array is fine. A date with genuinely nothing due can still be omitted from `days[]` entirely; what's not allowed is including a day and dropping one of its three item arrays.
- **Optional fields are omitted when not applicable — never sent as `null`.** `sequenceNumber`, `blockHint`, `lessonTitle`, `instructions` (Activity), `notes`, `blockHint` (Chore), `notes`, `time` (Family Event) are all typed as plain `string`/`integer` in the schema with no `null` variant. If a field doesn't apply, the key is absent from the object, full stop. This is a real validation behavior, not a style preference — a packet built with explicit `null`s in these positions will be rejected.
- **`additionalProperties: false` is enforced at every level** — the packet root, each `day`, and each `activityEntry`/`choreEntry`/`eventEntry`. An incoming packet carrying any key not named in the schema fails validation whole-packet, same as a missing required field. This was an open question in the prior revision of this slice; the schema resolves it.
- `activityType` is a string key (e.g. `"Quiz"`), not an object — the Child App never needs the Activity Type table itself (Domain Model §2.5a). Packet Import validates presence only; it never inspects `activityType` to decide how to render `payload` (that's `payload.kind`'s job, below).
- **`payload` is a tagged union.** Its `kind` is stamped by Management at authoring/generation time, one of four values, each with its own required sub-fields and `additionalProperties: false` (Interchange Contract §1a, `packet_schema.json`'s `payload` definition):

  | `kind` | Additional required fields | Emitted for |
  |---|---|---|
  | `pageRange` | `pageRangeStart` (int ≥ 0), `pageRangeEnd` (int ≥ `pageRangeStart`) | PDF, Reading Pages |
  | `reference` | `reference` (non-empty string — a selector reference identifying the item inside a platform the child already reaches on their own; never a URL) | Video, Quiz, Test, Report, Workbook, Project, Drill |
  | `none` | — | Practice Level (its `sequenceNumber` *is* the payload, carried as the Activity entry's own field — see below) |
  | `freeText` | `text` (non-empty string) | every parent-added custom Activity Type, regardless of its `structurePattern` |

  The Child App renders by `kind` alone and never inspects `activityType`. M1's Packet Import (Module 2, FR-3) validates that `payload.kind` is one of the four values and that kind's required sub-fields — and *only* that kind's sub-fields — are present; a `pageRange` payload carrying a stray `reference` key fails validation under `additionalProperties: false`, not just an unrecognized-kind check.
- `difficultyTier` still rides along as the honest underlying reference for `rewardCategoryId`, but the Child App never resolves it against anything — it has no Difficulty Tier table.
- `rewardCategoryId` is **required** on every Activity and Chore entry. It's the Reward Ledger category the item mints into on completion (out of scope for M1's modules, but the field must be received, validated for presence, and stored now so M2 doesn't require a schema migration). The Child App validates it only for presence and non-empty string shape — never against a lookup table.
- `courseName` is **required** on every Activity entry (never present on Chore entries — `additionalProperties: false` on `choreEntry` means a stray `courseName` there is a validation failure, not a harmless extra). Carried verbatim from the Management-side Course name at packet-generation time. This is what Module 3's Subjects view groups by (SRS Module 3 FR-3), is displayed above 'activitytitle' in the planner views, and what the eventual Completion CSV's `course` column reports — the Child App parses no ID to derive it.
- `capturesGrade` is **required** on every Activity entry (bool). Stamped by Management at Activity creation without exception, so it is never legitimately absent. Not consumed by any M1 module (grade capture is Module 4, M2), but required at import time and stored now.
- `sequenceNumber`, when present, is an integer **≥ 1** (`packet_schema.json` sets `minimum: 1`) — omitted, never `0` or negative, when not applicable. Required, not optional, as an integer for `count`-structured types.
- `lessonTitle` is optional — display-only, copied from the owning Lesson's `title` at Activity creation (Domain Model §2.5); since Lesson `title` is required, absence should not occur in practice, but the field is still schema-optional.
- `instructions` is optional — copied unchanged from the Management-side Activity `instructions` (Domain Model §2.5), same treatment already given to Chore `notes` below.
- A Chore's `id` is never present in `activities[]`, and an Activity's `id` is never present in `chores[]` — the ID prefix (§3 below) is what a future module would use to distinguish them if needed, but M1 code can always tell them apart structurally since they arrive in separate arrays.
- **`choreType` is a closed enum, not free text.** `packet_schema.json`'s `choreEntry.choreType` is a JSON-Schema `enum` of eleven canonical chore categories, the same list Interchange Contract §1b carries: `Pet Care`, `Car Care`, `Kitchen/Dining`, `Bathroom`, `Living/Main Area`, `Playroom`, `Bedroom`, `Parent's Room`, `Porch`, `Floors`, `Miscellaneous`. An incoming chore whose `choreType` is anything else fails whole-packet validation (SRS Module 2 §5). A hand-authored test packet **must** use one of these exact strings — `"housework"`, `"outside"`, `"kitchen"`, and the like are *not* valid, and their rejection is correct behavior, not a bug in the validator. (The two earlier values `housework`/`outside` were superseded when the enum was expanded to per-area categories; the schema is the source of truth.)
- Chore entries carry **no** `activityType`, **no** `capturesGrade`, **no** `payload`, **no** `courseName`, **no** `sequenceNumber` — and, per `additionalProperties: false`, sending any of these on a Chore entry is a validation failure, not a tolerated extra.
- A Chore entry's `required` is always `true` (`packet_schema.json` pins this with `"const": true`) — stamped by Packet Generation, not parent-authored. A chore has no "optional" state.
- **A Chore entry carries its own `date` field, matching the enclosing day's `date`.** This is a deliberate, stated asymmetry (Interchange Contract §1a note) — Activity entries rely solely on the enclosing day's `date`; Chore entries additionally carry `date` on the entry itself, and `packet_schema.json`'s `choreEntry` marks it required. Redundant with the wrapper, but both must be present and both must agree; Packet Import does not need to reconcile a mismatch between them for M1 (constructing a hand-authored test packet should simply keep them equal).
- **A Chore entry's `id` is per-occurrence, not per-chore.** The same recurring chore due on three dates in this packet appears three times, on three different `days[]` entries, under three distinct IDs (§3). This is a deliberate design decision, not an oversight: it's what lets each occurrence be independently completed, refreshed, and reported, matching the same one-ID-one-completable-thing rule Activities already follow.
- **`daysOfWeek[]` never appears on a Chore entry in the Packet.** The recurrence rule (which days a Chore is due) is a Management-only concept, fully resolved into individual dated occurrences before export. The Child App has no recurrence logic and never needs one — carrying `daysOfWeek[]` here would invite a child-side recurrence evaluator, which the Domain Model deliberately doesn't sanction (§5.7's three named bounded-intelligence exceptions don't include one).
- Family Event entries carry no completion-related fields of any kind (they are never completable) and their `id` is the 2-segment form (§3).
- **A Family Event's `time` is display-only, 24-hour, and never parsed.** Format is `HH:MM` (e.g. `"16:30"`, `"09:00"`), per Interchange Contract §1c. The Child App shows it verbatim next to the event and never converts it, compares it, or schedules on it. `time` is optional; when absent the event simply shows no time. (An earlier draft of this slice's sample used a 12-hour `"3:00 PM"` string — that was a sample error; the fixture and contract are 24-hour.)
- **Constraints the schema cannot express — enforced by the validator as an explicit second pass.** `packet_schema.json` checks `type`, `required`, `enum`/`const`, `pattern`, `additionalProperties`, and numeric bounds (`minimum: 0` on the page fields, `minimum: 1` on `sequenceNumber`), but several relational rules live *between* fields and cannot be stated in JSON Schema — so the validator checks them in code, after the schema pass, and any failure rejects the whole packet exactly like a schema failure (Module 2's all-or-nothing rule):
  1. **`coversFrom ≤ coversTo`** — the packet's own date range is well-formed.
  2. **`pageRangeEnd ≥ pageRangeStart`** on every `pageRange` payload — the schema only floors both at `0`, so it cannot see the relation; the prose asserts it (Interchange §1a), the validator enforces it.
  3. **Each chore's own `date` equals its enclosing `days[]` entry's `date`** — the two are required to agree (the asymmetry note above); a mismatch is malformed.
  4. **Each event overlaps the packet range** — i.e. `[startDate, endDate]` intersects `[coversFrom, coversTo]`. This is an *overlap* test, deliberately **not** strict containment: a legitimately multi-day event may begin before `coversFrom` or end after `coversTo` and still be shown on its in-range days (Interchange §1c). An event entirely outside the range is the malformed case.
  5. **Every `days[].date` falls inside `[coversFrom, coversTo]`, inclusive** — the schema types each date but cannot relate it to the packet's own range.
  6. **No `days[].date` appears twice.** A date with nothing due may be omitted from `days[]` entirely; it may not be listed twice. Two entries for one date is malformed, not a merge to resolve.
  7. **No `id` appears twice across the whole packet** — all three arrays, all days — with **one sanctioned exception**: a multi-day Family Event repeats its `EVT-` id once per in-range day by design (Interchange §1c). Build the duplicate check to skip `eventEntry` ids, or to allow them only when every repeat is byte-identical. A repeated Activity or Chore-occurrence id is always malformed.
  8. **`sequenceNumber` is present when `payload.kind` is `reference` or `none`.** Those two kinds are the canonical *count*-structured types, whose ordinal the child must render (SRS Module 3 FR-10) — and for `none` (Practice Level) the ordinal is the *only* content, so its absence leaves nothing to show. The schema types `sequenceNumber` as optional-for-all because it can't see `structurePattern`; the validator restores the "required for count types" rule (Interchange §1a) using `kind`, which is all the child has. **`freeText` is deliberately exempt** — a custom type may be count- or page-range-structured and `kind` can't distinguish them, so its `sequenceNumber` is optional and simply displayed when present. `pageRange` types don't carry it.

  These are the same "app-level convention the schema can't catch" already noted for zero-padded numeric `seq` in §3 — gathered here so the validator's second pass is written once, not rediscovered per field.

---

## 3. ID scheme and delimiter

**Delimiter chosen: hyphen (`-`).** To keep this safe inside a readable composite ID *and* safe as a CSV cell value (Interchange Contract §4), every individual segment is restricted to alphanumerics only (no hyphens, no other punctuation) — so a hyphen unambiguously means "segment boundary," never "part of a segment." Confirmed by `packet_schema.json`'s `id` patterns on all three entry types.

**Activity ID:** `{courseCode}-{instanceToken}-{lessonCode}-{seq}`
- `courseCode` — alphanumeric only, e.g. `SAXMATH5`.
- `instanceToken` — alphanumeric only, base36, minted once per stamp (Management App concern; the Child App only ever reads this, never generates it).
- `lessonCode` — alphanumeric only, e.g. `L03`.
- `seq` — zero-padded integer, e.g. `02`.
- Schema pattern: `^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+$` (four alphanumeric segments — the schema does not itself distinguish `seq` as numeric-only, so a build that needs zero-padded numeric `seq` should enforce that as an app-level convention, not rely on the shared schema to catch a violation — this is one of the app-level checks gathered in §2's second-pass note).
- Example: `SAXMATH5-f3k9-L03-02`.

**Chore record ID (Management-side stored record — identifies the Chore *definition*, never appears in a Packet):** `CHR-{choreToken}`
- Fixed `CHR` prefix — this is what guarantees non-collision with Activity IDs. The guarantee is only as good as the assumption that no `courseCode` is ever literally `CHR` or `EVT`; Management Module 03 enforces this as an authoring validation rule rather than leaving it an assumption.
- `choreToken` — alphanumeric only, base36, minted once per Chore at creation (Management App concern).

**Chore occurrence ID (what a Packet, an Activity Record, and a Completion CSV row actually carry):** `CHR-{choreToken}-{YYYYMMDD}`
- Schema pattern: `^CHR-[A-Za-z0-9]+-\d{8}$` — the date suffix is schema-enforced as exactly 8 digits.
- **Minted deterministically at generation time**, by Packet Generation's chore expansion (Management Module 08): the same (choreToken, date) pair always produces the same ID. This is what keeps re-generating an already-covered date range idempotent with no separate lookup table — the child device sees the identical ID again and applies its existing refresh-on-pending / resolved-no-op logic exactly as already written.
- **Never parsed for scheduling.** The date segment is a minting detail, not a live source of truth — the occurrence's actual due date lives on its own `date` field (§2), which Deferment/Waive may legitimately move away from the date baked into the ID. Treat the ID as identity, not as schedule.
- A recurring chore due on several dates therefore has one record ID (`CHR-b4n1`, Management-side only) and one distinct occurrence ID per date (`CHR-b4n1-20260914`, `CHR-b4n1-20260915`, ...) — restoring the same one-ID-one-completable-thing rule Activities already follow. (`packet_sample.json` demonstrates exactly this: `CHR-b4n1` recurs across both of its days.)
- Example occurrence ID: `CHR-b4n1-20260914`.

**Family Event ID:** `EVT-{eventToken}`
- **Two segments — fixed `EVT` prefix plus one alphanumeric token. No `seq` segment.** Schema pattern: `^EVT-[A-Za-z0-9]+$`. Minted once at authoring on the Management side; guarantees non-collision with both Activity and Chore IDs via the same reserved-prefix guard as `CHR`.
- Example (from `packet_sample.json`): `EVT-t9x2`.

**Validation rule for M1's Packet Import (Module 2, FR-3/§5):** any incoming `id` that doesn't match one of these three prefix patterns is treated as a malformed entry and fails whole-packet validation, per Module 2's all-or-nothing rule. Implement these as the exact regexes above, not a looser approximation — `packet_schema.json` is the source of truth if you need to copy them verbatim into a validator.

**Edge case, stated for completeness:** if a Chore is later deleted on the Management side, any occurrence already delivered to the child device is unaffected — it remains a valid, completable item under its already-minted occurrence ID. It simply becomes unmatched-by-source on the Management side going forward (the same accepted handling already documented for a deleted Course Template's `sourceTemplateId`). Nothing in M1's Packet Import needs to detect or special-case this; it falls out of import never removing existing content (Module 2, FR-5).

---

## 4. IndexedDB schema (Child App, M1 scope only)

One database, e.g. `childAppDB`, version 1. Stores needed for Modules 1–3 only:

| Store name | Key path | Shape | Written by |
|---|---|---|---|
| `child` | fixed key `"child"` (singleton) | `{ name, pin }` | Module 1 (create), Module 11 (edit — later milestone) |
| `semester` | fixed key `"semester"` (singleton) | `{ label }` | Module 1 (create), Module 11 (edit — later milestone) |
| `themeSettings` | fixed key `"themeSettings"` (singleton) | `{ theme }` | Module 1 (create), Module 10 (edit — later milestone) |
| `activities` | `id` | Activity-as-received shape (§2) — `id`, `activityType`, `title`, `required`, `payload` (tagged union), `difficultyTier`, `rewardCategoryId`, `courseName`, `capturesGrade`, plus optional `expectedDurationMin`, `blockHint`, `sequenceNumber`, `lessonTitle`, `instructions` — **plus `date`**, copied from the enclosing `days[]` entry's `date` at import time (Activity entries carry no `date` of their own in the Packet), **plus `receiptIndex`** (integer, stamped at import, see below) | Module 2 (create/refresh) |
| `chores` | `id` (the per-occurrence ID, §3) | Chore-as-received shape (§2) — `id`, `choreType`, `title`, `date` (carried directly on the entry in the Packet — no copy-down needed, unlike Activities), `difficultyTier`, `rewardCategoryId`, `required`, plus optional `notes`, `blockHint`, **plus `receiptIndex`** | Module 2 (create/refresh) |
| `events` | `id` | Family Event-as-received shape (§2) — `id` (2-segment `EVT-{eventToken}`), `title`, `startDate`, `endDate`, plus optional `notes`, `time` | Module 2 (create) |
| `plannerMeta` | `id` (matches an `activities`/`chores` `id`) | `{ id, sortOrder?, blockHint?, deferredDate? }` — the **child-override record**. Every field but `id` is optional and written only when the child actually acts; an item the child has never touched has **no** `plannerMeta` record at all. | Module 3 (`sortOrder`, `blockHint`); Module 5 (`deferredDate` — M2, store defined now so no version bump is needed then) |

**Notes:**
- Singleton stores (`child`, `semester`, `themeSettings`) use a fixed key rather than an auto-incrementing key — there is exactly one record each, ever, in M1.
- `rewardCategoryId`, `courseName`, and `capturesGrade` on `activities`, and `rewardCategoryId` on `chores`, are **base required fields of `schemaVersion: 1`**, not additive fields layered on later — store and index them from the first build. No M1 module reads `capturesGrade` yet (that's Module 4, M2), but Packet Import must still validate its presence and persist it, so M2 doesn't require a schema migration to pick it up.
- **`date` handling differs by item type, and this matters for the import code path.** For an Activity, the stored record's `date` is *written by Module 2 during import*, copied from the enclosing `days[]` wrapper — the Packet's Activity entry itself has no `date` key. For a Chore, the Packet's entry already carries its own `date` key directly (§2); Module 2 can store it as received, though in practice it will equal the wrapper's date and either source is safe to use. Don't write import code that assumes both item types get `date` the same way — Activities require the copy-down step, Chores don't strictly need it but receive an identical value either way.
- `plannerMeta` is deliberately separate from `activities`/`chores` — Module 3's FR-4/FR-5 only ever touch `sortOrder`/`blockHint`, never the received item's own fields. Keeping them in separate stores makes it structurally impossible for the Daily Planner to accidentally mutate received content.
- Because every stored item — including each Chore occurrence — carries its own globally distinct `id` (§3), these two stores never need a compound key. `plannerMeta`, keyed the same way, naturally holds independent sort order and block assignment per occurrence, with no extra bookkeeping to keep multiple occurrences of the same recurring chore from colliding.
- **Effective `blockHint` (display precedence) and the canonical block set.** The block an item is *displayed under* is resolved at read time, in this order:
  1. a `blockHint` on that item's `plannerMeta` record — the child's override — wins;
  2. else the received item's own `blockHint` in `activities`/`chores`, **if it is one of the canonical four**;
  3. else **`morning`** — the default bucket, used identically for an **absent** `blockHint` and for an **out-of-set** one.

  The **canonical block set is exactly `morning`, `afternoon`, `evening`, `night`** (SRS Module 3 FR-5). `packet_schema.json` types `blockHint` as an unconstrained `string`, so an out-of-set value (say `"lunchtime"`) *passes* schema validation and is **stored as received** — it is simply never rendered as its own group; rule (3) folds it into `morning`. This is deliberate: validation can't reject it, so the display layer absorbs it. There is no "unassigned" bucket and no third fallback. A re-import's refresh-on-pending step (Module 2 FR-4) rewrites the received item's own fields but **never** touches `plannerMeta`, so a child's block override survives every subsequent import (Module 3 AC-4).

- **Ordering: block outer, category nested, position innermost.**

  The Today view (and the Subjects view at its top level) sorts on three nested axes, in this order:

  | Axis | Values, in fixed order | Source |
  |---|---|---|
  | 1 — **Block** (outer) | `morning` → `afternoon` → `evening` → `night` | effective `blockHint`, resolved as above |
  | 2 — **Category** (nested in each block) | School Activities → Chores | the item's store (`activities` vs `chores`) — intrinsic, never child-editable |
  | 3 — **Position** (innermost, within each block+category group) | ascending sort key | see below |

  Family Events are **outside this structure entirely** — their own section, never in a block, a category, or a sort position. A block with no items renders nothing (no empty header).

  Overdue roll-forward items (still-pending required items whose effective due date is before today) drop into **today's** list under their **own** effective block and sort among today's items of that block+category by the same key below. There is no separate "overdue" block, section, or sort bucket.

- **The sort key: `receiptIndex` and `sortOrder` share one number space.**

  Two values would otherwise need comparing across incompatible spaces (a receipt position vs. a child-chosen order), which is a bug factory. Instead:

  - At import, Module 2 stamps every **newly-added** item with **`receiptIndex`** — an integer from a single counter incremented across the whole packet in traversal order: `days[]` in array order, and within each day `activities[]` then `chores[]` (the Packet's own fixed merge order, Domain Model §2.10). A **refresh** of an existing item does **not** restamp `receiptIndex` — it is written once, when the item first arrives, so a re-import never reshuffles a list the child is already looking at.
  - An item's **effective sort key** is `plannerMeta.sortOrder` when present, else its `receiptIndex`. Both are plain numbers in the same space, so they compare directly.
  - When the child drags an item to a new position (Module 3 FR-4), Module 3 writes `plannerMeta.sortOrder` as the **midpoint of the effective keys of its two new neighbours** (a float — `(a + b) / 2`); dropped at the top of a group, `firstKey - 1`; at the bottom, `lastKey + 1`. Only the moved item is written — never the whole group.
  - **Tie-break: `id`, ascending, as a string.** Two items can land on the same effective key (e.g. an overdue item and a today item that happen to share a `receiptIndex` from different packets). The `id` tie-break makes the render order total and deterministic, which matters because the list must not shuffle between renders.
  - `sortOrder` is compared **only within an item's block+category group** — it is never a global ordering. Moving an item to another block (which writes `blockHint` and *not* `sortOrder`) therefore carries its existing key into the new group, and it lands wherever that key falls. This is correct and intended.

  Block choice and sort position are **independent axes**: moving between blocks writes only `plannerMeta.blockHint`, reordering writes only `plannerMeta.sortOrder` (Module 3 FR-4/FR-5). Until the child touches either, there is no `plannerMeta` record for that item at all and both fall back to their defaults.

- **Effective due date: `plannerMeta.deferredDate` overrides the received `date`, and import never clobbers it.**

  A PIN-gated deferment (Module 5, Milestone M2) moves an item's due date. It writes `plannerMeta.deferredDate` — it does **not** rewrite the item's `date` in `activities`/`chores`, which stays as-received. Every date test in Module 3 (due today? overdue?) reads the **effective due date**: `plannerMeta.deferredDate` when present, else the item's own `date`.

  This is what makes the two rules consistent that would otherwise collide: Module 2's refresh-on-pending rewrites a pending item's received `date` from the incoming copy (so a parent's re-pace lands), while a child-side deferral — recorded in `plannerMeta`, which import never touches — survives. **A re-import can never silently un-defer an item.** Waiving remains the way to remove a delivered item the parent no longer wants done (Module 2 §2.2).

  At M1 nothing writes `deferredDate` (Module 5 is M2), so the effective due date is always the received `date`. The **read-side resolution is still written now**, in M1's Module 3, so Module 5 lands without touching this module. Defining the field now also means `plannerMeta` needs no schema version bump at M2.

- **`childId` and `childName`: passthrough. No store, no check, no gate.** Both are required Packet fields; neither is stored anywhere in `childAppDB` and neither is validated against anything. The Child App is single-child and holds no `childId` of its own (the `child` store is `{ name, pin }`), so there is nothing authoritative to match against. **A packet generated for a different child imports silently and successfully.** This is accepted, not an oversight — the parent controls which file reaches which device, and the Completion CSV reconciles on `activityId` alone, never on `childName` (Interchange Contract §1, §3). Do not add a mismatch reject; it would be a contract change.

- **There is no `dailyPlan` store, and there never will be.** The Daily Plan is **derived at render time** (Domain Model §3.4) from `activities` + `chores` + `events` + `plannerMeta` + the device-local date. Nothing about a day is persisted: no day record, no `blocks[]` array, no assembled list. Domain Model §3.4 previously listed `activities[]`/`events[]`/`blocks[]` as required fields of a Daily Plan entity; that field list described a shape that does not exist and has been withdrawn. The only child-authored per-item state in the whole app is the `plannerMeta` record above.

- Not included yet (reserved for M2 and later): `activityRecords` (Module 4), `rewardLedgerSnapshot`/`rewardLedgerTail` (Module 6), `streak` (Module 7). Adding these later is an additive schema change (a new store in a version bump), not a redesign of anything above.
- **No completion store exists at M1, by design.** Because `activityRecords` (Module 4, Milestone M2) is absent, Module 3's completion filters read against a store that isn't there and are no-ops — every actionable item is pending (SRS Module 2 §2.3, Module 3 FR-1). Nothing in this slice needs a `status` field on `activities`/`chores`; pending-ness is the absence of a completion record, not a stored flag, and adding the record store later does not change the shapes above.
- **`lessonTitle` and `instructions` do not bump `schemaVersion`.** Both are optional packet fields, omitted (never `null`) when absent, per §2's rule. This no longer depends on an unconfirmed assumption about Module 2's key-whitelisting — `packet_schema.json`'s `additionalProperties: false` locks it: Packet Import must reject any packet carrying a key not in the schema, and accept one that omits an optional key cleanly.
- At Startup Wizard completion, the app calls `navigator.storage.persist()` and proceeds regardless of the answer — a best-effort request to exempt this origin from browser storage eviction. Denial is not surfaced to the child; residual eviction risk is accepted and covered by the recovery-note-plus-repair design (Domain Model §5.9).
- **Validation mechanism — how the validator stays in sync with the schema (Architecture Evaluation §6).** The stack is vanilla JS with no npm and no build step, so there is no vendored JSON-Schema library. Instead the app bundles `packet_schema.json` itself as a data asset and a small hand-written validator *walks that actual schema file at runtime* — a minimal interpreter of the Draft-07 subset the schema uses. **The complete keyword list — the Rev 3 version of this list was incomplete and would have produced a validator that could not traverse the schema at all:**

  | Keyword | Why it's needed |
  |---|---|
  | `$ref` + `definitions` | The schema is almost entirely `#/definitions/...` pointers (`day`, `payload`, `activityEntry`, `choreEntry`, `eventEntry`). Without local pointer resolution the walker cannot reach a single entry. |
  | `properties` | Descend into an object's named sub-schemas. |
  | `items` | Descend into `days[]`, `activities[]`, `chores[]`, `events[]`. |
  | `type` | `object`, `array`, `string`, `integer`, `boolean`. |
  | `required` | Missing-key rejection. |
  | `additionalProperties: false` | Unknown-key rejection, enforced at every level (root, `day`, each entry, each `payload` branch). |
  | `enum` | `choreType`'s eleven canonical values. |
  | `const` | `schemaVersion: 1`, `payload.kind`, chore `required: true`. |
  | `pattern` | The three `id` regexes and the `YYYY-MM-DD` date fields. |
  | `minimum` | `0` on the page fields, `1` on `sequenceNumber`. |
  | `minLength` | `1` on `payload.reference` and `payload.text`. |
  | `oneOf` | The `payload` tagged union. |

  **`format` is deliberately NOT implemented.** Draft-07 treats it as an annotation, not an assertion, and nothing in either app parses `generatedAt` — so its `format: date-time` is checked as `type: string` only. Stated so a build session doesn't waste effort on a date-time parser or, worse, reject a valid packet.

  **Three traps, because this validator is hand-rolled. The third is a silent-failure bug and was caught only by running the spec:**
  1. **`required` is both a keyword and a property name.** `activityEntry` and `choreEntry` each declare `properties.required` (a boolean field). The walker must only read keywords at *schema* level and never treat a key inside a `properties` map as a keyword. A naive `if ('required' in node)` will misfire here.
  2. **`additionalProperties: false` inside a `oneOf` branch is evaluated per branch**, against that branch's own `properties` only — never against a merged parent. This is what makes a `pageRange` payload carrying a stray `reference` key fail, and it only works if each branch is validated in isolation.
  3. **A `oneOf` branch has no `type` of its own.** Each of `payload`'s four branches declares only `properties` / `required` / `additionalProperties` — the `type: "object"` lives on the *parent* `payload` schema. A validator that dispatches on `type` and does nothing when `type` is absent will therefore **silently pass every payload, including a malformed one** — no error, no rejection, garbage stored. This was found by actually running the Rev 3 spec against the golden fixture; it is not hypothetical. Two mitigations, both applied: `packet_schema.json`'s four `oneOf` branches now carry an explicit `"type": "object"` (a defensive addition that changes which packets validate — none — and does **not** bump `schemaVersion`), and the validator must additionally treat any subschema carrying `properties` or `required` as an object regardless of whether `type` is stated.

  There is therefore exactly **one** schema artifact and nothing to drift: adding a field to `packet_schema.json` extends validation automatically, with no mirrored rule-set to keep in step. The only checks written by hand are the eight relational constraints in §2 that no JSON-Schema keyword can express, run as an explicit second pass after the schema walk. This is the decision locked in Architecture Evaluation §6; it is restated here because it is the concrete thing the Module 2 build session needs in front of it.
- **Indexing: none at M1 (Architecture Evaluation §6).** At M1 volumes — one packet per child per import cycle — full scans over `activities`/`chores` (e.g. to assemble a date's Today view or the overdue rollup) are acceptable; no secondary indexes are defined. If a later milestone's volume makes date-range queries slow, adding a `date` index is an additive version bump, not a redesign of the shapes above.

---

## 5. What this slice deliberately leaves open

- Ledger checkpoint cadence (N entries / on wipe) — not needed until Module 4/6.
- `sortOrder`'s numeric type is fixed (a float sharing `receiptIndex`'s space, §4); its *precision floor* under repeated midpoint insertion is not — a child reordering the same short list dozens of times will eventually exhaust float precision. Not a real risk at M1 list sizes (a handful of items per group), and the fix if it ever bites is a renormalisation pass over the group, not a redesign. Noted, not solved.
- Management App schema entirely — separate app, separate milestone (M4+).
- The Completion CSV (`completions_sample.csv`) is out of M1's build scope (Module 08 is M2+), but it's worth knowing what it confirms in passing, since it's built from the same received-item fields M1 stores: a Chore row's `course` column is blank (Chore entries never carry `courseName`, consistent with §2), its `activityType` column is the Chore's own `choreType`, and `sequenceNumber` is blank both for page-range-structured Activities and for every Chore row. None of this is an M1 requirement — it's confirmation that the fields M1's Packet Import validates and stores now are the same ones the CSV export will read later, with no gap to fill in between.

The wipe trigger mechanism, the Chore-row placeholder for the Completion CSV's `course`/`activityType` columns, and `sequenceNumber` as a CSV column are **resolved and locked** elsewhere (Architecture Evaluation §13, Domain Model §6) — they no longer belong on this slice's open list. They're omitted here only because they're outside M1's build scope, not because they're undecided.

---

## 6. Acceptance check for this slice

Before handing Modules 1–3 to a build session, confirm:

1. A hand-authored packet JSON file matching §2's shape validates against `packet_schema.json` directly (not just "by eye" against prose) — including that every Activity entry carries `rewardCategoryId`, `courseName`, and `capturesGrade`, every Chore entry carries `rewardCategoryId` **and its own `date`**, and no entry of any type carries a key the schema doesn't name.
2. `packet_sample.json` itself imports cleanly end-to-end through Modules 1–3's build (Interchange Contract §8's own requirement) — this is the actual acceptance bar, not just a hand-authored test file.
3. A test packet with an optional field explicitly set to `null` (rather than omitted) is **rejected** by validation — confirming the omit-don't-null rule is enforced, not just documented.
4. Every `id` in a test packet matches one of §3's three prefix patterns — including that Family Event IDs are 2-segment (`EVT-{eventToken}`).
5. A test payload of each `kind` (`pageRange`, `reference`, `none`, `freeText`) validates with only that kind's required sub-fields present; a payload missing a required sub-field, *or carrying an extra one*, fails validation.
6. The `childAppDB` schema in §4 has a store for every field Modules 1–3 need to read or write, and no store for anything M2+ owns.
7. `packet_sample.json`, imported on a device whose local date is 2026-09-14, renders a Today view with a **morning** block containing the two Saxon Math activities (School) then "Unload dishwasher" (Chore), an **afternoon** block containing "Timeline Practice" then "Draw a Still Life" (both School, in receipt order), an Events section containing "Piano recital", and **no evening or night block rendered at all**. This is the single end-to-end check that the block-outer / category-nested / position-innermost ordering is actually implemented.
8. An item whose packet `blockHint` is **absent**, and one whose `blockHint` is **out-of-set** (e.g. `"lunchtime"`), both render under **morning** and both import cleanly — the schema permits any string, so an out-of-set value never fails validation and is stored as received; the Daily Planner folds it into the `morning` fallback rather than dropping it, duplicating it, or bucketing it as "unassigned" (SRS Module 3 AC-11, §4's display-precedence note).
9. A packet with a `days[].date` outside `[coversFrom, coversTo]`, a duplicated `days[].date`, or a duplicated Activity/Chore `id` is rejected whole. A packet whose multi-day Family Event repeats the same `EVT-` id across days imports cleanly.
10. A packet whose `childId`/`childName` do not match the device's child imports silently and successfully — no warning, no reject.
11. Reordering an item, then re-importing a packet that still contains it, leaves it in the child's chosen position; moving an item to another block, then re-importing, leaves it in the child's chosen block. The refresh-on-pending step updates the received fields but leaves `plannerMeta` untouched, so both the effective block and the sort position are unchanged (SRS Module 2 FR-4, Module 3 AC-3/AC-4).
12. The `plannerMeta` store accepts a `deferredDate` field at M1 without a schema version bump, and Module 3's date resolution reads it (even though nothing writes it until M2).
13. A test packet containing one daily chore across a 7-day range carries seven distinct chore entries, one per `days[]` date, sharing the `CHR-{choreToken}-` stem but each with a different 8-digit date suffix, and each entry's own `date` field matching its enclosing day — never one entry repeated or refreshed across days.
14. Every stored `activities`/`chores` record carries its own `date` field after import (via copy-down for Activities, via direct receipt for Chores — §4), and the Daily Planner's date-keyed views (Today / overdue rollup, Module 3 FR-1) can be assembled by reading stored records alone.
15. A test packet with two Activities carrying different `courseName` values (or two Courses that a person would call the same subject but under different exact strings) renders as two separate groups in the Subjects view — confirming the known, accepted string-match limitation (SRS Module 3 §2.2) rather than an unexpected merge or crash.
16. A test chore using a `choreType` outside the canonical enum (e.g. `"housework"`) is **rejected**, and one using a canonical value (e.g. `"Kitchen/Dining"`) is accepted — confirming `choreType` is enforced as the closed set in `packet_schema.json` / Interchange §1b, not free text.
17. A packet whose `schemaVersion` is missing or not exactly `1` is rejected **before any content parsing**, with a distinct plain-language message naming the version problem — not a generic dump of schema failures (SRS Module 2 FR-2, Interchange §8).
18. The validator's second pass rejects each of the cross-field violations §2 names — `coversFrom > coversTo`, `pageRangeEnd < pageRangeStart`, a chore `date` disagreeing with its enclosing day, an event lying entirely outside the packet range, and a `reference`- or `none`-kind Activity missing `sequenceNumber` — each as a whole-packet rejection, while a multi-day event that merely *overlaps* the range, and a `freeText` Activity with no `sequenceNumber`, are both accepted.
19. A `none`-kind (Practice Level) Activity carrying `sequenceNumber: 4` and a `reference`-kind (Quiz) Activity carrying `sequenceNumber: 1` both round-trip: stored on import, rendered as a child-facing ordinal by the Daily Planner (SRS Module 3 FR-10), and later emitted in the Completion CSV's `sequenceNumber` column (Interchange §2) — while a `pageRange` Activity leaves that column blank.
20. Each `payload.kind` renders its content on the Daily Planner item by kind (SRS Module 3 FR-11): a `pageRange` shows a human-readable range (e.g. "Pages 22–27" for the sample's `SAXMATH5-f3k9-L03-02`), a `reference` shows its selector string, a `freeText` shows its text, and a `none` shows no payload line — with no branch keyed off `activityType`.
