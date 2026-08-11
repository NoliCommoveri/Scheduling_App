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
const CACHE_NAME = "daily-plan-shell-v4";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./sample-packet.js",
  "./js/schema.js",
  "./js/validator.js",
  "./js/date-util.js",
  "./js/import-core.js",
  "./js/merge-core.js",
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
  "./js/importer.js",
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

  if (!SHELL_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      // A shell file missing from the cache (install-time fetch failed) is
      // fetched and backfilled, so one bad install does not stay broken.
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
