// api.js — fetch wrappers for the wall's one bearer credential.
// Phase 2: pairing and the roster read (TDS_Slice_Wall_Display_App.md §13).
// Phase 3 (Wall Calendar Redesign) adds the placements read
// (TDS_Slice_Wall_Calendar_Redesign.md §12). Phase 5 adds the placement
// WRITES: standing PUT/DELETE on `wall_slots` (§3.2, §12). Phase 5b adds
// PUT/DELETE on `wall_slot_days` — the §3.5.2 per-day duration override
// ("just this one"). Phase 6 adds the write path itself: completions,
// reward entries, and the arbitrated claim/release (§6.1-§6.5, §8.3.1) —
// the shape (one wall token, childId per call, 401 -> unpaired) set above
// only ever needed adding routes, never a second convention. Phase 8 adds
// `getEvents` (§7.2) — the month grid's household-wide feed, and the only
// read here that names no child at all, exactly like `getChildren`.

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

  // §7.2 — the household-wide, server-deduped events feed the month grid
  // runs on, and the ONE read in this app that is not part of `Poll`'s
  // fan-out. The poll's window is a fortnight around today, widened forward
  // only by what the day and week views ask for (poll.js `setRange`); a month
  // grid draws 42 days of a month that may be nowhere near today, and §7.2
  // exists precisely so that is one query rather than a per-child plan call
  // per month — which is also why the month view asks for no window of its
  // own (app.js `neededRange`).
  //
  // Its projection is `{ id, source_id, date, title, payload }`: the route
  // selected `kind = 'event'` in SQL and then dropped the column from what
  // it returns. `kind` is stamped back on here so `events-core.js`'s own
  // `eventsOn`/`eventKey`/`spanLabel` run over this feed exactly as they do
  // over a plan window — one dedupe in the app, not a second one for the
  // month.
  function getEvents(from, to) {
    var qs = "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    return request("/api/wall/events?" + qs).then(function (res) {
      return (res.events || []).map(function (row) {
        return Object.assign({}, row, { kind: "event" });
      });
    });
  }

  // §12 — every placement, household-wide, plus any `wall_slot_days`
  // overrides. `from`/`to` only bound the day-scoped overrides (`wall_slots`
  // itself carries no date, §3.3); omitted here because the set is "small"
  // per §12 regardless, and a full re-fetch is what `Poll.pollNow()` does
  // after every placement write anyway (day-ui.js).
  function getSlots() {
    return request("/api/wall/slots").then(function (res) {
      // Placement Scopes §4.2 — `slotWeekdays` joins them, unbounded by the
      // window like `slots` (a weekday row carries no date). Defaulted to []
      // so a wall running against a Worker that predates Phase 2 renders the
      // standing placements it already understands rather than throwing.
      return { slots: res.slots || [], days: res.days || [], slotWeekdays: res.slotWeekdays || [] };
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

  // §12 — un-place; the chore returns to the tray.
  //
  // Placement Scopes §11.6 (Phase 2) — CORRECTED: this no longer clears that
  // subject's `wall_slot_days` overrides server-side, and it never touched
  // `wall_slot_weekdays`. Un-placing is standing-scoped: it deletes the
  // `wall_slots` row and nothing else, so a tray drag on a Friday cannot
  // destroy a year of deliberate per-weekday times. The override rows left
  // behind are dormant, not orphaned — §2.1's gate means a chore with no
  // standing row renders nowhere whatever else it carries. Accepted cost,
  // recorded: re-placing the chore later restores those times.
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
  // one date.
  //
  // Placement Scopes §4.1/§4.2 (Phase 2) — WIDENED: `startMin` joins
  // `durationMin`, so a date can move a chore as well as re-time it. Under
  // §4.1's full-row contract both are sent on every call and either may be
  // `null` — a field the body omits is written NULL, cleared rather than left
  // alone — but not both: an override that overrides nothing is a DELETE.
  // `SlotsCore.overrideWrite` decides that fork, so no caller here has to
  // remember it.
  //
  // Each value must be THAT LEVEL'S OWN (§4.1), never the resolved number the
  // chip is drawing with.
  function putSlotDay(childId, subjectKind, subjectKey, instanceKey, date, startMin, durationMin) {
    return request("/api/wall/slots/day", {
      method: "PUT",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        date: date,
        startMin: startMin == null ? null : startMin,
        durationMin: durationMin == null ? null : durationMin,
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

  // Placement Scopes §4.2 (Phase 4) — "every Friday": the weekday level,
  // between the standing row and the per-date one. Same key as a placement
  // plus the weekday NUMBER (0=Sun..6=Sat), which the caller derives from the
  // rendered date with `TimeCore.weekdayOf` — the Worker has no timezone to
  // derive it in and deliberately does not try (worker/index.js).
  //
  // Same full-row contract as `putSlotDay` above, same both-null-is-a-DELETE
  // fork, same "send the level's own value" rule.
  function putSlotWeekday(childId, subjectKind, subjectKey, instanceKey, weekday, startMin, durationMin) {
    return request("/api/wall/slots/weekday", {
      method: "PUT",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        weekday: weekday,
        startMin: startMin == null ? null : startMin,
        durationMin: durationMin == null ? null : durationMin,
      },
    });
  }

  // Placement Scopes §4.2 — clears the weekday level; the chip falls to the
  // standing row. It does NOT take the chore off that weekday: the weekday
  // level answers only *when*, never *whether* (§2.1, §11.3).
  function deleteSlotWeekday(childId, subjectKind, subjectKey, instanceKey, weekday) {
    return request("/api/wall/slots/weekday", {
      method: "DELETE",
      body: {
        childId: childId,
        subjectKind: subjectKind,
        subjectKey: subjectKey,
        instanceKey: instanceKey || "",
        weekday: weekday,
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

  // §5.5/§12 — every school block, household-wide, plus its member courses
  // (Phase 7). Two flat tables, joined client-side — same shape as
  // getSlots()'s slots/days split, and for the same reason: a block carries
  // no date (§5.4 — no per-day override for a block's span in v1), so there
  // is nothing here for a window to bound.
  function getSchoolBlocks() {
    return request("/api/wall/school-blocks").then(function (res) {
      // Placement Scopes §4.2 — `blockWeekdays` is the block's SCHEDULE, so
      // it is not optional decoration: with it absent every block renders on
      // no day (§2.2). The `|| []` below is the honest reading of a Worker
      // that predates Phase 2, and the migrations are applied before the code
      // that uses them (DEPLOY.md) precisely so that window is not entered.
      return {
        blocks: res.blocks || [],
        blockCourses: res.blockCourses || [],
        blockWeekdays: res.blockWeekdays || [],
        blockDates: res.blockDates || [],
      };
    });
  }

  // §5.4 — mints a new block ("+ School"). `label` may be omitted or null
  // for the "School" default.
  //
  // Placement Scopes §4.2/§6.4 — `weekdays` is the block's SCHEDULE, written
  // WITH the block in one `batch()` rather than by follow-up PUTs, because
  // every wall write is online-required with no outbox (§1) and five separate
  // writes have four places to stop halfway. Omitting it is not neutral: the
  // Worker then applies plain Mon-Fri, which is invisible on a weekend
  // (§2.2 — no weekday row, no block). Callers say what they want.
  //
  // The response echoes the list actually stored, so an optimistic append can
  // carry the schedule instead of guessing it.
  function postSchoolBlock(childId, startMin, durationMin, label, weekdays) {
    return request("/api/wall/school-blocks", {
      method: "POST",
      body: {
        childId: childId, startMin: startMin, durationMin: durationMin,
        label: label || null, weekdays: weekdays || null,
      },
    });
  }

  // §5.4 — move (startMin), resize (durationMin) or relabel (label) an
  // existing block. Only the keys present in `fields` change.
  function putSchoolBlock(id, fields) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id), {
      method: "PUT",
      body: fields || {},
    });
  }

  // §5.4 — un-places the block; the Worker cascades to its membership rows.
  function deleteSchoolBlock(id) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id), { method: "DELETE" });
  }

  // Placement Scopes §4.2 (Phase 2's routes, Phase 5a's client) ---------------
  // The block's two override levels. `wall_school_block_weekdays` presence IS
  // the schedule (§2.2), so these two are not a time editor with a scheduling
  // side effect — the PUT is what puts the block on that day and the DELETE is
  // what takes it off.
  //
  // The span is a PAIR at every level (§2.2): both ends or both null, never
  // one. `null`/`null` means "this day happens, at the block's own span",
  // which is what every row migration 0018 backfilled holds.
  function putSchoolBlockWeekday(id, weekday, startMin, endMin) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/weekdays", {
      method: "PUT",
      body: { weekday: weekday, startMin: startMin == null ? null : startMin, endMin: endMin == null ? null : endMin },
    });
  }

  function deleteSchoolBlockWeekday(id, weekday) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/weekdays", {
      method: "DELETE",
      body: { weekday: weekday },
    });
  }

  // §2.2.1 — the per-date exception, which decides its own date outright and
  // in BOTH directions: `occurs: 0` skips a scheduled day, `occurs: 1` adds an
  // unscheduled one. `occurs` is required, not defaulted here, because under
  // §4.1 an omitted field is written NULL and NULL is not a valid `occurs`.
  //
  // A skipped day carries no span — the Worker rejects `occurs: 0` with one
  // (§4.3) rather than accepting and ignoring it, so callers must pass nulls.
  function putSchoolBlockDate(id, date, occurs, startMin, endMin) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/dates", {
      method: "PUT",
      body: {
        date: date, occurs: occurs,
        startMin: startMin == null ? null : startMin,
        endMin: endMin == null ? null : endMin,
      },
    });
  }

  function deleteSchoolBlockDate(id, date) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/dates", {
      method: "DELETE",
      body: { date: date },
    });
  }

  // §5.2 — checking a box in the membership picker. Idempotent.
  function putSchoolBlockCourse(id, courseName) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/courses", {
      method: "PUT",
      body: { courseName: courseName },
    });
  }

  // §5.2 — unchecking a box. Removes only the membership row.
  function deleteSchoolBlockCourse(id, courseName) {
    return request("/api/wall/school-blocks/" + encodeURIComponent(id) + "/courses", {
      method: "DELETE",
      body: { courseName: courseName },
    });
  }

  g.WallApi = {
    UnpairedError: UnpairedError,
    pair: pair,
    getChildren: getChildren,
    getPlan: getPlan,
    getEvents: getEvents,
    getSlots: getSlots,
    putSlot: putSlot,
    deleteSlot: deleteSlot,
    putSlotDay: putSlotDay,
    deleteSlotDay: deleteSlotDay,
    putSlotWeekday: putSlotWeekday,
    deleteSlotWeekday: deleteSlotWeekday,
    postCompletions: postCompletions,
    postRewardEntries: postRewardEntries,
    claim: claim,
    releaseClaim: releaseClaim,
    getSchoolBlocks: getSchoolBlocks,
    postSchoolBlock: postSchoolBlock,
    putSchoolBlock: putSchoolBlock,
    deleteSchoolBlock: deleteSchoolBlock,
    putSchoolBlockWeekday: putSchoolBlockWeekday,
    deleteSchoolBlockWeekday: deleteSchoolBlockWeekday,
    putSchoolBlockDate: putSchoolBlockDate,
    deleteSchoolBlockDate: deleteSchoolBlockDate,
    putSchoolBlockCourse: putSchoolBlockCourse,
    deleteSchoolBlockCourse: deleteSchoolBlockCourse,
    request: request,
  };
})(typeof window !== "undefined" ? window : globalThis);
