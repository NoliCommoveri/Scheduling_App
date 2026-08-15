# Grading Assistant — Pre-Build Test Kit

**Date:** 2026-08-15 · **Status:** decision-gate artifact, not a design document.

> **This is not a TDS slice and nothing here is approved scope.** It is the
> zero-cost accuracy test that runs *before* a TDS is authored, to decide whether
> the grading assistant is worth building at all. A session that finds this file
> should not treat it as a licence to build.
>
> **Two gates are open and both are Ray's to close:**
>
> 1. **`CLAUDE.md` §0 / §VII lock "free tier only."** The Anthropic API is metered
>    (est. ~$7–11/month at ~240 worksheets). This is a §V.A halt requiring the same
>    explicit in-session sign-off the three previous narrowings received.
> 2. **No TDS slice exists** for this milestone. Per §II.2, missing TDS = HALT.
>
> If the test below passes, its results become the accuracy baseline *in* that TDS.
> If it fails, no TDS is needed.

**Purpose:** decide whether to build the grading assistant, before writing any code.
**Cost:** $0 (run it in claude.ai, not the API).
**Time:** about 90 minutes, including your own grading.

---

## 0. Before you start — three rules

1. **Grade the 20 pages yourself FIRST**, on paper, and put your marks away.
   If you look at Claude's output first you will anchor to it and the test is worthless.
2. **Use Claude Sonnet 5** for the main run. That's the model the build would default
   to. If it passes, you're on the cheap path. Section 5 says when to retry on Opus 5.
3. **Attach the answer key BEFORE the photo**, every time. Not cosmetic — it mirrors
   the request ordering the Worker would use, and ordering is what makes the answer
   key cacheable later. Testing in the wrong order measures a system you aren't building.

---

## 1. Choosing the 20 pages

Do **not** pick at random. Pick deliberately — you are trying to find the edges:

| Count | What |
|---|---|
| 11 | Typical, unremarkable completed pages |
| 3 | Your worst handwriting — whichever child, whichever day |
| 2 | Pages with crossed-out or reworked answers |
| 2 | Pages with at least one blank or half-finished item |
| 2 | Pages where *you* had to think about whether the answer counted |

Spread across at least two children if their handwriting differs.

**If you want a read on math too:** make 5 of the 20 math pages, and score them on a
separate sheet. Math is a different problem with a different failure mode and mixing
the numbers will hide both.

---

## 2. The prompt

For each page: start a **new conversation**, attach the answer key PDF, attach the
photo, then paste the text below with the bracketed parts filled in.

New conversation each time. A prior page in context will contaminate the next one.

---

You are grading one completed worksheet for a homeschool student. The answer key
is attached first; the student's completed page is the photograph attached after it.

Context for this page:
- Course: [e.g. Language Arts Level E]
- Unit / Lesson: [e.g. Unit 1 Reading Around the World — Making Inferences]
- Student's approximate grade level: [e.g. 5th grade]

How to grade:

- The answer key gives a MODEL answer, not the only acceptable one. Accept any
  response that conveys the same idea. Do not require the key's wording, phrasing,
  or level of detail.
- Judge against what is reasonable for the stated grade level, not against an adult
  standard. Incomplete sentences, weak spelling, and informal phrasing are not errors
  unless the item is specifically testing those things.
- Mark an item BLANK if it was not attempted. Do not mark it incorrect. These are
  different and they matter differently.
- Do not invent errors. If the answer is acceptable, say so plainly.
- If you cannot read the handwriting, or you genuinely cannot tell whether an answer
  should count, mark the item UNSURE and say why. An honest UNSURE is more useful to
  me than a confident guess. Do not guess.

Return exactly this, and nothing else:

**Per item:**
| # | What the student wrote (transcribe it) | Verdict | One-line reason |

Verdict is one of: CORRECT, PARTIAL, INCORRECT, BLANK, UNSURE.

**Score:** X out of Y (count PARTIAL as half; exclude BLANK and UNSURE from the
denominator and note how many you excluded).

**Feedback for the student:** two or three sentences, addressed to the child, warm
and specific. Name one thing they did well and at most one thing to work on.

---

## 3. Why the transcription column matters

Asking Claude to write out what it *thinks* the student wrote separates the two
failure modes that look identical in the score but have completely different fixes:

- It misread the handwriting → an image-quality or capture problem. Fixable with
  better photos, a phone stand, more light.
- It read the answer correctly and judged it wrong → a rubric problem. Fixable by
  tuning the prompt.

Without that column you can't tell them apart and you can't fix either.

---

## 4. The scoring sheet

One row per page. Fill it in by comparing Claude's output against the marks you made
in step 0.

| Page | Lesson | Items | Claude's score | My score | Items I'd override | Failure codes |
|------|--------|-------|----------------|----------|--------------------|---------------|
| 1    |        |       |                |          |                    |               |
| 2    |        |       |                |          |                    |               |
| 3    |        |       |                |          |                    |               |
| …    |        |       |                |          |                    |               |
| 20   |        |       |                |          |                    |               |

### Failure codes

Write one code per disagreement, in the last column.

| Code | Meaning | Severity |
|---|---|---|
| **T** | Transcription — misread the handwriting | Fixable with better photos |
| **H** | Too harsh — a correct answer marked wrong | Annoying, but **visible** to you |
| **L** | Too lenient — a wrong answer marked right | **Dangerous — silent** |
| **B** | Blank mishandled — marked an unattempted item wrong, or vice versa | Moderate |
| **I** | Invented — flagged an error that isn't there | Moderate |
| **U** | It said UNSURE | **Not a failure — count separately** |

**On U:** an UNSURE is the system working correctly. It means the grader declined to
guess and handed the item to you, which is exactly what you'd want. Tally these, but
never count them against the agreement rate.

**On L versus H:** these are not equally bad. A too-harsh mark surfaces itself — the
child objects, you look, you fix it. A too-lenient mark is silent and inflates the
record permanently. Weight L far more heavily when you read the results.

### Totals

- Total items graded across all 20 pages: **______** (expect roughly 120–180)
- Items I'd override: **______**
- **Per-item agreement = 1 − (overrides ÷ total items) = ______ %**
- Count of **L** (silent lenient): **______**
- Count of **U** (honest unsure): **______**

---

## 5. Reading the result

Judge on **per-item agreement**, not per-page. Twenty pages is too small a sample;
the ~150 items underneath them are not.

| Agreement | L count | Verdict |
|---|---|---|
| ≥ 95% | 0 | **Build it.** Integration is the whole remaining value and it's the part I'm confident about. |
| ≥ 90% | ≤ 2 | **Build it**, with the parent-approval gate mandatory — which it already is in the design. |
| 80–89% | any | **Borderline.** Go run the timing test in §6; let that decide. |
| < 80% | any | **Don't build.** No amount of integration rescues this. |
| any | > 5 | **Don't build**, even at high agreement. Silent leniency on a child's academic record is the one failure this system must not have. |

**Before accepting a bad result, check whether it's the photos.** If most of your
disagreements are coded **T**, the grader isn't the problem — the capture is. Retake
those pages flat, in good light, filling the frame, and re-run just those. That's a
solvable problem and it would be a shame to kill the project over it.

**If it lands at 85–92%, retry the disagreements on Opus 5.** That tells you whether
the harder model rescues them — which is a real, concrete answer to "is Opus worth
roughly $4 a month more," rather than a guess.

---

## 6. The timing test — the honest arbiter

Agreement rate isn't actually the thing you care about. The thing you care about is
whether reviewing a graded page is faster than grading it from scratch. If it isn't,
the tool is a machine for generating work.

So, with a stopwatch:

1. Grade **10 fresh pages by hand**, start to finish. Record the time.
2. Review **10 Claude-graded pages** — read each verdict, accept or override, done.
   Record the time.

**Review needs to be at least twice as fast.** If it isn't, the accuracy is too low
to trust at a glance, which means you're re-grading from scratch and also reading
Claude's homework. Walk away at that point regardless of what the agreement rate says.

---

## 7. What to send me

Whatever you've got — the totals block from §4 is enough on its own. Also useful:

- Two or three of the actual disagreements, with what Claude said and what you'd have
  marked. Those are what I'd tune the rubric against in phase 2.
- Anything that surprised you.
- Whether the "feedback for the student" paragraphs were something you'd actually
  show a child, or whether you'd suppress that feature. That's a real design fork and
  it's cheaper to decide now than after it's built.

From there: if it passes, the next step is the TDS slice, and these results go in it
as the accuracy baseline.
