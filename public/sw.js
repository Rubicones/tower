/* tower service worker: offline app shell + streaming audio pool.
 *
 * Two caches:
 *   - APP_CACHE   the installable app shell + bundled fallback clips.
 *   - AUDIO_CACHE archive.org tape responses. The <audio> deck streams via
 *                 HTTP range requests, so each entry is one byte-range of a
 *                 tape. Played ranges accumulate into a local pool, capped at
 *                 ~200 MB with LRU eviction. Over a night of playback the app
 *                 can keep going from this pool if the network drops.
 *
 * Range responses (HTTP 206) cannot be stored by Cache.put directly, so each
 * is normalised to a 200 with the original status/content-range preserved in
 * side headers, and reconstructed into a real 206 when served back.
 */

const APP_CACHE = "tower-app-v2";
const AUDIO_CACHE = "tower-audio-v1";
const AUDIO_CACHE_CAP_BYTES = 200 * 1024 * 1024;

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/audio/silence.mp3",
  "/audio/atc/fallback/fallback-01.mp3",
  "/audio/atc/fallback/fallback-02.mp3",
  "/audio/atc/fallback/fallback-03.mp3",
];

const ORIG_STATUS = "x-tower-orig-status";
const ORIG_RANGE = "x-tower-orig-content-range";
const ORIG_TYPE = "x-tower-orig-content-type";
const ENTRY_SIZE = "x-tower-entry-size";

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
        keys
          .filter((key) => key !== APP_CACHE && key !== AUDIO_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isArchiveAudio(url) {
  return (
    url.hostname === "archive.org" || url.hostname.endsWith(".archive.org")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (isArchiveAudio(url)) {
    event.respondWith(handleArchiveAudio(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

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
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(APP_CACHE);
          cache.put(request, response.clone());
        }
        return response;
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
        throw new Error("offline and not cached");
      }
    })(),
  );
});

/* ------------------------------------------------------------------ */
/* archive.org range-aware, cache-first audio pool                     */
/* ------------------------------------------------------------------ */

/** Stable cache key for a (url, range) pair — a valid, unique synthetic URL. */
function audioCacheKey(url, rangeHeader) {
  const key = new URL(url.href);
  key.searchParams.set("__rk", rangeHeader || "full");
  return new Request(key.href);
}

/** Rebuild a servable Response (206/200) from a stored normalised entry. */
async function fromStored(stored) {
  const status = Number(stored.headers.get(ORIG_STATUS)) || 200;
  const headers = new Headers();
  const type = stored.headers.get(ORIG_TYPE);
  const range = stored.headers.get(ORIG_RANGE);
  if (type) headers.set("Content-Type", type);
  if (range) headers.set("Content-Range", range);
  headers.set("Accept-Ranges", "bytes");
  const body = await stored.arrayBuffer();
  headers.set("Content-Length", String(body.byteLength));
  return new Response(body, { status, statusText: "", headers });
}

async function handleArchiveAudio(request) {
  const url = new URL(request.url);
  const rangeHeader = request.headers.get("range") || "";
  const key = audioCacheKey(url, rangeHeader);
  const cache = await caches.open(AUDIO_CACHE);

  const cached = await cache.match(key);
  if (cached) {
    // Bump recency (LRU): re-insert so it moves to the end of keys().
    void cache.put(key, cached.clone()).catch(() => {});
    return fromStored(cached);
  }

  let response;
  try {
    response = await fetch(request);
  } catch {
    // Network gone and nothing cached for this range — let the element's
    // error handler kick the in-app failover ladder.
    return new Response(null, { status: 504, statusText: "offline" });
  }

  if (response.status === 206 || response.status === 200) {
    try {
      const buf = await response.clone().arrayBuffer();
      const headers = new Headers();
      headers.set(ORIG_STATUS, String(response.status));
      const type = response.headers.get("content-type");
      const range = response.headers.get("content-range");
      if (type) headers.set(ORIG_TYPE, type);
      if (range) headers.set(ORIG_RANGE, range);
      headers.set(ENTRY_SIZE, String(buf.byteLength));
      await cache.put(key, new Response(buf, { status: 200, headers }));
      void enforceAudioCap(cache);
    } catch {
      // Storing is best-effort; still return the live response below.
    }
  }
  return response;
}

/** Evict oldest audio entries (FIFO by insertion == approx LRU) past the cap. */
async function enforceAudioCap(cache) {
  try {
    const keys = await cache.keys();
    let total = 0;
    const sizes = [];
    for (const request of keys) {
      const entry = await cache.match(request);
      const size = entry ? Number(entry.headers.get(ENTRY_SIZE)) || 0 : 0;
      total += size;
      sizes.push({ request, size });
    }
    let i = 0;
    while (total > AUDIO_CACHE_CAP_BYTES && i < sizes.length) {
      await cache.delete(sizes[i].request);
      total -= sizes[i].size;
      i += 1;
    }
  } catch {
    // Eviction is best-effort; the browser also enforces its own quotas.
  }
}
