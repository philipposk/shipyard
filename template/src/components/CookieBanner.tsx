"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";

const KEY = "cookie-notice-seen";
const EVENT = "cookie-notice";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

/** Tells visitors the app only uses the cookies it needs to keep them signed in. Shown once per browser. */
export function CookieBanner() {
  // Server and first paint say "seen" so the banner never flashes for people who already closed it.
  const hasSeen = useSyncExternalStore(subscribe, seen, () => true);

  if (hasSeen) return null;

  function close() {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Storage blocked: it will show again next visit, which is fine.
    }
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <div
      className="fixed left-0 right-0 z-50 mx-auto max-w-[640px] p-3"
      style={{ bottom: "var(--nav-space)" }}
      role="region"
      aria-label="Cookie notice"
    >
      <div className="card card-pad flex items-center gap-3">
        <p className="text-sm muted flex-1 m-0">
          Only cookies needed to keep you signed in. No ad tracking.{" "}
          <Link href="/privacy" className="link">
            Privacy
          </Link>
        </p>
        <button type="button" className="btn btn-primary" onClick={close}>
          OK
        </button>
      </div>
    </div>
  );
}
