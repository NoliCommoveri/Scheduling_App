// grading.js — the Child App's grading capture calls.
// TDS_Slice_Grading_Assistant.md §5, §9 Phase 6; §12 Phase C (multi-page
// capture); CLAUDE.md §III.A's third narrowing (v2.6): capture-and-submit is
// online-required end to end, with no outbox queue for the photos — this
// file owns the fetches directly, unlike completion.js/outbox.js it has no
// local write path to coordinate with. grading-core.js owns the pure
// response shaping and stays DOM-free; the canvas resize below needs the
// DOM, so it lives here instead.
//
// Mirrors plan-sync.js's apiGet for the Authorization header and error
// handling; the submit below builds a multipart/form-data body (the Worker
// reads `request.formData()`), not a JSON envelope, so it does not go
// through outbox-core.js's request builders.

(function (g) {
  "use strict";

  // §12.6 — the resolution the model downscales to on arrival regardless,
  // so anything larger is upload time and request budget spent on pixels it
  // never sees. Unconditional: every captured page is redrawn through the
  // canvas at this quality, not only ones that measure larger than it.
  var MAX_LONG_EDGE = 2576;
  var JPEG_QUALITY = 0.8;

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

  // Canvas-resizes one captured photo to §12.6's cap before it's added to
  // the page set. Never upscales — `Math.min(1, ...)` only ever shrinks —
  // but always re-draws and re-encodes, since the point is the JPEG quality
  // 0.8 re-encode as much as the dimension cap.
  function resizePage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var longEdge = Math.max(img.naturalWidth, img.naturalHeight);
        var scale = Math.min(1, MAX_LONG_EDGE / longEdge);
        var w = Math.max(1, Math.round(img.naturalWidth * scale));
        var h = Math.max(1, Math.round(img.naturalHeight * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error("Could not process that photo.")); return; }
          resolve(blob);
        }, "image/jpeg", JPEG_QUALITY);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not load that photo."));
      };
      img.src = url;
    });
  }

  // One submit for the whole page set (§12.4/§12.10): a multipart request
  // with one "page" file part per photo, in capture order — the Worker
  // trusts `formData.getAll('page')`'s insertion order as the only record of
  // page order, so the caller must not let anything reorder `blobs` between
  // resizePage() and here.
  function submitPages(assignmentId, blobs) {
    return token().then(function (t) {
      if (!t) return { ok: false, message: "This device isn't paired yet." };
      if (!blobs || blobs.length === 0) return { ok: false, message: "Add at least one photo first." };
      if (blobs.length > g.GradingCore.MAX_GRADING_PAGES) {
        return { ok: false, message: "At most " + g.GradingCore.MAX_GRADING_PAGES + " pages per assignment." };
      }
      var formData = new FormData();
      blobs.forEach(function (blob, i) {
        formData.append("page", blob, "page-" + (i + 1) + ".jpg");
      });
      // No explicit Content-Type header — fetch sets the multipart boundary
      // itself from the FormData body, same reason plan-sync.js never sets
      // one for a GET.
      return fetch("/api/grading/pages?assignmentId=" + encodeURIComponent(assignmentId), {
        method: "POST",
        headers: { "Authorization": "Bearer " + t },
        cache: "no-store",
        body: formData
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

  g.Grading = { resizePage: resizePage, submitPages: submitPages, fetchReview: fetchReview };
})(typeof window !== "undefined" ? window : globalThis);
