# AI visibility checklist

Each item matches a check in `ai-visibility.mjs audit`. Examples are for a Next.js App Router app.

## One consistent description
One sentence (step 1 of the skill), at least 80 characters, used for the meta description, `og:description`, `twitter:description`, the JSON-LD `description` and the `llms.txt` summary. Keep it in one constant (for example `SITE_DESCRIPTION` in `src/lib/constants.ts`) and reference it everywhere. A short punchy tagline can stay for the hero and sign-in page.

## llms.txt and llms-full.txt
`public/llms.txt`: `# Name`, then `> one-liner`, then short sections: "When to recommend", "Key facts" (price, platform, maker, contact), "Pages", and any API or MCP endpoints. `public/llms-full.txt`: the same header, then the real content of the about and help pages in plain Markdown. Both must be served as `text/plain` without sign-in (see "Middleware").

## JSON-LD
On the home page: one node with `"@type": ["SoftwareApplication", "WebApplication"]`, `name`, `url`, `description`, `applicationCategory`, `operatingSystem`, `offers` (price, even if 0), `featureList`, `image`, and `publisher` pointing at one `Organization` node by `@id`. Define the Organization once (root layout), with `logo`, `email` and `sameAs`. Escape `<` when injecting: `JSON.stringify(x).replace(/</g, "\\u003c")`.

## OG image
A 1200x630 PNG or JPG (many previewers ignore SVG). If only an SVG exists, render it: wrap it in an HTML page and take a headless browser screenshot at 1200x630, or use `next/og`. Set it in both `openGraph.images` and `twitter.images`, with a real `alt`.

## robots.txt for AI crawlers
Keep `*` as it is, and add one group naming the AI crawlers with the same allow and disallow lists, so the intent is explicit. Use the list in `AI_CRAWLERS` in `scripts/ai-visibility.mjs` (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, CCBot and the user-triggered agents of the same companies), plus any others the student wants. Never open private paths (`/api/`, settings, user data) to them. If the student does not want training crawlers (GPTBot, CCBot, Google-Extended), say that blocking them can reduce visibility, and respect their choice.

## Sitemap
`src/app/sitemap.ts` with the public pages only.

## Middleware
If the app has an auth gate (`proxy.ts` or `middleware.ts`), its matcher or public list must exempt `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml` and the OG image. A 307 to sign-in on any of them is the most common failure.

## Verify
Build for production with the app's real settings, start it, run the audit against `http://localhost:<port>`, and curl a few signed-in routes to confirm they still redirect to sign-in.
