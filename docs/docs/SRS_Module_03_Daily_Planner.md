# Software Requirements Specification — Child App
## Module 3: Daily Planner

*Written against Domain Model §3.4/§2.10, Architecture Evaluation, Documentation Roadmap. Assumes Module 2's pure-additive import behavior — pending items are never auto-dropped, which has a direct consequence handled below.*

---

## 1. Purpose

The child's main working view: what's due, organized and reorderable, with entry points into completion (Module 4, elsewhere) and deferment (§3.6b, elsewhere). This module owns *presentation and light organization* of Received Packet content — it does not compute pacing, does not decide what's required, and does not perform completion or deferment itself.

## 2. Scope notes

**2.1 — "Overdue but still pending" is surfaced, as a direct consequence of Module 2.** Because import is pure-additive and nothing is ever auto-dropped, a required item that isn't completed on its due date doesn't disappear — it just sits there. If the Daily Planner only ever showed "today's" items by date match, an overdue chore from a week ago would become permanently invisible (still occupying storage, still blocking the streak, but never shown to the child to act on). To prevent that, the **Today** view rolls forward any still-pending required item from a past date alongside today's own due items.

**2.2 — "Subjects" view is grouping by `courseName`, with a known gap.** Only School, Chores, Events, and (implicitly) Today have grounding in the domain model as distinct views — "Subjects" is defined here as grouping School Activities by the `courseName` string each one carries (Interchange Contract §1a) — a plain display value, not a lookup against any Course record the Child App doesn't have. Worth being precise about the gap this leaves: `courseName` is whatever the Management-side Course was named at packet-generation time, not a normalized subject category. If a child ever has two Courses that a person would naturally call the same subject (e.g., two separate Math courses in different semesters, or a co-op class plus a workbook both under "Math"), grouping by `courseName` won't merge them unless the names are identical — each distinct name shows as its own group. That's a known, accepted limitation for now; if it becomes a real annoyance later, the fix is a `subject` field on Course in the Domain Model (Management App side — Course Template Library module) that rides through the same passthrough mechanism, not anything in this Child App module.

**2.3 — Category grouping (School vs. Chores).** Distinct from the type filter views (FR-2, which let the child see only one category at a time): the **mixed views (Today, and Subjects at its top level) organize their contents into School / Chores sections** rather than showing one flat interleaved list — see FR-1 and FR-3 below.

## 3. User stories

- As a child, I want to open the app and immediately see what I need to do today, including anything I still owe from before, so nothing gets lost.
- As a child, I want to put my list in the order I want to work through it.
- As a child, I want to glance at just my chores, or just my schoolwork, without wading through everything at once.
- As a parent, I want Family Events to show up as reminders my child can see, without my child being able to accidentally "complete" a birthday party.

## 4. Functional requirements

**FR-1 — Today view (default landing view).** Assembles, for the device-local current date:
- All Activities and Chores due today that are not yet completed or waived.
- All still-pending required Activities/Chores from any earlier date, not yet completed or waived (§2.1 — overdue rollup).
- All Family Events touching today's date, shown as display-only entries.
- Items already completed today remain visible in a visually-distinct completed state for the rest of that day, rather than disappearing the instant they're done.

**Completion state check.** Filters test whether a completion record exists for an item — those records are created by Module 4 (Activity & Chore Completion, Milestone M2), not by Packet Import; with no record, the item displays as "not yet completed or waived." At Milestone M1, Module 4 does not exist yet, so no completion records are ever present and these filters are no-ops: every actionable item shows as pending, and nothing is filtered out as done. The filters are written now so they go live unchanged the moment Module 4 lands.

**Effective due date.** Every date test this module makes — due today? overdue? — uses the item's **effective due date**: its deferred date when a PIN-gated deferment (Module 5, M2) has moved it, otherwise the `date` it was received with. Never the received `date` directly once a deferral exists, and never the date segment inside a Chore occurrence ID. At M1 no deferrals can exist yet, so the effective due date is always the received `date` — but the resolution is written now so Module 5 lands without touching this module.

