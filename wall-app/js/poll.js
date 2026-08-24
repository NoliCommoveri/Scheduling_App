// poll.js — cadence, the roster+plan fetch, since-merge, staleness
// (TDS_Slice_Wall_Calendar_Redesign.md §10.1, superseding wall slice §5.2's
// 60s/15min split with a flat 10-minute idle cadence — see cadenceMs below).
// Not a `*-core.js` file — it does the app's actual IO — so it isn't
// unit-tested per §14; `events-core.js`, `chores-core.js` and
// `slots-core.js` hold all the logic worth testing in isolation and this
// file just calls them via app.js/day-ui.js. `pollNow` is also how
// nav-ui.js's interaction-triggered polls (§10.1: a tap, a view change, a
// date change, a refresh) reach the network — it is not new to this file.
//
// State lives in one in-memory day map, keyed by assignment id (§5.2.1):
// every row in the current window, patched in place by each poll's `since=`
// delta. A row that comes back rescinded, or claimed by a child other than
// the one it belongs to, is dropped from the map outright — neither
// actionable nor countable, for anyone.
//
// Wall Calendar Redesign §12 adds `slots`/`slotDays`: one household-wide,
// full-replace fetch per tick (placements have no per-child `since` to
// delta against), riding alongside the plan fan-out in the same `tick()`.
//
// ---------------------------------------------------------------------------
// THE WINDOW FOLLOWS THE NAV (code review, 2026-08-24)
//
// The window was pinned to [today-7, today+6] and nothing recomputed it for
// the date actually on screen, while nav-ui.js will step the day view a day
// at a time and the week view SEVEN days at a time with no clamp. So the
// week view's "next week" was routinely half outside the fetch window: on a
// Wednesday, next Thursday through Saturday had no rows in the map at all
// and rendered as genuinely empty days. Nothing distinguished "nothing
// scheduled" from "never fetched" — and school blocks DID draw on those days
// (they resolve from weekday rows, which carry no date and need no window),
// so an unfetched day looked like an authoritative answer.
//
// The window is now the base window UNIONED with whatever range the rendered
// view asks for, through `setRange` (app.js calls it on every nav change).
// Two properties hold it together:
//
//   * the base is always included, so `today` is always loaded whatever the
//     nav is pointed at — the chime (app.js's remind tick) and the overdue
//     roll-forward (chores-core.js's `onDate`) both read it;
//   * the extension is capped at MAX_AHEAD_DAYS/MAX_BEHIND_DAYS, so one plan
//     query per child per tick stays bounded however far the stepper is
//     tapped. Past the cap the date is simply not loaded, and `rangeFrom`/
//     `rangeTo` on the state say so out loud rather than leaving day-ui.js
//     and week-ui.js to draw an empty day (they render §5.4's out-of-range
//     notice instead).
//
// `rangeReady` is false from the moment the window changes until a tick has
// landed on it — the difference between "outside the range" (a settled
// answer) and "not fetched yet" (a moment away), which the two views word
// differently.
//
// ---------------------------------------------------------------------------
// ONE FETCH AT A TIME (code review, 2026-08-24)
//
// `scheduleNext` used to assign `timer` without clearing what was already
// there, and `pollNow` called it on every resolution. Two overlapping
// `pollNow()` calls therefore left the first chain's timeout armed AND
// started a second — and chains only ever multiplied. Every discrete nav
// interaction polls (§10.1), so opening the hamburger and then tapping a
// view was enough to leak one, permanently, per pair of taps. On a tablet
// meant to run for months that compounds into a fan-out several times per
// cadence period, each one tearing down and rebuilding the day view under
// the family's hands.
//
// So: `scheduleNext` clears before it arms, and `runTick` is the one door to
// `tick()`. A request arriving while a fetch is in flight does not start a
// second fan-out — it sets `queued` and runs exactly once more when the
// current one lands. That re-run is not politeness: complete-ui.js's
// `refreshRow` depends on `pollNow()` resolving against data fetched AFTER
// its call (§6.1's "re-poll and refuse a row that is no longer pending"),
// which coalescing into an already-running tick would quietly break.

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

  // §10.1 — a flat 10-minute idle cadence, day and night alike. Replaces
  // the wall slice's 60s/15min split: interaction-triggered polls (pollNow,
  // driven by nav-ui.js) are what keeps the board feeling responsive while
  // someone is actually at the tablet, so the idle cadence no longer needs
  // to be fast during the day to compensate.
  function cadenceMs() {
    return 10 * 60 * 1000;
  }

  // The window that is always loaded, whatever the nav is pointed at.
  var BASE_BACK_DAYS = 7;
  var BASE_FWD_DAYS = 6;

  // How far FORWARD a rendered view may drag the window. Eight weeks is far
  // more than a family steps to in practice (the week stepper needs eight
  // taps to reach it) and keeps one plan query per child comfortably inside
  // the Worker's own MAX_QUERY_ROWS cap. Past this the date is not loaded and
  // the views say so.
  var MAX_AHEAD_DAYS = 56;

  // And BACKWARD: not at all, deliberately, which is why this is a named zero
  // rather than an absent case.
  //
  // The back edge is load-bearing in a way the forward edge is not.
  // chores-core.js's `onDate` rolls an overdue chore forward onto today for
  // as long as it is pending and required, and the only thing bounding that
  // "forever" is the 7 days of history this window holds — its own header
  // says so. Widening the back edge would therefore quietly change what
  // TODAY shows: navigate back a month to look at something, come back, and
  // today's grid carries a month of accumulated overdue chores that the
  // child's own tablet (its own fetch window, its own `planner-core.js`)
  // does not show. That is CLAUDE.md §IV.B's "the wall and the child's
  // tablet disagree about what is due today", arriving through the back door.
  //
  // So stepping back past today-7 reports the day as outside the loaded range
  // rather than fetching it. Lifting this means giving the roll-forward an
  // explicit bound of its own first, in both apps — a design change, not a
  // constant.
  var MAX_BEHIND_DAYS = 0;

  var state = {
    today: null,
    children: [],
    rowsById: Object.create(null),
    slots: [],
    slotDays: [],
    slotWeekdays: [],
    schoolBlocks: [],
    schoolBlockCourses: [],
    schoolBlockWeekdays: [],
    schoolBlockDates: [],
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    // The window the plan fan-out is fetching, and whether a tick has landed
    // on it yet. day-ui.js and week-ui.js read both: a date outside the range
    // draws the out-of-range notice, and `rangeReady === false` is what makes
    // the moment right after a far navigation say "Loading…" instead.
    rangeFrom: null,
    rangeTo: null,
    rangeReady: false,
  };
  var sinceByChild = Object.create(null);
  var listeners = [];
  var timer = null;
  var running = false;
  // What the rendered view asked for, via setRange — null until app.js says.
  var needFrom = null;
  var needTo = null;
  // The one-fetch-at-a-time gate. `inFlight` is the running tick's promise;
  // `queued` remembers that somebody asked while it was running, so exactly
  // one more tick follows it rather than a second fan-out starting now.
  var inFlight = null;
  var queued = false;
  var queuedFull = false;

  function values(obj) {
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  function getState() {
    return {
      today: state.today,
      children: state.children,
      rows: values(state.rowsById),
      slots: state.slots,
      slotDays: state.slotDays,
      slotWeekdays: state.slotWeekdays,
      schoolBlocks: state.schoolBlocks,
      schoolBlockCourses: state.schoolBlockCourses,
      schoolBlockWeekdays: state.schoolBlockWeekdays,
      schoolBlockDates: state.schoolBlockDates,
      lastSuccessAt: state.lastSuccessAt,
      lastAttemptAt: state.lastAttemptAt,
      lastError: state.lastError,
      rangeFrom: state.rangeFrom,
      rangeTo: state.rangeTo,
      rangeReady: state.rangeReady,
    };
  }

  // The base window unioned with whatever the rendered view asked for, with
  // the extension capped either side. The base is never given up: `today`
  // must stay loaded for the chime and the overdue roll-forward whatever
  // date the nav is showing.
  function computeWindow() {
    var from = addDays(state.today, -BASE_BACK_DAYS);
    var to = addDays(state.today, BASE_FWD_DAYS);
    // The caps are distances from `today`, and they are held at the base's
    // own edges so a cap can only ever refuse to WIDEN the window — never
    // narrow it. MAX_BEHIND_DAYS is 0 and BASE_BACK_DAYS is 7, so without the
    // max() below a backward ask would clamp the back edge to today and drop
    // the week of history the overdue roll-forward reads.
    var floor = addDays(state.today, -Math.max(BASE_BACK_DAYS, MAX_BEHIND_DAYS));
    var ceil = addDays(state.today, Math.max(BASE_FWD_DAYS, MAX_AHEAD_DAYS));
    if (needFrom && needFrom < from) from = needFrom < floor ? floor : needFrom;
    if (needTo && needTo > to) to = needTo > ceil ? ceil : needTo;
    return { from: from, to: to };
  }

  // Adopts a window if it differs from the one in force. Returns whether it
  // changed — a changed window means the per-child `since` watermarks are
  // meaningless (they were earned against a narrower set of dates, so a
  // delta would skip every unchanged row in the days just added) and the
  // next tick has to be a full one.
  function adoptWindow() {
    var win = computeWindow();
    if (win.from === state.rangeFrom && win.to === state.rangeTo) return false;
    state.rangeFrom = win.from;
    state.rangeTo = win.to;
    state.rangeReady = false;
    sinceByChild = Object.create(null);
    return true;
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
    var from = state.rangeFrom;
    var to = state.rangeTo;
    var since = full ? null : (sinceByChild[child.id] || null);
    return g.WallApi.getPlan(child.id, from, to, since).then(function (res) {
      mergeRows(res.assignments);
      sinceByChild[child.id] = maxUpdatedAt(res.assignments, since || 0);
    });
  }

  function tick(full) {
    state.lastAttemptAt = Date.now();
    // The window may have moved since the last tick (a nav step, or a
    // rollover shifting the base) — adopt it here so the cadence tick and an
    // interaction-triggered one can never disagree about what they fetched.
    if (adoptWindow()) full = true;
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
      // Placements are household-wide and have no per-child `since` — one
      // fetch alongside the plan fan-out, not one per child (§12). School
      // blocks (§5.5, Phase 7) are the same shape for the same reason.
      return Promise.all(
        children.map(function (c) { return fetchChildPlan(c, full); })
          .concat([g.WallApi.getSlots().then(function (res) {
            state.slots = res.slots;
            state.slotDays = res.days;
            state.slotWeekdays = res.slotWeekdays;
          })])
          .concat([g.WallApi.getSchoolBlocks().then(function (res) {
            state.schoolBlocks = res.blocks;
            state.schoolBlockCourses = res.blockCourses;
            state.schoolBlockWeekdays = res.blockWeekdays;
            state.schoolBlockDates = res.blockDates;
          })])
      );
    }).then(function () {
      state.lastSuccessAt = Date.now();
      state.lastError = null;
      // The window is only "ready" once a tick has actually landed on it.
      // A failed tick leaves it false, so the views keep saying "Loading…"
      // rather than claiming a date is out of range on the strength of a
      // fetch that never happened.
      state.rangeReady = true;
      notify();
    }).catch(function (err) {
      // §5.4 — reads simply fail and the last render stays up; the staleness
      // stamp (driven by lastSuccessAt) is how that becomes visible.
      state.lastError = err;
      notify();
    });
  }

  // The one door to `tick()`. Never starts a second fan-out on top of a
  // running one; a request that arrives mid-flight runs exactly once more
  // when the current tick lands, and the returned promise resolves after
  // THAT re-run — which is what complete-ui.js's `refreshRow` needs (§6.1).
  function runTick(full) {
    if (inFlight) {
      queued = true;
      queuedFull = queuedFull || !!full;
      return inFlight;
    }
    inFlight = tick(full).then(function () {
      inFlight = null;
      if (!queued) return;
      var again = queuedFull;
      queued = false;
      queuedFull = false;
      return runTick(again);
    });
    return inFlight;
  }

  // Arms the idle cadence, clearing whatever was already armed. Clearing
  // first is the whole fix: without it every resolution added a timeout and
  // orphaned the last one, so overlapping polls multiplied the chains.
  function scheduleNext() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!running) return;
    timer = setTimeout(function () {
      timer = null;
      runTick(false).then(scheduleNext);
    }, cadenceMs());
  }

  function start() {
    if (running) return;
    running = true;
    state.today = todayLocal();
    adoptWindow();
    runTick(true).then(scheduleNext);
  }

  function stop() {
    running = false;
    queued = false;
    queuedFull = false;
    // A torn-down shell renders nothing, so it needs nothing. Dropping the
    // need here keeps a settings round-trip taken from a far-off date from
    // re-fetching that date's window on the way back in, only for the
    // freshly-mounted nav (which lands on today, §4.1) to narrow it again.
    needFrom = null;
    needTo = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // Forced fetch, out of cadence — after a write (Phase 4b) or a re-pair.
  function pollNow() {
    return runTick(false).then(scheduleNext);
  }

  // The rendered view declaring the dates it needs (app.js, on every nav
  // change). Widening the window is a full fetch; a range already covered
  // costs nothing at all, which is the common case — stepping from today to
  // tomorrow is inside the base window and asks for no network of its own.
  function setRange(from, to) {
    if (from === needFrom && to === needTo) return Promise.resolve();
    needFrom = from || null;
    needTo = to || null;
    if (!running || !state.today) return Promise.resolve();
    if (!adoptWindow()) return Promise.resolve();
    // Say so before the fetch, not after: the render that follows this nav
    // change happens immediately, and it has to know the window it is being
    // asked to draw is not loaded yet.
    notify();
    return runTick(true).then(scheduleNext);
  }

  // §5.3 — a new local day: clear the map, recompute `today`, full fetch.
  function rollover() {
    state.rowsById = Object.create(null);
    sinceByChild = Object.create(null);
    state.today = todayLocal();
    // The base window moves with `today`, so the whole window is re-derived
    // — including any extension the nav still has outstanding, though
    // app.js's own rollover puts the nav back on today first (§4.1/§10.3).
    adoptWindow();
    return runTick(true).then(scheduleNext);
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
    setRange: setRange,
    rollover: rollover,
    onUpdate: onUpdate,
    getState: getState,
    todayLocal: todayLocal,
    addDays: addDays,
  };
})(typeof window !== "undefined" ? window : globalThis);
