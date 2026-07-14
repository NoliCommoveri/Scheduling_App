// reward.js — Reward Economy display + spend (Module 6), wired to IndexedDB.
// TDS_Slice_M3 §4/§5. Mirrors deferment.js's split: this file owns DB access,
// the PIN check, and the fold trigger; reward-core.js owns the pure math.

(function (g) {
  "use strict";

  var C = g.CompletionCore;
  var R = g.RewardCore;

  // FR-1/FR-2: every category the child has ever earned into (union of the
  // snapshot and any tail-only categories), theme-skinned, balance via the
  // single shared fold (CompletionCore.foldBalance — TDS §4/§10).
  function gatherBalances(themeId) {
    return Promise.all([g.DB.getAll("rewardLedgerSnapshot"), g.DB.getAll("rewardLedgerTail")])
      .then(function (r) {
        var snapshots = Object.create(null);
        r[0].forEach(function (s) { snapshots[s.categoryId] = s; });
        var tailByCategory = Object.create(null);
        r[1].forEach(function (t) {
          (tailByCategory[t.categoryId] = tailByCategory[t.categoryId] || []).push(t);
        });
        var categoryIds = Object.create(null);
        Object.keys(snapshots).forEach(function (id) { categoryIds[id] = true; });
        Object.keys(tailByCategory).forEach(function (id) { categoryIds[id] = true; });
        return Object.keys(categoryIds).sort().map(function (id) {
          var balance = C.foldBalance(snapshots[id], tailByCategory[id] || []);
          var display = g.ThemeCore.resolveCategoryDisplay(themeId, id);
          return { categoryId: id, balance: balance, label: display.label, icon: display.icon };
        });
      });
  }

  // One current-balance read for a single category — used by the spend
  // ceiling check so it reads the exact same fold the display shows.
  function currentBalance(categoryId) {
    return Promise.all([g.DB.get("rewardLedgerSnapshot", categoryId), g.DB.getAll("rewardLedgerTail")])
      .then(function (r) {
        var tailForCategory = r[1].filter(function (e) { return e.categoryId === categoryId; });
        return C.foldBalance(r[0], tailForCategory);
      });
  }

  // FR-3: completions this week + a read-only streak reference, never
  // merged with the category balances (AC-3).
  function gatherCompletionCount() {
    return g.DB.getAll("activityRecords").then(function (all) {
      return R.completionsThisWeek(all, g.DateUtil.today());
    });
  }

  function gatherDisplay() {
    return g.Theming.getActiveTheme().then(function (theme) {
      return Promise.all([gatherBalances(theme.id), gatherCompletionCount(), g.DB.getSingleton("streak")])
        .then(function (r) {
          var streak = r[2] || { currentStreak: 0 };
          return { theme: theme, categories: r[0], completionsThisWeek: r[1], currentStreak: streak.currentStreak };
        });
    });
  }

  // FR-4: PIN checked before the spend screen is reachable at all (enforced
  // by the caller gating entry) and again here before any write — same
  // discipline as deferment.js's withPin.
  function spend(categoryId, rawAmount, enteredPin) {
    return g.DB.getSingleton("child").then(function (child) {
      if (!g.DefermentCore.checkPin(enteredPin, child && child.pin)) return { ok: false, pinError: true };

      var v = R.validateSpendAmount(rawAmount);
      if (!v.ok) return { ok: false, amountError: v.message };

      return currentBalance(categoryId).then(function (balance) {
        if (!R.checkSpendCeiling(v.amount, balance)) return { ok: false, ceilingError: true, balance: balance };

        var today = g.DateUtil.today();
        var entry = R.buildSpendEntry(categoryId, v.amount, today);
        return g.DB.put("rewardLedgerTail", entry)
          .then(function () { return g.Completion.foldIfDue(categoryId, today); })
          .then(function () { return { ok: true }; });
      });
    });
  }

  g.Reward = { gatherDisplay: gatherDisplay, spend: spend };
})(typeof window !== "undefined" ? window : globalThis);
