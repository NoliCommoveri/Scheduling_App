/* Module: sync.js — Cloudflare D1 curriculum backup, client side.
 * Per TDS_Slice_D1_Sync_Management_App.md §6, as narrowed by
 * TDS_Slice_Online_Revamp.md §3.1.
 *
 * ROLE CHANGED 2026-08-10. This file used to be described as a mirror behind an
 * offline-first app whose IndexedDB was the source of truth. That is no longer
 * the architecture: D1 is the system of record for the project. What this file
 * still does, unchanged, is back up the *parent's curriculum authoring stores*
 * as opaque blobs in `records` — courses, lessons, activities, tiers and the
 * rest, which only this app interprets.
 *
 * It does NOT carry assignments, completions, or reward entries. Those are
 * relational tables written through their own endpoints (Revamp §3.3-§3.6).
 *
 * Still non-blocking by design: nothing here is awaited by an authoring path,
 * so a dropped network grows the outbox instead of failing a write.
 *
 * KNOWN GAP, load-bearing: the outbox only captures writes made AFTER a sync
 * token is set. Anything authored before that never reached D1 -- this is what
 * cost Ray a curriculum. There is deliberately no backfill (Revamp §12): the
 * data is already gone, so authoring restarts on the new system instead.
 *
 * Practical consequence: set the sync token BEFORE authoring anything, and
 * verify against /api/sync/status that it actually landed.
 */

