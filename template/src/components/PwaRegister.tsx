"use client";

import { useEffect } from "react";

/** Registers the service worker (public/sw.js) that makes the app installable. Only on https, never on localhost. */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:") return;
    if (window.location.pathname === "/clear-cache") return;

    void (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
        await reg.update();
      } catch {
        // Installing is a nice extra; the app works without it.
      }
    })();
  }, []);

  return null;
}
