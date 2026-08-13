# Documentation Roadmap — Schedule Management App

*Load alongside the Domain Model and Architecture Evaluation. All three core documents, and every SRS module, cross-reference each other using consistent section markers.*

---

> ## ⚠️ Superseded in part — read this first (2026-08-11)
>
> **`docs/TDS_Slice_Online_Revamp.md` is the controlling design.** Where this document and
> that one disagree, that one wins, and this banner exists because they disagree in several
> places that a reader would otherwise take at face value.
>
> The 2026-08-10 architectural reversal (CLAUDE.md 2.0) made Cloudflare D1 the system of
> record and deleted the interchange layer entirely. Specifically, in the text below:
>
> | Says | Actually |
> |---|---|
> | "the interchange" / the Packet (Management → Child) | **Repealed.** One shared `assignments` table; the parent writes rows, the child completes them. Revamp §3.3. |
> | The Completion CSV (Child → Management) | **Repealed as transport.** CSV survives only as a report download. Revamp §11. |
> | "Received Packet", per-occurrence chore IDs, `CHR-{token}-{date}` | **Repealed.** IDs are server-minted opaque UUIDs. Revamp §3.3.1. |
> | Reward Ledger "checkpointed snapshot + tail" | **Repealed on both sides** (2026-08-11). `reward_entries` in D1 and `rewardEntries` in IndexedDB are both append-only; balance is a fold, never a stored number, and the N=100 checkpoint is deleted. Revamp §3.4, §8.1. |
> | Packet Import (Child Module 02), Completion CSV Export (Child Module 08), Completion Import (Mgmt Module 09) | **Retired.** Their code is deleted. Revamp §11. |
> | "Export to Drive" | **Abandoned.** It solved a problem that no longer exists. |
> | Principle 3, "no required server" | **Repealed.** Principles 1 and 2 (zero cost) hold. |
>
> What survives unchanged: the Domain Model's language for curriculum, courses, lessons,
> activities, tiers and pacing; the two-app split; Propose/Review/Commit; the pacing engine;
> and every SRS module not named above.
>
> This document is kept for its sequencing history and its module inventory, not as a
> statement of the current architecture. It has not been rewritten line by line because
> doing so would erase the record of what the project used to be — but nothing below should
> be built from without checking the revamp slice first.

---

## 0. Post-revamp milestones (2026-08-11 onward)

§5's M1–M10 describe the build up to the architectural reversal. Work since then is sequenced by
TDS slice rather than by milestone number, and is recorded here so the two schemes do not have to
be reconciled.

**`TDS_Slice_Online_Revamp.md`** — phases 1–5, the reversal itself, plus the §8.2 shim collapse
(phases 1–3), the §12 live-days repeal, the §14 `plannerMeta` fold, and the §8.1 ledger collapse.
**Landed.**

**`TDS_Slice_Child_Feedback_Loop.md`** — five features, phased per its §10. Status as of
2026-08-12:

| Feature | Slice § | Status |
|---|---|---|
| **E** — Date header + the device-local date basis | §7 | ✅ Landed |
| **B** — Course-ordered filtering | §4 | ✅ Landed |
| **A** — Completed view + Undo, incl. the streak reversal | §3 | ✅ Landed (SRS Module 07 gained FR-8/FR-9) |
| **C** — Completion notes | §5 | ✅ Landed, in the two releases §5.5 requires |
| **D** — Assignment messages (one-way) | §6 | 🟡 Backend landed (migration 0005 + three routes); both UIs deferred |

Two of the slice's §11 open items were closed on 2026-08-12, before Feature D began, because both
touch the ground D would build on:

- **§11.4 — manual reorder vs `sequence_no`.** Decided per §4.3's recommendation: the up/down
  arrows are suppressed for any row carrying a parent-authored `sequence_no`, and otherwise scoped
  to block+course peers. Feature B's grouping had made the un-narrowed arrows write a sort key the
  new sort then ignored.
