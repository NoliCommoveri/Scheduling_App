// completion.js — Activity & Chore Completion (Module 4) + Reward Ledger earn/fold
// (Module 6-earn), wired to IndexedDB. TDS_Slice_M2 §3/§4/§9.
// Mirrors the importer.js/merge-core.js split: this file owns DB access and the
// cross-module trigger point; completion-core.js owns the pure record/fold math.
//
// Online Revamp Phase 4 (§5.5, §7): a completion now also queues an upload of
// the child-owned columns and its reward entry. The local writes above are
// unchanged and still happen first — the queue is a consequence of the write,
// never a precondition for it (§8.4).

(function (g) {
  "use strict";

  var C = g.CompletionCore;

  // Every enqueue is a no-op on an unpaired device or a packet-imported item
  // (outbox.js decides which), so no caller here has to know whether this
  // device is online, linked, or reading from a file.
  //
  // The earn entry is handed over as-is rather than rebuilt: since the §8.1
  // collapse the row stored in `rewardEntries` is already in the server's shape,
  // carrying the id that makes the append idempotent (§5.5). Uploading a
  // reconstruction would give the server a different id for the same earning.
  function queueUpload(item, record, earn, at) {
    if (!g.Outbox) return Promise.resolve();
    var fields = { status: record.status, completedAt: at };
    if (typeof record.grade === "number") fields.grade = record.grade;
    return g.Outbox.enqueueCompletion(item.id, fields).then(function () {
      return g.Outbox.enqueueReward(earn);
    });
  }

  // TDS §9: "Module 4 writes activityRecords and the reward ledger, and triggers
  // Module 7's live check." Streak (Module 7) is a later build phase; until it
  // defines Streak.recheckToday, this is a no-op — Module 4 never has to change
  // when Module 7 lands. Always returns a promise so the caller's own promise
  // doesn't resolve until the streak recheck has actually finished (this is
  // still "one logical operation" per TDS §3, even though it's several writes).
  function notifyStreak() {
    if (g.Streak && typeof g.Streak.recheckToday === "function") return g.Streak.recheckToday();
    return Promise.resolve();
  }

  // TDS §3: idempotency guard first (double-tap race — an already-resolved item
  // is a full no-op, never a double-earn), then grade validation gated on
  // capturesGrade (chores have no such field, treated as absent-equals-false,
  // SRS Module 4 FR-2), then the write path in order: record, earn entry,
  // streak trigger.
  //
  // The fold check that used to sit between the earn and the upload is gone with
  // the store it maintained (§8.1) — an append is now the whole of the write.
  function completeItem(item, rawGrade) {
    return g.DB.get("activityRecords", item.id).then(function (existing) {
      if (existing) return { ok: true, alreadyDone: true };

      var grade;
      if (item.capturesGrade) {
        var v = C.validateGrade(rawGrade);
        if (!v.ok) return { ok: false, gradeError: v.message };
        grade = v.grade;
      }

      var today = g.DateUtil.today();
      var at = Date.now();
      var record = C.buildActivityRecord(item.id, today, grade);
      // Minted before the row is stored, let alone sent, so the local entry and
      // the uploaded one are the same entry (§5.5).
      var earn = C.buildEarnEntry(C.mintEntryId(), item.rewardCategoryId, today, item.id, item.rewardAmount, at);

      return g.DB.put("activityRecords", record)
        .then(function () { return g.DB.put("rewardEntries", earn); })
        .then(function () { return queueUpload(item, record, earn, at); })
        .then(notifyStreak)
        .then(function () { return { ok: true, alreadyDone: false }; });
    });
  }

  g.Completion = { completeItem: completeItem };
})(typeof window !== "undefined" ? window : globalThis);
