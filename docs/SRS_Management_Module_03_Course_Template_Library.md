# Software Requirements Specification — Management App
## Module 3: Course Template Library
*Written against Domain Model §2.4 (Course), §2.5/§2.5a (Activity, Activity Type — ID scheme, canonical enum), §2.8 (Lesson), Management SRS Module 02 (Difficulty Tier reference table), Architecture Evaluation, Documentation Roadmap.*

---

## 1. Purpose

Lets the parent author and maintain the Course Template library: Courses (under a Curriculum), their Lessons, and their Activities. This module owns Course/Lesson/Activity content and structure only — it does not own stamping a Course to a child (Child Management, a separate module), pacing (Pacing Configuration), or packet generation. Two entry paths populate Activity data: manual single-Activity CRUD (aided by Lesson-level content planning defaults) and bulk CSV import.

## 2. Scope notes

**2.0 — This module is split across two milestones by functional requirement.** It owns three entities (Course, Lesson, Activity) across 14 FRs. Activity Type is **not** one of them — it is Module 12 (split out during M5 planning, Roadmap §8).

- **Milestone M5 — the manual authoring path.** Courses (FR-1, FR-2), Lessons (FR-3), Activities (FR-4), reordering (FR-9), and the resolution/validation rules (FR-6, FR-7, FR-8). This is everything needed to hand-author a course that can be stamped, paced, and generated into a packet.
- **Milestone M8 — volume and convenience.** Bulk CSV import of Lessons + Activities (FR-5) and the Lesson content-planning presets (FR-P1–FR-P6). These are how a parent enters curriculum **at volume**; they are not how the pipeline is **proved**. Two hand-authored lessons prove the packet, so they are deliberately deferred until after the M7 seam checkpoint (Roadmap §5).

Nothing about the data model differs between the two halves — FR-5 and the FR-P set write the same Lessons and Activities the manual path writes, so building them later requires no migration and no rework of the manual path.

**2.1 — Course is manual-only; Lesson and Activity support bulk import.** Given the real volume split (roughly 6 Courses vs. hundreds of Lessons/Activities per semester), Course is never part of the CSV. The parent creates each Course in-app first and gets its `courseCode` back; the CSV then references that `courseCode` to attach Lessons and Activities to an already-existing Course.

**2.2 — Bulk import shape: flat rows, `courseCode` + `lessonCode` repeated, all-or-nothing validation.** One CSV row per Activity. Every row carries the `courseCode` of an existing Course (hard reject if unmatched) and a `lessonCode` (new Lessons are created on the fly, grouped by this code). Within a `lessonCode` group, every Lesson-level field (`title`, `order`) must match exactly across all rows in that group; any mismatch rejects the entire file. This mirrors the all-or-nothing pattern already locked for Packet Import (Child App Module 2), applied one level down since Course itself is out of the CSV.

**2.3 — Activity Type is a parent-extensible table, not an enum, and it lives in Module 12.** The 11 canonical types (Video, PDF, Practice, Online Sim, Quiz, Test, Report, Reading Pages, Workbook, Project, Drill) are its **seed set**, not a fixed list. This module only *references* the table — for `activityType` validation (FR-8) and, at packet-projection time rather than at Activity creation, for `capturePattern` (FR-10).

**2.4 — Course template deletion is not reference-guarded, unlike Curriculum and Difficulty Tier.** A stamped Child Course Instance is a full independent copy (Domain Model §2.4 — "an Instance never links back to the template for content"); its `sourceTemplateId` is provenance-only, not a live dependency. Deleting a template therefore cannot break an existing instance. `sourceTemplateId` may end up pointing at a deleted template — that's an inert historical reference, not a data-integrity problem, and the Management App should display it as "template no longer available" rather than treat it as an error.

