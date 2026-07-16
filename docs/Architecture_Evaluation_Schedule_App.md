# Schedule Management App — Architecture Evaluation

---

## 1. Project constraint (highest priority)

> **This project must be designed, built, and maintained at essentially zero cost.**

Both apps must:
- Run completely offline.
- Require no server, no paid hosting, no paid developer.
- Be maintainable by one reasonably technical parent using AI assistance.
- Run by opening `index.html`.

Google Drive is used as a **convenience transport** for moving files between the parent device and the kids' devices. It is not an architectural dependency — the same files could move by USB, cable, or email. Neither app makes a network call to function.

Every architectural decision favors simplicity over sophistication.

---

## 2. Vision

This section is the project's vision statement of record; there is no separate Vision document.

This is not a scheduling application. It is a **Curriculum Execution Engine**, split across two apps:

- The **Management App** authors curriculum, paces it per child, and generates the daily work.
- The **Child App** receives that work, lets the child own their day, records what actually happened, and reports it back.

The schedule is an *output*, not the core data. The core data is curriculum (on the parent side) and completion history (produced on the child side).

---

## 3. Why two apps (the architectural forces)

| Force | Consequence |
|---|---|
| Kids' ~$80 Android phones are weak | Heavy data + the pacing engine must live off their devices. Child app stays tiny and fast. |
| Kids may switch devices / device types (phone ↔ Chromebook) | Authoritative data on the parent device; export formats can be tailored per target platform. |
| A preteen can wipe a device | The authoritative curriculum never lives on a child device. Losing a child device costs at most the current 1–2 week slice, re-pushable. |
| One parent plans for multiple kids | Multi-student planning lives in one Management app on the capable device — never on the constrained child devices. |

The split is a **producer/consumer** pattern: a heavy authoring/planning app on the capable device, a light execution app on the constrained devices.

---

## 4. The two apps at a glance

### Management App (parent device — the heavy one)
- **Curriculum** (publisher/source-level, never instanced, shared across children).
- Course **template library** (authored once, reusable).
- **Child-tagged Course instances** (a template stamped to a specific child; independent copy, IDs regenerated at stamp).
- **Chore** and **Family Event** authoring (standalone, bypass Course/Lesson/Pacing entirely).
- **Difficulty Tier & Reward Category** management (shared reference table).
- **Pacing engine** (per Course instance, School content only).
- **Packet generation** — per-child, per-date-range, as a **Propose → Review → Commit** flow: the parent proposes a set (paced Activities + due Chores + in-range Events), reviews and adjusts it (relocate, exclude, defer, pull forward, drop a chore occurrence), then commits — which writes the Generation Log and exports the Packet to Drive. There is no pacing cursor; the log records what went out.
- **Completion import** (deferred build; the CSV contract is fixed now so it drops in later).
- **Master reporting** — six CSV report types (planning-side: Curriculum Progress, Activity/Chore Roster; actual-data: Activity/Chore History, Grades, Attendance, Instructional Hours).
- Multi-student: all kids visible in one place.
- **App-launch PIN** — a single, session-level PIN gates entry to the whole Management App, independent of and separate from the Child App's own PIN.

### Child App (kid devices — the light one)
- **Startup wizard** (PIN setup, child name, semester label, theme confirm — four steps, no start date; SRS Module 1 is the authority).
- **Packet import** (reads a bounded slice from Drive; additive with refresh-on-pending).
- **Daily planner** — reorder, move between time blocks, filter views (School/Chores/Events/Subjects/Today).
- **Activity & Chore completion & logging** — capture per Activity Type; mints one Reward Ledger unit per difficulty tier.
- **Deferment / Waive** — PIN-gated reschedule-or-waive of a required item.
- **Reward economy (child-facing)** — earn display, derived balance per category, PIN-gated parent spend/deduct.
- **Streak** — live counter, device-local date.
- **Completion CSV export** — with an end-of-week reminder prompt; the child owns the export.
- **Theming** — the adoption pillar (see §11).
- The Child App is **child-scoped, not semester-scoped.** It persists across many semesters on one device; there is no automatic wipe at semester end. Data is cleared only by a **manual, targeted wipe** that clears completed/exported records while preserving still-pending required work, the Reward Ledger snapshot, and the Streak counter. The wipe is triggered by a child-side button, placed alongside the Completion CSV Export action rather than on the main daily view — export and wipe form one small routine the child owns — and requires only a plain confirmation, no PIN.

