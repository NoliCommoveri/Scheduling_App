# Technical Design Specification — Slice

## Scope: Grading Assistant — photo capture, AI-proposed grades, tunable per-course rubrics, and a mechanics-error record for remediation

**Date:** 2026-08-15 · **Status:** authored for build, pending §12 confirmation.

**Applies to:** Child App (capture), Worker (grading route, rubric resolution, mechanics
filter), Management App (rubric authoring, review surface, remediation report). Three
declared scopes per `CLAUDE.md` §I.A; no runtime JS is shared between them.

**Builds on:** `TDS_Slice_Online_Revamp.md` (the shared `assignments` table, column-level
ownership, the `records` mirror, the outbox/drain model), `TDS_Slice_Wall_Display_App.md`
§6.4 (the online-required narrowing), and `TDS_Slice_Lesson_Recipe.md` D13 (the sparse
per-Course override pattern, reused verbatim here for rubrics).

**Repeals nothing.** This slice adds two tables, one column, one field on the Course
record, one R2 bucket, and five routes. It changes no existing column's ownership and no
existing route's contract.

---

## 0. Decisions made in this slice

1. **The grader never writes any `assignments` column.** The grading call writes a
   *proposal* into its own table, `grading_reviews`. It touches no column on the
   assignment row at all. This is the Wall App's pattern (`CLAUDE.md` §0) applied
   verbatim: own your own tables, widen nobody else's column.
2. **A grade has two columns: reported and verified.** `assignments.grade` stays exactly
   what it is today — child-owned, self-reported, written through
   `ASSIGNMENT_COMPLETION_FIELDS` from the child's tablet (`completion.js:67`). A new
   **parent-owned** column, `verified_grade`, holds the number the parent stands behind.
   Accepting a proposal writes the proposed score there; overriding writes the parent's
   own number there. The two halves stay disjoint, which is the property §III.B exists to
   protect — no credential gains the ability to write the other's column, and no conflict
   resolution is needed because the two writers never contend for a value.
   [DECISION] recorded at §2.
3. **No new credential class, and no new §III.E exception.** The child's device requests
   grading for its own assignment; the Worker derives `child_id` from the device token as
   it always has. The parent's accept/override runs under `SYNC_TOKEN` and writes only a
   parent-owned column. Unlike the Wall App, this feature needs no departure from
   derive-from-token — worth stating plainly so no future session invents one.
4. **Content and mechanics are separate axes.** Content correctness produces the number.
   Spelling and grammar findings are recorded and reported beside it, and never move the
   number. Rationale: `reporting.js:142` rolls up average grade per course, and a
   mechanics deduction applied to some courses and not others silently destroys the
   comparability of that rollup.
5. **Recording is decoupled from counting.** A rubric that sets `spelling: 'off'` means
   "do not mark the child down for this," **not** "do not track it." Findings are written
   to `mechanics_findings` either way, because the stated purpose of the axis is designing
   remedial work, and remediation needs the data from courses that don't penalise.
6. **The word list is a post-filter, never a prompt injection.** Fry's 1000 ships as a
   frozen Set in a Worker module. The model reports every suspected misspelling; the
   Worker decides which ones count. Injecting 1000 words into every request would cost
   ~1300 tokens per call and make the model's job fuzzier, not sharper. As a post-filter
   it is deterministic, free, and unit-testable.
7. **Rubrics need no migration.** A rubric is a field on the Course record. Course records
   already reach D1 inside `records` (`store = 'courses'`, `worker/index.js:61`) via the
   existing sync push, and the Worker reads them with `json_extract` exactly as migration
   `0002` does for children.
8. **Grading is online-required, and there is no offline capture.** Same class of
   narrowing as `claim_group` rows (§III.A) and the Wall App — not a new kind of
   departure. A capture with no network shows a message and the child tries again later;
   nothing is queued. **The child app's outbox is not extended.** It carries typed JSON
   ops — completions, reward entries, streaks (`outbox-core.js`) — and has never held a
   binary payload; teaching it to would be a new store, a new op type, and a new failure
   mode for a case a fixed-wifi household rarely hits. Completing the lesson or chore is
   unaffected and still works offline exactly as it does today; only the grading needs a
   connection.

