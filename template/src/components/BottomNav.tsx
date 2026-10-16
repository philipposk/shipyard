"use client";

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
  const current = activeHref ?? pathname;

  return (
    <nav className={className} aria-label="Main">
      <div className="grid max-w-[640px] mx-auto" style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, 1fr)` }}>
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(current, item.href);
          return (
            <Link key={item.href} href={item.href} className="tab-link" aria-current={active ? "page" : undefined}>
              <NavIcon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