---

## 5. Data flow (one-way in each direction)

```
MANAGEMENT APP (parent device)
  Curriculum (shared)  ──►  Course Template Library
        │  stamp + child-tag (Course level only)
        ▼
  Child Course Instance  +  Pacing Profile
        │  generate (pacing engine runs HERE, per child per date range,
        │  aggregating paced Activities + due Chores + in-range Events)
        ▼
  Packet  ──────────►  Google Drive  ──────────►  CHILD APP (kid device)
                                                       imports packet (additive, refresh-on-pending)
                                                       child plans / completes / logs / defers
                                                       │
                                                       ▼
                                                   Completion CSV
  Master Records  ◄──────────  Google Drive  ◄─────── (child exports, owns this)
  (spreadsheet now;
   Management import later)
```

- **Curriculum / plans:** parent → child. One direction.
- **Completion records:** child → parent. One direction.
- **No bidirectional live sync.** The completion CSV is a *report the parent collects*, not a database that merges into live state. Eventual Management import reconciles by stable activity ID — still a collect-and-reconcile step, not a live merge.
- **No spend channel in either direction.** Reward Ledger spends are executed locally on the child device; the interchange contract carries no spend content.
- **No Reward Ledger visibility channel either.** The Management App never receives Reward Ledger balances or entries — this is why any Management-side rule (e.g. a delete guard) can only ever be checked against Activity/Chore references, never ledger data (see §13).

---

## 6. Technology stack (both apps)

- HTML, CSS, Vanilla JavaScript, IndexedDB.
- No React, Vue, Angular, TypeScript, npm, Webpack, build pipeline, server, or database server.
- **No PDF generation.** All reporting is CSV/spreadsheet (§9).
- **Packet validator:** The packet validator is a vendored, hand-written JSON-Schema validator utility that reads `packet_schema.json` at runtime. It serves as both validation engine and schema documentation. No external schema library is pulled; the validator code is part of the codebase. When schema fields are added, validation automatically covers them through a single source of truth.
  - **Draft-07 keywords the validator must implement** (the complete set `packet_schema.json` actually uses — an earlier, shorter list in the M1 TDS was incomplete and is superseded): `$ref` / `definitions` (resolution of local `#/definitions/...` pointers), `type`, `properties`, `items`, `required`, `additionalProperties: false`, `enum`, `const`, `pattern`, `minimum`, `minLength`, `oneOf`.
  - **`format` is NOT implemented.** Draft-07 treats it as an annotation, not an assertion. `generatedAt`'s `format: date-time` is therefore checked as `type: string` only. Accepted — nothing in either app parses `generatedAt`.
  - **Three implementation traps, called out because the validator is hand-rolled:** (1) `required` is both a JSON-Schema keyword *and* a property name on `activityEntry`/`choreEntry` — the walker must only read keywords at schema level, never inside a `properties` map. (2) `additionalProperties: false` inside a `oneOf` branch must be evaluated **per branch**, against that branch's own `properties` only — never against a merged parent. (3) **A `oneOf` branch carries no `type` of its own** — a validator that dispatches on `type` will silently pass *every* payload, malformed ones included. Treat any subschema with `properties`/`required` as an object regardless. (`packet_schema.json`'s branches now also state `type: "object"` explicitly, as belt-and-braces; this changes no packet's validity and does not bump `schemaVersion`.)
  - **Relational constraints no keyword can express** run as an explicit second pass after the schema walk. The authoritative list is Interchange Contract §1, Rules.
- **Indexing:** At Module 1 volumes (one packet per child per import cycle), full scans on date and block label are acceptable. No database indexes are required for initial implementation.

