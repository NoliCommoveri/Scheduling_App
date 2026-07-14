// export.js — Completion CSV Export (Module 8), wired to IndexedDB + file save.
// TDS_Slice_M2 §7. Mirrors the other DB-wiring files: export-core.js owns the
// pure row/CSV/note math; this file owns storage reads and the download trigger.

(function (g) {
  "use strict";

  var C = g.ExportCore;

  function loadSourceMaps() {
    return Promise.all([g.DB.getAll("activities"), g.DB.getAll("chores")]).then(function (r) {
      var activities = Object.create(null);
      r[0].forEach(function (a) { activities[a.id] = a; });
      var chores = Object.create(null);
      r[1].forEach(function (c) { chores[c.id] = c; });
      return { activities: activities, chores: chores };
    });
  }

  // Rows and the exact record objects they came from, kept in lockstep — a
  // record only gets flipped to exported if it actually produced a row.
  function gatherEligible() {
    return Promise.all([g.DB.getAll("activityRecords"), loadSourceMaps(), g.DB.getSingleton("child"), g.DB.getSingleton("semester")])
      .then(function (r) {
        var eligible = r[0].filter(C.isEligible);
        var sources = r[1];
        var child = r[2] || {};
        var semester = r[3] || {};
        var rows = [];
        var includedRecords = [];
        eligible.forEach(function (rec) {
          var isChore = !sources.activities[rec.activityId];
          var sourceItem = isChore ? sources.chores[rec.activityId] : sources.activities[rec.activityId];
          if (!sourceItem) return; // orphaned record — shouldn't happen by construction; skip defensively
          rows.push(C.buildRow(rec, sourceItem, isChore, child.name, semester.label));
          includedRecords.push(rec);
        });
        return { rows: rows, includedRecords: includedRecords, childName: child.name };
      });
  }

  // Category balances for the recovery note (TDS_Slice_M2 §7, closed by
  // TDS_Slice_M3 §9): union of every category in rewardLedgerSnapshot plus
  // any category with tail-only (unfolded) entries. themeDisplayName now
  // resolves through the active theme's mapping — the same generic-default
  // fallback the on-screen display uses (§4) — never the raw categoryId.
  function gatherCategoryBalances() {
    return Promise.all([g.DB.getAll("rewardLedgerSnapshot"), g.DB.getAll("rewardLedgerTail"), g.Theming.getActiveTheme()])
      .then(function (r) {
        var snapshots = Object.create(null);
        r[0].forEach(function (s) { snapshots[s.categoryId] = s; });
        var tailByCategory = Object.create(null);
        r[1].forEach(function (t) {
          (tailByCategory[t.categoryId] = tailByCategory[t.categoryId] || []).push(t);
        });
        var themeId = r[2].id;
        var categoryIds = Object.create(null);
        Object.keys(snapshots).forEach(function (id) { categoryIds[id] = true; });
        Object.keys(tailByCategory).forEach(function (id) { categoryIds[id] = true; });
        return Object.keys(categoryIds).sort().map(function (id) {
          var balance = g.CompletionCore.readBalance(snapshots[id], tailByCategory[id] || []);
          var display = g.ThemeCore.resolveCategoryDisplay(themeId, id);
          return { categoryId: id, themeDisplayName: display.label, balance: balance };
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

  // FR-7: end-of-week reminder. lastSuccessfulExportDate is derived, never
  // stored — max(date) over any exported:true record, or "never" if none.
  function reminderState() {
    return g.DB.getAll("activityRecords").then(function (all) {
      var eligibleCount = all.filter(C.isEligible).length;
      if (eligibleCount === 0) return { show: false };
      var exportedDates = all.filter(function (r) { return r.exported === true; }).map(function (r) { return r.date; }).sort();
      if (exportedDates.length === 0) return { show: true, eligibleCount: eligibleCount };
      var lastExport = exportedDates[exportedDates.length - 1];
      var days = g.DateUtil.daysBetween(lastExport, g.DateUtil.today());
      return { show: days >= 7, eligibleCount: eligibleCount };
    });
  }

  g.Export = { exportCompletions: exportCompletions, reminderState: reminderState };
})(typeof window !== "undefined" ? window : globalThis);
