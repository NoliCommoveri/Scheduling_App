# Interchange Contract — Management App ⇄ Child App

*Extracted from Domain Model §4, with supporting field-level detail pulled from Management SRS Module 08 (Packet Generation & Export), Child SRS Module 02 (Packet Import), Child SRS Module 08 (Completion CSV Export), and Management SRS Module 09 (Completion Import). This is the single source of truth for anything that crosses between the two apps.*

*Companion artifacts, normative: `packet_schema.json`, `packet_sample.json`, `completions_sample.csv`. Where prose and schema disagree, **the schema wins** — that is the point of having it.*

*If a build session on either side needs to change something here, the change is made in this file first, then carried back into Domain Model §4 and the relevant SRS module in the same sitting — never decided locally inside one app's build session and left for the other side to discover later.*

---

## 0. The one rule that makes this document possible

**Domain Model §5.3: "Two schemas, one contract."** Management and Child apps have separate IndexedDB schemas and never share a database. The *only* thing they share is what's in this document. Neither app's internal storage shape, module structure, or code should ever need to be known by someone building the other app. If a build session finds itself needing to know something about the *other* app beyond what's written here, that's a signal the contract is under-specified — raise it, don't guess.

**Corollary: the Child App never parses an ID.** Every value the child needs to display, group by, or export is carried as its own field. IDs are opaque join keys on the child side — compared for equality, never decomposed. (Management parses the `CHR-{choreToken}` stem on import; that is a Management-side act, §3.)

---

## 1. The Packet (Management → Child)

**Purpose:** carries a bounded slice of pre-generated daily work for one child to the child device.

**Shape:**
```
{
  schemaVersion,          // integer. Current value: 1.
  childId, childName,
  semesterLabel,          // passthrough only — never validated against the device's own label
  generatedAt, coversFrom, coversTo,
  days[]: [
    {
      date,               // YYYY-MM-DD. Authoritative for every activity in this day.
      activities[],       // see §1a
      chores[],           // see §1b
      events[]            // see §1c, display-only
    }
  ]
}
```

`generatedAt` is an ISO-8601 timestamp. `coversFrom`, `coversTo`, and every `date` are `YYYY-MM-DD`. Dates are **calendar dates, never instants** — no timezone, no offset, ever. Both apps compare them as strings.

### 1a. Activity entries carry

**Required:** `id`, `activityType`, `title`, `required` (bool), `payload` (tagged union — see below), `difficultyTier`, `rewardCategoryId`, `courseName`, `capturesGrade` (bool).

**Optional, present when authored:** `expectedDurationMin`, `blockHint`, `sequenceNumber` (**required** for `count`-structured types — at the seam, where `structurePattern` is not visible, this means required whenever `payload.kind` is `reference` or `none`, and optional for `freeText`, since a custom type may be either structure and `kind` alone cannot distinguish them; it carries the "which one of the series" ordinal the child displays), `lessonTitle`, `instructions`.

**Activity entries do NOT carry `date`** — the enclosing day's `date` is authoritative and is what the child stores on the received item. (Chore entries *do* carry `date`; see §1b. The asymmetry is harmless but is stated rather than assumed.)

`lessonTitle` and `instructions` ride through automatically because Packet Generation copies every field as currently authored (Mgmt Module 08, FR-8) — they are not separate Packet-format additions. `courseName` and `rewardCategoryId` ride through the same rule.

**`payload` is a tagged union.** Its `kind` is stamped by Management at authoring time, derived from the Activity Type's `structurePattern` *and* whether the type is canonical or parent-added — because a custom `page-range` type carries free text, not start/end fields (Mgmt SRS 03 §8), so `structurePattern` alone does not predict shape.

| `kind` | Additional fields | Emitted for |
|---|---|---|
| `pageRange` | `pageRangeStart` (int ≥ 0), `pageRangeEnd` (int ≥ `pageRangeStart`) | PDF, Reading Pages |
| `reference` | `reference` (non-empty string — a **selector reference** identifying the item inside a platform the child already reaches on their own. Never a URL. Nothing in this system routes a child anywhere.) | Video, Quiz, Test, Report, Workbook, Project, Drill |
| `none` | — | Practice Level (its `sequenceNumber` *is* the payload) |
| `freeText` | `text` (non-empty string) | **every** parent-added custom Activity Type, regardless of its `structurePattern` |

The child renders by `kind` and **never inspects `activityType`** — the same discipline already locked for `capturesGrade` (Child SRS 04 §2). A parent-added Activity Type therefore needs zero child-side change, which is the property Child SRS 04 AC-8 already claims and which `kind` is what actually delivers.

