# Management App — Cloudflare deployment & D1 backup setup

One-time setup, ~10 minutes. Everything here stays inside Cloudflare's free tier.

> **Partially superseded — 2026-08-10.** `docs/TDS_Slice_Online_Revamp.md` makes D1 the
> system of record and puts both apps behind one Worker. Two things in this guide changed:
>
> - **Step 3 no longer touches the D1 console.** *(Done — Revamp Phase 0.)* Schema arrives
>   as numbered files in `/migrations`, applied by clicking **Apply** in Settings → Database
>   or at `/admin/migrations`. No console, no CLI. See Revamp §3.7.
> - **`[assets] directory` widened to `./`** so the Child App is served from the same origin,
>   with a repo-root `.assetsignore` holding everything non-public back. *(Done — Phase 3
>   prep.)* See Revamp §10 and **Part C** below, which is the one-time move you have to
>   do by hand.
>
> Everything else below — the git connection, the repo-root `wrangler.toml`, the
> `SYNC_TOKEN` secret, the troubleshooting section — is unchanged and still correct.

Design and rationale: `docs/TDS_Slice_Online_Revamp.md` (current),
`docs/TDS_Slice_D1_Sync_Management_App.md` (superseded, kept for the deploy history).

---

## What this gives you

One Cloudflare Worker serving **both apps and the API from a single origin**, on top
of a D1 database that is the system of record. A lost laptop, a cleared browser or a
wiped profile no longer costs you anything: the curriculum you author is mirrored to
D1 as you write it, and everything the children are assigned and complete lives there
outright.

The parent's browser holds a working copy plus an upload queue; each child's device
holds a cached plan plus its own queue. Neither is the truth any more. If the network
is down, changes queue locally and upload themselves later — you never have to
remember to press anything — but the network is the normal path, not an exception.

> **This replaces the old "works completely offline" promise, deliberately.** What you
> give up is that a child's device must reach the network at least once to *receive*
> new work. What you get is that the two apps talk to each other: no packet files to
> carry, no completion CSVs to import, no reconciliation. See Revamp §0.

---

## Part A — one-time resource setup

Steps 1–4 create the database and the secret. They run once. After that, every
deploy happens from GitHub on push (Part B).

**No local tooling is required.** Everything below is done in the Cloudflare
dashboard and by editing one file on GitHub. Wrangler runs inside Cloudflare's
build environment, not on your machine.

## 1. Create the D1 database

Dashboard: **Storage & Databases → D1 → Create database**. This project's database
is named `scheduling-app`.

The database's overview page shows its **Database ID**. Copy it.

## 2. Point the config at it

Already done, in **`wrangler.toml` at the repository root**:

```toml
database_name = "scheduling-app"
database_id   = "bb58d835-f115-4ae5-a8ad-5653b102957e"
```

If you ever recreate the database, both fields have to match the dashboard again —
Wrangler validates the pair, and a mismatch fails the deploy rather than silently
writing somewhere unexpected.

> **Do not add the D1 binding through the dashboard's Bindings tab.** For a
> git-deployed Worker that editor is locked: bindings added there silently fail to
> persist, because `wrangler.toml` is the source of truth and Cloudflare will not
> let the two drift. The repo config above is the only place this belongs.

## 3. Create the tables

**Nothing to do in the console.** The schema ships as numbered files in `/migrations`
and applies itself from a button (Revamp §3.7). Do this once the Worker is deployed
(Part B) and `SYNC_TOKEN` is set (step 4):

- **Settings → Database**, in the Management App. It lists every migration with its
  state and applies the pending ones. The app also checks on load and raises a banner
  by itself when something is pending, so you do not have to remember to look.
- **`/admin/migrations`** on the deployed origin — a plain page served by the Worker,
  with a token field and a confirm box. Use this one if the Management App will not
  start, which is exactly when a schema problem is most likely.

Either surface needs the parent `SYNC_TOKEN`. Both are safe to press twice: applying
with nothing pending writes nothing and says so.

