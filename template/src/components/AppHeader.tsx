import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { MobileMenu } from "./MobileMenu";
import { SkipLink } from "./SkipLink";
import { AppMark } from "./AppMark";
import { BRAND, LAYOUT, type Layout } from "@/lib/constants";

interface AppHeaderProps {
  signedIn?: boolean;
  /** Hide the ☰ menu (used while someone finishes their profile). */
  menu?: boolean;
  /** Which layout the app uses. Normally left out; the design preview sets it. */
  layout?: Layout;
  /** Add the admin links to the menu. */
  isAdmin?: boolean;
}

const PUBLIC_LINKS = [
  { href: "/about", label: "About" },
  { href: "/help", label: "Help" },
];

export function AppHeader({ signedIn, menu = true, layout = LAYOUT, isAdmin = false }: AppHeaderProps) {
  // Top-nav apps show their links in the bar for visitors on wide screens, like the signed-in bar does.
  if (layout === "top-nav" && !signedIn && menu) {
    return (
      <header className="app-header">
        <SkipLink />
        <div className="tn-in">
          <Link href="/" aria-label={`${BRAND.name} home`} className="app-brand tn-brand">
            <AppMark size={32} />
            <span className="max-[359px]:hidden">{BRAND.name}</span>
          </Link>
          <nav className="tn-nav" aria-label="Main">
            {PUBLIC_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="tn-link">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="tn-actions">
            <ThemeToggle />
            <Link href="/sign-in" className="btn btn-primary tn-signin">
              Sign in
            </Link>
            <div className="tn-menu">
              <MobileMenu signedIn={false} />
            </div>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="app-header">
      <SkipLink />
      <div className="app-header-in">
        <Link href="/" aria-label={`${BRAND.name} home`} className="app-brand">
          <AppMark size={32} />
          <span className="max-[359px]:hidden">{BRAND.name}</span>
        </Link>
        <div className="app-actions">
          <ThemeToggle />
          {menu ? <MobileMenu signedIn={signedIn} isAdmin={isAdmin} /> : null}
        </div>
      </div>
    </header>
  );
}
