# Technical Design Specification — Slice

## Scope: Grading Assistant — photo capture, AI-proposed grades, tunable per-course rubrics, and a mechanics-error record for remediation

**Date:** 2026-08-15 · **Status:** §11.1 confirmed 2026-08-15; Phases 1–6 shipped. §0.7 corrected 2026-08-16 (no offline photo queue — see `CLAUDE.md` v2.6). §11.2–5 remain open, none blocking.

**Applies to:** Child App (capture), Worker (grading route, rubric resolution, mechanics
filter), Management App (rubric authoring, review surface, remediation report). Three
declared scopes per `CLAUDE.md` §I.A; no runtime JS is shared between them.

**Builds on:** `TDS_Slice_Online_Revamp.md` (the shared `assignments` table, column-level
ownership, the `records` mirror, the outbox/drain model), `TDS_Slice_Wall_Display_App.md`
§6.4 (the online-required narrowing), and `TDS_Slice_Lesson_Recipe.md` D13 (the sparse
per-Course override pattern, reused verbatim here for rubrics).

**Repeals nothing.** This slice adds two tables, one field on the Course record, one R2
bucket, and four routes. It changes no existing column's ownership and no existing
route's contract.

---

## 0. Decisions made in this slice

1. **The grader never writes `assignments.grade`.** It writes a *proposal* into its own
   table. The score reaches `grade` only through the existing completion path, using
   exactly `ASSIGNMENT_COMPLETION_FIELDS`, unchanged. This is the Wall App's pattern
   (`CLAUDE.md` §0) applied verbatim: own your own tables, widen nobody else's column.
2. **No new credential class, and no new §III.E exception.** The child's device requests
   grading for its own assignment; the Worker derives `child_id` from the device token as
   it always has. Unlike the Wall App, this feature needs no departure from
   derive-from-token — worth stating plainly so no future session invents one.
3. **Content and mechanics are separate axes.** Content correctness produces the number.
   Spelling and grammar findings are recorded and reported beside it, and never move the
   number. Rationale in §4.1: `reporting.js:142` rolls up average grade per course, and a
   mechanics deduction applied to some courses and not others silently destroys the
   comparability of that rollup.
4. **Recording is decoupled from counting.** A rubric that sets `spelling: 'off'` means
   "do not mark the child down for this," **not** "do not track it." Findings are written
   to `mechanics_findings` either way, because the stated purpose of the axis is designing
   remedial work, and remediation needs the data from courses that don't penalise.
5. **The word list is a post-filter, never a prompt injection.** Fry's 1000 ships as a
   frozen Set in a Worker module. The model reports every suspected misspelling; the
   Worker decides which ones count. Injecting 1000 words into every request would cost
   ~1300 tokens per call and make the model's job fuzzier, not sharper. As a post-filter
   it is deterministic, free, and unit-testable.
6. **Rubrics need no migration.** A rubric is a field on the Course record. Course records
   already reach D1 inside `records` (`store = 'courses'`) via the existing sync push, and
   the Worker reads them with `json_extract` exactly as migration `0002` does for children.
7. **Grading is online-required.** Same class of narrowing as `claim_group` rows
   (§III.A) and the Wall App, but simpler than either: there is no offline path at all.
   Capture-and-submit requires a live connection end to end — a capture with no network
   is not queued anywhere, in the outbox or otherwise; the capture UI declines to submit
   and the child tries again once connected. **Corrected 2026-08-16, before Phase 6
   build:** this section originally described a photo queued in the outbox and graded on
   drain. That was never built. What survives from the original intent is the boundary,
   not the mechanism — capture-and-grade is still a separate action from marking the
   assignment done, and still never blocks the completion, which stays fully local-first.
   See `CLAUDE.md` §III.A / v2.6.

---

## 1. Schema changes — summary

Two migrations. One field, no migration. One bucket.

| File | Change |
|---|---|
| `migrations/0012_grading_reviews.sql` | `CREATE TABLE grading_reviews (…)` — the grader's own proposal rows (§2.1) |
| `migrations/0013_mechanics_findings.sql` | `CREATE TABLE mechanics_findings (…)` — append-only remediation feed (§2.2) |
| *(none)* | `gradingRubric` — a sparse field on the Course record, carried by the existing `records` sync (§3) |
| *(none)* | R2 bucket `grading-media`, bound in `wrangler.toml` (§5) |

Both migrations register in `management-app/worker/migrations.js` in the same commit, per
`CLAUDE.md` §III.D.

### 1.1 `grading_reviews`

One row per grading attempt. Not append-only — a re-grade replaces the row for that
assignment, because a proposal is a draft and there is no ledger property to protect.

