// pin-core.js — salted PIN hashing and lockout bookkeeping for the Wall App.
// Mirrors nothing (TDS_Slice_Wall_Display_App.md §11 table) — the wall is the
// only surface with a PIN. PURE aside from crypto.subtle, which has no DOM and
// no network dependency, so this loads and runs the same under `node --test`
// (TDS §12 items 7-8) as it does on the tablet.
//
// What the PIN protects, stated once so no caller has to guess (TDS §4.4): a
// sibling tapping the wrong tile, not an attacker with developer tools. Salted
// SHA-256 over a 4-digit space is brute-forceable in milliseconds by anyone who
// has already got that far — this is a deterrent, not a security boundary.

(function (g) {
  "use strict";

  var LOCKOUT_THRESHOLD = 5;
  var LOCKOUT_MS = 60 * 1000;

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  function randomSalt() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toHex(bytes.buffer);
  }

  function hashPin(pin, salt) {
    var data = new TextEncoder().encode(salt + ":" + pin);
    return crypto.subtle.digest("SHA-256", data).then(toHex);
  }

  // { salt, hash } for a freshly-set PIN — store.js persists this on the
  // record keyed by childId (§3.4).
  function createPinRecord(pin) {
    var salt = randomSalt();
    return hashPin(pin, salt).then(function (hash) {
      return { pinSalt: salt, pinHash: hash };
    });
  }

  function verifyPin(pin, record) {
    if (!record || !record.pinSalt || !record.pinHash) return Promise.resolve(false);
    return hashPin(pin, record.pinSalt).then(function (hash) {
      return hash === record.pinHash;
    });
  }

  // §4.6 — a roster entry with no PIN set yet is gated, not open. Never read
  // as "no PIN required": the caller must show "Ask a parent to set a PIN"
  // rather than skipping the pad.
  function hasPin(record) {
    return !!(record && record.pinSalt && record.pinHash);
  }

  // §4.3 — five consecutive wrong entries locks that child's tile for 60s.
  // The counter and the lockout live on the same record store.js persists, so
  // closing and reopening the browser does not clear it.
  function isLocked(record, now) {
    return !!(record && record.lockedUntil && record.lockedUntil > (now == null ? Date.now() : now));
  }

  function recordFailure(record, now) {
    var t = now == null ? Date.now() : now;
    var failCount = ((record && record.failCount) || 0) + 1;
    var lockedUntil = (record && record.lockedUntil) || null;
    if (failCount >= LOCKOUT_THRESHOLD) {
      lockedUntil = t + LOCKOUT_MS;
    }
    return Object.assign({}, record, { failCount: failCount, lockedUntil: lockedUntil });
  }

  function recordSuccess(record) {
    return Object.assign({}, record, { failCount: 0, lockedUntil: null });
  }

  g.PinCore = {
    LOCKOUT_THRESHOLD: LOCKOUT_THRESHOLD,
    LOCKOUT_MS: LOCKOUT_MS,
    randomSalt: randomSalt,
    hashPin: hashPin,
    createPinRecord: createPinRecord,
    verifyPin: verifyPin,
    hasPin: hasPin,
    isLocked: isLocked,
    recordFailure: recordFailure,
    recordSuccess: recordSuccess,
  };
})(typeof window !== "undefined" ? window : globalThis);
