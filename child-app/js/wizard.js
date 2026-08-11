// wizard.js — Startup Wizard (SRS Module 1). Runs once, when no child record
// exists. Captures a PIN, pairs the device, captures a semester label and a
// theme; writes the three singleton stores; then transitions to the Daily
// Planner. Touches no content.
//
// Online Revamp §4.3 / Module 1 §7: step 2 used to ask someone to type the
// child's name. It now redeems a pairing code, and the name arrives from the
// server as part of that exchange — the same answer, from the authority that
// actually holds it, and the device gets its token in the bargain.
//
// [DECISION] Whether the pairing step is skippable
// Decided: no. Setup cannot finish without a paired device.
// Rationale: the token is what every read and write presents (§5.5), so a
//   device that skips it has no plan, no upload path, and no name — and its
//   only route back is the Settings screen, which sits behind the parent PIN.
//   That was the state a fresh install landed in before this step existed,
//   and it looked like an app that simply did not work. §8.4 already accepts
//   that a device must reach the network at least once to receive assignments;
//   requiring that once to be during setup adds no new constraint, it just
//   makes the existing one visible at the moment someone can act on it.
// Consequence: the parent mints the code in the Management App (Settings →
//   Devices) before handing over the child's device. DEPLOY.md Part D orders it.
// Locked for: this milestone.

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
    var steps = [renderPin, renderPair, renderSemester, renderTheme];

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
        step = 1; renderPair();
      }, false));
      frame(body);
    }

    // --- Step 2: Pair this device (Online Revamp §4.3) ---
    //
    // Two faces, chosen by whether a token is already stored: the code form, or
    // a confirmation. The second is not a nicety — `Pairing.redeem` commits the
    // token to `syncMeta` the moment the server answers, so a wizard abandoned
    // after this step and reopened must recognise its own work rather than ask
    // for a code that has already been consumed and cannot be redeemed twice.
    function renderPair() {
      var body = el(
        '<div>' +
          '<div class="wiz-step-label">Step 2 of 4</div>' +
          '<h1 class="wiz-title">Link this device</h1>' +
          '<div id="pairBody"><p class="wiz-help">Checking…</p></div>' +
        '</div>'
      );
      frame(body);

      var slot = body.querySelector("#pairBody");

      g.Pairing.getStatus().then(function (meta) {
        if (meta && meta.deviceToken) return renderPaired(meta.childName);
        renderForm();
      }).catch(function () { renderForm(); });

      function advance() { step = 2; renderSemester(); }

      function renderPaired(childName) {
        state.name = childName || state.name;
        slot.innerHTML = "";
        slot.appendChild(el(
          '<p class="wiz-help">This device is linked to <strong>' + escapeHtml(state.name) + '</strong>. ' +
          'Their plan will appear as soon as setup is finished.</p>'
        ));
        body.appendChild(actions(true, "Continue", advance, true));
      }

      function renderForm() {
        slot.innerHTML = "";
        slot.appendChild(el(
          '<p class="wiz-help">In the Management App, open <strong>Settings → Devices</strong>, ' +
          'pick this child and press <strong>Pair a device</strong>. Type the 8-character code it ' +
          'shows here — it is good for 15 minutes and works once.</p>'
        ));
        slot.appendChild(el(
          '<div class="field"><label for="code">Pairing code</label>' +
            '<input id="code" type="text" autocomplete="off" autocapitalize="characters" ' +
              'spellcheck="false" maxlength="12" inputmode="text">' +
            '<div class="err-text" id="codeErr"></div></div>'
        ));
        slot.appendChild(el(
          '<div class="field"><label for="devLabel">Name this device (optional)</label>' +
            '<input id="devLabel" type="text" autocomplete="off" maxlength="40" ' +
              'placeholder="e.g. Ellie\'s tablet"></div>'
        ));

        var bar = actions(true, "Link device", function () {
          var err = slot.querySelector("#codeErr");
          var button = bar.querySelector("button:last-child");
          err.textContent = "";
          button.disabled = true;
          g.Pairing.redeem(slot.querySelector("#code").value, slot.querySelector("#devLabel").value)
            .then(function (res) {
              button.disabled = false;
              if (!res.ok) { err.textContent = res.message; return; }
              // Straight on rather than pausing to confirm: the name coming
              // back is the confirmation, and it is on the next screen.
              state.name = res.childName || state.name;
              advance();
            });
        }, true);
        body.appendChild(bar);

        var codeInput = slot.querySelector("#code");
        if (codeInput) codeInput.focus();
      }
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
      // Merged, not replaced: the pairing step has already written `name` onto
      // this record (pairing.js), and a blind put would be writing the same
      // value back over a record that may have gained fields since.
      g.DB.getSingleton("child").then(function (child) {
        return Promise.all([
          g.DB.putSingleton("child", Object.assign({}, child, { name: state.name, pin: state.pin })),
          g.DB.putSingleton("semester", { label: state.semester }),
          g.DB.putSingleton("themeSettings", { theme: state.theme })
        ]);
      }).then(function () {
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
  // The child's name reaches this screen from the server (§4.3 step 4), so it
  // is escaped on the way into markup like any other value the device did not
  // author itself.
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  g.Wizard = { run: run, THEMES: THEMES };
})(window);


