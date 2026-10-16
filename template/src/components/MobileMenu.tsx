"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";
import { ADMIN_LINKS } from "@/lib/nav";

interface MobileMenuProps {
  signedIn?: boolean;
  /** Add the admin links (only ever true for admins; the admin pages check again). */
  isAdmin?: boolean;
}

/** The ☰ button in the top bar. Opaque card so text stays readable over any page. */
export function MobileMenu({ signedIn, isAdmin = false }: MobileMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);

  // Close when the page changes (adjusting state during render is the React-approved way to do this).
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const links = signedIn
    ? [{ href: "/settings", label: "Settings" }, ...(isAdmin ? ADMIN_LINKS : [])]
    : [
        { href: "/sign-in", label: "Sign in" },
        { href: "/about", label: "About" },
        { href: "/help", label: "Help" },
      ];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost px-3"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Menu"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <div className="popover absolute right-0 top-full mt-1 min-w-[180px]">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="menu-item">
              {l.label}
            </Link>
          ))}
          {signedIn && <SignOutButton className="menu-item" />}
        </div>
      )}
    </div>
  );
}
