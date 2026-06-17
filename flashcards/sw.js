/* Offline cache. Bump CACHE when you change files. */
const CACHE = "recall-v4";
const ASSETS = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "db.js",
  "apkg.js",
  "vendor/fflate.js",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm",
  "manifest.json",
  "icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
