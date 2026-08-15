# CLAUDE.md – Build Session Guardrails

**Version:** 2.4  
**Project:** Homeschool Curriculum & Chore Scheduling System  
**Last Updated:** 2026-08-15  

---

## Purpose

This document defines hard constraints, verification rituals, and decision gates that apply to **every Claude Code build session** on this project. It is read-only guidance enforced **before any code is written or edited**.

> **Version 2.0 is an architectural reversal.** The project was built offline-first, with two air-gapped databases exchanging a JSON packet and a completion CSV. That constraint is **repealed**. The system of record is now a Cloudflare D1 database, and the two apps talk to it over HTTP. `docs/TDS_Slice_Online_Revamp.md` is the authoritative design; this file enforces it.
>
> If you find guidance anywhere in `/docs` that tells you the app must work offline, that IndexedDB is the source of truth, or that packets and CSVs are the interchange — **that guidance is superseded.** Do not halt, do not escalate, do not "restore" it. Build online.

---

## 0. Non-Negotiables (read this first)

| Constraint | Why |
|---|---|
| **Ray has no CLI.** | No step — deploy, schema, backup, recovery — may require a terminal. Anything that would be a `wrangler` command must be a button in a browser. See TDS_Online_Revamp §3.7. |
| **D1 is the system of record.** | IndexedDB on both devices is a cache plus an outbox. Never the truth. |
| **The parent token never goes on a child device.** | It grants a whole-database snapshot. Child devices use scoped, revocable device tokens; the wall tablet uses a household-scoped **wall token** restricted to `/api/wall/*`. A tablet on the kitchen wall is a child device for this purpose. |
| **Column-level ownership is enforced server-side.** | Parent-owned and child-owned columns are disjoint. This is what makes the design conflict-free. Never let a client decide what it may write. **No credential class widens this** — the wall token names *which child* it acts for, never *what may be written*. The case that tested it and held: the Wall App adjusts how long a thing takes by writing an override in a table it owns, **never** by writing the parent-owned `expected_duration_min` (`TDS_Slice_Wall_Calendar_Redesign.md` §3.5.1). When a requirement seems to need a client writing someone else's column, build it beside the rule, not through it. |
| **Vanilla JS, no build step — in the two browser apps.** | The Worker is bundled by Wrangler and always has been. That is not a violation. |
| **Free tier only.** | Cloudflare Workers + D1 free tier. No paid services, no billing surprises. |

---

## I. Scope Enforcement

### A. App-Level Isolation (MANDATORY)

Three applications, one shared database, no shared runtime code:

| Aspect | Child App | Management App | Wall Display App |
|--------|-----------|-----------------|------------------|
| **Folder** | `child-app/` | `management-app/` | `wall-app/` |
| **Scope** | Child UI: plan, complete, rewards, streak | Parent/admin UI: curriculum, pacing, assignment, reporting | Shared family calendar: day/week/month views, chores placed on a 15-minute grid, school blocks, completion |
| **Runtime Code Sharing** | **FORBIDDEN** | **FORBIDDEN** | **FORBIDDEN** |
| **Data Flow** | ← `GET /api/plan` · `POST /api/completions` → | → `POST /api/assignments` · `GET /api/assignments` ← | ← `GET /api/wall/children` · `GET /api/wall/plan` · `GET /api/wall/events` · `GET/PUT/DELETE /api/wall/slots` · `PUT/DELETE /api/wall/slots/day` · `GET/POST /api/wall/school-blocks` · `PUT/DELETE /api/wall/school-blocks/:id` · `PUT/DELETE /api/wall/school-blocks/:id/courses` · `POST /api/wall/completions` → |
| **Credential** | Scoped device token (per child) | `SYNC_TOKEN` (parent) | Household-scoped **wall token** (`devices.scope = 'wall'`) |

The Wall App **reads** the active-child roster, chores, events, and — read-only, for school blocks —
activities; **writes** completions, their earn entries, shared-chore claims, and **its own placement
tables (`wall_slots`, `wall_slot_days`, `wall_school_blocks`, `wall_school_block_courses`)**. Nothing
else — no waives, no deferments, no grades, no messages, no streaks, and nothing whatsoever on an
activity row
(`TDS_Slice_Wall_Calendar_Redesign.md` §5.1, §12).

