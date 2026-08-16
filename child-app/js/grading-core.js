// grading-core.js — pure logic for the Child App's grading capture UI.
// TDS_Slice_Grading_Assistant.md §5, §6, §9 Phase 6.
//
// Pure — no fetch, no IndexedDB, no DOM — so it can be exercised directly,
// same discipline as every other `*-core.js` file in this app.

(function (g) {
  "use strict";

  // Mirrors management-app/worker/grading-core.js's COUNTED_VERDICTS
  // (normalizeScore). A stored `grading_reviews` row keeps `items` but not
  // `outOf` — GET /api/grading/review/:id has to recompute the denominator
  // from the same three verdicts the Worker counted, or a reloaded proposal
  // would show a score with no "out of" beside it.
  var COUNTED_VERDICTS = { CORRECT: true, PARTIAL: true, INCORRECT: true };

  // Mirrors management-app/worker/index.js's MAX_GRADING_PAGES (§12.6). The
  // Worker enforces this once it reads the multipart body; this copy lets the
  // capture UI refuse a 13th page before any upload starts (§12.10 check 5).
  var MAX_GRADING_PAGES = 12;

  function outOfFromItems(items) {
    var rows = Array.isArray(items) ? items : [];
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && COUNTED_VERDICTS[rows[i].verdict]) count++;
    }
    return count;
  }

  // Worker's own gate (resolveGradingContext): only a lesson activity has an
  // answer key to grade against. Chores and non-activity rows never get the
  // button; asking the Worker would always 400.
  function isGradableActivity(item) {
    return !!item && item.kind === "activity";
  }

  // A whole-number percent for display, or null when there is nothing to
  // divide (every item was BLANK/UNSURE, or there are no items at all —
  // normalizeScore's own empty-denominator guard, §8).
  function percentOf(score, outOf) {
    if (typeof score !== "number" || !outOf) return null;
    return Math.round((score / outOf) * 100);
  }

  // One line of child-facing copy per proposal state (§1.1's four states).
  // 'failed' is not one of them — a failed grading attempt has no proposal
  // to show, so the caller falls back to offering another capture instead.
  var STATE_LABELS = {
    proposed: "Submitted — waiting for a parent to check it.",
    accepted: "Your parent confirmed this grade.",
    overridden: "Your parent looked at this and changed the grade."
  };

  function stateLabel(state) {
    return STATE_LABELS[state] || null;
  }

  // Shapes both server responses this UI reads into one display model:
  // the direct POST /api/grading/pages reply (`score`/`outOf`) and the GET
  // /api/grading/review/:id reply (`proposedScore`/`items`, no `outOf`).
  function formatProposal(review) {
    if (!review) return null;
    var score = typeof review.score === "number" ? review.score
      : typeof review.proposedScore === "number" ? review.proposedScore
      : null;
    var outOf = typeof review.outOf === "number" ? review.outOf : outOfFromItems(review.items);
    var pct = percentOf(score, outOf);
    return {
      state: review.state || "proposed",
      label: stateLabel(review.state) || stateLabel("proposed"),
      score: score,
      outOf: outOf,
      percent: pct,
      scoreText: pct == null ? null : score + " out of " + outOf + " (" + pct + "%)",
      feedback: review.feedback || null
    };
  }

  // Child-friendly copy for the Worker's error responses (§5's four failure
  // shapes actually reachable from this route: 400/404/422/502/413/500).
  // Anything not named here — an unrecognised status — falls through to the
  // generic message rather than surfacing a raw HTTP code to a kid.
  //
  // §12.6: a 413 is no longer one flat cause. `pageFiles.length >
  // MAX_GRADING_PAGES` and the combined key-plus-pages guard both answer 413,
  // and the combined one already names which side is over in `error` — so a
  // 413 with a server message is passed through verbatim, same as 422, and
  // only a 413 with no message (or a stray legacy call) falls back to the
  // flat per-photo copy.
  function errorMessage(status, serverMessage) {
    if ((status === 422 || status === 413) && serverMessage) return serverMessage; // worded for a parent already
    if (status === 413) return "That photo is too big. Try again with a smaller picture.";
    if (status === 404) return "Couldn't find that assignment to grade.";
    if (status === 401) return "This device needs to be paired again — ask a parent.";
    return "Couldn't grade that right now. Try again in a bit.";
  }

  g.GradingCore = {
    MAX_GRADING_PAGES: MAX_GRADING_PAGES,
    isGradableActivity: isGradableActivity,
    outOfFromItems: outOfFromItems,
    percentOf: percentOf,
    stateLabel: stateLabel,
    formatProposal: formatProposal,
    errorMessage: errorMessage
  };
})(typeof window !== "undefined" ? window : globalThis);
