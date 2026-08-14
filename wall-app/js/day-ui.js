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
//
// §16 Phase 4 adds block mode (§4.4): the same day, collapsed into the four
// canonical blocks, or expanded to just one of them at full 15-minute
// resolution. Still read-only — an unplaced chore appears inside its
// block_hint block instead of the tray (§3.4's last paragraph), but nothing
// is draggable until Phase 5. The full-day grid built in Phase 3 is now one
// of three "modes" this file renders; `buildGutter`/`buildGridBody`/
// `buildColumn` were generalized to a `[rangeStart, rangeEnd)` window so the
// single-block grid reuses the exact same positioning code the full grid
// uses, rather than a second copy that could drift from it.

(function (g) {
  "use strict";

  var GRID_START_MIN = 6 * 60; // 06:00 (§4.3)
  var GRID_END_MIN = 23 * 60; // 23:00
  var ROW_MIN = 15;

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
  // Shared by every mode, so it takes the raw roster rather than a
  // mode-specific layout shape.

  function buildStickyHeader(children) {
    var cols = (children || []).map(function (c) {
      return '<div class="day-col-header">' + escapeHtml(c.name) + "</div>";
    }).join("");
    return el(
      '<div class="day-sticky-header">' +
        '<div class="day-gutter-spacer"></div>' + cols +
      "</div>"
    );
  }

  // ---- mode bar (§4.4 — switching between the full grid and block mode) ---

  function buildModeBar(mode, setMode) {
    var isGrid = mode === "grid";
    var bar = el(
      '<div class="day-mode-bar">' +
        '<button class="day-mode-btn' + (isGrid ? " active" : "") + '" data-mode="grid">Full day</button>' +
        '<button class="day-mode-btn' + (!isGrid ? " active" : "") + '" data-mode="blocks">Blocks</button>' +
      "</div>"
    );
    bar.querySelector('[data-mode="grid"]').addEventListener("click", function () { setMode("grid"); });
    bar.querySelector('[data-mode="blocks"]').addEventListener("click", function () { setMode("blocks"); });
    return bar;
  }

  // ---- unscheduled tray (§3.4) ---------------------------------------------
  // Used by grid mode for every unplaced chore, and by single-block mode
  // for the unplaced chores whose hint puts them in *this* block — an
  // unplaced chore has no start_min, so it cannot sit on a time grid however
  // narrow. Block mode's collapsed view doesn't need this: there, an
  // unplaced chore renders inline in its block row instead (§3.4).

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

  // ---- early/late strips (§4.3 — never hidden, never clamped; grid mode only,
  // since block mode's night block already covers everything outside 06:00-23:00) --

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
  // Generalized over a [rangeStart, rangeEnd) minute window so the full-day
  // grid (Phase 3) and a single expanded block (Phase 4, §4.4) share one
  // implementation. A `placed` entry's `topMin` is the coordinate to draw
  // it at — equal to its real `chip.startMin` in grid mode, but remapped by
  // `ChoresCore.blockVirtualMin` in single-block mode so the night block's
  // midnight wrap draws on one continuous axis (§4.4).

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

  function buildGutter(rh, rangeStart, rangeEnd) {
    var gutter = el('<div class="day-gutter"></div>');
    var hStart = rangeStart / 60;
    var hEndExclusive = rangeEnd / 60;
    for (var h = hStart; h < hEndExclusive; h++) {
      var top = ((h * 60 - rangeStart) / ROW_MIN) * rh;
      var label = el('<div class="day-gutter-label"></div>');
      label.style.top = top + "px";
      label.textContent = g.TimeCore.formatMinutes((h * 60) % 1440, "24h");
      gutter.appendChild(label);
    }
    var bottom = el('<div class="day-gutter-label bottom"></div>');
    bottom.style.top = ((rangeEnd - rangeStart) / ROW_MIN) * rh + "px";
    bottom.textContent = g.TimeCore.formatMinutes(rangeEnd % 1440, "24h");
    gutter.appendChild(bottom);
    return gutter;
  }

  function buildColumn(entry, rh, rangeStart, opts) {
    var col = el('<div class="day-column"></div>');
    entry.placed.forEach(function (placed) {
      var top = ((placed.topMin - rangeStart) / ROW_MIN) * rh;
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

  function buildGridBody(perChild, rangeStart, rangeEnd, opts) {
    var rh = rowHeightPx();
    var body = el('<div class="day-grid-body"></div>');
    body.style.height = (((rangeEnd - rangeStart) / ROW_MIN) * rh) + "px";
    body.appendChild(buildGutter(rh, rangeStart, rangeEnd));
    perChild.forEach(function (entry) {
      body.appendChild(buildColumn(entry, rh, rangeStart, opts));
    });
    var nowLine = el('<div class="day-now-line"></div>');
    nowLine.style.display = "none";
    body.appendChild(nowLine);
    return body;
  }

  // `virtualMin` is already in the same coordinate space as rangeStart/End
  // (grid mode: a real clock minute; single-block mode: blockVirtualMin's
  // output). Grid mode pins to the nearest edge rather than vanishing
  // outside its range (§4.3); single-block mode's caller never calls this
  // unless "now" is actually inside the block, so no pinning is needed there.
  function positionNowLine(body, rh, rangeStart, rangeEnd, virtualMin) {
    var nowLine = body.querySelector(".day-now-line");
    if (!nowLine) return;
    var totalH = ((rangeEnd - rangeStart) / ROW_MIN) * rh;
    var top;
    if (virtualMin < rangeStart) top = 0;
    else if (virtualMin >= rangeEnd) top = totalH;
    else top = ((virtualMin - rangeStart) / ROW_MIN) * rh;
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

  // ---- grid mode (§4.3) ------------------------------------------------------

  function layoutPerChildGrid(state, date) {
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
        placed.push({ row: row, chip: chip, topMin: chip.startMin });
      });
      return { child: child, placed: placed, unplaced: unplaced, early: early, late: late };
    });
  }

  function buildGridContent(scroll, state, date, opts, fmt) {
    var perChild = layoutPerChildGrid(state, date);

    scroll.appendChild(buildTrayRow(perChild));

    var earlyStrip = buildStrip("early", perChild, fmt);
    if (earlyStrip) scroll.appendChild(earlyStrip);

    var body = buildGridBody(perChild, GRID_START_MIN, GRID_END_MIN, { fmt: fmt, onChipTap: opts.onChipTap });
    scroll.appendChild(body);

    var lateStrip = buildStrip("late", perChild, fmt);
    if (lateStrip) scroll.appendChild(lateStrip);

    return { body: body, rangeStart: GRID_START_MIN, rangeEnd: GRID_END_MIN, scrollToNowIfToday: true, block: null };
  }

  // ---- block mode, collapsed (§4.4) -------------------------------------------

  function layoutPerChildByBlock(state, date) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var buckets = { morning: [], afternoon: [], evening: [], night: [] };
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        buckets[g.ChoresCore.blockForChip(row, chip)].push({ row: row, chip: chip });
      });
      g.ChoresCore.CANON_BLOCKS.forEach(function (b) {
        // Placed items first, ordered by time; unplaced last (§6's convention
        // for week view, reused here for the same reason: a time beats no time).
        buckets[b].sort(function (a, bItem) {
          var at = a.chip.startMin, bt = bItem.chip.startMin;
          if (at == null && bt == null) return 0;
          if (at == null) return 1;
          if (bt == null) return -1;
          return at - bt;
        });
      });
      return { child: child, buckets: buckets };
    });
  }

  function blockItemHtml(item, fmt) {
    var time = item.chip.startMin != null
      ? '<span class="block-item-time">' + g.TimeCore.formatMinutes(item.chip.startMin, fmt) + "</span>"
      : "";
    return "<li>" + time + '<span class="block-item-title">' + escapeHtml(item.row.title) + "</span></li>";
  }

  function buildBlockRow(blockName, perChildBuckets, opts, expandBlock) {
    var label = blockName.charAt(0).toUpperCase() + blockName.slice(1);
    var row = el('<div class="day-block-row"></div>');
    var headerCell = el('<div class="day-block-label"><button class="day-block-toggle"></button></div>');
    row.appendChild(headerCell);

    var totalCount = 0;
    perChildBuckets.forEach(function (entry) {
      var items = entry.buckets[blockName];
      totalCount += items.length;
      var cell = el('<div class="day-block-cell"></div>');
      if (items.length) {
        var list = el('<ul class="day-block-list"></ul>');
        items.forEach(function (item) {
          var li = el(blockItemHtml(item, opts.fmt));
          li.addEventListener("click", function () {
            if (opts.onChipTap) opts.onChipTap(item.row, entry.child);
          });
          list.appendChild(li);
        });
        cell.appendChild(list);
      }
      row.appendChild(cell);
    });

    var toggle = headerCell.querySelector(".day-block-toggle");
    toggle.textContent = label + " · " + totalCount;
    toggle.addEventListener("click", function () { expandBlock(blockName); });
    return row;
  }

  function buildBlocksContent(scroll, state, date, opts, fmt, expandBlock) {
    var perChild = layoutPerChildByBlock(state, date);
    g.ChoresCore.CANON_BLOCKS.forEach(function (blockName) {
      scroll.appendChild(buildBlockRow(blockName, perChild, { fmt: fmt, onChipTap: opts.onChipTap }, expandBlock));
    });
    return { body: null, rangeStart: null, rangeEnd: null, scrollToNowIfToday: false, block: null };
  }

  // ---- block mode, expanded — one block's own 15-minute grid (§4.4) ----------

  function buildSingleBlockHeader(blockName, collapseBlock) {
    var label = blockName.charAt(0).toUpperCase() + blockName.slice(1);
    var header = el(
      '<div class="day-block-expanded-header">' +
        '<button class="day-block-back">&#8249; Blocks</button>' +
        '<span class="day-block-expanded-title"></span>' +
      "</div>"
    );
    header.querySelector(".day-block-expanded-title").textContent = label;
    header.querySelector(".day-block-back").addEventListener("click", collapseBlock);
    return header;
  }

  function layoutPerChildForBlock(state, date, blockName) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        if (g.ChoresCore.blockForChip(row, chip) !== blockName) return;
        if (chip.startMin == null) { unplaced.push(row); return; }
        placed.push({ row: row, chip: chip, topMin: g.ChoresCore.blockVirtualMin(chip.startMin, blockName) });
      });
      return { child: child, placed: placed, unplaced: unplaced };
    });
  }

  function buildSingleBlockContent(scroll, state, date, blockName, opts, fmt, collapseBlock) {
    var hours = g.ChoresCore.BLOCK_HOURS[blockName];
    var perChild = layoutPerChildForBlock(state, date, blockName);

    scroll.appendChild(buildSingleBlockHeader(blockName, collapseBlock));
    scroll.appendChild(buildTrayRow(perChild));

    var body = buildGridBody(perChild, hours.start, hours.end, { fmt: fmt, onChipTap: opts.onChipTap });
    scroll.appendChild(body);

    return { body: body, rangeStart: hours.start, rangeEnd: hours.end, scrollToNowIfToday: true, block: blockName };
  }

  // ---- assembly --------------------------------------------------------------

  var current = { state: null, date: null, opts: {} };
  var currentRoot = null;
  var dayMode = "grid"; // "grid" | "blocks" | one of ChoresCore.CANON_BLOCKS
  var nowLineTimer = null;
  var staleTimer = null;
  var lastRenderedDate = null;
  var lastRenderedMode = null;

  function setMode(mode) {
    dayMode = mode;
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
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
    currentRoot = root;

    var settings = g.Store.getSettings();
    var fmt = settings.timeFormat || "24h";
    var today = state.today;

    var oldScroll = root.querySelector(".day-scroll");
    var prevScrollTop = oldScroll ? oldScroll.scrollTop : null;
    var isNewDate = date !== lastRenderedDate;
    var isNewMode = dayMode !== lastRenderedMode;
    lastRenderedDate = date;
    lastRenderedMode = dayMode;

    root.innerHTML = "";

    if (!state.children || state.children.length === 0) {
      root.appendChild(el(
        '<div class="day-empty">No active children yet. Add one in the Management App — ' +
        "it appears here automatically.</div>"
      ));
      return;
    }

    var modeClass = dayMode === "grid" ? "day-mode-grid" : dayMode === "blocks" ? "day-mode-blocks" : "day-mode-block-expanded";
    var shell = el('<div class="day-view ' + modeClass + '"><div class="day-scroll"></div></div>');
    var scroll = shell.querySelector(".day-scroll");

    scroll.appendChild(buildStickyHeader(state.children));
    scroll.appendChild(buildModeBar(dayMode, setMode));
    scroll.appendChild(buildEventsBand(state.rows, date));

    var result;
    if (dayMode === "grid") {
      result = buildGridContent(scroll, state, date, opts, fmt);
    } else if (dayMode === "blocks") {
      result = buildBlocksContent(scroll, state, date, opts, fmt, setMode);
    } else {
      result = buildSingleBlockContent(scroll, state, date, dayMode, opts, fmt, function () { setMode("blocks"); });
    }

    scroll.appendChild(buildStaleStamp(state, fmt));
    root.appendChild(shell);

    var rh = rowHeightPx();
    if (result.body) {
      var nowVirtual = null;
      if (date === today) {
        var now = new Date();
        var nowMin = now.getHours() * 60 + now.getMinutes();
        if (dayMode === "grid") {
          nowVirtual = nowMin; // grid always shows a (possibly edge-clamped) now-line, §4.3
        } else if (g.ChoresCore.blockFromStartMin(nowMin) === result.block) {
          nowVirtual = g.ChoresCore.blockVirtualMin(nowMin, result.block);
        }
      }
      if (nowVirtual != null) {
        positionNowLine(result.body, rh, result.rangeStart, result.rangeEnd, nowVirtual);
        (function (rangeStart, rangeEnd, block) {
          nowLineTimer = setInterval(function () {
            var n = new Date();
            var m = n.getHours() * 60 + n.getMinutes();
            var v = block ? g.ChoresCore.blockVirtualMin(m, block) : m;
            positionNowLine(result.body, rh, rangeStart, rangeEnd, v);
          }, 30000);
        })(result.rangeStart, result.rangeEnd, result.block);
      }
    }

    var resetScroll = isNewDate || isNewMode;
    if (!resetScroll && prevScrollTop != null) {
      scroll.scrollTop = prevScrollTop;
    } else if (result.scrollToNowIfToday && date === today && result.body) {
      requestAnimationFrame(function () {
        var nowLine = result.body.querySelector(".day-now-line");
        var target = (nowLine && nowLine.style.display !== "none") ? nowLine.offsetTop : 0;
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
    lastRenderedMode = null;
  }

  g.DayUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
