// Child App service worker — app-shell cache for offline install/reload.
// Bump CACHE_NAME on any shell file change so clients pick up the new set.
const CACHE_NAME = "daily-plan-shell-v1";

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
  "./js/completion-core.js",
  "./js/deferment-core.js",
  "./js/streak-core.js",
  "./js/export-core.js",
  "./js/wipe-core.js",
  "./js/theme-core.js",
  "./js/reward-core.js",
  "./js/settings-core.js",
  "./js/db.js",
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