**Effective block.** For each item, the effective block is:
1. the child's block override, if one exists; else
2. the item's `blockHint` from the packet, if present **and** one of the canonical four; else
3. **`morning`** — the default bucket, used identically for an absent `blockHint` and for one outside the canonical four.

An out-of-set `blockHint` is stored as received (Module 2 never rejects it) but is never rendered as a block of its own.

**Ordering — three nested axes, fixed. Block outer, category nested, position innermost.**

1. **Block (outer).** The four canonical labels, always in this order: **`morning` → `afternoon` → `evening` → `night`.** Every actionable item renders under its effective block. An overdue item rolls forward into *today's* list under its **own** effective block — an overdue `morning` activity appears among today's `morning` items — with no separate "overdue" section or sort bucket.
2. **Category (nested inside each block).** Within a block, **School Activities first, then Chores** — the same fixed split as the Packet's merge order (Domain Model §2.10) — rather than one interleaved list.
3. **Position (innermost, within each block+category group).** The child's sort position when they have set one (FR-4); otherwise **packet receipt order** — the position the item occupied in the packet's traversal when it was first imported (Module 2 FR-4). Overdue items take their place by that same receipt-order rule alongside today's items in the same group; they are not pinned to the top.

A block with no items in it renders nothing — no empty block header. Family Events are **outside this structure entirely**: they display in their own section, never inside a block, a category, or a sort position.

Block choice and sort position are **independent axes**: moving an item between blocks (FR-5) changes only its block and never its sort position; reordering (FR-4) changes only its sort position and never its block.

