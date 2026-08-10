# Technical Design Specification — Slice

## Scope: Management App — Cloudflare D1 Durable Mirror & Sync

> ## ⚠️ SUPERSEDED — 2026-08-10, later the same day, by `TDS_Slice_Online_Revamp.md`.
>
> This slice's central claim — *"IndexedDB remains the source of truth; offline-first is
> preserved in full"* (§0, §1) — **no longer holds.** D1 is now the system of record for
> the whole project, not a mirror behind it.
>
> **What survives:** the `records` table, the outbox drain, the push/snapshot/status
> endpoints, and the deployment shape. Its role narrows to backing up *parent curriculum
> authoring stores only* (Revamp §3.1). Everything a child is assigned or produces lives in
> relational tables instead (Revamp §3.3–§3.6).
>
> **What does not survive:** §0's amendment table, which narrowed the offline-first
> constraint rather than repealing it. Read Revamp §0 instead.
>
> **Known gap this slice left open, and its cost:** the outbox only ever captured writes made
> *after* sync was enabled, so curriculum authored before that never reached D1. This is what
> lost Ray a curriculum. No backfill is planned (Revamp §12) — the data is gone, and authoring
> restarts on the new system. Set the token *before* authoring, and verify it landed.

**Status:** Authored 2026-08-10. Superseded the same day (see above).
**Applies to:** `management-app/` only. The Child App is untouched by this slice.

---

## 0. Revision note — what this slice changes about locked decisions

This slice deliberately amends three previously LOCKED items. It does not repeal them;
it narrows them to the Child App and to the Management App's *read/write path*.

| Locked item | Prior statement | Amended statement |
|---|---|---|
| §III.A "No network calls during normal app operation" | Absolute, both apps | Holds for the Child App absolutely. For the Management App, network is used **only** by the background mirror, which is non-blocking and failure-tolerant. No read or write in the app waits on it. |
| §X "Offline-first guarantee — LOCKED — All" | Absolute, both apps | **Preserved in full.** IndexedDB remains the source of truth for the Management App. The app functions identically with the network unplugged; the mirror simply queues. |
| §X "Single vs. multi-file layout / GitHub Pages deployment" | Management App on GitHub Pages | Management App moves to Cloudflare Workers static assets so the app and its API are same-origin. Still vanilla JS, still no build step. Child App stays on GitHub Pages. |

Roadmap principles 1 ("zero-cost development") and 2 ("zero-cost maintenance") are
preserved — Cloudflare D1 and Workers are used within their free tier. Principle 3
("no required server") is **narrowed**: the server is required for *durability*, never
for *operation*.

```
[DECISION] Cloudflare D1 role for the Management App
Decided: Durable auto-sync mirror. IndexedDB stays the source of truth.
Rationale: The stated problem is data loss, not multi-device access. A mirror
  solves loss without surrendering offline-first, without an auth/user model,
  and without rewriting 135 storage call sites. A source-of-truth migration
  would have broken offline operation outright for no gain against the goal.
Locked for: this slice and forward, until a multi-device requirement appears.
```

---

## 1. Decided here (TDS-level calls)

