// Wall App service worker — shell-only cache (TDS_Slice_Wall_Display_App.md
// §10.2). Cache-first for the precached shell, network-only for /api/*, never
// cache an API response — same discipline as child-app/sw.js, re-implemented
// rather than shared (CLAUDE.md §I.A). It exists so a wifi blip during a
// reload does not white-screen a tablet meant to run for months, and for no
// other reason.
//
// Bump CACHE_NAME on any shell file change. Settings' "Reload app" button
// (settings-ui.js) unregisters and re-registers this worker for exactly the
// case where a device is stuck on a stale cache with no CLI to clear it from
// (CLAUDE.md §0).
//
// v1: Phase 2 (superseded slice) — shell, store, admin PIN, first-run
// wizard, pairing, ambient tiles from the live roster with no plan data
// behind them yet.
// v2: Wall Calendar Redesign §16 Phase 2 — the nav shell (nav-ui.js). Also
// backfills poll.js, events-core.js, chores-core.js and completed-core.js,
// which Phase 3 of the superseded slice added to index.html without ever
// adding them here — a gap found on review of this file, not a v2 change in
// its own right. Without it, a wifi blip during a reload left the tablet
// unable to fetch render-critical scripts with no cached fallback.
// v3: §16 Phase 3 — the real day view (day-ui.js) replaces the ambient
// board outright. `ambient-ui.js` and `completed-core.js` are deleted
// (§13); `time-core.js` and `slots-core.js` are new.
// v4: §16 Phase 4 — block mode. day-ui.js and wall.css both change
// substantially (the mode bar, collapsed block rows, and the single-block
// expanded grid); chores-core.js gains the block-classification helpers.
// No new files.
// v5: §16 Phase 5 — placement writes. day-ui.js, api.js, slots-core.js and
// wall.css all change substantially for drag/tap-to-place. No new files.
// v6: §16 Phase 5b — the duration-adjust sheet. day-ui.js (long-press
// gesture, the sheet), api.js (wall_slot_days PUT/DELETE), slots-core.js
// (assignedDurationMin), time-core.js (formatDurationMin), and wall.css
// (the sheet, the chip duration marker, the press state) all change.
// No new files.
const CACHE_NAME = "wall-display-shell-v6";

const APP_SHELL = [
  "./",
  "./manifest.json",
  "./css/wall.css",
  "./js/pin-core.js",
  "./js/store.js",
  "./js/api.js",
  "./js/setup.js",
  "./js/time-core.js",
  "./js/events-core.js",
  "./js/chores-core.js",
  "./js/slots-core.js",
  "./js/poll.js",
  "./js/day-ui.js",
  "./js/nav-ui.js",
  "./js/settings-ui.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Per-file, not cache.addAll(): one missing asset must not abort
      // caching of the rest of the shell.
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

// Same fold as child-app/sw.js's shellPath(): Cloudflare's asset server 307s
// "/wall-app/index.html" onto "/wall-app/", and caching a redirected response
// makes the very next navigation a network error. One spelling, the
// directory path, in and out.
const SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).pathname));

function shellPath(pathname) {
  return pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : pathname;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-only, never cached — an API response cached here is a completion
  // the wall could show as applied when it was never sent (§6.4).
  if (url.pathname.startsWith("/api/")) return;

  const path = shellPath(url.pathname);
  if (!SHELL_PATHS.has(path)) return;

  const canonical = new URL(path, self.location.href).href;

  event.respondWith(
    caches.match(canonical).then((cached) => {
      if (cached) return cached;
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
