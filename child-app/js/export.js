// export.js — Completion CSV Export (Module 8), wired to IndexedDB + file save.
// TDS_Slice_M2 §7. Mirrors the other DB-wiring files: export-core.js owns the
// pure row/CSV/note math; this file owns storage reads and the download trigger.
//
// §14 phase 3: the source used to be the received Activity/Chore, read out of
// the `activities`/`chores` stores those are now dropped. It is the `assignments`
// row now — decorated the same way planner-ui.js's rows are — keyed by id
// exactly as the old source maps were.

(function (g) {
  "use strict";

  var C = g.ExportCore;

  // The unfiltered, decorated index — the same join source the Completed view
  // uses, and for the same reason: an eligible record is by definition resolved,
  // so the plannable set (`DB.loadState()`) is exactly the wrong side of §6.4 to
  // look it up in.
  function loadAssignmentMap() {
    return g.DB.loadAssignmentIndex();
  }

  // Rows and the exact record objects they came from, kept in lockstep — a
  // record only gets flipped to exported if it actually produced a row.
  function gatherEligible() {
    return Promise.all([g.DB.getAll("activityRecords"), loadAssignmentMap(), g.DB.getSingleton("child"), g.DB.getSingleton("semester")])
      .then(function (r) {
        var eligible = r[0].filter(C.isEligible);
        var assignments = r[1];
        var child = r[2] || {};
        var semester = r[3] || {};
        var rows = [];
        var includedRecords = [];
        eligible.forEach(function (rec) {
          var assignmentRow = assignments[rec.activityId];
          // Fallen out of the local `assignments` cache window (plan-sync.js's
          // PAST_DAYS/FUTURE_DAYS) before this device got around to exporting —
          // skip defensively rather than report a row with nothing to say.
          if (!assignmentRow) return;
          rows.push(C.buildRow(rec, assignmentRow, child.name, semester.label));
          includedRecords.push(rec);
        });
        return { rows: rows, includedRecords: includedRecords, childName: child.name };
      });
  }

  // Category balances for the recovery note (TDS_Slice_M2 §7, closed by
  // TDS_Slice_M3 §9): every category the ledger mentions, folded by the same
  // shared function the on-screen display and the spend ceiling use, so the note
  // can never quote a balance the app does not show. themeDisplayName resolves
  // through the active theme's mapping — the same generic-default fallback the
  // display uses (§4) — never the raw categoryId.
  function gatherCategoryBalances() {
    return Promise.all([g.DB.getAll("rewardEntries"), g.Theming.getActiveTheme()])
      .then(function (r) {
        var balances = g.CompletionCore.balancesByCategory(r[0]);
        var themeId = r[1].id;
        return Object.keys(balances).sort().map(function (id) {
          var display = g.ThemeCore.resolveCategoryDisplay(themeId, id);
          return { categoryId: id, themeDisplayName: display.label, balance: balances[id] };
        });
      });
  }

  // Classic Blob + <a download> — works on the Android WebView this app
  // targets (CLAUDE.md); the modern File System Access API's save-with-cancel
  // semantics are desktop-only and unavailable here. This is the closest thing
  // to an observable "save succeeded" signal on this platform: if constructing
  // the blob and dispatching the download doesn't throw, we treat it as success.
  function triggerDownload(filename, text, mimeType) {
    var blob = new Blob([text], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // FR-4: all-or-nothing. exported flags are only flipped after the CSV
  // download has been triggered without throwing (§ triggerDownload's note on
  // what "succeeded" can mean on this platform).
  function exportCompletions() {
    return gatherEligible().then(function (gathered) {
      if (gathered.rows.length === 0) return { ok: true, empty: true };

      var stamp = g.DateUtil.filenameTimestamp();
      var slug = C.buildChildSlug(gathered.childName);
      var csvName = "completions_" + slug + "_" + stamp + ".csv";
      var noteName = "recovery_" + slug + "_" + stamp + ".txt";

      try {
        triggerDownload(csvName, C.toCsv(gathered.rows), "text/csv;charset=utf-8");
      } catch (e) {
        return { ok: false };
      }

      var flipped = gathered.includedRecords.map(function (rec) {
        return Object.assign({}, rec, { exported: true });
      });

      return g.DB.putMany("activityRecords", flipped).then(function () {
        // FR-8: the recovery note is independent — its failure never blocks
        // the CSV export or unmarks the exported flags already written above.
        return Promise.all([g.DB.getSingleton("streak"), gatherCategoryBalances()])
          .then(function (r) {
            var streak = r[0] || { currentStreak: 0 };
            var noteText = C.buildRecoveryNote(g.DateUtil.today(), streak.currentStreak, r[1]);
            var noteOk = true;
            try {
              triggerDownload(noteName, noteText, "text/plain;charset=utf-8");
            } catch (e) {
              noteOk = false;
            }
            return { ok: true, empty: false, count: gathered.rows.length, noteOk: noteOk };
          })
          .catch(function () {
            return { ok: true, empty: false, count: gathered.rows.length, noteOk: false };
          });
      });
    });
  }

  // `reminderState` used to sit beside this — the FR-7 end-of-week nudge, a
  // derived "7+ days since the last export with work outstanding". Removed with
  // the banner it fed (planner-ui.js): Module 8's retirement repealed the
  // reminder when completions moved to POST /api/completions, and nothing else
  // ever called it. Export itself is untouched and stays manual, from the Menu.
  g.Export = { exportCompletions: exportCompletions };
})(typeof window !== "undefined" ? window : globalThis);