> **Apply a migration before deploying the code that uses it.**
> (Child Feedback Loop TDS §5.5.) A migration adds its column or table on its own;
> the Worker and Child App code that reads and writes it should land in a *later*
> deploy. Press **Apply** here between the two, and confirm it shows applied.
> Applying early costs nothing — an inert column with nothing reading or writing it
> yet is harmless.
>
> If the order does slip, the damage is now bounded (TDS §11.7, closed 2026-08-12).
> A device posting a value the schema cannot take gets that **row** held back and
> retried, while the rest of its queue — completions, rewards, streak — keeps
> draining normally. Before that containment it was a request-level 500, which
> froze the device's entire outbox until the migration landed; a parent who
> deployed on Friday and applied on Monday lost the weekend's sync on every
> device. That failure mode is gone, but the ordering is still the cheap way to
> avoid the stall entirely.
>
> One caveat while a device is on an older Child App shell: it has not picked up
> the header that opts into the per-row behaviour, so it still gets the old
> whole-batch retry. Nothing is lost either way — the rows stay queued — but the
> drain stalls for that device until it updates or the migration is applied.
>
> **`0005_assignment_messages.sql` is a free one.** It creates the messages
> table, and as of this deploy nothing calls the routes that use it — the Child
> App composer and the Management App inbox are both later releases. Apply it
> whenever you next open this page; there is no window to get wrong.
>
> **`0009_wall_device_scope.sql` is another free one.** It adds a `scope` column
> to `devices` that every existing row reads as `'child'` through its default, so
> nothing changes for the tablets you already paired. It is what the Wall Display
> App's credential needs (Wall TDS §8.1): until it is applied, pairing a wall
> display fails and nothing else does. Child pairing deliberately does not name
> the column, so it keeps working either way.

> **The console path is retired.** The `records` table on the live database was created
> by hand there before the runner existed, which is why `0001_online_revamp_init.sql`
> uses `CREATE TABLE IF NOT EXISTS` throughout — it is a no-op against that table and
> creates everything else. Applied migrations are tracked in `d1_migrations`, so nothing
> is ever applied twice.

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

Secrets **do** work from the dashboard, unlike bindings — they are stored
separately from `wrangler.toml`, which is correct, since a secret value must never
be committed to git.

> **Secrets only take effect on a deploy made after they were added.** If the
> Worker was already deployed when you added `SYNC_TOKEN`, push a commit or hit
> **Retry deployment**, or `env.SYNC_TOKEN` stays undefined and every API call
> keeps returning `401`.

**Keep a copy somewhere safe.** The value is not viewable again after saving. You
need it again in step 6, and on every new device.

> If `SYNC_TOKEN` is never set, the API denies every request. It fails closed on
> purpose — an unconfigured Worker is never an open one.

---

## 5. Grading Assistant: R2 bucket and API key

Two dashboard steps and one in the app, needed only once the Grading Assistant's Phase 3 build
lands (`docs/TDS_Slice_Grading_Assistant.md`). Skip this section if that feature isn't in use yet —
`wrangler.toml`'s R2 binding simply resolves once the bucket exists, same as D1 did in step 1.

