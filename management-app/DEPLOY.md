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

## 5. Deploy

```bash
wrangler deploy
```

Wrangler prints your URL, e.g. `https://homeschool-management.<subdomain>.workers.dev`.
That URL now serves the management app *and* its backup API from the same origin —
no CORS, no second deployment.

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
