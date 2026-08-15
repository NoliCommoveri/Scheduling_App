// settings-ui.js — the admin gate and the Settings panel
// (TDS_Slice_Wall_Display_App.md §4.5). Phase 2 scope: the PIN gate itself,
// re-pairing the display, and the shell reload button §10.2 requires. Wall
// Calendar Redesign Phase 3 adds the time-format control (§11.3). Phase 6
// adds the failed-earns list (§6.2's `rejected` outcome — an admin's only
// window into an append-only ledger entry that will never retry on its
// own). Per-child PIN management does not join at all — repealed, §2.3.

(function (g) {
  "use strict";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Shows the admin PIN pad; calls onClose() whichever way the user leaves
  // (success into the panel and back out, or Cancel). Reuses PinCore's
  // verify — the admin PIN is stored the same shape as a child's (§4.5), just
  // under wall.settings instead of wall.pins.
  function open(root, onClose) {
    renderPad(root, onClose);
  }

  function renderPad(root, onClose) {
    root.innerHTML = "";
    var body = el(
      '<div class="settings-overlay">' +
        '<div class="settings-pad-card">' +
          '<h2>Admin PIN</h2>' +
          '<input id="settingsPin" inputmode="numeric" type="password" autocomplete="off" autofocus>' +
          '<div class="err-text" id="settingsPinErr"></div>' +
          '<div class="wiz-actions">' +
            '<button class="btn ghost" id="settingsCancel">Cancel</button>' +
            '<button class="btn" id="settingsUnlock">Unlock</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    root.appendChild(body);

    var input = body.querySelector("#settingsPin");
    var err = body.querySelector("#settingsPinErr");
    input.focus();

    body.querySelector("#settingsCancel").addEventListener("click", function () { onClose(); });

    function tryUnlock() {
      var settings = g.Store.getSettings();
      var pin = input.value.trim();
      g.PinCore.verifyPin(pin, { pinSalt: settings.adminPinSalt, pinHash: settings.adminPinHash })
        .then(function (ok) {
          if (!ok) { err.textContent = "Wrong PIN."; input.value = ""; input.focus(); return; }
          renderPanel(root, onClose);
        });
    }
    body.querySelector("#settingsUnlock").addEventListener("click", tryUnlock);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") tryUnlock(); });
  }

  function renderPanel(root, onClose) {
    root.innerHTML = "";
    var settings = g.Store.getSettings();
    var is24h = settings.timeFormat !== "12h";
    var body = el(
      '<div class="settings-overlay">' +
        '<div class="settings-panel">' +
          '<h2>Settings</h2>' +
          '<div class="settings-row">' +
            '<div>' +
              '<div class="settings-row-title">Time format</div>' +
              '<div class="settings-row-help">Governs every clock, chip time, and the grid gutter (§11.3).</div>' +
            '</div>' +
            '<div class="settings-toggle-group">' +
              '<button class="btn ghost time-fmt-btn" id="timeFmt24" data-fmt="24h">24-hour</button>' +
              '<button class="btn ghost time-fmt-btn" id="timeFmt12" data-fmt="12h">12-hour</button>' +
            '</div>' +
          '</div>' +
          '<div class="settings-row settings-row-column" id="failedEarnsRow">' +
            '<div>' +
              '<div class="settings-row-title">Failed rewards</div>' +
              '<div class="settings-row-help">Chores that completed but could not credit a reward. ' +
                'Fix the reward category in the Management App, then adjust the balance from there.</div>' +
            "</div>" +
            '<ul class="failed-earns-list"></ul>' +
          "</div>" +
          '<div class="settings-row">' +
            '<div>' +
              '<div class="settings-row-title">Re-pair this display</div>' +
              '<div class="settings-row-help">Use this if the display was revoked, or to move it to a new tablet.</div>' +
            '</div>' +
            '<button class="btn" id="repairBtn">Re-pair</button>' +
          '</div>' +
          '<div class="settings-row">' +
            '<div>' +
              '<div class="settings-row-title">Reload app</div>' +
              '<div class="settings-row-help">Unregisters and re-registers the shell — use if an update seems stuck.</div>' +
            '</div>' +
            '<button class="btn" id="reloadBtn">Reload</button>' +
          '</div>' +
          '<div class="wiz-actions"><button class="btn ghost" id="settingsDone">Done</button></div>' +
        '</div>' +
      '</div>'
    );
    root.appendChild(body);

    var fmtBtns = body.querySelectorAll(".time-fmt-btn");
    function paintFmtButtons() {
      fmtBtns.forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.fmt === (is24h ? "24h" : "12h"));
      });
    }
    paintFmtButtons();
    fmtBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        is24h = btn.dataset.fmt === "24h";
        g.Store.setSettings({ timeFormat: is24h ? "24h" : "12h" });
        paintFmtButtons();
      });
    });

    // §6.2's `rejected` outcome, surfaced rather than dropped — the row is
    // never retried (it will never work), so this list is the only trace
    // left of a reward that did not land. Cleared per-row once an admin has
    // acted on it in the Management App; nothing here writes to D1.
    var failedRow = body.querySelector("#failedEarnsRow");
    var failedList = body.querySelector(".failed-earns-list");
    function paintFailedEarns() {
      var failed = g.Store.getFailedEarns();
      failedRow.style.display = failed.length ? "" : "none";
      failedList.innerHTML = "";
      failed.forEach(function (entry) {
        var li = el(
          '<li class="failed-earn-row">' +
            '<span class="failed-earn-text"></span>' +
            '<button class="btn ghost failed-earn-dismiss" type="button">Dismiss</button>' +
          "</li>"
        );
        li.querySelector(".failed-earn-text").textContent = entry.category + " " + entry.amount + " — " + entry.reason;
        li.querySelector(".failed-earn-dismiss").addEventListener("click", function () {
          g.Store.setFailedEarns(g.Store.getFailedEarns().filter(function (e) { return e.id !== entry.id; }));
          paintFailedEarns();
        });
        failedList.appendChild(li);
      });
    }
    paintFailedEarns();

    body.querySelector("#settingsDone").addEventListener("click", function () { onClose(); });

    body.querySelector("#repairBtn").addEventListener("click", function () {
      root.innerHTML = "";
      g.Setup.runRepair(root, function () { onClose(); });
    });

    body.querySelector("#reloadBtn").addEventListener("click", function () {
      if (!("serviceWorker" in navigator)) { location.reload(); return; }
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }).then(function () { location.reload(); });
    });
  }

  g.SettingsUi = { open: open };
})(typeof window !== "undefined" ? window : globalThis);
