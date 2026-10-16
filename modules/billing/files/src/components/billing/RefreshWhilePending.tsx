"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Right after paying, the plan shows up a few seconds later. Reload the page data a few times until it does. */
export function RefreshWhilePending({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= 8) window.clearInterval(timer);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return null;
}
