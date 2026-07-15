/* Module: storage.js — managementAppDB schema, open/seed.
 * Per TDS_Slice_M4_Management_App_Rev3.md §2 and TDS_Slice_M5_Management_App_Rev7.md §2. */

const Storage = (() => {
  const DB_NAME = 'managementAppDB';
  const DB_VERSION = 2;

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
  // future milestone needs an IndexedDB version bump.
  const EMPTY_STORES = [
    'courses', 'lessons', 'activities', 'children', 'pacingProfiles',
    'chores', 'familyEvents', 'generationLog', 'importedCompletions', 'unmatchedRows',
  ];

  const STORE_NAMES = [
    'appSettings', 'meta', 'curricula', 'tiers', 'rewardCategories', 'activityTypes',
    ...EMPTY_STORES,
  ];

  let dbPromise = null;

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

  async function put(storeName, value, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function del(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Dev/testing only — not part of any spec'd module. Empties one store
  // completely; does not re-seed it (seeding only ever runs in
  // onupgradeneeded, once, at v1).
  async function clearStore(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readwrite').objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // For multi-store atomic writes (e.g. minting a tier + category + counter
  // in one transaction). `worker(tx)` must issue all its requests
  // synchronously against `tx.objectStore(...)` before returning — do not
  // await inside it, or the IDB transaction auto-commits early.
  async function runTransaction(storeNames, mode, worker) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      try {
        result = worker(t);
      } catch (err) {
        reject(err);
      }
    });
  }

  return { openDB, get, getAll, getAllByIndex, put, del, runTransaction, clearStore, STORE_NAMES };
})();