---

## 1. Schema changes — summary

Three migrations. One field, no migration. One bucket.

| File | Change |
|---|---|
| `migrations/0012_grading_reviews.sql` | `CREATE TABLE grading_reviews (…)` — the grader's own proposal rows (§1.1) |
| `migrations/0013_mechanics_findings.sql` | `CREATE TABLE mechanics_findings (…)` — append-only remediation feed (§1.2) |
| `migrations/0014_verified_grade.sql` | `ALTER TABLE assignments ADD COLUMN verified_grade REAL` — parent-owned (§1.3) |
| *(none)* | `gradingRubric` — a sparse field on the Course record, carried by the existing `records` sync (§2) |
| *(none)* | R2 bucket `grading-media`, bound in `wrangler.toml` (§4) |

All three migrations register in `management-app/worker/migrations.js` in the same commit,
per `CLAUDE.md` §III.D — an `import` line and a `MIGRATIONS` entry each, matching the
existing eleven.

### 1.1 `grading_reviews`

One row per grading attempt. Not append-only — a re-grade replaces the row for that
assignment, because a proposal is a draft and there is no ledger property to protect.

| Column | Purpose |
|---|---|
| `assignment_id` | PK. One live proposal per assignment. |
| `child_id` | Denormalised for query; always matches the assignment's. |
| `photo_key` | R2 object key for the captured page. |
| `proposed_score` | REAL. The content score. **Never copied to any `assignments` column by the grading route** — only a parent's accept can move it, and only into `verified_grade` (§1.3). |
| `items` | JSON: per-item verdict, transcription, reason. |
| `feedback` | Text addressed to the child. |
| `rubric_digest` | Hash of the resolved rubric that produced this. §2.3. |
| `model` | Model id that graded it — so a later accuracy regression is attributable. §7. |
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
| `counted` | 0/1 — whether the rubric made it affect the child's feedback. Recorded either way (§0.5). |
| `source` | `'list'` \| `'model'` — which arm of §3.2 decided it. Lets you audit the two independently. |
| `found_at` | |

Indexed on `(child_id, intended)` — that index *is* the remediation report.

**Why a table and not JSON on `grading_reviews`:** migration `0002`'s own header makes
this argument for `children` — a projection exists "so reports and joins do not have to
parse JSON blobs." Same reasoning, same answer.

### 1.3 `assignments.verified_grade`

A single nullable `REAL`, added by `0014`. Parent-owned.

| Concern | Resolution |
|---|---|
| **Who may write it** | Added to `ASSIGNMENT_PATCH_FIELDS` (`worker/index.js:93`) — the parent-authenticated map. It is **never** added to `ASSIGNMENT_COMPLETION_FIELDS`, so no device token and no wall token can reach it. |
| **Who may write `grade`** | Unchanged: the child, via `ASSIGNMENT_COMPLETION_FIELDS`, exactly as today. The parent still cannot touch it, and `management-app/js/assignments.js:569` stays true as written. |
| **The effective grade** | `verified_grade` when non-null, otherwise `grade`. One helper, in the Management App's reporting layer. |
| **Reporting** | `reporting.js:102` and `:137` switch from `row.grade` to the effective grade. Averages therefore reflect the parent's correction where one exists, and the child's self-report where it does not. |
| **CSV export** | `reporting.js:167` gains a `verified_grade` column beside the existing `grade` rather than replacing it — an export that silently collapsed the two would destroy the distinction the columns exist to hold. |

**Why this is not a widening.** §III.B's rule is that the parent writes the top half and
the child writes the bottom half, and that the two sets are disjoint. Adding a column to
the parent's half satisfies that rule rather than bending it: the sets remain disjoint,
the Worker still enforces both maps, and neither client gains a column it could not write
before. It is an ordinary schema change described in a TDS, not a fourth narrowing — but
because §I.A's Data Flow cell is being amended anyway, it is listed in §11.

