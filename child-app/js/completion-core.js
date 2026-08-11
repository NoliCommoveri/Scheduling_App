// completion-core.js — pure logic for Activity/Chore Completion (Module 4) and
// the Reward Ledger's earn/balance mechanics (Module 6-earn), TDS_Slice_M2 §3/§4
// as amended by TDS_Slice_Online_Revamp.md §3.4/§8.1.
// No IndexedDB access here — same discipline as planner-core.js/assignment-core.js,
// so record shapes and balance math can be tested directly against fixtures.

(function (g) {
  "use strict";

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

  // ---- the reward ledger (Module 6-earn; Online Revamp §3.4, §8.1) ----
  //
  // One append-only store of signed entries, in the same vocabulary the server
  // ledger uses (§3.4): { id, assignmentId, category, amount, reason, earnedAt,
  // date }. Balance is a fold over the entries and is never stored.
  //
  // What this replaced, and why. Until the §8.1 collapse the device kept two
  // stores: a `rewardLedgerSnapshot` row per category holding a running balance,
  // and a `rewardLedgerTail` of entries not yet folded into it, compacted every
  // 100 entries. That fold existed for one reason — stopping the tail growing
  // without bound in IndexedDB on a budget Android phone. §3.4 repealed it for
  // D1 because SQLite is indifferent to tens of thousands of rows, and §8.1
  // repeals it here for a closely related reason: a child earning roughly one
  // entry per completed item takes years to reach a size IndexedDB notices,
  // while a snapshot is a lossy checkpoint that can never be audited back to the
  // entries it folded. The old shape also carried its sign in a `type` field and
  // the new one carries it in `amount`, which is what lets a balance be a sum.
  //
  // The entry id is minted at the write site, before the row is stored, and the
  // same id is what the outbox uploads (§5.5). Local row and server row are
  // therefore the same row, not two constructions that happen to agree.

  function mintEntryId() {
    if (g.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
    // Same fallback shape outbox.js and packet.js use: unique enough to be a
    // primary key, and it is only ever compared for equality (§5.5).
    return "rw-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // The one place the stored shape is written, so an earn, a spend and a repair
  // adjustment cannot drift apart. `amount` arrives already signed — §3.4's
  // ledger holds the sign in the amount rather than deriving it from a type.
  // `reason` uses the server's enum ('earned' | 'spend' | 'adjustment') so the
  // stored row needs no translation on its way to `buildRewardOp`.
  function buildEntry(id, category, amount, reason, date, at, assignmentId) {
    return {
      id: id,
      assignmentId: assignmentId || null,
      category: category,
      amount: amount,
      reason: reason,
      earnedAt: typeof at === "number" ? at : Date.now(),
      // Device-local calendar day. Not derivable from `earnedAt` without
      // re-deriving the local date, and the recovery note wants the day the
      // child would recognise, so it is stored rather than recomputed. The
      // server has no column for it — this field is local-only.
      date: date
    };
  }

  // TDS §3 step 2 / Online Revamp §7: the earn entry, amount independent of grade.
  //
  // `amount` is an optional override for the flat 1. §7 has the earned amount
  // come from the assignment row's snapshotted `reward_amount`, so that a later
  // edit to a tier cannot retroactively change what was already earned. The
  // Management App has no per-tier amount to snapshot yet (§14), so packet.js
  // leaves that column NULL and every row falls through to the flat 1 this
  // module has always used — nothing changes today, and the day a parent can set
  // an amount, this is already the path it travels.
  function buildEarnEntry(id, categoryId, today, sourceId, amount, at) {
    var value = typeof amount === "number" && isFinite(amount) ? amount : 1;
    return buildEntry(id, categoryId, value, "earned", today, at, sourceId);
  }

  // Ledger order: `earnedAt` ascending, `id` as a deterministic tiebreak for two
  // entries written inside the same millisecond. This is the order the server
  // reads its own ledger in (§3.4's `earned_at`), so both ends fold one sequence.
  // The old store got its order free from an autoincrement key; a client-minted
  // UUID carries no order, so it has to be stated.
  function sortEntries(entries) {
    return (entries || []).slice().sort(function (a, b) {
      var at = typeof a.earnedAt === "number" ? a.earnedAt : 0;
      var bt = typeof b.earnedAt === "number" ? b.earnedAt : 0;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
  }

  // Balance for one category's entries: an ordered, per-step zero-floored sum.
  // Every read — the display, the spend ceiling, the adjust preview, the
  // recovery note — goes through this one function, so none of them can disagree
  // about what a category is worth.
  //
  // Order-sensitive at the floor, deliberately: 30, then a -50 adjustment
  // (floors to 0), then a +10 earn gives 10, not 0. A plain sum would give -10
  // and a max(0, sum) would give 0; neither matches the locked product rule that
  // a child has no negative or "owed" state (Roadmap §8, deferred-by-decision).
  //
  // KNOWN DIVERGENCE: §3.4's server-side balance is a plain `SUM(amount)` with
  // no floor, so a ledger holding an adjustment large enough to drive a category
  // negative reads lower on the server than on the device. Nothing reconciles
  // the two today — §7's "the server's SUM is authoritative on reconnect"
  // describes an intent no code implements — so the divergence is latent, not
  // active, and it predates this collapse rather than arriving with it. Left as
  // found: deciding which end is right is a product call, not a refactor.
  function balanceOf(entries) {
    var balance = 0;
    sortEntries(entries).forEach(function (entry) {
      balance = Math.max(0, balance + (typeof entry.amount === "number" ? entry.amount : 0));
    });
    return balance;
  }

  // Every category the child has ever had an entry in, folded. The categories
  // come from the entries themselves — there is no longer a separate per-category
  // row that could go out of step with them, which is exactly what the snapshot
  // store was and exactly how it could go wrong.
  function balancesByCategory(entries) {
    var byCategory = Object.create(null);
    (entries || []).forEach(function (entry) {
      if (!entry || !entry.category) return;
      (byCategory[entry.category] = byCategory[entry.category] || []).push(entry);
    });
    var out = Object.create(null);
    Object.keys(byCategory).forEach(function (category) {
      out[category] = balanceOf(byCategory[category]);
    });
    return out;
  }

  g.CompletionCore = {
    validateGrade: validateGrade,
    buildActivityRecord: buildActivityRecord,
    mintEntryId: mintEntryId,
    buildEntry: buildEntry,
    buildEarnEntry: buildEarnEntry,
    sortEntries: sortEntries,
    balanceOf: balanceOf,
    balancesByCategory: balancesByCategory
  };
})(typeof window !== "undefined" ? window : globalThis);