**FR-2 — Type filter views (School / Chores / Events).** Each is the same underlying item set from FR-1, filtered to one type. The Events view contains only Family Events (never anything with an overdue concept, since events aren't completable — §2.6). These remain useful even with FR-1's sectioning, for a child who wants only one category on screen at all.

**FR-3 — Subjects view.** School Activities from the FR-1 set, grouped by their `courseName` field (§2.2). This view only ever shows the School category — Chores have no `courseName` to group by, so they don't appear here (use the Chores filter view, FR-2, for those).

**FR-4 — Reorder.** The child can freely reorder Activities and Chores **within a block+category group** — the innermost axis of FR-1's ordering. Reordering never moves an item out of its block or across the School/Chores split; that is FR-5's job (block) and not offered at all (category, which is intrinsic to the item type). Family Events are never reorderable and never appear in a completion-oriented list position (§3.4). Reordering is a local, cosmetic edit — it does not touch due dates, required status, block, or stable IDs, and it persists across packet re-imports (Module 2 FR-4).

**FR-5 — Move between blocks.** The child can assign or change an item's block label. The canonical set is exactly four: `morning`, `afternoon`, `evening`, `night`. A child may move an item to any of the four, and the override persists across packet re-imports (Module 2 FR-4) — a refresh never clobbers it.

Block **is** an ordering axis — the outer one (FR-1). Moving an item between blocks therefore moves it between the Today view's top-level groups. It changes nothing else: not the due date, not required status, not completion state, and **not** the item's sort position within its new group (FR-4's axis is independent).

An **unknown** (out-of-set) `blockHint` arriving in a packet is accepted by validation and stored as received (Module 2), but is never rendered as a block; the item displays under **`morning`**, the same default an item with **no** `blockHint` at all gets. There is no third fallback and no "unassigned" bucket.

*(This supersedes the earlier "`blockHint` is unused for ordering in this iteration" position. Domain Model §2.10's statement refers to the Packet's own array order, which is unchanged; the child-side display grouping is block-outer, per Domain Model §3.4.)*

**FR-6 — Entry point to deferment.** Any required, not-yet-complete item exposes a reschedule/waive control. This module only surfaces that entry point; the PIN-gated logic itself belongs to the Deferment/Waive module (§3.6b, written separately).

**FR-7 — Entry point to completion.** Any not-yet-complete Activity or Chore exposes a "mark complete" entry point. This module surfaces it; the capture/logging behavior belongs to Activity & Chore Completion (Module 4, written separately).

**FR-8 — `lessonTitle` display.** Each Activity's display includes its `lessonTitle` when present — e.g., a subline under the Activity's title — distinct from and additional to the `sequenceNumber` ordinal (FR-10, and Domain Model §2.5's separate level/count indicator). An Activity with no `lessonTitle` renders with no subline in that position — never a placeholder or empty element.

**FR-9 — `instructions` / `notes` display.** When present, an Activity's `instructions` and a Chore's `notes` are shown to the child — e.g., an expandable detail or inline text below the item. This is the first requirement to put either field on screen. Absent or `null` renders as nothing shown in that position — never an empty box.

**FR-10 — `sequenceNumber` (count / level ordinal) display.** For a count-structured Activity, `sequenceNumber` is the ordinal telling the child *which one of the series* this is — e.g. "Practice Level 4", "Quiz 1". When present, the Daily Planner renders it as a child-facing number **distinct from and additional to the Activity's `title` text** (the parent should not have to hand-type "4" into the title). For a Practice Level (`payload.kind: none`) this ordinal *is* the level indicator — there is no other payload to show, so rendering it is what makes the item meaningful at all. This is the child-facing rendering that Mgmt Module 03 FR-P6 explicitly defers to the Daily Planner, and that Roadmap §5 requires. The child displays `sequenceNumber` **whenever it is present, keyed off its presence rather than off `payload.kind`** — this is deliberate, because a custom (`freeText`) count-structured type also carries it while a custom page-range type does not, and the child cannot tell the two apart from `kind` alone (Interchange §1a). Absent renders as nothing in that position — never a placeholder. The child shows only the ordinal it received; the Lesson's total count (`targetCount`, the "of 12") is a Management-side planning aid and does not travel in the packet, so no "N of M" total is shown unless a future interchange change carries the total.

**FR-11 — Payload display (the actual work), rendered by `payload.kind`.** Each Activity's display includes a human-readable rendering of its `payload`, so the child sees *what to do* on the daily list itself — not only after opening the completion flow. Rendering keys off `payload.kind` (never `activityType`), per Interchange §1a:
- **`pageRange`** → the page span, e.g. **"Pages 45–60"**, from `pageRangeStart`/`pageRangeEnd`. This is the primary case: Reading Pages and PDF activities must show their range on the item.
- **`reference`** → the selector reference string as authored, e.g. "Saxon Math 5 - Unit 2 - Quiz 3", shown as plain text the child reads and then finds in the platform they already use — never a link or hosted address (nothing in this system routes the child anywhere, Interchange §1a).
- **`none`** → no payload line; a Practice Level's content is its level ordinal, already rendered by FR-10.
- **`freeText`** → the authored free-text string (custom types, and any parent-added type).


This is the same by-`kind` rendering discipline the completion screen uses (Module 4 FR-1); the Daily Planner surfaces it on the list so the child knows the work at a glance. The child renders whatever `kind` and sub-fields it received and never inspects `activityType`. A malformed or absent payload never reaches this point — Packet Import rejects a payload missing its kind's required sub-fields (Module 2 FR-3), so the renderer can assume each `kind`'s sub-fields are present.

** FR-12 — `coursename` display.** Each activity's display includes its `coursename` when present — above the Activity's title. An Activity with no `coursename` renders with no value in that position — never a placeholder or empty element.


## 5. Validation rules

| Rule | Detail |
|---|---|
| Reorder position | Must resolve to a valid position **within that item's block+category group**; no orphaned or out-of-range positions. Reorder never relocates an item across blocks or across the School/Chores split. |
| Block label | Exactly four canonical labels: `morning`, `afternoon`, `evening`, `night`. A child override must be one of the four. An unknown or absent `blockHint` from a packet never fails validation — the item displays under `morning`. |
| Effective due date | Deferred date when present, else the received `date`. Never the date segment inside a Chore occurrence ID. |
| Family Events | Never accept a reorder into a completion-flow position, and never expose a "complete" control, in any view. |

## 6. Permissions

No PIN required for reorder or block assignment — these are cosmetic, child-owned organizational actions with no effect on required status, due dates, or the streak. (The deferment entry point in FR-6 leads to a PIN-gated action, but that gating belongs to the Deferment/Waive module, not this one.)

## 7. Inputs / Outputs

**Inputs:** Received Packet content (Module 2's output, including each item's recorded packet receipt order), existing Activity Record completion state, existing per-item overrides, device-local current date.

**Outputs (written to device storage):** per-item `sortOrder` and `blockHint` override values only. No due dates (received or deferred), required flags, stable IDs, or completion state are altered by this module. The Daily Plan itself is **derived at render time and never persisted** (Domain Model §3.4) — this module stores no day records, no block arrays, and no assembled lists.

## 8. Acceptance criteria

1. Opening the app shows Today's due items plus any still-pending required item from an earlier date — nothing required-and-incomplete is ever absent from Today.
2. A completed item stays visible (marked done) in Today's list for the rest of that day rather than vanishing immediately.
3. Reordering an item's position within a day persists across app restarts and survives unrelated packet imports.
4. Assigning an item to a different block changes only its block label — due date, required status, and completion state are unaffected.
5. Family Events never present a reorder handle or a "complete" control in any view.
6. Switching between Today/School/Chores/Events/Subjects changes only what's displayed — never completion state, required status, or stored order.
7. Today's list is grouped **by block first** — `morning`, `afternoon`, `evening`, `night`, always in that order — and **within each block** separates School items from Chore items (School first, then Chores), with Family Events in their own section outside the block structure. Never one flat interleaved list, and never category-outer.
8. The Subjects view shows only School items, sub-grouped by their `courseName` field; a child with only Chores due sees an empty or absent Subjects view rather than Chores leaking into it.
9. An Activity with a `lessonTitle` shows it as a subline under the Activity's title; one without shows nothing in that position — no empty element rendered either way.
10. An Activity with `instructions` (and, separately, a Chore with `notes`) shows that text to the child; one without shows nothing in that position — no empty box or placeholder.
11. An item with an unknown (out-of-set) `blockHint`, and an item with **no** `blockHint` at all, both render under `morning`. Neither causes a validation failure, and neither produces an "unassigned" or empty block.
12. A count-structured Activity carrying a `sequenceNumber` (e.g. a Quiz with `1`, a Practice Level with `4`) shows that number to the child as an ordinal distinct from the title; a Practice Level in particular renders its level number rather than appearing as a bare title with no content. An Activity with no `sequenceNumber` shows nothing in that position — no placeholder — regardless of `payload.kind`.
13. A `pageRange` Activity (Reading Pages / PDF) shows its range on the item as human-readable text (e.g. "Pages 45–60"); a `reference` Activity shows its selector string; a `freeText` Activity shows its text; a `none` Activity shows no payload line (its ordinal from FR-10 is its content). The rendering is chosen by `payload.kind`, and a custom Activity Type renders correctly with no special-casing.
14. A still-pending required item from an earlier date whose effective block is `afternoon` rolls forward into today's **afternoon** group, ordered among today's afternoon items by receipt order — not pinned to the top of the list and not placed in a separate "overdue" section.
15. Moving an item to a different block leaves its position within the new group determined by its existing sort position / receipt order; reordering an item leaves its block unchanged. The two actions never affect each other.
16. A block with no items renders no header and no empty container.
17. Importing `packet_sample.json` on 2026-09-14 produces a Today view whose morning block contains, in order: the two Saxon Math activities (School), then "Unload dishwasher" (Chore); whose afternoon block contains, in receipt order, "Timeline Practice" then "Draw a Still Life" (both School); and whose Events section contains "Piano recital" — with no evening or night block rendered.
