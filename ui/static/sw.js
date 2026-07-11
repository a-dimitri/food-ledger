// Service worker for the Ledger PWA.
//
// Network-first for same-origin GETs, with a cache fallback so the app shell
// opens offline. Deliberately NOT cache-first: this app is normally online and
// deploys often, so serving fresh assets matters more than shaving a few KB —
// it also avoids the "stale JS after deploy" trap. Never touches /api/* (user
// data + auth) or cross-origin requests (e.g. the IAP -> Google login redirect).

const CACHE = "ledger-v1";
const SHELL = [
  "/static/app.js",
  "/static/styles.css",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let IAP/Google redirects pass through
  if (url.pathname.startsWith("/api/")) return;      // never cache user data or auth

  // Navigations fall back to the cached shell ("/"); assets to their own URL.
  const key = req.mode === "navigate" ? "/" : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache real same-origin 200s (not opaque/redirect responses).
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key))
  );
});