- **§11.7 — per-row containment of D1 errors.** Closed. A database fault inside a device batch
  route is now a per-row `deferred` (keep and retry) rather than a request-level 500 (halt the
  whole drain), distinct from `rejected` (discard). Gated on an `X-Outbox-Protocol: 2` header so an
  older Child App shell still gets the retryable 5xx it knows how to handle.

**Feature D's three decisions** (Module 13 §7, settled in-session 2026-08-12): the body cap is 500
characters, there is no mark-unread in v1, and the build is phased backend-first. Migration 0005
and the three routes have landed; the Child App composer and the Management App inbox are each
their own later release, unsequenced. What remains open is what the child sees after sending
(slice §6.3's "📨 sent" marker), to be confirmed when the composer is built.

Still open and *not* blocking Feature D: §11.1 (subject as a grouping level), §11.2 (two-way
messaging), §11.3 (Undo's PIN gate), §11.5 (retiring the Subjects tab), §11.6 (historical
Completed browsing), §11.8 (verifying the device timezone), §11.9 (midnight rollover while the app
is open). **§11.9 is answered** for the app that cannot avoid it — see the Wall Display slice §5.3;
the Child App item stays open.

**`TDS_Slice_Shared_Chores.md`** — server-arbitrated claims on a shared `claim_group`. **Landed**
(migration 0007). `CLAUDE.md` 2.1 carries its §14 amendment.

**`TDS_Slice_Wall_Display_App.md`** — a third app, `wall-app/`: an always-on tablet showing the
family's events and each child's chore progress, with chore completion behind a per-child PIN.
Design revised 2026-08-13 after review; `CLAUDE.md` 2.2 carries its §16 amendment. **Not started.**

| Phase | Contents | Est. | Status |
|---|---|---|---|
| **0** | The TDS, the `CLAUDE.md` 2.2 amendment, this entry. Ray's sign-off on the three narrowings. | ~30 min | ✅ Done |
| **1 — Worker** | Migration 0009 (`devices.scope`) + registry; `withWall`; the six `/api/wall/*` routes; the `/wall` redirect. No app yet. | ~2.5 h | ⬜ |
| **2** | Shell, `store.js`, admin PIN, first-run wizard, display pairing, Settings. Tiles from the live roster. | ~2 h | ⬜ |
| **3** | `api.js`, `poll.js`, the three pure cores; the ambient screen becomes real — events, counts, Done Today, staleness, rollover, night dim. | ~2.5 h | ⬜ |
| **4a** | PIN pad, session/lockout, the PIN-less tile, the per-child chore list. Read-only. | ~1.5 h | ⬜ |
| **4b** | Completion, earn entries, the retry queue, Undo (both paths), the claim path. | ~2 h | ⬜ |
| **5** | Tests, then the on-device shakedown. | ~2 h | ⬜ |

**Three narrowings signed off in-session, 2026-08-13**, each recorded where it is decided in the
slice: wall writes are online-required with no outbox (§6.4); `child_id` is named in the request on
`/api/wall/*` rather than derived from the token (§8.3); completed chore titles appear on the
ambient screen, narrowing the slice's own §0.4 (§6.7).

**One decision this slice reverses within a day of drafting:** the wall was first designed to hold
one device token per child, paired individually. Ray rejected it — the wall pulls all active
children from D1 instead. Slice §17 logs that and the correctness fixes found in the same review.

**Deliberately not built** (slice §15): server-side earn idempotency, PINs in D1, streaks from the
wall, a genuine "everyone" flag on events, per-child theming, a second display.

**`TDS_Slice_Alexa_Voice_Bridge.md`** — spoken schedule queries and, gated, voice completion.
Drafted 2026-08-13, **not started**, and its Phase 2 remains gated on §6.3's reward-crediting
question. The Wall slice §9 answers part of that (the earn rule is stated once, in Wall §6.2) and
§9.1 now recommends the two share one credential mechanism rather than inventing two.

---

## 1. Recommended documentation order

**A note on the Vision Document:** a standalone Vision Document has never existed apart from this list — its content lives inside the Architecture Evaluation (§2 there). This list drops it from the numbered order below rather than carrying a step that isn't going to be produced separately. The Architecture Evaluation's §2 is the vision statement of record. If a standalone Vision Document is wanted later, that's a fresh decision to make deliberately, not a default to keep deferring.

1. **Domain Model** — covers both apps plus the interchange (**locked**).
2. **Software Requirements Specification (SRS)** — organized by module, per app (**complete** — all 22 modules written).
3. **Technical Design Specification (TDS)** — file structure, IndexedDB schema, packet/CSV formats, ID delimiter, ledger checkpoint cadence, wipe trigger.
4. **Build Roadmap** — milestones, child app and management app sequenced.

The Domain Model defines the *language*; the SRS defines *what it must do*; the TDS defines *how*; the Build Roadmap defines *in what order*.

---

## 2. Domain Model summary (locked)

**Management App domain** — Curriculum (shared, never instanced); Child (person); Course (template → stamped Child Course Instance, no propagation); Lesson (optional Content Planning fields — shared page-range budget, per-type count targets); Activity (references Activity Type and a difficulty tier; ID minted unique at creation; `sequenceNumber` for count-structured types); Activity Type (parent-managed table with two independent patterns — `capturePattern`, `structurePattern`); Chore (standalone, recurring, own difficulty tier); Family Event (standalone, dated, reminder-only); Difficulty Tier & Reward Category (one shared reference table); Pacing Profile (School instances only); Generated Packet (per-child, per-date-range aggregation of paced activities + due chores + in-range events); App Settings (singleton, holds the Management App's own `launchPin` — gates the whole app once per session, independent of the Child App's PIN).

**Child App domain** — Semester (passthrough label, not a lifecycle owner); Child (single, denormalized; carries its own `pin`, the credential for every Child-App PIN-gated action); Received Packet (wider content; pending required work survives the wipe; **imports are additive with refresh-on-pending** — a resend with the same ID refreshes a still-pending item's display fields/due date/tier, and is a full no-op against a resolved item; recurring chores arrive as distinct **per-occurrence** items, each carrying its own deterministic occurrence ID and no `daysOfWeek[]` — recurrence stays a Management-only concept, never evaluated on the child side); Daily Plan (School/Chores/Events/Subjects/Today views; reorder + PIN-gated deferment, any date today or later, no upper bound); Activity (as received); Activity Record (immutable; completed/exported records wiped, pending preserved); Reward Ledger (checkpointed snapshot + tail; earn auto, spend and adjust parent-PIN-gated on device; export writes a write-only recovery note; Settings owns the PIN-gated repair form (balances + streak set)); Streak (live counter; all-required-done qualifies, empty days neutral, device-local date); Reward Definition (priced catalog — **deferred**); Theme/Settings (owns per-category reward display).

**Interchange** — the Packet (Management → Child; activities, chores, display-only events; no spend channel) and the Completion CSV (Child → Management; activity + chore rows on a stable-ID join key; `waived` status reserved; family events never produce rows).

**Locked modeling decisions** (do not revisit without explicit request): Curriculum is shared and never instanced. Course is stamped into an independent child-tagged copy with no live propagation. Activity IDs are unique-at-creation and never copied. Packet Import is additive-with-refresh-on-pending.

---

## 3. SRS — expected modules (per app)

Write one module at a time. **✅ = written.**

**Management App**
- ✅ **Curriculum Library** — author/edit Curricula; `defaultCurriculumType`, soft `suggestedActivityTypes`; reference-guarded delete; name uniqueness.
- ✅ **Difficulty Tier & Reward Category Management** — shared reference table; extensible; fixed mapping; new tier ⇒ new category; reference-guarded delete; seeded with **4 base tiers** (labels/order per TDR, expanded from the original 3). *(Written ahead of Course Template Library because Activity's `difficultyTier` reference needed a real table to validate against — write reference tables before the entities that point at them.)*
- ✅ **Course Template Library** — author/edit Courses under a Curriculum (manual only); `courseCode`; Lessons with `lessonCode` and optional Content Planning fields; Activities with Activity Type + difficulty tier + `sequenceNumber`; bulk CSV import for Lessons/Activities (Course excluded, flat-row shape, all-or-nothing).
- ✅ **Child Management** — add children (two-tier delete guard: hard-blocked while any Course Instance exists, warn-and-confirm-export cascade once none remain); assign Courses (stamp → Child Course Instance, regenerating Activity IDs, `progressCursor` starts absent).
- ✅ **Pacing Configuration** — per Child Course Instance (School only); `daysOfWeek[]` (explicit weekday subset, not a bare count) + `pacingMode` (`activityCount` | `minutesBudget`, exactly one) + mode-specific budget value.
- ✅ **Chore Authoring** — standalone per-child chores; `choreType`, `daysOfWeek[]` recurrence (any non-empty subset of the week, supporting partial-week patterns such as every day but Saturday), difficulty tier.
- ✅ **Family Event Authoring** — standalone dated reminders; single- or multi-child (`childIds[]`); `startDate`/`endDate` (a single-day event sets them equal).
- ✅ **Packet Generation & Export** — per-child, per-date-range aggregation (paced activities + due chores + in-range events), fixed merge order, multi-child event fan-out; export to Drive; advances each contributing Instance's `progressCursor` at generation time (not on child-side import — the one-way interchange makes that impossible); writes one Generation Log row per assigned Activity/Chore occurrence (Domain Model §2.10a), consumed by Master Reporting's Roster.
- ✅ **Completion Import** — deferred build (Phase 4); CSV contract, incl. reserved `waived`, fixed now. Results land in an Imported Completion Record entity (Domain Model §2.12); row-level partial commit (one bad row doesn't reject the file) and idempotent re-import by `activityId` are both specified now, ahead of the Phase 4 build.
- ✅ **Master Reporting** — six CSV report types split across planning data (Curriculum Progress, Activity/Chore Roster) and actual-data (Activity/Chore History, Grades, Attendance, Instructional Hours); the latter four report a genuine zero-row result until the first Completion Import runs.
- ✅ **Settings & Backup** — full JSON backup/restore of the Curriculum/Course library, instances, and pacing (scoped structurally, not as a hardcoded entity list); owns the Management App's `launchPin` set/change flow (Domain Model §2.11).
- 🟡 **Assignment Messages** (Module 13) — *stub only.* The parent-facing inbox for one-way child → parent questions about an assignment: unread-first list, unread badge, explicit mark-read, nothing ever deleted. Added post-revamp by `TDS_Slice_Child_Feedback_Loop.md` §6; see `SRS_Management_Module_13_Assignment_Messages.md` for the contract and its five open items. Not yet built.

**Child App**
- ✅ **Startup Wizard** — child/semester config; theme confirm; PIN setup (`pin` on Child, Domain Model §3.2).
- ✅ **Packet Import** — from Drive; all-or-nothing validation; additive with refresh-on-pending (see §2).
- ✅ **Daily Planner** — reorder, move between blocks; School/Chores/Events/Subjects/Today views. Renders `sequenceNumber` as child-facing display, separate from the Activity title.
- ✅ **Activity & Chore Completion / Logging** — capture per Activity Type (canonical 10-type list, Drill included); mints one reward unit per difficulty tier. Activity Record fields follow the Domain Model naming (`activityId`/`date`); no `actualStart`/`actualFinish`/`durationMin`/`notes` are captured (§2 there); `exported` (defaults `false`, later flipped by Module 8) is part of the record's field list.
- ✅ **Deferment / Waive** — PIN-gated reschedule-or-waive of a required item; streak-rescue mechanism.
- ✅ **Reward Economy (child-facing)** — earn display, derived balance per category, PIN-gated parent spend/deduct. Display is theme-owned (see §5).
- ✅ **Streak** — live counter; qualifying rule; on-open gap catch-up; device-local date.
- ✅ **Completion CSV Export** — with end-of-week reminder; `waived` status carried. Eleven-column set per Domain Model §4, including `sequenceNumber` and the Chore-row `course`/`activityType` convention (`activityType` mapped from the Chore's own `choreType`, `course` left blank).
- ✅ **Wipe** — child-side button, paired with the Completion CSV Export action rather than on the main daily view; manual, targeted; clears completed/exported data; preserves pending required work, ledger snapshot, streak.
- ✅ **Theming** — CSS-variable system; palette + signature themes; per-Reward-Category display with generic-default fallback.
- ✅ **Settings**.

Each module: purpose, user stories, functional requirements, validation rules, permissions, inputs, outputs, acceptance criteria. Keep implementation detail out of the SRS ("let the student reorder today's work," not "use SortableJS").

---

## 4. TDS — what belongs there

- File structure per app is fixed at one file per SRS module (13 files for the Child App, 14 for the Management App — Activity Type's split into its own module and `activityTypes.js` during M5 planning, §8 — per §7 of the Architecture Evaluation) — the TDS fleshes out each file's internal shape, not the file list itself.
- IndexedDB schema — Management (multi-student, template library) and Child (single-child, multi-semester) are **different schemas**.
- Packet format (Management → Child) — exact JSON shape, schema version, three content arrays.
- Completion CSV format (Child → Management) — exact columns (the locked eleven, including `sequenceNumber` and the Chore-row `choreType`-mapped `activityType`), stable-ID join key, reserved `waived` status.
- **Activity ID composition** — segment sources and instance-token generation. The delimiter (`-`, alphanumeric-only segments) is already locked (Interchange Contract §4), not a TDS decision.
- **Reward Ledger checkpointing** — snapshot shape, fold cadence (N entries / on wipe), tail retention.
- **Wipe** — the preserve-pending-work scope's exact storage-level mechanics; the trigger itself (child-side button, paired with Export) and its confirmation-only gating are already fixed.
- **Streak** — on-open gap-catch-up reconciliation against device-local date.
- **Generation Log** — exact storage shape for `{ childId, instanceId?, itemId, assignedDate, generatedAt }` (Domain Model §2.10a).
- **Management App backup file** — `schemaVersion`/shape for Settings & Backup's JSON export (Management SRS Module 11).
- ~~Recovery note filename convention~~ — **locked, not a TDS item.** Packet/Completions/recovery-note filename patterns, all device-local, zero-padded, lexically sortable, are fixed in Interchange Contract §7. The recovery note shares the CSV's exact timestamp stem.
- Data flow diagrams each direction; backup/restore per app; budget-Android performance (child app).

---

## 5. Build Roadmap — sequencing

The **Child App is the critical path** — it's what the kids touch daily and what sells the switch. Build it first to a usable state (even fed by hand-built packets), then build the Management App.

- **M1 — Child app shell:** startup wizard, IndexedDB, packet import (hand-authored packet), daily view with School/Chores/Events.
- **M2 — Child app completion + core data model:** complete/log activities and chores, Activity Records, deferment/waive, Reward Ledger earning (checkpointed) + Streak counter, completion CSV export with end-of-week reminder and recovery-note companion file, manual wipe (preserving pending work + ledger + streak).
- **M3 — Child app theming + reward *display*:** CSS-variable system, 2–3 palette themes, one signature theme, per-Reward-Category display with generic-default fallback. **Reward earning exists from M2, but the child cannot *see* rewards until M3** — treat these as distinct milestones, don't mark the reward feature "done" at M2. Parent-PIN spend/deduct UI lands here too, alongside the PIN-gated repair form (balance adjust + streak set).
### Management App milestones — re-cut

*The original three-milestone cut (M4 shell / M5 pacing+generation / M6 reporting) was set before the Management SRS was written and did not survive it.

*The re-cut below is organized by **what can be verified at each stop**, and drives at the interchange seam as early as the dependency chain allows.*

- **M4 — Management app shell.** `storage.js`, router, and the `launchPin` gate (Module 11, FR-1/FR-2 only); Curriculum Library (Module 01); Difficulty Tier & Reward Category (Module 02). *Exit: a PIN-gated app that opens, holding the two reference tables every later entity validates against.*
- **M5 — Authoring core.** Course Template Library (Module 03) **manual path only** — Activity Types, Courses, Lessons, Activities, authored by hand; Child Management (Module 04), including instance stamping with ID regeneration. *Exit: a course can be authored and stamped to a child.*
- **M6 — Standalone content.** Chore Authoring (Module 06); Family Event Authoring (Module 07). Small, and it comes **before** packet generation deliberately: Module 08's chore-expansion (FR-3) and event-fan-out (FR-4) requirements cannot be written against entities that don't exist yet.
- **M7 — THE SEAM.** Pacing Configuration (Module 05); Packet Generation & Export (Module 08). **Exit criterion, and it is a hard one: a packet generated by this app validates against `packet_schema.json` and imports clean, end to end, into the Child App.** This is the integration checkpoint the whole two-app design rests on. It now lands near the middle of the Management build rather than at the end of it. Do not pass this milestone on a packet that "looks right" — pass it on a packet the other app actually accepted.
- **M8 — Ergonomics & safety.** Bulk CSV import of Lessons + Activities (Module 03, FR-5); Lesson content-planning presets (Module 03, FR-P1–FR-P6); Settings & Backup remainder (Module 11, FR-3–FR-8 — full backup/restore). *These are severable on purpose: bulk import is how the parent enters curriculum **at volume**, not how the pipeline is **proved**. Two hand-authored lessons prove the packet. Deferring these buys the M7 seam checkpoint three milestones earlier at no risk to it.*
- **M9 — Master Reporting** (Module 10) — six CSV report types. The four actual-data reports correctly return zero rows until M10 lands.
- **M10 — Completion Import** (Module 09) — the Completion CSV read back into Management, reconciled by `activityId`. Still the "Phase 4" of Architecture Evaluation §12; contract fixed now, build last.

**Module 03 spans two milestones (M5 and M8) by functional requirement, not by document.** Its manual authoring path is on the critical path to a packet; its bulk-import and content-planning-preset paths are not. See §8 for the open question this raises about the module's size.

Each milestone must produce a working app and must not depend on unfinished features. Under this cut that rule is actually satisfiable, which it was not before.

---

## 6. General guidance for future AI sessions

- Do not redesign the application unless explicitly requested. Treat previous design decisions as requirements.
- Prefer explicit data models over clever abstractions.
- **No live propagation** from Course template to Child Course Instance (Curriculum-level suggestions are the one narrow exception).
- **Activity IDs are minted unique at creation and never copied** — do not "simplify" to a shared or restarting autonumber.
- **Chore occurrence IDs are deterministic** (`CHR-{choreToken}-{YYYYMMDD}`) — never randomized, never parsed for scheduling.
- Keep the two apps' schemas separate; the only shared thing is the interchange contract. **Do not add a spend channel to the interchange** — spends are local to the child device.
- The completion CSV carries a **stable activity ID** and a reserved **`waived`** status — do not drop either to make the CSV prettier.
- The child app has exactly **three** sanctioned bounded-intelligence exceptions (the reward balance fold, streak, local date-edit for deferment) — anything beyond these is scope creep. *(Was "ledger snapshot". The snapshot store is gone as of 2026-08-11 — Revamp §8.1 — but the exception it named survives: the device still folds a balance out of its own ledger entries rather than asking the server for one.)*
- Ledger/Streak recovery is note-plus-repair-form only — never add a machine-readable backup/restore path, and never make any module read the recovery note.
- Keep everything zero-cost and framework-free. Optimize the child app hard for budget Android; the management app can be heavier. *(Amended 2026-08-10: "mostly offline" is repealed — see `TDS_Slice_Online_Revamp.md`. Zero-cost and framework-free stand.)*
- **Standing rule:** any SRS-level decision that changes domain semantics (adds a field, changes a behavior like Packet Import's refresh logic) gets reflected in the Domain Model doc the same session it's decided — not batched into a future leveling pass.
- Evaluate every recommendation against the guardrails in Architecture Evaluation §11.

---

## 7. Core project constraints (never violate)

> **Amended 2026-08-10** by `TDS_Slice_Online_Revamp.md`. Constraints 3, 4, 5, 13 and 14 are
> repealed; 1 and 2 are preserved by staying inside Cloudflare's free tier. The list below
> is the current one.

1. Zero-cost development. 2. Zero-cost maintenance. 3. **No CLI — every operation, including schema migration, is performed from a browser.** 4. Cloudflare Workers + D1, free tier only. 5. **Online-first, offline-tolerant**: the child app opens from cache and queues completions, but the network is the normal path. 6. Browser-based. 7. Child app optimized for budget Android; management app for the parent's capable device. 8. Maintainable by one parent with AI assistance. 9. Curriculum-first design. 10. Student ownership without allowing avoidance of required work. 11. Two-app producer/consumer split. 12. Generation lives on the parent device; the child app never runs the pacing engine (three named exceptions — §6). 13. **D1 is the system of record; both apps' IndexedDB is a cache plus an outbox.** 14. **Parent and child write disjoint column sets on one shared `assignments` table; ownership is enforced server-side.** 15. Theming is an adoption pillar, theme-ready from day one, and owns the reward-category display.

*Repealed for the record:* "No required server", "No required cloud services", "Runs completely offline", "Child app holds only a disposable slice", "Interchange is one-way in each direction; no bidirectional sync".

---

## 8. Open questions (with a decision point, so they stop aging silently)

**Resolved during M5 planning: Course Template Library (Management Module 03) splits into two modules.** It carried **19 functional requirements across three distinct sub-domains** — Activity Type CRUD (FR-A1–A5), Lesson content-planning presets (FR-P1–P6), and Course/Lesson/Activity authoring plus bulk CSV import (FR-1–8) — making it by far the largest module in either app, and its single `courses.js` file was the one place in the codebase that broke guardrail 15 ("understood from one file and one data model") and guardrail 16 ("one module modifiable at a time"). Activity Type was its own Domain Model entity (§2.5a) with its own CRUD and its own immutability rules, sitting inside Module 03 by history, not by design.

**Decision: split.** Activity Type CRUD (FR-A1–A5) left Module 03 and became **Management SRS Module 12 — Activity Type Management**, with its own file, `activityTypes.js` (Management file list: 13 → 14, Architecture Evaluation §7). Course Template Library drops to three entities (Course, Lesson, Activity) and 14 FRs. See SRS Module 12 §0 and TDS_Slice_M5_Management_App_Rev7 for the full accounting; one FR (the `capturesGrade`-copy rule) stayed behind in Module 03, renumbered FR-10, since it's a rule about Activities, not about types.

Everything else raised through the SRS layer has a locked answer in the Domain Model, Architecture Evaluation, or the relevant SRS module. New questions surfaced during TDS work get a row here rather than being decided ad hoc.

**Deferred by decision (not open, do not re-raise without new information):**
- The Reward Definition catalog (priced redeemables) — paper lists until built.
- Archivable-as-template — a diverged Child Course Instance is never promoted back into the library; a parent wanting to reuse an instance's content as a new template re-authors it manually.
- Parent-added custom Activity Type payload — a single generic free-text field ("reference / instructions"), regardless of `structurePattern`; only the 10 canonical types have hand-specified structured payload shapes.
- Manual file selection — a permanent fallback on both sides of the interchange (Packet Import and Packet/Completion CSV export alike), never superseded once Drive integration ships.
- Reward Ledger spend ceiling — hard; a child can never spend past their current balance. No negative/"owed" state exists.

---

*Companion documents: Domain Model, Architecture Evaluation. All SRS modules for both apps are written; the project structure is fixed (Architecture Evaluation §7). Next document in sequence: the Technical Design Specification.*