The two apps share visual language and utility patterns (the Spelling Star / Math Star family conventions) but are separate deployments with separate IndexedDB schemas.

---

## 7. Project structure (per app)

File structure maps one-to-one to each app's eleven SRS modules — one file per module, plus a router and a storage file shared by necessity (the IndexedDB schema can't be split per-module). Each module file's header comment cites its SRS module by name. There is **no shared `ui.js`**: each module renders its own UI inline, so that fixing or extending one module never risks touching a rendering layer every other module also depends on — the file list is the practical expression of guardrail 16 (AI-friendly, one module at a time). A narrow, pure-function `utils.js` (formatting helpers only, never UI or business logic) may be added at the TDS's discretion if a genuine cross-module need arises.

**Management App (14 files)**
```
index.html
/css   styles.css
/js
    app.js               (router, launchPin gate)
    storage.js           (IndexedDB schema)
    curriculum.js        (Curriculum Library)
    tiers.js             (Difficulty Tier & Reward Category)
    courses.js           (Course Template Library)
    activityTypes.js     (Activity Type Management)
    children.js          (Child Management)
    pacing.js            (Pacing Configuration)
    chores.js            (Chore Authoring)
    events.js            (Family Event Authoring)
    packet.js            (Packet Generation & Export; writes the Generation Log)
    importCompletion.js  (Completion Import — Phase 4 build)
    reports.js           (Master Reporting)
    settings.js          (Settings & Backup)
```

**Child App (13 files)**
```
index.html
/css   styles.css   (+ theme variable sets)
/js
    app.js          (router, init)
    storage.js      (IndexedDB schema)
    wizard.js       (Startup Wizard)
    packetImport.js (Packet Import)
    planner.js      (Daily Planner)
    activity.js     (Activity & Chore Completion / Logging)
    deferment.js    (Deferment / Waive)
    ledger.js       (Reward Economy, child-facing)
    streak.js       (Streak)
    exportCsv.js    (Completion CSV Export)
    wipe.js         (Wipe — paired with exportCsv.js's UI)
    theme.js        (Theming)
    settings.js     (Settings)
```

Each file has one clear responsibility, matching its SRS module one-to-one.

*(Resolved during M5 planning: Activity Type was split out into its own module and `activityTypes.js`. `courses.js` now owns three entities, not four. The Management list is 14 files.)*

**Note the new strain this creates, and that it is accepted:** `children.js` (Module 04) now owns Child CRUD **and** stamping **and** full Lesson/Activity CRUD on instance rows — so `children.js` and `courses.js` both write the `courses`/`lessons`/`activities` stores, partitioned by `state`. This is the first place in either app where two modules write the same stores. It is deliberate (the alternative — one module owning both templates and instances — is worse, since the two have genuinely different rules) but it should be named, not discovered.

---

## 8. Data philosophy

Prefer simple, explicit data over clever code.

**Management hierarchy:**
```
Curriculum (shared, never instanced)
      │ referenced by
      ▼
Course Template (library, authored once)
      │ stamp + tag (regenerates Activity IDs)
      ▼
Child Course Instance  (independent copy, e.g. "SAXMATH5" stamped for Nora)
      ▼
Lesson → Activity (+ Chore, Family Event — standalone, bypass this chain)
      │ pace
      ▼
Generated Packet (per child, per date range — aggregates Activities + Chores + Events)
```

**Child hierarchy:**
```
Child (single, denormalized device owner)
      │
Received Packet(s)  (dated content; Semester rides along only as a passthrough label)
      ▼
Daily Plan → Activity / Chore (as received) + Family Event (display-only)
      ▼
Activity Record (immutable completion history — survives until a manual, targeted wipe)

Permanent, wipe-exempt: Reward Ledger snapshot, Streak counter, still-pending required work.
```

The template → instance relationship is **copy-at-assignment with no propagation** at the Course level (Curriculum-level suggestions are the one narrow exception — see §11). Avoid hidden workflow engines. Recurring chores arrive fully expanded — one dated item per occurrence, each with its own ID — so the Child App never runs a recurrence evaluator (guardrail 19).

