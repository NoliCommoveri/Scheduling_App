# CLAUDE.md – Build Session Guardrails

**Version:** 2.0  
**Project:** Homeschool Curriculum & Chore Scheduling System  
**Last Updated:** 2026-08-10  

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
| **The parent token never goes on a child device.** | It grants a whole-database snapshot. Child devices use scoped, revocable device tokens. |
| **Column-level ownership is enforced server-side.** | Parent-owned and child-owned columns are disjoint. This is what makes the design conflict-free. Never let a client decide what it may write. |
| **Vanilla JS, no build step — in the two browser apps.** | The Worker is bundled by Wrangler and always has been. That is not a violation. |
| **Free tier only.** | Cloudflare Workers + D1 free tier. No paid services, no billing surprises. |

---

## I. Scope Enforcement

### A. App-Level Isolation (MANDATORY)

Two applications, one shared database, no shared runtime code:

| Aspect | Child App | Management App |
|--------|-----------|-----------------|
| **Folder** | `child-app/` | `management-app/` |
| **Scope** | Child UI: plan, complete, rewards, streak | Parent/admin UI: curriculum, pacing, assignment, reporting |
| **Runtime Code Sharing** | **FORBIDDEN** | **FORBIDDEN** |
| **Data Flow** | ← `GET /api/plan` · `POST /api/completions` → | → `POST /api/assignments` · `GET /api/assignments` ← |
| **Credential** | Scoped device token (per child) | `SYNC_TOKEN` (parent) |

**Enforcement:**
- A session **must declare which app it is building** at the start. Worker changes are their own scope.
- File edits outside the declared scope are an error; halt and escalate to Ray.
- The two apps may share a *schema* and an *API*. They may never share a JS file.

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
├── management-app/
│   ├── index.html, js/, styles/
│   └── worker/             (index.js, migrations.js, validation.js — the API;
│                            never served as an asset)
│
└── docs/                   (TDS slices, SRS modules, roadmap)
```

`tests/` covers the pure layers only — `worker/validation.js` and the Child App's
`*-core.js` files. Those were written DOM-free and IO-free precisely so they could be
exercised directly; everything above them still needs the manual §13 acceptance checks.
Adding a directory of anything non-public also means adding it to `.assetsignore` in the
same commit — the assets directory is the repo root.

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

- `SYNC_TOKEN` — parent, Worker secret, full scope.
- Device tokens — per child, hashed at rest in `devices`, revocable, scoped to one `child_id`.
- The Worker derives `child_id` **from the token**, never from the request body.
- `/api/pair` is the only unauthenticated route.

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

---

## VIII. Key File References

| Document | Purpose |
|---|---|
| `docs/TDS_Slice_Online_Revamp.md` | **Controlling design.** Schema, API, auth, migrations, phasing. |
| `migrations/*.sql` | Schema history. Forward-only. |
| `management-app/worker/index.js` | The API. |
| `management-app/worker/migrations.js` | Migration registry. |
| `management-app/DEPLOY.md` | Cloudflare setup. |
| `docs/SRS_*.md` | Feature specs. Current except the retired modules named in §II.3. |
| `docs/Roadmap_Schedule_App.md` | Milestone sequencing. |
| `Interchange_Contract.md` | **Legacy.** Historical record only; `fixtures/` and `worker/schema.sql` are deleted. |

---

## IX. Version & Amendments

**Current Version:** 2.0  
**Date:** 2026-08-10

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-07-13 | Initial. Split-app architecture, documentation-first gate, offline-first constraints. |
| 1.1 | 2026-07-13 | Corrected reward ledger fold cadence to N=100. |
| 1.2 | 2026-07-13 | Corrected `plannerMeta` shape. |
| 2.0 | 2026-08-10 | **Architectural reversal.** Offline-first repealed; D1 becomes the system of record; packet and CSV interchange replaced by a shared `assignments` table and an HTTP API; per-occurrence chore IDs, reserved prefixes, and the N=100 ledger fold repealed; no-CLI added as a hard constraint with browser-applied migrations. Authorized by Ray in-session. See `docs/TDS_Slice_Online_Revamp.md`. |

---

**End of CLAUDE.md**

_Approved by: Ray (project architect)_  
_Enforced in: All Claude Code sessions for this project_