**5a. Create the R2 bucket.** Dashboard → **R2 Object Storage → Create bucket**, name it exactly
`grading-media` (matches `wrangler.toml`'s `bucket_name`), default settings otherwise. This is
where captured worksheet photos and parent-uploaded answer keys live — never in the repo, never
public (§4 of the TDS).

**5b. Set the model API key.** Under **Settings → Variables and Secrets → Add**, same place as
`SYNC_TOKEN` above:

| Field | Value |
|---|---|
| Type | **Secret** (not Text) |
| Name | `ANTHROPIC_API_KEY` |
| Value | an API key from the Anthropic Console |

Same rule as `SYNC_TOKEN`: secrets only take effect on a deploy made *after* they're added, and
the value isn't viewable again once saved — keep a copy somewhere safe before moving on.

> **This is the one place this project spends money beyond Cloudflare's free tier.** Model
> inference is metered — estimated ~$7–11/month at ~240 worksheets a month (`CLAUDE.md` §0, a
> narrowing scoped to this milestone only). Cloudflare Workers, D1, and R2 stay free-tier
> regardless.

Until both the bucket and the key exist, `/api/grading/*` routes return a 500 naming whichever is
missing — same fail-closed shape as `SYNC_TOKEN` above, not a broken deploy.

**5c. Upload an answer key for each lesson you want graded.** This one is in the app, not the
dashboard: **Assigned Courses → the Course → the Lesson → Answer key**, which takes a PDF and shows
whether one is already there. The Lesson list on the Course marks which lessons still need one, so
you can see the gaps without opening each in turn.

Grading needs a key: a child capturing a page for a lesson that has none gets "No answer key has
been uploaded for this lesson yet. Ask a parent to add one," and nothing is graded or charged.
Answer keys attach to the **assigned** Course's lesson, not the template's, so a course stamped for
two children needs the PDF on each — deliberate, since curriculum editions change between years and
a key shared across every year would eventually be the wrong one (§4 of the TDS).

Keys live in R2 alongside the photos and are served only through the Worker with the parent token.
They are never in the repo and never reachable from a child's device — which is the whole reason
this is an upload rather than a file in the tree.

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
| Root directory | *(leave at the repo root)* |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler deploy` |
| Branch | `main` |

> **No build command is needed here**, unlike the Star-homeschool Worker. That one
> writes its API as Pages Functions in `functions/`, a file-based-routing
> convention a plain Worker cannot read, so it must be compiled to a single entry
> script first and its `main` points at the build output.
>
> `management-app/worker/index.js` is *already* a single entry script that routes
> itself and falls back to `env.ASSETS.fetch(request)` — the same shape that
> bundler emits. `main` points straight at the source and `wrangler deploy` bundles
> it. There is no `dist/` to regenerate and commit.
>
> If the build log ever reports `wrangler: not found`, set the build command to
> `npm install`; the root `package.json` exists only to pin Wrangler's version so
> deploys are reproducible.

> **Workers, not Pages.** This is a Worker with static assets (`main` + `[assets]`)
> because it needs the D1 binding. A Cloudflare **Pages** project handles bindings
> differently and will not work with this config as written.

### Why the repo root is fine

The connection covers the whole repository, and that is deliberate: **`wrangler.toml`
must sit at the repository root**, because a git-connected build looks for it there.
It is the one file in this project whose location Cloudflare dictates rather than
`CLAUDE.md` §I.B.

What gets *deployed* is still scoped by that config, not by the connection — but
that scope is now the whole repository. `[assets] directory = "./"` uploads
everything, because both apps have to be served from this one origin, so the
**repo-root `.assetsignore` is the only thing keeping the rest private**:
`docs/`, `migrations/`, `tests/`, `.git/`, `management-app/worker/`,
`wrangler.toml`, and every `*.md` are excluded there.

That file is a security boundary now, not housekeeping. **Adding a directory of
anything non-public to the repo means adding it to `.assetsignore` in the same
commit**, or it is downloadable by anyone who guesses the URL. Revamp acceptance
check §13.10 is the test — see "Verifying the asset boundary" below.

`migrations/` is excluded from *assets* yet still reaches the Worker: the
`[[rules]]` Text glob in `wrangler.toml` bundles each `.sql` file into the script
itself (Revamp §3.7.2), which is what lets the in-browser runner apply them.

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

Either way, Cloudflare prints your URL. It is built from the **Worker** name in
`wrangler.toml` (`name = "scheduling-app"`), so it reads
`https://scheduling-app.<subdomain>.workers.dev`. Change that `name` if you want a
different URL; it does not affect the database binding. The D1 database happens to
be named `scheduling-app` too, but the two are unrelated settings — renaming the
Worker does not touch the database.

That one URL now serves **both apps** and the API from the same origin — no CORS,
no second deployment:

| URL | What it is |
|---|---|
| `/` | Redirects to the Management App |
| `/management-app/` | The Management App |
| `/kid` | Redirects to the Child App — the short URL to type on a child's device |
| `/child-app/` | The Child App |
| `/api/…` | The API, for both |
| `/admin/migrations` | The no-JS migration fallback |

## 6. Connect the app

1. Open the deployed URL and unlock with your launch PIN.
2. Go to **Settings → Cloud backup**.
3. Paste the `SYNC_TOKEN` from step 4 and press **Save token**.

You should see `Connected. Cloud holds N record(s).` The status line then tracks
every change: `Up to date. Last synced: …`, or a pending count when offline.

---

## Part C — moving the Child App off GitHub Pages

One time only, after the first deploy that includes the widened `[assets]`
directory. Until this is done there are two live copies of the Child App: the new
one at `/child-app/`, and the old GitHub Pages one, which cannot reach the API and
will keep serving itself out of its own service worker cache indefinitely.

**1. Check the new copy works.** Open `<your-worker-url>/kid`. It should redirect
to `/child-app/` and load.

**2. Turn off GitHub Pages.** On GitHub: **Settings → Pages**, set Source to
**None**. This is deliberately step 2, not step 1 — confirm the replacement is up
before removing the thing it replaces.

**3. Re-add the home-screen icon on each child's device.** The old icon points at
`github.io` and will not update itself, because a home-screen PWA keeps the origin
it was installed from.

- Delete the old icon.
- Open `<your-worker-url>/kid` in the browser.
- **Add to Home Screen.**

**4. If a device still shows the old app,** its old service worker is still
serving from cache on the old origin. Open the `github.io` URL directly in a
browser tab (not the icon), and clear site data for it: on Android Chrome, tap the
padlock → **Permissions/Site settings → Delete data**. Once Pages is off (step 2)
this resolves on its own the next time the cache is evicted, but clearing is
faster.

> **Pairing has to be redone** on each child device if it was ever attempted from
> the GitHub Pages copy — a device token stored there belongs to a different
> origin's IndexedDB and does not travel. Mint a fresh pairing code from
> **Settings → Devices** in the Management App.

---

## Part D — first run, in order

Parts A–C put the system on the internet. This is the shortest path from there to a
child looking at their own plan. **The order matters** — each step is the input to the
next, and doing them out of order is the one way to get stuck.

Everything here is a browser. There is no CLI in this project (CLAUDE.md §0).

### 1. Apply the schema

Open the Management App, unlock with your launch PIN, go to **Settings → Database**,
press **Apply**. A banner on the home screen tells you if anything is pending without
your having to look.

If the app will not start at all, use **`/admin/migrations`** instead — same job, plain
HTML, no JavaScript, works when nothing else does.

*Nothing else on this list will work until this is done.* An unmigrated database has no
tables for children, assignments, devices or pairing codes.

### 2. Save the sync token in the app

**Settings → Cloud backup**, paste the `SYNC_TOKEN` from Part A step 4, **Save token**.
You should see `Connected. Cloud holds N record(s).`

### 3. Author enough to assign

The minimum that produces a real day, in dependency order — each screen validates
against the one above it:

| Order | Screen | Why it has to come first |
|---|---|---|
| 1 | **Tiers** | Already seeded with four (Easy → Very Hard) and their reward categories. Every activity and chore points at one. Extend if you want; nothing here blocks you. |
| 2 | **Activity Types** | Already seeded with the canonical ten (Quiz, Test, Project, Report, PDF, Drill, Workbook, Video, Practice Level, Reading Pages). Activities reference these. |
| 3 | **Curriculum** | The container courses live under. |
| 4 | **Courses** | Lessons and activities are authored inside a course. |
| 5 | **Children** | One row per child. **Nothing can be assigned or paired without this.** |
| 6 | **Children → assign a course** | Stamps a Child Course Instance — the thing pacing paces. |
| 7 | **Pacing** | How fast that instance moves. School instances only. |
| 8 | **Chores** / **Events** | Optional. Standalone, per child, no curriculum needed. |

### 4. Commit a batch of assignments

**Assign** → pick the child and a date range → **Propose** → review what comes back →
**Commit & assign**.

Commit is the moment work becomes real: it writes one row per child per day per thing
to do, straight to D1. Nothing is downloaded and nothing needs carrying anywhere.

A big Commit goes up in chunks. If one dies partway, press **Commit** again — it
resumes rather than assigning everything twice, and it will tell you where it got to.

Check it landed under **Assignments**, which browses what any child has been given and
is also where you rescind a bad batch or move a single item.

### 5. Pair each child's device

In the Management App, **Settings → Devices**. Under **Pair a device**, pick the child
and press **Generate pairing code**. It shows an 8-character code, good for **15
minutes**, usable **once**. The same page lists every device already paired and revokes
any of them.

Then on the child's device:

1. Open `<your-worker-url>/kid` and **Add to Home Screen**.
2. Set a parent PIN — this is the device's own PIN for deferment and reward spending,
   nothing to do with your launch PIN or the sync token.
3. Type the pairing code. Case, spaces and dashes do not matter.
4. Name the device if you like ("Ellie's tablet"), give it a semester label and a
   theme.

Their name is never typed on that device — it arrives with the code, from the child
record you made in step 3. When setup ends, the plan you committed in step 4 is already
on screen.

> **The parent `SYNC_TOKEN` never goes on a child's device.** It grants a whole-database
> snapshot. Device tokens are scoped to one child and revocable from **Settings →
> Devices**, effective on that device's very next request with no redeploy. This is the
> single most important rule in the design (Revamp §4.1).

Repeat step 5 per child, and per device if a child has more than one. A code pairs one
device; mint another for the next.

### If something looks wrong

| Symptom | Cause |
|---|---|
| Child App says "This device isn't linked yet" | Setup was finished before pairing, or Settings → "Forget this device" was pressed. Mint a fresh code. |
| "Unknown pairing code" | Expired (15 min) or already used. Mint another; they are free. |
| Paired, but no work shows up | Nothing has been committed for that child *in the window*. The device fetches today−7 … today+14. |
| Child App keeps re-asking for setup | Setup never reached the last step, so no PIN was stored. Run it through to the end; it will recognise the pairing it already has. |
| Everything returns 401 | `SYNC_TOKEN` unset, or set after the last deploy. See the troubleshooting section. |

---

## Verifying the asset boundary

The assets directory is the whole repository now, so it is worth confirming by
hand that `.assetsignore` is actually holding. **In a browser tab**, visit each of
these on your deployed origin — all four must show the app's 404, not a file:

| URL | Must not be downloadable |
|---|---|
| `/wrangler.toml` | Config |
| `/management-app/worker/index.js` | The API's source |
| `/migrations/0001_online_revamp_init.sql` | Schema |
| `/docs/TDS_Slice_Online_Revamp.md` | Design docs |

*(This is Revamp acceptance check §13.10. The slice writes it as a `curl`
one-liner; the address bar tests exactly the same thing, and there is no CLI in
this project — see CLAUDE.md §0.)*

Do this again any time a new top-level directory is added to the repo.

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

## Troubleshooting

### "Variables cannot be added to a Worker that only has static assets"

Also shows as *"Triggers cannot be added…"* and *"Logpush cannot be added…"* on the
same Settings page, and as a Bindings tab that accepts a D1 binding then shows
"No connected bindings" again immediately.

**Cause:** the Worker deployed with **no script** — only static assets. The build
did not find a `wrangler.toml` with a `main` entry, so there is nothing for a
secret or binding to attach to.

**Fix:** `wrangler.toml` must be at the **repository root** (it is), with `main`
pointing at the Worker script. Redeploy. Once the deploy includes a script, the
Variables and Secrets section becomes usable.

If the Worker stays stuck in assets-only mode after a correct redeploy, delete it
in the dashboard and let the next push recreate it — the project type is decided at
creation and does not always convert in place.

*(Same failure and same fix as the Star-homeschool Worker — see that repo's
`docs/parent-sync-spec.md`, Step 5.)*

### Every API call returns 401 after setting the token

`SYNC_TOKEN` takes effect only on a deploy made **after** it was added. Push a
commit or hit **Retry deployment**.

---

## Things worth knowing

- **The Child App now ships from this Worker,** not GitHub Pages (Revamp §10) — see
  Part C for the one-time move. It had to become same-origin with the API: it calls
  `/api/…` with relative URLs, which from a `github.io` origin resolve to GitHub and
  404. The cost is a one-time home-screen re-add per child, and the "fully offline"
  description stops being true — it is online-first, offline-tolerant now.
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
