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
// v7: §16 Phase 6 — the completion sheet. New file `complete-ui.js` (the
// write path: completions, reward entries, claim/release, the pending- and
// failed-earns queues). api.js gains the four write calls; day-ui.js gains
// done-in-place chip styling (§8.4); settings-ui.js gains the failed-earns
// list; store.js retires the dead `wall.pins` key and adds `wall.failedEarns`;
// wall.css gains the sheet, the done-chip styles, and the toast.
// v8: §16 Phase 6b — sound. New files `remind-core.js` (pure: which placed
// chores are due to chime) and `sound.js` (WebAudio: the two synthesized
// tones, the lazy-unlock gesture). app.js gains the local 5-second remind
// tick; nav-ui.js gains the "tap to enable sound" topbar indicator;
// complete-ui.js fires the confirmation tone on a successful tick;
// settings-ui.js gains the Sound section (per-child toggle, Test sound);
// store.js gains `wall.childPrefs`; wall.css gains the indicator and the
// sound-section rows.
// v9: §16 Phase 7 — school blocks (§5, revised 2026-08-15, §20). New file
// `school-core.js` (pure: per-course completion rollup, block collapse).
// api.js gains the five school-block calls; poll.js fetches them alongside
// slots; day-ui.js renders blocks in all three day-view modes, generalizes
// `attachGesture` for a block's drag/long-press/tap, and always renders the
// tray header (for "+ School") rather than hiding it when nothing's
// unplaced; wall.css gains the block chip, the two new sheets, and the
// always-visible tray's add button.
const CACHE_NAME = "wall-display-shell-v9";

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
  "./js/school-core.js",
  "./js/remind-core.js",
  "./js/sound.js",
  "./js/poll.js",
  "./js/day-ui.js",
  "./js/complete-ui.js",
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
