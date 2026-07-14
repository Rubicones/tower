/* tower service worker: offline app shell + local audio.
 *
 * NOTE ON STREAMING AUDIO:
 * The ATC layer streams 30–60 MB NASA tapes from archive.org using HTTP range
 * requests, seeking around freely. A service worker cannot safely cache/replay
 * those partial (206) responses — reconstructing them breaks the media element
 * ("ServiceWorker intercepted the request and encountered an unexpected error")
 * and reading their bodies would force full-file downloads. So archive.org is
 * deliberately NOT intercepted here; the browser handles range streaming and
 * its own HTTP cache natively. Offline resilience is provided in-app by the
 * failover ladder (live → session replay → bundled fallbacks in
 * /public/audio/atc/fallback/), which does not depend on this worker.
 */

const APP_CACHE = "tower-app-v5";

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.png",
  "/icons/icon-16.png",
  "/icons/icon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
  "/audio/silence.mp3",
  "/audio/atc/fallback/fallback-01.mp3",
  "/audio/atc/fallback/fallback-02.mp3",
  "/audio/atc/fallback/fallback-03.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      // Best-effort: a single missing asset must not abort the install.
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== APP_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only ever handle same-origin requests. archive.org (and any other cross-
  // origin host) is left entirely to the browser — see the note above.
  if (url.origin !== self.location.origin) return;

  // Never touch range requests (local fallback clips can be seeked too); the
  // browser satisfies these correctly on its own.
  if (request.headers.has("range")) return;

  // Local audio + static assets: cache-first (immutable-ish, large).
  const cacheFirst =
    url.pathname.startsWith("/audio/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/_next/static/");

  if (cacheFirst) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(APP_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          // Nothing cached and offline — surface a clean failure.
          return new Response(null, { status: 504, statusText: "offline" });
        }
      })(),
    );
    return;
  }

  // App shell / navigations: network-first with cache fallback.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (
          response.ok &&
          (request.mode === "navigate" || url.pathname === "/")
        ) {
          const cache = await caches.open(APP_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return new Response(null, { status: 504, statusText: "offline" });
      }
    })(),
  );
});