**1.1 — The mirror is structural, not an entity list.** The D1 table stores
`(store, key) -> JSON`, mirroring IndexedDB generically. This is the same scoping
principle Module 11 §2.2 already established for backup ("everything in Management App
storage except the App Settings record"), and it means a future milestone adding a new
object store is mirrored automatically, with no D1 migration and no edit to this slice.

**1.2 — `appSettings` is never mirrored.** SRS Module 11 §2.3 excludes the `launchPin`
from backup as a device-local credential. The same rule applies here, for the same
reason, and it is what makes it safe to store the sync token in `appSettings` (§4.1).

**1.3 — `meta` *is* mirrored.** `idCounters.nextSeq` is authored state. A restore that
omitted it would remint `D05`/`R05` over an ID already in use. It is in scope.

**1.4 — Write capture happens at the `Storage` layer, never at call sites.** All 19
`runTransaction` sites and all direct `put`/`del` calls stay byte-for-byte unchanged.
`storage.js` wraps the `IDBTransaction` handed to each `worker(tx)` and intercepts
`put`/`delete` on the object stores it hands out.

**1.5 — Capture must be live, not by argument pre-scan.** Several existing transaction
workers issue writes from *inside* `onsuccess` callbacks — `tiers.createTier` (mints IDs
from `meta` then writes), `children.deleteInstance` (cascades from `getAllKeys`), and
`packet.js` generation (flips `excludeFromGeneration` after a `get`). A wrapper that
only inspected the worker's synchronous arguments would silently miss all three. The
proxy therefore records at the moment `put`/`delete` is actually invoked.

**1.6 — Outbox rows are written in the *same* IndexedDB transaction as the data.**
`runTransaction` appends `syncOutbox` to the caller's `storeNames` list for `readwrite`
transactions. Recording mirror-intent atomically with the data write closes the gap
where a crash between commit and a follow-up outbox write would drop a record from the
mirror forever. An aborted transaction discards its outbox rows with everything else.

**1.7 — Last-write-wins on `(store, key)`, ordered by client sequence.** There is one
authoring device by design (Architecture Evaluation §3: "authoritative data on the
parent device"). Conflict resolution beyond LWW would be a workflow engine the
Architecture Evaluation's principles 15/16 warn against. Rows are pushed in `seq` order.

**1.8 — Deletes are tombstoned, not removed.** A deleted record is kept with
`deleted = 1`. A hard delete would let a stale device silently resurrect it on its next
push, and it makes `since`-based pull correct without a separate deletion log.

**1.9 — Restore is full-replace and explicitly confirmed.** Pulling the cloud snapshot
onto a device wholesale-replaces every in-scope store, matching Module 11 §2.4/FR-7
exactly. It is destructive, so it is gated behind a typed confirmation, and it never
touches `appSettings` (§1.2).

---

## 2. IndexedDB schema — v3 → v4

One store is added. Nothing existing is reshaped, reindexed, or dropped.

```js
// v4
syncOutbox: { keyPath: 'seq', autoIncrement: true }
```

| Field | Type | Notes |
|---|---|---|
| `seq` | integer | Auto-increment. Push order; monotonic per device. |
| `store` | string | Source object store name. |
| `key` | string | `JSON.stringify` of the IndexedDB key (§3.1). |
| `op` | `'put' \| 'delete'` | |
| `value` | object \| null | The record for `put`; `null` for `delete`. |
| `ts` | integer | `Date.now()` at capture. |

`syncOutbox` is itself never mirrored.

---

## 3. Key handling

**3.1 — Serialization.** Every IndexedDB key becomes text via `JSON.stringify`, giving
one uniform `key` column across three different key shapes already in the schema:

| Shape | Example store | IDB key | Mirrored `key` |
|---|---|---|---|
| In-line, string keyPath | `courses` (`id`) | `'C0007'` | `"C0007"` |
| In-line, array keyPath | `generationLog` (`['childId','itemId']`) | `['CH01','A0042']` | `["CH01","A0042"]` |
| Out-of-line | `meta` | `'idCounters'` | `"idCounters"` |

**3.2 — Key derivation on `put`.** The wrapper reads `store.keyPath` from the live
`IDBObjectStore`, so it needs no hardcoded table of store→keyPath and cannot drift as
the schema grows:

- `keyPath` is a string → `value[keyPath]`
- `keyPath` is an array → `keyPath.map(p => value[p])`
- `keyPath` is `null` (out-of-line) → the explicit second argument to `put`

**3.3 — Unsupported key forms.** `delete(IDBKeyRange)` is not used anywhere in the
current code. If one is ever passed, the wrapper records nothing for it and logs a
console warning rather than guessing a key — a silently wrong mirror is worse than a
loud gap.

---

## 4. D1 schema

```sql
CREATE TABLE IF NOT EXISTS records (
  store      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT,                        -- JSON; NULL when deleted = 1
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,            -- server receipt time, ms
  device_id  TEXT,
  PRIMARY KEY (store, key)
);
CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records (updated_at);
```

**4.1 — Auth.** A single shared secret, held as the Worker secret `SYNC_TOKEN` and sent
by the client as `Authorization: Bearer <token>`. Compared in constant time. The client
copy lives in `appSettings`, which §1.2 guarantees is never mirrored. This is deliberately
not a user/account system: the app serves one family on one authoring device, and an
account model would be a larger surface than the thing it protects.

---

## 5. HTTP API (same-origin, `/api/*`)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `POST` | `/api/sync/push` | `{ deviceId, changes: [{ store, key, op, value, ts }] }` | `{ applied, serverTime }` |
| `GET` | `/api/sync/snapshot` | — | `{ records: [{ store, key, value }], count, serverTime }` |
| `GET` | `/api/sync/status` | — | `{ count, lastUpdatedAt, serverTime }` |

All three require auth (§4.1) and return `401` without it. `push` is idempotent: it
upserts by `(store, key)`, so a retried batch after a dropped response is harmless.
`snapshot` returns live rows only (`deleted = 0`).

---

## 6. Client sync engine (`js/sync.js`)

- **Trigger:** debounced ~1.5 s after any captured write; also on app load, on the
  `online` event, and on a periodic retry timer.
- **Drain:** read `syncOutbox` in `seq` order, push in batches of 200, delete the pushed
  rows only after a `2xx`. A failed push leaves the outbox intact and backs off
  (2 s → 4 s → 8 s → … capped at 5 min).
- **Non-blocking:** no app path ever awaits the network. Sync failure degrades to
  "pending count rises," never to a blocked or errored write.
- **Restore:** `snapshot` → confirm → full-replace of in-scope stores (§1.9).

---

## 7. Deployment

```
management-app/
  wrangler.toml          # Worker + assets + D1 binding
  .assetsignore          # keeps worker source out of the public asset bundle
  worker/index.js        # API + static asset fallthrough
  worker/schema.sql      # §4 DDL
  index.html, js/, styles/
```

`run_worker_first = ["/api/*"]` routes the API to the Worker; every other path is
served from static assets.

---

## 8. Acceptance checks (build-session verifiable)

1. With the network disabled, every existing authoring flow works unchanged, and the
   pending-change count rises. Re-enabling the network drains it to zero unattended.
2. `tiers.createTier` (writes from inside `onsuccess`) produces mirror rows for all
   three of `tiers`, `rewardCategories`, and `meta`.
3. `children.deleteInstance` (cascade keys from `getAllKeys`) produces `delete` rows for
   every cascaded Activity, not just the Course.
4. An aborted transaction produces **no** outbox rows.
5. `generationLog`'s composite key round-trips: push, snapshot, restore, and the record
   is retrievable by `['childId','itemId']`.
6. `appSettings` never appears in D1, before or after a restore.
7. A restore onto an empty browser reproduces the full authored corpus, and the
   device's own `launchPin` is unchanged.
