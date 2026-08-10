# Management App — Cloudflare deployment & D1 backup setup

One-time setup, ~10 minutes. Everything here stays inside Cloudflare's free tier.

Design and rationale: `docs/TDS_Slice_D1_Sync_Management_App.md`.

---

## What this gives you

Your data still lives in the browser's IndexedDB and the app still works with the
network unplugged. On top of that, **every write is copied to a Cloudflare D1
database automatically**, so a lost laptop, a cleared browser, or a wiped profile
no longer costs you your authored curriculum.

If the network is down, changes queue locally and upload themselves later. You
never have to remember to press anything.

---

## Part A — one-time resource setup

Steps 1–4 create the database and the secret. They run once. After that, every
deploy happens from GitHub on push (Part B).

**No local tooling is required.** Everything below is done in the Cloudflare
dashboard and by editing one file on GitHub. Wrangler runs inside Cloudflare's
build environment, not on your machine.

## 1. Create the D1 database

Dashboard: **Storage & Databases → D1 → Create database**. Name it
`homeschool-management`.

The database's overview page shows its **Database ID**. Copy it.

## 2. Point the config at it

Edit `management-app/wrangler.toml` on GitHub (pencil icon) and paste the ID over
`REPLACE_WITH_YOUR_D1_DATABASE_ID`. Commit.

If you named the database something other than `homeschool-management`, change
`database_name` to match as well — both fields have to agree with the dashboard.

## 3. Create the table

Open the database, go to the **Console** tab, and run these two statements **one at
a time**:

```sql
CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, device_id TEXT, PRIMARY KEY (store, key));
```

```sql
CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records (updated_at);
```

(These are the same statements as `worker/schema.sql`, flattened for the console.)

Confirm it worked:

```sql
SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name;
```

You should see `records` and `idx_records_updated_at`.

## 4. Set your sync token

This is the only thing standing between the internet and your database, so
generate it rather than inventing one. Any password manager's generator works —
30+ random characters.

Add it to the Worker **after** its first deploy (Part B), under
**Settings → Variables and Secrets → Add**:

| Field | Value |
|---|---|
| Type | **Secret** (not Text) |
| Name | `SYNC_TOKEN` |
| Value | your generated string |

Adding a secret triggers a redeploy automatically.

**Keep a copy somewhere safe.** You need it again in step 6, and on every new
device.

> If `SYNC_TOKEN` is never set, the API denies every request. It fails closed on
> purpose — an unconfigured Worker is never an open one.

---

## Part B — deploying

Do this after steps 1–3, then come back and do step 4. The first deploy will
succeed but every API call returns `401` until `SYNC_TOKEN` exists — that is the
fail-closed behaviour, not a broken deploy.

**Use B1 unless you specifically want a local CLI.** B2 is an alternative, not a
prerequisite: nothing in this setup requires Wrangler on your own machine.

### B1. Push-to-deploy from GitHub (recommended)

Cloudflare builds and deploys straight from the repo on every push, the same shape
as a GitHub Pages deployment.

In the Cloudflare dashboard: **Workers & Pages → Create → Workers → Connect to Git**,
pick this repository, then set:

| Setting | Value |
|---|---|
| **Root directory** | `management-app` |
| Build command | *(leave empty — vanilla JS, no build step)* |
| Deploy command | `npx wrangler deploy` |
| Branch | `main` |

> **Workers, not Pages.** This is a Worker with static assets (`main` + `[assets]`)
> because it needs the D1 binding. A Cloudflare **Pages** project handles bindings
> differently and will not work with this config as written.

**Root directory is what scopes the deployment to just the management app.**
`wrangler.toml` lives in `management-app/`, and its `[assets] directory = "./"` is
resolved relative to that file — so `child-app/`, `docs/`, and `fixtures/` are never
uploaded. The Child App stays on GitHub Pages, untouched.

`SYNC_TOKEN` is a Worker secret, so it lives on the Worker, not in the repo, and
survives every Git-triggered deploy.

The `database_id` committed in `wrangler.toml` is an identifier, not a credential —
it is safe in the repo. Reaching the database still requires your Cloudflare account.

### B2. Deploy from a machine with Wrangler (optional)

```bash
cd management-app
wrangler deploy
```

Only if you want it. B1 covers the whole lifecycle on its own.

---

Either way, Cloudflare prints your URL, e.g.
`https://homeschool-management.<subdomain>.workers.dev`. That URL serves the
management app *and* its backup API from the same origin — no CORS, no second
deployment.

## 6. Connect the app

1. Open the deployed URL and unlock with your launch PIN.
2. Go to **Settings → Cloud backup**.
3. Paste the `SYNC_TOKEN` from step 4 and press **Save token**.

You should see `Connected. Cloud holds N record(s).` The status line then tracks
every change: `Up to date. Last synced: …`, or a pending count when offline.

---

## Restoring onto a new device or browser

1. Open the same deployed URL. Set a launch PIN (this device's own — it is never
   part of the backup, by design).
2. **Settings → Cloud backup**, paste the sync token, save.
3. Under **Restore from cloud**, type `RESTORE` and confirm.

This **replaces everything** in that browser with the cloud copy. Your launch PIN
is not affected.

---

## Verifying the backup independently

Confirm the data really is in D1, without trusting the app's own status line. In
the D1 **Console** tab:

```sql
SELECT store, COUNT(*) AS rows FROM records WHERE deleted = 0 GROUP BY store ORDER BY store;
```

Expect one row per populated object store — `activities`, `courses`, `lessons`,
`children`, and so on. `appSettings` must **never** appear: your launch PIN and
sync token are device-local and are deliberately excluded from the mirror.

---

## Things worth knowing

- **The Child App is untouched.** It stays on GitHub Pages, fully offline, exactly
  as before. This is a management-side change only.
- **Deletes are tombstoned,** not removed, so a stale device cannot resurrect a
  record you deleted elsewhere. `SELECT` with `deleted = 0` to see live rows.
- **One authoring device is the intended shape.** Conflict handling is
  last-write-wins; the architecture already assumes the parent device is
  authoritative.
- **Developer Tools' "Clear" buttons are local-only** and are not mirrored — that
  is deliberate, so clearing a store to test empty-state UI cannot destroy your
  durable copy. Use restore to pull it back.
- **Rotating the token:** edit the `SYNC_TOKEN` secret under the Worker's
  **Settings → Variables and Secrets** (this redeploys automatically), then re-save
  the new token in the app's Settings on each device.
- **`run_worker_first` needs a reasonably current Wrangler** (the route-array form,
  Wrangler 4.20+). If a deploy fails validating that key, delete the line — it is a
  routing optimization, not a requirement. `/api/*` never matches a static asset, so
  those requests fall through to the Worker regardless.
