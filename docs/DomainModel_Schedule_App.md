# Schedule Management App — Domain Model

*Load alongside the Documentation Roadmap and Architecture Evaluation. This is the domain model for the two-app producer/consumer scheduling system, distinct from the separate Star app family.*

*The Domain Model defines the **language** of the system: every major entity, its purpose, relationships, fields, lifecycle, and rules. No UI discussion.*

---

## 1. The central modeling decision (read first)

The system has a two-tier instancing model:

- **Curriculum — shared, never instanced.** A Curriculum (e.g., "MiAcademy," "Saxon Math," a homemade curriculum) is a permanent, top-of-library concept. It is never stamped, duplicated, or child-tagged. Two children both taking MiAcademy courses means exactly **one** MiAcademy Curriculum row, referenced by both.
- **Course — a template stamped into an independent, child-tagged copy.** A Course is authored once in a library. Assigning it to a child **duplicates** it into a **Child Course Instance**, tagged with that child. From that moment the instance is independent — its pacing and content can diverge from the template and from every other child's instance. Editing the template later does not touch instances already stamped. **No propagation.**
- **The one narrow exception:** a Course carries a `curriculumId` — a reference only, never copied. If a Curriculum's `suggestedActivityTypes` changes later, every Course referencing it sees the update live. This is safe specifically because Curriculum was never copied in the first place, so there's nothing for it to desync from.
- **Stamping regenerates Activity IDs.** Every duplicated Activity receives a new, globally unique ID at the moment of stamping. IDs are **never copied or reused** — this is what prevents two stamps of the same template (e.g. Fall and Spring) from minting Activities that collide on the completion-CSV join key.

Rationale: two children's curricula are *guaranteed* to diverge (pacing at minimum, often content too). Modeling guaranteed-to-diverge things as one shared record with divergence bolted on is the harder, more bug-prone path. Independent copies-from-a-stamp are honest to reality.

---

## 2. Management App domain

### 2.1 Child (person)
- **Purpose:** identifies one student the parent is planning for.
- **Relationships:** owns many Child Course Instances, Chores, and Family Events; referenced by every Packet and every completion record.
- **Required fields:** `id`, `name`.
- **Optional fields:** `gradeLabel`, `notes`, `themeHint` (advisory only).
- **Lifecycle:** created when the parent adds a student; persists indefinitely — the Management app is not wiped.
- **Rules:** `id` (`CHI-{token}`) is a Management-internal key. It is **not** baked into the `instanceToken`, does not appear in any Activity ID, and never crosses the interchange — the `instanceToken` minted at stamping is purely random and encodes nothing (§2.5). Management recovers the child for any completion row by `activityId` → Activity → Instance → `childId`; no ID is ever parsed to do it. **Deletion is a two-tier guard:** Tier 1 — hard block while any Course Instance still belongs to this Child; no override, no forced cascade; the parent must remove each Instance first. Tier 2 — once zero Course Instances remain, deletion surfaces an explicit warning that this permanently removes the Child's remaining Management-side data (Chores, Family Events, Pacing history) and requires the parent to confirm they've already exported/backed up anything they want to keep — an honesty checkpoint only, since no Master Reports module exists yet to verify an export actually happened. Only after that confirmation does deletion cascade.

### 2.2 Curriculum
- **Purpose:** the publisher/source-level container above Course — "who/what this content comes from" (a platform, a publisher, or the parent-as-publisher for homemade material).
- **Relationships:** shared across all children; referenced by many Courses via `curriculumId`.
- **Required fields:** `id`, `name`.
- **Optional fields:** `publisherNote`, `defaultCurriculumType` (Website | App | Offline), `suggestedActivityTypes[]` (soft defaults only).
- **Lifecycle:** authored once, persists indefinitely, never stamped/duplicated/child-tagged.
- **Rules:** delivery mechanism (Website/App/Offline) lives here, not on Course — it doesn't vary course-to-course within one curriculum. `suggestedActivityTypes` is **always a soft suggestion, never an enforced whitelist**, even for a curriculum whose current offering is a genuinely fixed set — hard-coding today's ceiling would force a migration the moment a publisher expands its offering.

### 2.3 Difficulty Tier & Reward Category
- **Purpose:** a single, shared lookup used identically by Activity and Chore, so "Easy/Medium/Hard" means one thing app-wide.
- **Shape:** one row per tier `{ tierId, label, order, rewardCategoryId }`; a parallel Reward Category row `{ categoryId, internalLabel }` — a neutral, kid-invisible identifier, never a themed name.
- **Relationships:** referenced by `difficultyTier` on Activity and Chore. Each tier maps to exactly one Reward Category.
- **Lifecycle:** parent-managed CRUD, seeded with a fixed default set of **four** — Easy, Medium, Hard, Very Hard — each with its own paired Reward Category; extensible beyond that by the parent.
- **Rules:**
  - **The mapping is fixed once a tier exists** — not reweightable in Settings. Reassigning it later would make historical ledger entries ambiguous about what they represent.
  - **A new tier is always created paired with a new Reward Category** — never reusing an existing category at a different weight.
  - **Earn magnitude is a hard constant: exactly 1 unit per completion.** Difficulty selects *which currency*, never *how much*. There is no "this one is worth 3."
  - Display is entirely theme-owned (§3.9) — the neutral `categoryId` is what's stored and summed; a category with no theme-specific art yet falls back to a generic default, never a blank/broken render.
  - **`tierId` and `categoryId` are opaque, sequential, minted-in-pairs IDs** — `D01`/`R01`, `D02`/`R02`, … — never derived from `label` (which FR-3 lets the parent rename freely). The **seeded four** are fixed on every install: Easy `D01`/`R01`, Medium `D02`/`R02`, Hard `D03`/`R03`, **Very Hard `D04`/`R04`**. Numbers are **never reused** after a delete; the mint counter is persisted (`meta.nextSeq`), not recomputed from surviving rows.

### 2.4 Course
- **Purpose:** a named body of study in one subject/area, belonging to one Curriculum. Exists as **Template** (in the library) or **Instance** (stamped to a child) — same structure, different state.
- **Relationships:** belongs to one Curriculum (`curriculumId`, reference only); has one `mainCategory`; contains ordered Lessons; a Template is the source of one or more Child Course Instances.
- **Required fields:** `id`, `name`, `curriculumId`, `courseCode` (short, human-readable, e.g. `SAXMATH5` — keeps generated Activity IDs readable; **unique across all Course templates, case-insensitively**; alphanumeric only; never `CHR`, `EVT`, or `TPL`), `mainCategory` (`school` — Chore and Family Event are separate entities and never appear here), `state` (`template` | `instance`), and for instances `sourceTemplateId` + `childId` + `instanceToken` + `progressCursor` (see Rules below).
  - **There is no `lessons[]` field.** A Course's Lessons are a query — `lessons` filtered by `courseId`, sorted by `order` — not an embedded array. An array *and* a foreign key would be two sources of truth for the same relationship, and the one that silently drifts (a Lesson present in the store but missing from its Course's array) is invisible in every UI and fatal to pacing. §2.8 drops `activities[]` for the identical reason.
  - **`instanceToken`** (Instance-only): the random token minted for this Instance at stamping and baked into every one of its Activity IDs (§2.5). It is **stored on this record** precisely so that adding a new Activity to an existing Instance (Mgmt SRS 04 FR-10) can mint an ID carrying the right token **without parsing an existing Activity ID** — no code, anywhere, on either side, ever parses an ID to recover it (Interchange Contract §4).
