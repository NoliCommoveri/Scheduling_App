// app.js — bootstrap and routing. No child record yet ⇒ Startup Wizard (Module 1);
// otherwise ⇒ Daily Planner (Module 3). The wizard runs exactly once per device.

(function (g) {
  "use strict";

  var root = document.getElementById("root");

  function startPlanner() {
    // Streak's gap catch-up (Module 7 FR-3) runs on every app open, before the
    // planner renders — cheap at M1/M2 volumes (TDS_Slice_M2 §5's cost note).
    Promise.all([g.DB.getSingleton("child"), g.DB.getSingleton("semester"), g.DB.getSingleton("themeSettings"), g.Streak.reconcileOnOpen()])
      .then(function (r) {
        var child = r[0] || {};
        var semester = r[1] || {};
        g.Theming.applyTheme((r[2] || {}).theme);
        var planner = g.PlannerUI.mount(root, { name: child.name, semester: semester.label });

        // Online Revamp §8.4: mount first, then go to the network. The app opens
        // from cache and renders the last known plan instantly; the fetch below
        // is what makes it current, and it is allowed to fail.
        //
        // The catch-up walk above ran against the cache as it was. When a sync
        // brings past days in for the first time it can change the answer, so
        // it is re-run — never before the fetch, only after one that moved
        // something. Judging a day with no data yields 'neutral', so the stale
        // pass can only under-count a streak, never falsely break one.
        g.PlanSync.start(function () {
          g.Streak.reconcileOnOpen().then(function () { planner.reload(); });
        });

        // Phase 4's other half (§5.5): anything this device did while it could
        // not reach the server is queued in `outbox` and goes up now. Started
        // after the planner is mounted and never awaited, same as the read
        // path — a kid who opens the app to a dead network still gets their
        // plan on screen, and the queue simply waits.
        g.Outbox.start();
      });
  }

  function boot() {
    g.DB.getSingleton("themeSettings").then(function (ts) {
      g.Theming.applyTheme(ts && ts.theme);
      return g.DB.getSingleton("child");
    }).then(function (child) {
      // Both fields, not just the name. Since the Wizard's pairing step (§4.3)
      // writes `name` from the server the moment a code is redeemed, a setup
      // abandoned between that step and the last one leaves a named record with
      // no PIN — and a name-only gate would send it to the planner, where every
      // parent-gated action checks against a PIN that does not exist and can
      // never match. `pin` is written only by the final step, so requiring it
      // is what makes "the wizard ran to completion" the actual test.
      if (child && child.name && child.pin) {
        startPlanner();
      } else {
        g.Wizard.run(root, function () { startPlanner(); });
      }
    }).catch(function (e) {
      root.innerHTML = '<div class="empty"><h2>Storage unavailable</h2>' +
        '<p>This app needs on-device storage (IndexedDB) to run. If you are in a private window, try a normal window.</p></div>';
      console.error(e);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);

