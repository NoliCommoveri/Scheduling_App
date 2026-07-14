// reward-core.js — pure logic for Reward Economy display + spend (Module 6),
// TDS_Slice_M3 §4/§5. No IndexedDB access here — same discipline as the
// other -core.js modules. The balance fold itself lives in CompletionCore
// (single-sourced, TDS §4/§10) — this file owns only what's new at M3: the
// completion-count visual and the spend validation/write-shape.

(function (g) {
  "use strict";

  function localDateFromStr(s) {
    var p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function toDateStr(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // Sunday-Saturday week containing `todayStr`, on the same device-local
  // calendar-day boundary the Streak uses (Domain Model §3.8, §2 scope note).
  function weekBounds(todayStr) {
    var d = localDateFromStr(todayStr);
    var dow = d.getDay(); // 0 = Sunday
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return { start: toDateStr(start), end: toDateStr(end) };
  }

  // FR-3: completed Activities *and* Chores dated within the current week.
  // Waived records are not completions (§4) and are excluded.
  function completionsThisWeek(activityRecords, todayStr) {
    var w = weekBounds(todayStr);
    return activityRecords.filter(function (r) {
      return r.status === "complete" && r.date >= w.start && r.date <= w.end;
    }).length;
  }

  // Spend validation rule (Module 6 §5): whole number, greater than zero.
  function validateSpendAmount(raw) {
    var n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, message: "Enter a whole number greater than 0." };
    }
    return { ok: true, amount: n };
  }

  // Spend ceiling (Module 6 FR-4/AC-5, TDS §5): a spend exceeding the
  // category's currently displayed balance is refused outright.
  function checkSpendCeiling(amount, currentBalance) {
    return amount <= currentBalance;
  }

  // TDS §5: the exact tail-entry shape a spend writes.
  function buildSpendEntry(categoryId, amount, today) {
    return { type: "spend", categoryId: categoryId, amount: amount, date: today };
  }

  g.RewardCore = {
    weekBounds: weekBounds,
    completionsThisWeek: completionsThisWeek,
    validateSpendAmount: validateSpendAmount,
    checkSpendCeiling: checkSpendCeiling,
    buildSpendEntry: buildSpendEntry
  };
})(typeof window !== "undefined" ? window : globalThis);