| Column | Purpose |
|---|---|
| `assignment_id` | PK. One live proposal per assignment. |
| `child_id` | Denormalised for query; always matches the assignment's. |
| `photo_key` | R2 object key for the captured page. |
| `proposed_score` | REAL. The content score. **Never copied to `assignments.grade` by this route.** |
| `items` | JSON: per-item verdict, transcription, reason. |
| `feedback` | Text addressed to the child. |
| `rubric_digest` | Hash of the resolved rubric that produced this. §3.3. |
| `model` | Model id that graded it — so a later accuracy regression is attributable. |
| `state` | `'proposed'` \| `'accepted'` \| `'overridden'` \| `'failed'` |
| `created_at`, `reviewed_at` | |

### 1.2 `mechanics_findings`

Append-only, one row per finding, never updated or deleted. Shaped for the query that
justifies it: *which words does this child keep getting wrong?*

| Column | Purpose |
|---|---|
| `id` | PK, server-minted. |
| `child_id`, `assignment_id` | |
| `kind` | `'spelling'` \| `'grammar'` |
| `as_written` | What the child wrote. |
| `intended` | What the model believes was meant. |
| `counted` | 0/1 — whether the rubric made it affect the child's feedback. Recorded either way (§0.4). |
| `source` | `'list'` \| `'model'` — which arm of §4.2 decided it. Lets you audit the two independently. |
| `found_at` | |

Indexed on `(child_id, intended)` — that index *is* the remediation report.

**Why a table and not JSON on `grading_reviews`:** migration `0002`'s own header makes
this argument for `children` — a projection exists "so reports and joins do not have to
parse JSON blobs." Same reasoning, same answer.

---

## 2. The rubric model

Three layers, resolved in order. This is `TDS_Slice_Lesson_Recipe.md` D13's shape reused
without modification: sparse per-Course override, absent keys falling through to defaults,
so improving a default still reaches every course that has not opted out.

```
householdDefaults          (settings record, one per install)
  └── course.gradingRubric (sparse — only the keys this course disagrees with)
        └── resolved rubric → prompt text
```

### 2.1 Fields

| Key | Values | Default | Meaning |
|---|---|---|---|
| `spelling` | `'off'` \| `'listOnly'` \| `'all'` | `'listOnly'` | Which misspellings are surfaced to the child. All are recorded regardless (§0.4). |
| `grammar` | `'off'` \| `'on'` | `'off'` | |
| `paraphraseTolerance` | `'strict'` \| `'normal'` \| `'generous'` | `'normal'` | How far from the key's wording an answer may sit. The main dial for reading comprehension. |
| `partialCredit` | boolean | `true` | Whether PARTIAL counts as half. |
| `houseRules` | free text | `''` | Prose appended verbatim to the prompt. The escape hatch — this is a household of three children, not a rules engine. |

### 2.2 Resolution is a pure function

`resolveRubric(courseOverride, householdDefaults) → rubric` and
`rubricToPrompt(rubric, gradeLevel) → string` are DOM-free and IO-free, and live in
`management-app/worker/grading-core.js`.

This is the point of the layer: the most behaviour-critical code in the feature becomes
directly testable in `tests/`, alongside `validation.js` and the `*-core.js` files, with
no network call and no D1. See §8.

### 2.3 `rubric_digest`

`grading_reviews` stores a hash of the *resolved* rubric, not the rubric itself.

§III.B's denormalization rule says a completed assignment records what it *was* — but
copying prose onto every row would bloat D1 for no benefit at ~240 rows/month. The digest
preserves the property that matters (you can tell whether two grades were produced under
the same policy, and spot the boundary when a rubric changed mid-term) at 64 bytes.

---

## 3. Mechanics: the word list and the filter

### 3.1 The list

Fry's 1000 most common words, grouped by hundred, as a frozen `Set` in
`management-app/worker/word-list.js`. Public domain, no maintenance, Worker-only, never
served as an asset. Approximate level mapping, keyed off the child's existing
`gradeLabel` field (`children.js:48` — it is already authored, nothing new to collect):

| Fry group | Roughly |
|---|---|
| 1–300 | Grades 1–3 |
| 301–600 | Grade 4 |
| 601–1000 | Grade 5+ |

Mapping is approximate by nature and lives in one constant, so it is trivially tuned once
you see real results.

### 3.2 The filter

The model does not decide what counts. It reports; the Worker decides.

1. **Model reports** every suspected misspelling as
   `{ asWritten, intended, ageJudgment: 'expected' | 'advanced' }`. It is told to report
   all of them and to pre-filter nothing.
2. **Worker resolves each**, in this order:
   - `spelling: 'off'` → recorded, `counted = 0`, not shown to the child.
   - `intended` in the Fry list at or below the child's level → **counts**,
     `source = 'list'`. Deterministic, and defensible to a child who asks why.
   - not in the list, and `spelling: 'all'` → falls to the model's `ageJudgment`,
     `source = 'model'`.
   - not in the list, and `spelling: 'listOnly'` → recorded, `counted = 0`.
