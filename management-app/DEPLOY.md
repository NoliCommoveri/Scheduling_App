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

## Part A — one-time resource setup (from your machine)

Steps 1–4 create the database and the secret. They run once. After that you can
deploy from GitHub on every push (Part B) and never touch Wrangler again.

## 1. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the D1 database

```bash
cd management-app
wrangler d1 create homeschool-management
```

This prints a `database_id`. Open `wrangler.toml` and paste it over
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

## 3. Create the table

```bash
wrangler d1 execute homeschool-management --remote --file=worker/schema.sql
```

## 4. Set your sync token

Pick a long random string — this is the only thing standing between the internet
and your database, so let it be generated, not invented:

```bash
openssl rand -base64 32
```

Store it as a Worker secret, pasting the value when prompted:

```bash
wrangler secret put SYNC_TOKEN
```

**Keep a copy somewhere safe** (a password manager). You need it again in step 6,
and on every new device.

> If `SYNC_TOKEN` is never set, the API denies every request. It fails closed on
> purpose — an unconfigured Worker is never an open one.

---

## Part B — deploying

Two options. Pick one; **B1 is the one to use if you already deploy from GitHub.**

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
survives every Git-triggered deploy. If you'd rather not use the CLI for step 4, set
it in the dashboard instead under **Settings → Variables and Secrets**, as a
**Secret** (not a plaintext variable).

The `database_id` committed in `wrangler.toml` is an identifier, not a credential —
it is safe in the repo. Reaching the database still requires your Cloudflare account.

### B2. Deploy from your machine

```bash
cd management-app
wrangler deploy
```

Useful for a first smoke test before wiring up Git.

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

Confirm the data really is in D1, without trusting the app's own status line:

```bash
wrangler d1 execute homeschool-management --remote \
  --command "SELECT store, COUNT(*) AS rows FROM records WHERE deleted = 0 GROUP BY store ORDER BY store"
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
- **Rotating the token:** `wrangler secret put SYNC_TOKEN` again, redeploy, then
  re-save the new token in Settings on each device.
- **`run_worker_first` needs a reasonably current Wrangler** (the route-array form,
  Wrangler 4.20+). If a deploy fails validating that key, delete the line — it is a
  routing optimization, not a requirement. `/api/*` never matches a static asset, so
  those requests fall through to the Worker regardless.
