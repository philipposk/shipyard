"use client";

import "./globals.css";
import { DEFAULT_THEME } from "@/lib/theme";
import { fontClassName } from "@/lib/fonts";
import { ErrorScreen } from "@/components/errors/ErrorScreen";

// Shown when the page frame itself crashes (it replaces the whole layout, so it needs its own html and body).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME} className={fontClassName || undefined}>
      <body>
        <main id="main-content" tabIndex={-1} className="app-main">
          <ErrorScreen error={error} reset={reset} source="app" />
        </main>
      </body>
    </html>
  );
}
