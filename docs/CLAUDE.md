# CLAUDE.md – Build Session Guardrails

**Version:** 1.0  
**Project:** Homeschool Curriculum & Chore Scheduling System  
**Last Updated:** 2026-07-13  

---

## Purpose

This document defines hard constraints, verification rituals, and decision gates that apply to **every Claude Code build session** on this project. It is read-only guidance enforced **before any code is written or edited**. You are the designer for the Child App.

---

## I. Scope Enforcement

### A. App-Level Isolation (MANDATORY)

The project consists of **two separate applications** with a defined interchange contract:

| Aspect | Child App | Management App |
|--------|-----------|-----------------|
| **Folder** | `child-app/` | `management-app/` |
| **Scope** | Modules 1–11 (Child UI) | Modules 01–11 (Parent/admin UI) |
| **Runtime Code Sharing** | **FORBIDDEN** | **FORBIDDEN** |
| **Shared Resources** | `Interchange_Contract.md`, `fixtures/` (read-only) | Interchange Contract, `fixtures/` (read-only) |
| **Data Flow** | ← Packet (JSON) ← | → Completion CSV → |

**Enforcement:**
- A Claude Code session **must declare which app it is building** at the start.
- Any file edit or create operation **outside the declared app folder** is an error; halt and escalate to Ray.
- The `fixtures/` and interchange docs are **read-only reference only**; never edit them from a build session.

### B. Repository Structure (LOCKED)

```
/
├── README.md (orientation)
├── Interchange_Contract.md (master reference)
├── Split_Build_Session_Guide.md (meta-workflow)
├── CLAUDE.md (this file)
│
├── fixtures/
│   ├── packet_sample.json
│   ├── packet_schema.json
│   ├── completions_sample.csv
│   └── TestData_M2_Child_App.md
│
├── child-app/
│   ├── index.html (or homeschool-child-app.html for M1)
│   ├── js/
│   │   ├── startup.js (Module 1 – Startup Wizard)
│   │   ├── packet-import.js (Module 2 – Packet Import)
│   │   ├── daily-planner.js (Module 3 – Daily Planner)
│   │   ├── completion.js (Module 4 – Activity/Chore Completion)
│   │   ├── deferment.js (Module 5 – Deferment/Waive)
│   │   ├── rewards.js (Module 6 – Reward Ledger)
│   │   ├── streak.js (Module 7 – Streak)
│   │   ├── export.js (Module 8 – CSV Export)
│   │   ├── wipe.js (Module 9 – Wipe)
│   │   ├── theming.js (Module 10 – Theming)
│   │   ├── settings.js (Module 11 – Settings)
│   │   └── idb-schema.js (IndexedDB store definitions)
│   └── styles/
│       └── styles.css
│
├── management-app/
│   ├── index.html
│   ├── js/
│   │   ├── curriculum-lib.js (Module 01)
│   │   ├── difficulty-tier.js (Module 02)
│   │   ├── course-template.js (Module 03)
│   │   ├── child-mgmt.js (Module 04)
│   │   ├── pacing-config.js (Module 05)
│   │   ├── chore-auth.js (Module 06)
│   │   ├── event-auth.js (Module 07)
│   │   ├── packet-gen.js (Module 08)
│   │   ├── completion-import.js (Module 09)
│   │   ├── reporting.js (Module 10)
│   │   ├── settings-backup.js (Module 11)
│   │   └── idb-schema.js (IndexedDB store definitions)
│   └── styles/
│       └── styles.css
│
└── docs/ (optional, stores prior TDS/SRS for reference)
    ├── TDS_Slice_M1_Child_App.md
    ├── TDS_Slice_M2_Child_App.md
    └── ... (SRS modules, Domain Model, etc.)
```

Do **not** deviate from this structure without explicit Ray approval.

---

## II. Documentation-First Gate

### BEFORE any code is written, verify:

1. **TDS Slice for the target milestone exists** and is in `/docs/`:
   - Defines schema shapes (tables, store layout, JSON structure)
   - Locks all state machine transitions and mechanic decisions
   - Flags open vs. decided items explicitly
   - **Missing TDS = HALT; escalate to Ray for TDS authoring**

2. **SRS modules for all affected Modules are current**:
   - For Child App M2 (Modules 4–9): `SRS_Module_04.md` through `SRS_Module_09.md` must match the TDS slice.
   - For Management App: Check `SRS_Management_Module_0X.md` for all modules being built.
   - **Mismatch = HALT; run audit (§ IV.A) before proceeding**

3. **Interchange Contract is consistent** with schema:
   - Packet schema in `packet_schema.json` matches TDS "Packet Structure" section.
   - Completion CSV layout in `Interchange_Contract.md` matches TDS "Completion CSV" section.
   - **Mismatch = HALT; escalate reconciliation (§ III.C)**

---

## III. Key Architectural Constraints (LOAD-BEARING)

These constraints are **not negotiable**. Violating them will break the system.

### A. IndexedDB & Offline-First

- **No network calls** during normal app operation (except GitHub Pages asset load and optional later Google Drive integration).
- **IndexedDB is the source of truth** for all state; volatile state only in memory.
- **Schema is defined in `idb-schema.js`** per app. Each build session must:
  1. Read the current TDS slice to extract store definitions.
  2. Verify `idb-schema.js` reflects the TDS slice exactly.
  3. If `idb-schema.js` is out-of-date, update it *before* writing any feature code.

**Validation:**
```bash
node validate-idb-schema.js --app child|management --tds ./docs/TDS_Slice_*.md
```

### B. Child App: Per-Occurrence Chore Identity

From the M1/M2 design decisions:

- **Chores DO NOT have a single definition-level ID** in the packet.
- **Each chore instance is identified deterministically**: `CHR-{choreToken}-{YYYYMMDD}` at the child app level.
- The packet contains chores **pre-expanded by date**, with a `date` field (ISO 8601 string).
- **`daysOfWeek[]` does NOT appear in the packet**; expansion happens in the management app before export.
- **Reserved prefix validation is load-bearing**: No `courseCode` may be literally `CHR` or `EVT`.

**Validation:**
```bash
node validate-packet-schema.js --packet ./fixtures/packet_sample.json
# Must confirm no courseCode is "CHR" or "EVT"
```

### C. Packet & Completion CSV Interchange

- **Packet (Management → Child)**: JSON, downloaded or imported by child app via Module 2.
  - Structure is defined in `packet_schema.json` and locked in the TDS slice.
  - Child app **never edits or transforms the packet**; it loads it as-is into IndexedDB.
  
- **Completion CSV (Child → Management)**: Tab-separated, exported by Module 8.
  - One row per completed activity/chore, with columns: `completionID`, `itemID`, `date`, `completedAt`, `earnedReward`, `notes`.
  - Management app imports this via Module 09 and reconciles against its database.

**Validation:**
```bash
node validate-interchange.js --packet ./fixtures/packet_sample.json --csv ./fixtures/completions_sample.csv
```

### D. Reward Ledger Fold Cadence (N=100)

- **M2 decision (locked, per `TDS_Slice_M2_Child_App.md` §4 — corrected 2026-07-13, was previously misstated here as N=25)**: after every `rewardLedgerTail` append, count that category's tail entries (`rewardLedgerTail`, scoped by `categoryId`); on reaching 100, fold immediately — sum into `rewardLedgerSnapshot`, then delete the folded tail rows for that category.
- **Do not allow this to drift** in later modules; it is part of the user's mental model.

### E. `plannerMeta` Keyed by Item ID, Not Date

From M1 design (per `TDS_Slice_M1_Child_App.md` §4 — corrected 2026-07-13, field names were previously misstated here):