**Side benefit worth stating.** Because the two numbers are stored separately, the record
keeps what the child reported, what the AI proposed, and what the parent settled on, as
three distinct facts. A correction never destroys the original, which is the same instinct
§III.C applies to the reward ledger.

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
| `spelling` | `'off'` \| `'listOnly'` \| `'all'` | `'listOnly'` | Which misspellings are surfaced to the child. All are recorded regardless (§0.5). |
| `grammar` | `'off'` \| `'on'` | `'off'` | |
| `paraphraseTolerance` | `'strict'` \| `'normal'` \| `'generous'` | `'normal'` | How far from the key's wording an answer may sit. The main dial for reading comprehension. Defined by worked example, not by the word alone — §7.2. |
| `partialCredit` | boolean | `true` | Whether PARTIAL counts as half. |
| `houseRules` | free text | `''` | Prose appended verbatim to the prompt. The escape hatch — this is a household of three children, not a rules engine. Also where the tuning examples live (§7). |

### 2.2 Resolution is a pure function

`resolveRubric(courseOverride, householdDefaults) → rubric` and
`rubricToPrompt(rubric, gradeLevel) → string` are DOM-free and IO-free, and live in
`management-app/worker/grading-core.js`.

This is the point of the layer: the most behaviour-critical code in the feature becomes
directly testable in `tests/`, alongside `validation.js` and the `*-core.js` files, with
no network call and no D1. See §9.

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

**`gradeLabel` is optional and may be absent** (`children.js:48` writes it only when the
parent filled it in). A child with no grade label resolves to the **lowest** band, Fry
1–300 — the most forgiving reading, so a missing field can never cause a child to be
marked down for a word nobody established they should know. `resolveFryBand(gradeLabel)`
is a pure function in `grading-core.js` and is covered by §9's first suite.

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

> **Check before phase 1:** enabling R2 on a Cloudflare account requires a payment method
> on file even though this usage sits inside the free allowance. That is a two-minute
> dashboard step, not a bill — but it is a stop-the-world surprise if it is discovered
> mid-phase.

---

## 5. Worker routes

Five routes, in two credential groups. **Two are for the child's tablet and three are for
the parent**, and the Worker rejects the wrong credential on each.

| Route | Credential | Purpose |
|---|---|---|
| `POST /api/grading/page` | Device token | Upload a photo, create the `grading_reviews` row, run the grading call, return the proposal. Online-required. |
| `GET /api/grading/review/:assignmentId` | Device token | Read back a proposal for display on the child's tablet. |
| `POST /api/grading/review/:assignmentId/accept` | `SYNC_TOKEN` | Parent accepts or overrides. Writes `assignments.verified_grade` and sets `grading_reviews.state` in one statement pair. |
| `POST /api/grading/keys` | `SYNC_TOKEN` | Parent uploads an answer key PDF for a lesson. |
| `GET /api/grading/remediation` | `SYNC_TOKEN` | Aggregated `mechanics_findings` for a child. |

On the two device routes the Worker derives `child_id` from the token and **no route
accepts a `childId` in the body** (§0.3). On the three parent routes the assignment is
named in the path or body as it is on every other parent-authenticated route, and the
`SYNC_TOKEN` is full-scope by definition.

A `SYNC_TOKEN` on a device route and a device token on a parent route are both 401, the
same cross-credential property §III.E requires of the wall routes.

**The accept route writes an `assignments` column, and that is not a widening.** It writes
exactly one, `verified_grade`, it is parent-owned (§1.3), and the route is
parent-authenticated. No device token can reach it, and the child-owned `grade` is not in
that route's field map at all.

---

## 6. The prompt contract

Ordering is load-bearing and is fixed by the caching rule, not by taste:

```
1. Answer key PDF          ← stable across every child and page in this lesson
2. Resolved rubric text    ← stable per course (includes the §7 examples)
3. Lesson / course context ← stable per lesson
   ──── cache breakpoint, 1h TTL ────
4. The child's photo       ← volatile, one request only
5. Output instruction
```

Caching is a prefix match: everything before a change is reusable, everything after is
not. Key-first is what makes the answer key ride at roughly a tenth of input price when
you grade three children's copies of the same lesson in one sitting. Photo-first would
cost full price on every call.

