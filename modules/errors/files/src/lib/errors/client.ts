// Runs in the browser. Sends a short note about a crashed page to /api/errors so the owner finds out.
// Never throws, never sends more than the message, the page path and Next's short error code.

const sent = new Set<string>();

export function reportClientError(error: Error & { digest?: string }, source: "page" | "app" = "page"): void {
  try {
    const message = String(error?.message ?? "Unknown error").slice(0, 500);
    const route = window.location.pathname;
    const once = `${route}|${message}`;
    // A page that crashes again after "Try again" is still one problem.
    if (sent.has(once)) return;
    sent.add(once);
    void fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, route, digest: error?.digest, source }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never be a second problem.
  }
}