**The placement tables widen nothing on `assignments`.** The wall's writes there remain exactly
`ASSIGNMENT_COMPLETION_FIELDS`. This is the distinction that keeps the row below intact: the wall
owns four tables of its own — two for a chore's standing time-of-day placement (`wall_slots`,
`wall_slot_days`), two for a school block's span and membership (`wall_school_blocks`,
`wall_school_block_courses`) — and owns no new column of anyone else's.

It mirrors several rules from the Child App's pure layer (day membership, the event key, the
plannability rule); mirroring is **not** sharing, and each mirrored file must name what it mirrors
in a comment.

**Enforcement:**
- A session **must declare which app it is building** at the start. Worker changes are their own scope.
- File edits outside the declared scope are an error; halt and escalate to Ray.
- The three apps may share a *schema* and an *API*. They may never share a JS file.

### B. Repository Structure

```
/
├── CLAUDE.md (this file)
├── wrangler.toml           (repo root — Cloudflare dictates this location)
├── package.json            (pins Wrangler for git-connected deploys; not app runtime)
│
├── migrations/             (NNNN_description.sql — forward-only, applied in-browser)
├── tests/                  (node --test; `npm test`. No runtime dependency of either app)
│
├── child-app/              (PWA: index.html, js/, css/, icons/, manifest.json, sw.js)
├── wall-app/               (PWA: index.html, js/, css/, icons/, manifest.json, sw.js)
├── management-app/
│   ├── index.html, js/, styles/
│   └── worker/             (index.js, migrations.js, validation.js — the API;
│                            never served as an asset)
│
└── docs/                   (TDS slices, SRS modules, roadmap)
```

`tests/` covers the pure layers only — `worker/validation.js` and the `*-core.js` files in
the Child App and the Wall App. Those were written DOM-free and IO-free precisely so they
could be exercised directly; everything above them still needs the manual §13 acceptance
checks. Adding a directory of anything non-public also means adding it to `.assetsignore` in
the same commit — the assets directory is the repo root.

**`wall-app/` is public static assets, exactly like `child-app/`, and needs NO `.assetsignore`
entry.** Stated explicitly so the next reader does not "fix" its absence: the wall app ships
no secret, and its credential is minted at runtime and lives in the tablet's `localStorage`.

`Interchange_Contract.md` is **legacy** — an artifact of the packet/CSV era, kept as a historical record of a contract nothing implements any more. Do not build against it. `fixtures/` was deleted in Phase 5, along with `management-app/worker/schema.sql`, whose header still told an operator to run `wrangler d1 execute` or paste DDL into the D1 console — the one thing §III.D says is never acceptable.

---

## II. Documentation-First Gate

### BEFORE any code is written, verify:

1. **`docs/TDS_Slice_Online_Revamp.md` has been read.** It is the controlling design for everything post-2026-08-10. Where it conflicts with an older slice, it wins.

2. **A TDS slice exists for the target milestone**, defining schema shapes, state transitions, and open-vs-decided items.
   - **Missing TDS = HALT; escalate to Ray for TDS authoring.**

3. **SRS modules for affected Modules are current.**
   - **Mismatch = HALT; run audit (§IV.A) before proceeding.**
   - Exception: Child Module 02 (Packet Import), Child Module 08 (CSV Export as transport), and Management Module 09 (Completion Import) are **retired**. A mismatch against those is expected, not a blocker.

4. **The D1 schema and the Worker API match the TDS.**
   - Every schema change is a new migration file, registered per §3.7.3 of the revamp slice.
   - **Never edit an applied migration.** Correct it with a new one.

---

## III. Key Architectural Constraints (LOAD-BEARING)

### A. D1 as System of Record

