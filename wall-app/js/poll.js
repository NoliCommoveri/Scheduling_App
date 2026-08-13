// poll.js — cadence, the roster+plan fetch, since-merge, staleness
// (TDS_Slice_Wall_Display_App.md §5.2). Not a `*-core.js` file — it does the
// app's actual IO — so it isn't unit-tested per §11; `events-core.js`,
// `chores-core.js` and `completed-core.js` hold all the logic worth testing
// in isolation and this file just calls them via app.js/ambient-ui.js.
//
// State lives in one in-memory day map, keyed by assignment id (§5.2.1):
// every row in the current [today-7, today+6] window, patched in place by
// each poll's `since=` delta. A row that comes back rescinded, or claimed by
// a child other than the one it belongs to, is dropped from the map outright
// — neither actionable nor countable, for anyone.

(function (g) {
  "use strict";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function addDays(iso, n) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  // §5.2 — 60s between 06:00 and 22:00 local, 15 minutes overnight.
  function cadenceMs() {
    var hour = new Date().getHours();
    return (hour >= 6 && hour < 22) ? 60 * 1000 : 15 * 60 * 1000;
  }

  var state = {
    today: null,
    children: [],
    rowsById: Object.create(null),
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
  };
  var sinceByChild = Object.create(null);
  var listeners = [];
  var timer = null;
  var running = false;

  function values(obj) {
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  function getState() {
    return {
      today: state.today,
      children: state.children,
      rows: values(state.rowsById),
      lastSuccessAt: state.lastSuccessAt,
      lastAttemptAt: state.lastAttemptAt,
      lastError: state.lastError,
    };
  }

  function notify() {
    var snapshot = getState();
    listeners.forEach(function (fn) {
      try { fn(snapshot); } catch (e) { /* a bad listener must not kill polling */ }
    });
  }

  function mergeRows(rows) {
    (rows || []).forEach(function (row) {
      var drop = row.rescinded_at != null ||
        (row.claimed_by != null && row.claimed_by !== row.child_id);
      if (drop) { delete state.rowsById[row.id]; return; }
      state.rowsById[row.id] = row;
    });
  }

  function maxUpdatedAt(rows, current) {
    var max = current || 0;
    (rows || []).forEach(function (row) {
      if (typeof row.updated_at === "number" && row.updated_at > max) max = row.updated_at;
    });
    return max;
  }

  function fetchChildPlan(child, full) {
    var from = addDays(state.today, -7);
    var to = addDays(state.today, 6);
    var since = full ? null : (sinceByChild[child.id] || null);
    return g.WallApi.getPlan(child.id, from, to, since).then(function (res) {
      mergeRows(res.assignments);
      sinceByChild[child.id] = maxUpdatedAt(res.assignments, since || 0);
    });
  }

  function tick(full) {
    state.lastAttemptAt = Date.now();
    return g.WallApi.getChildren().then(function (children) {
      state.children = children;
      var currentIds = Object.create(null);
      children.forEach(function (c) { currentIds[c.id] = true; });
      // An archived child's watermark is forgotten, so if they come back
      // (un-archived) their window gets a full fetch rather than trusting a
      // stale `since` (§14.3 — un-archiving restores everything).
      Object.keys(sinceByChild).forEach(function (id) {
        if (!currentIds[id]) delete sinceByChild[id];
      });
      return Promise.all(children.map(function (c) { return fetchChildPlan(c, full); }));
    }).then(function () {
      state.lastSuccessAt = Date.now();
      state.lastError = null;
      notify();
    }).catch(function (err) {
      // §5.4 — reads simply fail and the last render stays up; the staleness
      // stamp (driven by lastSuccessAt) is how that becomes visible.
      state.lastError = err;
      notify();
    });
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(function () {
      tick(false).then(scheduleNext);
    }, cadenceMs());
  }

  function start() {
    if (running) return;
    running = true;
    state.today = todayLocal();
    tick(true).then(scheduleNext);
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // Forced fetch, out of cadence — after a write (Phase 4b) or a re-pair.
  function pollNow() {
    if (timer) clearTimeout(timer);
    return tick(false).then(scheduleNext);
  }

  // §5.3 — a new local day: clear the map, recompute `today`, full fetch.
  function rollover() {
    state.rowsById = Object.create(null);
    sinceByChild = Object.create(null);
    state.today = todayLocal();
    if (timer) clearTimeout(timer);
    return tick(true).then(scheduleNext);
  }

  function onUpdate(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  g.Poll = {
    start: start,
    stop: stop,
    pollNow: pollNow,
    rollover: rollover,
    onUpdate: onUpdate,
    getState: getState,
    todayLocal: todayLocal,
    addDays: addDays,
  };
})(typeof window !== "undefined" ? window : globalThis);
