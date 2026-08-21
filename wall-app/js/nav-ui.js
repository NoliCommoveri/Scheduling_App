// nav-ui.js — the persistent shell: hamburger, sidebar (Day/Week/Month, date
// stepper, Today, Settings), a large centre refresh, and the night-dim
// overlay. TDS_Slice_Wall_Calendar_Redesign.md §11.6 (nav shell), §4.1 (land
// on today), §10.1 (interaction-triggered polls). Night dimming moves here
// from ambient-ui.js (wall slice §10.2, unchanged in substance) because it is
// a shell-wide concern once there is chrome outside the board to dim too.
//
// Phase 2 scope: the shell and its navigation state (view + rendered date).
// It does not render Day/Week/Month content itself — it hands the caller a
// `contentEl` to render into and reports state changes via `onStateChange`.
// Phase 3 (day), then Phase 8 (week, then month) filled in the content
// behind each of the three; this file still only owns navigation. Phase 8's
// month grid adds `goTo(view, date)` to the returned controller — a day-cell
// tap changes view and date in one move (§7.1), which neither `setView` nor
// `setDate` can express on its own.
//
// §16 Phase 6b adds the §11.5.1 "tap to enable sound" indicator to the
// topbar. This file already owns the one shell-wide "a tap happened
// anywhere" listener (previously only for night-dim suppression), so
// `Sound.unlock()` rides the same listener rather than a second one.