`capturesGrade` is **required** on every Activity entry, not optional: Mgmt SRS 03 FR-10 stamps it at Activity creation for every Activity without exception, so it is never legitimately absent.

`courseName` is the received Activity's course, carried verbatim so the child never needs to derive it from anything else. It is what the Subjects view groups by and what the Completion CSV's `course` column reports (§2).

`rewardCategoryId` is the reward category the item's `difficultyTier` maps to, stamped by Management at Packet Generation. The child has no Difficulty Tier table of its own; it mints its earn entry from `rewardCategoryId` directly and never resolves `difficultyTier` against anything. `difficultyTier` still rides along as the honest underlying reference, but the child never needs to look it up.

### 1b. Chore entries carry

**Required:** `id` — the **per-occurrence** ID, `CHR-{choreToken}-{YYYYMMDD}`, minted at generation time, never the parent record's own `id`. Also `choreType` (one of: Pet Care, Car Care, Kitchen/Dining, Bathroom, Living/Main Area, Playroom, Bedroom, Parent's Room, Porch, Floors, Miscellaneous), `title`, `date`, `difficultyTier`, `rewardCategoryId`, and `required` (always `true`; stamped by Packet Generation, not parent-authored — a chore has no "optional" state).

**Optional:** `notes`, `blockHint`.

Chore entries carry **no** `activityType`, **no** `capturesGrade`, **no** `payload`, **no** `courseName`, **no** `sequenceNumber`. Their absence is meaningful and the child treats absent `capturesGrade` as `false` (Child SRS 04 FR-2).

**`daysOfWeek[]` never travels in the Packet** — recurrence is a Management-only concept and is never evaluated on the child side.

### 1c. Family Event entries carry

**Required:** `id` (`EVT-{eventToken}`), `title`, `startDate`, `endDate` (a single-day event sets them equal).
**Optional:** `notes`, `time`.

`childIds[]` context is already resolved — fan-out to each named child happens before export. Display-only: no Activity Record, ever, and no CSV row. Events appear on every day in `[startDate, endDate]` that falls inside the packet's range.

`time` is display-only and uses 24-hour format (e.g., `"15:00"`, `"09:00"`). It is never parsed for scheduling.

**Multi-day events:** A multi-day event appears in every day's `events[]` array with the same `id`. This repeated entry is intentional for display purposes and does not trigger a duplicate-ID validation error.

**Lifecycle:** generated from the per-child, per-date-range aggregation → advances each contributing Instance's `progressCursor` on the Management side (before export — the one-way interchange makes a child-side trigger impossible) → written to Drive (or manual file) → imported by the Child App.

### 1d. Child-side overrides

The child device may hold local overrides that the Packet never carries and Management never sees. **Import refreshes the received item's own fields; it never clobbers an override.** There are exactly two:

**1 — Block label (`blockHint`).** The canonical set is four labels: `morning`, `afternoon`, `evening`, `night`. A child may override an item's block to any of the four.

**Effective block — the precedence, binding on the child side:**
1. the child's override, if one exists; else
2. the packet's `blockHint`, if present **and** one of the canonical four; else
3. **`morning`** — the default bucket, used identically for an absent `blockHint` and for one outside the canonical set.

An out-of-set `blockHint` is **stored as received** (the schema permits any string, so it never fails validation) but is never rendered as a block; it simply falls to `morning` for display. The effective block is the **outer** grouping axis of the child's Today view (Child SRS Module 3 FR-1) — a change from the earlier "unused for ordering" position, which is superseded.

**2 — Deferred due date.** A PIN-gated deferment (Child SRS Module 5) moves an item's due date on the child device only. The item's **effective due date** is its deferred date when one exists, otherwise the `date` it was received with. A re-import rewrites the received `date` but never the deferred date — a parent's later re-pace does not silently un-defer an item the parent already rescheduled on the device.

Neither override ever appears in an exported packet, and neither crosses the interchange in any direction. Only the parent's original `blockHint` and the received `date` are Management-side values.

### Rules (binding on both sides)