**A 1-hour TTL, not the 5-minute default** — grading happens in sittings, and a lesson's
cached prefix has to survive the gap between one child finishing and the next starting. Be
clear-eyed about where the saving actually begins: a 1-hour cache write costs **double**,
against 1.25× for the 5-minute tier, so three gradings of one lesson sits **at** break-even
rather than past it, and the real saving starts on the fourth. The TTL is chosen for
surviving the gap, not for the first sitting's arithmetic.

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

## 7. Rubric tuning and the example set

The rubric fields in §2.1 are dials with names on them. Names are not calibration:
`'generous'` is not a quantity, and no amount of prose makes it one. This section is how
the rubric actually gets good, and it is the cheapest work in the whole slice.

### 7.1 The example set is harvested, not authored

**Do not write examples from imagination before the accuracy test runs.** Invented wrong
answers are wrong in tidy ways real children are not, and an example set built by guessing
at the model's failures encodes the guess rather than the failure.

`Grading_Assistant_Pre_Build_Test.md` already produces the raw material. Its §7 asks for
"two or three of the actual disagreements, with what Claude said and what you'd have
marked," and names them as the tuning input for this feature. The ordering is therefore:

```
run the 20-page test  →  keep the §4 scoring sheet  →  harvest the disagreements
                                                    →  they become houseRules examples (phase 4)
```

### 7.2 Three uses, in descending order of value

**a. The kept scoring sheet is a regression yardstick.** §1.1 stores `model` and
`rubric_digest` on every row so "a later accuracy regression is attributable" — but
attribution needs something to compare against, and nothing in the design currently
provides it. The completed §4 scoring sheet from the pre-build test *is* that baseline:
~20 pages, ~150 items, each with a known-correct verdict in Ray's hand. Filed rather than
discarded, it means a rubric edit or a model change can be re-run against known answers
instead of assessed by feel. This costs nothing beyond not throwing the sheet away, and it
is the single highest-value artifact this section produces.

**b. Worked examples are the only way to define `paraphraseTolerance`.** §2.1 calls it
"the main dial for reading comprehension" — the most consequential setting in the feature —
and then defines it as three adjectives. One matched pair per course closes that gap
better than a paragraph: an answer that *should* pass under `'generous'` and *should* fail
under `'strict'`, with a line saying which and why. The same technique pins the `UNSURE`
boundary from §6 — one example of handwriting bad enough to decline, one of handwriting
poor but readable. Those two boundaries are learnable from examples and essentially not
learnable from description.

**c. Few-shot examples in the prompt, kept small.** Harvested examples go in the rubric's
`houseRules` free text (§2.1) — **per course, not in one global document**. A single master
example file would apply reading-comprehension judgement to spelling lists and arithmetic
alike, which is the failure §0.4 already separates the axes to avoid.

### 7.3 Constraints on the set

| Constraint | Why |
|---|---|
| **5–10 examples per course, not 50** | Examples are the strongest single signal in a prompt: the model matches their length, tone and structure closely. A large set narrows the grader onto the shape of whatever you collected. |
| **Vary them; never ship one "gold" example** | A single exemplar freezes behaviour around itself. Several deliberately different ones teach a boundary instead of a template. |
| **Real answers only** | Taken from actual pages the children wrote. See §7.1. |
| **Prefer near-misses** | The pre-build test's failure codes rank **L** (too lenient) as the dangerous, silent failure and **H** (too harsh) as the visible, self-correcting one. The examples that carry information are therefore the wrong answers that *look* acceptable. A clearly-wrong answer teaches nothing the model did not already know. |
| **Watch the spill onto untested subjects** | §12.4 flags math as unvalidated. A set drawn entirely from short-phrase reading answers will make the grader worse at anything shaped differently, so per-course scoping (§7.2c) is load-bearing, not tidiness. |

**Cost is not the reason to keep the set small.** Examples sit in the rubric layer, above
the cache breakpoint in §6's ordering, so after the first grading of a lesson they are read
at roughly a tenth of input price. Keep the set small because more examples *narrow the
model*, not because they are expensive — the two arguments point the same way but only one
of them is true here, and a future session that optimises for tokens will cut the wrong
ones.

### 7.4 Where this lands in the build

