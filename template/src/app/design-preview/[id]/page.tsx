// Shows one look on the real pieces of this app. The Shipyard design step opens it to take screenshots
// before a look is applied. It only exists while building: in production it is a 404.
// It reads .shipyard/design/<id>.preview.json (written by Shipyard, ignored by git). No sign-in, no app data.
import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppShell } from "@/components/AppShell";
import { BRAND } from "@/lib/constants";
import { HOME_PATTERNS } from "@/components/home";
import { isPreviewId, readPreview } from "@/lib/preview.mjs";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Design preview", robots: { index: false, follow: false } };

interface PreviewPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ theme?: string | string[] }>;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The app icon file is one fixed colour, so in a preview every look would show the same blue logo. This draws a
 * monogram (first letter of the app name) in the look's own accent colours and puts it in place of the icon.
 */
function monogramCss(accent: string | undefined, contrast: string | undefined): string {
  if (!accent || !contrast || !HEX_COLOR.test(accent) || !HEX_COLOR.test(contrast)) return "";
  const first = Array.from(BRAND.name.trim())[0] ?? "A";
  const letter = /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : "A";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${accent}"/>` +
    `<text x="32" y="44" text-anchor="middle" font-family="system-ui,sans-serif" font-size="34" font-weight="700" fill="${contrast}">${letter}</text></svg>`;
  return `.theme-scope .app-mark{content:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`;
}

export default async function DesignPreviewPage({ params, searchParams }: PreviewPageProps) {
  if (process.env.NODE_ENV === "production") notFound();
  const { id } = await params;
  if (!isPreviewId(id)) notFound();
  const query = await searchParams;
  const theme = query.theme === "dark" ? "dark" : "light";

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(process.cwd(), ".shipyard", "design", `${id}.preview.json`), "utf8"));
  } catch {
    notFound();
  }
  const preview = readPreview(raw, theme);
  if (!preview) notFound();

  const Home = HOME_PATTERNS[preview.home as keyof typeof HOME_PATTERNS];
  const style: Record<string, string> = { ...preview.vars, colorScheme: theme };
  if (preview.bodyFont) style["--app-font"] = preview.bodyFont;
  if (preview.headingFont) style["--heading-font"] = preview.headingFont;
  // The page is its own document, so the root size and the page colour are set for the whole of it.
  const rootCss = [
    preview.baseSize ? `html{font-size:${preview.baseSize}}` : "",
    preview.background ? `html,body{background:${preview.background}}` : "",
    monogramCss(preview.vars["--accent"], preview.vars["--accent-contrast"]),
  ].join("");

  return (
    <>
      {rootCss ? <style>{rootCss}</style> : null}
      {preview.fontUrls.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <div
        className="theme-scope"
        style={style as CSSProperties}
        data-density={preview.look.density}
        data-cards={preview.look.cards}
        data-buttons={preview.look.buttons}
        data-header={preview.look.header}
        data-layout={preview.layout}
      >
        <AppShell signedIn isAdmin={false} layout={preview.layout as "bottom-nav" | "sidebar" | "top-nav"} activeHref="/">
          <Home />
        </AppShell>
      </div>
    </>
  );
}
