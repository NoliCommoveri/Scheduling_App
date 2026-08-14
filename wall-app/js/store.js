// store.js — localStorage only (TDS_Slice_Wall_Display_App.md §3.4). No
// IndexedDB, no outbox, no packet: the wall holds four keys and nothing else.
//
//   wall.token         — the one household-scoped bearer credential
//   wall.pins          — [{ childId, pinSalt, pinHash, failCount, lockedUntil }]
//   wall.settings       — { adminPinSalt, adminPinHash, dimStartHour, dimEndHour, shellVersion, timeFormat }
//   wall.pendingEarns   — [{ id, childId, assignmentId, category, amount, reason, earnedAt, attempts }]
//
// A child's PIN row survives archive/un-archive (§3.3) because nothing here
// ever deletes a row except an explicit reset — the roster, not this store,
// decides who is currently shown.

(function (g) {
  "use strict";

  var KEY_TOKEN = "wall.token";
  var KEY_PINS = "wall.pins";
  var KEY_SETTINGS = "wall.settings";
  var KEY_PENDING_EARNS = "wall.pendingEarns";

  var DEFAULT_SETTINGS = {
    adminPinSalt: null,
    adminPinHash: null,
    dimStartHour: 21,
    dimEndHour: 6,
    shellVersion: null,
    timeFormat: "24h", // §11.3 — '24h' | '12h'. Absent on an installed tablet's
                        // stored object; this merge (getSettings, below) is
                        // the whole migration.
  };

  function readJson(key, fallback) {
    var raw = localStorage.getItem(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // ---- token --------------------------------------------------------------

  function getToken() {
    return localStorage.getItem(KEY_TOKEN);
  }

  function setToken(token) {
    localStorage.setItem(KEY_TOKEN, token);
  }

  // Unpair: forgets the credential only. PINs and settings survive, so
  // re-pairing (§3.2's "This display has been unpaired" screen) restores the
  // whole tablet rather than starting over.
  function clearToken() {
    localStorage.removeItem(KEY_TOKEN);
  }

  // ---- PINs -----------------------------------------------------------------

  function getPins() {
    return readJson(KEY_PINS, []);
  }

  function getPinRecord(childId) {
    return getPins().find(function (r) { return r.childId === childId; }) || null;
  }

  function setPinRecord(childId, patch) {
    var pins = getPins();
    var existing = pins.find(function (r) { return r.childId === childId; });
    var next = Object.assign(
      { childId: childId, pinSalt: null, pinHash: null, failCount: 0, lockedUntil: null },
      existing,
      patch
    );
    var out = pins.filter(function (r) { return r.childId !== childId; });
    out.push(next);
    writeJson(KEY_PINS, out);
    return next;
  }

  // Admin-only reset (settings-ui.js) — clears the PIN but keeps the child's
  // row so a fresh setPinRecord call finds no stale lockout state next time.
  function resetPinRecord(childId) {
    setPinRecord(childId, { pinSalt: null, pinHash: null, failCount: 0, lockedUntil: null });
  }

  // ---- settings -------------------------------------------------------------

  function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, readJson(KEY_SETTINGS, {}));
  }

  function setSettings(patch) {
    var next = Object.assign(getSettings(), patch);
    writeJson(KEY_SETTINGS, next);
    return next;
  }

  // ---- pending earns (§6.2 — the only retry queue in the app) --------------

  function getPendingEarns() {
    return readJson(KEY_PENDING_EARNS, []);
  }

  function setPendingEarns(list) {
    writeJson(KEY_PENDING_EARNS, list);
  }

  g.Store = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    getPins: getPins,
    getPinRecord: getPinRecord,
    setPinRecord: setPinRecord,
    resetPinRecord: resetPinRecord,
    getSettings: getSettings,
    setSettings: setSettings,
    getPendingEarns: getPendingEarns,
    setPendingEarns: setPendingEarns,
  };
})(typeof window !== "undefined" ? window : globalThis);
