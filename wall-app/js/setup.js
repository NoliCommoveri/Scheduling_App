// setup.js — first-run wizard and re-pairing (TDS_Slice_Wall_Display_App.md
// §4.5, §3.2). Two steps only, in order: set the admin PIN, then pair the
// display. There is no third step — the roster arrives on its own (§0.1),
// with nothing to type for any child.
//
// `pairing.js` from the pre-revision draft is gone; this pairs a *display*,
// not a child (§3.2), and its Continue button never resolves without a
// stored token — same "not skippable" reasoning as the Child App's wizard,
// applied to the one household credential instead of a per-child one.

(function (g) {
  "use strict";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function frame(root, step, total, inner) {
    root.innerHTML = "";
    var wrap = el(
      '<div class="wiz">' +
        '<div class="wiz-brand">Family Wall Display · Setup</div>' +
        '<div class="wiz-progress">' +
          Array.from({ length: total }).map(function (_, i) {
            return '<div class="wiz-dot' + (i <= step ? " done" : "") + '"></div>';
          }).join("") +
        '</div>' +
        '<div class="wiz-card" id="wizCard"></div>' +
      '</div>'
    );
    wrap.querySelector("#wizCard").appendChild(inner);
    root.appendChild(wrap);
    var firstInput = inner.querySelector("input");
    if (firstInput) firstInput.focus();
  }

  function actions(nextLabel, onNext, canBack, onBack) {
    var bar = el('<div class="wiz-actions"></div>');
    if (canBack) {
      var back = el('<button class="btn ghost">Back</button>');
      back.onclick = onBack;
      bar.appendChild(back);
    }
    var next = el('<button class="btn">' + nextLabel + '</button>');
    next.onclick = onNext;
    bar.appendChild(next);
    return bar;
  }

  // --- Step: admin PIN (§4.5) -------------------------------------------

  function renderAdminPinStep(root, state, onNext) {
    var body = el(
      '<div>' +
        '<div class="wiz-step-label">Step 1 of 2</div>' +
        '<h1 class="wiz-title">Set an admin PIN</h1>' +
        '<p class="wiz-help">This guards Settings — re-pairing, child PINs, dim hours. ' +
          'Keep it different from any child\'s chore PIN. At least 4 digits.</p>' +
        '<div class="field"><label for="apin">Admin PIN</label>' +
          '<input id="apin" inputmode="numeric" type="password" autocomplete="off"></div>' +
        '<div class="field"><label for="apin2">Repeat</label>' +
          '<input id="apin2" inputmode="numeric" type="password" autocomplete="off">' +
          '<div class="err-text" id="apinErr"></div></div>' +
      '</div>'
    );
    body.appendChild(actions("Continue", function () {
      var pin = body.querySelector("#apin").value.trim();
      var pin2 = body.querySelector("#apin2").value.trim();
      var err = body.querySelector("#apinErr");
      if (!/^\d{4,}$/.test(pin)) { err.textContent = "Use at least 4 digits, numbers only."; return; }
      if (pin !== pin2) { err.textContent = "The two PINs don't match."; return; }
      g.PinCore.createPinRecord(pin).then(function (rec) {
        g.Store.setSettings({ adminPinSalt: rec.pinSalt, adminPinHash: rec.pinHash });
        onNext();
      });
    }, false));
    frame(root, 0, 2, body);
  }

  // --- Step: pair the display (§3.2) --------------------------------------

  function renderPairStep(root, step, total, onDone, onBack) {
    var body = el(
      '<div>' +
        '<div class="wiz-step-label">Step ' + (step + 1) + ' of ' + total + '</div>' +
        '<h1 class="wiz-title">Pair this display</h1>' +
        '<p class="wiz-help">In the Management App, open <strong>Settings → Devices</strong> and press ' +
          '<strong>Pair wall display</strong>. Type the 8-character code it shows here — it is good for ' +
          '15 minutes and works once. Every active child then appears on this screen automatically; ' +
          'there is nothing to pair per child.</p>' +
        '<div class="field"><label for="code">Pairing code</label>' +
          '<input id="code" type="text" autocomplete="off" autocapitalize="characters" ' +
            'spellcheck="false" maxlength="12" inputmode="text"></div>' +
        '<div class="err-text" id="codeErr"></div>' +
      '</div>'
    );
    var bar = actions("Pair display", function () {
      var err = body.querySelector("#codeErr");
      var button = bar.querySelector("button:last-child");
      err.textContent = "";
      var code = body.querySelector("#code").value.replace(/[\s-]/g, "").toUpperCase();
      if (!code) { err.textContent = "Enter the pairing code."; return; }
      button.disabled = true;
      g.WallApi.pair(code, "Wall display").then(function (res) {
        g.Store.setToken(res.token);
        onDone();
      }).catch(function (e) {
        button.disabled = false;
        err.textContent = e.message || "Could not pair. Check the code and try again.";
      });
    }, !!onBack, onBack);
    body.appendChild(bar);
    frame(root, step, total, body);
  }

  // First run: no admin PIN and no token. Two steps, in order, not skippable —
  // same reasoning as the Child App's wizard (wizard.js), applied to the one
  // household credential instead of a per-child one.
  function run(root, onComplete) {
    function toPinStep() { renderAdminPinStep(root, {}, toPairStep); }
    function toPairStep() { renderPairStep(root, 1, 2, onComplete, toPinStep); }
    toPinStep();
  }

  // Re-pair only (Settings §4.5, or the "unpaired" screen after a revoke).
  // The admin PIN is untouched — a revoked display still has the same admin,
  // and forcing a reset here would strand Settings behind a PIN nobody
  // remembers changing.
  function runRepair(root, onComplete) {
    renderPairStep(root, 0, 1, onComplete);
  }

  g.Setup = { run: run, runRepair: runRepair };
})(typeof window !== "undefined" ? window : globalThis);