- **Additive with refresh-on-pending**, scoped to the packet's own date range. A resend with the same `id` refreshes a still-pending item's display fields/received `date`/tier; against an already-resolved item it's a full no-op. It never overwrites a child-side override (§1d) — neither the block label nor a deferred due date. Import never touches days outside its range or already-made completion records.
- **All-or-nothing validation.** A packet failing schema or semester checks is rejected whole — no partial apply.
- **Structural rules the JSON Schema cannot express** (enforced as an explicit second pass, and binding on the generator too — Management must never emit a packet that violates one):
  - `coversFrom` ≤ `coversTo`.
  - Every `days[].date` falls inside `[coversFrom, coversTo]`, inclusive.
  - **No duplicate `days[].date`** — a date appears at most once in `days[]`. (A date with nothing due may be omitted entirely; it may not appear twice.)
  - **No duplicate `id` within one packet**, across all three arrays and all days — with the **one sanctioned exception** of a multi-day Family Event, which repeats the same `EVT-` id once per in-range day by design (§1c).
  - Each `choreEntry.date` equals its enclosing day's `date`.
  - `pageRangeEnd` ≥ `pageRangeStart`.
  - `sequenceNumber` is present whenever `payload.kind` is `reference` or `none` (§1a).
  - Every `eventEntry` overlaps the packet's `[coversFrom, coversTo]` range.
- **`childId` and `childName` are passthrough only, on both ends.** The Child App is single-child and stores no `childId` of its own, so it has nothing to match a packet against: it **does not validate, reject, or store** either field, and importing a packet generated for a different child succeeds silently. This is accepted — the parent controls which file reaches which device, and the Completion CSV's reconciliation key is `activityId` (§3), never `childName`. Neither field may be used to gate an import.
- **Version check is early and distinct.** Before running full packet validation, check `schemaVersion` immediately. If `schemaVersion` is missing or not exactly `1`, stop all content parsing and return a distinct, plain-language error message (not generic schema output). Example message: `"Packet schema version unsupported. Expected version 1, got: [actual value]"`. A `schemaVersion` the child does not recognize is a **whole-packet reject** — never a best-effort partial parse, never a silent field-drop.
- **Stable IDs preserved** — Activity/Family Event IDs identical to their Management-side originals; Chore IDs are the per-occurrence ID minted at generation, deterministic per `(choreToken, date)`.
- **Variable range.** A packet may cover any number of days; cadence is the parent's runtime choice — there is no fixed "current packet" concept to bound anything against.
- **No spend channel.** The Packet never carries Reward Ledger spend instructions. Spends are local to the child device only, under no circumstances transmitted.
- **No PIN gate on import itself.** Import is receive-only and ungated; the all-or-nothing validation is the only protection against garbage input.
- **`semesterLabel` is passthrough only**, on both ends. Never auto-rejected on mismatch; the device's own stored semester label is never altered or validated by an import.
- **No automatic removal.** If a parent drops a planned item from future pacing, an already-delivered pending copy is not auto-removed by any later import. It stays on the Daily Plan until completed or waived. Import has no removal behavior of its own.

---

## 2. The Completion CSV (Child → Management)

**Purpose:** reports what actually happened — the parent's spreadsheet dashboard today, the Management import source in Phase 4.

**Columns — locked, eleven total, the single authoritative list:**
```
activityId, date, course, activity, activityType, plannedBlock, status, grade, childName, semesterLabel, sequenceNumber
```

**Column sourcing (child side, at export time):**

