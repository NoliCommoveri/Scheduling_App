// api.js — fetch wrappers for the wall's one bearer credential.
// Phase 2: pairing and the roster read (TDS_Slice_Wall_Display_App.md §13).
// Phase 3 (Wall Calendar Redesign) adds the placements read
// (TDS_Slice_Wall_Calendar_Redesign.md §12). Phase 5 adds the placement
// WRITES: standing PUT/DELETE on `wall_slots` (§3.2, §12). Phase 5b adds
// PUT/DELETE on `wall_slot_days` — the §3.5.2 per-day duration override
// ("just this one"). Phase 6 adds the write path itself: completions,
// reward entries, and the arbitrated claim/release (§6.1-§6.5, §8.3.1) —
// the shape (one wall token, childId per call, 401 -> unpaired) set above
// only ever needed adding routes, never a second convention.

(function (g) {
  "use strict";

  // Thrown on any 401: the token is missing, wrong, or revoked. app.js catches
  // this one error class to route to the "This display has been unpaired"
  // screen (§3.2) rather than treating it like an ordinary fetch failure.
  function UnpairedError() {
    this.name = "UnpairedError";
    this.message = "This display has been unpaired.";
  }
  UnpairedError.prototype = Object.create(Error.prototype);

  function authHeaders() {
    var token = g.Store.getToken();
    return token ? { Authorization: "Bearer " + token } : {};
  }

  function request(path, options) {
    options = options || {};
    var headers = Object.assign({}, authHeaders(), options.headers || {});
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) throw new UnpairedError();
      return res.json().catch(function () { return {}; }).then(function (parsed) {
        if (!res.ok) {
          var err = new Error((parsed && parsed.error) || "HTTP " + res.status);
          err.status = res.status;
          err.body = parsed;
          throw err;
        }
        return parsed;
      });
    });
  }

  // Unauthenticated, like /api/pair (§3.2). Redeems a pair code minted from
  // Management App -> Devices -> Pair wall display.
  function pair(code, label) {
    return request("/api/wall/pair", { method: "POST", body: { code: code, label: label } });
  }

  // §3.3 — SELECT id, name FROM children WHERE active = 1 ORDER BY name.
  function getChildren() {
    return request("/api/wall/children").then(function (res) { return res.children || []; });
  }

  // §5.1/§5.2 — handlePlan's body: { assignments, from, to, truncated?, limit? }.
  // `since`, when given, is the incremental watermark (max updated_at from
  // the last successful fetch of this child's window); omit for a full fetch.
  function getPlan(childId, from, to, since) {
    var qs = "childId=" + encodeURIComponent(childId) +
      "&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    if (since != null) qs += "&since=" + encodeURIComponent(since);
    return request("/api/wall/plan?" + qs);
  }

  // §12 — every placement, household-wide, plus any `wall_slot_days`
  // overrides. `from`/`to` only bound the day-scoped overrides (`wall_slots`
  // itself carries no date, §3.3); omitted here because the set is "small"
  // per §12 regardless, and a full re-fetch is what `Poll.pollNow()` does
  // after every placement write anyway (day-ui.js).
  function getSlots() {
    return request("/api/wall/slots").then(function (res) {
      return { slots: res.slots || [], days: res.days || [] };
    });
  }

  // §12 — upsert of the standing placement (§3.2, §3.3). `durationMin` is
  // sent verbatim, including `null`/`undefined` normalized to `null` —
  // the route has no prior value to fall back to on a partial body
  // (worker/index.js's handleWallSlotPut), so a caller that wants to keep
  // an existing standing duration override in place across a plain time
  // move must resend it explicitly rather than omit it.
  function putSlot(childId, subjectKind, subjectKey, instanceKey, startMin, durationMin) {
    return request("/api/wall/slots", {
      method: "PUT",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        startMin: startMin,
        durationMin: durationMin == null ? null : durationMin,
      },
    });
  }

  // §12 — un-place; the chore returns to the tray. Also clears that
  // subject's `wall_slot_days` overrides server-side.
  function deleteSlot(childId, subjectKind, subjectKey, instanceKey) {
    return request("/api/wall/slots", {
      method: "DELETE",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
      },
    });
  }

  // §3.5.2/§12 — "just this one": upserts a `wall_slot_days` override for
  // one date. `durationMin` is required (the Worker's handleWallSlotDayPut
  // rejects `null` — an override that means nothing is a DELETE, not a PUT
  // that writes null, worker/index.js).
  function putSlotDay(childId, subjectKind, subjectKey, instanceKey, date, durationMin) {
    return request("/api/wall/slots/day", {
      method: "PUT",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        date: date,
        durationMin: durationMin,
      },
    });
  }

  // §3.5.2/§12 — clears one date's override; the chip falls back to the
  // standing override, or the parent's own estimate.
  function deleteSlotDay(childId, subjectKind, subjectKey, instanceKey, date) {
    return request("/api/wall/slots/day", {
      method: "DELETE",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        date: date,
      },
    });
  }

  // §6.1/§8.3 — an ordinary completion batch. `X-Outbox-Protocol: 2` so a
  // transient database fault comes back as a `deferred` row (§11.7 in the
  // Worker) rather than a flat 503 the wall would have no way to act on
  // differently from a permanent rejection.
  function postCompletions(childId, completions) {
    return request("/api/wall/completions", {
      method: "POST",
      headers: { "X-Outbox-Protocol": "2" },
      body: { childId: childId, completions: completions },
    });
  }

  // §6.2 — the earn entry (or, with a negative `amount`, its Undo
  // reversal). Same protocol header, same reason: a fault must come back
  // as `deferred` so `wall.pendingEarns` — the only retry queue in the
  // app — knows to keep the row rather than treat it as refused.
  function postRewardEntries(childId, entries) {
    return request("/api/wall/rewards/entries", {
      method: "POST",
      headers: { "X-Outbox-Protocol": "2" },
      body: { childId: childId, entries: entries },
    });
  }

  // §6.3/§8.3.1 — the arbitrated claim. `childId` is this route's own
  // parameter, carried INSIDE the JSON body (worker/index.js destructures
  // it out before `CLAIM_BODY_KEYS` sees the rest) — unlike the release
  // below, which puts it on the query string instead. `fields` carries
  // `completedAt` (§8.3.1) and optionally `grade`/`completionNote`.
  function claim(childId, assignmentId, fields) {
    return request("/api/wall/assignments/" + encodeURIComponent(assignmentId) + "/claim", {
      method: "POST",
      body: Object.assign({ childId: childId }, fields || {}),
    });
  }

  // §6.5/§8.5 — release, for Undo's shared-chore path. `childId` rides the
  // query string: the Worker's DELETE route never parses a body at all, so
  // sending one would just be bytes nobody reads.
  function releaseClaim(childId, assignmentId) {
    return request(
      "/api/wall/assignments/" + encodeURIComponent(assignmentId) + "/claim?childId=" + encodeURIComponent(childId),
      { method: "DELETE" }
    );
  }

  g.WallApi = {
    UnpairedError: UnpairedError,
    pair: pair,
    getChildren: getChildren,
    getPlan: getPlan,
    getSlots: getSlots,
    putSlot: putSlot,
    deleteSlot: deleteSlot,
    putSlotDay: putSlotDay,
    deleteSlotDay: deleteSlotDay,
    postCompletions: postCompletions,
    postRewardEntries: postRewardEntries,
    claim: claim,
    releaseClaim: releaseClaim,
    request: request,
  };
})(typeof window !== "undefined" ? window : globalThis);
