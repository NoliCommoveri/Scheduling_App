// app.js — boot, the nav shell, and the day-rollover timer.
// TDS_Slice_Wall_Display_App.md §11 (boot states) and
// TDS_Slice_Wall_Calendar_Redesign.md §16. Phase 2 put the ambient board
// inside nav-ui.js's persistent shell; Phase 3 replaces that board with
// `day-ui.js`'s real day view, for any rendered date, not just today. Phase 8
// adds `week-ui.js`'s real week view (rows, not the TDS's original columns —
// superseded in-session, see week-ui.js's own header). Month still shows a
// placeholder.
//
// Phase 6 wires the completion sheet: `onChipTap` opens `CompleteUi`
// against `root` — the outer shell element, ONE LEVEL ABOVE
// `navCtrl.contentEl` — because `renderContent()` below replaces
// `contentEl`'s subtree wholesale on every poll (background cadence or the
// pollNow() a write triggers), and an overlay living inside it would be
// torn out from under whoever is mid-completion. Phase 6 also drains
// `wall.pendingEarns` (§6.2's retry queue) on every successful poll, not
// just right after a write, so a reward that failed to send gets another
// chance on the ordinary 10-minute cadence too.
//
// Phase 6b wires the start-time chime (§11.5). `remindTick` runs on a cheap
// LOCAL 5-second timer — no network — that only asks "did the clock cross
// into a new minute, and does any placed chore start THIS minute". Only
// when the answer to both is yes does it spend a network poll, landing
// right before the chime fires so a chore finished on the child's own
// tablet minutes ago isn't announced here as still pending (§11.5's own
// "one poll immediately before a chime fires, not a faster cadence"). This
// is deliberately independent of `Poll`'s own 10-minute cadence rather than
// piggybacked on it — the two run on different clocks for different
// reasons and tying them together would mean either a laggy chime or a
// faster background cadence than §10.1 asks for.

(function (g) {
  "use strict";

  var pollUnsub = null;
  var midnightTimer = null;
  var navCtrl = null;
  var remindTimer = null;
  var firedChimeKeys = Object.create(null);
  var lastCheckedMin = null;

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
    g.DayUi.stop();
    g.WeekUi.stop();
    g.CompleteUi.close();
    stopRemindLoop();
    if (navCtrl) { navCtrl.destroy(); navCtrl = null; }
    if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
  }

  // ---- §11.5 start-time chime (§16 Phase 6b) -------------------------------

  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function soundOnMapFromPrefs() {
    var prefs = g.Store.getChildPrefs();
    var map = {};
    Object.keys(prefs).forEach(function (id) { map[id] = prefs[id].soundOn !== false; });
    return map;
  }

  function fireDueChimes(state, nowMin) {
    var settings = g.Store.getSettings();
    var candidates = g.RemindCore.chimeCandidates(state, state.today);
    var due = g.RemindCore.dueNow(candidates, nowMin, {
      soundOnByChild: soundOnMapFromPrefs(),
      quietStartHour: settings.dimStartHour,
      quietEndHour: settings.dimEndHour,
      date: state.today,
    }, firedChimeKeys);
    due.forEach(function (entry) {
      firedChimeKeys[g.RemindCore.fireKey(entry.row, state.today)] = true;
    });
    if (due.length && g.Sound) g.Sound.chime();
  }

  function remindTick() {
    var state = g.Poll.getState();
    if (!state.today) return;
    var nowMin = nowMinutes();
    if (nowMin === lastCheckedMin) return; // already handled this minute
    lastCheckedMin = nowMin;
    var candidates = g.RemindCore.chimeCandidates(state, state.today);
    var mightFire = candidates.some(function (c) { return c.startMin === nowMin; });
    if (!mightFire) return; // nothing scheduled this minute — no poll spent
    g.Poll.pollNow().catch(function () {}).then(function () {
      fireDueChimes(g.Poll.getState(), nowMin);
    });
  }

  function startRemindLoop() {
    stopRemindLoop();
    lastCheckedMin = null;
    remindTimer = setInterval(remindTick, 5000);
    remindTick();
  }

  function stopRemindLoop() {
    if (remindTimer) { clearInterval(remindTimer); remindTimer = null; }
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
    loading.className = "day-loading";
    loading.textContent = "Loading…";
    navCtrl.contentEl.appendChild(loading);

    function showPlaceholder(text) {
      g.DayUi.stop();
      g.WeekUi.stop();
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

      if (navState.view === "day") {
        g.WeekUi.stop();
        g.DayUi.render(navCtrl.contentEl, lastPollState, navState.date, {
          onChipTap: function (row, child) {
            g.CompleteUi.open(root, row, child);
          },
        });
        return;
      }

      if (navState.view === "week") {
        g.DayUi.stop();
        g.WeekUi.render(navCtrl.contentEl, lastPollState, navState.date, {});
        return;
      }

      var label = navState.view.charAt(0).toUpperCase() + navState.view.slice(1);
      showPlaceholder(label + " view arrives in a later build phase.");
    }

    pollUnsub = g.Poll.onUpdate(function (state) {
      if (state.lastError instanceof g.WallApi.UnpairedError) {
        teardownAmbient();
        showUnpaired(root);
        return;
      }
      lastPollState = state;
      renderContent();
      // §6.2 — drained on every successful poll, not just right after a
      // write. A fault here must never block rendering: it is a queue
      // state change, not a page state, so it is fired and forgotten.
      if (!state.lastError) g.CompleteUi.drainPendingEarns();
    });

    g.Poll.start();
    startRemindLoop();
    scheduleMidnightRollover();
  }

  function openSettings(root) {
    var children = g.Poll.getState().children || [];
    teardownAmbient();
    g.SettingsUi.open(root, children, function () { startAmbient(root); });
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
      g.CompleteUi.close(); // a sheet held open across midnight names a stale row
      g.WeekUi.stop(); // same reason — the week detail sheet names a stale date
      if (navCtrl) navCtrl.resetToToday();
      firedChimeKeys = Object.create(null); // a new day's fire keys start clean, per remind-core.js's date-scoped key
      lastCheckedMin = null;
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
