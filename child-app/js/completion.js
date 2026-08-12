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
    // §5.3: only sent when a note was actually given — a blank note at
    // completion time is "nothing to say," not a write of empty string.
    if (typeof record.note === "string") fields.completionNote = record.note;
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
  //
  // Child Feedback Loop §5.3: `rawNote` is validated unconditionally (unlike
  // grade, it is never gated on capturesGrade — every completion may carry
  // one).
  function completeItem(item, rawGrade, rawNote) {
    return g.DB.get("activityRecords", item.id).then(function (existing) {
      if (existing) return { ok: true, alreadyDone: true };

      var grade;
      if (item.capturesGrade) {
        var v = C.validateGrade(rawGrade);
        if (!v.ok) return { ok: false, gradeError: v.message };
        grade = v.grade;
      }

      var noteResult = C.validateNote(rawNote);
      if (!noteResult.ok) return { ok: false, noteError: noteResult.message };
      var note = noteResult.note;

      var today = g.DateUtil.today();
      var at = Date.now();
      var record = C.buildActivityRecord(item.id, today, grade, note);
      // Minted before the row is stored, let alone sent, so the local entry and
      // the uploaded one are the same entry (§5.5).
      //
      // §7: both values come off the assignment row as snapshotted at assign
      // time, so a later edit to a tier never changes what was already earned.
      // `reward_amount` is NULL today — packet.js has no per-tier number to
      // snapshot — which buildEarnEntry reads as the flat 1 the Child App has
      // always used. (§14 phase 2: these were read as `rewardCategoryId` /
      // `rewardAmount` until assignment-core stopped minting aliases.)
      var earn = C.buildEarnEntry(C.mintEntryId(), item.reward_category, today, item.id, item.reward_amount, at);

      return g.DB.put("activityRecords", record)
        .then(function () { return g.DB.put("rewardEntries", earn); })
        .then(function () { return queueUpload(item, record, earn, at); })
        .then(notifyStreak)
        .then(function () { return { ok: true, alreadyDone: false }; });
    });
  }

  // Child Feedback Loop TDS §3.3 — reverses everything completeItem granted,
  // in the same action: the reward is clawed back and the streak advance
  // (§3.4) is walked back. With both reversals intact, Undo needs no parent
  // PIN (§0.1) — there is nothing left to bank, so there is nothing to game.
  function undoItem(item) {
    return g.DB.get("activityRecords", item.id).then(function (existing) {
      // Only a live 'complete' row can be undone. A 'waived' row is left
      // untouched — no Undo button is rendered for one either (§3.2), and
      // SRS Module 5 already frames a waive as not undoable.
      if (!existing || existing.status !== "complete") return { ok: false };

      var today = g.DateUtil.today();
      var at = Date.now();
      // Recomputed from the assignment row's own snapshotted values, not
      // looked up from the original ledger entry, so it can never disagree
      // with what was actually earned (§3.3 step 2).
      var amount = typeof item.reward_amount === "number" && isFinite(item.reward_amount) ? item.reward_amount : 1;
      var reversal = C.buildEntry(C.mintEntryId(), item.reward_category, -amount, "adjustment", today, at, item.id);

      return g.DB.del("activityRecords", item.id)
        .then(function () { return g.DB.put("rewardEntries", reversal); })
        .then(function () {
          // completionNote cleared alongside grade — §3.3 step 4 deferred this
          // until §5 landed; it now has.
          return g.Outbox.enqueueCompletion(item.id, {
            status: "pending", completedAt: null, grade: null, completionNote: null
          });
        })
        .then(function () { return g.Outbox.enqueueReward(reversal); })
        .then(notifyStreakUndo)
        .then(function () { return { ok: true }; });
    });
  }

  // Not notifyStreak()/recheckToday() — that path only ever advances a
  // streak and never retracts one, so it would be a no-op in this direction
  // (§3.4). Streak (Module 7) may not be loaded in every context this file
  // runs in, same guard as notifyStreak above.
  function notifyStreakUndo() {
    if (g.Streak && typeof g.Streak.undoToday === "function") return g.Streak.undoToday();
    return Promise.resolve();
  }

  // Child Feedback Loop §5.3 — the note is editable after the fact from the
  // Completed view, unlike grade: an always-writable child-owned column, not
  // a write-once field. Same shape as completeItem/undoItem: guard, local
  // write, enqueue.
  //
  // Blank clears an existing note — a real write of NULL, same rule §4.2/
  // outbox-core.js already applies to every other completion field — rather
  // than "leave whatever was there," which validateNote's blank-is-absent
  // reading would otherwise imply for a fresh completion.
  function updateNote(item, rawNote) {
    return g.DB.get("activityRecords", item.id).then(function (existing) {
      if (!existing || existing.status !== "complete") return { ok: false };

      var v = C.validateNote(rawNote);
      if (!v.ok) return { ok: false, noteError: v.message };

      var updated = Object.assign({}, existing);
      if (typeof v.note === "string") updated.note = v.note;
      else delete updated.note;

      return g.DB.put("activityRecords", updated)
        .then(function () {
          return g.Outbox.enqueueCompletion(item.id, {
            completionNote: typeof v.note === "string" ? v.note : null
          });
        })
        .then(function () { return { ok: true }; });
    });
  }

  g.Completion = { completeItem: completeItem, undoItem: undoItem, updateNote: updateNote };
})(typeof window !== "undefined" ? window : globalThis);
