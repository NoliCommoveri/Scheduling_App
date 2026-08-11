// outbox.js — the Child App's write path onto D1.
// TDS_Slice_Online_Revamp.md §5.5 (routes), §7 (rewards), §8.4 (offline).
//
// Online Revamp Phase 4: the mirror image of plan-sync.js. That file owns the
// read — /api/plan into the `assignments` cache. This one owns the write —
// completions, reward entries and the streak, out of the `outbox` store.
// outbox-core.js owns the pure shapes and the coalescing; nothing here does
// arithmetic on a payload.
//
// The contract every caller relies on (CLAUDE.md §III.A): an enqueue resolves
// once the row is durably in IndexedDB, never once it has reached the server.
// A completion is committed the moment the kid taps it, on a train, in a
// basement, with the wifi off. The drain is a separate concern that runs later
// and is allowed to fail indefinitely.

(function (g) {
  "use strict";

  var DEBOUNCE_MS = 1200;
  var BACKOFF_START_MS = 4000;
  var BACKOFF_MAX_MS = 5 * 60 * 1000;

  var C = g.OutboxCore;

  var draining = false;
  var drainQueued = false;
  var debounceTimer = null;
  var retryTimer = null;
  var backoffMs = BACKOFF_START_MS;
  var started = false;

  // Upload bookkeeping is deliberately in memory, not in syncMeta.
  //
  // plan-sync.js writes syncMeta with a read-modify-write around each poll, and
  // a second writer on the same singleton would silently clobber whichever of
  // the two lost the race — including, in the worst case, the device token. The
  // thing that genuinely has to survive a reload is the queue, and the queue is
  // its own store. What is left is a status line, and a status line that resets
  // to "nothing tried yet" after a reload is honest.
  var state = { pending: 0, lastUploadedAt: null, lastError: null };

  function mintId() {
    if (g.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
    // Same fallback shape packet.js uses for batch ids: unique enough to be a
    // primary key, and the server only ever compares it for equality (§5.5).
    return "rw-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // The pairing this device currently holds, or null when unpaired.
  function link() {
    return g.DB.getSingleton("syncMeta").then(function (meta) {
      return meta && meta.deviceToken ? { token: meta.deviceToken, childId: meta.childId || null } : null;
    });
  }

  // Every queued row is stamped with the child it was produced for.
  //
  // This is not bookkeeping — it is a correctness guard. The Worker derives
  // child_id from the token and ignores anything in the body (§4.2), which is
  // exactly right for a device that stays paired to one kid, and exactly wrong
  // for a tablet that gets handed down. Forget the pairing, redeem a code for a
  // sibling, and an undrained queue would post the first child's reward entries
  // under the second child's token — and §3.4's ledger is append-only, so that
  // is not a mistake anyone can take back. Rows that outlive their pairing are
  // discarded at drain time instead.
  function append(childId, op) {
    if (!op) return Promise.resolve(false);
    op.childId = childId;
    return g.DB.outboxAdd(op).then(function () {
      state.pending++;
      scheduleDrain();
      return true;
    });
  }

  // ---- enqueue (called from the write sites, inside their promise chains) ----

  // Only rows that came from /api/plan may be uploaded. Phase 5 deleted the
  // packet import, but this guard is not therefore dead: a device that imported
  // a packet before upgrading still has those rows in activities/chores/events
  // until the §8.1 store drop runs, and POSTing one's id would earn a "Not
  // found for this child" rejection per item, forever. Cache presence is the
  // test rather than the shape of the id, because §3.3.1 is explicit that
  // nothing parses an id.
  function isServerAssignment(assignmentId) {
    if (!assignmentId) return Promise.resolve(false);
    return g.DB.get("assignments", assignmentId).then(function (row) { return !!row; });
  }

  function enqueueCompletion(assignmentId, fields) {
    return Promise.all([link(), isServerAssignment(assignmentId)]).then(function (r) {
      if (!r[0] || !r[1]) return false;
      return append(r[0].childId, C.buildCompletionOp(assignmentId, fields, Date.now()));
    });
  }

  // plannerMeta's vocabulary ({ deferredDate, blockHint, sortOrder }) rather
  // than the column names, so deferment.js and planner-ui.js can pass the exact
  // patch they already write locally and the rename lives in one place.
  function enqueueMeta(assignmentId, patch) {
    return enqueueCompletion(assignmentId, C.completionFieldsFromMeta(patch));
  }

  // §7: earning is a side effect of completion, posted in the same drain. The
  // id is minted here — before the row is stored, let alone sent — so a replay
  // hits the ON CONFLICT DO NOTHING in the Worker instead of appending twice.
  //
  // assignmentId is optional: a spend (Module 6) and a repair adjustment
  // (Module 11 FR-7a) have no assignment behind them, and §3.4 allows NULL.
  function enqueueReward(entry) {
    return link().then(function (paired) {
      if (!paired) return false;
      if (!entry || !entry.category) return false; // an uncategorised local entry has nowhere to land
      return append(paired.childId, C.buildRewardOp(Object.assign({ id: mintId() }, entry), Date.now()));
    });
  }

  function enqueueStreak(streak) {
    return link().then(function (paired) {
      if (!paired) return false;
      return append(paired.childId, C.buildStreakOp(streak, Date.now()));
    });
  }

  // ---- drain ----

  function send(request, token) {
    return fetch(request.path, {
      method: request.method,
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(request.body)
    }).then(function (res) {
      if (res.ok) return { ok: true };
      if (res.status === 401) return { ok: false, unauthorized: true };
      // A 4xx that is not 401 means this request will never succeed: a column
      // the credential does not own (§5.6), a batch the server will not take,
      // a row belonging to another child. Retrying it forever would wedge
      // everything queued behind it, so it is dropped and reported. 408 and 429
      // are the two 4xx that genuinely mean "later".
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, permanent: true, status: res.status };
      }
      return { ok: false, retry: true, status: res.status };
    });
  }

  // Sequential, not parallel. Completions are ordered ahead of the reward
  // entries that reference them (see OutboxCore.plan), and firing both at once
  // would throw that away for a saving measured in milliseconds on a queue this
  // size. Resolves to null when everything went, or to the halting failure.
  function drainRequests(requests, token) {
    return requests.reduce(function (chain, request) {
      return chain.then(function (halted) {
        if (halted) return halted;
        return send(request, token).then(function (result) {
          if (!result.ok && !result.permanent) return result; // halt, keep the rows
          if (result.permanent) {
            state.lastError = "rejected";
            console.error("[outbox] dropping " + request.seqs.length +
              " queued row(s): " + request.path + " returned " + result.status);
          }
          // Deleted only after the response, and only the seqs this request
          // carried — a run that dies halfway leaves the rest queued rather
          // than losing them.
          return g.DB.outboxDelete(request.seqs).then(function () { return null; });
        });
      });
    }, Promise.resolve(null));
  }

  function drain() {
    if (draining) { drainQueued = true; return Promise.resolve(state); }
    draining = true;

    // Three outcomes, deliberately distinct: IDLE (nothing to send, so the
    // "last uploaded" stamp must not move), null (everything went), or the
    // failure that halted the run.
    var IDLE = "idle";

    return g.DB.outboxAll().then(function (rows) {
      state.pending = rows.length;
      if (rows.length === 0) return IDLE;
      return link().then(function (paired) {
        if (!paired) return IDLE;

        // Rows belonging to a pairing this device no longer holds. They cannot
        // be sent — the only credential available would file them under the
        // wrong child (see append) — and they will never become sendable, so
        // holding them would only wedge the queue behind them.
        var foreign = rows.filter(function (row) { return row.childId !== paired.childId; });
        var mine = rows.filter(function (row) { return row.childId === paired.childId; });

        var cleared = foreign.length === 0
          ? Promise.resolve()
          : g.DB.outboxDelete(foreign.map(function (row) { return row.seq; })).then(function () {
              console.warn("[outbox] discarded " + foreign.length +
                " row(s) queued under a previous pairing");
            });

        return cleared.then(function () { return drainRequests(C.plan(mine), paired.token); });
      });
    }).then(function (halt) {
      if (halt === IDLE) {
        // Nothing was queued, or nothing could be: leave the bookkeeping alone
        // rather than reporting a successful upload of zero rows.
      } else if (halt && halt.unauthorized) {
        // Matching plan-sync.js: a 401 does not discard the token. It usually
        // means the parent revoked this device (§4.1), but re-pairing is their
        // call, and a transient server fault must not cost the kid their queue.
        state.lastError = "unauthorized";
        scheduleRetry();
      } else if (halt) {
        state.lastError = "offline";
        scheduleRetry();
      } else {
        state.lastUploadedAt = Date.now();
        if (state.lastError !== "rejected") state.lastError = null;
        backoffMs = BACKOFF_START_MS;
        clearTimeout(retryTimer);
      }
      return state;
    }).catch(function (err) {
      // §8.4: offline is the normal case, not an error state to shout about.
      console.warn("[outbox] drain deferred:", err && err.message ? err.message : err);
      state.lastError = "offline";
      scheduleRetry();
      return state;
    }).then(function (result) {
      return g.DB.outboxCount().then(function (count) {
        state.pending = count;
        draining = false;
        if (drainQueued) { drainQueued = false; scheduleDrain(0); }
        return result;
      });
    });
  }

  function scheduleDrain(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { drain(); }, typeof delay === "number" ? delay : DEBOUNCE_MS);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { drain(); }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }

  // No poll timer of its own. There is nothing to discover on the server side —
  // the queue only grows from local writes, and every one of those schedules a
  // drain. What is left is recovering from a failure, which the backoff covers,
  // and coming back from a dead network, which these two events announce.
  function start() {
    if (started) return;
    started = true;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") scheduleDrain(0);
    });
    window.addEventListener("online", function () { backoffMs = BACKOFF_START_MS; scheduleDrain(0); });
    scheduleDrain(0);
  }

  function status() {
    return g.DB.outboxCount().then(function (count) {
      state.pending = count;
      return { pending: count, lastUploadedAt: state.lastUploadedAt, error: state.lastError };
    });
  }

  g.Outbox = {
    enqueueCompletion: enqueueCompletion,
    enqueueMeta: enqueueMeta,
    enqueueReward: enqueueReward,
    enqueueStreak: enqueueStreak,
    drain: drain,
    start: start,
    status: status
  };
})(typeof window !== "undefined" ? window : globalThis);
