"use client";

import { usePathname } from "next/navigation";

/** Wraps the floating extras (cookie notice, install banner, back to top) and leaves them out of design previews. */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/design-preview")) return null;
  return <>{children}</>;
}