const Sync = (() => {
  const OUTBOX = 'syncOutbox';
  const BATCH_SIZE = 200;
  const DEBOUNCE_MS = 1500;
  const BACKOFF_START_MS = 2000;
  const BACKOFF_MAX_MS = 5 * 60 * 1000;
  const SNAPSHOT_PAGE = 2000;

  // Device-local settings, stored alongside launchPin in appSettings, which
  // is never mirrored (TDS §1.2) — so the token cannot leak into D1.
  const SETTINGS_KEY = 'appSettings';

  let draining = false;
  let drainQueued = false;
  let debounceTimer = null;
  let retryTimer = null;
  let backoffMs = BACKOFF_START_MS;

  const state = {
    enabled: false,
    pending: 0,
    lastSyncedAt: null,
    lastError: null,
    inFlight: false,
  };
  const listeners = new Set();

  // ---- config ----

  async function readSettings() {
    return (await Storage.get(SETTINGS_KEY, SETTINGS_KEY)) || {};
  }

  async function getConfig() {
    const settings = await readSettings();
    return {
      token: settings.syncToken || null,
      deviceId: settings.syncDeviceId || null,
      enabled: Boolean(settings.syncToken),
    };
  }

  async function setToken(token) {
    const settings = await readSettings();
    const next = { ...settings };
    if (token) {
      next.syncToken = token;
      if (!next.syncDeviceId) next.syncDeviceId = mintDeviceId();
    } else {
      delete next.syncToken;
    }
    await Storage.put(SETTINGS_KEY, next, SETTINGS_KEY);
    state.enabled = Boolean(token);
    state.lastError = null;
    emit();
    if (token) scheduleDrain(0);
  }

  function mintDeviceId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ---- HTTP ----

  async function api(path, { method = 'GET', body } = {}) {
    const { token } = await getConfig();
    if (!token) throw new Error('Sync is not configured on this device.');

    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) throw new Error('Sync token rejected by the server.');
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = await response.json();
        if (parsed && parsed.error) detail = parsed.error;
      } catch { /* non-JSON error body — keep the status line */ }
      throw new Error(detail);
    }
    return response.json();
  }

  // ---- outbox ----

  async function readOutboxBatch(limit) {
    const db = await Storage.openDB();
    return new Promise((resolve, reject) => {
      const rows = [];
      const req = db.transaction(OUTBOX, 'readonly').objectStore(OUTBOX).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || rows.length >= limit) return resolve(rows);
        rows.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function countOutbox() {
    const db = await Storage.openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(OUTBOX, 'readonly').objectStore(OUTBOX).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteOutboxRows(seqs) {
    // captureForSync: false — clearing the outbox must not write new outbox
    // rows, which would make the drain loop self-perpetuating.
    await Storage.runTransaction([OUTBOX], 'readwrite', (t) => {
      const store = t.objectStore(OUTBOX);
      for (const seq of seqs) store.delete(seq);
    }, { captureForSync: false });
  }

  // ---- drain ----

  function scheduleDrain(delay = DEBOUNCE_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { drain(); }, delay);
  }

  async function drain() {
    if (draining) { drainQueued = true; return; }

    const { enabled } = await getConfig();
    state.enabled = enabled;
    if (!enabled) { state.pending = await countOutbox(); emit(); return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      state.pending = await countOutbox();
      emit();
      return;
    }

    draining = true;
    state.inFlight = true;
    emit();

    try {
      const { deviceId } = await getConfig();

      for (;;) {
        const rows = await readOutboxBatch(BATCH_SIZE);
        if (rows.length === 0) break;

        await api('/api/sync/push', {
          method: 'POST',
          body: {
            deviceId,
            changes: rows.map((r) => ({ store: r.store, key: r.key, op: r.op, value: r.value, ts: r.ts })),
          },
        });

        // Delete only after a 2xx. A dropped response re-pushes the same
        // batch next drain, which the server's upsert makes harmless (§5).
        await deleteOutboxRows(rows.map((r) => r.seq));
      }

      state.lastSyncedAt = Date.now();
      state.lastError = null;
      backoffMs = BACKOFF_START_MS;
      clearTimeout(retryTimer);
    } catch (err) {
      state.lastError = String((err && err.message) || err);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { drain(); }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } finally {
      draining = false;
      state.inFlight = false;
      state.pending = await countOutbox();
      emit();
      if (drainQueued) { drainQueued = false; scheduleDrain(0); }
    }
  }

  // ---- restore (TDS §1.9) ----

  async function fetchSnapshot() {
    const records = [];
    for (let offset = 0; ; offset += SNAPSHOT_PAGE) {
      const page = await api(`/api/sync/snapshot?limit=${SNAPSHOT_PAGE}&offset=${offset}`);
      records.push(...page.records);
      if (page.records.length < SNAPSHOT_PAGE) break;
    }
    return records;
  }

  // Full replace of every in-scope store, matching SRS Module 11 §2.4/FR-7.
  // appSettings is never touched, so this device keeps its own launchPin.
  async function restoreFromCloud() {
    const records = await fetchSnapshot();

    const byStore = new Map();
    for (const record of records) {
      if (Storage.SYNC_EXCLUDED.has(record.store)) continue;
      if (!byStore.has(record.store)) byStore.set(record.store, []);
      byStore.get(record.store).push(record);
    }

    const targetStores = Storage.STORE_NAMES.filter((name) => !Storage.SYNC_EXCLUDED.has(name));

    // captureForSync: false — a restore is D1's own content coming back;
    // re-pushing it would be pure churn.
    await Storage.runTransaction(targetStores, 'readwrite', (t) => {
      for (const storeName of targetStores) {
        const store = t.objectStore(storeName);
        store.clear();
        for (const record of byStore.get(storeName) || []) {
          // Out-of-line stores (meta) need the key passed back explicitly;
          // in-line stores carry it inside the value already (§3.2).
          if (store.keyPath === null || store.keyPath === undefined) {
            store.put(record.value, JSON.parse(record.key));
          } else {
            store.put(record.value);
          }
        }
      }
    }, { captureForSync: false });

    // The outbox described the pre-restore state; keeping it would push stale
    // records back over the data we just pulled down.
    await Storage.runTransaction([OUTBOX], 'readwrite', (t) => {
      t.objectStore(OUTBOX).clear();
    }, { captureForSync: false });

    state.pending = 0;
    state.lastSyncedAt = Date.now();
    emit();
    return { restored: records.length, stores: byStore.size };
  }

  async function status() {
    return api('/api/sync/status');
  }

  // ---- observable state ----

  function emit() {
    for (const listener of listeners) {
      try {
        listener({ ...state });
      } catch (err) {
        console.warn('[sync] listener failed:', err);
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
  }

  function getState() {
    return { ...state };
  }

  // ---- lifecycle ----

  async function init() {
    const { enabled } = await getConfig();
    state.enabled = enabled;
    state.pending = await countOutbox();
    emit();

    Storage.onCommit(() => scheduleDrain());
    window.addEventListener('online', () => scheduleDrain(0));

    if (enabled) scheduleDrain(0);
  }

  // `api` is exported so migrations.js can call §5.3a with the parent
  // credential without storing or re-deriving the token a second time. It is
  // the only sanctioned way to reach a parent endpoint from another module.
  return {
    init, drain, subscribe, getState, getConfig, setToken,
    restoreFromCloud, status, countOutbox, api,
  };
})();
