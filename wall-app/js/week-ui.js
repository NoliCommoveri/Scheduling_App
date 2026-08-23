// week-ui.js — the week view: seven day-ROWS, Sunday-first, each showing
// that day's events, then a Chores token and a School token when the
// respective assignment kind exists that day for any active child.
// TDS_Slice_Wall_Calendar_Redesign.md §6 described a seven-COLUMN week with
// colour-per-child attribution; this supersedes that design in-session,
// 2026-08-15 — rows read better than columns at this width, and a token per
// kind keeps a busy day's row from turning into a wall of identical chips
// the way §7.1 already reasoned chores would on the month grid.
//
// Both tokens open the SAME read-only sheet shape: a kid picker first —
// nothing else renders until a child is picked, since a token is a
// household summary and the wall has no column position here to answer
// "who" the way §8.2's day view does — then that child's list for the day.
// No completion, no drag, no write of any kind; Close is the only exit
// besides picking a different child.
//
// The Chores sheet segments the picked child's chores into the four
// canonical blocks (chores-core.js's CANON_BLOCKS), one continuous scroll,
// silently ordered by placed time (SlotsCore.resolveChip's startMin) — the
// time itself is never shown, only used to sort. Each title carries a star
// rating from its difficulty tier (ChoresCore.difficultyStars).
//
// The School sheet lists that child's courses with activities that day
// (SchoolCore.coursesWithTypeCounts) and each course's activity-type
// counts. Order doesn't matter there, per the brief — courses stay
// alphabetical (coursesWithActivities' own order) for a stable render, but
// nothing sorts the type counts within a course.

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

  // ---- the week's seven dates, Sunday-first --------------------------------

  // Placement Scopes §2.3 — the local `dayOfWeek` these three lines used to
  // hold now lives in TimeCore.weekdayOf, the one implementation (nav-ui.js
  // had the same copy). Same answer, same Sunday-first numbering; tested now.
  //
  // Reuses Poll.addDays rather than re-deriving date math, same reason
  // nav-ui.js does.
  function weekDates(iso) {
    var sunday = g.Poll.addDays(iso, -g.TimeCore.weekdayOf(iso));
    var out = [];
    for (var i = 0; i < 7; i++) out.push(g.Poll.addDays(sunday, i));
    return out;
  }

  function dayHeaderLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  // ---- events (reuses EventsCore.eventsOn's own dedupe/sort verbatim) -----

  function eventRowHtml(row, date) {
    var p = parsePayload(row.payload);
    var span = g.EventsCore.spanLabel(row, date);
    var bits = [];
    if (p.time) bits.push('<span class="event-time">' + escapeHtml(p.time) + "</span>");
    bits.push('<span class="event-title">' + escapeHtml(row.title) + "</span>");
    if (span) bits.push('<span class="event-span">' + escapeHtml(span) + "</span>");
    return '<div class="event-row">' + bits.join("") + "</div>";
  }

  // ---- tokens: shown when the kind exists for ANY active child that day ---

  function anyChoresOn(state, date) {
    return (state.children || []).some(function (c) {
      return g.ChoresCore.choresForChild(state.rows, c.id, date, state.today).length > 0;
    });
  }

  function anySchoolOn(state, date) {
    return (state.children || []).some(function (c) {
      return g.SchoolCore.coursesWithActivities(state.rows, c.id, date).length > 0;
    });
  }

  // ---- detail sheet: kid picker, then a read-only list ---------------------

  var detail = null; // { kind: 'chores'|'school', date, child: null|{id,name} }

  function openDetail(kind, date) {
    detail = { kind: kind, date: date, child: null };
    rerenderNow();
  }

  function closeDetail() {
    detail = null;
    rerenderNow();
  }

  function pickChild(child) {
    detail.child = child;
    rerenderNow();
  }

  function backToPicker() {
    detail.child = null;
    rerenderNow();
  }

  function buildKidPicker(state) {
    var list = el('<ul class="week-kid-picker-list"></ul>');
    (state.children || []).forEach(function (child) {
      var li = el('<li></li>');
      var btn = el('<button class="btn ghost week-kid-btn" type="button"></button>');
      btn.textContent = child.name;
      btn.addEventListener("click", function () { pickChild(child); });
      li.appendChild(btn);
      list.appendChild(li);
    });
    return list;
  }

  // Placed items first, ordered by time; unplaced last — day-ui.js's own
  // block-mode convention (layoutPerChildByBlock), reused here for the same
  // reason: a time beats no time. The time itself is only ever a sort key
  // in this sheet, never rendered (per the brief).
  function sortByPlacedTime(a, b) {
    var at = a.chip.startMin, bt = b.chip.startMin;
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    return at - bt;
  }

  function buildChoresBody(state, date, child) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    var wdIdx = g.SlotsCore.indexWeekdays(state.slotWeekdays);
    var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
    var buckets = { morning: [], afternoon: [], evening: [], night: [] };
    chores.forEach(function (row) {
      var chip = g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date);
      buckets[g.ChoresCore.blockForChip(row, chip)].push({ row: row, chip: chip });
    });

    var wrap = el('<div class="week-detail-scroll"></div>');
    var any = false;
    g.ChoresCore.CANON_BLOCKS.forEach(function (blockName) {
      var items = buckets[blockName];
      if (!items.length) return;
      any = true;
      items.sort(sortByPlacedTime);
      var label = blockName.charAt(0).toUpperCase() + blockName.slice(1);
      var section = el(
        '<div class="week-detail-block">' +
          '<h3 class="week-detail-block-header">' + escapeHtml(label) + "</h3>" +
          '<ul class="week-detail-chore-list"></ul>' +
        "</div>"
      );
      var list = section.querySelector(".week-detail-chore-list");
      items.forEach(function (item) {
        var stars = g.ChoresCore.difficultyStars(item.row);
        var starHtml = stars > 0
          ? '<span class="week-detail-stars">' + "&#9733;".repeat(stars) + "</span>"
          : "";
        list.appendChild(el(
          '<li class="week-detail-chore-item">' +
            '<span class="week-detail-chore-title">' + escapeHtml(item.row.title) + "</span>" +
            starHtml +
          "</li>"
        ));
      });
      wrap.appendChild(section);
    });
    if (!any) wrap.appendChild(el('<div class="week-detail-empty">No chores that day.</div>'));
    return wrap;
  }

  function buildSchoolBody(state, date, child) {
    var courses = g.SchoolCore.coursesWithTypeCounts(state.rows, child.id, date);
    var wrap = el('<div class="week-detail-scroll"></div>');
    if (!courses.length) {
      wrap.appendChild(el('<div class="week-detail-empty">No courses that day.</div>'));
      return wrap;
    }
    var list = el('<ul class="week-detail-course-list"></ul>');
    courses.forEach(function (c) {
      var counts = c.typeCounts.map(function (tc) { return tc.count + " " + tc.type; }).join(", ");
      list.appendChild(el(
        '<li class="week-detail-course-item">' +
          '<span class="week-detail-course-name">' + escapeHtml(c.courseName) + "</span>" +
          '<span class="week-detail-type-counts">' + escapeHtml(counts) + "</span>" +
        "</li>"
      ));
    });
    wrap.appendChild(list);
    return wrap;
  }

  function buildDetailSheet(state) {
    var d = detail;
    var overlay = el(
      '<div class="duration-sheet-overlay week-detail-overlay">' +
        '<div class="duration-sheet-card week-detail-card">' +
          "<h2></h2>" +
          '<div class="week-detail-body"></div>' +
          '<div class="duration-sheet-actions">' +
            (d.child ? '<button class="btn ghost" id="weekBack">&#8249; Change child</button>' : "") +
            '<button class="btn" id="weekDone">Done</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    var title = (d.kind === "chores" ? "Chores" : "School") + " — " + dayHeaderLabel(d.date) +
      (d.child ? " — " + d.child.name : "");
    overlay.querySelector("h2").textContent = title;

    var body = overlay.querySelector(".week-detail-body");
    if (!d.child) {
      body.appendChild(buildKidPicker(state));
    } else if (d.kind === "chores") {
      body.appendChild(buildChoresBody(state, d.date, d.child));
    } else {
      body.appendChild(buildSchoolBody(state, d.date, d.child));
    }

    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) closeDetail(); // backdrop tap cancels, same as every other sheet
    });
    overlay.querySelector("#weekDone").addEventListener("click", closeDetail);
    var back = overlay.querySelector("#weekBack");
    if (back) back.addEventListener("click", backToPicker);

    return overlay;
  }

  // ---- assembly --------------------------------------------------------------

  var current = { state: null, date: null, opts: {} };
  var currentRoot = null;
  var lastRenderedDate = null;

  function rerenderNow() {
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
  }

  function buildDayRow(state, date, today) {
    var row = el('<div class="week-day-row"></div>');
    if (date === today) row.classList.add("today");
    row.appendChild(el('<div class="week-day-header">' + escapeHtml(dayHeaderLabel(date)) + "</div>"));

    var events = g.EventsCore.eventsOn(state.rows, date);
    if (events.length) {
      var band = el('<div class="week-day-events"></div>');
      events.forEach(function (ev) { band.appendChild(el(eventRowHtml(ev, date))); });
      row.appendChild(band);
    }

    var tokens = el('<div class="week-day-tokens"></div>');
    if (anyChoresOn(state, date)) {
      var choresBtn = el('<button class="week-token week-token-chores" type="button">Chores</button>');
      choresBtn.addEventListener("click", function () { openDetail("chores", date); });
      tokens.appendChild(choresBtn);
    }
    if (anySchoolOn(state, date)) {
      var schoolBtn = el('<button class="week-token week-token-school" type="button">School</button>');
      schoolBtn.addEventListener("click", function () { openDetail("school", date); });
      tokens.appendChild(schoolBtn);
    }
    if (tokens.children.length) row.appendChild(tokens);

    return row;
  }

  // `state` is Poll.getState()'s shape. `date` is the rendered anchor day
  // (nav-ui.js's state.date) — the week shown is the Sunday-first week
  // containing it, not just that one day.
  function render(root, state, date, opts) {
    opts = opts || {};
    current = { state: state, date: date, opts: opts };
    currentRoot = root;

    // A sheet named a date from a week that's been navigated away from —
    // stale, same reason day-ui.js drops selectedForPlacement/sheetState on
    // a date change.
    if (date !== lastRenderedDate) detail = null;
    lastRenderedDate = date;

    root.innerHTML = "";

    if (!state.children || state.children.length === 0) {
      root.appendChild(el(
        '<div class="day-empty">No active children yet. Add one in the Management App — ' +
        "it appears here automatically.</div>"
      ));
      return;
    }

    var shell = el('<div class="week-view"><div class="week-scroll"></div></div>');
    var scroll = shell.querySelector(".week-scroll");
    weekDates(date).forEach(function (d) {
      scroll.appendChild(buildDayRow(state, d, state.today));
    });
    root.appendChild(shell);

    if (detail) root.appendChild(buildDetailSheet(state));
  }

  function stop() {
    detail = null;
    lastRenderedDate = null;
  }

  g.WeekUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
