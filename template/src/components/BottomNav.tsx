"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./NavIcon";
import { NAV_ITEMS, isActivePath } from "@/lib/nav";

interface BottomNavProps {
  /** CSS class of the bar. "bottom-nav" is always shown; "tn-tabbar" only on phones (top-nav layout). */
  className?: string;
  /** Page to mark as the current one. Normally left out: the address bar decides. */
  activeHref?: string;
}

export function BottomNav({ className = "bottom-nav", activeHref }: BottomNavProps) {
  const pathname = usePathname();
  // The tab just tapped lights up at once, before the next page arrives, so the tap always feels answered.
  // It only counts while we are still on the page it was tapped from, so it clears itself when the page changes.
  const [tapped, setTapped] = useState<{ href: string; from: string } | null>(null);
  const pending = tapped && tapped.from === pathname ? tapped.href : null;
  const current = activeHref ?? pending ?? pathname;

  return (
    <nav className={className} aria-label="Main">
      <div className="grid max-w-[640px] mx-auto" style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, 1fr)` }}>
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(current, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="tab-link"
              aria-current={active ? "page" : undefined}
              data-pending={pending === item.href ? "" : undefined}
              onClick={(e) => {
                // A click that opens a new tab or window does not leave this page, so it must not light the tab.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                if (!isActivePath(pathname, item.href)) setTapped({ href: item.href, from: pathname });
              }}
            >
              <NavIcon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