**2.5 — Activity Type is parent-extensible via two independent axes, not a hardcoded enum.** The 10 types in §2.3 seed a small managed table (same shape as Module 2's Difficulty Tier). Each type has:
- a `capturePattern` (`grade-optional` | `no-capture`) — governs Child App completion behavior (Module 4).
- a `structurePattern` (`page-range` | `count`) — governs Lesson-level planning behavior (§6).

Both patterns are chosen from a fixed set of two options each when a type is created, and both are **fixed once the type exists** — same integrity reasoning as Difficulty Tier's mapping: changing either later would make existing Activity Records and Lesson presets ambiguous about what they actually represent.

**2.6 — Lesson Content Planning.** A Lesson optionally carries a **content plan** — a shared page-range budget (for `page-range`-structured types, currently PDF and Reading Pages) and/or per-type count targets (for `count`-structured types, currently everything else, including Practice Level). These are **soft planning aids**, not generators or hard limits:
- The **page-range budget** is one shared range per Lesson (e.g. 45–60), drawn from by *both* PDF and Reading Pages Activities together. When the parent manually creates a new Activity of either type under that Lesson, its starting page defaults to the lowest page in the budget not yet covered by an existing PDF or Reading Pages Activity in that Lesson — filling gaps first, then continuing past the budget's end if it's fully covered. The end page is **never defaulted** — pages are personalized per activity/day, so the parent always sets it explicitly.
- A **count target** (e.g. Practice Level: 12, Video: 1) is purely informational — it drives a progress display ("3 of 12 Practice Level Activities added") with no value-defaulting and no enforcement. The parent can add fewer than the target (skip freely) or more, without any block or warning.
- Presets are entered/edited through manual Lesson authoring only (§7/FR-3) — not through the bulk CSV, since the defaulting behavior is inherently an interactive "see a suggestion, override if needed" flow that a static spreadsheet row can't participate in. A bulk-imported Lesson can still receive presets afterward via manual edit.

**2.7 — Platform-hosted content is named, never linked.** Content like Video and Quiz is accessed through the learning platform's own app, which the child already knows how to navigate — the Activity only needs to identify *which* item to select there, never a link or hosted address. That identification is the `title` (the separate `reference` field it used to occupy is gone — §4); this applies to any Activity Type whose content lives on a platform the child accesses independently of this system, not just Video.

## 3. User stories

- As a parent, I want to create a Course once, by hand, and get back a short code I can reference, so my bulk-imported Lessons and Activities have somewhere to attach.
- As a parent, I want to import a semester's worth of Lessons and Activities from one spreadsheet, so I'm not hand-entering hundreds of rows.
- As a parent, I want to set a page range and expected activity counts when I create a Lesson, so adding each individual Activity afterward doesn't require me to remember what pages or counts are already covered.
- As a parent, I want the page range to just be a starting suggestion, not a rule, so I can freely adjust it day to day without fighting the app.
- As a parent, I want to fix or add a single Activity by hand without re-running a whole CSV, so small corrections don't require a full re-import.
- As a parent, I want a bad import file rejected outright, not partially applied, so I never end up with a half-imported semester I have to debug.
- As a parent, I want to say once that a Quiz in this Course takes twenty minutes and a Practice takes ten, so pacing by minutes reflects what the work actually costs without me typing a number onto three hundred Activity forms.

## 4. Entity fields (as authored here)

**Course** — Required: `id`, `name`, `curriculumId` (references Curriculum Library), `courseCode` (short, human-readable, parent-entered or auto-slugified from `name`; **unique across all Course templates, case-insensitively**; **frozen once any Activity exists beneath the Course** — FR-2), `mainCategory` (fixed to `school` for anything authored here), `lessons[]`, `state` (`template` — instances are created by Child Management, out of scope here). Optional: `coreElective` (`core` | `elective`), `subject`, `description`, `defaultPacingHint`, `titlePatterns` (sparse map of `activityTypeKey` → pattern string, FR-P8; absent keys fall back to the built-in default). `titlePatterns` is never carried onto a stamped Course Instance (Child Management's `stampCourse`) — the recipe is template-only, so an instance would carry a field nothing reads.

**`defaultPacingHint` is read, as of the default-profile change.** It stays free text and stays optional, but it is no longer inert: stamping this Course to a Child seeds that Instance's Pacing Profile from it (Mgmt SRS 05 §2.6a/FR-1a, Mgmt SRS 04 FR-4 step 6). Documented form is one or more labelled clauses separated by `;` — `Activities Per Day - 2`, `Minutes Per Day - 60`, `Days - Mon/Wed/Fri` — and the Course form's help text says so. Nothing here validates it: an unreadable hint costs nothing, since every field it fails to state falls back to a default the parent can edit in Pacing Configuration. The hint is copied onto the Instance at stamp time as it always was, and editing it afterward (on either record) never re-paces an existing Profile.

**Lesson** — Required: `id`, `courseId` (parent link), `lessonCode` (short, parent-entered or auto-derived from `order`; **unique within its Course**; **frozen once any Activity exists under the Lesson** — FR-3), `order`, `title`, `activities[]`, `nextActivitySeq` (the persisted, never-reused `seq` counter, Domain Model §2.5/§2.8 — system-maintained, never parent-facing). Optional: `objective`, `estimatedDays`, `pageRangeStart`/`pageRangeEnd` (the shared content-planning budget, §6), `activityCountTargets[]` (list of `{activityTypeKey, targetCount}`, §6).

**Activity** — Required: `id`, `lessonId` (parent link), `activityType` (references the Activity Type table, Module 12 — not a hardcoded enum), `title`, `required` (bool), `difficultyTier` (references Module 2's Tier table), `order` (integer — position within the Lesson; contiguous from `0`, system-maintained; **this is the pacing walk order**, Mgmt SRS 05 §2.4; reorderable via FR-9). For `page-range`-structured types only, also required: `pageRangeStart`, `pageRangeEnd` (integers, top-level fields). Optional: `expectedDurationMin`, `instructions`.

**`expectedDurationMin` has three entry paths, all writing this same field on this same record** — the single-Activity form (FR-4), a CSV column (FR-5), and the Course's bulk per-type panel (FR-11). None of them is a default or an inheritance: the value lives on the Activity and nowhere else, absent when unset, and an absent value is counted as 15 minutes at generation time (Mgmt SRS 05 §2.3) rather than being written as one.

**Seven fields left this record** (`TDS_Slice_Lesson_Recipe.md` §3.1, shipped 2026-08-13): `payload` (one shape survived, so its two page-range members are top-level fields instead), `reference` and `text` (`title` carries what they did), `blockHint` (collected and never read — a row's block hint comes from the pacing profile at generation), `sequenceNumber` (§6/FR-P6 — the ordinal lives in the title now), `capturesGrade` (a pure function of `activityType`, computed at packet projection), and `lessonTitle` (derivable from `lessonId`; the snapshot that matters is the committed D1 row, which still freezes it — so renaming a Lesson now flows into future commits instead of leaving templates on the old name).

**Two numbers live on an Activity — do not conflate them** (the third, `sequenceNumber`, is gone with the field):

| Field | Counts | Scope | Mutable? | Visible to child? |
|---|---|---|---|---|
| `order` | Position in the Lesson, across **all** types | Lesson | **Yes** — parent reorders freely | No (drives pacing order only) |
| `seq` | ID segment, across **all** types | Lesson | **Never** — minted once, never reused | No (inside an ID nobody parses) |

**Reordering an Activity (FR-9) changes `order` only.** It never touches `seq`.

## 5. Activity Type Management — moved to Module 12

**Activity Type CRUD (create, edit label, immutability of `capturePattern`/`structurePattern`, reference-guarded delete — previously FR-A1–FR-A4) is no longer specified in this document.** It moved to **Management SRS Module 12 — Activity Type Management** during M5 planning (Roadmap §8, Architecture Evaluation §7), with its own `activityTypes.js` file and its own `activityTypes` store (already seeded in `storage.js` at M4 — M4 TDS Q4; only the CRUD's file ownership moved). This module only *references* the Activity Type table (FR-8) and reads `capturePattern` off it — at packet projection, not at Activity creation.

**One FR stays behind, because it's a rule about Activities, not about types:** what was FR-A5 (`capturesGrade` from the type's `capturePattern`) is renumbered **FR-10** and kept in §7, alongside the other Activity FRs — now stating that it is derived rather than stored.

## 6. Lesson Content Planning

See §2.6 for the full rationale. This section specifies the mechanism.

**FR-P1 — Set the Lesson page-range budget.** When creating or editing a Lesson, the parent may optionally set `pageRangeStart`/`pageRangeEnd`. One range per Lesson, and — per D11 (§8) — one page-range **type** per Lesson to draw on it; there is no separate range per type.

**FR-P2 — Set per-type count targets.** When creating or editing a Lesson, the parent may optionally set a `targetCount` for any Activity Type (e.g. Practice Level: 12, Video: 1, Quiz: 1) — `count`-structured types most naturally, but a `page-range` type's target reads as "this many chunks" and is equally allowed. Multiple targets, one per type, may be set on the same Lesson. A Lesson with no targets yet opens the group **pre-populated with one blank-count row per type named by the Course's `titlePatterns` or its Curriculum's `suggestedActivityTypes[]`** (FR-P9), so the common case is typing numbers rather than picking types. A row whose count is left blank stores no target — a suggested row the parent ignores leaves the record exactly as if it were never offered — and any other type remains addable from the row's dropdown.

**Row order is the parent's, and it is the order the Activities are stamped in.** Each row carries ↑/↓ alongside Remove, and `activityCountTargets[]` is stored in the on-screen order, because FR-P9 seeds the recipe "in target order" and the recipe stamps `order` down its own list. The group *opens* in Activity Type table order (FR-P9's union, deliberately stable and independent of which source named a type first) — that is a starting position, not a claim about the teaching order of the Lesson, and a Lesson that watches the video before drilling the practice levels needs to say so before generating rather than reordering N generated rows afterwards in Stage 2.

**FR-P3 — Page-range default on manual Activity creation.** When the parent manually creates (FR-4) a new PDF or Reading Pages Activity under a Lesson that has a page-range budget set, the Activity's starting page pre-fills to the lowest page within `[pageRangeStart, pageRangeEnd]` not yet covered by any existing PDF or Reading Pages Activity under that same Lesson — filling gaps before extending past `pageRangeEnd` once the whole budget is covered. The ending page is **never** pre-filled; the parent always sets it. The pre-filled start is a suggestion only — freely editable, never validated against the budget (an Activity may start before, end after, or fall entirely outside the budget with no warning or block).

**FR-P4 — Count target is display-only.** When a Lesson has a `targetCount` set for a given type, the Lesson's authoring view shows current-vs-target progress (e.g. "3 of 12"). This has no effect on validation anywhere — an Activity of that type can be added whether the count is under, at, or over target, and Activities can be skipped entirely with no warning.

**FR-P5 — Presets have no effect on bulk import defaulting.** CSV-imported Activities (FR-5) receive no auto-defaulted values — every field is explicit in the row if provided, per the existing bulk-import contract. A Lesson created via bulk import simply has no content plan unless the parent adds one afterward via manual edit. (Since a bulk-imported Lesson arrives with Activities already under it, the recipe — FR-P7, offered only on an empty Lesson — is not available on it either; the two volume paths never collide.)

**FR-P6 — RETIRED** (`TDS_Slice_Lesson_Recipe.md` §3.2). `sequenceNumber` no longer exists, so there is nothing to default. The ordinal a child sees now lives **in the `title`** — "Level 3", "Part 2" — written once by the recipe's title patterns (FR-P7/FR-P8) or typed by the parent on the single-Activity path, where the title field pre-fills a next-ordinal suggestion by counting same-type Activities in the Lesson. The stated cost of counting rather than `max + 1`: deleting Level 2 of 1/2/3 makes the next suggestion "Level 3", not "Level 4". It is an editable prefill on the rare hand-add path, and the alternative is parsing integers back out of titles.

**FR-P7 — Recipe expansion.** Offered on a Lesson's detail view only while it has zero Activities (D4, `TDS_Slice_Lesson_Recipe.md` §5.1) — the same read `hasActivitiesUnderLesson` already makes, so deleting every Activity under a Lesson reopens the recipe. Stage 1 collects an optional page-range split (at most one page-range Activity Type per Lesson, D11) plus any number of count-structured type rows, each generating that many Activities; the submit control shows the live total, recomputed on every input. Stage 2 shows the generated rows — type, pre-filled title (§5.6, resolved against the Course's `titlePatterns` if any), page range where applicable — with titles freely editable and rows freely reorderable; nothing is written at this stage. Generate performs one write: a single Activity per row, `order` contiguous from `0` in the (possibly reordered) Stage 2 order, `id` minted from `Lesson.nextActivitySeq` walked forward once per row and never recomputed as `max(existing) + 1`, and `Lesson.nextActivitySeq` advanced by the row count in the same transaction. A single validation failure (an unresolvable Difficulty Tier, an empty proposal, a title blanked back to empty in Stage 2) writes nothing — no partial Lesson, `nextActivitySeq` unmoved. Every generated Activity's `required` is `true`; the recipe has no per-row required toggle. `createActivity`/`editActivity`/`moveActivity`/`deleteActivity` (FR-4/FR-9) are unaffected and remain the only way to amend a Lesson once it has Activities.

Stage 1 also offers **Copy from lesson** (`TDS_Slice_Lesson_Recipe.md` §5.4) — a dropdown of the other Lessons in this Course that already have Activities. Selecting one seeds Stage 1 from that Lesson's committed Activities: the set of Activity Types, each type's count, and their accepted order (first-appearance order across the source Lesson's Activities, read in `order`) — carrying the order is the point, since it's what makes Stage 2's reordering a one-time cost per Course rather than per Lesson. The page-range type's **hand-typed chunk titles** copy forward as positional defaults, applied in Stage 2 only if the new split ends up with the same chunk count as the source (otherwise they fall back to the pattern default, same as an uncopied chunk) — nothing else about the page range copies, since this Lesson has its own budget. Every other row's title is never copied verbatim; it is regenerated fresh in Stage 2 against *this* Lesson's own title, the same as any non-copied recipe.

**FR-P8 — Per-Course title pattern overrides, and copying Course settings.** The Course create and edit forms carry a disclosure block with one row per Activity Type, each row's placeholder showing that type's built-in title pattern (`TDS_Slice_Lesson_Recipe.md` §5.6) so the parent can see what they'd get before typing. A row left blank stores nothing — the type falls back to its built-in default, and a later change to that default reaches every Course that has not opted out. A non-blank row is validated at save: every `{…}` token must be one of `{lesson}`, `{n}`, `{type}`, `{start}`, `{end}`; `{start}`/`{end}` are rejected on any Activity Type whose `structurePattern` is not `page-range`. Overriding a type takes ownership of it **at every count** — a Course overriding Video's pattern no longer receives the built-in default's count-1 collapse (§5.6). Patterns are read once, at recipe expansion (FR-P7); editing a Course's `titlePatterns` afterward never renames Activities already generated.

The Course create form additionally carries a **"Copy settings from"** dropdown (§5.7) listing existing template Courses. Selecting one pre-fills `curriculumId`, `subject`, `coreElective`, `description`, `defaultPacingHint`, and `titlePatterns` into the form — every value stays editable before save, and this is a one-time pre-fill, not a link: editing the source Course afterward changes nothing on the copy. Never pre-fills `name` (always typed) or `courseCode` (unique, minted or typed per Course), and never touches Lessons, Activities, `id`, `state`, or `sourceTemplateId` — this copies configuration, not structure, so the new Course is created empty and the recipe (FR-P7) remains available on it.

**FR-P9 — The content plan seeds the recipe.** The Lesson's `activityCountTargets[]` (FR-P2) pre-fill Stage 1 of the recipe (FR-P7) rather than being retyped there: each `count`-structured target becomes a count row carrying that count, in target order; a `page-range`-structured target of N becomes the Lesson's single page-range slot with N split points spread evenly across `[pageRangeStart, pageRangeEnd]` in first-page mode (`TDS_Slice_Lesson_Recipe.md` §5.2a). A target of `0`, a target naming an Activity Type that no longer exists, and a second page-range target (D11) each seed nothing. When the Lesson has no page-range budget, or one too small to hold a page per chunk, the type is pre-selected and the split points are left for the parent. Every seeded value is ordinary form state — removable, editable, and overwritten wholesale by "Copy from lesson" — and generating never writes back to the targets. This does not qualify FR-P4: seeding a form is a pre-fill, not enforcement, so a recipe may still generate more, fewer, or entirely different types than the plan called for, and the Content Plan panel reports current-vs-target unchanged.

## 7. Functional requirements

**FR-1 — Create Course (manual only).** The parent creates a Course with `name`, `curriculumId` (selected from Curriculum Library), and `courseCode`. `mainCategory` is fixed to `school` and not parent-facing as a choice. Optional fields per §4.

**FR-2 — Edit / Delete Course.** Any Course field can be edited freely **except `courseCode`, which freezes once any Activity exists beneath the Course** (in any of its Lessons) — see §9. The form disables the field and states why; it never silently discards the change. Delete is unguarded per §2.4 — it proceeds regardless of stamped instances, since instances are independent copies — and **deleting a Course frees its `courseCode` for reuse, which is safe** (its Activities are gone; its Instances carry random tokens).

**FR-3 — Create / Edit / Delete Lesson (manual).** The parent creates a Lesson under an existing Course with `title`, `order`, `lessonCode`, and optionally its content plan (page-range budget and/or count targets, §6). Deleting a Lesson cascades to delete its own Activities (composition) but has no effect on any already-stamped Child Course Instance (§2.4's independence principle applies at every level of this hierarchy). `lessonCode` freezes once any Activity exists under that Lesson, for the same reason and by the same mechanism as FR-2's `courseCode`.

**FR-4 — Create / Edit / Delete Activity (manual, single).** The parent creates an Activity under an existing Lesson with `activityType` (selected from the Activity Type table, Module 12), `title`, `required`, `pageRangeStart`/`pageRangeEnd` where the type is `page-range`-structured (start pre-filled per FR-P3), `difficultyTier` (must resolve to an existing Tier from Module 2), and `order` (system-assigned to the next contiguous position; adjustable afterward only via FR-9). The form carries no `reference`, `blockHint`, or `sequenceNumber` field, and nothing is copied onto the record from the owning Lesson. **Its ID is minted from `Lesson.nextActivitySeq`, never `max(existing) + 1`** (Domain Model §2.5/§2.8). Delete removes the Activity only; no cascading effect beyond its own record, and does **not** free its `seq` for reuse.

**FR-5 — Bulk import Lessons + Activities via CSV.** The parent selects a CSV file. Each row represents one Activity and carries: `courseCode`, `lessonCode`, `lessonTitle`, `lessonOrder`, `activityType`, `title`, `required`, `pageRangeStart`/`pageRangeEnd` (populated for `page-range`-structured types, blank otherwise), `difficultyTier`, and the optional `expectedDurationMin`/`instructions` — twelve columns, in a locked order, validated as a whole-file header gate (`TDS_Slice_M8_Management_App.md` §1). Processing:
- The import view offers a **blank template download** — the locked header row, emitted from the same column list the header gate validates against — so the parent starts from the exact header rather than transcribing it.
- Every row's `courseCode` must match an existing Course; any unmatched code rejects the entire file (§2.1).
- Rows are grouped by `lessonCode`. New Lessons are created for `lessonCode`s not already present under the matched Course; existing Lessons are appended to (new Activities added) if the code already exists.
- Within a `lessonCode` group, `lessonTitle` and `lessonOrder` must be identical across every row — any mismatch rejects the entire file (§2.2).
- The `lessonTitle` column exists for Lesson-consistency validation (§9, "Bulk: Lesson consistency") and to name a Lesson the file creates. It is **not** copied onto the Activity record — `lessonTitle` left that record with the Activity reduction (§4) and is read through `lessonId` wherever it is displayed.
- Every row is validated per §9 before anything is written — including the `courseCode`/`lessonCode` character and reserved-value rules; a violating `lessonCode` rejects the entire file under the same all-or-nothing rule.
- **All-or-nothing:** any single invalid row anywhere in the file rejects the entire import; nothing is written, existing data is untouched.

**FR-6 — Activity Type drives one question: page range or not.** A type whose `structurePattern` is `page-range` (PDF, Reading Pages, Workbook) requires `pageRangeStart`/`pageRangeEnd`; a `count`-structured type requires that both be absent, and asks for no type-specific field of its own — `title` carries what it needs to say, and `instructions` carries the rest. This applies identically whether the Activity is authored manually (FR-4), via bulk import (FR-5), or by recipe expansion (FR-P7) — one validation rule set, three entry paths. A parent-added custom type is validated by its `structurePattern` like any other; the free-text branch that used to single custom types out is gone (§8).

**FR-7 — `difficultyTier` must resolve.** Activities from either entry path require a `difficultyTier` value that matches an existing Tier (Module 2). No "create tier on the fly" path exists — tiers are managed exclusively in Module 2.

**FR-8 — `activityType` must resolve.** Activities from either entry path require an `activityType` value that matches an existing type in the Activity Type table (Module 12). No on-the-fly type creation exists — types are managed exclusively via that module.

**FR-9 — Reorder Activities within a Lesson.** The parent can move an Activity up or down within its Lesson, swapping `order` with its neighbour (the same mechanism as Module 02's tier reorder). **This is the pacing consumption order** (Mgmt SRS 05 §2.4) — without this action, an Activity authored out of sequence could only be fixed by deleting and re-creating it, which permanently burns a `seq`. **Reordering changes `order` only** — never `seq`.

**FR-10 — `capturesGrade` is computed from the type, never stored on the Activity.** No entry path — manual (FR-4), bulk import (FR-5), or recipe (FR-P7) — writes `capturesGrade`. It is derived from the type's `capturePattern` at packet-projection time (`TDS_Slice_Lesson_Recipe.md` §7.2), which is safe precisely *because* Module 12 makes `capturePattern` immutable: a stored copy could never drift, so it was three copies to keep in sync for no gain. **This reverses the earlier rule** (copy-at-creation, stored on the record) rather than qualifying it.

**FR-11 — Bulk-set `expectedDurationMin` by Activity Type.** The Course's detail view carries a
collapsed panel with **one row per Activity Type present beneath that Course** — never the whole
Activity Type table — each row showing that type's current state (`8 Activities · all 20 min`,
`· 20 min · 3 with none`, `· 10, 20, 30 min`, `· no duration set`) and a minutes box. Saving writes
that number onto every Activity of that type in the Course, in one transaction, skipping any
Activity already at the value. **A row left blank is not touched** — the panel saves every row at
once, so blank cannot mean "clear" without letting one Save wipe the types the parent had not
reached yet; removing a type's durations is a confirmed per-row **Clear**, which deletes the key
outright (absent, never `null` or `0`, per §4). Validation is FR-4's rule unchanged: positive whole
number or blank. A single invalid value rejects the whole run, nothing written — the same
all-or-nothing shape as FR-5 and FR-P7.

**This stores nothing on the Course and creates no default or inheritance.** There is no "this
Course says a Quiz is 20 minutes" anywhere in the data — only the Activities that were each written
`20`. An Activity created afterward gets nothing from it; FR-4's form still writes and overrides
the same field on the same record, and every consumer reads the Activity exactly as before.
Durations set on a template flow to a Course stamped afterward only because stamping copies the
Activity row whole (Mgmt SRS 04 FR-4 step 4), not through any link. The panel touches exactly one
field — a bulk save leaves `id`, `order`, `activityType`, `difficultyTier`, `title`, `required`,
the page range and `instructions` byte-identical — and does not appear on a Course with no
Activities. See `TDS_Slice_Course_Duration_Bulk_Edit.md`; the same panel serves an Assigned Course
(Mgmt SRS 04 FR-15).

## 8. Type-specific field reference

**There is one shape, and one question: does this type take a page range?** (`TDS_Slice_Lesson_Recipe.md` §4.1.) The four-branch payload map this section used to carry — structured page range, platform selector `reference`, empty for Practice Level, free text for custom types — collapsed when `reference` and `text` were dropped and `title` took over what they said.

**`page-range`-structured types (Module 12):** PDF, Reading Pages, and Workbook. Each Activity carries top-level `pageRangeStart`/`pageRangeEnd` integers and draws on the Lesson's single page budget (§6/FR-P3). **At most one page-range type per Lesson** (D11) — the budget belongs to the Lesson, and two different books drawing on one range would be meaningless. A parent-added custom type given `structurePattern: page-range` behaves identically, pre-fill included.

**`count`-structured types:** everything else — Video, Practice, Online Sim, Quiz, Test, Report, Project, Drill, and any parent-added type given this structure. They carry **no type-specific field at all**. What the child needs to know is the `title` ("Level 3", "Adding Fractions: Part 2"), optionally expanded by `instructions`.

**Interchange note:** at Packet Generation (Mgmt SRS Module 08) an Activity's projected payload is `{pageRangeStart, pageRangeEnd}` or `{}`, plus the derived `capturesGrade`/`lessonTitle` and any `instructions`. The `kind` discriminator (`pageRange`/`reference`/`none`/`freeText`) belonged to the packet-JSON era and has no reader left.

## 9. Validation rules

| Rule | Detail |
|---|---|
| Course required fields | `name`, `curriculumId` (must reference an existing Curriculum), `courseCode` non-empty, **alphanumeric characters only** (the ID scheme's segments must never contain the delimiter), **never the reserved values `CHR`, `EVT`, or `TPL`** (case-insensitive) — the Chore, Family Event, and template-ID namespaces (Interchange Contract §4). |
| `courseCode` uniqueness | Unique across all Courses with `state: template`, compared as `toLocaleUpperCase()`. Instances are excluded (they inherit the code by copy). On edit, exclude the record being edited. |
| `courseCode` collision on auto-slugify | If slugifying `name` produces an existing code, **reject and require the parent to choose** — no silent auto-suffixing. |
| `courseCode` freeze | Rejected if any Activity exists beneath the Course. |
| Lesson required fields | `title`, `order` (numeric), `lessonCode` non-empty, **alphanumeric characters only**. |
| `lessonCode` uniqueness | Unique within its Course. |
| `lessonCode` freeze | Rejected if any Activity exists under the Lesson. |
| Reserved codes | `courseCode` and `lessonCode` may never be `CHR`, `EVT`, or `TPL` (case-insensitive). |
| Code auto-slugify | Auto-slugified `courseCode`/`lessonCode` (FR-1/§4) strips non-alphanumeric characters rather than passing them through. |
| Lesson optional preset fields | `pageRangeStart` ≤ `pageRangeEnd` if both provided; `targetCount` (per type) must be a non-negative integer if provided. Neither is required. |
| Activity required fields | `activityType` (must resolve to an existing type, Module 12/FR-8), `title`, `required` (bool), `pageRangeStart`/`pageRangeEnd` present and `start ≤ end` for a `page-range` type and absent for a `count` type (§8), `difficultyTier` (must reference an existing Tier). |
| `seq` | Read from `Lesson.nextActivitySeq`, never `max(existing) + 1`. Advanced in the same transaction as the Activity write. **Never reused**, including after a delete. |
| `order` | Contiguous integers from `0`, system-maintained, renumbered on delete. Never parent-typed. |
| Bulk: header | The header row must match the twelve locked columns exactly, in order, before any data row is read (`TDS_Slice_M8` §1/§4.1) ⇒ whole-file reject on any deviation. |
| Bulk: Course match | Every row's `courseCode` must match an existing Course; any miss ⇒ whole-file reject. |
| Bulk: Lesson consistency | All rows sharing a `lessonCode` (within one Course) must have identical `lessonTitle` and `lessonOrder`; any mismatch ⇒ whole-file reject. |
| Bulk: whole-file | Any single invalid row, anywhere, for any reason above ⇒ entire import rejected, nothing written. |
| Tier reference | `difficultyTier` must resolve to an existing row in Module 2's table; no free-text or on-the-fly creation from this module. |
| Activity Type reference | `activityType` must resolve to an existing row in the Activity Type table (Module 12); no free-text or on-the-fly creation from either entry path. Type CRUD, delete-guard, and pattern immutability are now Module 12's validation rules, not this module's. |
| Page-range default | Never validated/enforced against the Lesson's budget — a suggestion only (§6/FR-P3). |
| Count target | Never validated/enforced — display-only (§6/FR-P4). |
| Page range | Required (both, `start ≤ end`, integers) for a `page-range`-structured type; required **absent** for a `count`-structured type. Same rule on all three entry paths — manual, bulk CSV, recipe. |

## 10. Permissions

No *additional* per-action PIN. The Management App requires its own `launchPin` once per session (Domain Model §2.11) — the parent authenticates once at app launch, not per module. This module doesn't add a further gate on top of that.

## 11. Inputs / Outputs

**Inputs:** parent-entered form data (Course/Lesson/Activity manual CRUD; reorder; Lesson content-plan fields); one CSV file for bulk Lesson+Activity import; reads Curriculum Library (for `curriculumId` selection, and for `suggestedActivityTypes[]` when seeding a new Lesson's count-target rows — FR-P9), Module 2's Tier table (for `difficultyTier` validation), and Module 12's Activity Type table (for `activityType` validation and `capturePattern` copy-through) — does not write to any of the three.

**Outputs (written to Management App storage):**
- New, updated, or deleted Course, Lesson, and Activity records (manual paths, FR-1–FR-4, FR-9), including any Lesson content-plan fields (§6).
- New Lessons and Activities, and Activities appended to existing Lessons, from a successful bulk import (all-or-nothing, FR-5).
- No change to Curriculum, Difficulty Tier/Category, Activity Type, Child, or any Child Course Instance data — this module touches the Course/Lesson/Activity hierarchy only. Activity Type CRUD moved to Module 12 (§5).

## 12. Acceptance criteria

1. Creating a Course with `name`, `curriculumId`, and `courseCode` succeeds; the `courseCode` is then usable as a bulk-import join key.
2. Deleting a Course that has been stamped into one or more Child Course Instances succeeds without error, and does not alter or delete those instances.
3. A bulk import file containing one row with an unmatched `courseCode` is rejected in its entirety — no Lessons or Activities from any row in the file are written.
4. A bulk import file where two rows share a `lessonCode` but have different `lessonTitle` values is rejected in its entirety.
5. A bulk import file where all rows are valid creates the correct number of new Lessons and Activities, correctly attached to their matched Course.
6. Re-importing a CSV that adds new Activity rows under an already-existing `lessonCode` (same Course) appends those Activities to the existing Lesson rather than creating a duplicate Lesson.
7. Creating or importing an Activity with a `difficultyTier` value that doesn't match any existing Tier is rejected.
8. Manually adding a single Activity to an existing, previously bulk-imported Lesson succeeds without requiring any CSV re-import.
9. A Lesson with `pageRangeStart: 45`, `pageRangeEnd: 60`, and one existing PDF Activity covering pages 45–47: creating a new Reading Pages Activity under that same Lesson pre-fills its starting page as 48 (the shared budget, gap-filled, crossing type boundaries).
10. If that same Lesson's budget is fully covered by existing Activities up through page 60, creating another page-range-type Activity pre-fills a starting page of 61 — past the original budget, with no warning or block.
11. A Lesson with a Practice Level `targetCount` of 12 and 3 existing Practice Level Activities shows "3 of 12" in its planning view; adding a 4th, or stopping at 3 permanently, both succeed with no warning.
12. A CSV-imported Lesson has no content-plan fields set by default; adding them afterward via manual edit works exactly as it would for a manually-created Lesson.
13. Creating a 4th Video Activity under a Lesson that already has 3 pre-fills a **title** carrying the next ordinal; the parent can overwrite it with anything, including a duplicate, without being blocked. *(Replaces the retired `sequenceNumber` pre-fill check — FR-P6.)*
14. No Activity written by any entry path carries `payload`, `reference`, `text`, `blockHint`, `capturesGrade`, `lessonTitle`, or `sequenceNumber`; a hand-authored, bulk-imported, and recipe-generated Activity of the same type have identical key sets.
15. Creating a second Course template with a `courseCode` differing only in case from an existing one ("saxmath5" vs "SAXMATH5") is rejected.
16. A Course with at least one Activity beneath it cannot have its `courseCode` edited by any UI path; a Course with Lessons but no Activities still can.
17. Creating three Activities in a Lesson, deleting the second, then creating another mints a fourth ID ending `-04` — **not** `-02`. Reloading between each step does not change the result, because the counter is persisted, not recomputed from surviving rows. *(This is the check most likely to fail on a first build: a `max() + 1` implementation passes every other test in this list and fails only this one.)*
18. Reordering an Activity within its Lesson changes its `order` and leaves its `id` and `title` byte-identical.
19. Two Lessons under one Course cannot share a `lessonCode`.
20. A Lesson saved with targets Video 1, Practice 3, Quiz 1 opens the recipe's Stage 1 with those three count rows already carrying those counts — nothing is retyped — and the submit control reads "Propose 5 activities" before any input.
21. A PDF target of 3 on a Lesson budgeted 800–810 opens Stage 1 with PDF selected as the page-range type and `800, 803, 807` in the split box, generating chunks 800–802, 803–806, 807–810 with no gap warning.
22. Removing a seeded row, or changing a seeded count, changes what Generate writes; the Lesson's own `activityCountTargets[]` are unchanged either way, and the Content Plan panel still reports current-vs-target against the original targets.
23. A Lesson with no targets opens Stage 1 with no rows and no page-range type selected.
24. Adding a Lesson under a Course whose `titlePatterns` names Practice, and whose Curriculum suggests Video and Quiz, opens the count-target group with exactly those three rows, counts blank, in Activity Type table order; saving without typing any count stores no `activityCountTargets` at all.
24a. Moving a count-target row with ↑/↓ carries its type selection and its typed count with it; ↑ on the first row and ↓ on the last are disabled. The saved `activityCountTargets[]` is in the on-screen order, the Edit Lesson form reopens in that order, the recipe's Stage 1 seeds in that order (FR-P9), and the generated Activities are stamped `order` 0..N-1 in that order — a page-range target excepted, which becomes the single page-range slot wherever it sat in the list (D11).
25. A type named by neither the Course nor the Curriculum is still selectable from a target row's dropdown, and a Lesson that already has targets shows those targets rather than the suggested rows.
26. A Course holding 8 Quiz and 12 Practice Activities across several Lessons shows exactly two duration rows (FR-11); typing 20 on the Quiz row and saving sets `expectedDurationMin: 20` on all 8 Quizzes and leaves every Practice Activity byte-identical, including the ones that already had a duration of their own.
27. Saving that same panel again immediately reports no changes and writes nothing; leaving a row blank never alters that type, and **Clear** on a row removes the property outright — the reloaded Activities have no `expectedDurationMin` key at all, not `null` and not `0`.
28. A bulk save leaves every other field on the Activities it touches unchanged — an Activity carrying `pageRangeStart`/`pageRangeEnd` and `instructions` keeps both, and its `id`, `order` and `difficultyTier` are byte-identical afterward.

*(AC-9–AC-11 from the prior revision — Activity Type creation, delete-guard, and pattern-immutability checks — moved to Module 12's acceptance criteria; they are no longer this module's to verify.)*
