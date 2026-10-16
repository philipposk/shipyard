"use client";

import { useEffect, useState } from "react";
import { BRAND } from "@/lib/constants";

// Chrome's install event. Not in TypeScript's built-in types.
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
}

const DISMISS_KEY = "install-prompt-dismissed";

/** Offers "Add to home screen" on phones, only when the browser says the app can be installed. */
export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const phone = window.matchMedia("(pointer: coarse) and (max-width: 820px)").matches;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      // Storage blocked: just show it.
    }
    if (!phone || dismissed) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!installEvent) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Not saved; it may come back next visit.
    }
    setInstallEvent(null);
  }

  async function install() {
    try {
      await installEvent?.prompt();
    } finally {
      dismiss();
    }
  }

  return (
    <div className="fixed top-16 left-4 right-4 z-40 max-w-[640px] mx-auto">
      <div className="card p-3 flex items-center justify-between gap-2">
        <span className="text-sm">Add {BRAND.shortName} to your home screen</span>
        <div className="flex gap-1">
          <button type="button" className="btn btn-ghost" onClick={dismiss}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void install()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
