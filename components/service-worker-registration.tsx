"use client";

import { useEffect } from "react";

/** Registers the PWA service worker (production only). Renders nothing. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // In dev, actively tear down any stale production service worker + its
      // caches. A leftover SW serves cached `/_next/static/` chunks, which no
      // longer match Turbopack's per-build hashes → ChunkLoadError and an
      // infinite HMR reload loop.
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
      if ("caches" in window) {
        void caches
          .keys()
          .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
          .catch(() => {});
      }
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is progressive enhancement; ignore failures.
    });
  }, []);
  return null;
}
