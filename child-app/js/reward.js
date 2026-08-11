// reward.js — Reward Economy display + spend (Module 6), wired to IndexedDB.
// TDS_Slice_M3 §4/§5. Mirrors deferment.js's split: this file owns DB access,
// the PIN check, and the fold trigger; reward-core.js owns the pure math.

(function (g) {
  "use strict";

  var C = g.CompletionCore;
  var R = g.RewardCore;

  // FR-1/FR-2: every category the child has ever earned into, theme-skinned,
  // balance via the single shared fold (CompletionCore.balanceOf — TDS §4/§10,
  // Online Revamp §3.4). One store read now rather than two: since the §8.1
  // collapse the categories are whatever the entries mention, so there is no
  // union to take and no per-category row that could disagree with them.
  function gatherBalances(themeId) {
    return g.DB.getAll("rewardEntries").then(function (entries) {
      var balances = C.balancesByCategory(entries);
      return Object.keys(balances).sort().map(function (id) {
        var display = g.ThemeCore.resolveCategoryDisplay(themeId, id);
        return { categoryId: id, balance: balances[id], label: display.label, icon: display.icon };
      });
    });
  }

  // One current-balance read for a single category — used by the spend
  // ceiling check so it reads the exact same fold the display shows.
  function currentBalance(categoryId) {
    return g.DB.getAll("rewardEntries").then(function (entries) {
      return C.balanceOf(entries.filter(function (e) { return e.category === categoryId; }));
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
        var at = Date.now();
        // Online Revamp §3.4: the ledger is append-only and signed, so a spend
        // is a negative entry rather than a subtraction from a balance. Nothing
        // is ever decremented at either end; the balance is a fold.
        var entry = R.buildSpendEntry(C.mintEntryId(), categoryId, v.amount, today, at);
        return g.DB.put("rewardEntries", entry)
          .then(function () {
            if (!g.Outbox) return;
            return g.Outbox.enqueueReward(entry);
          })
          .then(function () { return { ok: true }; });
      });
    });
  }

  g.Reward = { gatherDisplay: gatherDisplay, spend: spend };
})(typeof window !== "undefined" ? window : globalThis);