---

## 9. Reporting & export (CSV only, no PDF)

### Completion CSV (Child App — primary output)
- One row per Activity Record; completed Chores use the same row shape and join-key convention. **Family Events never produce rows.**
- Columns (locked): `activityId, date, course, activity, activityType, plannedBlock, status, grade, childName, semesterLabel, sequenceNumber`. `actualStart`, `actualFinish`, `durationMin`, and `notes` are not columns: no capture mechanism exists anywhere in the Child App SRS for any of the four, and none is required by a user story.
- `activityId` present from v1 as the reconciliation join key, even before an importer reads it. `status` reserves a `waived` value for deliberately-skipped required items. `sequenceNumber` is copied straight from the child device's Activity-as-received data — no new capture mechanism, just one more field carried into the row — and is blank for page-range types and Chore rows, where it doesn't apply.
- Excel/Google Sheets friendly (UTF-8, RFC 4180). Doubles as the parent's spreadsheet dashboard *and* the future import source.
- Exported by the child on a cadence (end of week), with a reminder prompt. The parent backstops it.
- **Chore rows and the `course`/`activityType` columns:** a Chore has no `course` and no `activityType` of its own (§2.6 in the Domain Model). `activityType` is mapped from the Chore's own `choreType` (a value from its canonical enum — Domain Model §2.6 / Interchange Contract §1b) rather than a generic placeholder — the column stays genuinely informative instead of a constant dead value. `course` is left blank, the same treatment already given to other not-applicable columns (`grade`, `plannedBlock`). The columns themselves are never dropped for chore rows, since dropping columns per-row would break the CSV's fixed-width contract.

### Master Reports (Management App)
- Six CSV report types, split across planning data (Curriculum Progress, Activity/Chore Roster) and actual-data (Activity/Chore History, Grades, Attendance, Instructional Hours).
- Both planning-side reports read the **Generation Log** (Domain Model §2.10a) and are available the moment Packet Generation has committed once, without needing an import: Curriculum Progress from the count of `sent` rows per Instance, Roster from the per-decision rows recording which Activity/Chore occurrences were sent to a child on which dates. There is no pacing cursor.
- The four actual-data report types depend on Imported Completion Records and return a genuinely empty (zero-row, correctly-headed) result until the first successful Completion Import — not an error, an accurate answer given the data that exists.
- Once completion import ships, these consolidate every child's completion data. Until then, the parent consolidates in a spreadsheet from the collected child CSVs.

### Backup (Management App)
- Full JSON backup/restore, scoped structurally as everything in Management App storage except the App Settings record (`launchPin` stays device-local and is never included). This automatically covers the Curriculum/Course library, instances, pacing, and any future entity — including the Generation Log — without this document needing to enumerate them by name.
- Restore is a full, wholesale replace, never a merge, safeguarded by an automatic pre-restore snapshot and an explicit confirmation — no second PIN.

**No PDF anywhere.** Every report is a spreadsheet.

---

## 10. Theming and the reward economy (adoption pillar — child app)

### Theme structure
A theme is **three cheap parts + one optional expensive part**:
- **Palette** — CSS custom-property swap; semantic variable names stay constant, values change.
- **Emoji/icon set** — functional icons reskinned to the theme's world.
- **Copy pack** — encouragement lines, button labels, activity framing.
- **Signature reward visual** (optional) — e.g. completed work "builds" a structure block by block. Budget per theme; must be tested on the cheap device.

**Two tiers:** Palette themes (as many as wanted — cheap) and Signature themes (one or two the kids actually pick, with the custom reward visual).

### Licensed-IP guardrail
No copyrighted assets, characters, or logos. Beloved franchises are captured as *aesthetic-adjacent* themes built from non-ownable elements (e.g. Minecraft → blocky-builder; Pokémon → creature-collector). A future build session must not "helpfully" reintroduce real IP assets.

### Reliability rules
Plain DOM/CSS over canvas; no repaint-costly decorative animation; generous touch targets (~44px).

