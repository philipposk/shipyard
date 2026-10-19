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

/** One line in the picture of the app: what the row says and a short word on the right (a day, a state). */
export interface HomePreviewRow {
  title: string;
  meta: string;
}

/**
 * The picture of the app on the home page (split pattern). Write what a signed-in person really sees on the
 * app's main screen: sample content OF THE APP (a note, a task, a booking), never the site's own menu links.
 * It is only a drawing, so nothing in it is clickable.
 */
export interface HomePreview {
  /** The name of the main screen, for example "Your list". */
  title: string;
  /** Three to five rows. */
  rows: readonly HomePreviewRow[];
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
  /** Sample content of the app's main screen, drawn as a picture. */
  preview: HomePreview;
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
  preview: {
    title: "Your list",
    rows: [
      { title: "Plan the week", meta: "Today" },
      { title: "Book the dentist", meta: "Tomorrow" },
      { title: "Ideas for the weekend", meta: "Saved" },
    ],
  },
};
