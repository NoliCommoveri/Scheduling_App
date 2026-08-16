# Answer Key Transcription — the Claude Project procedure

**Date:** 2026-08-16 · **Status:** procedure for the §11.2 accuracy test, then for ordinary use
**Implements:** `TDS_Slice_Grading_Assistant.md` §12.5.3 — the answer key as text

Transcription is **not an app feature** ([DECISION], §12.5.3). Ray runs it in a Claude
Project on his own Pro subscription and pastes the result into the Management App. The app's
whole surface for this is a textarea. This document is the procedure that fills it.

**Why it exists:** an answer key PDF is ~three quarters of every grading request. As text it
is roughly a tenth the size — ~$150 for the school year against ~$420 (§12.8). The saving is
real only if the transcription is *right*, which is what most of this document is about.

> **Amended 2026-08-16.** The first version of this guide told you to split a key by
> **workbook** page ranges — "43-47, 48-51". Those numbers do not appear anywhere in an
> answer key, so that instruction asked the model to find something that was not on the page.
> §1 is new and explains what to use instead. §3's prompt and §4's message are rewritten
> around it. Phase F has since shipped, so the per-activity boxes §5 describes now exist.

---

## 0. The one risk that governs everything

**A wrong transcription is worse than no transcription.** It puts an incorrect answer in the
key, and the child is then marked wrong *for being right*. That surfaces weeks later as
inexplicable grades, with nothing on screen pointing back to the cause.

This is the same failure §4.2 argues about mis-matched key files — "a wrong placement arms a
Lesson with another Lesson's answers." Every instruction below that sounds fussy is fussy for
this reason.

The grader is not a proofreader of the key. It trusts the key completely.

---

## 1. Three page numberings, and the only one the key knows

This is the thing to get straight before anything else, because getting it wrong produces
exactly the silent failure §0 describes.

| Numbering | Range | Where it lives |
|---|---|---|
| **original_page** | 24–918 | The full-course workbook. **This is what the course-import CSV's activity ranges and `pageRangeStart`/`pageRangeEnd` use.** |
| **trimmed_page** | 1–~825 | Position in the trimmed workbook PDF, once the non-lesson pages are dropped. |
| **answer key page** | 1–N | Position in one lesson's answer key PDF. **The only numbering printed anywhere in the key.** |

An answer key is a standalone per-lesson document. It has never heard of page 388. Asking it
to "split at 43-47" is asking it to find a number that is not in the file: at best it says
UNCLEAR, at worst it invents a plausible split and you never find out.

### The conversion

**A key carries exactly two pages of front matter the student workbook does not** — the
Educator Information page and the teacher-facing objectives page. Everything after that lines
up one-to-one with the lesson's workbook pages. So:

```
answer_key_page = original_page − lesson_first_original_page + 3
```

**Verified on `MPS1.2.4AnswerKey.pdf` (Matter Transformed), two independent ways:**

- **By count.** The key is 17 pages. The lesson's budget is 43–57, which is 15 pages.
  17 − 2 = 15, exactly.
- **By structure.** Convert the lesson's four hand-split chunks and every one lands on a
  section boundary printed in the key:

  | Chunk (original) | → key pages | Heading actually there |
  |---|---|---|
  | 43–47 | 3–7 | vocabulary, figure, **Matter Transformed Guided Notes** (5–7) |
  | 48–51 | 8–11 | **Day 2: Atom Diagram Booklet** — exact |
  | 52–53 | 12–13 | **Day 3: Phase Diagram** — exact |
  | 54–55 | 14–15 | **Day 4: Non-Newtonian Fluids** — exact |
  | *(56–57, in the budget but in no assignment)* | 16–17 | Reinforcement and Extension; the "I can…" self-assessment |

  Four chunks, four exact hits, and the two pages left out of the split are the two the
  publisher did not make into day work. The split points Ray chose by hand already follow the
  curriculum's own day structure.

### Where the numbers come from

`Mia_Physical_Science_PDF_page_map.csv` is gaining an **`answer_key_page`** column, so the
conversion is looked up rather than done in your head. Until that column is there, apply the
formula above.