### Theme's role regarding the Reward Ledger
Each theme supplies a **display skin per Reward Category** — name and icon — layered over the neutral, kid-invisible internal category ID the Ledger stores and sums. A category with no theme-specific art yet falls back to a **generic default visual**, never a blank or broken render. This is required from the first theme forward, not a later polish pass.

A theme may ship reward-category art keyed **only** to `R01`, `R02`, `R03`, and `R04` — the four seeded, install-invariant categories: Easy, Medium, Hard, Very Hard (`TDS_Slice_M4` §1, as amended at M5). Every other `categoryId` renders the generic default, **always**. Parent-added categories are sequential (`R05`, `R06`, …) and therefore perfectly predictable — but a given number means a *different tier on every family's device*: one family's `R05` is "Brutal," another's is "Trivial." Art keyed to one would render correctly on one install and nonsensically on the next. The fallback is safe because this rule says so, not because the ID scheme prevents it.

**The seeded/parent-added line is the whole rule, and it is the only reason to seed a tier rather than let a parent add one.** "Very Hard" was previously the textbook example of an ID a theme must *never* key art to — it now sits at `R04` on every install precisely so that it can be. Any future tier that themes must be able to render has to be **seeded**, not merely addable; if it is added by the parent, it is unthemeable, permanently, and no amount of care in the theme fixes that.

### The reward economy is a deliberate exception to "no new tracked counter"
The project's general preference for simplicity (§1) argues against adding new persistent, tracked counters where existing data can be derived instead. That preference does not extend to the Reward Ledger and Streak — both are genuinely new, persistent counters. This is accepted and explicit, justified as follows:
- **Reward Ledger:** checkpointed — a small per-category balance **snapshot** that survives the wipe, plus a **recent tail** that folds into the snapshot on a cadence and is then dropped. Bounded storage regardless of how long the device is used. Earn is a flat **1 per completion**; spend is a **parent-PIN-gated action on the child device** — no child-side spend, no interchange channel. A priced-redeemable catalog (Reward Definition) is deferred, covered by paper lists until built.
- **Streak:** a single integer plus a date, live-counted (not derived retroactively), reconciled on each app open against elapsed time.
- **Survival:** ledger and streak live only in child-device browser storage, so three cheap layers cover loss: persistent-storage request at setup (best-effort), a write-only human-readable recovery note bundled into the weekly Completion CSV export tap, and a parent-PIN-gated repair form for restoring or correcting values. No machine restore exists and no app ever reads the note — recovery is a parent reading a file and keying numbers into a PIN-gated form, proportionate to a reward toy.
- **Accepted architectural cost:** the Ledger's checkpointing introduces a snapshot a bug could bake a wrong balance into permanently — pure-derive-from-full-history is self-correcting, this isn't. Accepted in exchange for bounded storage; mitigated by an auditable raw tail, deterministic folding, and a parent-PIN-gated `adjust` correction path (Settings) — the sanctioned remedy when a wrong balance does get baked in.
- The completion-count reward visual (activities done this week, days streaked) still exists alongside the Ledger display — two separate things the child sees, never conflated.

### Access
Theme selection lives in the child app's light settings, no PIN gate, and no per-kid restriction — all themes are open to every child.

---

## 11. Design guardrails (evaluate every future feature against these)

