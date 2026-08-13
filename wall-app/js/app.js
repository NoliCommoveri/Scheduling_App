// app.js — boot, view routing, and the day-rollover timer
// (TDS_Slice_Wall_Display_App.md §11). Phase 2 scope was first-run wizard ->
// ambient tiles, the admin-gated Settings panel, and the "unpaired" screen
// (§3.2). Phase 3 replaces the one-shot roster fetch with poll.js's cadence
// (§5.2) and adds the local-midnight rollover timer (§5.3).

(function (g) {
  "use strict";

  var pollUnsub = null;
  var midnightTimer = null;

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
    if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
  }

  function startAmbient(root) {
    teardownAmbient();

    root.innerHTML = "";
    var loading = document.createElement("div");
    loading.className = "ambient-loading";
    loading.textContent = "Loading…";
    root.appendChild(loading);

    var firstLoadRetried = false;

    pollUnsub = g.Poll.onUpdate(function (state) {
      if (state.lastError instanceof g.WallApi.UnpairedError) {
        teardownAmbient();
        showUnpaired(root);
        return;
      }

      if (!state.lastSuccessAt && state.lastError) {
        // First fetch failed outright — nothing to render yet. §5.4's
        // "keep the last render" only applies once there has been one; this
        // is the one case with nothing to fall back to.
        if (!firstLoadRetried) {
          firstLoadRetried = true;
          setTimeout(function () { g.Poll.pollNow(); }, 5000);
        }
        root.innerHTML = "";
        var msg = document.createElement("div");
        msg.className = "ambient-error";
        msg.textContent = "Could not reach the server. Retrying…";
        root.appendChild(msg);
        return;
      }

      g.AmbientUi.render(root, state, {
        onSettings: function () { openSettings(root); },
        onTileTap: function (/* child */) {
          // Phase 4a wires the PIN pad and per-child chore list. Until then
          // a tile tap is a no-op — there is nothing behind it yet.
        },
      });
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
