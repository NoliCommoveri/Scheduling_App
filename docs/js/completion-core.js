// completion-core.js — pure logic for Activity/Chore Completion (Module 4) and
// the Reward Ledger's earn/fold mechanics (Module 6-earn), TDS_Slice_M2 §3/§4.
// No IndexedDB access here — same discipline as merge-core.js/planner-core.js,
// so record shapes and fold math can be tested directly against fixtures.

(function (g) {
  "use strict";

  var FOLD_THRESHOLD = 100; // TDS_Slice_M2 §4 — locked, see CLAUDE.md §III.D.

  // Grade: whole number 0-100, or absent. Blank/undefined input is valid (skip
  // the grade). Returns { ok:true, grade: number|undefined } or { ok:false, message }.
  function validateGrade(raw) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, grade: undefined };
    var n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, message: "Grade must be a whole number from 0 to 100." };
    }
    return { ok: true, grade: n };
  }

  // TDS §3 FR-5: exactly { activityId, date, status:'complete', exported:false, grade? }.
  // grade is present only when provided — never null, never a blank placeholder.
  function buildActivityRecord(activityId, today, grade) {
    var rec = { activityId: activityId, date: today, status: "complete", exported: false };
    if (typeof grade === "number") rec.grade = grade;
    return rec;
  }

  // TDS §3 step 2: the flat-earn tail entry, amount always 1 regardless of grade.
  function buildEarnEntry(categoryId, today, sourceId) {
    return { type: "earn", categoryId: categoryId, amount: 1, date: today, sourceId: sourceId };
  }

  // Signed contribution of one tail entry (TDS §4). Only 'earn' is ever written
  // in M2 scope; 'spend'/'adjust' are M3/M11 writers, but this must already hold
  // for them once they exist.
  function signedAmount(entry) {
    if (entry.type === "earn") return entry.amount;
    if (entry.type === "spend") return -entry.amount;
    if (entry.type === "adjust") return entry.amount;
    return 0;
  }

  // The single balance function (TDS_Slice_M3 §4/§10): the ordered, per-step
  // zero-floored fold of the tail onto the snapshot, in ascending `id` order
  // (chronological — `id` is the autoIncrement key). Both the fold (below) and
  // the display/spend-ceiling/adjust-preview/recovery-note reads share this
  // exact function so they can never disagree about a category's balance.
  // Order-sensitive at the floor: 30, then -50 adjust (floors to 0), then +10
  // earn -> 10, not 0 — a plain max(0, sum) would wrongly yield 0.
  function foldBalance(existingSnapshot, tailEntries) {
    var balance = existingSnapshot ? existingSnapshot.balance : 0;
    var sorted = tailEntries.slice().sort(function (a, b) { return a.id - b.id; });
    sorted.forEach(function (entry) {
      balance = Math.max(0, balance + signedAmount(entry));
    });
    return balance;
  }

  // Fold plan for one category's tail into its snapshot (TDS §4, steps 1-4).
  // existingSnapshot may be null/undefined (category's first-ever earn).
  // tailEntries: every rewardLedgerTail row currently stored for this categoryId.
  // Returns { snapshot, deleteIds } — deleteIds are the tail rows' own `id` keys.
  function foldPlan(categoryId, existingSnapshot, tailEntries, today) {
    return {
      snapshot: { categoryId: categoryId, balance: foldBalance(existingSnapshot, tailEntries), asOfDate: today },
      deleteIds: tailEntries.map(function (e) { return e.id; })
    };
  }

  // Display-time balance read (TDS_Slice_M3 §4): the same ordered, per-step
  // floored fold foldPlan uses — on an earn-only tail this equals M2's original
  // plain snapshot + sum(tail), so nothing that was already correct changes.
  // Read-only, never stored. Used by Module 6's display, the spend ceiling
  // check, Module 11's adjust preview, and Module 8's recovery note.
  function readBalance(existingSnapshot, tailEntries) {
    return foldBalance(existingSnapshot, tailEntries);
  }

  g.CompletionCore = {
    FOLD_THRESHOLD: FOLD_THRESHOLD,
    validateGrade: validateGrade,
    buildActivityRecord: buildActivityRecord,
    buildEarnEntry: buildEarnEntry,
    foldPlan: foldPlan,
    foldBalance: foldBalance,
    readBalance: readBalance
  };
})(typeof window !== "undefined" ? window : globalThis);
