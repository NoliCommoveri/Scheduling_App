# Software Requirements Specification — Child App
## Module 8: Completion CSV Export

*Written against Domain Model §4.2 (Completion CSV — the single authoritative column list), §3.6 (Activity Record, including `exported`), §5.4 ("child owns the export"), §3.6a (the completed/exported wipe carve-out), Architecture Evaluation §9 (Reporting & export) and §13 ("Child owns the completion export, with reminder").*

---

## 1. Purpose

Turns resolved Activity Records (completed or waived) into the Completion CSV the child hands back to the parent for the Management App to eventually read (Completion Import, a deferred Phase-4 Management App module). This module owns *what gets exported and when the child is reminded to* — it does not own reconciliation (explicitly deferred to Phase 4) or the wipe's clearing logic (Module 9, separate), though Module 9's access point is deliberately paired with this module's own UI (§2.1).

## 2. Scope notes

**2.1 — Export and Wipe share one access area, by design.** The Wipe action (Module 9) is a child-side button placed alongside this module's export action rather than on the daily/Today view — export and wipe form one small routine the child owns: send the week's work, then clear what's been sent. This module doesn't implement Wipe's logic, but its UI is the natural home for Wipe's entry point.

## 3. Completion CSV columns (locked — Domain Model §4.2)

| Column | Source | Notes |
|---|---|---|
| `activityId` | Activity Record `activityId` | The stable join key. |
| `date` | Activity Record `date` | |
| `course` | The received Activity entry's `courseName` field, carried verbatim (Interchange Contract §1a) — this module parses no ID to produce it. Left blank for Chore rows, which have no `courseName` of their own | |
| `activity` | The source item's `title` (Activity-as-received §3.5, or Chore-as-received §3.5a) | Available today. |
| `activityType` | The source Activity's `activityType` field (§3.5) for Activity rows; mapped from the Chore's own `choreType` for Chore rows — one of the eleven canonical categories (`Pet Care`, `Car Care`, `Kitchen/Dining`, `Bathroom`, `Living/Main Area`, `Playroom`, `Bedroom`, `Parent's Room`, `Porch`, `Floors`, `Miscellaneous`, Interchange Contract §1b), written verbatim, never a generic placeholder | Keeps the column genuinely informative for Chore rows instead of a constant dead value. The golden fixture `completions_sample.csv` shows this: its chore row's `activityType` cell reads `Kitchen/Dining`. |
| `plannedBlock` | The source item's `blockHint` (§3.5/§3.5a) | Available today; optional field, may be blank if the parent never set a block hint — that's an existing, unrelated blank case, not a gap. |
| `status` | Activity Record `status` (`complete` \| `waived`, per FR-1 eligibility) | Available today. |
| `grade` | Activity Record `grade` | Available today (Module 4 FR-5/FR-6) — blank unless captured, per the Activity Type's capture pattern. |
| `childName` | Child record (Module 1) | Available today. |
| `semesterLabel` | Semester, passthrough only (§3.1/§4.1) | Available today. |
| `sequenceNumber` | The source item's `sequenceNumber` (§3.5), where present | Blank for page-range types and Chore rows, where it doesn't apply. Copied directly from on-device data — no new capture mechanism. |

**All eleven columns are always present in every row**, including Chore rows — no conditional omission (Architecture Evaluation §9). `course` and `sequenceNumber` are legitimately blank on some rows (Chore rows for the former; page-range types and Chore rows for the latter) — those are honest not-applicable cases, not gaps.

## 4. User stories

- As a parent, I want my child's completed and waived work to come back to me in one file I can hand off to the Management App later.
- As a child, I want to be reminded to export if I've let it go too long, so my parent isn't stuck without any record of what I've done.
- As a parent, I want a failed export to never silently lose data — if it didn't go through, the records should still be there to try again.

## 5. Functional requirements

**FR-1 — Export eligibility.** An Activity Record is eligible once its `status` is `complete` or `waived` **and** it has not yet been marked exported. Still-pending items (including anything merely rescheduled, per Module 5) are never eligible — they have no resolved outcome yet.

**FR-2 — Manual, child-initiated, ungated.** Export is triggered explicitly by the child (or a parent using the same device) — never automatic or backgrounded. No PIN gate — this is the child's own action per Architecture Evaluation §13 ("child owns the completion export").

**FR-3 — CSV columns.** Per §3's locked table. Family Events never produce a row, per the Domain Model.

**FR-3a — Every row carries all eleven columns, including Chore rows.** A Chore row is never shorter than an Activity row. `activityType` is populated from the Chore's own `choreType`; `course` is left blank — never dropped or reordered per row.

**FR-4 — All-or-nothing write.** At the moment of export, every currently-eligible record (FR-1) is gathered and written into one CSV file in a single operation. Records are only marked exported if the file was produced successfully — a failed or interrupted export leaves every record's eligibility exactly as it was, so a retry is always safe and nothing is silently dropped. The file is named `completions_{childSlug}_{YYYYMMDD-HHmm}.csv` (Interchange Contract §7) — device-local timestamp, zero-padded, lexically sortable; `childSlug` is the Child record's `name`, lowercased, non-alphanumerics collapsed to `-`. This module (and Completion Import on the Management side) never parses the filename to decide behavior — it's a convenience only, and a hand-renamed file must import exactly as well as a generated one.

