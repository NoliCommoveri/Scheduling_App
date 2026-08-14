// app.js — boot, the nav shell, and the day-rollover timer.
// TDS_Slice_Wall_Display_App.md §11 (boot states) and
// TDS_Slice_Wall_Calendar_Redesign.md §16 Phase 2: the ambient board
// (ambient-ui.js) still renders as the day view's content, but it now lives
// inside nav-ui.js's persistent shell rather than owning the whole screen.
// Week/Month and any date other than today show a placeholder until Phase 3
// (day view for any date) and Phase 8 (week/month) land.

(function (g) {
  "use strict";

  var pollUnsub = null;
  var midnightTimer = null;
  var navCtrl = null;

  function boot() {
    var root = document.getElementById("app");
    var settings = g.Store.getSettings();

    if (!settings.adminPinHash) {
      // First run: no admin PIN means no token either (setup.js writes the
      // PIN before pairing), so the whole two-step wizard runs.
      g.Setup.run(root, function () { startAmbient(root); });
      return;
    }

    if (!g.Store.getToken()) {
      showUnpaired(root);
      return;
    }

    startAmbient(root);
  }

  function teardownAmbient() {
    if (pollUnsub) { pollUnsub(); pollUnsub = null; }
    g.Poll.stop();
    g.AmbientUi.stop();
    if (navCtrl) { navCtrl.destroy(); navCtrl = null; }
    if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
  }

  function startAmbient(root) {
    teardownAmbient();

    var lastPollState = null;
    var firstLoadRetried = false;

    navCtrl = g.NavUi.mount(root, {
      onStateChange: function () { renderContent(); },
      onRefresh: function () { g.Poll.pollNow(); },
      onSettings: function () { openSettings(root); },
    });

    var loading = document.createElement("div");
    loading.className = "ambient-loading";
    loading.textContent = "Loading…";
    navCtrl.contentEl.appendChild(loading);

    function showPlaceholder(text) {
      g.AmbientUi.stop();
      navCtrl.contentEl.innerHTML = "";
      var ph = document.createElement("div");
      ph.className = "wall-placeholder";
      ph.textContent = text;
      navCtrl.contentEl.appendChild(ph);
    }

    function renderContent() {
      if (!lastPollState) return;
      var navState = navCtrl.getState();

      if (!lastPollState.lastSuccessAt && lastPollState.lastError) {
        // First fetch failed outright — nothing to render yet. §5.4's
        // "keep the last render" only applies once there has been one; this
        // is the one case with nothing to fall back to.
        if (!firstLoadRetried) {
          firstLoadRetried = true;
          setTimeout(function () { g.Poll.pollNow(); }, 5000);
        }
        showPlaceholder("Could not reach the server. Retrying…");
        return;
      }

      if (navState.view === "day" && navState.date === lastPollState.today) {
        g.AmbientUi.render(navCtrl.contentEl, lastPollState, {
          onTileTap: function (/* child */) {
            // Phase 4a of the superseded slice wired the PIN pad and
            // per-child chore list. Never built; tapping a tile is a no-op.
          },
        });
        return;
      }

      if (navState.view === "day") {
        showPlaceholder("Viewing other days arrives in the next build phase.");
      } else {
        var label = navState.view.charAt(0).toUpperCase() + navState.view.slice(1);
        showPlaceholder(label + " view arrives in a later build phase.");
      }
    }

    pollUnsub = g.Poll.onUpdate(function (state) {
      if (state.lastError instanceof g.WallApi.UnpairedError) {
        teardownAmbient();
        showUnpaired(root);
        return;
      }
      lastPollState = state;
      renderContent();
    });

    g.Poll.start();
    scheduleMidnightRollover();
  }

  function openSettings(root) {
    teardownAmbient();
    g.SettingsUi.open(root, function () { startAmbient(root); });
  }

  function showUnpaired(root) {
    root.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "wiz";
    wrap.innerHTML =
      '<div class="wiz-brand">Family Wall Display</div>' +
      '<div class="wiz-card">' +
        '<h1 class="wiz-title">This display has been unpaired</h1>' +
        '<p class="wiz-help">Ask a parent to generate a new pairing code from ' +
          'Management App → Settings → Devices → Pair wall display.</p>' +
        '<div class="wiz-actions"><button class="btn" id="repairNow">Re-pair</button></div>' +
      '</div>';
    root.appendChild(wrap);
    wrap.querySelector("#repairNow").addEventListener("click", function () {
      g.Setup.runRepair(root, function () { startAmbient(root); });
    });
  }

  // §5.3 — a timer for the next local midnight, recomputed after each fire
  // so DST can't drift it. Five seconds past midnight, not exactly on it, so
  // a clock that's a hair fast doesn't fire this before the new day's rows
  // could plausibly exist server-side.
  function scheduleMidnightRollover() {
    if (midnightTimer) clearTimeout(midnightTimer);
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    midnightTimer = setTimeout(function () {
      // Calendar redesign §4.1/§10.3 — a rollover always lands back on
      // day/today, even if the sidebar had wandered to another view or date.
      if (navCtrl) navCtrl.resetToToday();
      g.Poll.rollover();
      scheduleMidnightRollover();
    }, next.getTime() - now.getTime());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
