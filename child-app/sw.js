// Child App service worker — app-shell cache for install/reload.
// Bump CACHE_NAME on any shell file change so clients pick up the new set.
//
// Per TDS_Slice_Online_Revamp.md §8.5: cache-first for the precached shell
// only, network-only for /api/*, and never cache an API response. The previous
// handler was cache-first for every GET, which would have pinned the first
// /api/plan response forever once the planner went online — the app would look
// like it was working while showing a plan from weeks ago.
//
// v2, not v1: the shell moved origin (GitHub Pages → the Worker, §10) and the
// handler changed shape, so every previously cached entry must be discarded.
// v3: Phase 3B adds assignment-core.js and plan-sync.js to the shell. A device
// still holding the v2 set would boot an index.html that <script>s two files
// the cache has never heard of.
// v4: Phase 4 adds outbox-core.js and outbox.js, for the same reason.
// v5: Phase 5 deletes the packet import path (§11). The reason to bump is the
// mirror image of v3's: a device still holding the v4 set would keep serving
// six files that no longer exist on the server, and — because index.html is
// itself cached — would keep <script>ing them from a stale shell forever.
// v6: no file was added or removed this time — db.js, outbox.js, plan-sync.js
// and planner-ui.js changed contents. That still needs a bump: this handler is
// cache-first for every shell path, so an unchanged CACHE_NAME would keep
// serving the old copies indefinitely and the §5.6 rejection handling would
// never reach a device that already has the app installed.
// v7: the §8.1 ledger collapse, and the most consequential bump so far. db.js
// carries the IndexedDB v7 upgrade that migrates rewardLedgerSnapshot/Tail into
// rewardEntries; completion.js, reward.js, settings.js and export.js read and
// write the new store. A device left on the v6 shell would run the old files
// against whichever schema its browser happens to hold — writing to two stores
// the upgrade has already deleted the moment any other tab triggers it. The
// files must land as a set.
// v8: the Startup Wizard pairs the device (§4.3, Module 1 §7). wizard.js,
// pairing.js and app.js changed together — the wizard calls a redeem that now
// seeds the Child record's name, and app.js's boot gate depends on the wizard
// having written a PIN. A device serving any two of the three from a v7 cache
// would either re-enter setup on every launch or leave it half-finished.
// v9: two reasons at once.
//   1. `./index.html` leaves the shell — see the note above shellPath(). It is
//      the cause of the ERR_FAILED an installed shortcut hits on launch, and a
//      cache still holding the poisoned entry has to be discarded, not merely
//      stopped from being read.
//   2. The bump this file missed. Fourteen shell files changed across the §8.2
//      shim collapse (phases 1-3), the §12 live-days repeal and the §14
//      plannerMeta fold while CACHE_NAME sat at v8 — db.js among them, and it
//      carries the IndexedDB v9 upgrade. Same hazard v7 called out: a device
//      left on the old shell runs superseded code against whichever schema its
//      browser happens to hold.
// v10: Child Feedback Loop §7.2 — the date header. No file added or removed
// (planner-ui.js and style.css only changed contents), but the same v6
// reasoning applies: this handler is cache-first for the shell, so a device
// left on v9 would never see the header land, and would keep reasoning about
// "today" with no on-screen check against a mis-set device clock (§7.1).
const CACHE_NAME = "daily-plan-shell-v10";

const APP_SHELL = [
  "./",
  "./manifest.json",
  "./css/style.css",
  "./js/date-util.js",
  "./js/planner-core.js",
  "./js/assignment-core.js",
  "./js/completion-core.js",
  "./js/deferment-core.js",
  "./js/streak-core.js",
  "./js/export-core.js",
  "./js/wipe-core.js",
  "./js/theme-core.js",
  "./js/reward-core.js",
  "./js/settings-core.js",
  "./js/outbox-core.js",
  "./js/db.js",
  "./js/pairing.js",
  "./js/plan-sync.js",
  "./js/outbox.js",
  "./js/theming.js",
  "./js/completion.js",
  "./js/deferment.js",
  "./js/streak.js",
  "./js/export.js",
  "./js/wipe.js",
  "./js/reward.js",
  "./js/settings.js",
  "./js/wizard.js",
  "./js/planner-ui.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Per-file, not cache.addAll(): a missing icon (not dropped in yet)
      // must not abort caching of the rest of the shell.
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The precached shell, as absolute paths, resolved once at startup. Matching on
// this set is what makes the handler cache-first for the shell and nothing else
// — a URL the install step did not precache is never served from, or written
// to, the cache.
//
// Resolved against self.location (this script's URL), which is the base
// `cache.add()` uses for the same relative strings during install. Not
// registration.scope: the two are identical for a default registration, but if
// scope ever widens these paths must still follow the script.
const SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).pathname));

// The shell has one spelling, and it is the directory path.
//
// Cloudflare's asset server treats `/child-app/` and `/child-app/index.html` as
// the same resource and 307s the second onto the first (`html_handling`
// defaults to "auto-trailing-slash"). That redirect is harmless to a plain
// browser and fatal to this worker, because `cache.add("./index.html")` follows
// it and stores a response whose `redirected` flag is set — and the Fetch spec
// makes a *navigation* answered with a redirected response a network error, not
// a fallback. Chrome reports ERR_FAILED and the app never boots. Every device
// installed before this fix launches at exactly that URL: `start_url` was
// `./index.html` when the shortcut was created, and an installed shortcut keeps
// the start_url it was captured with. It did not bite while the shell was on
// GitHub Pages, which serves `/child-app/index.html` as a plain 200; moving
// both apps onto the Worker (§10) is what introduced the redirect.
//
// Dropping `./index.html` from the shell and letting it fall through to the
// network would trade a dead launch for one that cannot open offline. So it is
// folded onto the directory path instead, on the way in and on the way out:
// the cache holds one entry, keyed `/child-app/`, fetched and served without a
// redirect in it. Nothing else in the shell has a second spelling.
function shellPath(pathname) {
  return pathname.endsWith("/index.html")
    ? pathname.slice(0, -"index.html".length)
    : pathname;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin GETs are none of this worker's business.
  if (url.origin !== self.location.origin) return;

  // /api/* is network-only and never cached. Left to fall through rather than
  // handled: an API request that fails offline must reach the app's own error
  // path so a completion queues in the outbox (§8.4), not be masked here.
  if (url.pathname.startsWith("/api/")) return;

  const path = shellPath(url.pathname);
  if (!SHELL_PATHS.has(path)) return;

  // Matched and re-fetched on the canonical URL rather than on `request`, which
  // is what keeps a redirect out of the response. Building it from the pathname
  // also drops any query string — a launch at `?source=pwa` wants the same
  // shell file, and the shell is versioned by CACHE_NAME, never by a query.
  const canonical = new URL(path, self.location.href).href;

  event.respondWith(
    caches.match(canonical).then((cached) => {
      if (cached) return cached;
      // A shell file missing from the cache (install-time fetch failed) is
      // fetched and backfilled, so one bad install does not stay broken.
      return fetch(canonical).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(canonical, clone));
        }
        return response;
      });
    })
  );
});