**FR-5 — Marking exported.** On a successful export, every included record's `exported` flag is set. This is what makes it eligible for the wipe's "completed/exported" clearing (§3.6a), consumed by Module 9 — completion/waiver alone is not enough; export must also have happened.

**FR-6 — No duplicate rows across exports.** An already-exported record is never included in a later export. Each eligible record appears in exactly one CSV file over its lifetime (barring a wipe-preservation edge case, which doesn't apply here since exported records are wipe-eligible, not wipe-preserved).

**FR-7 — End-of-week reminder.** If **7 or more device-local days** have passed since the last successful export, **and** at least one eligible-but-unexported record exists, the app surfaces a reminder. The reminder can be dismissed for the current session but reappears on the next app open as long as the condition still holds — it clears permanently (until it next applies) once an export succeeds or there's simply nothing left to export.

**FR-8 — Recovery note companion file.** Every successful export additionally writes a small, human-readable recovery note as a separate file alongside the CSV, over the same manual-save path: device-local date, `currentStreak` (Module 7), and per-category `{ categoryId, themeDisplayName, balance }` (Module 6's Reward Ledger). The note is named `recovery_{childSlug}_{YYYYMMDD-HHmm}.txt`, sharing the CSV's exact timestamp stem (Interchange Contract §7) — so the pair is unmistakable by eye in a Drive folder months later. The CSV contract (§3's eleven columns) is untouched — the note is not part of it. Note-write failure is independent of the CSV export: it never blocks the export, never prevents `exported` flags from being set (FR-4/FR-5 unchanged), and surfaces only a retriable notice. The note is write-only — no module in either app ever reads it back (Domain Model §3.7, §5.9).

## 6. Validation rules

| Rule | Detail |
|---|---|
| Eligibility | Only `complete` or `waived`, not-yet-exported records ever appear in a CSV. |
| Empty export | Triggering export with zero eligible records is a harmless no-op (a clear "nothing to export" message, no empty file, no error). |
| Atomicity | A partial/failed write must not mark any record as exported. |
| Reminder trigger | 7+ device-local days since last successful export, with ≥1 eligible record outstanding. |
| Column completeness | Every row — Activity or Chore — carries all eleven columns in the fixed order (§3); no per-row omission. |
| Note-write independence | A failed recovery-note write never unmarks or blocks the CSV export; the CSV's success alone governs `exported` flags. |

## 7. Permissions

No PIN. This is explicitly the child's own action (Architecture Evaluation §13), distinct from the PIN-gated actions elsewhere (deferment/waive, reward spend).

## 8. Inputs / Outputs

**Inputs:** all Activity Records with `status: complete` or `status: waived` and `exported` not yet set; the source Activity-as-received or Chore-as-received item for each record (for `courseName`, `activity`, `activityType`, `plannedBlock`, `sequenceNumber`); Child record (for `childName`); Semester (for `semesterLabel`, passthrough only); Reward Ledger snapshot + tail (read, Module 6 — for the recovery note's per-category balances); Streak's `currentStreak` (read, Module 7 — for the recovery note). This module now has a read dependency on Modules 6 and 7's stored data that it didn't have before FR-8 — noted explicitly so a future single-module edit to either doesn't silently break the note.

**Outputs:** one CSV file per successful export, per §3's column table. Every included Activity Record's `exported` flag is set to true (FR-5). One recovery note file per successful export (FR-8), written alongside the CSV over the same manual-save path. Nothing else in device storage is touched — no effect on Received Packet content, Reward Ledger, Streak, or Theme/Settings.

## 9. Acceptance criteria

1. A triggered export includes every complete/waived, not-yet-exported record, and nothing else — no pending items, no rescheduled-but-still-pending items, no Family Events.
2. Every exported row — Activity or Chore — has all eleven columns from §3, in order; a Chore row's `activityType` cell reads its `choreType` value, and its `course` cell is blank, never missing.
3. Simulating a failed export leaves every record's `exported` flag unset, and a subsequent successful export includes those same records.
4. Re-triggering export immediately after a successful one produces an empty/no-op result if nothing new has resolved since.
5. A record only becomes wipe-eligible once it is both resolved (complete/waived) and exported — resolved-but-not-yet-exported records are still protected from the wipe (§3.6a).
6. The end-of-week reminder appears once 7+ days pass with outstanding eligible records, and does not appear if everything eligible has already been exported.
7. No PIN prompt ever appears anywhere in the export flow.
8. A successful export produces both files — the CSV and the recovery note — in the same operation.
9. Simulating a failed recovery-note write leaves the CSV export fully successful: every included record is still marked exported, and only a retriable notice about the note surfaces.