- **Optional fields:** `coreElective` (`core` | `elective`), `subject`, `description`, `defaultPacingHint`.
- **Lifecycle:** Template authored/edited freely in the library, reused by stamping; Instance created by duplicating a template and tagging it with a `childId`, thereafter fully independent.
- **Rules:** an Instance never links back to the template for content — it is a full copy. `sourceTemplateId` is provenance/label only, **not** a live reference. No propagation (§5.1). **A diverged Instance is never promoted back into the template library** — there is no archive-as-template path; a parent wanting to reuse an instance's content as a new template re-authors it manually. **An Instance's own Course-level fields are editable exactly as its Lessons are** (Mgmt SRS 04 FR-13): `name` and every optional field are freely editable, and edits never touch the template. `courseCode` is the sole exception, and it is frozen by construction rather than by a special rule — a stamped Instance has Activities beneath it from its first instant, so §2.4's freeze applies immediately and permanently. `mainCategory`, `sourceTemplateId`, `childId`, and `instanceToken` are never editable by any path. **`progressCursor`** (Instance-only): a pointer to the last Activity (by stable `id`) included in a Generated Packet for this Instance, walked in pacing-walk order — Lessons in `Lesson.order`, and within each Lesson, Activities in **`Activity.order`** ascending (§2.5; Mgmt SRS 05 §2.4). *(Corrected: this previously read "authored array position (`Lesson.activities[]`)", which was never persisted anywhere — the store is relational and IndexedDB returns rows in key order, not authored order. `Activity.order` exists to make this walk implementable.)* A freshly-stamped Instance has **no** `progressCursor` (absent, not zero/null-as-a-value — nothing paced yet). **Written exclusively by the Packet Generation module** (Management SRS Module 08); every other module reads it for display only.
  - **`courseCode` freezes once any Activity exists beneath the Course** (in any of its Lessons). Editing it afterward would strand every already-minted Activity ID, and would let a later Course take the freed code and mint a colliding one — the random `instanceToken` used to absorb this, but a template ID's literal `TPL` does not. The edit form disables the field with a reason; it does not silently ignore the change. **Deleting a Course outright *does* free its `courseCode` for reuse, and that is safe** — its template Activities are gone from the store, and any Instances stamped from it carry random tokens.
  - Uniqueness is scoped to `state: template` only. Instances inherit `courseCode` by copy, and two stamps of one template legitimately share it; the `instanceToken` is what keeps their Activity IDs apart.
  - **A stamped Instance's Lessons and Activities are editable** (Mgmt SRS 04) — this is what "the instance can diverge from the template" means in practice. Edits never propagate back to the template, and never touch it. Two divergence hazards are inherent and warned about rather than blocked: editing or deleting an Activity the child has **already received** changes nothing on their device (one-way interchange, §5.1), and deleting one they have **already completed** turns their CSV row into an unmatched row at import (§4.3).

