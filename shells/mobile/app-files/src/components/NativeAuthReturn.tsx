"use client";

import { useEffect } from "react";
import { isNativeApp, toWebCallback } from "@/lib/native-auth";

/**
 * Mounted once in the root layout. When the phone's browser finishes Google sign-in it opens the app on
 * `<app id>://auth/callback`. This closes the browser and loads the normal /auth/callback page inside the app,
 * which finishes the sign-in (the one-time proof was stored in the app's own browser when sign-in started).
 * Does nothing in a normal browser. Written by Shipyard add-shell.
 */
export default function NativeAuthReturn() {
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    const seen = new Set<string>();
    let listener: Promise<{ remove: () => Promise<void> }> | null = null;

    const openReturn = async (url: string) => {
      const target = toWebCallback(url, window.location.origin);
      if (!target || seen.has(target)) return;
      seen.add(target);
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      } catch {
        // The browser was never opened by the plugin, or it is already closed.
      }
      if (!cancelled) window.location.assign(target);
    };

    (async () => {
      const { App } = await import("@capacitor/app");
      if (cancelled) return;
      const launch = await App.getLaunchUrl();
      if (launch?.url) await openReturn(launch.url);
      const handle = App.addListener("appUrlOpen", (event) => {
        void openReturn(event.url);
      });
      listener = handle;
      if (cancelled) void handle.then((subscription) => subscription.remove());
    })();

    return () => {
      cancelled = true;
      void listener?.then((handle) => handle.remove());
    };
  }, []);

  return null;
}