The column is derivable from the formula, which means **its real job is the row where the
formula is wrong.** Do not "simplify" it back into arithmetic later; it exists so an exception
can be written down.

### Validate before you transcribe, not after

For each lesson, check:

```
key_page_count == (lesson_last_original_page − lesson_first_original_page + 1) + 2
```

A lesson that fails this is a lesson whose front matter differs, and its whole mapping is
suspect. Find those by running the check across the keys you have — a one-time pass — rather
than discovering one lesson at a time from a child's inexplicable grade.

> **Note for whoever next touches `TDS_Slice_Grading_Assistant.md`:** §12.5.2 records this
> key as 23 pages. It is 17. The cost model built on that figure is therefore conservative —
> wrong in the cheap direction — but the number should be corrected when the slice is next
> edited.

---

## 2. Set up the Project (once)

In claude.ai → **Projects** → **New project**.

**Name:** `Answer Key Transcription`

**Project knowledge:** nothing permanent. Answer key PDFs are uploaded per conversation, not
kept in project knowledge — keys are per lesson and per course, and a Project accumulating
them will start blending them.

**Custom instructions:** paste §3 verbatim.

One Project serves every course. Start a **new conversation per lesson** — never transcribe
two lessons in one thread, because the model will start reconciling one lesson's answers
against another's.

---

## 3. Project custom instructions — paste verbatim

```
You transcribe printed answer keys from homeschool curriculum PDFs into plain text.

The text you produce is fed to another model that grades a child's handwritten
worksheet against it. That model trusts your output completely and never sees the
original PDF. If you transcribe an answer incorrectly, a child who answered
correctly is marked wrong.

PAGE NUMBERS

Every page range you are given is in the ANSWER KEY's own numbering — counted
from the first page of the attached file, which is normally also the number
printed on the page. The student's workbook uses different numbers entirely.
You will never be given those and must never try to infer them.

Each range also names the section heading expected at those pages. That is a
cross-check, not decoration: see rule 9.

RULES

1. Transcribe, never improve. Reproduce the answer as printed, including its
   wording, its level of detail, and its units. Do not rephrase, shorten,
   expand, correct, or modernise it. If the key says "it gets bigger", write
   "it gets bigger" — not "the volume increases".

2. Never invent. If an item's answer is missing, unreadable, or you are unsure
   which item it belongs to, write UNCLEAR and a short note saying what you
   could not resolve. An UNCLEAR item is cheap to fix. A confidently wrong one
   is not.

3. Answers only. Do not transcribe teaching notes, lesson objectives, pacing
   guidance, scripture, discussion prompts, or anything addressed to the parent
   rather than scoring the child's page. Do not transcribe decorative images.

4. A labelled diagram becomes prose. If the key answers an item with a fully
   labelled figure, write what the labels say as a sentence — "the change from
   liquid to gas is evaporation; gas to liquid is condensation".

   If an item genuinely cannot become text — the child must DRAW or LABEL
   something and the answer only makes sense as a picture — still give it a
   numbered line, and write NO TEXT ANSWER followed by what the item requires.
   Do not silently omit it. The numbers have to line up with the child's page,
   and a missing number is worse than a marked one. Repeat it in the notes
   block as well.

   Some keys answer a whole make-something activity with a photograph of a
   finished example. Describe what the example shows, item by item, and mark
   each NO TEXT ANSWER. Do not treat the picture as ungradable and skip it.

5. Keep the item numbering the workbook uses. The grading model matches your
   items against numbers printed on the child's page. If the key renumbers or
   groups items differently from the workbook, follow the workbook's numbering
   and say so in a note. This is about the numbers beside the questions, not
   about page numbers, which are covered above.

6. Include a short question stem with each answer — up to about ten words, just
   enough to identify which question it is. Full question text is not needed.

7. Where an item accepts several answers, transcribe all of them as the key
   gives them, separated by " OR ". Do not decide which is best. Do not add
   alternatives the key does not list.

8. Do not add commentary, difficulty ratings, grading advice, or tolerance
   guidance. How strictly to grade is decided elsewhere, per course, and your
   opinion on it will be applied to the child by mistake.

9. Check each range against the heading named for it, and report any
   disagreement. If the pages you were given do not carry the heading named, or
   the section visibly starts or ends a page away from the range requested,
   transcribe exactly the pages you were asked for and describe the mismatch in
   the notes block. Never quietly shift a range to fit a heading, and never
   transcribe pages other than the ones requested. A disagreement here means
   the page mapping is wrong, which matters well beyond this one lesson.

OUTPUT FORMAT

Plain text. No markdown, no JSON, no code fences, no bold. For each range
requested, output exactly:

=== Key pages A-B · <section heading as printed> ===
1. <short question stem> — <the answer as printed>
2. <short question stem> — NO TEXT ANSWER: <what the item requires>
3. <short question stem> — <the answer as printed>
...

Then, if anything needs flagging, a final block:

=== Notes ===
- <item number>: <what was unclear, or NO TEXT ANSWER, or a numbering
  discrepancy>
- <range>: <any heading mismatch, per rule 9>

Nothing else. No preamble, no summary, no offer to continue.
```

