"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppMark } from "./AppMark";
import { BottomNav } from "./BottomNav";
import { MobileMenu } from "./MobileMenu";
import { SignOutButton } from "./SignOutButton";
import { SkipLink } from "./SkipLink";
import { ThemeToggle } from "./ThemeToggle";
import { BRAND } from "@/lib/constants";
import { ADMIN_LINKS, NAV_ITEMS, isActivePath } from "@/lib/nav";

interface TopNavShellProps {
  children: React.ReactNode;
  /** Shown in the account menu. */
  userLabel?: string;
  /** Page to mark as the current one. Normally left out: the address bar decides. */
  activeHref?: string;
  /** Add the admin links to the account menu. */
  isAdmin?: boolean;
}

/**
 * Links in the top bar on screens 768px and wider (name on the left, pages next to it, account on the right),
 * with the page centred at the content width. On phones it turns into the top bar plus a tab bar at the bottom.
 */
export function TopNavShell({ children, userLabel, activeHref, isAdmin = false }: TopNavShellProps) {
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
    <>
      <header className="app-header">
        <SkipLink />
        <div className="tn-in">
          <Link href="/" aria-label={`${BRAND.name} home`} className="app-brand tn-brand">
            <AppMark size={32} />
            <span className="max-[359px]:hidden">{BRAND.name}</span>
          </Link>
          <nav className="tn-nav" aria-label="Main">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="tn-link"
                aria-current={isActivePath(current, item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="tn-actions">
            <ThemeToggle />
            <div className="tn-account" ref={menuRef}>
              <button
                type="button"
                className="btn btn-ghost px-2"
                aria-haspopup="true"
                aria-expanded={menuOpen}
                aria-label="Account"
                onClick={() => setMenuOpen((o) => !o)}
              >
                <span
                  className="grid place-items-center rounded-full font-bold shrink-0"
                  style={{ width: 30, height: 30, background: "var(--accent-soft)", color: "var(--accent-text)", fontSize: 13 }}
                  aria-hidden="true"
                >
                  {(userLabel?.trim()[0] ?? "A").toUpperCase()}
                </span>
              </button>
              {menuOpen && (
                <div className="popover tn-account-menu">
                  {userLabel ? <p className="muted m-0 px-3 py-2 text-sm truncate">{userLabel}</p> : null}
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
            <div className="tn-menu">
              <MobileMenu signedIn isAdmin={isAdmin} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="tn-main">
        {children}
      </main>

      <BottomNav className="tn-tabbar" activeHref={activeHref} />
    </>
  );
}
