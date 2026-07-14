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
        g.PlannerUI.mount(root, { name: child.name, semester: semester.label });
      });
  }

  function boot() {
    g.DB.getSingleton("themeSettings").then(function (ts) {
      g.Theming.applyTheme(ts && ts.theme);
      return g.DB.getSingleton("child");
    }).then(function (child) {
      if (child && child.name) {
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

