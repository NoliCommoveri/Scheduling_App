# Answer Key Transcription — the Claude Project procedure

**Date:** 2026-08-16 · **Status:** procedure for the §11.2 accuracy test, then for ordinary use
**Implements:** `TDS_Slice_Grading_Assistant.md` §12.5.3 — the answer key as text

Transcription is **not an app feature** ([DECISION], §12.5.3). Ray runs it in a Claude
Project on his own Pro subscription and pastes the result into the Management App. The app's
whole surface for this is a textarea. This document is the procedure that fills it.

**Why it exists:** an answer key PDF is ~three quarters of every grading request. As text it
is roughly a tenth the size — ~$150 for the school year against ~$420 (§12.8). The saving is
real only if the transcription is *right*, which is what most of this document is about.

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

## 1. Set up the Project (once)

In claude.ai → **Projects** → **New project**.

**Name:** `Answer Key Transcription`

**Project knowledge:** nothing permanent. Answer key PDFs are uploaded per conversation, not
kept in project knowledge — keys are per lesson and per course, and a Project accumulating
them will start blending them.

**Custom instructions:** paste §2 verbatim.

One Project serves every course. Start a **new conversation per lesson** — never transcribe
two lessons in one thread, because the model will start reconciling one lesson's answers
against another's.

---

## 2. Project custom instructions — paste verbatim

```
You transcribe printed answer keys from homeschool curriculum PDFs into plain text.

The text you produce is fed to another model that grades a child's handwritten
worksheet against it. That model trusts your output completely and never sees the
original PDF. If you transcribe an answer incorrectly, a child who answered
correctly is marked wrong.

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

5. Keep the item numbering the workbook uses. The grading model matches your
   items against numbers printed on the child's page. If the key renumbers or
   groups items differently from the workbook, follow the workbook's numbering
   and say so in a note.

6. Include a short question stem with each answer — up to about ten words, just
   enough to identify which question it is. Full question text is not needed.

7. Where an item accepts several answers, transcribe all of them as the key
   gives them, separated by " OR ". Do not decide which is best. Do not add
   alternatives the key does not list.

8. Do not add commentary, difficulty ratings, grading advice, or tolerance
   guidance. How strictly to grade is decided elsewhere, per course, and your
   opinion on it will be applied to the child by mistake.

OUTPUT FORMAT

Plain text. No markdown, no JSON, no code fences, no bold. For each assignment
page range requested, output exactly:

=== Workbook pages A-B ===
1. <short question stem> — <the answer as printed>
2. <short question stem> — NO TEXT ANSWER: <what the item requires>
3. <short question stem> — <the answer as printed>
...

Then, if anything needs flagging, a final block:

=== Notes ===
- <item number>: <what was unclear, or NO TEXT ANSWER, or a numbering
  discrepancy>

Nothing else. No preamble, no summary, no offer to continue.
```

---

## 3. What to bring to each conversation

Three things:

1. **The answer key PDF** for one lesson — upload it to the conversation.
2. **The workbook page ranges** for that lesson's assignments. These come from
   `pageRangeStart` / `pageRangeEnd` on each `pdf` activity — visible in the Management App
   on the Lesson, and originally from the course-import CSV. For L03 "Matter Transformed"
   that is four assignments: **43–47, 48–51, 52–53, 54–55**.
3. **Nothing else.** Not the child's work, not the rubric, not last lesson's thread.

### The message to send

```
Attached is the answer key for <COURSE CODE> Lesson <NN> "<LESSON TITLE>".

Transcribe it, split into these assignments by workbook page range:
  43-47
  48-51
  52-53
  54-55

Follow the project instructions exactly. Output the four blocks and the notes
block, nothing else.
```

Replace the ranges with that lesson's own. If a lesson is a single assignment, give the one
range — the format is the same.

---

## 4. What you get back, and what to do with it

Expected shape:

```
=== Workbook pages 43-47 ===
1. Three states of matter — solid, liquid, gas
2. Particle spacing in a solid — tightly packed in a fixed arrangement
3. What melting is — a solid changing to a liquid as it gains heat
4. Label the particle diagram — NO TEXT ANSWER: child labels solid/liquid/gas panels
5. Why ice floats — water expands as it freezes, so ice is less dense
...

=== Workbook pages 48-51 ===
1. ...

=== Notes ===
- p.46 item 4: NO TEXT ANSWER — child must label a particle diagram
```

**Read the notes block first.** Then:

| What the notes say | What to do |
|---|---|
| Nothing | Paste each block into its assignment's `answerKeyText` box. |
| `UNCLEAR` on an item | Open the PDF to that page and fix the line by hand. Do not paste an UNCLEAR line. |
| `NO TEXT ANSWER` on a few items | Paste the block as it is. Those items come back `UNSURE` and you grade them by eye; every other item on the page still grades against text. |
| `NO TEXT ANSWER` on most of an assignment | **Leave that assignment's box empty.** It falls through to the PDF automatically (§12.5.3's resolution order) — that is the escape hatch, and it needs no flag set. |

`NO TEXT ANSWER` is prose, not a keyword — nothing parses it. It works because
`GRADING_OUTPUT_INSTRUCTION` tells the model to return `UNSURE` for any item the
photographs show and the key does not answer, rather than grading it from its own knowledge
(§12.5.0a). `UNSURE` is excluded from the score denominator, so a diagram item neither
lowers the child's number nor pads it.

**Spot-check before pasting.** Pick three items at random per assignment, look them up in the
PDF, and confirm the text matches. Three per assignment is enough to catch a systematic
failure — a page skipped, numbering off by one, the wrong lesson transcribed — which is the
failure mode that matters. It will not catch a single slipped word, and nothing cheap will.

**Where it goes:** Management App → Assigned Courses → the Course → the Lesson → the `pdf`
activity → **Answer key text**. One box per assignment. It saves through the ordinary
`records` sync push like any other curriculum edit — no upload, no new route (§12.9).

> The per-activity boxes are **Phase F** and do not exist yet (§12.10). Until F ships, keep
> transcriptions in a file. The whole-lesson box is the middle resolution layer and takes all
> four blocks concatenated, if per-assignment segmentation is not yet available to you.

---

## 5. The test lesson

§11.2's accuracy test is the last unmeasured assumption in §12 (§12.11.9), and it needs
exactly one transcribed key. Run it between phases **E** and **F** (§12.10), so F is built on
a measurement rather than on §12.5.3's reasoning.

**Use L03 "Matter Transformed" of `MIAPHYSCI6`.** It is the lesson §12.5.2 measured — 23 key
pages, 2.3 MB, four assignments — so its costs and structure are already characterised, and
its large images were examined and found to be labelled illustrations rather than answers
(§12.11.8).

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

---

## 6. What this deliberately does not do

- **No automated transcription.** `POST /api/grading/keys/transcribe` was specified in an
  earlier draft and is **cancelled** (§12.5.3). Do not build it. What it bought is bought
  better here: no route, no prompt contract to maintain, no metered spend, and no review
  screen whose only job was making a machine's output safe.
- **No transcription of the child's work.** That is the grading call's job, from the photo.
- **No cost to this project.** The Project runs on Ray's Pro subscription, so §12.8's saving
  arrives with nothing offsetting it.