No new phase and no new schema. Phase 4 (rubric authoring) gains the `houseRules` editor it
already needed, seeded with whatever the test produced; phase 8's acceptance run uses the
kept scoring sheet as its comparison rather than a fresh judgement call.

---

## 8. Guardrail compliance

Checked against `CLAUDE.md` §IV.B, since this slice touches three apps and adds a paid
dependency.

| Guardrail | Status |
|---|---|
| Column-level ownership | **Intact.** The grading call writes only the two grader-owned tables. The accept route writes one column, `verified_grade`, which is parent-owned and reachable only with `SYNC_TOKEN`. The child-owned `grade` and `ASSIGNMENT_COMPLETION_FIELDS` are untouched. |
| Parent/child halves disjoint | **Intact, and the reason this design works.** `grade` is child-only; `verified_grade` is parent-only; neither map contains the other's column. |
| `child_id` from token | **Intact.** No new exception; §III.E's rule is unmodified. |
| No CLI | **Intact.** Bucket via dashboard, binding via GitHub, migrations via Settings → Database. |
| Migrations registered | All three, same commit. |
| `.assetsignore` | **No change needed** — `docs/`, `*.md`, `migrations/` and `management-app/worker/` are already excluded. The word list and `grading-core.js` live under `worker/`, so they inherit that exclusion. Answer keys never enter the tree at all (§4). |
| Vanilla JS, no build step | Intact in all three browser apps. The Worker is bundled, as always. |
| Free tier only | **NARROWED.** See §11. |
| Local-first | **Narrowed, existing class.** §0.8. The Child App's completion guarantee is untouched; only grading requires a connection. |

---

## 9. Tests

`tests/` covers pure layers only. Four new suites, all against
`management-app/worker/grading-core.js` and `word-list.js`:

1. **Rubric resolution** — sparse override merges over defaults; absent keys fall through;
   an empty override resolves to defaults exactly.
2. **Fry band resolution** — each labelled band; **and an absent `gradeLabel` resolving to
   the lowest band** (§3.1).
3. **Mechanics filter** — each branch of §3.2, including the two that record with
   `counted = 0`, and the `source` attribution for both arms.
4. **Score normalization** — PARTIAL as half under `partialCredit`, `BLANK` and `UNSURE`
   excluded from the denominator, empty-denominator guard; and the effective-grade helper
   from §1.3 (`verified_grade` wins, `grade` when null, null when both are null).

The prompt assembly and the grading call itself are not unit-testable and are covered by
the §10 acceptance checks against a real database.

---

## 10. Phasing

| Phase | Scope | Contents | Est. |
|---|---|---|---|
| **1** | Worker | Three migrations + registry, R2 bucket and binding, media upload/serve routes | ~2h |
| **2** | Worker | `grading-core.js` (rubric resolution, Fry band, mechanics filter, normalization), `word-list.js`, + tests | ~2.5h |
| **3** | Worker | The grading route: prompt assembly, cached call, structured output, error paths | ~2.5h |
| **4** | Management App | Rubric authoring — household defaults + per-course sparse override, including the `houseRules` editor seeded per §7.4 | ~2h |
| **5** | Management App | Review surface: proposal, accept/override → `verified_grade`; effective-grade helper wired into `reporting.js` and the CSV export (§1.3) | ~3h |
| **6** | Child App | Capture UI: camera input, online-required submit, proposal display | ~2.5h |
| **7** | Management App | Remediation report over `mechanics_findings` | ~1.5h |
| **8** | — | Acceptance checks below against a real database, budget-device smoke test, re-run of the kept scoring sheet (§7.2a) | ~1.5h |

**~17.5 hours across eight sessions.** Up from the ~12h first estimate: the tunable rubric
adds phase 4, the list-plus-model mechanics arm adds to phase 2, the remediation record
adds phase 7, and the reporting change in §1.3 adds half an hour to phase 5. Each phase
leaves the system working.

Phases 1–3 are Worker scope, 4/5/7 Management App, 6 Child App — separately declared per
§I.A.

**Phase 3 is the only phase that spends money.** Everything before it is free to build and
free to abandon.

### Acceptance checks

