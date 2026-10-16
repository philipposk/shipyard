"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/errors/client";

interface ErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** "app" when even the page frame broke (global-error.tsx). */
  source?: "page" | "app";
}

/** The "something went wrong" card used by error.tsx and global-error.tsx. It tells the owner, then offers a retry. */
export function ErrorScreen({ error, reset, source = "page" }: ErrorScreenProps) {
  useEffect(() => {
    reportClientError(error, source);
  }, [error, source]);

  return (
    <div className="text-center py-12">
      <h1 className="page-title mb-2">Something went wrong</h1>
      <p className="text-sm mb-6 muted">This page could not load. The person who runs this app has been told.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        {/* A full page load, which also clears whatever state broke (and works when the page frame itself is broken). */}
        <button type="button" className="btn btn-secondary" onClick={() => window.location.assign(window.location.origin)}>
          Back home
        </button>
      </div>
    </div>
  );
}
