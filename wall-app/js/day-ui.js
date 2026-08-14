// day-ui.js — the day view: column-per-child grid, sticky header, the
// events band, the unscheduled tray, early/late strips, and the now-line.
// TDS_Slice_Wall_Calendar_Redesign.md §4 (the day view), §11.3 (time
// format). Phase 3 scope: READ-ONLY. Chips are not draggable (§16 Phase 5),
// the tray's items are not tappable-to-place, and tapping a chip is a
// no-op stub — the same posture ambient-ui.js took with tile taps before
// Phase 4a. Replaces `ambient-ui.js` outright (§13).
//
// Layout is plain flexbox, not CSS Grid: §4.3's "vertical scrolling only,
// no horizontal scroll anywhere" means the column count never overflows the
// viewport, so a sticky header over N equal-width flex columns gives the
// same result as a grid with far less code, and chip positioning is then
// just `top`/`height` in px within each column — one scroll container, one
// coordinate system.

(function (g) {
  "use strict";

  var GRID_START_MIN = 6 * 60; // 06:00 (§4.3)
  var GRID_END_MIN = 23 * 60; // 23:00
  var ROW_MIN = 15;
  var ROW_COUNT = (GRID_END_MIN - GRID_START_MIN) / ROW_MIN; // 68

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function rowHeightPx() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
    return parseFloat(v) || 18;
  }

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // ---- events band (§4.2 — family-wide, full width, above the grid) -------

  function eventRowHtml(row, date) {
    var p = parsePayload(row.payload);
    var span = g.EventsCore.spanLabel(row, date);
    var bits = [];
    if (p.time) bits.push('<span class="event-time">' + escapeHtml(p.time) + "</span>");
    bits.push('<span class="event-title">' + escapeHtml(row.title) + "</span>");
    if (span) bits.push('<span class="event-span">' + escapeHtml(span) + "</span>");
    return '<div class="event-row">' + bits.join("") + "</div>";
  }

  function buildEventsBand(rows, date) {
    var todays = g.EventsCore.eventsOn(rows, date);
    if (!todays.length) return el('<div class="day-events-band day-events-empty"></div>');
    return el(
      '<div class="day-events-band">' +
        todays.map(function (row) { return eventRowHtml(row, date); }).join("") +
      "</div>"
    );
  }

  // ---- sticky header (§4.2 — frozen at the top of the scroll) -------------

  function buildStickyHeader(perChild) {
    var cols = perChild.map(function (c) {
      return '<div class="day-col-header">' + escapeHtml(c.child.name) + "</div>";
    }).join("");
    return el(
      '<div class="day-sticky-header">' +
        '<div class="day-gutter-spacer"></div>' + cols +
      "</div>"
    );
  }

  // ---- unscheduled tray (§3.4) ---------------------------------------------

  function trayCellHtml(entry) {
    var n = entry.unplaced.length;
    if (!n) return '<div class="day-tray-cell"></div>';
    var items = entry.unplaced.map(function (row) {
      return '<li>' + escapeHtml(row.title) + "</li>";
    }).join("");
    return (
      '<div class="day-tray-cell">' +
        '<button class="day-tray-toggle">Not scheduled &middot; ' + n + "</button>" +
        '<ul class="day-tray-list">' + items + "</ul>" +
      "</div>"
    );
  }

  function buildTrayRow(perChild) {
    var any = perChild.some(function (c) { return c.unplaced.length > 0; });
    var wrap = el('<div class="day-tray-row"><div class="day-gutter-spacer"></div></div>');
    if (!any) return wrap;
    perChild.forEach(function (entry) {
      var cell = el(trayCellHtml(entry));
      var toggle = cell.querySelector(".day-tray-toggle");
      if (toggle) {
        toggle.addEventListener("click", function () {
          cell.classList.toggle("expanded");
        });
      }
      wrap.appendChild(cell);
    });
    return wrap;
  }

  // ---- early/late strips (§4.3 — never hidden, never clamped) -------------

  function buildStrip(kind, perChild, fmt) {
    var items = [];
    perChild.forEach(function (entry) {
      (entry[kind] || []).forEach(function (placed) {
        items.push({ row: placed.row, chip: placed.chip, childName: entry.child.name });
      });
    });
    if (!items.length) return null;
    items.sort(function (a, b) { return a.chip.startMin - b.chip.startMin; });
    var label = kind === "early" ? "Before " + g.TimeCore.formatMinutes(GRID_START_MIN, fmt)
      : "After " + g.TimeCore.formatMinutes(GRID_END_MIN, fmt);
    var wrap = el(
      '<div class="day-strip ' + kind + '">' +
        '<button class="day-strip-toggle">' + escapeHtml(label) + " &middot; " + items.length + "</button>" +
        '<ul class="day-strip-list"></ul>' +
      "</div>"
    );
    var list = wrap.querySelector(".day-strip-list");
    items.forEach(function (item) {
      list.appendChild(el(
        "<li>" +
          '<span class="strip-time">' + g.TimeCore.formatMinutes(item.chip.startMin, fmt) + "</span>" +
          '<span class="strip-title">' + escapeHtml(item.row.title) + "</span>" +
          '<span class="strip-child">' + escapeHtml(item.childName) + "</span>" +
        "</li>"
      ));
    });
    wrap.querySelector(".day-strip-toggle").addEventListener("click", function () {
      wrap.classList.toggle("expanded");
    });
    return wrap;
  }

  // ---- the grid body: gutter, columns, chips, now-line ---------------------

  // Time and title share one line (not stacked) because a 15-minute chore
  // with no authored estimate is the common case today (§4.3) and renders
  // as exactly one grid row — too short for two stacked lines to fit.
  function chipHtml(placed, fmt) {
    return (
      '<div class="day-chip">' +
        '<span class="chip-time">' + g.TimeCore.formatMinutes(placed.chip.startMin, fmt) + "</span>" +
        '<span class="chip-title">' + escapeHtml(placed.row.title) + "</span>" +
      "</div>"
    );
  }

  function buildGutter(rh) {
    var gutter = el('<div class="day-gutter"></div>');
    for (var h = 6; h <= 22; h++) {
      var top = ((h * 60 - GRID_START_MIN) / ROW_MIN) * rh;
      var label = el('<div class="day-gutter-label"></div>');
      label.style.top = top + "px";
      label.textContent = g.TimeCore.formatMinutes(h * 60, "24h");
      gutter.appendChild(label);
    }
    var bottom = el('<div class="day-gutter-label bottom"></div>');
    bottom.style.top = ROW_COUNT * rh + "px";
    bottom.textContent = g.TimeCore.formatMinutes(GRID_END_MIN, "24h");
    gutter.appendChild(bottom);
    return gutter;
  }

  function buildColumn(entry, rh, opts) {
    var col = el('<div class="day-column"></div>');
    entry.placed.forEach(function (placed) {
      var top = ((placed.chip.startMin - GRID_START_MIN) / ROW_MIN) * rh;
      var rows = Math.max(1, Math.ceil(placed.chip.durationMin / ROW_MIN));
      var chip = el(chipHtml(placed, opts.fmt));
      chip.style.top = top + "px";
      chip.style.height = (rows * rh - 2) + "px"; // 2px gap between chips
      chip.addEventListener("click", function () {
        if (opts.onChipTap) opts.onChipTap(placed.row, entry.child);
      });
      col.appendChild(chip);
    });
    return col;
  }

  function buildGridBody(perChild, opts) {
    var rh = rowHeightPx();
    var body = el('<div class="day-grid-body"></div>');
    body.style.height = (ROW_COUNT * rh) + "px";
    body.appendChild(buildGutter(rh));
    perChild.forEach(function (entry) {
      body.appendChild(buildColumn(entry, rh, opts));
    });
    var nowLine = el('<div class="day-now-line"></div>');
    nowLine.style.display = "none";
    body.appendChild(nowLine);
    return body;
  }

  function positionNowLine(body, rh) {
    var nowLine = body.querySelector(".day-now-line");
    if (!nowLine) return;
    var now = new Date();
    var min = now.getHours() * 60 + now.getMinutes();
    var totalH = ROW_COUNT * rh;
    var top;
    if (min < GRID_START_MIN) top = 0;
    else if (min >= GRID_END_MIN) top = totalH;
    else top = ((min - GRID_START_MIN) / ROW_MIN) * rh;
    nowLine.style.display = "";
    nowLine.style.top = top + "px";
  }

  // ---- staleness stamp (§10.4, unchanged) ----------------------------------

  function buildStaleStamp(state, fmt) {
    if (!state.lastSuccessAt) return el('<div class="day-stale-stamp">Loading&hellip;</div>');
    var ageMin = (Date.now() - state.lastSuccessAt) / 60000;
    var cls = ageMin > 10 ? "day-stale-stamp amber" : "day-stale-stamp";
    var text = "Last updated " + g.TimeCore.formatDate(new Date(state.lastSuccessAt), fmt);
    var stamp = el('<div class="' + cls + '"></div>');
    stamp.textContent = text;
    return stamp;
  }

  // ---- assembly --------------------------------------------------------------

  var current = { state: null, date: null, opts: {} };
  var nowLineTimer = null;
  var staleTimer = null;
  var lastRenderedDate = null;

  function layoutPerChild(state, date) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [], early = [], late = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        if (chip.startMin == null) { unplaced.push(row); return; }
        if (chip.startMin < GRID_START_MIN) { early.push({ row: row, chip: chip }); return; }
        if (chip.startMin >= GRID_END_MIN) { late.push({ row: row, chip: chip }); return; }
        placed.push({ row: row, chip: chip });
      });
      return { child: child, placed: placed, unplaced: unplaced, early: early, late: late };
    });
  }

  function stopTimers() {
    if (nowLineTimer) { clearInterval(nowLineTimer); nowLineTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
  }

  // `state` is Poll.getState()'s shape, now carrying `.slots`/`.slotDays`
  // too (poll.js). `date` is the rendered day (nav-ui.js's state.date).
  function render(root, state, date, opts) {
    opts = opts || {};
    stopTimers();
    current = { state: state, date: date, opts: opts };

    var settings = g.Store.getSettings();
    var fmt = settings.timeFormat || "24h";
    var today = state.today;

    var oldScroll = root.querySelector(".day-scroll");
    var prevScrollTop = oldScroll ? oldScroll.scrollTop : null;
    var isNewDate = date !== lastRenderedDate;
    lastRenderedDate = date;

    root.innerHTML = "";

    if (!state.children || state.children.length === 0) {
      root.appendChild(el(
        '<div class="day-empty">No active children yet. Add one in the Management App — ' +
        "it appears here automatically.</div>"
      ));
      return;
    }

    var perChild = layoutPerChild(state, date);

    var shell = el('<div class="day-view"><div class="day-scroll"></div></div>');
    var scroll = shell.querySelector(".day-scroll");

    scroll.appendChild(buildStickyHeader(perChild));
    scroll.appendChild(buildEventsBand(state.rows, date));
    scroll.appendChild(buildTrayRow(perChild));

    var earlyStrip = buildStrip("early", perChild, fmt);
    if (earlyStrip) scroll.appendChild(earlyStrip);

    var gridOpts = { fmt: fmt, onChipTap: opts.onChipTap };
    var body = buildGridBody(perChild, gridOpts);
    scroll.appendChild(body);

    var lateStrip = buildStrip("late", perChild, fmt);
    if (lateStrip) scroll.appendChild(lateStrip);

    scroll.appendChild(buildStaleStamp(state, fmt));

    root.appendChild(shell);

    var rh = rowHeightPx();
    if (date === today) {
      positionNowLine(body, rh);
      nowLineTimer = setInterval(function () { positionNowLine(body, rh); }, 30000);
    }

    if (!isNewDate && prevScrollTop != null) {
      scroll.scrollTop = prevScrollTop;
    } else if (date === today) {
      // §4.3 — scroll to the now-line on load, once per fresh view of today.
      requestAnimationFrame(function () {
        var nowLine = body.querySelector(".day-now-line");
        var target = nowLine ? nowLine.offsetTop : 0;
        scroll.scrollTop = Math.max(0, target - scroll.clientHeight / 3);
      });
    }

    staleTimer = setInterval(function () {
      var stamp = scroll.querySelector(".day-stale-stamp");
      if (!stamp || !current.state || !current.state.lastSuccessAt) return;
      var ageMin = (Date.now() - current.state.lastSuccessAt) / 60000;
      stamp.classList.toggle("amber", ageMin > 10);
      stamp.textContent = "Last updated " + g.TimeCore.formatDate(new Date(current.state.lastSuccessAt), fmt);
    }, 15000);
  }

  function stop() {
    stopTimers();
    lastRenderedDate = null;
  }

  g.DayUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
