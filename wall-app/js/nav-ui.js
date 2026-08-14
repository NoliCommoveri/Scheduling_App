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
// Only Day view has real content behind it until Phase 3 (day) and Phase 8
// (week/month); the caller is responsible for showing a placeholder for the
// rest, this file only owns navigation.

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

  function formatClock(d) {
    var h = d.getHours();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 || 12;
    return h12 + ":" + pad2(d.getMinutes()) + " " + ampm;
  }

  function dateLabel(iso) {
    var parts = iso.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
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
          '<div class="wall-topbar-label"></div>' +
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
    var clockEl = shell.querySelector(".wall-clock");
    var dateLabelEl = shell.querySelector("#navDateLabel");
    var viewBtns = shell.querySelectorAll(".sidebar-view-btn");

    function renderLabel() {
      var viewName = state.view.charAt(0).toUpperCase() + state.view.slice(1);
      topbarLabel.textContent = viewName + " · " + dateLabel(state.date);
      dateLabelEl.textContent = dateLabel(state.date);
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

    shell.querySelector("#navDatePrev").addEventListener("click", function () {
      setDate(addDays(state.date, -1));
    });
    shell.querySelector("#navDateNext").addEventListener("click", function () {
      setDate(addDays(state.date, 1));
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
    // slice §10.2) and, while the sidebar is open, resets its idle timer.
    shell.addEventListener("pointerdown", function () {
      dimSuppressed = true;
      updateLiveBits();
      if (state.sidebarOpen) armIdleTimer();
    });

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
      resetToToday: resetToToday,
      destroy: destroy,
    };
  }

  g.NavUi = { mount: mount, VIEWS: VIEWS };
})(typeof window !== "undefined" ? window : globalThis);
