// wizard.js — Startup Wizard (SRS Module 1). Runs once, when no child record
// exists. Captures PIN, child name, semester label, theme; writes the three
// singleton stores; then transitions to the Daily Planner. Touches no content.

(function (g) {
  "use strict";

  // Quick-start choice at setup is the two Palette themes only — the full
  // set (including both Signature themes, Module 10) is always reachable
  // afterward via the ungated theme switcher (TDS_Slice_M3 §3/FR-2), so
  // this scoping never restricts what the child can ultimately choose.
  var THEMES = g.ThemeCore.listThemes().filter(function (t) { return t.tier === "palette"; });

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function run(root, onComplete) {
    var state = { pin: "", pin2: "", name: "", semester: "", theme: "daylight" };
    var step = 0; // 0..3
    var steps = [renderPin, renderName, renderSemester, renderTheme];

    function applyThemePreview(id) { document.documentElement.setAttribute("data-theme", id); }

    function frame(inner) {
      root.innerHTML = "";
      var dots = state && "";
      var wrap = el(
        '<div class="wizard">' +
          '<div class="wiz-brand">Daily Plan · Setup</div>' +
          '<div class="wiz-progress">' +
            steps.map(function (_, i) { return '<div class="wiz-dot' + (i <= step ? " done" : "") + '"></div>'; }).join("") +
          '</div>' +
          '<div class="wiz-card" id="wizCard"></div>' +
        '</div>'
      );
      wrap.querySelector("#wizCard").appendChild(inner);
      root.appendChild(wrap);
      var firstInput = inner.querySelector("input");
      if (firstInput) firstInput.focus();
    }

    function actions(backLabel, nextLabel, onNext, canBack) {
      var bar = el('<div class="wiz-actions"></div>');
      if (canBack) {
        var back = el('<button class="btn ghost">Back</button>');
        back.onclick = function () { step--; steps[step](); };
        bar.appendChild(back);
      }
      var next = el('<button class="btn">' + nextLabel + '</button>');
      next.onclick = onNext;
      bar.appendChild(next);
      return bar;
    }

    // --- Step 1: PIN ---
    function renderPin() {
      var body = el(
        '<div>' +
          '<div class="wiz-step-label">Step 1 of 4</div>' +
          '<h1 class="wiz-title">Create a parent PIN</h1>' +
          '<p class="wiz-help">This unlocks parent actions later, like rescheduling or spending rewards. At least 4 digits.</p>' +
          '<div class="field"><label for="pin">PIN</label>' +
            '<input id="pin" inputmode="numeric" type="password" autocomplete="off" value="' + state.pin + '"></div>' +
          '<div class="field"><label for="pin2">Repeat PIN</label>' +
            '<input id="pin2" inputmode="numeric" type="password" autocomplete="off" value="' + state.pin2 + '">' +
            '<div class="err-text" id="pinErr"></div></div>' +
        '</div>'
      );
      body.appendChild(actions(null, "Continue", function () {
        state.pin = body.querySelector("#pin").value.trim();
        state.pin2 = body.querySelector("#pin2").value.trim();
        var err = body.querySelector("#pinErr");
        if (!/^\d{4,}$/.test(state.pin)) { err.textContent = "Use at least 4 digits, numbers only."; return; }
        if (state.pin !== state.pin2) { err.textContent = "The two PINs don't match."; return; }
        step = 1; renderName();
      }, false));
      frame(body);
    }

    // --- Step 2: Name ---
    function renderName() {
      var body = el(
        '<div>' +
          '<div class="wiz-step-label">Step 2 of 4</div>' +
          '<h1 class="wiz-title">Who is this for?</h1>' +
          '<p class="wiz-help">Your child\'s first name or nickname. It shows up around the app.</p>' +
          '<div class="field"><label for="name">Name</label>' +
            '<input id="name" type="text" autocomplete="off" maxlength="24" value="' + escapeAttr(state.name) + '">' +
            '<div class="err-text" id="nameErr"></div></div>' +
        '</div>'
      );
      body.appendChild(actions(true, "Continue", function () {
        state.name = body.querySelector("#name").value.trim();
        var err = body.querySelector("#nameErr");
        if (!state.name) { err.textContent = "Please enter a name."; return; }
        step = 2; renderSemester();
      }, true));
      frame(body);
    }

    // --- Step 3: Semester label ---
    function renderSemester() {
      var body = el(
        '<div>' +
          '<div class="wiz-step-label">Step 3 of 4</div>' +
          '<h1 class="wiz-title">Name this stretch of school</h1>' +
          '<p class="wiz-help">A label for the current semester, like "Fall 2026". It\'s just a heading — it doesn\'t control anything.</p>' +
          '<div class="field"><label for="sem">Semester label</label>' +
            '<input id="sem" type="text" autocomplete="off" maxlength="40" value="' + escapeAttr(state.semester) + '" placeholder="Fall 2026">' +
            '<div class="err-text" id="semErr"></div></div>' +
        '</div>'
      );
      body.appendChild(actions(true, "Continue", function () {
        state.semester = body.querySelector("#sem").value.trim();
        var err = body.querySelector("#semErr");
        if (!state.semester) { err.textContent = "Please enter a label."; return; }
        step = 3; renderTheme();
      }, true));
      frame(body);
    }

    // --- Step 4: Theme ---
    function renderTheme() {
      var body = el(
        '<div>' +
          '<div class="wiz-step-label">Step 4 of 4</div>' +
          '<h1 class="wiz-title">Pick a look</h1>' +
          '<p class="wiz-help">You can change this later in settings.</p>' +
          '<div class="theme-grid" id="themeGrid"></div>' +
        '</div>'
      );
      var grid = body.querySelector("#themeGrid");
      THEMES.forEach(function (t) {
        var opt = el(
          '<button class="theme-opt" aria-pressed="' + (state.theme === t.id) + '">' +
            '<div class="theme-swatch">' + t.swatch.map(function (c) { return '<span style="background:' + c + '"></span>'; }).join("") + '</div>' +
            t.name +
          '</button>'
        );
        opt.onclick = function () {
          state.theme = t.id;
          applyThemePreview(t.id);
          Array.prototype.forEach.call(grid.children, function (c) { c.setAttribute("aria-pressed", "false"); });
          opt.setAttribute("aria-pressed", "true");
        };
        grid.appendChild(opt);
      });
      body.appendChild(actions(true, "Finish setup", function () {
        finish();
      }, true));
      frame(body);
    }

    function finish() {
      Promise.all([
        g.DB.putSingleton("child", { name: state.name, pin: state.pin }),
        g.DB.putSingleton("semester", { label: state.semester }),
        g.DB.putSingleton("themeSettings", { theme: state.theme })
      ]).then(function () {
        // Best-effort request to survive browser storage eviction (TDS §4).
        if (navigator.storage && navigator.storage.persist) {
          try { navigator.storage.persist(); } catch (e) { /* denial not surfaced */ }
        }
        onComplete({ name: state.name, semester: state.semester, theme: state.theme });
      });
    }

    steps[0]();
  }

  function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  g.Wizard = { run: run, THEMES: THEMES };
})(window);


