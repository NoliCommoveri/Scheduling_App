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
// v10: §9 display correction — same-slot chips share the column side by
// side instead of stacking on top of one another; a third-or-later
// collapses into a "+N" tile. day-ui.js gains the overlap grouping, the
// overflow tile and its sheet; wall.css gains the narrowed-chip, overflow
// tile and overflow-sheet-row styles. No new files.
// v11: §16 Phase 8 — the week view. New file `week-ui.js`: seven day-rows
// (Sunday-first), each showing that day's events plus a Chores/School token
// when the respective kind exists that day, opening a read-only kid-picker
// sheet — this supersedes the TDS's original seven-column design
// in-session (see week-ui.js's own header). chores-core.js gains
// `difficultyStars` (the chore's difficulty tier as a star count);
// school-core.js gains `activityTypeCounts`/`coursesWithTypeCounts` (a
// course's activity-type breakdown for the School sheet). app.js wires the
// "week" nav state to it; wall.css gains the week rows, tokens, and detail
// sheet styles.
// v12: nav polish — a prev/next stepper lands directly on the topbar (not
// only behind the hamburger), and the header names each view on its own
// terms instead of always showing the anchor date: week shows its
// Sunday-Saturday span, month shows the month name. Stepping now moves by
// the active view's own unit (a day, a week, or a calendar month) rather
// than always by one day. nav-ui.js and wall.css only — no new files.
// v13: day-view density and touch tolerances, from the wall running on the
// real tablet. wall.css: the 15-minute row goes 18px -> 32px (§4.3's rule
// unchanged — a row is still 15 minutes, a chip still ceil(duration/15)
// rows), chip and school-block text scales with it, and the mode bar gains
// a zoom. day-ui.js: the zoom itself (ZOOM_STEPS, stored per tablet), and
// `attachGesture` learns that a finger is not a mouse — a drag slop of at
// least one row, a 140ms window in which no drag can start, a tap radius
// wide enough for a wobbly tap, a same-slot drop that writes nothing, and
// Undo on a move that does happen. store.js gains `dayRowH`. No new files.
// v14: the tap that opened a sheet also closed it. All five sheets
// (completion, duration, block span, membership, overflow) dismiss on
// `pointerdown` rather than `click`, so the click trailing the opening tap
// can no longer reach the overlay it just created — this is what made a
// chip feel like it had a "sweet spot". New file `toast.js`: one popup
// policy for the whole wall (8 seconds or the next tap) hosted on <body>,
// where a background poll's re-render cannot tear it out; day-ui.js and
// complete-ui.js both go through it and `.complete-toast` is gone.
// day-ui.js also wraps each chore chip in a gap-aware transparent tap
// target, paints school blocks behind chips rather than over them, and
// indents a chore that falls inside a block.
// v15: §16 Phase 8, second half — the month view (§7). New files
// `month-core.js` (pure: the six-by-seven Sunday-first grid, its 42-day
// fetch window, and the per-cell "+N more" split) and `month-ui.js` (the
// grid, and the one view in this app that fetches for itself — §7.2's
// household-wide `GET /api/wall/events`, riding Poll's heartbeat rather
// than a second timer). api.js gains `getEvents`; nav-ui.js gains
// `goTo(view, date)` so a day-cell tap moves view and date in one poll;
// app.js drops its last placeholder branch; wall.css gains the grid, the
// in-cell event lines and the overflow sheet.
// v17: Placement Scopes Phases 2-3 — placements resolve through three
// scopes (standing / weekday / occurrence) and a school block's weekday list
// becomes its schedule, which is what stops blocks rendering on weekends
// (§0.1). `time-core.js` gains `weekdayOf` and is now the ONE place a date
// becomes a day-of-week (nav-ui.js and week-ui.js each had their own copy);
// `slots-core.js` gains the weekday level, the `scope` a chip resolved
// through, and the past-midnight clamp; `school-core.js` gains a placement
// section (`blockOccursOn`, `resolveBlockSpan`, `scheduledWeekdays`) beside
// its rollups; `day-ui.js`'s `blocksForChild` becomes `blocksForChildOn` and
// every block render reads the RESOLVED span; api.js and poll.js carry the
// three new arrays.
//
// The bump belongs to THIS phase, not Phase 6 as the slice's §9 scheduled it.
// This worker is cache-first for the shell, so without it the tablet keeps
// serving the old scripts and Phase 3 changes nothing a family can see —
// which is the one thing the Phase 2+3 break is supposed to deliver.
const CACHE_NAME = "wall-display-shell-v17";

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
  "./js/month-core.js",
  "./js/slots-core.js",
  "./js/school-core.js",
  "./js/remind-core.js",
  "./js/sound.js",
  "./js/poll.js",
  "./js/toast.js",
  "./js/day-ui.js",
  "./js/complete-ui.js",
  "./js/week-ui.js",
  "./js/month-ui.js",
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
