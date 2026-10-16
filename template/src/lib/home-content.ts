// All the words on the public home page (what visitors see at "/" before they sign in).
// The design step picks the pattern (HOME_STYLE in theme.ts); this file holds the text for every pattern.
// Change the text here and nowhere else. Write real sentences about this app: no made-up numbers or reviews.
import { BRAND } from "@/lib/constants";
import type { NavIconName } from "@/lib/nav";

export interface HomeLink {
  label: string;
  href: string;
}

export interface HomePoint {
  title: string;
  text: string;
}

/** One line of the contents list (editorial and list patterns) or one card (cards pattern). */
export interface HomeEntry {
  /** Small label above the title, for example the kind of page. */
  kicker: string;
  title: string;
  blurb: string;
  href: string;
  icon: NavIconName;
}

export interface HomeContent {
  headline: string;
  subline: string;
  ctaPrimary: HomeLink;
  ctaSecondary: HomeLink;
  /** Exactly three short points. */
  points: readonly [HomePoint, HomePoint, HomePoint];
  /** Three to six entries. */
  entries: readonly HomeEntry[];
}

export const HOME: HomeContent = {
  headline: BRAND.name,
  subline: BRAND.tagline,
  ctaPrimary: { label: "Get started", href: "/sign-in" },
  ctaSecondary: { label: "Learn more", href: "/about" },
  points: [
    { title: "Yours alone", text: "Everything you add stays private to your account." },
    { title: "On every screen", text: "Works in the browser on your phone and your computer." },
    { title: "Light or dark", text: "Pick the look that is easy on your eyes." },
  ],
  entries: [
    { kicker: "Your space", title: "Items", blurb: "Add things and keep them in one place.", href: "/items", icon: "items" },
    { kicker: "About", title: `What ${BRAND.name} is`, blurb: "A short description of this app.", href: "/about", icon: "info" },
    { kicker: "Help", title: "Questions and answers", blurb: "Find help signing in or get in touch.", href: "/help", icon: "help" },
  ],
};