| Column | Source |
|---|---|
| `activityId` | The Activity Record's `activityId` — present from v1 even before anything consumes it. Never dropped. |
| `date` | Activity Record `date`. |
| `course` | The received Activity entry's **`courseName`**, verbatim. Blank for Chore rows. The child parses no ID to produce this value. |
| `activity` | The received item's `title`. |
| `activityType` | The received Activity's `activityType`; for Chore rows, the Chore's own `choreType` (a value from §1b's canonical enum) — not a placeholder. |
| `plannedBlock` | The received item's `blockHint` **as it arrived from Management**, if any — never the child's local block override (§1d). The column reports what the parent *planned*, not where the child moved it. Blank when the item carried no `blockHint`. |
| `status` | `complete` or `waived` (reserved value, distinguishing a deliberate skip from an undone item). |
| `grade` | Activity Record `grade`, per the Activity Type's `capturePattern`; blank unless captured. Whole-number percentage, 0–100. |
| `childName` | Child record, passthrough only. |
| `semesterLabel` | Semester, passthrough only. |
| `sequenceNumber` | Copied directly from the received item at export time — same sourcing pattern as `plannedBlock`. Blank for page-range types and Chore rows. |

### Rules (binding on both sides)

- **One row per Activity Record.** UTF-8, RFC 4180, append-only in spirit. Header row always present, always the eleven names above, always in that order.
- **The header IS the version.** The CSV carries no version field. Completion Import rejects a file whose header does not match the locked eleven.
- **A Chore row's `activityId` is the occurrence ID** — one row per completed occurrence. This is what makes idempotent re-import by `activityId` exact, with no compound key needed.
- **Family Events never produce rows**, under any circumstance.
- **Columns are never conditionally omitted.** The column set is fixed for every row regardless of source; not-applicable fields are left blank (`course`, `grade`, `plannedBlock`, `sequenceNumber` as applicable), never dropped from the row shape.
- **No `actualStart`, `actualFinish`, `durationMin`, or `notes` columns.** These fields don't exist on the Activity Record. Reintroducing any of them is a fresh decision requiring a real capture mechanism designed alongside it — not a default to revisit casually.
- **`exported` flips one-way, `false → true`, only on a successful export** (Child Module 08, FR-5) — this is the double gate the child-side wipe depends on (record must be both resolved *and* exported before it's eligible to clear).
- **A recovery note is written alongside the CSV on every successful export** (device-local date, `currentStreak`, per-category balances) — this note is explicitly **not part of the CSV contract**, is write-only, and is never read by any module in either app. Note-write failure never blocks the CSV export or the `exported` flag.

---

## 3. Reconciliation (Management-side import — Phase 4, contract fixed now)

**Purpose:** when Completion Import ships, fold each child's Completion CSV back into Management-side records, landing in Imported Completion Records (Domain Model §2.12) — a distinct data set, never merged into or confused with authored Course/Lesson/Activity/Chore/Instance content.

**Matching rule — by `activityId` lookup alone, never by `childName`/`semesterLabel`.** Both of those columns are passthrough-only, describing what the child device *believed* about itself at export time — not authoritative for routing. IDs are minted globally-unique and never reused, so every existing ID's ownership is fully recoverable by looking it up against current Management-side records (for Chore rows, via the `CHR-{choreToken}` stem, since only the stem is a stored parent record — the stem is the first two `-`-delimited segments, and this is the one sanctioned ID parse anywhere in either app).

**Rules:**
- **Collect-and-reconcile, not live merge.** Reads a CSV the parent supplies; does not sync automatically.
- **Row-level partial commit.** One bad row does not reject the whole file.
- **Idempotent re-import by `activityId`.** Already-imported rows are a no-op, not a duplicate or an error.
- **Unmatched rows are reported, not silently dropped** — e.g. rows referencing a since-deleted Instance.
- **`childName` mismatch is a non-blocking warning**, surfaced by name (both the row's stated value and the resolved actual value) — worth the parent's attention, never grounds to reject the row.
- **`course` is never used for matching.** It is a display passthrough, and a stale one by design (it reflects the course name at packet-generation time, not today). A later rename on the Management side does not invalidate any row.
- **No write-back to authored content, ever.** Import's only write is a new Imported Completion Record per matched row.
- **Every import produces a summary**: counts of newly-imported, already-imported (no-op), unmatched rows, and any mismatch warnings. Never a silent background operation.

---

## 4. ID scheme (both sides must honor, neither side may reinterpret)

**Delimiter: `-` (U+002D, hyphen-minus). Every segment is `[A-Za-z0-9]+` — alphanumeric only, never empty, never containing the delimiter.** This is what makes IDs safe in CSV cells and makes the Chore-stem parse (§3) unambiguous.

| ID | Form | Segments | Minted by |
|---|---|---|---|
| **Activity** | `{courseCode}-{instanceToken}-{lessonCode}-{seq}` | 4 | Management, once, at Instance stamping. e.g. `SAXMATH5-f3k9-L03-02` |
| **Activity (template)** | `{courseCode}-TPL-{lessonCode}-{seq}` | 4 | Management, at template authoring. **Never travels in a Packet.** The literal `TPL` in segment 2 is what makes that assertable. |
| **Chore record** | `CHR-{choreToken}` | 2 | Management, at Chore authoring. **Never travels in a Packet.** |
| **Chore occurrence** | `CHR-{choreToken}-{YYYYMMDD}` | 3 | Packet Generation, at expansion. This is what Packets, Activity Records, and the CSV all carry. |
| **Family Event** | `EVT-{eventToken}` | 2 | Management, at Family Event authoring. |

- Activity IDs are **never copied, never reused, never recomputed on the child side.**
- Chore occurrence IDs are **deterministic** per `(choreToken, date)` — never randomized. **The date segment is never parsed for scheduling**: `date` is the scheduling field, and deferment may move it independent of the ID.
- **Prefix collision guard:** `CHR`, `EVT`, and `TPL` are reserved values that `courseCode` and `lessonCode` can never take (Mgmt SRS 03 validation), and that a minted `instanceToken` can never equal (case-insensitively — a random base36 token can come up `tpl`; re-roll it). Combined with fixed segment counts, no ID in any namespace can collide with any ID in another. **A packet entry whose Activity ID carries `TPL` in segment 2 is a template ID that escaped; it is a defect, and either side may assert against it.**
- **The Child App parses no ID, ever.** The one sanctioned parse anywhere is Management-side Completion Import taking the `CHR-{choreToken}` stem (§3).
- **`difficultyTier` and `rewardCategoryId` are opaque strings** (`D01`, `R01`, …), minted Management-side. Neither side parses them; the child mints its earn entry from `rewardCategoryId` verbatim and resolves `difficultyTier` against nothing. They are not part of the composite-ID grammar above and take no reserved prefix.

---

## 5. What is explicitly NOT in this contract (do not add without a deliberate, cross-referenced decision)

- No spend channel of any kind (§1, rule).
- No Reward Ledger *data* of any kind crosses in either direction — the Management App has no visibility into child-side ledger entries, ever. `rewardCategoryId` is a category **definition** flowing *to* the child, not ledger data flowing *to* Management. Guardrail 6 is untouched.
- No tier `label` crosses. The child displays theme-skinned categories, never tier names (DM §2.3).
- No recurrence rule (`daysOfWeek[]`) crosses to the child side — recurrence is evaluated exactly once, on the Management side, at generation time.
- No `actualStart`/`actualFinish`/`durationMin`/`notes` columns in the CSV.
- No machine-readable version of the recovery note — it is human-eyes-only, forever, per current design.
- No bidirectional sync — both directions are one-way, collect-and-reconcile (CSV import) or generate-and-export (Packet), never live.

---

## 6. When this document must be updated

Any change to a field, a rule, or the column/shape list above is a **domain-semantics change**, which the Roadmap's standing rule (§6) already requires reflecting in the Domain Model the same session it's decided. For a split-account build, add one clause to that rule: **the change is also propagated into this file, into `fixtures/`, and into whichever build session (Child or Management) did not originate it, before that session's next work block starts.** A change that lives only in one account's conversation history does not count as decided.

---

## 7. Files and versioning

**`schemaVersion` is an integer. Current value: `1`.** The Completion CSV has no version field — its eleven-column header is its version.

**Filename conventions** (device-local timestamps, zero-padded, lexically sortable):

| File | Pattern | Example |
|---|---|---|
| Packet | `packet_{childSlug}_{coversFrom}_{coversTo}.json` | `packet_ada_2026-09-14_2026-09-20.json` |
| Completions | `completions_{childSlug}_{YYYYMMDD-HHmm}.csv` | `completions_ada_20260920-1642.csv` |
| Recovery note | `recovery_{childSlug}_{YYYYMMDD-HHmm}.txt` | `recovery_ada_20260920-1642.txt` |

`childSlug` = `name`, lowercased, non-alphanumerics collapsed to `-`. The recovery note **shares the CSV's exact timestamp stem**, so the pair is unmistakable by eye in a Drive folder six months later (Roadmap §4's requirement).

**Filenames are a convenience, never a contract.** Manual file selection is a permanent fallback on both sides (Roadmap §8). **Nothing in either app may ever parse a filename to decide behavior** — a hand-renamed file must import exactly as well as a generated one.

---

## 8. Fixtures are normative

`packet_schema.json` is the machine-checkable form of §1. `packet_sample.json` and `completions_sample.csv` are the golden examples both sides test against.

- The Child App's Packet Import **must** accept `packet_sample.json` and **must** reject a packet with an unknown `schemaVersion`.
- `packet_sample.json` carries a `blockHint` on **every** Activity and Chore entry, so the golden packet exercises the block-grouped Today view end to end. `blockHint` nonetheless remains **optional** in the schema — the absent case is a live path and falls to `morning` per §1d, and both sides must handle it.
- The Child App's CSV Export **must** produce a file byte-shaped like `completions_sample.csv` given equivalent records.
- Management's Packet Generation **must** emit packets that validate against `packet_schema.json`.
- Management's Completion Import **must** accept `completions_sample.csv` and produce a correct summary against it.

A change to any fixture is a contract change and follows §6. This is the seam; test it like one.
