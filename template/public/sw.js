// Service worker: makes the app installable and keeps the icons and built files handy.
// It never stores pages or data, so signed-in content is never shown to the wrong person
// and a deploy is visible right away. Bump the version to clear what it stored.
const CACHE = "<APP_SLUG>-v1";
const SHELL = ["/manifest.webmanifest", "/icon-192.png", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Only built files (their names change on every deploy) and the icons are served from the cache first.
function cacheable(pathname) {
  return pathname.startsWith("/_next/static/") || SHELL.includes(pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response("<!doctype html><meta name=viewport content=\"width=device-width\"><title>Offline</title><p style=\"font-family:system-ui;padding:2rem\">You are offline. Reconnect and try again.</p>", {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
      )
    );
    return;
  }

  if (!cacheable(url.pathname)) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