---

## 4. What to bring to each conversation

Three things:

1. **The answer key PDF** for one lesson — upload it to the conversation.
2. **The assignment splits, converted to key pages** (§1), each with the section heading you
   expect to find there. Get the workbook ranges from `pageRangeStart` / `pageRangeEnd` on
   each `pdf` activity — visible in the Management App on the Lesson — then convert. Open the
   key and read the headings off it; that is the whole point of naming them.
3. **Nothing else.** Not the child's work, not the rubric, not last lesson's thread.

### The message to send

```
Attached is the answer key for <COURSE CODE> Lesson <NN> "<LESSON TITLE>".

Transcribe it, split into these assignments. Page numbers are the key PDF's own
pages. Each range names the heading I expect there — check it and flag any
disagreement rather than adjusting the range.

  key pages 3-7    Matter Transformed Guided Notes
  key pages 8-11   Day 2: Atom Diagram Booklet
  key pages 12-13  Day 3: Phase Diagram
  key pages 14-15  Day 4: Non-Newtonian Fluids

Follow the project instructions exactly. Output the four blocks and the notes
block, nothing else.
```

Replace the ranges and headings with that lesson's own. If a lesson is a single assignment,
give the one range — the format is the same.

**If a key has no section headings at all**, name the range alone and say so in the message.
You lose the cross-check for that lesson, which makes the §5 spot-check the only thing
standing between a bad split and a child's grade — so spot-check harder.

---

## 5. What you get back, and what to do with it

Expected shape:

```
=== Key pages 3-7 · Matter Transformed Guided Notes ===
1. Three states of matter — solid, liquid, gas
2. Particle spacing in a solid — tightly packed in a fixed arrangement
3. What melting is — a solid changing to a liquid as it gains heat
4. Label the particle diagram — NO TEXT ANSWER: child labels solid/liquid/gas panels
5. Why ice floats — water expands as it freezes, so ice is less dense
...

=== Key pages 8-11 · Day 2: Atom Diagram Booklet ===
1. ...

=== Notes ===
- key page 6 item 4: NO TEXT ANSWER — child must label a particle diagram
```

**Read the notes block first.** Then:

| What the notes say | What to do |
|---|---|
| Nothing | Paste each block into its assignment's `answerKeyText` box. |
| A heading mismatch (rule 9) | **Stop.** Do not paste anything from that lesson. The page mapping is wrong — fix `answer_key_page` for the lesson, re-run §1's validation identity, and transcribe again. |
| `UNCLEAR` on an item | Open the PDF to that page and fix the line by hand. Do not paste an UNCLEAR line. |
| `NO TEXT ANSWER` on a few items | Paste the block as it is. Those items come back `UNSURE` and you grade them by eye; every other item on the page still grades against text. |
| `NO TEXT ANSWER` on most of an assignment | **Leave that assignment's box empty — and read the fall-through warning below.** |