1. **Zero cost.** No hosting, subscriptions, paid services, required cloud.
2. **Two-app split.** Management authors/generates; child consumes/reports. Don't collapse them.
3. **Generation on the parent device.** The child app never runs the pacing engine (three named exceptions — guardrail 19).
4. **Child app stays light** — Received Packet contents and Activity Records remain a bounded, wipeable slice. **Explicit exceptions:** still-pending required activities (future work, must survive the wipe), the Reward Ledger snapshot, and the Streak counter (bounded via checkpointing, not because they're "small").
5. **Authoritative data never on a child device.** Losing a child device costs one slice.
6. **One-way interchange each direction.** No bidirectional live sync. No spend channel. **No ledger-visibility channel either** — the Management App structurally cannot see Reward Ledger data, which is why any Management-side rule can only be checked against Activity/Chore references (§5, §13).
7. **Course template → instance is copy-with-no-propagation.** Curriculum-level suggestions are the one narrow, justified exception (§8). Do not add propagation to "fix" the rest.
8. **Stable activity ID in the completion CSV from v1.** The join key for future import. Never drop it, or the reserved `waived` status.
9. **Curriculum-first.** Enter curriculum once per template; reuse by stamping.
10. **Student ownership.** Kids choose *when*, not *whether*. Required work can't be removed on the child side — it can be rescheduled or waived through the sanctioned deferment mechanism only.
11. **Flexible views.** School/Chores/Events/Subjects/Today are filtered views of the same child-app data.
12. **Individual activity/chore tracking.** Every item independently completable and logged; history immutable.
13. **Time & grade capture** whenever applicable, per Activity Type's capture pattern.
14. **CSV-only reporting.** No PDF.
15. **Simplicity first.** If a feature can't be understood from one file and one data model, it's probably too complex.
16. **AI-friendly codebase.** One module modifiable at a time without understanding the whole app.
17. **Theming is an adoption pillar**, theme-ready from day one, and owns the reward-category display.
18. **Suggested Activity Types are always soft**, never an enforced whitelist, even for a currently-fixed offering.
19. **The child app's bounded-intelligence exceptions are named and closed.** Exactly three: the Reward Ledger snapshot, the Streak live counter, and the local Daily-Plan date-edit performed by deferment/reschedule. None runs the pacing engine; none holds curriculum-library-scale data. New child-side "intelligence" beyond these three is scope creep and must be challenged.

### The one honest tradeoff (documented so it isn't "fixed" later)
Independent Course template→instance copies mean **no propagation**. Author a course, stamp it to two kids, then find a mistake in the source, and you have three copies to fix (template + two instances). For this use case that's the *right* price — you almost never want a silent edit rewriting a course a child is mid-way through. A future session must not add live template-to-instance sync to "solve" this.

---

## 12. Development strategy

**Critical path is the Child App** — it's what the kids touch daily and what sells the switch.

- **Phase 1 — Child App core:** startup wizard, IndexedDB, packet import (hand-authored packet at first), daily view, completion + logging (Activities and Chores), Activity Records, deferment/waive, Reward Ledger earning + Streak counter, completion CSV export, end-of-week reminder, manual targeted wipe.
- **Phase 2 — Child App polish + theming:** reorder/move between blocks, filter views, per-Activity-Type grade capture, CSS-variable theme system, 2–3 palette themes, one signature theme, budget-device optimization, per-Reward-Category display with generic-default fallback, parent-PIN spend/deduct UI.
- **Phase 3 — Management App:** Curriculum library, Course template library, child management, instance stamping (ID regeneration), Chore + Family Event authoring, Difficulty Tier/Reward Category management, pacing engine, packet generation + Drive export, master CSV reporting, curriculum JSON backup/restore. **Phase 3 is cut into milestones M4–M9** (Roadmap §5) — the phase is the coarse grouping, the milestones are what a build session actually works against. The `launchPin` gate (Settings & Backup FR-1/FR-2) lands first, in M4, because `app.js` gates the whole app behind it.
- **Phase 4 — Consolidation:** Completion CSV import back into the Management app (reconcile by stable ID), consolidated master reports. **= milestone M10.**

**The seam checkpoint (milestone M7).** Packet Generation's exit criterion is a packet that the *Child App actually imported*, not a packet that validates by eye. Under the split-account build this is a two-session event and it is the highest-risk moment in the project — which is why the Roadmap's milestone re-cut pulls it to the middle of the Management build rather than the end. Nothing authored before it has been verified by anything.

Each phase functions without depending on future phases. The child app is usable (fed by hand-built packets) before the management app exists.

**Sequencing note:** the reward economy's *data model* is Phase 1–2 core, but its only *child-visible representation* is theme-owned. The earning engine can be built and correct in Phase 1–2, but the child cannot *see* their rewards until the theming milestone (Phase 2) lands. Treat "reward earning works" and "reward feature is visible to the kid" as distinct milestones — don't mark the reward feature done before theming exists.

---

## 13. Resolved vs. open

**Resolved, locked (do not re-litigate without new information):**
- Two-app producer/consumer split; generation on the parent device; child app is dumb (three named exceptions — guardrail 19).
- Multi-student in the Management app only.
- Course template → child-tagged independent instance, no propagation (Curriculum-level exempt).
- One-way interchange each direction; no spend channel; no ledger-visibility channel.
- CSV-only reporting; no PDF.
- Theming as an adoption pillar with the licensed-IP guardrail.
- Child owns the completion export (with reminder).
- Stable activity ID in the CSV from v1; `waived` status reserved.
- Archival: Management keeps curriculum as a reusable template; Child App is child-scoped with a manual, targeted wipe.
- Curriculum is a permanent, never-instanced top-level entity above Course.
- Chore and Family Event bypass Course/Lesson/Pacing entirely.
- Difficulty Tier / Reward Category is one shared reference table; extensible; mapping fixed once created; new tier always paired with new category; categories never convert.
- Reward earn magnitude — flat 1 per completion.
- Reward spend path — parent-PIN-gated, child-device-local, no interchange channel.
- Reward Ledger storage — snapshot + tail checkpointing.
- Stable Activity ID scheme — readable composite, unique at creation, never copied.
- Streak definition — all-required-done qualifies, empty days neutral, device-local date, on-open gap catch-up.
- Deferment/waive — PIN-gated child-side reschedule-or-waive.
- `timeZone` cut.
- Activity Type → capture-field matrix — resolved as an ongoing, parent-extensible mechanism (not a one-time enumeration).
- Bulk spreadsheet import shape — flat rows, Course excluded and authored manually, `courseCode`/`lessonCode` join keys, all-or-nothing validation.
- Completion CSV column set (§9), eleven columns, consistent with Domain Model §4.2 and SRS Module 8. Chore rows' `activityType` maps from `choreType`; `course` is blank.
- **`actualStart`, `actualFinish`, `durationMin`, `notes` — excluded from the Activity Record and Completion CSV (§9).** No capture mechanism exists anywhere in the Child App SRS for any of the four, and none is required by a user story. (See Domain Model §3.6/§4.2, Roadmap §8.)
- **`gradeLabel` — excluded from the Child App** (Startup Wizard, Semester, Child). The Management App's separate `Child.gradeLabel` field (parent record-keeping) is unaffected. (See Domain Model §3.1/§3.2, Roadmap §8.)
- **Per-kid theme gating — full child choice, no gating, ever (§10).** (See Domain Model §3.9, Roadmap §8.)
- **Difficulty Tier delete-guard — checks Activity/Chore references only, not Reward Ledger data**, consistent with §5 and guardrail 6 in §11 (the Management App has no visibility into Child-side ledger entries under the one-way interchange design). (See Domain Model §6, Roadmap §8.)
- **Activity Record `status` value is spelled `complete`, not `completed`.**
- **Deferment/Waive's Reschedule range — any device-local date today or later, no upper bound.**
- **Two independent PINs — Child App `pin` (per-action gate) and Management App `launchPin` (whole-app, once per session, §4).** The Child App PIN gates deferment/waive, reward spend (Modules 5/6), and Settings entry (Module 11).
- **`exported` (boolean) — required Activity Record field (Domain Model §3.6).** Load-bearing for the wipe's double gate (§9/§12).
- **`incomplete`/`excused` — excluded from the Activity Record `status` enum (Domain Model §3.6).** No producer anywhere in the SRS. Status is `complete` | `waived`.
- **Deferment/Waive scope — Activity or Chore alike (Domain Model §3.6b).**
- **Archivable-as-template — a diverged Child Course Instance is never promoted back into the library.** A parent wanting to reuse an instance's content as a new template re-authors it manually.
- **Wipe trigger — a child-side button, paired with the Completion CSV Export action (§4), not a packet-carried flag.** No PIN; a plain confirmation is sufficient, since the double gate (only resolved-and-exported records clear) already bounds the risk.
- **Parent-added custom Activity Type payload — a single generic free-text field ("reference / instructions"), regardless of `structurePattern`.** Only the 10 canonical types carry hand-specified structured payload shapes.
- **`sequenceNumber` is a Completion CSV column** (§9) — carried directly rather than left to a later lookup that could fail if the source Instance is deleted.
- **Project structure is fixed at one file per SRS module, no shared `ui.js`** (§7).
- **Manual file selection is a permanent fallback on both sides of the interchange**, never superseded once Drive integration ships — required by §1's own promise that neither app depends on a network call to function.
- **Reward Ledger spend ceiling is hard** — a child can never spend past their current balance; no negative/"owed" balance state exists.
- **Generation Log — one row per decision, keyed `(childId, itemId)`, `{ childId, instanceId?, itemId, assignedDate, disposition (sent|dropped), generatedAt }`, written only at Commit by Packet Generation** (Domain Model §2.10a). Both Master Reporting's Roster source and the generator's own completeness record (there is no pacing cursor); covered automatically by Settings & Backup's structural backup scope.
- **Family Event wipe rule — clears once its date is strictly before device-local today** (§9/§12); one dated today or later always survives.
- **Chore occurrence identity — per-occurrence IDs `CHR-{choreToken}-{YYYYMMDD}`, minted deterministically at generation; `daysOfWeek[]` never travels in the Packet; the ID's date segment is never parsed for scheduling.**
- **Ledger/Streak survival — three layers: `storage.persist()` requested at wizard completion (best-effort, residual eviction risk accepted); a write-only, human-readable recovery note written by the Completion CSV export action; a parent-PIN-gated repair form in Settings (`adjust` tail entries for balances; streak set writes `currentStreak` + `lastQualifyingDate`). No machine restore; no module ever reads the note; nothing crosses the interchange.**
- **Recovery-note fold logic is duplicated between Module 6 and Module 8, by acceptance (Domain Model §5.10), not oversight.**
- **Module 7 (Streak) FR-7/Permissions/AC-6 name the Settings repair form as the sole manual exception to "no manual control."**
- **Daily Plan ordering — block outer, category nested, position innermost** (Domain Model §3.4, Child SRS Module 3 FR-1). Blocks in fixed order `morning`/`afternoon`/`evening`/`night`; School-then-Chores inside each block; sort position innermost. Absent or out-of-set `blockHint` displays under `morning`. The Packet's own array merge order (School → Chores → Events) is unchanged and becomes the default within-group order.
- **Daily Plan is a derived view, not a stored entity** (Domain Model §3.4). No `dailyPlan` store, no `blocks[]`; the only child-authored per-item state is `{ sortOrder, blockHint, deferredDate }`.
- **Child-side overrides survive re-import** (Interchange Contract §1d) — a refresh-on-pending rewrites received fields but never the child's block override and never a deferred due date. A re-import cannot un-defer an item.
- **`childId`/`childName` are passthrough on the child side** — not stored, not validated, never a gate on import (Interchange Contract §1).

**Open (resolve in TDS):** completion-import reconciliation's exact storage-level indexing (the reconciliation mechanism itself is fully specified in Management SRS Module 09); Reward Ledger checkpoint cadence and tail retention; the Management App backup file's exact `schemaVersion` shape.

**Resolved, no longer open:** the Activity ID delimiter is locked to `-` (hyphen-minus), every segment alphanumeric-only; Family Event ID format is `EVT-{eventToken}`; Packet `schemaVersion` is an integer, current value `1`; Packet/Completions/recovery-note filename conventions are fixed. All four are specified in the Interchange Contract (§4, §7) and Domain Model §2.5/§2.7/§4.1, not deferred to the TDS.

**Deferred by decision, not open:** the Reward Definition catalog — priced redeemables per category; paper lists cover it until built.

---

*Load alongside the Documentation Roadmap and Domain Model. All SRS modules for both apps are written. Next document in sequence: the Technical Design Specification.*
