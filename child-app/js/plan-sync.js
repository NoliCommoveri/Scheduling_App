// plan-sync.js — the Child App's read path onto D1.
// TDS_Slice_Online_Revamp.md §5.5 (routes), §8.3 (freshness), §8.4 (offline).
//
// Online Revamp Phase 3B: the planner stops depending on a hand-carried packet
// file and reads the plan the parent committed. This file owns the network and
// the `assignments` cache; assignment-core.js owns the pure row→planner mapping;
// planner-ui.js is untouched below the reload hook.
//
// Write path — completions, rewards, streak upload — is Phase 4. Nothing here
// POSTs anything. A completion still commits to the local stores and stays
// there until that phase lands.

(function (g) {
  "use strict";

  // §8.3: launch, visibilitychange→visible, and every 60s while open. No
  // WebSockets, no push. At a kid's usage pattern the difference is invisible.
  var POLL_MS = 60000;

  // §5.5's default window (today−7 … today+14), computed on this side rather
  // than left to the server's default so the client can tell when the window
  // itself has moved. That matters: the window slides every day, and a `since`
  // delta would silently skip rows that entered the window without being
  // touched. See the windowMoved branch in run().
  var PAST_DAYS = 7;
  var FUTURE_DAYS = 14;

  var inFlight = null;
  var timer = null;
  var started = false;
  var listeners = [];

  function currentWindow() {
    var today = g.DateUtil.today();
    return { from: g.DateUtil.addDays(today, -PAST_DAYS), to: g.DateUtil.addDays(today, FUTURE_DAYS) };
  }

  // The device token is a scoped bearer (§4.1). It never leaves this device and
  // is never put in a URL — only the Authorization header, so it cannot end up
  // in a log line or a Referer.
  function apiGet(path, token) {
    return fetch(path, {
      method: "GET",
      headers: { "Authorization": "Bearer " + token },
      cache: "no-store"
    }).then(function (res) {
      if (res.status === 401) {
        var revoked = new Error("Unauthorized");
        revoked.unauthorized = true;
        throw revoked;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  // §5.5 sends rescinded rows on purpose, so the client can remove them rather
  // than never learning they were pulled. A rescinded row the child already
  // completed is kept: §6.3 — the work was done, the reward stands, and the
  // adapter's status filter is what keeps it out of future planning.
  //
  // pruneTo, when given, also drops cached rows that have fallen outside the
  // window. See the [DECISION] note in run().
  function ingest(rows, pruneTo) {
    var puts = [];
    var deletes = [];
    var keep = Object.create(null);

    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      keep[row.id] = true;
      if (row.rescinded_at != null && (row.status || "pending") === "pending") deletes.push(row.id);
      else puts.push(row);
    });

    var stale = pruneTo
      ? g.DB.getAll("assignments").then(function (cached) {
          return cached
            .filter(function (c) { return !keep[c.id] && (c.date < pruneTo.from || c.date > pruneTo.to); })
            .map(function (c) { return c.id; });
        })
      : Promise.resolve([]);

    return stale.then(function (outOfWindow) {
      var allDeletes = deletes.concat(outOfWindow);
      // A row's own child-owned columns are its only override (§14 folded
      // plannerMeta into them), so a delete here needs no separate cleanup —
      // an override no longer has anywhere to be orphaned to.
      return g.DB.applyPlan(puts, allDeletes).then(function () {
        return { puts: puts.length, deletes: allDeletes.length };
      });
    });
  }

  // syncMeta is the one singleton this app keeps about the server relationship:
  // the token and childId from pairing (§4.3 step 5), plus the bookkeeping below.
  // Written through Object.assign so a failed sync can never drop the token.
  function record(meta, patch) {
    var next = Object.assign({}, meta);
    if ("lastVersion" in patch) next.lastVersion = patch.lastVersion;
    if ("lastRange" in patch) next.lastRange = patch.lastRange;
    if (patch.ok) {
      next.lastSyncedAt = Date.now();
      next.lastError = null;
    } else {
      next.lastError = patch.unauthorized ? "unauthorized" : "offline";
    }
    return g.DB.putSingleton("syncMeta", next).then(function () { return next; });
  }

  function run() {
    return g.DB.getSingleton("syncMeta").then(function (meta) {
      if (!meta || !meta.deviceToken) return { changed: false, skipped: "unpaired" };

      var token = meta.deviceToken;
      var win = currentWindow();

      // The version probe is read BEFORE the plan fetch, deliberately. Anything
      // written between the two calls has an updated_at above the value stored
      // here, so the next poll picks it up. Reading it after would store a
      // watermark covering rows this fetch never saw, and they would be skipped
      // forever.
      return apiGet("/api/plan/version", token).then(function (version) {
        var serverVersion = typeof version.maxUpdatedAt === "number" ? version.maxUpdatedAt : null;
        var haveVersion = typeof meta.lastVersion === "number";
        var windowMoved = !meta.lastRange || meta.lastRange.from !== win.from || meta.lastRange.to !== win.to;
        var newer = !haveVersion || (serverVersion !== null && serverVersion > meta.lastVersion);

        if (!windowMoved && !newer) {
          return record(meta, { lastRange: win, ok: true }).then(function () {
            return { changed: false };
          });
        }

        // A `since` delta is only safe while the window is unchanged. A window
        // that has slid forward pulls in rows whose updated_at predates
        // lastVersion — exactly the rows `since` filters out — so a moved
        // window forces a full fetch of the new range. In practice that is one
        // full fetch per day, a few hundred rows.
        var url = "/api/plan?from=" + win.from + "&to=" + win.to;
        if (!windowMoved && haveVersion) url += "&since=" + meta.lastVersion;

        return apiGet(url, token).then(function (plan) {
          // [DECISION] What happens to cached rows that fall out of the window
          // Decided: a full fetch prunes them; a delta leaves the cache alone.
          // Rationale: the response for a range is authoritative for that range,
          //   and once a row is outside the window the server will not mention
          //   it again — not even to say it was rescinded. Holding a copy the
          //   device can no longer verify is worse than holding none, and it
          //   would grow without bound. The visible cost is that work still
          //   pending more than a week past its date stops appearing in the
          //   overdue rollup; past that point rescheduling it is a parent act
          //   (PATCH /api/assignments/:id, §6.5), not something the kid's
          //   planner should keep nagging about from unverifiable data.
          // Locked for: Phase 3B. The TDS does not specify a cache policy.
          return ingest(plan.assignments || [], windowMoved ? win : null).then(function (counts) {
            return record(meta, {
              lastVersion: serverVersion !== null ? serverVersion : (haveVersion ? meta.lastVersion : 0),
              lastRange: win,
              ok: true
            }).then(function () {
              return { changed: counts.puts + counts.deletes > 0 };
            });
          });
        });
      }).catch(function (err) {
        // §8.4: offline is tolerated, not an error state to shout about. The
        // cached plan stays on screen; the next tick tries again.
        //
        // A 401 does NOT delete the token. It usually means the parent revoked
        // this device (§4.1), but discarding the credential on one failed
        // request would also punish a transient server problem — and re-pairing
        // is the parent's call, not something this app should force. Settings
        // surfaces the state instead.
        return record(meta, { ok: false, unauthorized: !!err.unauthorized }).then(function () {
          return { changed: false, error: err.unauthorized ? "unauthorized" : "offline" };
        });
      });
    });
  }

  // One sync at a time. The 60s timer, a tab becoming visible, and a fresh pair
  // can all fire within the same moment; without this they would race each
  // other's syncMeta write and could store a watermark for a fetch that lost.
  function sync() {
    if (inFlight) return inFlight;
    inFlight = run().then(
      function (result) { inFlight = null; return result; },
      function (err) { inFlight = null; throw err; }
    );
    return inFlight;
  }

  function tick() {
    return sync().then(function (result) {
      if (result && result.changed) {
        listeners.forEach(function (fn) {
          try { fn(result); } catch (e) { console.error(e); }
        });
      }
      return result;
    }).catch(function (e) {
      console.error(e);
      return { changed: false, error: "failed" };
    });
  }

  // onChange fires only when the cache actually moved, so a quiet poll never
  // costs a re-render (and never steals focus from a dialog the kid has open).
  function start(onChange) {
    if (typeof onChange === "function") listeners.push(onChange);
    if (started) return;
    started = true;

    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") tick();
    });
    window.addEventListener("online", tick);
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    listeners = [];
  }

  // What Settings shows about the link. Derived, never stored as prose.
  //
  // `childId` rides along for Shared Chores §6.3: planner-ui's load fan-out
  // already calls this once per render, so this is where `state.selfChildId`
  // comes from rather than a second singleton read in that fan-out.
  function status() {
    return g.DB.getSingleton("syncMeta").then(function (meta) {
      if (!meta || !meta.deviceToken) return { paired: false };
      return {
        paired: true,
        childId: meta.childId || null,
        childName: meta.childName || null,
        lastSyncedAt: meta.lastSyncedAt || null,
        error: meta.lastError || null
      };
    });
  }

  g.PlanSync = {
    start: start,
    stop: stop,
    syncNow: tick,
    status: status,
    POLL_MS: POLL_MS
  };
})(typeof window !== "undefined" ? window : globalThis);