- **D1 holds the truth.** IndexedDB on both devices is a read-through cache plus a write outbox.
- **Network is the normal path.** Both apps make API calls during ordinary operation.
- **Offline is tolerated, not guaranteed.** The Child App opens from cache, renders the last known plan, and queues completions. It does **not** need to function indefinitely without a network, and no design may be contorted to make it.
- **Local writes never block on the network.** A completion commits locally and drains later.
- **Narrowed exception 1: `claim_group` rows.** Per `TDS_Slice_Shared_Chores.md` §0.8/§5.7, a row with `claim_group IS NOT NULL` requires a live connection to complete — the claim is the write, and it is synchronous, because only the server knows whether a sibling got there first. This applies to that row class only. Every other row — activities, events, private chores, `each` chores including multi-child, and deferment/waive/note/message writes even on a claim row — keeps the local-first path above, unchanged.
- **Narrowed exception 2: the Wall Display App.** Per `TDS_Slice_Wall_Display_App.md` §6.4, **every** wall write is synchronous and online-required. A failure leaves the chore un-ticked, shows a message, and the child taps again. The wall has no IndexedDB, no outbox, and no drain. Rationale: the local-first guarantee was built for a tablet carried around a house on patchy wifi; the wall is a fixed, mains-powered device metres from the access point, and an outbox on it would buy a rare edge case at the cost of a window in which a chore ticked at 4pm lands at 4:10pm — after the sibling standing at the same tablet has been told it is theirs to do. **Scoped to `wall-app/` only. The Child App's guarantee above is untouched.** Authorized by Ray in-session, 2026-08-13.

### B. The Shared Assignment Table

- **One row per child per day per thing to do**, in `assignments`.
- **IDs are server-minted opaque UUIDs.** Nothing parses an ID. There are no derived IDs, no reserved prefixes, no `CHR-{token}-{date}` scheme. *(The old per-occurrence identity rule is repealed.)*
- **Parent writes the top half, child writes the bottom half** — see the revamp slice §3.3. The Worker enforces this; clients are never trusted to self-limit.
- **Denormalized on purpose.** `title`, `course_name`, `reward_amount` are snapshotted at assign time. A completed assignment records what it *was*, not what the curriculum later became.

### C. Rescission and the Append-Only Ledger

- **Rescind sets `rescinded_at`; it never deletes.** A row that vanishes can be resurrected by a stale device replaying its outbox.
- **Every Commit stamps a `batch_id`**, so a bad batch can be reversed in one statement.
- **`reward_entries` is append-only.** Never update, never delete. A correction is a new compensating row. **Rescinding an assignment never claws back earnings** — a child's balance must not silently drop because a parent reorganised a syllabus.

### D. Migrations Are Browser-Applied

- Files in `/migrations`, `NNNN_short_description.sql`, forward-only, one logical change per file.
- **Adding a file also means registering it** in `management-app/worker/migrations.js`.
- Applied from Settings → Database, or from `/admin/migrations` when the app itself is broken.
- **Never instruct Ray to run a CLI command or paste SQL into the D1 console.** If a task seems to require it, that is a bug in the task, not in Ray's setup.

### E. Authorization

Three credential classes, all hashed at rest, all revocable:

- `SYNC_TOKEN` — parent, Worker secret, full scope.
- **Device tokens** (`devices.scope = 'child'`) — per child, revocable, scoped to one `child_id`.
- **The wall token** (`devices.scope = 'wall'`) — one per wall display, household-scoped, minted by
  a pair code like a device token and revoked from the same Devices UI. Restricted by the Worker to
  the `/api/wall/*` routes and nothing else.

The rules that hold across all three:

- The Worker derives `child_id` **from the token**, never from the request body. **One exception,
  authorized by Ray in-session 2026-08-13:** on `/api/wall/*` the child is named in the request,
  because a household-scoped credential cannot name one by itself. See
  `TDS_Slice_Wall_Display_App.md` §8.3. That exception is bounded by four things, and a wall route
  that drops any of them is a bug:
  1. the named `childId` is validated against `children WHERE active = 1` before any
     `assignments` access;
  2. every statement keeps its existing `AND child_id = ?` clause, with the resolved id
     substituted for the token-derived one;
  3. the routes reuse `ASSIGNMENT_COMPLETION_FIELDS` verbatim — **column ownership is not
     narrowed**, only child selection;
  4. a wall token is 401 on the device routes, and a device token is 401 on the wall routes.
- A credential may widen *which child* it acts for. **None may widen what may be written.**
- `/api/pair` and `/api/wall/pair` are the only unauthenticated routes.
- **Two wall routes name no child at all, and that is not a fourth exception.** `/api/wall/children`
  and `/api/wall/events` are household-scoped by nature: they are bounded by a
  `children.active = 1` join, they act for nobody, and they read no child-owned column that could
  be attributed to one. The four bounds above govern routes that *act for a named child*; these do
  not act. See `TDS_Slice_Wall_Calendar_Redesign.md` §7.2.
