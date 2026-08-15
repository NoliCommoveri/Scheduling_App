// store.js — localStorage only (TDS_Slice_Wall_Display_App.md §3.4). No
// IndexedDB, no outbox, no packet: the wall holds four keys and nothing else.
//
//   wall.token         — the one household-scoped bearer credential
//   wall.settings       — { adminPinSalt, adminPinHash, dimStartHour, dimEndHour, shellVersion, timeFormat }
//   wall.pendingEarns   — [{ id, childId, assignmentId, category, amount, reason, earnedAt, attempts }]
//   wall.failedEarns    — [{ id, childId, assignmentId, category, amount, reason, at }]
//
// `wall.pins` — per-child PIN records — is RETIRED (Wall Calendar Redesign
// §0.4, §1.2). Per-child PIN gating was never built (Phase 4a of the
// superseded slice does not exist in the tree), so this is dead storage
// with no reader anywhere in the app, not a migration of live data.

(function (g) {
  "use strict";

  var KEY_TOKEN = "wall.token";
  var KEY_SETTINGS = "wall.settings";
  var KEY_PENDING_EARNS = "wall.pendingEarns";
  var KEY_FAILED_EARNS = "wall.failedEarns";

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

  // ---- failed earns (§6.2's `rejected` outcome — surfaced, not silently
  // dropped, so a permanently-refused entry stays visible to an admin
  // rather than vanishing from an append-only ledger with no trace) -------

  function getFailedEarns() {
    return readJson(KEY_FAILED_EARNS, []);
  }

  function setFailedEarns(list) {
    writeJson(KEY_FAILED_EARNS, list);
  }

  g.Store = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    getSettings: getSettings,
    setSettings: setSettings,
    getPendingEarns: getPendingEarns,
    setPendingEarns: setPendingEarns,
    getFailedEarns: getFailedEarns,
    setFailedEarns: setFailedEarns,
  };
})(typeof window !== "undefined" ? window : globalThis);
