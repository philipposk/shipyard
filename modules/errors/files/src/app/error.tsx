"use client";

import { ErrorScreen } from "@/components/errors/ErrorScreen";

// Shown when a page crashes while it is running. The rest of the app (menus, other pages) keeps working.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="app-main">
      <ErrorScreen error={error} reset={reset} />
    </main>
  );
}
