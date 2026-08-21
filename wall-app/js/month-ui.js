// month-ui.js — the month view (TDS_Slice_Wall_Calendar_Redesign.md §7):
// six week-rows of seven day-cells, Sunday-first, showing EVENTS ONLY.
//
// Chores are deliberately absent, per §7.1: they recur near-daily, so
// drawing them on a month grid produces a wall of identical chips that says
// nothing. The week view reached the same conclusion from the other
// direction and collapsed a day's chores to one token (see week-ui.js's
// header); here they are simply not drawn.
//
// This is the ONE view that fetches for itself. `Poll`'s window is a
// fortnight ([today-7, today+6], poll.js) and a month grid draws 42 days —
// §7.2's household-wide `GET /api/wall/events` exists exactly so that is
// one query rather than a per-child plan call multiplied by the roster.
// Rather than run a second timer for it, the fetch rides `Poll`'s own
// heartbeat: `render()` refetches when the drawn window changes, and when
// the poll state's `lastSuccessAt` has advanced since the last fetch. So
// the month refreshes on the same 10-minute cadence and on every
// interaction-triggered poll (§10.1) without owning a clock of its own, and
// spends nothing at all while some other view is on screen.
//
// How many events a cell draws is MEASURED, not capped at a constant: a
// cell is a sixth of the screen's height and an event's height depends on
// whether it carries a multi-day span label, so the number that fits
// comfortably at 1280x800 clips mid-line at 1024x600. `fitGrid` below
// measures the whole grid in one layout and then answers arithmetically;
// `MonthCore.largestFit` owns the search over that answer.
//
// Tapping a cell opens that day's day view (§7.1). Tapping "+N more" opens
// a read-only sheet with that day's full list instead — the affordance
// exists to answer "what are the other two" without leaving the month, and
// carries its own "Open day" for when that is what was wanted after all.
// Nothing here writes: events have no completion lifecycle (§8.1).

