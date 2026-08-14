// ambient-ui.js — the day board content: tiles (n of m from chores-core.js),
// today's events plus a "Coming up" strip (events-core.js), the Done Today
// panel (completed-core.js), and a staleness stamp (TDS_Slice_Wall_Display_
// App.md §4.1, §0.4, §5.4, §6.7, §7). This is the "ambient board still
// rendering underneath" the new shell (TDS_Slice_Wall_Calendar_Redesign.md
// §16, Phase 2) — replaced outright in Phase 3.
//
// The topbar (brand/clock/gear) and night-dim overlay this file used to own
// moved to nav-ui.js in Phase 2: dimming is a shell-wide concern now that
// there is chrome outside the board to dim, and Settings is reached from the
// sidebar rather than a gear button. Tap-to-open PIN pad and the per-child
// chore list are Phase 4a of the superseded slice and were never built —
// a tile tap is still a no-op here.

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

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function addDays(iso, n) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function weekdayLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }

  // §10.2 — 15-second clock tick, no seconds shown.
  function formatClock(d) {
    var h = d.getHours();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 || 12;
    return h12 + ":" + pad2(d.getMinutes()) + " " + ampm;
  }

  // §6.7 — 12-hour, no seconds, local.
  function formatDoneTime(ms) {
    if (ms == null) return "earlier today";
    return formatClock(new Date(ms)).toLowerCase();
  }

  var clockTimer = null;
  var current = { state: null, opts: {} };

  function eventRowHtml(row, date) {
    var p = row.payload;
    try { p = typeof row.payload === "string" ? JSON.parse(row.payload) : (row.payload || {}); } catch (e) { p = {}; }
    var span = g.EventsCore.spanLabel(row, date);
    var bits = [];
    if (p.time) bits.push('<span class="event-time">' + escapeHtml(p.time) + '</span>');
    bits.push('<span class="event-title">' + escapeHtml(row.title) + '</span>');
    if (span) bits.push('<span class="event-span">' + escapeHtml(span) + '</span>');
    if (p.notes && p.notes.length <= 80) bits.push('<span class="event-notes">' + escapeHtml(p.notes) + '</span>');
    return '<div class="event-row">' + bits.join("") + '</div>';
  }

  function renderEvents(state) {
    var today = state.today;
    var todays = g.EventsCore.eventsOn(state.rows, today);
    var futureDates = [];
    for (var i = 1; i <= 6; i++) futureDates.push(addDays(today, i));
    var upcoming = g.EventsCore.upcoming(state.rows, futureDates);

    var todayHtml = todays.length
      ? todays.map(function (row) { return eventRowHtml(row, today); }).join("")
      : '<div class="events-empty">Nothing scheduled today.</div>';

    var upcomingHtml = upcoming.length
      ? upcoming.map(function (day) {
          return '<div class="upcoming-day">' +
            '<div class="upcoming-day-label">' + escapeHtml(weekdayLabel(day.date)) + '</div>' +
            day.events.map(function (row) { return eventRowHtml(row, day.date); }).join("") +
            '</div>';
        }).join("")
      : "";

    return el(
      '<div class="ambient-events">' +
        '<div class="events-today"><h2>Today</h2>' + todayHtml + '</div>' +
        (upcomingHtml ? '<div class="events-upcoming"><h3>Coming up</h3>' + upcomingHtml + '</div>' : '') +
      '</div>'
    );
  }

  function renderDoneToday(state) {
    var byId = {};
    (state.children || []).forEach(function (c) { byId[c.id] = c; });
    var done = g.CompletedCore.doneToday(state.rows, state.today, byId);
    var rows = done.length
      ? done.map(function (row) {
          return '<div class="done-row">' +
            '<span class="done-time">' + escapeHtml(formatDoneTime(row.completedAt)) + '</span>' +
            '<span class="done-title">' + escapeHtml(row.title) + '</span>' +
            '<span class="done-child">' + escapeHtml(row.childName) + '</span>' +
          '</div>';
        }).join("")
      : '<div class="done-empty">Nothing done yet today.</div>';

    return el('<div class="done-today"><h2>Done Today</h2><div class="done-rows">' + rows + '</div></div>');
  }

  function tileHtml(child, state) {
    var counts = g.ChoresCore.todayForChild(state.rows, child.id, state.today);
    return (
      '<button class="child-tile">' +
        '<div class="child-tile-name">' + escapeHtml(child.name) + '</div>' +
        '<div class="child-tile-count">' + counts.n + ' of ' + counts.m + '</div>' +
      '</button>'
    );
  }

  function staleStamp(state) {
    if (!state.lastSuccessAt) return '<div class="stale-stamp">Loading…</div>';
    var d = new Date(state.lastSuccessAt);
    var ageMin = (Date.now() - state.lastSuccessAt) / 60000;
    var cls = ageMin > 10 ? "stale-stamp amber" : "stale-stamp";
    return '<div class="' + cls + '">Last updated ' + formatClock(d) + '</div>';
  }

  function build(root, state, opts) {
    root.innerHTML = "";

    var shell = el('<div class="ambient"><div class="ambient-body"></div></div>');

    var body = shell.querySelector(".ambient-body");
    var tilesWrap = el('<div class="ambient-tiles"></div>');
    if (!state.children || state.children.length === 0) {
      tilesWrap.appendChild(el(
        '<div class="ambient-empty">No active children yet. Add one in the Management App — ' +
        'it appears here automatically.</div>'
      ));
    } else {
      state.children.forEach(function (child) {
        var tile = el(tileHtml(child, state));
        tile.addEventListener("click", function () {
          if (opts.onTileTap) opts.onTileTap(child);
        });
        tilesWrap.appendChild(tile);
      });
    }

    // §6.7's layout decision: Done Today as a panel beside the tiles, in a
    // two-column grid with events — the 960x600 baseline (§10.2) has no room
    // to stack tiles, today's events, the coming-up strip and Done Today in
    // one column without the page itself scrolling, which §10.2 reserves for
    // the per-child chore list alone. Each panel scrolls internally instead,
    // as a bounded fallback for a day with more on it than 600px holds.
    var panels = el('<div class="ambient-panels"></div>');
    panels.appendChild(renderEvents(state));
    panels.appendChild(renderDoneToday(state));

    body.appendChild(tilesWrap);
    body.appendChild(panels);
    body.appendChild(el(staleStamp(state)));

    root.appendChild(shell);
  }

  // Runs on the 15s tick, and once right after every build(): the staleness
  // stamp changes without needing a full poll/re-render. Clock and night-dim
  // are nav-ui.js's job now (Phase 2) — this file only owns the board.
  function updateLiveBits(root) {
    var shell = root.querySelector(".ambient");
    if (!shell) return;

    var state = current.state;
    if (state && state.lastSuccessAt) {
      var stamp = shell.querySelector(".stale-stamp");
      if (stamp) {
        var ageMin = (Date.now() - state.lastSuccessAt) / 60000;
        stamp.classList.toggle("amber", ageMin > 10);
        stamp.textContent = "Last updated " + formatClock(new Date(state.lastSuccessAt));
      }
    }
  }

  // `state` is Poll.getState()'s shape: { today, children, rows, lastSuccessAt, ... }.
  function render(root, state, opts) {
    opts = opts || {};
    current = { state: state, opts: opts };
    build(root, state, opts);
    updateLiveBits(root);
    if (!clockTimer) {
      clockTimer = setInterval(function () { updateLiveBits(root); }, 15000);
    }
  }

  function stop() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }

  g.AmbientUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
