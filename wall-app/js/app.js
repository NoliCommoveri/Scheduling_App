// app.js — boot and view routing (TDS_Slice_Wall_Display_App.md §11).
// Phase 2 scope: first-run wizard -> ambient tiles from the live roster, the
// admin-gated Settings panel, and the "unpaired" screen (§3.2's revocation
// path). Polling cadence, events, counts, Done Today and the day-rollover
// timer join in Phase 3 once poll.js and the *-core.js readers exist.

(function (g) {
  "use strict";

  function boot() {
    var root = document.getElementById("app");
    var settings = g.Store.getSettings();

    if (!settings.adminPinHash) {
      // First run: no admin PIN means no token either (setup.js writes the
      // PIN before pairing), so the whole two-step wizard runs.
      g.Setup.run(root, function () { renderAmbient(root); });
      return;
    }

    if (!g.Store.getToken()) {
      showUnpaired(root);
      return;
    }

    renderAmbient(root);
  }

  function renderAmbient(root) {
    root.innerHTML = "";
    var loading = document.createElement("div");
    loading.className = "ambient-loading";
    loading.textContent = "Loading…";
    root.appendChild(loading);

    g.WallApi.getChildren().then(function (children) {
      g.AmbientUi.render(root, children, {
        onSettings: function () { openSettings(root); },
        onTileTap: function (/* child */) {
          // Phase 4a wires the PIN pad and per-child chore list. Until then
          // a tile tap is a no-op — there is nothing behind it yet.
        },
      });
    }).catch(function (err) {
      if (err instanceof g.WallApi.UnpairedError) { showUnpaired(root); return; }
      root.innerHTML = "";
      var msg = document.createElement("div");
      msg.className = "ambient-error";
      msg.textContent = "Could not reach the server. Retrying…";
      root.appendChild(msg);
      setTimeout(function () { renderAmbient(root); }, 5000);
    });
  }

  function openSettings(root) {
    g.SettingsUi.open(root, function () { renderAmbient(root); });
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
      g.Setup.runRepair(root, function () { renderAmbient(root); });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