(function (g) {
  "use strict";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  function dayLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  // ---- fetch lifecycle (§7.2) ---------------------------------------------

  // `cache.key` is the window whose rows are currently DRAWABLE, "from|to".
  // `attemptKey`/`attemptStamp` describe the most recent fetch ATTEMPT,
  // which is a different thing: a fetch that failed leaves `cache` alone
  // (§5.4 — "reads simply fail and the last render stays up") but must
  // still be remembered, or the re-render its own failure triggers would
  // see an unloaded window and fire the same doomed request again, forever.
  //
  // So the two conditions to fetch are: the drawn window is not the one we
  // last asked for, or the poll has ticked since we asked. A failure
  // satisfies neither and simply waits for the next tick — which is also
  // what the refresh button produces (§10.1).
  var cache = { key: null, rows: [], error: null };
  var attemptKey = null;
  var attemptStamp = null;
  var attemptAt = 0;
  var inFlight = false;

  // Every discrete interaction (§10.1) fires BOTH a state-change render and
  // a poll, and that poll's fresh `lastSuccessAt` lands a fraction of a
  // second after the render. Without a floor under the heartbeat rule, each
  // one would spend two identical queries about a tenth of a second apart —
  // measured, not theorised. Five seconds is far longer than that burst and
  // far shorter than anything a person waits through, so the 10-minute
  // cadence and a deliberate second press of Refresh both still reload.
  var REFETCH_FLOOR_MS = 5000;

  function shouldFetch(key, stamp, now) {
    if (inFlight && attemptKey === key) return false;
    if (attemptKey !== key) return true; // a different month — always, at once
    if (!stamp || stamp === attemptStamp) return false;
    return now - attemptAt >= REFETCH_FLOOR_MS;
  }

  function fetchWindow(key, win, stamp, now) {
    attemptKey = key;
    attemptStamp = stamp;
    attemptAt = now;
    inFlight = true;
    g.WallApi.getEvents(win.from, win.to).then(function (rows) {
      // A month step overtook this fetch: a newer attempt owns the state
      // now, and applying these rows would paint the wrong month.
      if (attemptKey !== key) return;
      inFlight = false;
      cache = { key: key, rows: rows, error: null };
      rerenderNow();
    }).catch(function (err) {
      if (attemptKey !== key) return;
      inFlight = false;
      cache.error = err;
      rerenderNow();
      // A 401 here is not handled locally: `Poll`'s own next tick raises the
      // same UnpairedError and app.js routes the whole shell to the
      // "This display has been unpaired" screen (api.js). One owner for that
      // transition, not two.
    });
  }

  // ---- the "+N more" sheet -------------------------------------------------

  var overflowDate = null;

  function buildOverflowSheet(cell, opts) {
    var overlay = el(
      '<div class="duration-sheet-overlay month-more-overlay">' +
        '<div class="duration-sheet-card month-more-card">' +
          "<h2></h2>" +
          '<div class="month-more-body"></div>' +
          '<div class="duration-sheet-actions">' +
            '<button class="btn ghost" id="monthOpenDay">Open day</button>' +
            '<button class="btn" id="monthMoreDone">Close</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    overlay.querySelector("h2").textContent = dayLabel(cell.date);

    var body = overlay.querySelector(".month-more-body");
    cell.events.forEach(function (row) {
      body.appendChild(el(eventRowHtml(row, cell.date)));
    });

    // §20's 2026-08-21 (second pass) item 2 — every sheet on this wall
    // dismisses on `pointerdown`, never `click`, so the press that opened it
    // cannot also close it.
    overlay.addEventListener("pointerdown", function (ev) {
      if (ev.target === overlay) closeOverflow();
    });
    overlay.querySelector("#monthMoreDone").addEventListener("click", closeOverflow);
    overlay.querySelector("#monthOpenDay").addEventListener("click", function () {
      var date = cell.date;
      closeOverflow();
      if (opts.onDayTap) opts.onDayTap(date);
    });
    return overlay;
  }

  function openOverflow(date) {
    overflowDate = date;
    rerenderNow();
  }

  function closeOverflow() {
    overflowDate = null;
    rerenderNow();
  }

  // ---- cells ----------------------------------------------------------------

  // The sheet's full-detail line — the same `.event-row` markup the day
  // band and the week rows use (day-ui.js), reused rather than restyled.
  function eventRowHtml(row, date) {
    var p = parsePayload(row.payload);
    var span = g.EventsCore.spanLabel(row, date);
    var bits = [];
    if (p.time) bits.push('<span class="event-time">' + escapeHtml(p.time) + "</span>");
    bits.push('<span class="event-title">' + escapeHtml(row.title) + "</span>");
    if (span) bits.push('<span class="event-span">' + escapeHtml(span) + "</span>");
    return '<div class="event-row">' + bits.join("") + "</div>";
  }

  // The in-cell line, a different shape from the sheet's: a month cell is
  // roughly a seventh of the screen wide and a sixth of it tall, so time,
  // title and §7.1's `Day 2 of 4` share ONE line, with only the title
  // ellipsizing. The span rode a second line first; measured on a 1024x600
  // tablet that made a spanned event taller than a cell's whole event area,
  // so days in the middle of a visit drew "+3 more" and nothing else. One
  // line each keeps at least one real event in every cell, and the full
  // untruncated text is a tap away in either direction — the "+N more"
  // sheet, or the day view.
  function cellEventHtml(row, date) {
    var p = parsePayload(row.payload);
    var span = g.EventsCore.spanLabel(row, date);
    return '<div class="month-event"><div class="month-event-head">' +
      (p.time ? '<span class="month-event-time">' + escapeHtml(p.time) + "</span>" : "") +
      '<span class="month-event-title">' + escapeHtml(row.title) + "</span>" +
      (span ? '<span class="month-event-span">' + escapeHtml(span) + "</span>" : "") +
      "</div></div>";
  }

  function buildCell(cell, today, opts) {
    var node = el('<div class="month-cell"></div>');
    if (!cell.inMonth) node.classList.add("out-of-month");
    if (cell.date === today) node.classList.add("today");
    if (cell.events.length) node.classList.add("has-events");

    node.appendChild(el('<div class="month-cell-date">' + cell.dayNum + "</div>"));

    // Every event is built; `fitCell` below decides how many stay visible,
    // once the cell has a real height to measure against.
    var list = el('<div class="month-cell-events"></div>');
    cell.events.forEach(function (row) { list.appendChild(el(cellEventHtml(row, cell.date))); });
    node.appendChild(list);

    // The affordance lives INSIDE the events list, not beside it. That is
    // what makes `fitGrid`'s arithmetic possible: the list's own height is
    // fixed by the cell's flex layout, so it does not change when the
    // affordance appears or goes, and "does this set of children fit" can
    // be answered by adding heights rather than by laying out again.
    // Built for any cell with something to hide; removed in `fitGrid` if
    // the whole day turned out to fit. An empty cell never gets one.
    if (cell.events.length) {
      var more = el('<button class="month-more-btn" type="button"></button>');
      more.addEventListener("click", function (ev) {
        ev.stopPropagation(); // the cell's own tap means "open the day"
        openOverflow(cell.date);
      });
      list.appendChild(more);
    }

    // §7.1 — "Tapping a day opens that day's day view."
    node.addEventListener("click", function () {
      if (opts.onDayTap) opts.onDayTap(cell.date);
    });

    return node;
  }

  // The measured half of §7.1's "+N more". Must run AFTER the grid is in the
  // document — a detached node has no height to overflow.
  //
  // Deliberately structured as WRITE, then READ, then WRITE, over the whole
  // grid rather than cell by cell. The obvious shape — set a cell's state,
  // read whether it fits, repeat — interleaves writes with reads and so
  // forces the browser to lay the page out again on every single question:
  // measured at ~200ms per render on a month carrying six events a day,
  // which on a low-powered wall tablet is a visible stutter every ten
  // minutes. Batched this way the whole grid costs one layout, and the fit
  // question becomes arithmetic over heights read in that one pass.
  //
  // `MonthCore.largestFit` still owns the search; only its `fits` is now a
  // sum rather than a re-layout.
  function fitGrid(shell, cells) {
    var nodes = shell.querySelectorAll(".month-cell");
    var plans = [];
    var i, k;

    // ---- write: every cell into its tallest state, so one layout can
    // measure both an event's height and the affordance's ----
    for (i = 0; i < nodes.length; i++) {
      var total = cells[i].events.length;
      if (!total) continue;
      var more = nodes[i].querySelector(".month-more-btn");
      more.textContent = "+" + total + " more";
      plans.push({
        list: nodes[i].querySelector(".month-cell-events"),
        more: more,
        total: total,
      });
    }
    if (!plans.length) return;

    // ---- read: no write in between, so this is one layout for the grid.
    // The row gap is a stylesheet constant, so it is read once rather than
    // per cell — `getComputedStyle` is itself a measurement. ----
    var gap = parseFloat(getComputedStyle(plans[0].list).rowGap) || 0;
    for (i = 0; i < plans.length; i++) {
      var plan = plans[i];
      plan.gap = gap;
      plan.avail = plan.list.clientHeight;
      plan.moreH = plan.more.offsetHeight;
      plan.heights = [];
      for (k = 0; k < plan.total; k++) plan.heights.push(plan.list.children[k].offsetHeight);
      plan.n = g.MonthCore.largestFit(plan.total, fitsIn(plan));
    }

    // ---- write: apply the answers ----
    for (i = 0; i < plans.length; i++) apply(plans[i]);
  }

  // The height of a cell drawing its first `n` events, plus the affordance
  // when `n` is short of the whole day — the affordance's own line is part
  // of what must fit, never an addition made afterwards.
  function stackHeight(plan, n) {
    var count = n + (n < plan.total ? 1 : 0);
    if (count === 0) return 0;
    var sum = 0;
    for (var k = 0; k < n; k++) sum += plan.heights[k];
    if (n < plan.total) sum += plan.moreH;
    return sum + plan.gap * (count - 1);
  }

  function fitsIn(plan) {
    return function (n) {
      return stackHeight(plan, n) <= plan.avail + 1; // 1px for sub-pixel rounding
    };
  }

  function apply(plan) {
    for (var k = 0; k < plan.total; k++) {
      plan.list.children[k].style.display = k < plan.n ? "" : "none";
    }
    if (plan.n < plan.total) plan.more.textContent = "+" + (plan.total - plan.n) + " more";
    // A cell that drew its whole day has no use for the affordance it was
    // measured against, so it goes rather than lingering as a hidden node.
    else plan.more.remove();
  }

  // ---- assembly --------------------------------------------------------------

  var current = { state: null, date: null, opts: {} };
  var currentRoot = null;

  function rerenderNow() {
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
  }

  function buildGrid(cells, today, opts) {
    var shell = el(
      '<div class="month-view">' +
        '<div class="month-dow-row"></div>' +
        '<div class="month-grid"></div>' +
      "</div>"
    );
    var dow = shell.querySelector(".month-dow-row");
    g.MonthCore.DOW_LABELS.forEach(function (label) {
      dow.appendChild(el('<div class="month-dow">' + escapeHtml(label) + "</div>"));
    });
    var grid = shell.querySelector(".month-grid");
    cells.forEach(function (cell) { grid.appendChild(buildCell(cell, today, opts)); });
    return shell;
  }

  // `state` is Poll.getState()'s shape — used here only for `today` (the
  // highlighted cell) and `lastSuccessAt` (the refetch heartbeat). The
  // events themselves come from this file's own fetch, never from
  // `state.rows`, whose window is a fortnight and would silently draw an
  // empty second half of the month.
  //
  // `date` is nav-ui.js's anchor date; the month drawn is the one containing
  // it. `opts.onDayTap(date)` navigates to that day's day view.
  function render(root, state, date, opts) {
    opts = opts || {};
    current = { state: state, date: date, opts: opts };
    currentRoot = root;

    var win = g.MonthCore.windowFor(date);
    var key = win.from + "|" + win.to;

    // A sheet naming a date in a month that has been stepped away from is
    // stale — the same rule week-ui.js and day-ui.js apply to their own.
    if (overflowDate && (overflowDate < win.from || overflowDate > win.to)) overflowDate = null;

    var now = Date.now();
    if (shouldFetch(key, state.lastSuccessAt, now)) {
      // Fired before the paint below, not after: when the window is already
      // cached this reloads underneath the current render rather than
      // replacing it with a spinner.
      fetchWindow(key, win, state.lastSuccessAt, now);
    }

    root.innerHTML = "";

    if (cache.key !== key) {
      var pending = el('<div class="wall-placeholder"></div>');
      pending.textContent = cache.error
        ? "Could not load this month's events. Retrying…"
        : "Loading…";
      root.appendChild(pending);
      return;
    }

    var cells = g.MonthCore.buildCells(date, cache.rows);
    var shell = buildGrid(cells, state.today, opts);
    root.appendChild(shell);

    // After the append, not before: fitting reads real box heights.
    fitGrid(shell, cells);

    if (overflowDate) {
      var open = cells.filter(function (c) { return c.date === overflowDate; })[0];
      if (open) root.appendChild(buildOverflowSheet(open, opts));
      else overflowDate = null;
    }
  }

  // Leaving the view. Only the sheet and the render target go — both name
  // DOM that is about to be replaced. The cached window and the attempt
  // record are both KEPT: coming back paints instantly instead of flashing
  // "Loading…", and the poll stamp will have moved on during whatever time
  // was spent in another view, so the heartbeat rule above reloads it a
  // moment later without a second mechanism for re-entry.
  function stop() {
    overflowDate = null;
    currentRoot = null;
    current = { state: null, date: null, opts: {} };
  }

  g.MonthUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
