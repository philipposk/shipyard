"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppMark } from "./AppMark";
import { NavIcon } from "./NavIcon";
import { SkipLink } from "./SkipLink";
import { MobileMenu } from "./MobileMenu";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import { BRAND } from "@/lib/constants";
import { ADMIN_LINKS, NAV_ITEMS, isActivePath } from "@/lib/nav";

interface SidebarShellProps {
  children: React.ReactNode;
  /** Shown in the account menu at the bottom of the sidebar. */
  userLabel?: string;
  /** Page to mark as the current one. Normally left out: the address bar decides. */
  activeHref?: string;
  /** Add the admin links to the account menu. */
  isAdmin?: boolean;
}

/**
 * Left sidebar on screens 1024px and wider (logo, pages, theme, account menu).
 * On phones the sidebar turns into a small top bar (name, theme, account menu) plus a tab bar at the bottom,
 * built from the same page list.
 */
export function SidebarShell({ children, userLabel, activeHref, isAdmin = false }: SidebarShellProps) {
  const pathname = usePathname();
  const current = activeHref ?? pathname;
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  const menuRef = useRef<HTMLDivElement>(null);

  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div>
      <SkipLink />
      <aside className="sb-side" aria-label="Sidebar">
        <Link href="/" className="sb-brand" title={BRAND.name}>
          <AppMark size={30} />
          <span>{BRAND.name}</span>
        </Link>
        <nav className="sb-nav" aria-label="Main">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(current, item.href);
            return (
              <Link key={item.href} href={item.href} className="sb-link" aria-current={active ? "page" : undefined}>
                <NavIcon name={item.icon} size={20} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sb-foot">
          <ThemeToggle showLabel />
          <div className="sb-user" ref={menuRef}>
            <button
              type="button"
              className="menu-item"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span
                className="grid place-items-center rounded-full font-bold shrink-0"
                style={{ width: 28, height: 28, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 13 }}
                aria-hidden="true"
              >
                {(userLabel?.trim()[0] ?? "A").toUpperCase()}
              </span>
              <span className="min-w-0 truncate">{userLabel ?? "Account"}</span>
            </button>
            {menuOpen && (
              <div className="popover sb-user-menu">
                <Link href="/settings" className="menu-item">
                  Settings
                </Link>
                {isAdmin &&
                  ADMIN_LINKS.map((l) => (
                    <Link key={l.href} href={l.href} className="menu-item">
                      {l.label}
                    </Link>
                  ))}
                <SignOutButton className="menu-item" />
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="sb-main">
        <header className="sb-topbar">
          <Link href="/" aria-label={`${BRAND.name} home`} className="app-brand">
            <AppMark size={32} />
            <span className="max-[359px]:hidden">{BRAND.name}</span>
          </Link>
          <div className="app-actions">
            <ThemeToggle />
            <MobileMenu signedIn isAdmin={isAdmin} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="sb-content">
          {children}
        </main>
      </div>

      <nav className="sb-tabbar" aria-label="Main">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, 1fr)` }}>
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
    </div>
  );
}