3. **All findings are written** to `mechanics_findings` either way.

Storing `source` is what makes the two arms auditable separately: if the model arm proves
noisy in practice you can drop the whole household to `'listOnly'` and lose nothing that
was already trustworthy.

---

## 4. Media storage

R2 bucket `grading-media`, bound in `wrangler.toml` as `MEDIA`. Free tier: 10 GB storage,
1M Class A ops/month. At ~240 photos/month at ~500 KB, a year of use is ~1.4 GB.

| Prefix | Contents | Written by |
|---|---|---|
| `pages/{assignment_id}` | Captured worksheet photo | Child device, via the Worker |
| `keys/{lesson_id}` | Answer key PDF | Management App upload |

**Neither prefix is ever public.** `wrangler.toml` sets `[assets] directory = "./"`, so
anything in the repo is world-downloadable — which is why answer keys must live in R2 and
never in the tree. The failure mode is not merely a licensing one: a child with the app
URL could otherwise fetch the answer key to the page they are about to do. Access is
Worker-mediated and token-gated on both prefixes.

Bucket creation is a dashboard action and the binding is a `wrangler.toml` edit deployed
from GitHub. No CLI step, per §0.

---

## 5. Worker routes

All four take a device token and derive `child_id` from it (§0.2). No route accepts a
`childId` in the body.

| Route | Purpose |
|---|---|
| `POST /api/grading/page` | Upload a photo, create the `grading_reviews` row, run the grading call, return the proposal. Online-required. |
| `GET /api/grading/review/:assignmentId` | Read back a proposal. |
| `POST /api/grading/keys` | Parent uploads an answer key PDF for a lesson. `SYNC_TOKEN` only. |
| `GET /api/grading/remediation` | Aggregated `mechanics_findings` for a child. `SYNC_TOKEN` only. |

A `SYNC_TOKEN` on a device route and a device token on a parent route are both 401, the
same cross-credential property §III.E requires of the wall routes.

---

## 6. The prompt contract

Ordering is load-bearing and is fixed by the caching rule, not by taste:

```
1. Answer key PDF          ← stable across every child and page in this lesson
2. Resolved rubric text    ← stable per course
3. Lesson / course context ← stable per lesson
   ──── cache breakpoint, 1h TTL ────
4. The child's photo       ← volatile, one request only
5. Output instruction
```

Caching is a prefix match: everything before a change is reusable, everything after is
not. Key-first is what makes the answer key ride at roughly a tenth of input price when
you grade three children's copies of the same lesson in one sitting. Photo-first would
cost full price on every call. **A 1-hour TTL, not the 5-minute default** — grading
happens in sittings, and three requests against one cached key is comfortably past the
1-hour tier's break-even.

Response shape is pinned with structured outputs (`output_config.format`), not parsed from
prose. Per item: transcription, verdict (`CORRECT` | `PARTIAL` | `INCORRECT` | `BLANK` |
`UNSURE`), reason. Plus the mechanics array from §3.2, the content score, and the child
feedback paragraph.

**`UNSURE` is a first-class verdict, not a failure.** The model is instructed to use it
rather than guess when handwriting is illegible or an answer is genuinely borderline. An
honest `UNSURE` routes the item to the parent, which is exactly the behaviour that keeps
the review gate cheap.

**Transcription is required on every item.** It is the diagnostic that separates a
misread-handwriting failure (fix the capture) from a misjudged-answer failure (fix the
rubric). Without it those are indistinguishable in the score and neither is actionable.

Model: `claude-sonnet-5` default, per-course override to `claude-opus-5`. Recorded per row
in `grading_reviews.model`.

---

## 7. Guardrail compliance

Checked against `CLAUDE.md` §IV.B, since this slice touches three apps and adds a paid
dependency.

| Guardrail | Status |
|---|---|
| Column-level ownership | **Intact.** Grader writes only its own two tables. `assignments` writes stay exactly `ASSIGNMENT_COMPLETION_FIELDS`. |
| `child_id` from token | **Intact.** No new exception; §III.E's rule is unmodified. |
| No CLI | **Intact.** Bucket via dashboard, binding via GitHub, migrations via Settings → Database. |
| Migrations registered | Both, same commit. |
| `.assetsignore` | **No change needed** — `docs/`, `*.md`, `migrations/` and `management-app/worker/` are already excluded. The word list and `grading-core.js` live under `worker/`, so they inherit that exclusion. Answer keys never enter the tree at all (§4). |
| Vanilla JS, no build step | Intact in all three browser apps. The Worker is bundled, as always. |
| Free tier only | **NARROWED.** See §10. |
| Local-first | **Narrowed, existing class.** §0.7. |

---

## 8. Tests

`tests/` covers pure layers only. Three new suites, all against
`management-app/worker/grading-core.js` and `word-list.js`:

