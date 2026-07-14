// settings.js — Settings (Module 11), wired to IndexedDB. TDS_Slice_M3 §6/§7.
// Mirrors deferment.js's split: this file owns DB access and the PIN check;
// settings-core.js owns the pure validation math. FR-0's gate (checkEntryPin)
// is called once by the UI before the Settings screen renders at all — every
// other function here assumes that gate has already passed, same as the
// repair form needing no second PIN prompt of its own (TDS §6).

(function (g) {
  "use strict";

  var C = g.SettingsCore;

  function checkEntryPin(enteredPin) {
    return g.DB.getSingleton("child").then(function (child) {
      return g.DefermentCore.checkPin(enteredPin, child && child.pin);
    });
  }

  // FR-1: updates `name` on the Child singleton, leaving `pin` intact.
  function updateName(rawName) {
    var v = C.validateName(rawName);
    if (!v.ok) return Promise.resolve({ ok: false, message: v.message });
    return g.DB.getSingleton("child").then(function (child) {
      return g.DB.putSingleton("child", Object.assign({}, child, { name: v.name }));
    }).then(function () { return { ok: true, name: v.name }; });
  }

  // FR-2: updates `label` on the Semester singleton — a passthrough display
  // value only (§2.1); no other behavior changes as a result.
  function updateSemesterLabel(rawLabel) {
    var v = C.validateSemesterLabel(rawLabel);
    if (!v.ok) return Promise.resolve({ ok: false, message: v.message });
    return g.DB.getSingleton("semester").then(function (semester) {
      return g.DB.putSingleton("semester", Object.assign({}, semester, { label: v.label }));
    }).then(function () { return { ok: true, label: v.label }; });
  }

  // FR-3: requires the *current* PIN entered correctly a second time (beyond
  // the entry gate) before any write; a wrong current PIN aborts with no
  // partial effect. On success the new PIN immediately gates every surface.
  function changePin(currentPinEntered, newPin, newPin2) {
    return g.DB.getSingleton("child").then(function (child) {
      if (!g.DefermentCore.checkPin(currentPinEntered, child && child.pin)) {
        return { ok: false, currentPinError: true };
      }
      var v = C.validateNewPin(newPin, newPin2);
      if (!v.ok) return { ok: false, newPinError: v.message };
      return g.DB.putSingleton("child", Object.assign({}, child, { pin: v.pin }))
        .then(function () { return { ok: true }; });
    });
  }

  // FR-7a: appends one 'adjust' entry and runs the same fold check earn/spend
  // use (Module 6, TDS §5/§10) — no special-cased fold path for corrections.
  // A negative adjust that would go below zero is written as entered and
  // floored only at fold/read time (§4), never rejected here.
  function adjustBalance(categoryId, rawAmount) {
    var v = C.validateAdjustAmount(rawAmount);
    if (!v.ok) return Promise.resolve({ ok: false, message: v.message });
    var today = g.DateUtil.today();
    var entry = C.buildAdjustEntry(categoryId, v.amount, today);
    return g.DB.put("rewardLedgerTail", entry)
      .then(function () { return g.Completion.foldIfDue(categoryId, today); })
      .then(function () { return { ok: true }; });
  }

  // FR-7b: writes currentStreak and lastQualifyingDate together, defaulting
  // the date to device-local today (TDS §6) so the next on-open gap catch-up
  // doesn't immediately re-zero the restored value.
  function setStreak(rawStreak, rawDate) {
    var v = C.validateStreakValue(rawStreak);
    if (!v.ok) return Promise.resolve({ ok: false, message: v.message });
    var d = C.resolveRepairDate(rawDate, g.DateUtil.today());
    if (!d.ok) return Promise.resolve({ ok: false, message: d.message });
    return g.DB.putSingleton("streak", { currentStreak: v.value, lastQualifyingDate: d.date })
      .then(function () { return { ok: true }; });
  }

  g.Settings = {
    checkEntryPin: checkEntryPin,
    updateName: updateName,
    updateSemesterLabel: updateSemesterLabel,
    changePin: changePin,
    adjustBalance: adjustBalance,
    setStreak: setStreak
  };
})(typeof window !== "undefined" ? window : globalThis);
