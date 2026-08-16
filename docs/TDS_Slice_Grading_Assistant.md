# Technical Design Specification — Slice

## Scope: Grading Assistant — photo capture, AI-proposed grades, tunable per-course rubrics, and a mechanics-error record for remediation

**Date:** 2026-08-15 · **Status:** §11.1 confirmed 2026-08-15; Phases 1–7 shipped. §0.7 corrected 2026-08-16 (no offline photo queue — see `CLAUDE.md` v2.6). Phase 7 also built the §5 `GET /api/grading/remediation` route, which Phase 3 had not — see §9's note. §11.2–5 remain open, none blocking. Answer key upload built 2026-08-16 (§4, §5) — the
route had shipped in Phase 1 with no screen calling it; answer keys key to the *instance*
Lesson, decided the same day. The bulk screen (§4.2) followed the same day, over the same
three routes — a course's Lessons keyed from one page instead of one drill-down each.
**§12 drafted 2026-08-16 and not built:** the slice assumed one page per assignment and
real assignments are 2–8, so the shipped build silently replaces page 1's proposal with
page 2's. §12 amends §1.1, §4, §5 and §6 for multi-page capture and a composite grade, and
is blocked on the §12.9 `CLAUDE.md` amendment and the §12.8 cost re-authorization.

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

