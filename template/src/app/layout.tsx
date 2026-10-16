import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BRAND, SITE_DESCRIPTION, SITE_URL, ENABLE_PWA, SITE_PRIVATE, LAYOUT } from "@/lib/constants";
import { ScrollProgress } from "@/components/ScrollProgress";
import { BackToTop } from "@/components/BackToTop";
import { CookieBanner } from "@/components/CookieBanner";
import { InstallPrompt } from "@/components/InstallPrompt";
import { PwaRegister } from "@/components/PwaRegister";
import { SiteChrome } from "@/components/SiteChrome";
import { DEFAULT_THEME, LOOK, THEME_COLORS } from "@/lib/theme";
import { fontClassName } from "@/lib/fonts";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: BRAND.name, template: `%s | ${BRAND.name}` },
  description: SITE_DESCRIPTION,
  ...(ENABLE_PWA
    ? {
        appleWebApp: { capable: true, statusBarStyle: "default", title: BRAND.shortName },
        manifest: "/manifest.webmanifest",
      }
    : {}),
  openGraph: {
    title: BRAND.name,
    description: BRAND.description,
    url: SITE_URL,
    siteName: BRAND.name,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: BRAND.name }],
    type: "website",
  },
  twitter: { card: "summary_large_image", title: BRAND.name, description: BRAND.description },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
  ...(SITE_PRIVATE ? { robots: { index: false, follow: false, nocache: true } } : {}),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Runs before the page paints, so there is no flash of the wrong theme.
// localStorage "theme" is "light", "dark" or "system" (follow the phone or computer setting).
// When nothing is saved yet, the app's default look from src/lib/theme.ts is used.
const themeScript = `(function(){try{var t=localStorage.getItem('theme')||'${DEFAULT_THEME}';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();`;

// "<" is escaped so text from the app description can never close the script tag.
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: BRAND.name,
  url: SITE_URL,
  description: BRAND.description,
}).replace(/</g, "\\u003c");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      data-layout={LAYOUT}
      data-density={LOOK.density}
      data-cards={LOOK.cards}
      data-buttons={LOOK.buttons}
      data-header={LOOK.header}
      className={fontClassName || undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {ENABLE_PWA ? <meta name="mobile-web-app-capable" content="yes" /> : null}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      </head>
      <body>
        <SiteChrome>
          <ScrollProgress />
          {ENABLE_PWA ? <InstallPrompt /> : null}
        </SiteChrome>
        {children}
        <SiteChrome>
          <BackToTop />
          <CookieBanner />
        </SiteChrome>
        {ENABLE_PWA ? <PwaRegister /> : null}
      </body>
    </html>
  );
}