- `plannerMeta` is a store keyed by **item ID** (`id`, matching an `activities`/`chores` record's own `id`), not by date.
- Shape: `{ id, sortOrder?, blockHint?, deferredDate? }` — every field but `id` is optional, written only when the child actually acts; an untouched item has no `plannerMeta` record at all.
- `sortOrder`/`blockHint` are written by Module 3 (Daily Planner); `deferredDate` is written by Module 5 (Deferment/Waive, M2) — the store is defined at M1 so no version bump is needed when Module 5 lands.
- **Benefit**: Reschedule sort-order and block continuity for free.
- **Do not deviate** (e.g., no per-date plannerMeta).

---

## IV. Verification & Audit Rituals

### A. Pre-Build Audit Checklist

Before writing code, run these checks. **If any fail, halt and escalate to Ray.**

```bash
# 1. Confirm TDS slice exists
[ -f docs/TDS_Slice_M*.md ] && echo "✓ TDS slice found" || echo "✗ HALT: No TDS slice"

# 2. Confirm SRS modules are up-to-date
# For Child App M2, check SRS_Module_04 through 09
for i in 04 05 06 07 08 09; do
  [ -f docs/SRS_Module_${i}_*.md ] && echo "✓ SRS_Module_${i} found" || echo "✗ SRS_Module_${i} missing"
done

# 3. Validate packet schema against TDS
node validate-packet-schema.js --tds docs/TDS_Slice_*.md --packet fixtures/packet_sample.json

# 4. Confirm Interchange Contract is current
# (manual: read Interchange_Contract.md and verify it matches TDS slice)

# 5. Confirm no stale branch cruft (git status should be clean)
git status --short | grep -E '^ [MD]' && echo "✗ Uncommitted changes detected" || echo "✓ Working directory clean"
```

### B. Mid-Build Validation Points

At these milestones, run validation:

| Milestone | Command | Expected Output |
|-----------|---------|-----------------|
| Store schema written | `node validate-idb-schema.js --app child` | All stores match TDS |
| First 3 modules complete | `node validate-packet-load.js --app child` | Packet loads, no schema errors |
| Completion flow done | `node validate-completion-csv.js --app child` | CSV exports match spec |
| Full milestone complete | `npm test` (if available) | All tests pass |

### C. Post-Build Reconciliation (Mandatory Before Handoff)

After code is merged, Ray **must** perform this ritual before any code ships:

1. **Read the final TDS slice** and the actual code side-by-side.
2. **Verify the Interchange Contract** is still consistent (no schema drift).
3. **Run the full test suite** if one exists.
4. **Smoke-test the app** on a target device (Android budget device for child app).
5. **Update the Roadmap** if any decisions deferred to a later milestone were instead resolved now.

---

## V. Decision Gates & Escalation

### A. When to Halt & Escalate to Ray

**Do NOT guess. Do NOT proceed. Escalate with a clear summary.**

| Scenario | Action |
|----------|--------|
| No TDS slice for the target milestone | Halt. Provide Ray a summary of what you found and ask for TDS authoring. |
| SRS module contradicts TDS slice | Halt. Provide a specific list of contradictions and ask which takes precedence. |
| Schema change required not in TDS | Halt. Describe the change, explain why, and ask if it is in-scope for this milestone. |
| Cross-app code sharing seems beneficial | Halt. Explain the case and ask if it violates architecture. (Answer is almost always yes.) |
| `Interchange_Contract.md` needs update | Halt. Do not edit it unilaterally. Escalate the change with full justification. |
| File layout ambiguity (single `index.html` vs. separate files) | Halt. Ray has an open decision here; ask which layout to use. |
| Module 10 (Theming) needs to connect wizard choice to CSS | Halt. This is a later milestone; ask if it is in scope. |
| Estimated build time exceeds 2–3 hours | Halt before writing code. Estimate work, break into phases, ask Ray how to proceed. |

### B. Decision Flags

Use these in commit messages and comments to signal decisions:

```
[DECISION] <context>
Decided: <choice>
Rationale: <why this choice, not the alternative>
Locked for: <which milestone/module>
```

Example:
```
[DECISION] plannerMeta structure in Module 3
Decided: Key by item ID, not date (Reschedule continuity)
Rationale: Avoids re-computing sort-order & block-assignment on reschedule
Locked for: M1 (no change in M2 or later)
```

---

## VI. Tools & Commands

### A. Validation Scripts

These should exist in the repo root (`validate-*.js`). If not, create them:

```bash
node validate-packet-schema.js [--packet <path>] [--tds <path>]
  # Confirms packet matches TDS schema; flags reserved prefixes (CHR, EVT)

node validate-idb-schema.js [--app child|management] [--tds <path>]
  # Confirms idb-schema.js matches TDS store definitions

node validate-interchange.js [--packet <path>] [--csv <path>]
  # Confirms Completion CSV format matches Interchange Contract

node validate-completion-csv.js [--app child] [--export-path <path>]
  # Exports a test completion CSV and validates format
```

If a validation script is missing, **ask Ray before writing code**.

### B. Test Structure

If tests exist, run them before final commit:

```bash
npm test
  # Run all unit tests

npm run test:integration
  # Run integration tests (e.g., packet load → daily planner → export)

npm run test:coverage
  # Report code coverage
```

### C. Build & Deployment (Future)

```bash
npm run build
  # Bundle child or management app into a single .html file (if applicable)

npm run deploy
  # Push to GitHub Pages (requires Ray to configure secrets)
```

---

## VII. File Output Patterns (Ray's Workflow)

This session should follow Ray's established pattern:

1. **Create in `/home/claude/`** using `create_file`.
2. **Copy to `/mnt/user-data/outputs/`** using `bash_tool`.
3. **Present to Ray** using `present_files`.
4. **Wait for Ray's confirmation** before proceeding to the next step.

Ray will:
- Review the file locally.
- Confirm it matches intent ("✓ looks good, proceed").
- Authorize continuation (move to next phase, commit, etc.).

**Never skip this loop.** It prevents divergence.

---

## VIII. Communication Patterns

### A. Status Updates

At the end of each session phase, provide Ray with:

```
## Phase Summary

**Completed:**
- [x] Verified TDS slice (M2_Child_App)
- [x] Updated idb-schema.js (Modules 4–7)
- [x] Wrote Module 4 (Activity/Chore Completion)

**Halted / Escalated:**
- [ ] Module 5 deferment logic (awaiting TDS clarification on edge case X)

**Next Phase:**
- [ ] Module 5 (Deferment/Waive)
- [ ] Validation of Completion CSV export

**Estimated Remaining Time:** 1.5 hours

**Blockers:** None.
```

### B. Error Reporting

If a validation fails, provide:

```
## Validation Failure: [name]

**Issue:** [Specific error or mismatch]

**Details:**
- Expected: [from TDS or spec]
- Found: [in code or output]

**Impact:** [Does this block the build? Can it be deferred?]

**Suggested Fix:** [If obvious] or [Awaiting Ray guidance]
```

### C. Uncertainty

If something is unclear, ask explicitly:

```
**Clarification Needed:**

In SRS_Module_05 (Deferment), the waive flow says "remove from today's planner."
Does this mean:
A) Delete the item entirely (cannot defer again)?
B) Move it to a future date (user chooses when)?
C) Mark it done with zero reward (counts as completion)?

The TDS slice does not clarify this. Proceeding with Option [X] pending your confirmation.
```

---

## IX. Session Checklist

**Run this at the start of every Claude Code session:**

- [ ] **App declared.** This session is building: `child-app` or `management-app`.
- [ ] **TDS slice confirmed.** Located at: `docs/TDS_Slice_*.md`
- [ ] **SRS modules checked.** All affected modules are up-to-date and consistent.
- [ ] **Interchange Contract reviewed.** No schema drift.
- [ ] **CLAUDE.md read.** Constraints and gates understood.
- [ ] **Working directory clean.** `git status` shows no uncommitted changes.
- [ ] **Validation tools available.** All required `validate-*.js` scripts exist (or ask Ray if missing).

---

## X. Quick Reference: Locked Decisions

| Decision | Status | Module(s) | Notes |
|----------|--------|-----------|-------|
| IndexedDB as source of truth | **LOCKED** | All | No network state. |
| Offline-first guarantee | **LOCKED** | All | Blocks Gist integration. |
| Per-occurrence chore ID (`CHR-{token}-{date}`) | **LOCKED** | 4–9 | No single definition ID. |
| Packet interchange (JSON) | **LOCKED** | 2 | No transformation in child app. |
| Completion CSV interchange | **LOCKED** | 8–9 | Tab-separated, one row per completion. |
| Reserved prefix validation (CHR, EVT) | **LOCKED** | All | Enforced on packet load. |
| `plannerMeta` keyed by item ID | **LOCKED** | 3–5 | Reschedule continuity. |
| Ledger fold at N=100 | **LOCKED** | 6 | User mental model. Corrected 2026-07-13 (was misstated as N=25; TDS_Slice_M2 §4 is authoritative at N=100). |
| Single-file bundle for Android | **LOCKED** | M1 | Relative paths break on multi-file folders. |
| Vanilla JS, no build step | **LOCKED** | All | GitHub Pages deployment requirement. |
| Two-app split, no shared runtime code | **LOCKED** | All | Interchange only. |
| Child App M1 (Modules 1–3) | **COMPLETE** | 1–3 | `homeschool-child-app.html` delivered. |
| Module 10 (Theming) | **DEFERRED** | 10 | Wizard choice → CSS integration is later. |
| Google Drive integration | **DEFERRED** | 2 (alt path) | Planned for later milestone. |
| Single vs. multi-file layout | **OPEN** | M2+ | Ray to decide at build session start. |

---

## XI. Appendix: Key File References

| Document | Purpose | Read When |
|----------|---------|-----------|
| `Interchange_Contract.md` | Packet & CSV spec (master truth) | Before writing import/export code. |
| `packet_schema.json` | Normative JSON schema | Before writing packet validation. |
| `TDS_Slice_M*.md` | Mechanics & schema for milestone | Before writing any code. |
| `SRS_Module_0X.md` | Feature spec for module | Before writing feature code. |
| `DomainModel_Schedule_App.md` | Entity relationships & invariants | When designing store schema. |
| `Architecture_Evaluation_Schedule_App.md` | Trade-off rationale | When questioning a constraint. |
| `Split_Build_Session_Guide.md` | Meta-workflow for build sessions | To understand Ray's build ritual. |
| `Roadmap_Schedule_App.md` | Milestone sequencing & dependencies | To understand what comes next. |

---

## XII. Version & Amendments

**Current Version:** 1.0  
**Date:** 2026-07-13

### Change Log

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-07-13 | Initial CLAUDE.md for Child App M2 build. Enforces split-app architecture, documentation-first gate, core design constraints, and decision escalation. |
| 1.1 | 2026-07-13 | Corrected §III.D and §X: Reward Ledger fold cadence is N=100, not N=25, per `TDS_Slice_M2_Child_App.md` §4 (the document that fixes this concrete number — Domain Model §3.7 only ever said "every N entries"). Resolved with Ray after a pre-build audit found the two documents disagreed. |
| 1.2 | 2026-07-13 | Corrected §III.E: `plannerMeta` shape is `{ id, sortOrder?, blockHint?, deferredDate? }` (per `TDS_Slice_M1_Child_App.md` §4 and the actual code), not `{ rescheduledTo, sortOrder, blockAssignment }` as previously stated. |

---

**End of CLAUDE.md**

_Approved by: Ray (project architect)_  
_Enforced in: All Claude Code sessions for this project_