- **The wall's own tables (`wall_slots`, `wall_slot_days`, `wall_school_blocks`,
  `wall_school_block_courses`) sit outside this scheme entirely.** No other app reads or writes
  them, they contain no child-owned or parent-owned assignment data, and writing them is never a
  substitute for writing a column the wall does not own. A school block's `childId` (§5.5) takes
  no sentinel — a block is always one child's, unlike a `claim` chore's placement (§3.1.2) — but
  that is a rule about which rows the table holds, not a fifth bound on `assignments`.

---

## IV. Verification & Audit Rituals

### A. Pre-Build Audit Checklist

```bash
# 1. Controlling design present
[ -f docs/TDS_Slice_Online_Revamp.md ] && echo "✓" || echo "✗ HALT"

# 2. TDS slice for the target milestone
ls docs/TDS_Slice_*.md

# 3. Every migration file is registered in the runner
for f in migrations/*.sql; do
  grep -q "$(basename "$f")" management-app/worker/migrations.js \
    && echo "✓ $(basename "$f")" || echo "✗ UNREGISTERED: $(basename "$f")"
done

# 4. Working directory clean
git status --short
```

### B. Mid-Build Validation

| Milestone | Check |
|---|---|
| Migration written | Registered in `worker/migrations.js`; applies cleanly on an empty DB |
| Worker route added | Rejects the wrong credential type; rejects writes to columns it does not own |
| Child App data change | `DB.loadState()` returns `{ rows }` (see revamp §8.2 — the §14 shim collapse's phase 3 dropped the four legacy keys this row used to pin) |
| Wall App route added | All four §III.E bounds present: active-child check, `AND child_id = ?` retained, existing field map reused, cross-credential 401 both ways |
| Wall App day logic touched | Mirrors `planner-core.js` `effectiveDueDate` **and** `onToday` — deferment and overdue roll-forward both, or the wall and the child's tablet disagree about what is due today |
| Wall App placement write added | Writes `wall_slots` / `wall_slot_days` only. **No `assignments` column is touched outside `ASSIGNMENT_COMPLETION_FIELDS`** — in particular never `expected_duration_min`, which is parent-owned (§0) |
| Any schema change | Applied via the browser, never the console |

### C. Post-Build Reconciliation (before handoff)

1. Read the TDS slice and the code side by side.
2. Confirm every new migration is registered and applied.
3. Verify the credential-scope acceptance checks (revamp §13, items 1–7).
4. Smoke-test the Child App on a budget Android device.
5. Update the Roadmap if deferred decisions were resolved early.

---

## V. Decision Gates & Escalation

### A. When to Halt & Escalate

| Scenario | Action |
|---|---|
| No TDS slice for the target milestone | Halt. Summarize findings, ask for TDS authoring. |
| SRS contradicts the revamp slice | **Do not halt** if the contradiction is offline-vs-online, packet, or CSV. The revamp wins. Halt only for a genuine conflict. |
| Schema change not described in a TDS | Halt. Describe the change and ask if it is in scope. |
| A step appears to require a CLI | Halt. This is never acceptable — redesign it as a browser action. |
| Cross-app code sharing seems beneficial | Halt. The answer is almost always no. |
| Estimated build time exceeds 2–3 hours | Halt before writing code. Break into phases, ask how to proceed. |

### B. Decision Flags

```
[DECISION] <context>
Decided: <choice>
Rationale: <why this choice, not the alternative>
Locked for: <which milestone/module>
```

---

## VI. Communication Patterns

### A. Status Updates

End each phase with what completed, what halted and why, what is next, and estimated remaining time.

### B. Error Reporting

State the issue, expected vs. found, whether it blocks, and the suggested fix.

### C. Uncertainty

Ask explicitly, list the candidate readings, state which you are proceeding with, and flag it for confirmation.

---

## VII. Quick Reference: Locked Decisions

| Decision | Status | Notes |
|---|---|---|
| D1 as system of record | **LOCKED** | Replaces IndexedDB-as-truth. |
| Online-first, offline-tolerant | **LOCKED** | Replaces the offline-first guarantee. |
| No CLI, ever | **LOCKED** | Migrations and all ops are browser-driven. |
| Shared `assignments` table | **LOCKED** | Parent assigns, child completes, one row. |
| Server-minted opaque UUIDs | **LOCKED** | Repeals `CHR-{token}-{date}` and reserved prefixes. |
| Column-level ownership | **LOCKED** | Enforced in the Worker. No conflict resolution needed. |
| Rescind = `rescinded_at`, never DELETE | **LOCKED** | Batch-scoped via `batch_id`. |
| Append-only reward ledger | **LOCKED** | Repeals the N=100 fold. |
| Scoped, revocable child device tokens | **LOCKED** | Parent token never leaves parent devices. |
| Pacing engine in the browser | **LOCKED (this round)** | Server-side generation deferred; schema is ready. |
| One Worker serving both apps | **LOCKED** | Same-origin, no CORS, one git connection. |
| Vanilla JS, no build step (browser apps) | **LOCKED** | The Worker is bundled; that is not a violation. |
| Two-app split, no shared runtime code | **LOCKED** | Shared schema and API only. |
| Free tier only | **LOCKED** | Workers + D1. |
| Packet JSON interchange | **REPEALED** | Was Module 02. |
| Completion CSV interchange | **REPEALED** | Was Modules 08/09. CSV survives as a report export only. |
| `plannerMeta` as a store | **REPEALED** | Now columns on `assignments`. |
| Google Drive integration | **ABANDONED** | Solved a problem that no longer exists. |
| Module 10 (Theming) | **DEFERRED** | Wizard choice → CSS integration. |
| Shared chore claims | **LOCKED** | Server-arbitrated, online-required, `each`/`claim` allocation and per-day instances on a single Chore record. See `TDS_Slice_Shared_Chores.md`. |
| Wall Display App | **LOCKED** | Third app, `wall-app/`. One household-scoped wall token, no per-child pairing; roster read live from `children WHERE active = 1`; PINs local to the tablet; complete-only writes; online-required. See `TDS_Slice_Wall_Display_App.md`. |
| `child_id` from the request on `/api/wall/*` | **LOCKED** | The one exception to §III.E's derive-from-token rule, bounded by four checks. Column ownership unchanged. |
| Per-child pairing on the wall | **REPEALED** | Was the 2026-08-13 draft of the wall slice. The wall pulls all active children from D1 instead. |
| Wall calendar redesign | **LOCKED** | The wall becomes a shared family calendar: day/week/month, one column per active child, chores placed on a 15-minute grid, school blocks, completion that asks *when*. Placements live in wall-owned tables and carry forward to future days. See `TDS_Slice_Wall_Calendar_Redesign.md`. |
| Per-child PIN gating on the wall | **REPEALED** | Was wall slice §0.3/§0.4/§4, never built. One shared board; the column a tap lands in names the child. The admin PIN on Settings survives. Redesign slice §2.3 states the consequence plainly: any child can tick any child's chore. |
| Chore duration authored in the Management App | **LOCKED** | Module 06 gains `expectedDurationMin`, filling a column that already exists (`migrations/0001:46`). The wall may override it in its own tables; it may never write it. Redesign slice §3.5/§3.5.1. |

---

## VIII. Key File References

| Document | Purpose |
|---|---|
| `docs/TDS_Slice_Online_Revamp.md` | **Controlling design.** Schema, API, auth, migrations, phasing. |
| `docs/TDS_Slice_Wall_Display_App.md` | The Wall Display App: credential, roster, PIN gate, read/write paths, Worker routes, phasing. |
| `migrations/*.sql` | Schema history. Forward-only. |
| `management-app/worker/index.js` | The API. |
| `management-app/worker/migrations.js` | Migration registry. |
| `management-app/DEPLOY.md` | Cloudflare setup. |
| `docs/SRS_*.md` | Feature specs. Current except the retired modules named in §II.3. |
| `docs/Roadmap_Schedule_App.md` | Milestone sequencing. |
| `Interchange_Contract.md` | **Legacy.** Historical record only; `fixtures/` and `worker/schema.sql` are deleted. |

---

## IX. Version & Amendments

**Current Version:** 2.4  
**Date:** 2026-08-15

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-07-13 | Initial. Split-app architecture, documentation-first gate, offline-first constraints. |
| 1.1 | 2026-07-13 | Corrected reward ledger fold cadence to N=100. |
| 1.2 | 2026-07-13 | Corrected `plannerMeta` shape. |
| 2.0 | 2026-08-10 | **Architectural reversal.** Offline-first repealed; D1 becomes the system of record; packet and CSV interchange replaced by a shared `assignments` table and an HTTP API; per-occurrence chore IDs, reserved prefixes, and the N=100 ledger fold repealed; no-CLI added as a hard constraint with browser-applied migrations. Authorized by Ray in-session. See `docs/TDS_Slice_Online_Revamp.md`. |
| 2.1 | 2026-08-12 | §III.A gains the `claim_group` narrowing (online-required for shared-chore claims only; every other row keeps the local-first path). §VII gains the "Shared chore claims" locked-decision row. Closes the §14 amendment gap left open by `TDS_Slice_Shared_Chores.md` — the SRS modules were updated in commit `9715b50`, this file was not. Authorized by Ray in-session. See `docs/TDS_Slice_Shared_Chores.md` §0.8/§5.7/§14. |
| 2.3 | 2026-08-14 | **The wall becomes a calendar.** §I.A's Wall column is rewritten: its scope is a shared family calendar, its Data Flow gains the events and slots routes, and its write list gains **its own tables** (`wall_slots`, `wall_slot_days`) while its `assignments` writes stay exactly `ASSIGNMENT_COMPLETION_FIELDS`. Its read list gains activities, read-only, for school blocks. §0's column-ownership row records the case that tested the rule and held — the wall overrides a duration in a table it owns rather than writing the parent-owned `expected_duration_min`. §III.E records that `/api/wall/children` and `/api/wall/events` name no child and are therefore not a fourth exception, and that the wall's own tables sit outside the scheme. §IV.B gains a placement-write check. §VII gains three rows; per-child PIN gating on the wall is repealed. Authorized by Ray in-session, all three narrowings signed off individually. See `docs/TDS_Slice_Wall_Calendar_Redesign.md` §18. |
| 2.2 | 2026-08-13 | **Third app.** §I.A's isolation table becomes three columns and §I.B's tree gains `wall-app/` (public assets, no `.assetsignore` entry — stated so nobody "fixes" it). §0 records the wall token and that no credential widens column ownership. §III.A gains a second narrowing: all Wall App writes are online-required, scoped to that app. §III.E is restructured around three credential classes and records the one exception to derive-`child_id`-from-token — `/api/wall/*` names the child in the request — with the four bounds that contain it. §IV.B gains two Wall App checks. §VII gains three rows; per-child pairing on the wall is repealed. Authorized by Ray in-session, all three narrowings signed off individually. See `docs/TDS_Slice_Wall_Display_App.md` §6.4, §8.3, §16. |
| 2.4 | 2026-08-15 | **School blocks widen the wall's write scope a second time.** §I.A's Data Flow cell gains the five `/api/wall/school-blocks*` routes and its write list gains **two more wall-owned tables** (`wall_school_blocks`, `wall_school_block_courses`), alongside `wall_slots`/`wall_slot_days` — restated in the same breath that this widens nothing on `assignments`, whose writes there stay exactly `ASSIGNMENT_COMPLETION_FIELDS`. §III.E's "the wall's own tables" bullet gains the two new tables and a note that a school block's `childId` takes no sentinel (unlike a `claim` chore's placement, §3.1.2) without that being a fifth bound. This is the amendment `TDS_Slice_Wall_Calendar_Redesign.md` §18.1a flagged as required before Phase 7 shipped and not yet put to Ray individually — it is a direct extension of §2.3's already-approved narrowing (the wall may own tables of its own, outside the child-scoping scheme, so long as it widens no `assignments` column) rather than a new kind of departure, so it is recorded here rather than re-litigated as a fourth narrowing. See `docs/TDS_Slice_Wall_Calendar_Redesign.md` §5.5, §18.1a. |

---

**End of CLAUDE.md**

_Approved by: Ray (project architect)_  
_Enforced in: All Claude Code sessions for this project_