`NO TEXT ANSWER` is prose, not a keyword — nothing parses it. It works because
`GRADING_OUTPUT_INSTRUCTION` tells the model to return `UNSURE` for any item the
photographs show and the key does not answer, rather than grading it from its own knowledge
(§12.5.0a). `UNSURE` is excluded from the score denominator, so a diagram item neither
lowers the child's number nor pads it.

### The fall-through is three layers, not two

§12.5.3's resolution order is `activity.answerKeyText` → `lesson.answerKeyText` → the PDF.
An empty activity box therefore reaches **the lesson box first**, and only reaches the PDF if
that is empty too.

So if you have pasted anything into the whole-lesson box, emptying an activity box does not
give you the PDF — it gives that assignment the whole lesson's text, which is a different
assignment's answers. **Use the per-activity boxes only.** Keep the lesson box empty unless
you intend every assignment in the lesson to resolve to it.

### Spot-check before pasting

Pick three items at random per assignment, look them up in the PDF, and confirm the text
matches. Three per assignment is enough to catch a systematic failure — a page skipped,
numbering off by one, the wrong lesson transcribed — which is the failure mode that matters.
It will not catch a single slipped word, and nothing cheap will.

Rule 9's heading check now catches most systematic failures before you get here. The
spot-check is what catches the ones where the headings happen to line up anyway.

### Where it goes

Management App → Assigned Courses → the Course → the Lesson → the `pdf` activity →
**Answer key text (this activity)**. One box per assignment. Offered on `pdf` activities only.
It saves through the ordinary `records` sync push like any other curriculum edit — no upload,
no new route (§12.9).

---

## 6. The test lesson

§11.2's accuracy test is the last unmeasured assumption in §12 (§12.11.9), and it needs
exactly one transcribed key.

> **It has not been run, and it is now overdue.** §12.10 placed it between Phases E and F so
> that F would be built on a measurement. Both phases shipped first (`94398d4`, `278d6e5`),
> so text keys are live and unmeasured. Run it before transcribing a course's worth of keys.

**Use L03 "Matter Transformed" of `MIAPHYSCI6`.** It is the lesson §12.5.2 measured, its
costs and structure are characterised, and its large images were examined and found to be
labelled illustrations rather than answers (§12.11.8).

**Procedure:**

1. Transcribe it by the process above.
2. Take one real assignment's photographed pages — work a child has actually done.
3. Grade them **against the PDF key** (current behaviour). Record every item's verdict.
4. Grade the same pages **against the transcribed text**. Record again.
5. Compare verdict by verdict.

**What you are looking for:** items where the two disagree. A handful of `UNSURE` moving to a
verdict is fine and expected. What would sink §12.5.3 is a `CORRECT` becoming `INCORRECT` —
that means the transcription lost something the model was using, and the text path needs
work before it becomes the default.

Also record `usage.input_tokens` on both. Check 13 (§12.10) expects the text run to land at
roughly a quarter of the PDF run — that is the saving, measured rather than estimated.

**Pick the assignment for this test deliberately.** Day 2 (the Atom Diagram Booklet) and Day 3
(the Phase Diagram) are answered in the key largely by pictures of completed work, so they are
mostly `NO TEXT ANSWER` and mostly fall back to the PDF — which tests the escape hatch, not
the text path. The Guided Notes (key pages 5–7) are the text-heaviest assignment in the lesson
and the fair test of §12.5.3's claim. Running both is better: one measures the saving, the
other measures how often the saving does not apply.

This lesson is also a caution about §12.5.3's expectation that the PDF path is "the exception
rather than a co-equal branch." Two of its four assignments are craft and diagram work. If
that ratio holds across the course, the measured saving will land well short of §12.8's
figure — which is a reason to run the test, not to argue about it here.

---

## 7. What this deliberately does not do

- **No automated transcription.** `POST /api/grading/keys/transcribe` was specified in an
  earlier draft and is **cancelled** (§12.5.3). Do not build it. What it bought is bought
  better here: no route, no prompt contract to maintain, no metered spend, and no review
  screen whose only job was making a machine's output safe.
- **No transcription of the child's work.** That is the grading call's job, from the photo.
- **No cost to this project.** The Project runs on Ray's Pro subscription, so §12.8's saving
  arrives with nothing offsetting it.
