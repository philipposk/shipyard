import { AppHeader } from "./AppHeader";
import { BottomNav } from "./BottomNav";
import { SidebarShell } from "./SidebarShell";
import { TopNavShell } from "./TopNavShell";
import { LAYOUT, type Layout } from "@/lib/constants";
import { getIsAdmin } from "@/lib/session";

interface AppShellProps {
  children: React.ReactNode;
  /** Signed-in pages get the full navigation (tab bar, sidebar or top links, see LAYOUT in constants.ts). */
  signedIn?: boolean;
  /** Email or name shown in the account menu. */
  userLabel?: string;
  /** Set false to hide the navigation, for example while someone finishes their profile. */
  nav?: boolean;
  /** Show a different layout than the app's own. Used by the design preview. */
  layout?: Layout;
  /** Page to mark as the current one in the navigation. Used by the design preview. */
  activeHref?: string;
  /** Show the admin links in the account menu. Normally left out: signed-in pages look it up themselves. */
  isAdmin?: boolean;
}

/**
 * Wraps every page. Public pages (and signed-in pages with nav={false}) get a simple top bar.
 * Signed-in pages get the layout chosen when the app was created: "bottom-nav", "sidebar" or "top-nav".
 */
export async function AppShell({ children, signedIn = false, userLabel, nav = true, layout = LAYOUT, activeHref, isAdmin }: AppShellProps) {
  // Only signed-in pages with a menu need to know. The design preview passes isAdmin={false} so it needs no database.
  const admin = isAdmin ?? (signedIn && nav ? await getIsAdmin() : false);

  if (!signedIn || !nav) {
    return (
      <>
        <AppHeader signedIn={signedIn} menu={nav} layout={layout} isAdmin={admin} />
        <main id="main-content" tabIndex={-1} className="app-main">
          {children}
        </main>
      </>
    );
  }

  if (layout === "sidebar") {
    return (
      <SidebarShell userLabel={userLabel} activeHref={activeHref} isAdmin={admin}>
        {children}
      </SidebarShell>
    );
  }

  if (layout === "top-nav") {
    return (
      <TopNavShell userLabel={userLabel} activeHref={activeHref} isAdmin={admin}>
        {children}
      </TopNavShell>
    );
  }

  return (
    <>
      <AppHeader signedIn isAdmin={admin} />
      <main id="main-content" tabIndex={-1} className="app-main">
        {children}
      </main>
      <BottomNav activeHref={activeHref} />
    </>
  );
}
