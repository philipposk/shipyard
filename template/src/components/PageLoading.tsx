import { AppShell } from "./AppShell";
import { CardSkeleton, ListSkeleton } from "./LoadingSkeleton";

/**
 * Shown the moment someone taps a tab, while the server builds the next signed-in page.
 * Without it the old page stays on screen until the new one is ready, which feels slow on phones.
 * Next.js also prefetches this shell, so the switch is instant. It makes no database calls
 * (isAdmin={false}), so it never slows the real page down.
 * Use it from a route's loading.tsx: `export default function Loading() { return <PageLoading />; }`
 */
export function PageLoading({ rows = 3 }: { rows?: number }) {
  return (
    <AppShell signedIn isAdmin={false}>
      <div className="page-header">
        <div className="skeleton h-7 w-40" aria-hidden="true" />
      </div>
      <div className="space-y-4">
        <CardSkeleton />
        <ListSkeleton count={rows} />
      </div>
    </AppShell>
  );
}