*(The second sentence held until §12. Column **ownership** is still untouched there — the
grader writes only its own two tables — but §12 changes `POST /api/grading/page`'s shape
and `grading_reviews.photo_key`'s meaning. See §12.1.)*

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
| `keys/{lesson_id}` | Answer key PDF | Management App upload — Assigned Courses → the Course → **Answer keys** (all Lessons at once), or → the Lesson (one at a time) |

**`lesson_id` here is the *instance* Lesson's id, not the template's.** [DECISION] Ray,
in-session 2026-08-16. `stampCourse` mints fresh lesson ids per instance
(`instances.js:107`), and `resolveGradingContext` reads the key off the activity's own
lesson, so a key uploaded here belongs to one child's run of one course. That is the
intent, not an oversight: curriculum editions change between years, and a template-wide
key would quietly serve last year's answers to this year's child. The cost is accepted —
two children on the same course in the same year need the same PDF uploaded twice, and
each gets its own §6 cache prefix rather than sharing one. Do not "fix" this to
`sourceTemplateId`'s lesson to recover the shared prefix.

**Neither prefix is ever public.** `wrangler.toml` sets `[assets] directory = "./"`, so
anything in the repo is world-downloadable — which is why answer keys must live in R2 and
never in the tree. The failure mode is not merely a licensing one: a child with the app
URL could otherwise fetch the answer key to the page they are about to do. Access is
Worker-mediated and token-gated on both prefixes.

Bucket creation is a dashboard action and the binding is a `wrangler.toml` edit deployed
from GitHub. No CLI step, per §0.

### 4.2 The bulk answer-key screen

Added 2026-08-16, after the per-Lesson panel shipped the same day. Same three routes, no
schema change, no new field — this is a second *shape* of the same upload, sized to the
job it is actually used for. A parent starting a term has a folder of PDFs and a course of
twenty Lessons; the per-Lesson panel made that twenty drill-downs, each with its own
network round trip, and the count of what was still missing existed only in the parent's
head.

One page per Course Instance, reached from the Course, listing every Lesson with:

- what it currently has — uploaded date and size, "no answer key yet", or the honest
  "could not check" when the probe failed (the distinction §4.1's `listAnswerKeys` already
  drew for the badges);
- a file box of its own, for the single key you came to fix;
- what is staged against it, before anything uploads.

Files reach a Lesson two ways. Either its own box, or the multi-file picker at the top:
pick the whole folder and `management-app/js/answer-keys-core.js` places the ones whose
filenames unambiguously name a Lesson — by its code (`L02`), its title, or its number, in
that order of confidence. Everything else waits in a tray with a dropdown and a stated
reason. **The matcher is deliberately conservative**: matching is token-anchored rather
than substring (so `level1.pdf` is not lesson `L1` by code), a tier never falls through to
a weaker one to break its own tie, and both directions of ambiguity — two Lessons matching
one file, two files matching one Lesson — leave every file involved in the tray. A wrong
placement arms a Lesson with another Lesson's answers and surfaces weeks later as nonsense
grades; an unplaced file is a visible task on screen. The matcher is pure and DOM-free,
tested directly in `tests/management-answer-keys-core.test.js`.

Nothing uploads until **Upload all**. The run is sequential — these are multi-megabyte
PDFs on a home connection — and it is **not a transaction**: each Lesson's outcome is
written to its own row as it lands, a failure leaves that file pending, and pressing the
button again retries exactly what did not go up. Replacing existing keys is confirmed once,
before the run, naming the Lessons affected. `GET /api/grading/keys` is chunked at 100
lessonIds per request against the route's 200 cap (§5), which one long course is the first
thing that would ever reach.

---

## 5. Worker routes

Two credential groups. **The child's tablet uses the first two; the parent uses the rest**,
and the Worker rejects the wrong credential on each. On the device routes the Worker
derives `child_id` from the token (§0.2) and **no route accepts a `childId` in the body**.
On the parent routes the lesson or assignment is named in the path or query as it is on
every other `SYNC_TOKEN` route, that token being full-scope by definition.

*(This paragraph opened "All four take a device token" until 2026-08-16, while the table
under it already listed two as `SYNC_TOKEN` — a contradiction the shipped Worker never
had. The review surface's three routes in §9 were always parent-authenticated too.)*

| Route | Purpose |
|---|---|
| `POST /api/grading/page` | Upload a photo, create the `grading_reviews` row, run the grading call, return the proposal. Online-required. |
| `GET /api/grading/review/:assignmentId` | Read back a proposal. |
| `POST /api/grading/keys` | Parent uploads an answer key PDF for a lesson. `SYNC_TOKEN` only. |
| `GET /api/grading/keys` | Which lessons have a key — id, size, upload time. Never the PDF itself. `SYNC_TOKEN` only. |
| `DELETE /api/grading/keys` | Parent removes a lesson's key. `SYNC_TOKEN` only. |
| `GET /api/grading/remediation` | Aggregated `mechanics_findings` for a child. `SYNC_TOKEN` only. |

The two key-management routes were added 2026-08-16, alongside the screen that calls them.
`POST` had shipped in Phase 1 with nothing in any app calling it, which left the "written
by: Management App upload" in §4's table true only of curl — the one thing `CLAUDE.md` §0
says is never acceptable. A screen has to say whether a key is already there and be able
to take a wrong one away again; these answer that, and neither returns a stored PDF.

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
| **7** | Worker + Management App | Remediation report over `mechanics_findings`, including the §5 `GET /api/grading/remediation` route Phase 3 didn't build | ~1.5h |
| **8** | — | §9 acceptance checks against a real database, budget-device smoke test | ~1.5h |

**~17 hours across eight sessions.** Up from the ~12h first estimate: the tunable rubric
adds phase 4, the list-plus-model mechanics arm adds to phase 2, and the remediation
record adds phase 7. Each phase leaves the system working.

Phases 1–3 are Worker scope, 4/5 Management App, 6 Child App, 7 both (declared as such —
§5's route table listed `GET /api/grading/remediation` from the start, but no Worker phase
ever built it; Phase 7 closes that gap in the same session as the report that reads it,
rather than opening a ninth phase for a single ~15-line handler) — separately declared per
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

---

## 12. Multi-page assignments — amendment, 2026-08-16

**Status:** drafted, not built. Requires the `CLAUDE.md` amendment in §12.9 and the cost
re-authorization in §12.8 before any code.

### 12.0 What this corrects

The slice was designed around one photograph per assignment. §5 names the route
`POST /api/grading/page`, §4 keys a single R2 object at `pages/{assignment_id}`, §1.1
makes `assignment_id` the primary key of `grading_reviews`, and §6's prompt carries
exactly one image. Every one of those is internally consistent, and all of them assume a
fact that is not true of this household: **an assignment is 2–8 pages**, most often a
multi-page PDF activity type.

Two further facts, established the same day and load-bearing for §12.5 and §12.5.1: an
answer key is scoped to a **lesson**, and a lesson is split into **up to four assignments
on different days**; and within an assignment, some pages are read-only and are never
photographed. The photographs are therefore always a subset of what the key answers, and
the key is re-sent on each of the four assignments.

The shipped build does not fail on the second page. It silently replaces the first:
`MEDIA.put` writes the same key, and `saveGradingOutcome`'s
`ON CONFLICT (assignment_id) DO UPDATE` rewrites every column of the row. The parent's
review queue then shows a `proposed_score` for whichever page was photographed last,
presented as the assignment's grade. `mechanics_findings` is append-only and *does*
accumulate across pages, so the remediation report looks correct while the grade beside it
is not — which is what makes this worth writing down rather than treating as an obvious
bug.

[DECISION] Ray, in-session 2026-08-16.
**Decided:** an assignment is captured and graded as a whole. Every page goes up in one
request and produces one composite proposal.
**Rationale:** it is the only shape that yields a grade for the thing the parent actually
accepts. It also grades better — the model sees the full worksheet against the full key,
so continued items and back-references resolve — and it sends the answer key once per
assignment instead of once per page, which is the single largest cost lever in the feature
(§12.8).
**Locked for:** the Grading Assistant milestone.

### 12.1 What this repeals

The slice's opening claim — *"It changes no existing column's ownership and no existing
route's contract"* — is no longer true of the second half. Column **ownership** is still
untouched: the grader still writes only its own two tables, and §0.1 stands unchanged. But
`POST /api/grading/page` changes shape, `grading_reviews.photo_key` changes meaning, and
§6's prompt contract gains a page dimension. Recorded here rather than quietly amended in
place.

Nothing about §0.1 (never writes `assignments.grade`), §0.2 (no new credential class),
§0.3/§0.4 (mechanics as a separate axis, recorded regardless of counting), §0.5 (word list
as post-filter), or §0.7 (online-required, nothing queued) changes.

### 12.2 Schema

One migration, `migrations/0014_grading_page_count.sql`, registered in
`management-app/worker/migrations.js` in the same commit per `CLAUDE.md` §III.D.

```sql
ALTER TABLE grading_reviews ADD COLUMN page_count INTEGER NOT NULL DEFAULT 1;
```

`grading_reviews` stays **one row per assignment** — that is what makes the score
composite, and it is why the table needs a column rather than a child table. `items` is
already JSON and already holds the whole array; it now spans pages (§12.5).

`photo_key` changes meaning from *an object key* to *a prefix*. Pages are stored at
`pages/{assignment_id}/{n}`, `n` 1-based in capture order, and `page_count` says how many
exist. §4's table is amended accordingly.

**Legacy rows.** Any row written before this ships has `page_count = 1` and a flat object
at `pages/{assignment_id}` with no `/1` suffix. The photo-serving route
(`GET /api/grading/review/:id/photo`) resolves `pages/{id}/{n}`, then falls back to
`pages/{id}` when `n = 1` and the prefixed object is absent. This fallback exists only to
keep already-captured work visible; it can be deleted once Ray confirms no live rows
predate the change, and the deletion is a code change with no migration.

**No deletion of superseded pages.** A re-grade overwrites `pages/{id}/1..n` and, when the
new set is shorter, leaves orphans above the new `page_count`. Consistent with §11.1 —
photos are kept indefinitely for now — and the orphans are unreachable, since every read
is bounded by `page_count`.

### 12.3 Re-grade is whole-set

[DECISION] Ray, in-session 2026-08-16.
**Decided:** a re-grade re-shoots every page. There is no single-page re-shoot.
**Rationale:** §1.1's existing rule — a proposal is a draft with no ledger property to
protect — extended without modification. Per-page re-shoot would require page-level
proposal state, which is the second table §11.5 already rules out, to solve a problem the
parent's override already solves. Ray's stated preference is to teach good captures and
override the rest.
**Locked for:** the Grading Assistant milestone.

### 12.4 Routes

| Route | Change |
|---|---|
| `POST /api/grading/pages` | **Replaces** `POST /api/grading/page`. Takes `multipart/form-data`, one file part per page, in page order. `?assignmentId=` unchanged. Device token, online-required — §0.2 and §0.7 unchanged. |
| `GET /api/grading/review/:assignmentId` | Response gains `pageCount`. Existing fields unchanged. |
| `GET /api/grading/review/:id/photo` | Gains a `?page=n` parameter, defaulting to 1. `SYNC_TOKEN` only, unchanged. |

`multipart/form-data` rather than a JSON array of base64 strings: the upload leg stays raw
bytes instead of paying a 33% encoding tax twice, `request.formData()` is native to
Workers, and the Child App needs no build step to produce it (`CLAUDE.md` §0).

The route is renamed rather than extended because the singular name is now actively
misleading, and both ends of the contract are ours and deploy together. The old path is
**not** kept as an alias — a device pinned to it would silently keep single-page
behaviour, which is exactly the failure this amendment exists to remove.

### 12.5 Prompt contract — amends §6

Block ordering, with the cache breakpoint in the same place:

```
1. Answer key PDF          ← stable per lesson
2. Resolved rubric text    ← stable per course
3. Lesson / course context ← stable per lesson
   ──── cache breakpoint, 1h TTL ────
4. Page 1 image
5. Page 2 image
   … through page N, in capture order
N+4. Output instruction
```

The cached prefix is unchanged and is now sent **once per assignment** rather than once
per page.

`GRADING_OUTPUT_SCHEMA` gains a `page` integer on each item — 1-based, matching the image
order. Without it a wrong verdict cannot be traced back to the page it came from, which is
the same diagnostic argument §6 already makes for requiring `transcription`. `items` order
remains item order across the whole assignment; `page` is attribution, not ordering.

`GRADING_OUTPUT_INSTRUCTION` changes "Grade every item on the page" to name the set: every
item across all pages of the assignment, in the order given, numbering continuously and
recording each item's page. Items continued across a page break are one item, graded once.

**The key covers more than the assignment, and the instruction must say so.** Two facts,
both from Ray in-session 2026-08-16: an answer key is scoped to a whole **lesson** (§4),
while a lesson is split into **up to four assignments on different days**; and within an
assignment, some pages are read-only and are never photographed. So the photos are always
a *subset* of what the key answers — often a small one — and that is the normal case, not
a degraded one.

The instruction therefore bounds the graded set to what is visible: grade only items the
child's photographs actually show, transcribing from the photo in every case; do not
produce an item for anything the key covers but the photos do not; and do not treat a
key item's absence from the photos as unattempted work.

This matters more than it looks. Without the bound the model emits verdicts for the whole
lesson's items on every one of the four assignments. `BLANK` is excluded from
`normalizeScore`'s denominator (§8), so the *number* survives — which is exactly why this
would not announce itself. What breaks is the review surface: the parent opens one day's
assignment and finds it listing items from the other three days, and `mechanics_findings`
accrues rows for work that was never photographed, quietly poisoning the remediation
report §0.4 exists to feed.

`normalizeScore` (`grading-core.js`) needs **no change** — it already folds an array of
items against the rubric, and a longer array from more pages is the composite score by
construction. Stated explicitly so nobody adds per-page averaging, which would weight a
2-item page equally with a 20-item one.

### 12.5.1 The 1-hour cache no longer pays — and currently costs

§6 set `cache_control` with a 1-hour TTL on the third block, reasoning that "a household
grading three children's copies of one lesson in a sitting pays full price once and
roughly a tenth of it twice more." Three facts established 2026-08-16 each independently
remove that sitting:

1. **Siblings do not overlap.** The second child reaches a lesson roughly a year later
   (which is also why §12's grade-level text in block 2 is safe to leave alone — by then
   the label matches).
2. **A lesson splits across days.** Up to four assignments, on different days. No TTL the
   API offers spans a day, let alone four.
3. **Batching removes the within-assignment repeat.** §12's whole point is that an
   assignment is now one call, not one per page — which is the last case that was landing
   inside the hour.

So the cached prefix is written and, in ordinary use, never read. That is not neutral:
a 1-hour cache write bills at **2×** normal input rate, against **1.25×** for the
5-minute tier and **1×** for not caching at all. On the largest input in the request —
a whole lesson's answer key — the shipped setting is paying double for insurance that
cannot pay out.

[DECISION] Pending Ray.
**Proposed:** drop to the **5-minute default** (`cache_control: { type: 'ephemeral' }`,
no `ttl`) rather than removing `cache_control` entirely.
**Rationale:** 5-minute is cheaper than 1-hour at every call count, and unlike removal it
still pays out in the one case that survives — two assignments of the same lesson landing
on the same day and graded back to back, which the "up to four" split does not forbid. The
premium if that never happens is 0.25× on the key; the saving when it does is 0.9×. Buying
the option is worth more than the premium.
**Alternative, if same-day pairs never occur in practice:** remove `cache_control`
altogether for a flat 1× on every call. This is the strictly cheapest option under Ray's
stated pattern and should be taken if he confirms assignments of one lesson never share a
day.

Block ordering in §12.5 stays key-first regardless. It costs nothing, and it is what makes
the same-day case cacheable at all.

### 12.5.2 The answer key is the cost, and it may not need to be whole

Measured against a real course, `MIAPHYSCI6` (66 lessons, imported from the CSV Ray
supplied 2026-08-16):

| | |
|---|---|
| `pdf` activities — the graded assignments | **158** |
| `pdf` activities per lesson | 2 (×34), 3 (×11), 4 (×12), 1 (×9); mean 2.4 |
| Workbook pages per assignment | mean 5.2, range 1–14 |
| L03 "Matter Transformed" | four assignments — pp. 43–47, 48–51, 52–53, 54–55 |
| L03's answer key | 23 pages, 2.3 MB, 249 image XObjects, 65 embedded JPEGs |

The key is **image-heavy**, so it bills near the top of the per-PDF-page range, and at ~23
pages it is roughly **three-quarters of every grading request** — against ~3 photographed
pages at ~4,784 tokens each. It is then re-sent on each of that lesson's 2–4 assignments,
uncacheably (§12.5.1).

So the single largest lever in this feature is not the cache, the model, or the effort
level. It is **how much of the answer key each call carries**.

**The span is already known.** Correcting §12.11's fourth item: `pageRangeStart` /
`pageRangeEnd` ride the course-import CSV and are persisted on the activity record for any
Activity Type with `structurePattern: 'page-range'` — which `pdf` activities are. The
Worker's `resolveGradingContext` already loads that activity. Every grading call therefore
knows the workbook pages its assignment covers, today, with no schema change.

**What is not known is the mapping.** L03's 23 key pages cover 13 workbook pages
(43–55), so answer-key page *n* is not workbook page *43 + n − 1*. Determining the
relationship needs the key's internal structure read page by page, which this session could
not do — the container has no PDF renderer and `pypdf` would not install. Until someone
reads one, every option below rests on an unverified assumption.

Three ways forward, none yet chosen:

| Option | Effect | Cost |
|---|---|---|
| **A. Answer keys per `pdf` activity** rather than per lesson | Removes the problem outright — no mapping, no slicing, no over-sent pages, and §12.5's "the key covers more than the assignment" bound becomes unnecessary | Ray splits each key PDF by activity: 158 uploads for this course rather than 66. §4.2's matcher already places files by title, and "Day 2" / "Day 3" are in both the CSV and the filenames |
| **B. Per-lesson key + a stored page offset + Worker-side slicing** | Same token saving, one upload per lesson as today | Needs a PDF library bundled into the Worker, breaking the "no npm runtime dependencies" property `index.js`'s Phase 3 header claims; and needs the mapping to be regular enough for one integer offset to describe |
| **C. Change nothing** | — | ~$0.15 per assignment, ~$24 per course per child at introductory pricing |

**A is the recommendation**, on grounds beyond cost: it is the only option that also
deletes the phantom-items risk in §12.5 and the review-surface pollution that follows from
it, and it needs no new dependency and no heuristic. Its cost is Ray's labour, once per
course, in whatever tool splits the PDF — which is a real cost and his to weigh.

**Before any of this is chosen, measure rather than estimate.** The per-page PDF token
figures above are inferred from the file's structure, not observed.
`POST /v1/messages/count_tokens` against one real answer key returns the exact number, is
free, and needs no grading call. It should be the first thing done, because every figure in
§12.8 scales off it.

**What is *not* recoverable.** The key is re-sent, and re-billed, on each of the up-to-four
assignments per lesson. The Messages API is stateless and the Files API changes only how
bytes reach the request, not whether their tokens are charged — a `file_id` reference is
billed as input on every call exactly as inlined base64 is. Prompt caching is the only
mechanism that would avoid it, and no available TTL reaches across days. Recorded so no
future session re-derives this and reaches for the Files API expecting a saving.

### 12.6 Capture, sizing, and the guards

The Child App resizes each page to **2576px on the long edge** before upload, JPEG quality
0.8, via canvas. This is not a quality measure — it is the resolution Claude downscales to
on arrival regardless, so anything larger is upload time and request budget spent on
pixels the model never sees. A page lands at roughly 400–800 KB.

Per Ray, in-session 2026-08-16: **no capture-quality assistance beyond the resize** — no
blur detection, no framing guides, no re-shoot prompting. Children are taught to take good
photos; the parent overrides what comes out wrong. Do not add it later without asking.

The size guards are corrected in the same change, because the shipped ones count the wrong
thing. `MAX_GRADING_PHOTO_BYTES` (15 MB) and `MAX_ANSWER_KEY_BYTES` (20 MB) are each
enforced alone, but the Anthropic request carries **both, base64-encoded**: 35 MB of file
becomes ~47 MB on the wire, against a 32 MB request cap. Today's limits therefore already
permit a single-page request the API rejects — it has not bitten only because real phone
photos and answer-key PDFs are far smaller. Replacing them:

| Guard | Value | Why |
|---|---|---|
| `MAX_GRADING_PAGES` | 12 | Above the 8-page worst case with headroom; bounds the request before any byte is read. |
| `MAX_GRADING_PHOTO_BYTES` | 4 MB | Per page, post-resize. A resized page is well under; this catches a client that skipped the resize. |
| `MAX_ANSWER_KEY_BYTES` | 12 MB | Lowered from 20 MB so a maximal key can never alone exhaust the budget. |
| `MAX_GRADING_REQUEST_BYTES` | 20 MB | **New, and the one that matters**: answer-key bytes + summed page bytes, checked at grading time once the key is fetched. 20 MB raw is ~27 MB encoded, leaving margin under 32 MB for prompt text and JSON overhead. |

The combined check returns 413 naming which side is over, so "shrink the answer key PDF"
and "fewer pages" are distinguishable to the parent. The Child App's existing 413 copy
(`child-app/js/grading-core.js:81`, "That photo is too big") is per-photo and needs a
second message for the combined case.

### 12.7 Tests

`tests/` covers pure layers only (`CLAUDE.md` §I.B), so the batched call itself stays
covered by acceptance checks. Added to the existing grading suites:

1. **Score normalization across pages** — items drawn from several pages fold to one
   score; `BLANK`/`UNSURE` still leave the denominator; a page contributing no items does
   not change the result.
2. **Page attribution** — items carry the page they came from, and the count of distinct
   pages never exceeds `page_count`.

The resize is DOM-bound (canvas) and is not unit-testable under this rule; it is acceptance
check 4 below.

### 12.8 Cost — re-authorization required

`CLAUDE.md` §0 narrows "free tier only" for this milestone at **~$7–11/month at ~240
worksheets**. That figure assumes one page per worksheet. It does not survive this
amendment, and the narrowing was authorized against the number.

**The answer key, not the photos, is the dominant term** — see §12.5.2 for the measured
course data behind this. A key covers a whole lesson and is re-sent on each of that
lesson's 2–4 assignments (§12.5.1), uncacheably across days. Per assignment, with L03's
real 23-page image-heavy key and ~3 photographed pages:

| Component | Tokens | Note |
|---|---|---|
| Answer key PDF | ~35–70K | 23 pages, image-heavy. Charged again on each assignment of the lesson. |
| Photographed pages | ~14K | ~4,784 per page at 2576px; read-only pages are never sent. |
| Rubric, context, instruction | <1K | |
| Output | ~2K | Bounded by `max_tokens: 8000`. |

≈65K input, ~2K output → roughly **$0.15 per assignment** on Sonnet 5 at introductory
pricing, **~$0.22** once that ends on 2026-08-31. A course on the `claude-opus-5` override
runs roughly 2.5× that.

**Per course, per child: ~158 assignments → ~$24**, or ~$35 after 2026-08-31. Multiply by
courses run concurrently and by children. Spread over a nine-month year, one course is
~18 assignments/month; §0's "~240 worksheets" would be roughly six courses' worth of
assignments, at **~$16–24/month** — against the $7–11 that figure was quoted with.

**These are estimates, and one measurement replaces them all.** The per-PDF-page token
figures are inferred from the file's structure, not observed.
`POST /v1/messages/count_tokens` against one real answer key is free, needs no grading
call, and pins the largest term in the table. Do it before authorizing anything.

Four things move the number, in descending order of leverage: **sending only the relevant
answer-key pages** (§12.5.2) cuts ~80% off the dominant term and is worth more than
everything below combined; **dropping the 1-hour cache TTL** (§12.5.1) removes a 2×
write premium that never pays out, and is free; **fewer, larger assignments per lesson**
cuts key re-sends proportionally and is a pacing decision, not a code one; and
**`effort: 'medium'`** is already the cost-disciplined setting and should not be raised
without re-running this table.

For contrast, the **shipped** per-page behaviour costs considerably more than this
amendment does — it re-sends the whole lesson key on *every photographed page* rather than
once per assignment, so a 3-page assignment pays for the key three times while still
producing a wrong grade. This change reduces spend against what is deployed today; it
increases it against the figure Ray was quoted. Both statements need to be in front of him.

**This is a §V.A halt.** Not because the money is large, but because §0's narrowing names
a figure and this triples it.

### 12.9 `CLAUDE.md` amendment required — v2.8

Smaller than v2.5's, and of a kind already established rather than a new departure:

- **§0's "Free tier only" row** — the `~$7–11/month` estimate is restated for multi-page
  assignments, per §12.8. The narrowing itself is unchanged and still milestone-scoped.
- **§I.A's Data Flow cell** — `POST /api/grading/page` becomes `POST /api/grading/pages`,
  and `GET /api/grading/review/:id/photo` gains its `?page=` parameter. Restated in the
  same breath that this widens nothing on `assignments`: the grading call still touches no
  `assignments` column, and the §I.A exception for the parent's accept/override is
  unchanged in scope.
- **§VII's Grading Assistant row** — a pointer to this section.

No new narrowing of §III.A, §III.E, or the column-ownership rule is sought or implied.

### 12.10 Phasing

| Phase | Scope | Contents | Est. |
|---|---|---|---|
| **A** | Worker | Migration 0014 + registry; `photo_key` as prefix; `POST /api/grading/pages` (multipart, N images, batched call); output schema gains `page`; corrected size guards | ~2.5h |
| **B** | Worker + Management App | `?page=` on the photo route; review surface renders all pages of a proposal | ~1.5h |
| **C** | Child App | Multi-select capture, canvas resize to 2576px, one submit for the set | ~2h |
| **D** | — | Acceptance checks below, on a real 5+ page assignment | ~1h |

~7 hours. Each phase leaves the system working; A alone fixes the wrong grade, and C is
what makes the capture usable. Per `CLAUDE.md` §V.A this exceeds one session — declare a
single scope per session, in order.

### Acceptance checks

1. A 5-page assignment produces **one** `grading_reviews` row with `page_count = 5`, and
   `proposed_score` reflects items from every page. Verified by direct read.
2. Five R2 objects exist at `pages/{id}/1` … `/5`; none at the flat `pages/{id}`.
3. `assignments.grade` is unchanged by `POST /api/grading/pages`. Direct read — §9's
   check 3, re-run against the new route.
4. Every uploaded page is ≤ 2576px on its long edge, taken from a phone camera that shot
   larger.
5. A 13-page submit is rejected 413 before any model call is made — no spend.
6. An answer key plus pages summing over `MAX_GRADING_REQUEST_BYTES` is rejected 413
   naming which side is over, before any model call.
7. A re-grade of a 5-page assignment with 3 pages leaves `page_count = 3`, and the review
   surface shows 3 pages.
8. A legacy single-page row written before this change still renders its photo.
9. An assignment covering part of a lesson produces **no items for the pages it did not
   photograph** — not `BLANK` ones, not any. Verified on a lesson whose key answers
   markedly more than the assignment's photos show, by reading `items` directly.
10. The same assignment writes no `mechanics_findings` rows attributable to unphotographed
    work — the count matches what appears in the transcriptions.
11. **Replaces §9's check 6, which no longer describes reachable behaviour.** With the
    5-minute TTL of §12.5.1: two assignments of one lesson graded back to back on the same
    day show `usage.cache_read_input_tokens > 0` on the second. Two graded on *different*
    days show a cache write and no read — expected, and the reason the 1-hour tier was
    dropped. If §12.5.1's alternative is taken and `cache_control` is removed, this check
    becomes "neither call reports cache activity" instead.
12. A device token is still 401 on the parent routes and a `SYNC_TOKEN` still 401 on
    `POST /api/grading/pages`.

### 12.11 Open items

1. **Page order is capture order, and nothing verifies it.** If a child photographs page 3
   before page 2, items are attributed to the wrong pages and any answer-key alignment
   that depends on order degrades. Deliberately unhandled per §12.6 — flagged so the
   symptom is recognisable if it shows up in review.
2. **The 32 MB cap is inferred, not measured.** `MAX_GRADING_REQUEST_BYTES` is set with
   margin rather than tuned. If a 12-page assignment with a large key ever 413s in normal
   use, raise the cap before lowering the page limit.
3. **§11.2's accuracy test is still unrun**, and is now more valuable than when it was
   written: multi-page grading is exactly where item numbering and cross-page
   continuation can go wrong, and none of it is unit-testable.
4. **~~Nothing tells the model which part of the lesson this assignment is.~~ Corrected
   2026-08-16 — the data exists.** This item originally claimed the assignment's page span
   was unrecorded and that naming it would be a schema question. It is recorded:
   `pageRangeStart` / `pageRangeEnd` arrive on the course-import CSV and are persisted on
   the activity record by `courses.js` `createActivity` and `instances.js`
   `createInstanceActivity`, for any Activity Type whose `structurePattern` is
   `page-range` — which is what `pdf` activities are. `resolveGradingContext` already loads
   that activity. Naming the span in the lesson-context block is therefore a prompt change
   against data already in hand, and should be done alongside §12.5's bound rather than
   held back as a fallback. See §12.5.2 for the larger thing this unlocks.
5. **Do same-day assignments of one lesson occur?** §12.5.1's choice between the 5-minute
   TTL and no caching at all turns on this, and only Ray can answer it. Neither option is
   wrong; the 5-minute default is the safe one under uncertainty.
6. **The billable-unit ambiguity in §12.8** — 240 worksheets, or 240 assignments? — must be
   resolved before the cost is re-authorized. It is a 4× spread.