### 2.5 Activity
- **Purpose:** the atomic unit of work — one completable, loggable thing (watch a video, read pages 10–14, do practice level 3, take a quiz).
- **Relationships:** belongs to one Lesson; carries a reference to Activity Type (§2.5a) and to Difficulty Tier (§2.3); becomes a Daily Assignment when paced; corresponds 1:1 to a completion record on the child side, joined by stable ID.
- **Required fields:** `id` (stable interchange join key — see ID scheme below), `activityType` (reference to §2.5a), `title`, `required` (bool), `payload` (type-specific — a selector reference for platform-hosted content, never a URL), `difficultyTier` (references §2.3), `order` (integer — position within the owning Lesson; contiguous from `0`, system-maintained, reorderable by the parent; **this is the pacing walk order**, Mgmt SRS 05 §2.4).
- **Interchange note:** at Packet Generation, `payload` is stamped with a `kind` discriminator (`pageRange` | `reference` | `none` | `freeText`) so the Child App can render it without ever inspecting `activityType` (Interchange Contract §1a). `kind` is derived from the Activity Type's `structurePattern` **and** whether the type is canonical or parent-added — a custom `page-range` type still carries free text, not start/end fields, so `structurePattern` alone doesn't predict shape. Packet Generation also stamps `courseName` (the owning Course's `name`, verbatim) and `rewardCategoryId` (the Reward Category `difficultyTier` maps to, §2.3) onto every Activity entry it emits — neither is a field stored on the Management-side Activity record itself; both are resolved at generation time from data Management already has.
- **Optional fields:** `expectedDurationMin`, `capturesGrade` (bool — copied from the Activity Type's `capturePattern` at creation time and stored on the record, not looked up dynamically), `instructions`, `blockHint`, `sequenceNumber` (required, not optional, for types with `structurePattern: count` — see §2.5a; for Practice Level specifically, `sequenceNumber` *is* the level indicator), `lessonTitle` (display-only; copied from the owning Lesson's `title` at Activity creation — manual authoring, bulk import, or stamp).
- **ID scheme:** a readable composite, `{courseCode}-{instanceToken}-{lessonCode}-{seq}`, e.g. `SAXMATH5-f3k9-L03-02`. Four segments, always.
  - **Template Activities use the same grammar with a reserved literal token in segment 2:** `{courseCode}-TPL-{lessonCode}-{seq}`, e.g. `SAXMATH5-TPL-L03-02`. A template ID is structurally distinguishable from a stampable one by eye and by assertion, and **never crosses the interchange**.
  - `instanceToken` — a short **random** base36 token minted once per stamp event, shared by every Activity in that instance, **uniqueness-checked at mint and re-rolled on collision**, and never equal to `tpl`/`chr`/`evt` (case-insensitively). This is the collision firewall: two stamps of the same template produce two different tokens. It encodes nothing — in particular, not `childId` (§2.1).
  - `seq` — a **persisted, never-reused** per-Lesson counter, held on the Lesson record as `nextActivitySeq` (§2.8) and advanced in the same transaction as the Activity write. **It is never recomputed from the Activities that currently exist.** Deleting an Activity does not free its number: a `max(existing) + 1` implementation reuses it, and in an instance that means minting the completion-CSV join key of work the child has *already completed and exported*. Each Lesson — template or instance — carries its own counter. A Lesson created from scratch (template authoring, or Mgmt SRS 04 FR-9's instance-Lesson creation) seeds it to `1`.
  - **At stamp, `seq` values are copied, not re-minted.** Each Instance Activity keeps the exact `seq` its template original carried, and the Instance Lesson's `nextActivitySeq` is **copied forward from the template Lesson's current value** rather than reset. An Instance Activity's ID therefore differs from its template original **in segment 2 alone** — which is what makes a template↔instance diff checkable by eye, and what makes "did the stamp regenerate every ID?" a one-glance question. This is safe because the `instanceToken` already guarantees disjointness: two Instances of one template, and the template itself, can hold the same `seq` in the same `lessonCode` and still never collide.
  - `seq` is **not** `sequenceNumber` and **not** `order`. See the three-numbers note below.
  - Semester is deliberately **not** in the ID — it's a passthrough label (§3.1), already its own CSV column (§4.2); baking it into the immutable join key would buy nothing.
  - **Delimiter is locked to `-` (U+002D, hyphen-minus).** Every segment is alphanumeric only (`[A-Za-z0-9]+`) — never empty, never containing the delimiter. This is what keeps IDs safe in CSV cells and makes the Chore-stem parse (§2.12) unambiguous (Interchange Contract §4).

- **Three numbers live on an Activity, and a build session will wire the wrong one:**

  | Field | Counts | Scope | Mutable? | Visible to child? |
  |---|---|---|---|---|
  | `order` | Position in the Lesson, across **all** types | Lesson | **Yes** — parent reorders freely | No (drives pacing order only) |
  | `seq` | ID segment, across **all** types | Lesson | **Never** — minted once, never reused | No (inside an ID nobody parses) |
  | `sequenceNumber` | Ordinal within one **Activity Type** | Lesson + type | Yes — parent overrides freely; collisions permitted by design | **Yes** — and for Practice Level it *is* the level |

  **Reordering an Activity changes `order` only.** It never touches `seq` or `sequenceNumber`.
- **Lifecycle:** authored → copied at stamp with a freshly minted ID → paced → packeted → completed on the child device → returned in the completion CSV → mints one Reward Ledger unit (§3.7) on completion.
- **Rules:** the ID is minted once, at creation — during template authoring, at stamp, or when a **new** Activity is added to an existing Instance (Mgmt SRS 04) — and never reused or copied. **Editing an existing Activity's fields never re-mints its ID**, in a template or an instance; only creation mints. `required: true` activities cannot be removed by the child (§3.5). `lessonTitle` does not propagate: a later edit to the Lesson's `title` updates **no** already-created Activity's `lessonTitle`. This holds both **within a template** (renaming a Lesson leaves stale `lessonTitle` on its own already-created Activities — a distinct, intra-template case) and **across a stamp to an instance** (the existing §5.1 template→instance no-propagation guarantee).

### 2.5a Activity Type
- **Purpose:** defines the set of Activity Types available for authoring and the two independent behavioral patterns each carries. A parent-extensible table, not a fixed enum.
- **Relationships:** referenced by `activityType` on Activity (§2.5); referenced by Lesson's `activityCountTargets[]` (§2.8) for `count`-structured types.
- **Required fields:** `activityTypeKey`, `label`, `capturePattern` (`grade-optional` | `no-capture` — governs whether the Child App offers a grade entry on completion), `structurePattern` (`page-range` | `count` — governs Lesson-level content planning, §2.8).
- **Seed data (10 canonical types):**

  | `activityTypeKey` | Type (`label`) | capturePattern | structurePattern |
  |---|---|---|---|
  | `quiz` | Quiz | grade-optional | count |
  | `test` | Test | grade-optional | count |
  | `project` | Project | grade-optional | count |
  | `report` | Report | grade-optional | count |
  | `pdf` | PDF | grade-optional | page-range |
  | `drill` | Drill | grade-optional | count |
  | `workbook` | Workbook | grade-optional | count |
  | `video` | Video | no-capture | count |
  | `practice-level` | Practice Level | no-capture | count |
  | `reading-pages` | Reading Pages | no-capture | page-range |

  *(`activityTypeKey` values locked at M5 — TDS_Slice_M5_Management_App_Rev7 §1a, Management SRS Module 12 §4. Kebab-case for the two multi-word keys; the other eight are single lowercase words. These are permanent identifiers — `label` is the freely-renamable display text.)*

- **Lifecycle:** parent-managed CRUD. New types are created by choosing a `capturePattern`, a `structurePattern`, and a `label` — not by defining new behavior from scratch. A type can be deleted only if zero Activities reference it.
- **Rules:**
  - **Both patterns are fixed once a type exists** — changing either later would make existing Activity Records and Lesson presets ambiguous about what they represent.
  - **`page-range`-structured types share one budget per Lesson**, not one each (PDF and Reading Pages currently share this way).
  - **This entity does not exist on the Child App side.** The Child App only ever reads the boolean `capturesGrade` already carried on each Activity/Packet entry — it never needs type names or the managed table, so this can grow indefinitely with zero Child App impact.
  - **A parent-added custom type's `payload` is a single generic free-text field** ("reference / instructions"), regardless of `structurePattern` — carried in the interchange as `kind: freeText` (Interchange Contract §1a). Only the 10 canonical types carry a hand-specified, structured payload shape (a page range, a platform selector reference); a parent creating a new type has no way to define new field structure beyond picking `capturePattern`/`structurePattern`, so custom types get the simpler, universally-applicable free-text form instead.

### 2.6 Chore
- **Purpose:** recurring household/outside work. Deliberately does **not** go through Course/Lesson/Pacing Profile — chores repeat, they don't progress through an ordered sequence.
- **Relationships:** belongs to one Child directly (no Curriculum/Course parent); produces a Chore-as-received on the child side (§3.5a) and a completion record, same interchange join pattern as Activity.
- **Required fields:** `id` (`CHR-{choreToken}` — own minted token, own namespace, never collides with Activity IDs). The stored Chore record's `id` identifies the *definition*; each generated occurrence carries its own deterministic per-occurrence ID, `CHR-{choreToken}-{YYYYMMDD}`, minted by Packet Generation at expansion (§2.10). Occurrence IDs — not the record ID — are what Packets, Activity Records, and the Completion CSV carry. Also required: `childId`, `title`, `choreType` (a closed enum of canonical chore categories — `Pet Care`, `Car Care`, `Kitchen/Dining`, `Bathroom`, `Living/Main Area`, `Playroom`, `Bedroom`, `Parent's Room`, `Porch`, `Floors`, `Miscellaneous`; this is the same set the Packet's `choreEntry.choreType` enforces, Interchange Contract §1b / `packet_schema.json`, which the authored value passes through verbatim), `daysOfWeek[]` (a required, non-empty subset of `{Sun, Mon, Tue, Wed, Thu, Fri, Sat}`, no duplicates — a daily chore is all seven days selected, a weekly chore is one day selected, and any other combination, e.g. six days excluding Saturday, is equally valid with no separate code path), `difficultyTier` (references §2.3, same shared table Activity uses).
- **Optional fields:** `notes`, `blockHint`.
- **Lifecycle:** authored directly against a child — no template/instance split, a chore doesn't get "stamped." Generated into packets on its recurrence schedule. Completion mints exactly **1** Reward Ledger unit of its `difficultyTier`'s category, same rule as Activity.
- **Rules:** completely bypasses Lesson, Course, Curriculum, and Pacing Profile. **Every chore occurrence is required — there is no optional-chore state.** `required: true` is stamped by Packet Generation on every emitted occurrence (Interchange Contract §1b); it is a system-set value, not a parent-authored field, and Chore Authoring (Module 6) never exposes it for editing. Packet Generation also stamps `rewardCategoryId` (the Reward Category `difficultyTier` maps to, §2.3) onto every occurrence, the same resolution Activity entries get (§2.5).

### 2.7 Family Event
- **Purpose:** a dated reminder occupying calendar space in the Child App, with no completion concept.
- **Relationships:** belongs to one Child or a set of children; rides in the Packet as a display-only artifact; has **no** Activity Record and **no** row in the Completion CSV.
- **Required fields:** `id` (`EVT-{eventToken}`, 2 segments, minted at authoring — locked, not deferred to a TDS; `EVT` is reserved against `courseCode`/`lessonCode` the same way `CHR` is, so it can never collide with an Activity or Chore ID, §2.5), `title`, `startDate`, `endDate` (inclusive on both ends; `startDate ≤ endDate`; a single-day event sets `startDate = endDate`, no separate single-day code path), `childIds[]` (non-empty, minimum one entry).
- **Optional fields:** `notes`, `time`.
- **Lifecycle:** authored directly; sent in the Packet; displayed on the Child App's calendar/daily views; never completed, logged, or exported.
- **Rules:** does not touch Course/Lesson/Pacing/Activity/Chore in any way.

### 2.8 Lesson
- **Purpose:** an ordered subdivision of a Course grouping related Activities.
- **Relationships:** belongs to one Course; contains ordered Activities.
- **Required fields:** `id`, `order`, `title`, `lessonCode` (short, e.g. `L03` — feeds the Activity ID scheme), `nextActivitySeq` (integer — the persisted, never-reused `seq` counter for this Lesson's Activities, §2.5; seeded to `1` at Lesson creation, advanced in the same transaction as each Activity mint, **never recomputed from surviving Activities**).
- **Optional fields:** `objective`, `estimatedDays`, and the **Content Planning** fields: `pageRangeStart`/`pageRangeEnd` (a single shared page-range budget for the Lesson, drawn from by all `page-range`-structured Activities under it together) and `activityCountTargets[]` (a list of `{ activityTypeKey, targetCount }` pairs, one per `count`-structured type the parent wants to plan for).
- **There is no `activities[]` field.** A Lesson's Activities are a query — `activities` filtered by `lessonId`, sorted by `Activity.order` — not an embedded array. Same reasoning as §2.4's `lessons[]`: `order` is the persisted source of truth for sequence, and a second one would only ever disagree with it.
- **Lifecycle:** authored as part of a Course; copied wholesale when the Course is stamped.
- **Rules:** Content Planning fields are purely advisory — the page-range budget drives a *starting-page* default only (never an ending-page default) when the parent manually authors a new page-range Activity, filling gaps before extending past the budget's end; count targets drive a display-only "3 of 12" indicator. Neither is enforced or blocking; the parent can exceed, undershoot, or ignore either. Presets apply to manual single-Activity authoring only — bulk import is unaffected.
  - **`lessonCode` is unique within its Course**, and **freezes once any Activity exists under the Lesson.** Both are load-bearing, not cosmetic: with a literal `TPL` in segment 2, a template Activity ID carries no randomness at all, so its uniqueness rests entirely on `courseCode` + `lessonCode` + `seq`. Two Lessons sharing `L03` in one Course collide on the primary key; a renamed `lessonCode` strands old IDs and lets a later Lesson take the freed code and collide with them.

### 2.9 Pacing Profile
- **Purpose:** describes how one Child Course Instance's activities are distributed across days — the input to generation.
- **Relationships:** belongs to one Child Course Instance. Applies only to School content; Chore and Family Event are out of scope — they have their own recurrence/scheduling logic.
- **Required fields:** `id`, `instanceId`, `daysOfWeek[]` (same shape and validation as Chore's field, §2.6: a required, non-empty subset of `{Sun, Mon, Tue, Wed, Thu, Fri, Sat}`, no duplicates — one shared recurrence convention across both entities instead of two different models), `pacingMode` (`activityCount` | `minutesBudget`, required, exactly one), `startDate`, plus the mode-specific budget value: `activitiesPerDay` (required if `pacingMode: activityCount`) or `minutesPerDay` (required if `pacingMode: minutesBudget`).
- **Optional fields:** `blockLayout`, `skipDates[]`, `weighting`.
- **Lifecycle:** set at instance creation; adjustable through the semester; consulted on every generation run.
- **Rules:** pacing is per-instance, never shared. Changing it affects only *future* generation from the `progressCursor` forward.

### 2.10 Generated Packet
- **Purpose:** the output of generation — a bounded slice of daily assignments for one child, ready to export.
- **Generation unit: one child, one date range.** For that child and range, the generator:
  1. Walks every one of that child's Child Course Instances through its Pacing Profile to produce paced School Activities due in-range.
  2. Expands every one of that child's Chores through its own recurrence rule, minting one deterministic per-occurrence ID (`CHR-{choreToken}-{YYYYMMDD}`) per included date.
  3. Filters every Family Event touching that child by date-range overlap.
  4. Fans out multi-child Family Events into each named child's packet.
  5. Merges all three into `days[]`.
- **Merge order (fixed):** within a day, School Activities first, then Chores, then Family Events as day-level markers. This is the **Packet's array order** and is unchanged. `blockHint` does not affect it — but it is no longer "unused for ordering": on the child side it is the **outer** grouping axis of the Daily Plan (§3.4), with the School-then-Chores split nested *inside* each block. The Packet's merge order survives as the child's default *within-group* order (packet receipt order), which is exactly the role it now plays.
- **Empty-source rule:** a valid packet generates whenever *any* source has content for the range — a child with chores but no active instances still gets a packet.
- **Rules:** generation is idempotent for a given cursor + date range, so a re-export doesn't double-advance.

### 2.10a Generation Log
- **Purpose:** a per-item record of what Packet Generation actually sent to a child, and when — the input Master Reporting's Activity/Chore Roster report reads, since `progressCursor` alone only records a walk position, never the per-item dates a given run assigned.
- **Relationships:** one row per Activity or Chore occurrence included in a generation run; resolves to one Child (always) and one Course Instance (Activity rows only).
- **Required fields:** `childId`, `itemId` (for Chore rows, the per-occurrence ID), `assignedDate`, `generatedAt`.
- **Optional fields:** `instanceId` (Activity rows only — absent for Chores, which have no Instance).
- **Lifecycle:** written by Packet Generation (Management SRS Module 08) at the same time it advances `progressCursor` and writes the exported Packet file — one log row per item included in that run. Read-only to every other module.
- **Rules:** flat, one-row-per-occurrence shape, matching the Activity Record's own "one row per occurrence" convention (§3.6) rather than a run-level summary — this is what lets Roster answer "what was assigned to this child on this date" directly.

### 2.11 App Settings (Management)
- **Purpose:** a singleton, device-level settings record for the Management App itself — distinct from any Child, Curriculum, or Course data. Currently holds exactly one thing: the app-launch PIN.
- **Required fields:** `launchPin`.
- **Relationships:** none — not owned by or referencing any Child, Course, or other entity. One record per Management App installation.
- **Lifecycle:** set on first launch (analogous to the Child App's Startup Wizard, Module 1); changeable thereafter through the Management App's own Settings & Backup module (not yet written — Roadmap §3).
- **Rules:** checked **once, at app launch/session start** — this is a session-level gate on the whole app, not a per-action gate. It is a separate, independent credential from the Child App's `pin` (§3.2) — a parent using both apps sets each one separately; there is no shared-PIN mechanism between the two apps, consistent with the two apps never sharing a database (§5.3 in the load-bearing tradeoffs). Individual Management SRS modules (Curriculum Library, Difficulty Tier & Reward Category, Course Template Library, etc.) do **not** additionally gate their own actions behind this PIN — "No PIN" in those modules' Permissions sections means no *additional* per-action gate beyond the one-time launch gate, not that the app is unprotected.

### 2.12 Imported Completion Record
- **Purpose:** the Management-side result of reconciling a child's Completion CSV against currently-known Activity and Chore records, by stable `activityId`. Distinct from, and never merged into, authored Course/Lesson/Activity/Chore/Instance data.
- **Relationships:** one record per successfully-matched CSV row; resolves to exactly one Child (always) and one Course Instance (Activity rows only — Chores have none).
- **Required fields:** `activityId`, `date`, `status` (`complete` | `waived`), `resolvedChildId`, `importedAt`.
- **Optional fields:** `grade` (if present on the source row), `plannedBlock` (if present on the source row), `resolvedInstanceId` (Activity rows only).
- **Companion, not a field of this entity:** a separate, retained list of unmatched-row reports — `{ rawRow, reason, importedAt }` — surfaced to the parent and never auto-discarded.
- **Lifecycle:** created on a successful per-row match during Completion Import (Management SRS Module 09); never edited or deleted by that module afterward. Read by the future Master Reporting module.
- **Rules:** matching is by `activityId` alone — a row's own `childName`/`semesterLabel` are never used to resolve ownership, only cross-checked for a non-blocking mismatch warning. Chore rows resolve via the ID's `CHR-{choreToken}` stem, not the full occurrence ID, since only the stem is a stored Management-side record (Module 09 FR-3). Re-import of an `activityId` that already has a record here is a no-op, not a duplicate.

---

## 3. Child App domain

*Single-child. Child-scoped, not semester-scoped — this app persists across many semesters on one device; nothing forces a wipe at semester boundaries.*

### 3.1 Semester
- **Purpose:** a display label passed through from the Management App. Does **not** own the wipe boundary and does **not** scope the app's data lifecycle.
- **Required fields:** `label` (e.g. "Fall 2025").
- **Optional fields:** none. The Streak (§3.8) uses device-local date rather than timezone data.
- **Lifecycle:** arrives via Packet; the app may show a running history of semester labels it's seen.
- **Rules:** on the Management side, Semester remains operationally real (drives assignment/pacing). On the Child side it's a passthrough label only.

### 3.2 Child (single, denormalized)
- **Purpose:** the one student using this device — a flat copy of identifying fields, not a link to the Management child record.
- **Required fields:** `name`, `pin` (the credential for every Child-App PIN-gated action — deferment/waive, reward spend, and Settings entry/PIN change all share this one field. One PIN per device, not per feature).
- **Optional fields:** selected `theme`. (Distinct from the Management App's separate `Child.gradeLabel`, §2.1 — no `gradeLabel` field exists on the Child App side.)
- **Rules:** carries `name` into the completion CSV for parent attribution. `pin` is set once during Startup Wizard (Module 1) and changeable thereafter only through the PIN-gated Settings module (Module 11) — never readable in plaintext by any other module, never transmitted through the interchange.

### 3.3 Received Packet
- **Purpose:** an imported slice of daily work — Activities, Chores, and in-range Family Events.
- **Relationships:** dated content, tagged with whatever semester label arrived with it; not a lifecycle owner of anything.
- **Lifecycle:** imported → validated → merged into Daily Plans for its covered dates → retained until a manual, targeted wipe (§3.6a), not a semester-end wipe.
- **Rules:** **additive with refresh-on-pending** — import fills or overwrites the days it covers; a resend with the same activity `id` refreshes a still-pending item's display fields, received `date`, and tier, but is a full no-op against an already-resolved item. **It never overwrites a child-side override** (§3.4): not the block label, and not a deferred due date (§3.6b) — a re-import cannot silently un-defer an item. It never touches days outside its range or completion records already made. `childId`/`childName` are passthrough only and are neither stored nor validated on the child side (Interchange Contract §1); a packet generated for another child imports without complaint. Malformed packets are rejected whole, not partially applied.

### 3.4 Daily Plan
- **Purpose:** one day's work as the child sees and arranges it.
- **Relationships:** composed of Activities-as-received and Chores-as-received (both actionable), plus display-only Family Events; filtered into views (School / Chores / Events / Subjects / Today).
- **Not a stored entity — a derived view.** The Daily Plan is assembled at render time from the received items whose **effective due date** matches (or precedes, for the overdue rollup) the device-local date. There is no `dailyPlan` record, no `blocks[]` array, and no per-day `activities[]` array in storage. The only child-authored state is a small per-item override record (block label, sort position, deferred date). Two prior field-list entries (`activities[]`, `events[]`, `blocks[]`) described a persisted shape that does not exist and are withdrawn.
- **Effective due date:** the item's deferred date when a deferment has moved it (§3.6b), otherwise the `date` it was received with. Every date comparison the Daily Plan makes — is it due today, is it overdue — uses the effective due date, never the received `date` directly, and never the date segment inside a Chore occurrence ID.
- **Ordering (fixed, three nested axes):** **block first, category second, position third.**
  1. **Block** — the four canonical labels in fixed order: `morning` → `afternoon` → `evening` → `night`. An item's effective block is its child override, else its received `blockHint` if canonical, else `morning` (Interchange Contract §1d).
  2. **Category, nested inside each block** — School Activities first, then Chores. This mirrors the Packet's own merge order (§2.10).
  3. **Position, within each block+category group** — the child's sort position when they've set one, otherwise packet receipt order.
  Family Events sit in their own section and are never placed in a block, a category, or a sort position.
- **Rules:** the child may reorder and move actionable items between blocks; may **not** remove `required` items outright. A required item can instead be **rescheduled or waived** via the PIN-gated deferment action (§3.6b) — rescheduling edits its effective due date to any device-local date today or later, no upper bound (§3.6b); waiving drops its required status. Reorder and block-move are cosmetic, child-owned, and independent of each other: moving between blocks never changes sort position, and reordering never changes the block. Family Events are not reorderable into completion flows — they're calendar markers.

### 3.5 Activity (as received)
- **Purpose:** the child-side copy of a Management Activity — same stable ID, same payload, now completable.
- **Required fields:** `id` (the stable join key, unchanged from Management), `activityType`, `title`, `required`, `payload` (a tagged union — `kind` of `pageRange` | `reference` | `none` | `freeText`, each with its own additional fields, Interchange Contract §1a; the child renders by `kind` and never inspects `activityType`), `date`, `difficultyTier`, `rewardCategoryId` (the Reward Ledger category to mint into on completion — carried directly on the item; the child never resolves `difficultyTier` against a lookup table, since none exists client-side), `courseName` (the item's course, carried verbatim — the child parses no ID to derive this, it is displayed in the planner view, and it is what the Subjects view groups by, §3.3).
- **Optional fields:** `expectedDurationMin`, `capturesGrade`, `blockHint`, `sequenceNumber` (for count-structured types — rendered as its own child-facing display, separate from the Activity's title text), `lessonTitle` (display-only, copied at creation from the owning Lesson's `title`; §2.5), `instructions` (copied unchanged from the Management-side Activity `instructions`, §2.5 — closes an interchange gap that previously stopped `instructions` at the Management side).
- **Lifecycle:** received → planned → completed (produces an Activity Record) → exported.
- **Rules:** `required: true` cannot be deleted, skipped-as-removed, or hidden by the child. The child controls *when*, not *whether* (student-ownership guardrail). **The Child App parses no ID, ever** — every value it needs to display, group by, or export arrives as its own field (Interchange Contract §0).

### 3.5a Chore (as received)
- **Purpose:** the child-side copy of a Management Chore, due on a given date per its recurrence rule.
- **Required fields:** `id` (**per-occurrence** stable join key, `CHR-{choreToken}-{YYYYMMDD}`, never collides with Activity IDs), `choreType`, `difficultyTier`, `rewardCategoryId` (the Reward Ledger category to mint into on completion — carried directly, same treatment as Activity-as-received, §3.5), `title`, `date`, `required` (always `true`, stamped by Packet Generation — a chore has no optional state, §2.6).
- **Optional fields:** `notes`, `blockHint`.
- **Lifecycle:** received (expanded from the Chore's recurrence rule at generation time) → planned → completed (produces an Activity Record, same mechanism as School Activities) → exported.
- **Rules:** required-item handling is identical to Activity-as-received — chores are unconditionally required, with no "where applicable" carve-out; mints 1 Reward Ledger unit of its `rewardCategoryId` on completion. `daysOfWeek[]` is never present here — the recurrence rule never travels in the Packet (Management-only concept, §2.6). **One record per due occurrence:** the same chore due on three dates exists as three items with three IDs. The date segment inside the ID is a minting detail, never parsed — `date` is the scheduling field, and deferment may move it.

### 3.5b Family Event (as received)
- **Purpose:** the child-side copy of a Management Family Event — a display-only calendar marker.
- **Required fields:** `id`, `title`, `startDate`, `endDate` (same shape as the Management-side original, §2.7).
- **Optional fields:** `notes`, `time`.
- **Lifecycle:** received → displayed on calendar/daily views → never completed, logged, or exported. No Activity Record is ever created for it.
- **Rules:** not reorderable into completion flows; produces no CSV row, ever.

### 3.6 Activity Record
- **Purpose:** the immutable record of what actually happened for one Activity or Chore.
- **Relationships:** 1:1 with an Activity or a Chore **occurrence**, joined by stable `id`; a recurring chore completed across many dates produces many records, each under its own occurrence ID. Flattened into the Completion CSV.
- **Required fields:** `activityId`, `date`, `status` (`complete` | `waived`), `exported` (boolean; defaults `false` at creation, set `true` only by a successful Completion CSV export, Module 8 FR-5 — the double gate Module 9's wipe depends on).
- **Optional fields:** `grade` (per Activity Type's `capturePattern` — a whole-number percentage, 0–100, per SRS Module 4). No `actualStart`, `actualFinish`, `durationMin`, or `notes` fields — no capture mechanism exists for any of them anywhere in the Child App SRS, and none is planned; carrying four permanently-blank fields buys nothing.
- **Lifecycle:** written on completion with `exported: false` → never overwritten except `exported` flipping to `true` on a successful Completion CSV export (Module 8) → cleared **only** by a manual, targeted wipe, and only when it represents completed/exported work (§3.6a). **A record is only ever written once an item resolves** (complete or waived) — pending-ness, including a rescheduled item, is represented by the *absence* of a record, never by a record carrying an in-between status. This is why `incomplete` is never producible: nothing writes a record for something that hasn't happened yet.
- **Rules:** immutable once written, with the sole exception of the `exported` flag's one-way `false → true` transition — a correction to any other field is a parent-side concern, not a silent overwrite. This app is a consolidated to-do list and completion log, not a grading system.

#### 3.6a The wipe
- **Trigger:** manual only — a child-side button, placed alongside the Completion CSV Export action rather than on the main daily view, so export and wipe form one small routine the child owns without it being stumbled into during daily work. Requires a plain confirmation step (not the parent PIN) before proceeding — the wipe's own double gate (only resolved-and-exported records ever clear) already bounds the risk of an accidental tap.
- **Clears:** completed/exported Activity Records, and fully-consumed Received Packet content.
- **Preserves (never cleared):** still-pending required activities (including anything rescheduled); the Reward Ledger snapshot (§3.7); the Streak counter (§3.8).

#### 3.6b Deferment / Waive
- **Purpose:** handle real-life disruption to required work without silently breaking the streak or losing the obligation. There is no separate "excuse the day" concept — deferment *is* that lever.
- **Surface:** a PIN-gated action on a required **Activity or Chore** alike.
- **Reschedule:** move the item to a new date, device-local today or later, with **no upper bound** — a bounded range would be meaningless since Packet Import is pure-additive (§3.3) and there's no single discrete "current packet" to bound against. Stays a pending required obligation; preserved through a wipe; reports normally whenever eventually completed.
- **Waive:** drop the item's required status. It will not be made up. Reports in the completion CSV with `status = 'waived'`.
- **Streak interaction:** both operations make the item "not required-and-undone today," so a day rescued by either can still qualify (§3.8) rather than break.
- **Named exception (guardrail):** rescheduling is a local Daily-Plan date edit — a small extension of reorder/move-between-blocks. It is **not** the pacing engine: no cursor, no sequence computation, no stamping.

### 3.7 Reward Ledger
- **Purpose:** tracks earned/spent reward currency per category, separate from the plain completion tracker.
- **Structure — checkpointed, not an unbounded log:**
  - **Balance snapshot per category:** `{ categoryId, balance, asOfDate }` — small, stored, survives the wipe.
  - **Recent tail:** entries since the last snapshot (`{ id, type: earn|spend|adjust, categoryId, amount, date, sourceId?, note? }`).
  - **Fold cadence:** on a wipe, or every N entries, the tail folds into the snapshot (deterministic sum) and folded rows drop.
  - **Displayed balance = snapshot + sum(tail).**
- **Earn:** written automatically on completion of an Activity or Chore, amount **1**, category from the item's `rewardCategoryId` — carried directly on the received item and used as-is. The child never resolves `difficultyTier` against a lookup table, since no Difficulty Tier entity exists on the Child App side; `difficultyTier` rides along on the item only as the honest underlying reference (§3.5, §3.5a).
- **Spend:** written by the **parent, on the child device, behind the parent PIN** — pick category, enter amount, deduct. No child-side spend action; no interchange channel for spends.
- **Adjust:** written by the **parent, on the child device, behind the parent PIN** (Settings, Module 11) — a signed correction entry for recovery (restoring values after data loss or a device switch, from the latest recovery note) or repair (correcting a wrong baked-in balance, the accepted checkpointing cost below). Folds into the snapshot exactly as earn/spend do; a negative adjust cannot take a balance below zero (the hard spend ceiling's floor applies to every entry type).
- **Rules:**
  - The snapshot is never a number a human types — it is only ever a computed fold of the auditable tail. The sole sanctioned correction path is a parent-PIN-gated `adjust` tail entry (above), which keeps corrections themselves on the audit record rather than overwriting it.
  - **Accepted cost:** a snapshot is a point where a bug could bake in a wrong balance permanently. Mitigated by keeping the tail raw/auditable and folding as a pure deterministic sum. Accepted in exchange for bounded storage on the budget device. The `adjust` entry is that risk's remedy: a baked-in wrong balance is corrected forward through the tail, never by editing the snapshot.
  - Categories never convert into each other.
  - Persists indefinitely; exempt from wipe and semester re-scoping.
  - Display is theme-skinned per Reward Category; internal `categoryId` never shown to the child.
  - **Recovery note:** the Completion CSV export action (Module 8) additionally writes a small, human-readable note file — device-local date, streak value, and per-category balances (internal `categoryId` plus current theme display name for readability). **Write-only:** no module in either app ever reads or imports it; it is not part of the interchange contract, and the Management App never receives ledger data (guardrail 6 intact). Its only consumer is the parent's eyes, feeding the repair form.

#### 3.7a Reward Definition (catalog) — deferred
- **Purpose:** a named, priced redeemable (e.g. "shopping trip = 5 Hard") defined independently of chores/school.
- **Status:** deferred, not dropped. Covered by paper lists until built. First iteration's spend flow is the manual PIN-gated amount-and-deduct in §3.7 — no catalog, no redemption modeling.
- **Future shape (indicative):** `{ id, label, categoryId, price }`, parent-authored, referenced by a `spend` entry when redeemed.

### 3.8 Streak
- **Purpose:** tracks consecutive qualifying days, independent of whether the underlying records still exist.
- **Required fields:** `currentStreak` (integer), `lastQualifyingDate`.
- **Qualifying day:** a day with required activities due qualifies only if **all** are complete. A day with **no** required work due is **neutral** — it neither extends nor breaks the streak. A day with required work due and not all complete (and not rescued via reschedule/waive) **breaks** the streak.
- **Gap catch-up:** the counter only ticks while the app is open, so on each open it reconciles elapsed time — if any non-neutral day passed unqualified since `lastQualifyingDate`, it resets to 0.
- **Day boundary:** device-local date. No timezone modeling. *(Accepted: a child rolling the device clock could fake a streak — low-stakes on a reward toy, not worth clock-integrity checking.)*
- **Rules:** persists indefinitely, exempt from wipe and semester re-scoping. Live-counter design (not a retroactive scan) is required so a wipe or records gap can never be mistaken for "the streak never broke." A parent-PIN-gated set path exists in Settings (Module 11) for recovery: it writes `currentStreak` and `lastQualifyingDate` together (`lastQualifyingDate` defaulting to device-local today), so the on-open gap catch-up doesn't immediately re-zero a restored streak.

### 3.9 Theme / Settings
- **Purpose:** the child's personalization and light preferences — the adoption hook.
- **Required fields:** `theme`, plus light display prefs.
- **Optional fields:** reminder cadence preference (for the export reminder).
- **Lifecycle:** set in the wizard; child-editable anytime; not PIN-gated.
- **Rules:** owns a display mapping per Reward Category (name + icon) with a generic default fallback for any category without theme-specific art yet, so a newly-added difficulty tier never renders blank/broken. All themes open to every child, always — **no per-kid gating mechanism exists**, matching SRS Module 10.

---

## 4. Interchange format (first-class)

### 4.1 The Packet (Management → Child)
- **Purpose:** carry a bounded slice of pre-generated daily work for one child to the child device.
- **Shape:** `schemaVersion` (integer; current value `1`); `childId`/`childName`; `semesterLabel` (passthrough only — no auto-reject on mismatch); `generatedAt`, `coversFrom`, `coversTo`; `days[]`, each `{ date, activities[], chores[], events[] }` — activities and chores carrying their stable `id`, `activityType`/`choreType`, `difficultyTier`, `rewardCategoryId`, and other fields per §3.5/§3.5a; events display-only per §3.5b, carrying an `EVT-{eventToken}` `id` (§2.7). Activity entries also carry `lessonTitle` and `instructions` when present, plus the required `courseName` and a tagged-union `payload` (`kind` of `pageRange` | `reference` | `none` | `freeText`) so the child renders without ever inspecting `activityType`. Chore entries carry `required: true`, stamped by Packet Generation rather than parent-authored. None of these is a Packet-format addition requiring new authoring UI: `lessonTitle`/`instructions` ride through once authored (Packet Generation FR-8's "copy every field as currently authored"), and `courseName`/`rewardCategoryId`/`payload.kind`/chore `required` are resolved or stamped by Packet Generation itself at export time.
- **Lifecycle:** generated from the per-child, per-date-range aggregation (§2.10), which itself advances each contributing instance's `progressCursor` at generation time — on the Management side, before export, since the one-way interchange makes a child-side trigger impossible → written to Drive → imported by the child app.
- **Rules:**
  - **Additive with refresh-on-pending** over its own date range (§3.3).
  - **All-or-nothing validation.** A packet failing schema/semester checks is rejected whole. An unrecognized `schemaVersion` is included in that all-or-nothing reject — a whole-packet rejection with a plain message, never a best-effort partial parse.
  - **Stable IDs preserved** — identical to their Management-side originals; for Chores, the occurrence ID minted at generation (§2.10), deterministic per (choreToken, date).
  - **Variable range** — a packet may cover any number of days; cadence is the parent's runtime choice.
  - **No spend channel.** The Packet never carries Reward Ledger spend instructions — spends are local to the child device only.
  - **Fully specified, including filename conventions and fixtures, in the Interchange Contract §1/§7/§8** — referenced here rather than restated in full.

### 4.2 The Completion CSV (Child → Management)
- **Purpose:** report what actually happened; the parent's spreadsheet dashboard now, the Management import source later.
- **Columns (locked — the single authoritative list, eleven total):** `activityId, date, course, activity, activityType, plannedBlock, status, grade, childName, semesterLabel, sequenceNumber`
- **Lifecycle:** exported by the child on a cadence (end-of-week reminder) → saved to Drive → collected by the parent → (later) imported into Management.
- **Rules:**
  - **`activityId` present from v1**, even before anything consumes it — the reconciliation join key. Never dropped.
  - **`status` reserves a `waived` value**, distinguishing a deliberately-skipped required item from an un-done one.
  - Completed Chores produce rows on the same join-key convention. **Family Events never produce rows.**
  - **`course` is the received Activity entry's `courseName`, carried verbatim (§3.5).** The child parses no ID to produce it — a prior design that parsed the Activity ID's `courseCode` segment is superseded; `courseName` is a Packet field now, not a derived value.
  - **A Chore has no `course` and no `activityType` field of its own (§2.6).** `activityType` is populated from the Chore's own `choreType` (a value from its canonical enum, §2.6) rather than a generic placeholder, so the column stays genuinely informative instead of a constant dead value. `course` is left blank — the same treatment already given to other not-applicable columns (`grade`, `plannedBlock`). Columns are never conditionally omitted per row; the CSV's column set is fixed for every row regardless of source.
  - **The CSV carries no version field — its eleven-column header is its version.** A file whose header doesn't match the locked eleven, in order, is rejected by Completion Import as malformed (Interchange Contract §2, §7).
  - One row per Activity Record; UTF-8, RFC 4180; append-only in spirit.
  - **A Chore row's `activityId` is the occurrence ID** — one row per completed occurrence, so idempotent re-import by `activityId` (Module 09) is exact with no compound key.
  - **No `actualStart`, `actualFinish`, `durationMin`, or `notes` columns** — these fields don't exist on the Activity Record (§3.6). If reintroduced later, that's a fresh decision with a real capture mechanism designed alongside it — not a default to revisit casually.
  - **`sequenceNumber` is copied directly from the child device's Activity-as-received data at export time** — no new capture mechanism, the same sourcing pattern already used for `plannedBlock`. Blank for page-range types and Chore rows, where it doesn't apply. Carrying it directly (rather than leaving it to a later Management-side lookup) means it survives even if the source Instance is deleted before reconciliation.

### 4.3 Reconciliation (deferred build, designed now)
- **Purpose:** when Management import ships (Phase 4), fold each child's completion CSV back into consolidated master records. Results land in Imported Completion Records (§2.12).
- **Mechanism:** join completion rows to Management Activities/Chores by stable `activityId`.
- **Rules:** collect-and-reconcile, not live merge — reads a CSV the parent supplies, does not sync automatically. Unmatched rows (e.g. from a since-deleted instance) are reported, not silently dropped. **Fully specified in Management SRS Module 09 (Completion Import)** — row-level partial commit (a bad row doesn't reject the whole file), idempotent re-import by `activityId`, and a non-blocking `childName` mismatch warning are all part of that module's resolved design, referenced here rather than restated.

---

## 5. Load-bearing tradeoffs (documented so they aren't "fixed" later)

**5.1 No propagation from Course template to instance.** Independent copies mean a source fix requires fixing the template plus every already-stamped instance separately. Accepted deliberately — silent propagation into a course a child is mid-way through is worse than manual re-fixing. Curriculum-level suggestions (§1) are the one narrow, justified exception. **Do not add live template→instance sync.**

**5.2 A "useless" column from day one.** The Completion CSV carries `activityId`, and now the reserved `waived` status, before any importer reads either. Insurance against a breaking change to the export format when import eventually ships. **Do not remove either.**

**5.3 Two schemas, one contract.** Management and Child apps have different IndexedDB schemas and never share a database. The only thing they share is the interchange format (§4). Coupling their schemas would defeat the producer/consumer split.

**5.4 Child owns the export.** The completion export is the child's responsibility (with a reminder prompt), by design — it builds ownership. Cost: potential gaps if a preteen forgets; the parent backstops by checking. Do not move the export off the child to "guarantee" it — that removes the ownership the design is buying.

**5.5 The Reward Ledger and Streak are wipe-exempt because they're bounded, not because they're small.** The ledger is wipe-exempt because it's checkpointed to a bounded snapshot (§3.7) — storage stays bounded regardless of how long the device is used, independent of the (true but not load-bearing) fact that the balance itself is a small number.

**5.6 Suggested Activity Types are always soft, everywhere, permanently.** Even for a Curriculum with a genuinely fixed current offering, the suggestion list is never promoted to an enforced whitelist.

**5.7 The child app's bounded intelligence has exactly three named exceptions.** The Reward Ledger snapshot, the Streak counter, and the local date-edit performed by deferment/reschedule. None runs the pacing engine; none holds curriculum-library-scale data. Anything beyond these three is scope creep, not a fourth exception waiting to be justified the same way.

**5.8 Chore occurrence IDs are deterministic, not random.** `CHR-{choreToken}-{YYYYMMDD}` re-derives identically on regeneration — this is what keeps re-export idempotent for chores with no log lookup. Do not "improve" occurrence minting with a random token; randomness would turn every regeneration into duplicate work on the child device.

**5.9 Ledger/Streak recovery is approximate-by-design: a write-only note plus human repair, never machine restore.** The recovery note is at most one export cadence stale, and restoring means a parent keying values into a PIN-gated form. Accepted deliberately: a machine-restorable backup would add a parser, a schema version, and a tamper surface to buy per-unit exactness a reward toy doesn't need — and still couldn't correct a wrongly-baked snapshot, which only the adjust path can. **Do not add a restore parser or make any module read the note.**

**5.10 The recovery note's balance/streak fold is deliberately duplicated, not centralized.** Module 8 (Completion CSV Export) independently recomputes the same `snapshot + sum(tail)` fold Module 6 already implements for display, because Architecture Evaluation §7's shared `utils.js` carve-out is formatting-only, never business logic — it offers no home for shared computation. Accepted: duplicating one small, stable formula across two files is cheaper and safer than bending the one-file-per-module / no-shared-business-logic rule for a single reuse. **If the fold formula or the zero-floor rule ever changes, both Module 6 and Module 8 must be updated together** — named here so a future single-module edit doesn't silently desync them.

---

## 6. Resolved and locked (do not re-litigate without new information)

- Reward earn magnitude — flat 1 per completion.
- Reward spend path — PIN-gated child-device action, no interchange channel.
- Reward Ledger spend ceiling — hard; a child can never spend past their current balance. No negative/"owed" balance state exists.
- Stable Activity ID scheme — readable composite with per-stamp instance token.
- Streak qualifying rule, gap catch-up, day boundary; `timeZone` not modeled.
- Reward Ledger storage model — snapshot + tail checkpointing.
- Packet generation unit and merge order.
- Deferment/waive capability and the wipe carve-out for pending work.
- Activity Type → capture-field matrix (10 canonical types, extensible mechanism).
- Bulk spreadsheet import shape (flat rows, `courseCode`/`lessonCode` join keys, Course excluded, all-or-nothing).
- **`gradeLabel` is not a Child App field (§3.1, §3.2).** The Management App's separate `Child.gradeLabel` is unaffected.
- **Per-kid theme gating — full child choice, no gating, ever (§3.9).**
- **Completion CSV column set (§4.2), matching SRS Module 8** — eleven columns, including `sequenceNumber` and the `choreType`-mapped `activityType` convention for Chore rows.
- **Difficulty Tier delete-guard — checks Activity/Chore references only**, not Reward Ledger data (Management App has no visibility into Child-side ledger entries under the one-way interchange design).
- **`actualStart`, `actualFinish`, `durationMin`, `notes` are not part of the Activity Record or Completion CSV (§3.6, §4.2)** — no capture mechanism exists anywhere for any of the four, and none is planned.
- **Activity Record `status` is spelled `complete`, not `completed` (§3.6)**, matching the SRS layer.
- **Reschedule range — any device-local date today or later, no upper bound (§3.6b)**; a bounded range would be meaningless since Packet Import is pure-additive (§3.3).
- **Two independent PINs — Child App `pin` (Child, §3.2) and Management App `launchPin` (App Settings, §2.11).** Separate credentials, separate apps; the Child PIN gates individual actions, the Management PIN gates app launch once per session.
- **`exported` (boolean) — required field on Activity Record (§3.6)**, load-bearing for Module 8/Module 9; defaults `false`, flipped `true` only on successful export.
- **`incomplete`/`excused` are not part of the Activity Record `status` enum (§3.6)** — no producer anywhere in the SRS needs them; pending-ness is represented by record-absence, not an in-between status. Status is `complete` | `waived`.
- **Deferment/Waive extends to Activity or Chore alike (§3.6b)**, consistent with §3.4, Module 3 FR-6, and Module 7 §2.
- **Archivable-as-template — a diverged Child Course Instance is never promoted back into the library (§2.4).** A parent wanting to reuse an instance's content as a new template re-authors it manually.
- **Wipe trigger — a child-side button, paired with the Completion CSV Export action (§3.6a), not a packet-carried flag.** No PIN; a plain confirmation is sufficient.
- **Parent-added custom Activity Type payload — a single generic free-text field (§2.5a),** regardless of `structurePattern`.
- **Project structure is fixed at one file per SRS module, no shared `ui.js`** (Architecture Evaluation §7).
- **Generation Log (§2.10a)** — one row per assigned Activity/Chore occurrence, written by Packet Generation alongside `progressCursor`; feeds Master Reporting's Roster report.
- **Manual file selection is a permanent fallback on both sides of the interchange**, never superseded once Drive integration ships.
- **Family Event wipe rule — clears once its date is strictly before device-local today (§3.6a)**; one dated today or later always survives.
- **Chore occurrence identity — per-occurrence IDs `CHR-{choreToken}-{YYYYMMDD}`, minted deterministically at generation; `daysOfWeek[]` never travels in the Packet; the ID's date segment is never parsed for scheduling.**
- **Ledger/Streak survival — three layers: `storage.persist()` requested at wizard completion (best-effort, residual eviction risk accepted); a write-only, human-readable recovery note written by the Completion CSV export action; a parent-PIN-gated repair form in Settings (`adjust` tail entries for balances; streak set writes `currentStreak` + `lastQualifyingDate`). No machine restore; no module ever reads the note; nothing crosses the interchange.**
- **Recovery-note fold logic is duplicated between Module 6 and Module 8, by acceptance (§5.10), not oversight.**

- **`lessonTitle` is a display-only field on Activity (§2.5, §3.5), copied at creation from the owning Lesson's `title`.** It does not propagate — editing a Lesson's title later updates neither template Activities' `lessonTitle` (intra-template) nor stamped instances' (§5.1). Never a Completion CSV column; never on the Activity Record.
- **Activity `instructions` and Chore `notes` are both child-visible, parent-authored, display-only fields shown in the Daily Planner (§3.5, §2.6).** Neither is a completion-time capture, a Completion CSV column, or part of the Activity Record — distinct from the declined child-entered-notes-at-completion idea (Module 4 §3.2).

- **Activity `payload` is a tagged union with a `kind` discriminator (§2.5, §3.5)** — `pageRange` | `reference` | `none` | `freeText`, stamped by Packet Generation from the Activity Type's `structurePattern` and canonical/custom status. The child renders by `kind` alone and never inspects `activityType`.
- **Activity entries carry `courseName` verbatim (§2.5, §3.5, §4.1, §4.2)** — the Child App parses no ID, ever, including for the Completion CSV's `course` column. The Subjects view groups by this name, not a course code.
- **ID delimiter is locked to `-`, every segment alphanumeric-only (§2.5).** Family Event IDs are `EVT-{eventToken}`, no longer deferred to a TDS.
- **Every completable item carries `rewardCategoryId` directly (§2.5, §2.6, §3.5, §3.5a, §3.7).** The child mints Reward Ledger earns from this field and never resolves `difficultyTier` against a Difficulty Tier table, since none exists client-side.
- **Every Chore occurrence carries `required: true`, stamped by Packet Generation (§2.6, §3.5a).** Not parent-authored; there is no optional-chore state. Child-side "where applicable" hedges for chore requiredness are dropped.
- **`schemaVersion` is an integer; current value `1` (§4.1).** An unrecognized version is a whole-packet reject. Packet/Completions/recovery-note filename conventions are fixed in Interchange Contract §7 — no longer an open TDS item.
- **Daily Plan ordering — block outer, category nested, position innermost (§3.4).** `blockHint` *is* an ordering axis on the child side; the earlier "unused for ordering in this iteration" wording (§2.10) referred to the Packet's array order and is superseded for display. Blocks render in the fixed order `morning`/`afternoon`/`evening`/`night`; absent or out-of-set `blockHint` falls to `morning`.
- **Daily Plan is derived, never persisted (§3.4).** No `dailyPlan` store, no `blocks[]`. The only child-authored per-item state is `{ sortOrder, blockHint, deferredDate }`, all optional.
- **Child-side overrides survive every re-import (§3.3, §3.4, Interchange Contract §1d).** Refresh-on-pending rewrites the received fields, never the block override and never a deferred date — a re-import cannot un-defer.
- **`childId`/`childName` are passthrough on the child side (§3.3).** Not stored, not validated, never a gate on import. A cross-child import succeeds silently; the CSV reconciliation key is `activityId` alone (§4.2).

**Deferred by decision, not open:** the Reward Definition catalog (§3.7a) — paper lists until built.

---

*Companion documents: Documentation Roadmap, Architecture Evaluation. All SRS modules for both apps — including Master Reporting and Settings & Backup — are written. Next document in sequence: the Technical Design Specification.*