1. A device token is 401 on `/api/grading/keys`, `/api/grading/remediation` and
   `/api/grading/review/:id/accept`; a `SYNC_TOKEN` is 401 on `/api/grading/page`.
2. A grading call for child A's assignment cannot be requested with child B's token.
3. `assignments.grade` **and** `assignments.verified_grade` are both unchanged by
   `/api/grading/page`. Verified by direct read.
4. Accepting a proposal writes `verified_grade` and nothing else on the row; `grade` is
   byte-identical before and after, and `updated_by` names the parent credential rather
   than a device.
5. A device token attempting to write `verifiedGrade` through `/api/completions` is
   rejected as "not a child-writable column" — the existing per-row rejection path, no new
   code.
6. With `verified_grade` set, the Management App's average-grade tile and CSV export both
   reflect the verified number; with it null, both reflect the child's `grade`.
7. A rubric with `spelling: 'off'` still produces `mechanics_findings` rows, all with
   `counted = 0`.
8. A child with no `gradeLabel` grades without error, and no finding is marked
   `counted = 1` from a word above Fry 300.
9. Two gradings of the same lesson in one sitting show a cache read on the second
   (`usage.cache_read_input_tokens > 0`).
10. An answer key is not fetchable without a token, and does not appear in the public asset
    bundle.

---

## 11. `CLAUDE.md` amendment required — v2.5

This slice cannot ship without it, and unlike the v2.4 amendment it is **not** an
extension of an already-approved narrowing. It is a new one:

- **§0's "Free tier only" row is narrowed.** Cloudflare infrastructure stays free-tier
  (Workers, D1, R2). Model inference is metered, estimated ~$7–11/month at ~240
  worksheets. Authorized by Ray in-session, 2026-08-15, after two rounds of the cost being
  put to him explicitly.
- **§VII gains a "Grading Assistant" locked-decision row**, and a note that the paid-API
  narrowing is scoped to this milestone and does not generalise to other services.
- **§III.A gains a third narrowing**, of the existing class: grading requests are
  online-required. The Child App's local-first guarantee for completions is untouched.
- **§I.A's Data Flow cell** gains the five `/api/grading/*` routes and the two
  grader-owned tables, restated in the same breath that the child-owned
  `ASSIGNMENT_COMPLETION_FIELDS` is unchanged.
- **§VII gains a "Reported vs verified grade" row**, recording that `assignments` carries
  two grade columns — child-owned `grade`, parent-owned `verified_grade` — and that this
  *satisfies* the disjoint-halves rule rather than narrowing it. Recorded here because
  §I.A is being amended anyway, not because it is a fourth departure.

Also recorded: **images of children's work leave the household** for a third-party API.
Accepted by implication rather than by explicit statement; §12.1.

---

## 12. Open items

1. **Retention and privacy, stated explicitly.** Raised twice in-session; accepted by
   implication rather than answered. Before phase 3 spends a cent, Ray should say plainly
   whether he accepts children's handwriting going to the Anthropic API, and whether
   captured photos should be deleted from R2 after a proposal is accepted (a one-line
   change now, a migration later).
2. **The 20-page accuracy test is unrun.** No longer a gate, but it is the tuning corpus
   for phase 3's prompt *and* the regression baseline for §7.2a. See
   `Grading_Assistant_Pre_Build_Test.md`. Running it before phase 3 rather than after
   would save a tuning round and is the input §7.1 depends on.
3. **Fry level mapping is a guess** until real results exist. One constant, §3.1.
4. **Math is unvalidated.** Every accuracy claim in this slice rests on reading
   comprehension, where the answer is a short phrase. Shown-work math is a different
   problem and should not be enabled on a course until tested separately — and §7.3's
   spill warning applies directly.
5. **Re-grade policy.** §1.1 says a re-grade replaces the row. If you later want grading
   history per assignment, that is a second table, not a change to this one.
6. **Whether a child ever sees the verified number.** §1.3 stores both, but nothing in
   this slice decides what the child's tablet displays when the two differ. Defaulting to
   showing the verified number when present is the obvious choice; it is called out here
   because it is a parenting decision rather than a technical one.
