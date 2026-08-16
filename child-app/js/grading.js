// grading.js — the Child App's grading capture calls.
// TDS_Slice_Grading_Assistant.md §5, §9 Phase 6; CLAUDE.md §III.A's third
// narrowing (v2.6): capture-and-submit is online-required end to end, with
// no outbox queue for the photo — this file owns the two fetches directly,
// unlike completion.js/outbox.js it has no local write path to coordinate
// with. grading-core.js owns the pure response shaping.
//
// Mirrors plan-sync.js's apiGet for the Authorization header and error
// handling; POST here sends the image's own bytes as the body (the Worker
// reads `request.arrayBuffer()`), not a JSON envelope, so it does not go
// through outbox-core.js's request builders.

(function (g) {
  "use strict";

  function token() {
    return g.DB.getSingleton("syncMeta").then(function (meta) {
      return meta && meta.deviceToken ? meta.deviceToken : null;
    });
  }

  // Reads whatever the Worker sent back — JSON on both success and failure
  // (§5's error shape is always `{ error }`) — without throwing on a body
  // that fails to parse, so a proxy error page doesn't crash the dialog.
  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function submitPhoto(assignmentId, blob, contentType) {
    return token().then(function (t) {
      if (!t) return { ok: false, message: "This device isn't paired yet." };
      return fetch("/api/grading/page?assignmentId=" + encodeURIComponent(assignmentId), {
        method: "POST",
        headers: { "Authorization": "Bearer " + t, "Content-Type": contentType },
        cache: "no-store",
        body: blob
      }).then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) return { ok: true, review: body };
          var message = g.GradingCore.errorMessage(res.status, body && body.error);
          return { ok: false, status: res.status, message: message };
        });
      });
    }).catch(function () {
      return { ok: false, message: "Couldn't reach the grading service. Check the connection and try again." };
    });
  }

  // A 404 here means "no proposal yet," which is the ordinary state for an
  // item nobody has photographed — not treated as a fetch failure.
  function fetchReview(assignmentId) {
    return token().then(function (t) {
      if (!t) return { ok: false, message: "This device isn't paired yet." };
      return fetch("/api/grading/review/" + encodeURIComponent(assignmentId), {
        method: "GET",
        headers: { "Authorization": "Bearer " + t },
        cache: "no-store"
      }).then(function (res) {
        if (res.status === 404) return { ok: true, review: null };
        return readJson(res).then(function (body) {
          if (res.ok) return { ok: true, review: body && body.review };
          var message = g.GradingCore.errorMessage(res.status, body && body.error);
          return { ok: false, status: res.status, message: message };
        });
      });
    }).catch(function () {
      return { ok: false, message: "Couldn't check on this right now." };
    });
  }

  g.Grading = { submitPhoto: submitPhoto, fetchReview: fetchReview };
})(typeof window !== "undefined" ? window : globalThis);
