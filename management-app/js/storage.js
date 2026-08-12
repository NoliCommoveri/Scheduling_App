/* Module: storage.js — managementAppDB schema, open/seed.
 * Per TDS_Slice_M4_Management_App_Rev3.md §2, TDS_Slice_M5_Management_App_Rev7.md §2,
 * TDS_Slice_M7_Management_App_Rev1.md §2 (v3: pacingProfiles + generationLog),
 * and TDS_Slice_D1_Sync_Management_App.md §2 (v4: syncOutbox + write capture). */

const Storage = (() => {
  const DB_NAME = 'managementAppDB';
  const DB_VERSION = 4;

  const ACTIVITY_TYPE_SEED = [
    { activityTypeKey: 'quiz', label: 'Quiz', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'test', label: 'Test', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'project', label: 'Project', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'report', label: 'Report', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'pdf', label: 'PDF', capturePattern: 'grade-optional', structurePattern: 'page-range' },
    { activityTypeKey: 'drill', label: 'Drill', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'workbook', label: 'Workbook', capturePattern: 'grade-optional', structurePattern: 'count' },
    { activityTypeKey: 'video', label: 'Video', capturePattern: 'no-capture', structurePattern: 'count' },
    { activityTypeKey: 'practice-level', label: 'Practice Level', capturePattern: 'no-capture', structurePattern: 'count' },
    { activityTypeKey: 'reading-pages', label: 'Reading Pages', capturePattern: 'no-capture', structurePattern: 'page-range' },
  ];

  const TIER_SEED = [
    { tierId: 'D01', label: 'Easy', order: 0, rewardCategoryId: 'R01' },
    { tierId: 'D02', label: 'Medium', order: 1, rewardCategoryId: 'R02' },
    { tierId: 'D03', label: 'Hard', order: 2, rewardCategoryId: 'R03' },
    { tierId: 'D04', label: 'Very Hard', order: 3, rewardCategoryId: 'R04' },
  ];

  const REWARD_CATEGORY_SEED = [
    { categoryId: 'R01', internalLabel: 'Easy' },
    { categoryId: 'R02', internalLabel: 'Medium' },
    { categoryId: 'R03', internalLabel: 'Hard' },
    { categoryId: 'R04', internalLabel: 'Very Hard' },
  ];

  // Declared now, empty until their owning milestone (Q6 — TDS §1/§2), so no
  // future milestone needs an IndexedDB version bump. `pacingProfiles` and
  // `generationLog` are NOT here: M7 (§2) owns their keyPaths/indexes and
  // creates them in the v3 block below, not as generic keyPath:'id' stores.
  const EMPTY_STORES = [
    'courses', 'lessons', 'activities', 'children',
    'chores', 'familyEvents', 'importedCompletions', 'unmatchedRows',
  ];

  // Owned by the v3 upgrade (TDS_Slice_M7 §2) — non-'id' keyPaths + indexes.
  const V3_STORES = ['pacingProfiles', 'generationLog'];

  const STORE_NAMES = [
    'appSettings', 'meta', 'curricula', 'tiers', 'rewardCategories', 'activityTypes',
    ...EMPTY_STORES, ...V3_STORES,
  ];

  // The D1 mirror's outbox (TDS_Slice_D1_Sync §2). Deliberately NOT in
  // STORE_NAMES: that list drives restoreFromCloud/factoryReset's target set, and clearing the
  // outbox would silently drop changes that have not reached D1 yet.
  const OUTBOX_STORE = 'syncOutbox';

  // Never mirrored (TDS_Slice_D1_Sync §1.2, SRS Module 11 §2.3): appSettings
  // holds the launchPin and the sync token — device-local credentials, not
  // authored content. The outbox never mirrors itself.
  const SYNC_EXCLUDED = new Set(['appSettings', OUTBOX_STORE]);

  let dbPromise = null;
  const commitListeners = new Set();

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          db.createObjectStore('appSettings');
          const meta = db.createObjectStore('meta');
          const curricula = db.createObjectStore('curricula', { keyPath: 'id' });
          const tiers = db.createObjectStore('tiers', { keyPath: 'tierId' });
          const rewardCategories = db.createObjectStore('rewardCategories', { keyPath: 'categoryId' });
          const activityTypes = db.createObjectStore('activityTypes', { keyPath: 'activityTypeKey' });
          for (const storeName of EMPTY_STORES) db.createObjectStore(storeName, { keyPath: 'id' });

          // Seed — inside this same onupgradeneeded transaction, atomic with
          // store creation, and never re-runs (v1 seeds exactly once).
          // Four tiers seeded (D01-D04) per SRS Module 02 FR-1 — nextSeq starts at 5.
          meta.put({ nextSeq: 5 }, 'idCounters');
          for (const tier of TIER_SEED) tiers.put(tier);
          for (const cat of REWARD_CATEGORY_SEED) rewardCategories.put(cat);
          for (const type of ACTIVITY_TYPE_SEED) activityTypes.put(type);
          void curricula; // no seed data; store exists for FR-1 create/read
        }

        if (oldVersion < 2) {
          // Indexes only — no store is added, removed, or reshaped at v2
          // (TDS_Slice_M5 §2). Fetched via the versionchange transaction so
          // this runs identically whether the stores were just created above
          // (fresh install) or already existed (a device upgrading from v1).
          const activities = tx.objectStore('activities');
          activities.createIndex('by_lessonId', 'lessonId');
          activities.createIndex('by_activityType', 'activityType');
          activities.createIndex('by_difficultyTier', 'difficultyTier');

          const lessons = tx.objectStore('lessons');
          lessons.createIndex('by_courseId', 'courseId');

          const courses = tx.objectStore('courses');
          courses.createIndex('by_curriculumId', 'curriculumId');
          courses.createIndex('by_childId', 'childId');
          // Deliberately NOT unique — courseCode uniqueness is scoped to
          // state:"template" only; two Instances stamped from one template
          // legitimately share it (TDS_Slice_M5 §2 — "this one is a trap").
          courses.createIndex('by_courseCode', 'courseCode');

          // Backfill the fourth tier on a device that already ran M4's
          // three-tier seed. A fresh install (oldVersion 0) already seeded
          // four tiers above and nextSeq is already 5, so this only fires
          // for oldVersion === 1. Guarded on the counter, not on D04's
          // absence: nextSeq === 4 proves nothing has ever been minted, so
          // D04 is unclaimed; nextSeq > 4 means the parent already minted
          // their own tier as D04 and it must not be overwritten.
          if (oldVersion === 1) {
            const metaStore = tx.objectStore('meta');
            const tiersStore = tx.objectStore('tiers');
            const rewardCategoriesStore = tx.objectStore('rewardCategories');
            metaStore.get('idCounters').onsuccess = (e) => {
              const current = e.target.result;
              if (current && current.nextSeq === 4) {
                tiersStore.get('D04').onsuccess = (e2) => {
                  if (!e2.target.result) {
                    tiersStore.put({ tierId: 'D04', label: 'Very Hard', order: 3, rewardCategoryId: 'R04' });
                    rewardCategoriesStore.put({ categoryId: 'R04', internalLabel: 'Very Hard' });
                    metaStore.put({ nextSeq: 5 }, 'idCounters');
                  }
                };
              }
              // nextSeq > 4: parent already minted a custom D04 — write nothing.
            };
          }
        }

        if (oldVersion < 3) {
          // TDS_Slice_M7 §2: own pacingProfiles/generationLog with their real
          // keyPaths + indexes. Both are guaranteed empty (declared empty at
          // M4, never written through M6), so drop-and-recreate is lossless.
          // Guard on contains(): a v1/v2 device created these as keyPath:'id'
          // placeholders and must have them dropped first; a fresh install
          // (oldVersion 0) never created them here, so it only creates.
          for (const name of V3_STORES) {
            if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
          }
          // 1:1 with the Instance — fetched only by get(instanceId); no index.
          db.createObjectStore('pacingProfiles', { keyPath: 'instanceId' });
          // One row per (child, item) decision; put() over the composite key
          // makes reproduction idempotent (TDS §1/§4.4).
          const generationLog = db.createObjectStore('generationLog', {
            keyPath: ['childId', 'itemId'],
          });
          generationLog.createIndex('by_child', 'childId');
          generationLog.createIndex('by_instance', 'instanceId');
        }

        if (oldVersion < 4) {
          // TDS_Slice_D1_Sync §2 — one store added, nothing existing reshaped.
          // Rows are appended in the same transaction as the data write they
          // describe (§1.6), so `seq` doubles as push order.
          db.createObjectStore(OUTBOX_STORE, { keyPath: 'seq', autoIncrement: true });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function get(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllByIndex(storeName, indexName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // put/del route through runTransaction so mirror capture has exactly one
  // code path (TDS_Slice_D1_Sync §1.4) — there is no way to write to this
  // database that bypasses the outbox.
  async function put(storeName, value, key) {
    let result;
    await runTransaction([storeName], 'readwrite', (t) => {
      const req = t.objectStore(storeName).put(value, key);
      req.onsuccess = () => { result = req.result; };
    });
    return result;
  }

  async function del(storeName, key) {
    await runTransaction([storeName], 'readwrite', (t) => {
      t.objectStore(storeName).delete(key);
    });
  }

  // ---- D1 mirror write capture (TDS_Slice_D1_Sync §1.4–§1.6, §3) ----

  // Derives the record's IndexedDB key from the live store's own keyPath, so
  // this needs no hardcoded store→keyPath table and cannot drift as the
  // schema grows (§3.2). Handles all three key shapes in the schema: string
  // keyPath, array keyPath (generationLog), and out-of-line (meta).
  function deriveKey(store, value, explicitKey) {
    const keyPath = store.keyPath;
    if (keyPath === null || keyPath === undefined) return explicitKey;
    if (Array.isArray(keyPath)) return keyPath.map((p) => value[p]);
    return value[keyPath];
  }

  // A silently wrong mirror is worse than a loud gap (§3.3).
  function serializeKey(key, storeName, op) {
    if (key === undefined || key === null) {
      console.warn(`[sync] ${op} on "${storeName}" with no derivable key — not mirrored.`);
      return null;
    }
    if (typeof IDBKeyRange !== 'undefined' && key instanceof IDBKeyRange) {
      console.warn(`[sync] ${op} on "${storeName}" by key range — not mirrored.`);
      return null;
    }
    try {
      return JSON.stringify(key);
    } catch {
      console.warn(`[sync] ${op} on "${storeName}" with unserializable key — not mirrored.`);
      return null;
    }
  }

  // Intercepts put/delete at the moment they are invoked, not by inspecting
  // the worker's arguments up front — several existing transaction workers
  // issue writes from inside onsuccess callbacks (§1.5).
  function wrapStore(realStore, outboxStore, captured) {
    if (SYNC_EXCLUDED.has(realStore.name)) return realStore;

    const record = (op, key, value) => {
      const serialized = serializeKey(key, realStore.name, op);
      if (serialized === null) return;
      outboxStore.add({
        store: realStore.name,
        key: serialized,
        op,
        value: op === 'put' ? value : null,
        ts: Date.now(),
      });
      captured.count += 1;
    };

    return new Proxy(realStore, {
      get(target, prop) {
        if (prop === 'put') {
          return (value, key) => {
            record('put', deriveKey(target, value, key), value);
            return target.put(value, key);
          };
        }
        if (prop === 'delete') {
          return (key) => {
            record('delete', key, null);
            return target.delete(key);
          };
        }
        const value = Reflect.get(target, prop, target);
        // Bind to the real store: IDB methods reject a Proxy as `this`.
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  function wrapTransaction(realTx, captured) {
    const outboxStore = realTx.objectStore(OUTBOX_STORE);
    const cache = new Map();
    return new Proxy(realTx, {
      get(target, prop) {
        if (prop === 'objectStore') {
          return (name) => {
            if (!cache.has(name)) {
              cache.set(name, wrapStore(target.objectStore(name), outboxStore, captured));
            }
            return cache.get(name);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  // For multi-store atomic writes (e.g. minting a tier + category + counter
  // in one transaction). `worker(tx)` must issue all its requests
  // synchronously against `tx.objectStore(...)` before returning — do not
  // await inside it, or the IDB transaction auto-commits early.
  //
  // On readwrite transactions the outbox store is appended to `storeNames` so
  // mirror rows commit atomically with the data they describe (§1.6): an
  // aborted transaction discards its outbox rows too, and a crash can never
  // land a write that the mirror never hears about.
  async function runTransaction(storeNames, mode, worker, options = {}) {
    const db = await openDB();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const capture = mode === 'readwrite' && options.captureForSync !== false;
    const effectiveNames = capture ? [...names, OUTBOX_STORE] : names;

    const captured = { count: 0 };
    const result = await new Promise((resolve, reject) => {
      const t = db.transaction(effectiveNames, mode);
      let workerResult;
      t.oncomplete = () => resolve(workerResult);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      try {
        workerResult = worker(capture ? wrapTransaction(t, captured) : t);
      } catch (err) {
        reject(err);
      }
    });

    // Fire only after the commit actually landed. Listeners are advisory —
    // a throwing listener must never fail the write that triggered it.
    if (captured.count > 0) {
      for (const listener of commitListeners) {
        try {
          listener(captured.count);
        } catch (err) {
          console.warn('[sync] commit listener failed:', err);
        }
      }
    }

    return result;
  }

  // Registered by sync.js to schedule a drain after a captured write.
  function onCommit(listener) {
    commitListeners.add(listener);
    return () => commitListeners.delete(listener);
  }

  // Re-applies the same tiers/rewardCategories/activityTypes/idCounters seed
  // that a fresh install gets from onupgradeneeded's v1 block above — but as
  // ordinary put()s through runTransaction, not a versionchange transaction,
  // so it can run any time the DB already exists (e.g. after Settings →
  // Database "Reset everything" empties those stores without bumping
  // DB_VERSION, which means onupgradeneeded never fires again to reseed
  // them). Captured to the outbox like any other write, so the reseed syncs
  // back up to D1 on the next drain.
  async function seedDefaults() {
    await runTransaction(['meta', 'tiers', 'rewardCategories', 'activityTypes'], 'readwrite', (t) => {
      t.objectStore('meta').put({ nextSeq: 5 }, 'idCounters');
      for (const tier of TIER_SEED) t.objectStore('tiers').put(tier);
      for (const cat of REWARD_CATEGORY_SEED) t.objectStore('rewardCategories').put(cat);
      for (const type of ACTIVITY_TYPE_SEED) t.objectStore('activityTypes').put(type);
    });
  }

  return {
    openDB, get, getAll, getAllByIndex, put, del, runTransaction,
    onCommit, seedDefaults, STORE_NAMES, OUTBOX_STORE, SYNC_EXCLUDED,
  };
})();
