/** The one list of main pages. Both layouts (tab bar and sidebar) read it, so add a page here once. */
export type NavIconName = "home" | "items" | "settings" | "info" | "help";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/items", label: "Items", icon: "items" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

/**
 * Pages only admins see, listed in the account menu (not in the tab bar). Each page checks for itself that the
 * person is an admin; this list only decides what to show. Modules add their admin pages here (by the name ADMIN_LINKS).
 */
export const ADMIN_LINKS: readonly { href: string; label: string }[] = [
  { href: "/admin/health", label: "Health" },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