(function (g) {
  "use strict";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // Mirrors poll.js's own todayLocal/addDays rather than re-deriving them,
  // so the nav's idea of "today" can never drift from the poll's.
  function todayLocal() { return g.Poll.todayLocal(); }
  function addDays(iso, n) { return g.Poll.addDays(iso, n); }

  // Calendar-month step, not a fixed 30 days — landing on the 31st and
  // stepping forward a month clamps to the target month's last day rather
  // than overflowing into the month after.
  function addMonths(iso, n) {
    var parts = iso.split("-").map(Number);
    var target = new Date(parts[0], parts[1] - 1 + n, 1);
    var daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(parts[2], daysInTarget));
    return target.getFullYear() + "-" + pad2(target.getMonth() + 1) + "-" + pad2(target.getDate());
  }

  // Mirrors week-ui.js's own dayOfWeek/weekDates (Sunday-first) rather than
  // re-deriving them, so the nav's idea of "this week" can never drift from
  // the week view's.
  function dayOfWeek(iso) {
    var parts = iso.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).getDay();
  }
  function weekStart(iso) { return addDays(iso, -dayOfWeek(iso)); }

  // §11.3 — the topbar clock is one more thing the time-format setting
  // governs, through the same helper the grid and its chips use.
  function formatClock(d) {
    var settings = g.Store.getSettings();
    return g.TimeCore.formatDate(d, settings.timeFormat || "24h");
  }

  function dateLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  function monthLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // Sunday-through-Saturday span containing `iso`, per the user's ask that
  // week view name the range rather than repeat the anchor date.
  function weekRangeLabel(iso) {
    var start = weekStart(iso);
    var end = addDays(start, 6);
    var sParts = start.split("-").map(Number);
    var eParts = end.split("-").map(Number);
    var sDate = new Date(sParts[0], sParts[1] - 1, sParts[2]);
    var eDate = new Date(eParts[0], eParts[1] - 1, eParts[2]);
    if (sParts[0] !== eParts[0]) {
      return sDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
        " – " + eDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    if (sParts[1] !== eParts[1]) {
      return sDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " – " + eDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    return sDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      "–" + eDate.getDate();
  }

  // The header string for the active view: day keeps the single-date label,
  // week names its Sunday-Saturday span, month names the month — none of
  // them just repeat "today" once the view has been stepped away from it.
  function headerLabel(view, iso) {
    if (view === "week") return weekRangeLabel(iso);
    if (view === "month") return monthLabel(iso);
    return dateLabel(iso);
  }

  // How far one tap of the stepper moves, per view: a day, a Sunday-first
  // week, or a calendar month.
  function stepDate(view, iso, dir) {
    if (view === "week") return addDays(iso, dir * 7);
    if (view === "month") return addMonths(iso, dir);
    return addDays(iso, dir);
  }

  function stepAriaLabel(view, dir) {
    var unit = view === "week" ? "week" : view === "month" ? "month" : "day";
    return (dir < 0 ? "Previous " : "Next ") + unit;
  }

  // Mirrors ambient-ui.js's own isNight, which this file now supersedes —
  // named so the next reader finds the one copy that matters.
  function isNight(d, dimStartHour, dimEndHour) {
    var h = d.getHours();
    if (dimStartHour === dimEndHour) return false;
    if (dimStartHour < dimEndHour) return h >= dimStartHour && h < dimEndHour;
    return h >= dimStartHour || h < dimEndHour; // wraps midnight, e.g. 21 -> 6
  }

  var VIEWS = ["day", "week", "month"];
  var IDLE_DISMISS_MS = 20000; // §11.6 — a sidebar left open is a broken wall

  // `opts`: { onStateChange({view,date}), onRefresh(), onSettings() }.
  // onRefresh fires on every discrete nav interaction (§10.1) — hamburger
  // open, a view change, a date change, Today, or the refresh button itself.
  function mount(root, opts) {
    opts = opts || {};
    var dimSuppressed = false; // reset only by a reload, not by any render
    var clockTimer = null;
    var idleTimer = null;

    var state = { view: "day", date: todayLocal(), sidebarOpen: false };

    root.innerHTML = "";
    var shell = el(
      '<div class="wall-shell">' +
        '<div class="wall-topbar">' +
          '<button class="hamburger-btn icon-btn" aria-label="Menu">&#9776;</button>' +
          '<div class="wall-topbar-nav">' +
            '<button class="topbar-nav-btn icon-btn" id="topbarDatePrev">&#8249;</button>' +
            '<div class="wall-topbar-label"></div>' +
            '<button class="topbar-nav-btn icon-btn" id="topbarDateNext">&#8250;</button>' +
          '</div>' +
          '<div class="sound-indicator" title="Tap anywhere to enable sound">&#128263;</div>' +
          '<div class="wall-clock"></div>' +
          '<button class="refresh-btn icon-btn" aria-label="Refresh now">&#8635;</button>' +
        '</div>' +
        '<div class="wall-content"></div>' +
        '<div class="wall-sidebar-scrim"></div>' +
        '<div class="wall-sidebar">' +
          '<div class="sidebar-section">' +
            '<button class="sidebar-view-btn" data-view="day">Day</button>' +
            '<button class="sidebar-view-btn" data-view="week">Week</button>' +
            '<button class="sidebar-view-btn" data-view="month">Month</button>' +
          '</div>' +
          '<div class="sidebar-section sidebar-datestep">' +
            '<button class="datestep-btn" id="navDatePrev" aria-label="Previous day">&#8249;</button>' +
            '<div class="datestep-label" id="navDateLabel"></div>' +
            '<button class="datestep-btn" id="navDateNext" aria-label="Next day">&#8250;</button>' +
          '</div>' +
          '<div class="sidebar-section">' +
            '<button class="btn ghost" id="navTodayBtn">Today</button>' +
          '</div>' +
          '<div class="sidebar-section">' +
            '<button class="btn" id="navSettingsBtn">Settings</button>' +
          '</div>' +
        '</div>' +
        '<div class="night-overlay"></div>' +
      '</div>'
    );
    root.appendChild(shell);

    var contentEl = shell.querySelector(".wall-content");
    var sidebar = shell.querySelector(".wall-sidebar");
    var scrim = shell.querySelector(".wall-sidebar-scrim");
    var topbarLabel = shell.querySelector(".wall-topbar-label");
    var soundIndicator = shell.querySelector(".sound-indicator");
    var clockEl = shell.querySelector(".wall-clock");
    var dateLabelEl = shell.querySelector("#navDateLabel");
    var viewBtns = shell.querySelectorAll(".sidebar-view-btn");
    var topbarPrevBtn = shell.querySelector("#topbarDatePrev");
    var topbarNextBtn = shell.querySelector("#topbarDateNext");
    var sidebarPrevBtn = shell.querySelector("#navDatePrev");
    var sidebarNextBtn = shell.querySelector("#navDateNext");

    function renderLabel() {
      var viewName = state.view.charAt(0).toUpperCase() + state.view.slice(1);
      var label = headerLabel(state.view, state.date);
      topbarLabel.textContent = viewName + " · " + label;
      dateLabelEl.textContent = label;
      topbarPrevBtn.setAttribute("aria-label", stepAriaLabel(state.view, -1));
      topbarNextBtn.setAttribute("aria-label", stepAriaLabel(state.view, 1));
      sidebarPrevBtn.setAttribute("aria-label", stepAriaLabel(state.view, -1));
      sidebarNextBtn.setAttribute("aria-label", stepAriaLabel(state.view, 1));
      for (var i = 0; i < viewBtns.length; i++) {
        viewBtns[i].classList.toggle("active", viewBtns[i].dataset.view === state.view);
      }
    }

    function clearIdleTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    function armIdleTimer() {
      clearIdleTimer();
      idleTimer = setTimeout(closeSidebar, IDLE_DISMISS_MS);
    }

    function openSidebar() {
      state.sidebarOpen = true;
      sidebar.classList.add("open");
      scrim.classList.add("visible");
      armIdleTimer();
    }

    function closeSidebar() {
      state.sidebarOpen = false;
      sidebar.classList.remove("open");
      scrim.classList.remove("visible");
      clearIdleTimer();
    }

    function fireStateChange() {
      renderLabel();
      if (opts.onStateChange) opts.onStateChange({ view: state.view, date: state.date });
    }

    function fireRefresh() {
      if (opts.onRefresh) opts.onRefresh();
    }

    function setView(view) {
      if (state.view === view) { closeSidebar(); return; }
      state.view = view;
      closeSidebar();
      fireStateChange();
      fireRefresh();
    }

    function setDate(iso) {
      closeSidebar();
      if (state.date === iso) return;
      state.date = iso;
      fireStateChange();
      fireRefresh();
    }

    shell.querySelector(".hamburger-btn").addEventListener("click", function () {
      if (state.sidebarOpen) { closeSidebar(); return; }
      openSidebar();
      fireRefresh();
    });

    scrim.addEventListener("click", closeSidebar);

    for (var i = 0; i < viewBtns.length; i++) {
      viewBtns[i].addEventListener("click", function (e) {
        setView(e.currentTarget.dataset.view);
      });
    }

    sidebarPrevBtn.addEventListener("click", function () {
      setDate(stepDate(state.view, state.date, -1));
    });
    sidebarNextBtn.addEventListener("click", function () {
      setDate(stepDate(state.view, state.date, 1));
    });
    topbarPrevBtn.addEventListener("click", function () {
      setDate(stepDate(state.view, state.date, -1));
    });
    topbarNextBtn.addEventListener("click", function () {
      setDate(stepDate(state.view, state.date, 1));
    });
    shell.querySelector("#navTodayBtn").addEventListener("click", function () {
      setDate(todayLocal());
    });
    shell.querySelector("#navSettingsBtn").addEventListener("click", function () {
      closeSidebar();
      if (opts.onSettings) opts.onSettings();
    });

    shell.querySelector(".refresh-btn").addEventListener("click", fireRefresh);

    // A tap anywhere clears night-dim for the rest of this page load (wall
    // slice §10.2), unlocks WebAudio for the rest of it too (§11.5.1), and,
    // while the sidebar is open, resets its idle timer.
    shell.addEventListener("pointerdown", function () {
      dimSuppressed = true;
      updateLiveBits();
      if (g.Sound) g.Sound.unlock();
      if (state.sidebarOpen) armIdleTimer();
    });

    // Registered only while still locked — `Sound.unlock()` notifies its
    // listeners exactly once (the first real unlock) and never again, so a
    // listener added on a later mount (settings closing, a re-pair) after
    // that has already happened would sit forever unfired.
    if (g.Sound) {
      if (g.Sound.isUnlocked()) soundIndicator.style.display = "none";
      else g.Sound.onUnlock(function () { soundIndicator.style.display = "none"; });
    }

    function updateLiveBits() {
      var now = new Date();
      clockEl.textContent = formatClock(now);
      var settings = g.Store.getSettings();
      var night = !dimSuppressed && isNight(now, settings.dimStartHour, settings.dimEndHour);
      shell.classList.toggle("dimmed", night);
    }

    updateLiveBits();
    clockTimer = setInterval(updateLiveBits, 15000);
    renderLabel();

    // §7.1 — the month grid's "tapping a day opens that day's day view", the
    // one navigation that moves view AND date together. `setView` and
    // `setDate` each guard on their own field and fire independently, so
    // calling them in sequence would spend two state changes and two polls
    // on one tap.
    function goTo(view, iso) {
      if (state.view === view && state.date === iso) { closeSidebar(); return; }
      state.view = view;
      state.date = iso;
      closeSidebar();
      fireStateChange();
      fireRefresh();
    }

    // §4.1 — always day/today on boot, after rollover, and after the sidebar
    // is dismissed without a choice (the dismiss paths above already close
    // it without touching view/date, so only rollover needs this call).
    function resetToToday() {
      state.view = "day";
      state.date = todayLocal();
      closeSidebar();
      fireStateChange();
    }

    function destroy() {
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = null;
      clearIdleTimer();
    }

    return {
      contentEl: contentEl,
      getState: function () { return { view: state.view, date: state.date }; },
      goTo: goTo,
      resetToToday: resetToToday,
      destroy: destroy,
    };
  }

  g.NavUi = { mount: mount, VIEWS: VIEWS };
})(typeof window !== "undefined" ? window : globalThis);
