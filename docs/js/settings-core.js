// settings-core.js — pure logic for Settings (Module 11), TDS_Slice_M3 §6/§7.
// No IndexedDB access here — same discipline as the other -core.js modules.
// Name/semester/PIN rules mirror Module 1's Wizard exactly (SRS Module 11 §5).

(function (g) {
  "use strict";

  function validateName(raw) {
    var name = typeof raw === "string" ? raw.trim() : "";
    if (!name) return { ok: false, message: "Please enter a name." };
    if (name.length > 24) return { ok: false, message: "Keep it to 24 characters or fewer." };
    return { ok: true, name: name };
  }

  function validateSemesterLabel(raw) {
    var label = typeof raw === "string" ? raw.trim() : "";
    if (!label) return { ok: false, message: "Please enter a label." };
    if (label.length > 40) return { ok: false, message: "Keep it to 40 characters or fewer." };
    return { ok: true, label: label };
  }

  // FR-3: new PIN meets Module 1's rule (>=4 digits, numeric) and must match
  // its confirmation entry.
  function validateNewPin(pin, pin2) {
    if (!/^\d{4,}$/.test(pin || "")) return { ok: false, message: "Use at least 4 digits, numbers only." };
    if (pin !== pin2) return { ok: false, message: "The two PINs don't match." };
    return { ok: true, pin: pin };
  }

  // FR-7a: a signed whole number — any integer, including negative (the
  // floor is enforced at fold/read time, not here, per TDS §6's "written as
  // entered" rule).
  function validateAdjustAmount(raw) {
    var n = Number(raw);
    if (raw === "" || raw === null || raw === undefined || !Number.isInteger(n)) {
      return { ok: false, message: "Enter a whole number (positive or negative)." };
    }
    return { ok: true, amount: n };
  }

  // FR-7b: non-negative integer.
  function validateStreakValue(raw) {
    var n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, message: "Enter a non-negative whole number." };
    return { ok: true, value: n };
  }

  // FR-7b: lastQualifyingDate defaults to device-local today unless the
  // parent supplies another date — load-bearing so the next gap catch-up
  // doesn't immediately re-zero the restored value (TDS §6).
  function resolveRepairDate(raw, today) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, date: today };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, message: "Enter a valid date." };
    return { ok: true, date: raw };
  }

  // TDS §6: the exact tail-entry shape a repair adjust writes — identical
  // shape to a spend entry but type 'adjust', amount signed.
  function buildAdjustEntry(categoryId, amount, today) {
    return { type: "adjust", categoryId: categoryId, amount: amount, date: today };
  }

  g.SettingsCore = {
    validateName: validateName,
    validateSemesterLabel: validateSemesterLabel,
    validateNewPin: validateNewPin,
    validateAdjustAmount: validateAdjustAmount,
    validateStreakValue: validateStreakValue,
    resolveRepairDate: resolveRepairDate,
    buildAdjustEntry: buildAdjustEntry
  };
})(typeof window !== "undefined" ? window : globalThis);