1. **Rubric resolution** — sparse override merges over defaults; absent keys fall through;
   an empty override resolves to defaults exactly.
2. **Mechanics filter** — each branch of §3.2, including the two that record with
   `counted = 0`, and the `source` attribution for both arms.
3. **Score normalization** — PARTIAL as half under `partialCredit`, `BLANK` and `UNSURE`
   excluded from the denominator, empty-denominator guard.

The prompt assembly and the grading call itself are not unit-testable and are covered by
the §9 acceptance checks against a real database.

---

## 9. Phasing

| Phase | Scope | Contents | Est. |
|---|---|---|---|
| **1** | Worker | Two migrations + registry, R2 bucket and binding, media upload/serve routes | ~2h |
| **2** | Worker | `grading-core.js` (rubric resolution, mechanics filter, normalization), `word-list.js`, + tests | ~2.5h |
| **3** | Worker | The grading route: prompt assembly, cached call, structured output, error paths | ~2.5h |
| **4** | Management App | Rubric authoring — household defaults + per-course sparse override | ~2h |
| **5** | Management App | Review surface: proposal, accept/override, score lands via completion path | ~2.5h |
| **6** | Child App | Capture UI: camera input, online-required submit, proposal display | ~2.5h |
| **7** | Management App | Remediation report over `mechanics_findings` | ~1.5h |
| **8** | — | §9 acceptance checks against a real database, budget-device smoke test | ~1.5h |

**~17 hours across eight sessions.** Up from the ~12h first estimate: the tunable rubric
adds phase 4, the list-plus-model mechanics arm adds to phase 2, and the remediation
record adds phase 7. Each phase leaves the system working.

Phases 1–3 are Worker scope, 4/5/7 Management App, 6 Child App — separately declared per
§I.A.

**Phase 3 is the only phase that spends money.** Everything before it is free to build and
free to abandon.

### Acceptance checks

1. A device token is 401 on `/api/grading/keys` and `/api/grading/remediation`; a
   `SYNC_TOKEN` is 401 on `/api/grading/page`.
2. A grading call for child A's assignment cannot be requested with child B's token.
3. `assignments.grade` is unchanged by `/api/grading/page`. Verified by direct read.
4. Accepting a proposal writes `grade` through the completion path, with
   `updated_by = 'device:<id>'` as any other completion.
5. A rubric with `spelling: 'off'` still produces `mechanics_findings` rows, all with
   `counted = 0`.
6. Two gradings of the same lesson in one sitting show a cache read on the second
   (`usage.cache_read_input_tokens > 0`).
7. An answer key is not fetchable without a token, and does not appear in the public asset
   bundle.

---

## 10. `CLAUDE.md` amendment required — v2.5

This slice cannot ship without it, and unlike §2.4 it is **not** an extension of an
already-approved narrowing. It is a new one:

- **§0's "Free tier only" row is narrowed.** Cloudflare infrastructure stays free-tier
  (Workers, D1, R2). Model inference is metered, estimated ~$7–11/month at ~240
  worksheets. Authorized by Ray in-session, 2026-08-15, after two rounds of the cost being
  put to him explicitly.
- **§VII gains a "Grading Assistant" locked-decision row**, and a note that the paid-API
  narrowing is scoped to this milestone and does not generalise to other services.
- **§III.A gains a third narrowing**, of the existing class: grading requests are
  online-required. The Child App's local-first guarantee for completions is untouched.
- **§I.A's Data Flow cell** gains the four `/api/grading/*` routes and the two
  grader-owned tables, restated in the same breath that this widens nothing on
  `assignments`.

Also recorded: **images of children's work leave the household** for a third-party API.
Accepted by implication rather than by explicit statement; §11.1.

---

## 11. Open items

1. **Retention and privacy — resolved 2026-08-15, before Phase 3 build began.** Ray
   confirmed plainly: children's handwriting going to the Anthropic API is accepted.
   Captured photos are **kept indefinitely in R2 for now** — no deletion-on-accept logic
   in Phase 3 or Phase 5; revisit as a migration later if retention becomes a concern.
   This closes the item raised twice in-session that §10 required answered before any
   spend.
2. **The 20-page accuracy test is unrun.** No longer a gate, but it is the tuning corpus
   for phase 3's prompt. See `Grading_Assistant_Pre_Build_Test.md`. Running it before
   phase 3 rather than after would save a tuning round.
3. **Fry level mapping is a guess** until real results exist. One constant, §3.1.
4. **Math is unvalidated.** Every accuracy claim in this slice rests on reading
   comprehension, where the answer is a short phrase. Shown-work math is a different
   problem and should not be enabled on a course until tested separately.
5. **Re-grade policy.** §1.1 says a re-grade replaces the row. If you later want grading
   history per assignment, that is a second table, not a change to this one.
