# Search engines and speed (before and after going live)

Ported from 6x7-app-factory's `checklists/seo.md` and `checklists/performance.md` (lessons from the 6x7 launches), minus what Shipyard's template and `verify.mjs` already do (robots, sitemap, llms.txt, icons, per-page canonical, `poweredByHeader: false`, security headers). Tick each with the student; fix in a pull request.

## Search engines (public apps)

- Unique `<title>` and description per page, one H1 per page, alt text on every image.
- `metadataBase` set from the site address so share images get full URLs; an Open Graph image and Twitter card on the home page.
- JSON-LD `WebSite` and `Organization` in the layout (`Article` on blog posts, breadcrumbs on nested pages).
- `robots` never says `Disallow: /` for the whole site; private routes (`/api/`, `/settings`, `/admin`) are disallowed.
- No duplicate addresses for the same page in the sitemap.
- Google Search Console: the student adds a URL-prefix property for the live domain, verifies it (HTML file or meta tag; the proxy must not redirect the verification file to sign-in), submits `sitemap.xml`, and runs URL Inspection on the home page. Age gates and sign-in walls must let the home page be read.
- Private apps: `noindex` everywhere and an empty sitemap instead.

## Speed

- `next/image` for photos, lazy loading below the fold, subset fonts (`subsets: ["latin"]`).
- Fetch in parallel; no query per list row; select only the columns a page shows.
- Skeletons or `loading.tsx` on slow routes (not on pages that can answer 404).
- The proxy does not hit the database on every request (cache the check in a cookie).
- Service worker: never cache sign-in routes; bump the cache version on every deploy; serve `/sw.js` with `no-cache`.

## Lighthouse (manual before launch, optional in CI)

Lighthouse is Google's free page scorer. Budgets for public pages: performance 90 on phone, accessibility 95, best practices 95, SEO 90 (private apps: SEO is expected to fail, ignore it).

- **Before launch (always):** `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" <appDir> --only lighthouse` scores `/`, `/about` and `/sign-in` on phone and desktop against the live address and names the failing audits. Or, in the app, `npm run lighthouse -- https://<address>` (Lighthouse CI with `lighthouserc.json`). Fix what it names, redeploy, re-run.
- **In CI (optional, ask the student):** the template ships `.github/workflows/lighthouse.yml`. It runs after each Vercel deploy and by hand; set the repo variable `SITE_URL` to the live address, and `LIGHTHOUSE_SKIP_SEO=true` for a private app. It reports; it does not block merges. If the student does not want it, delete the file; never leave a job that is red on main.
- Common failures seen on the 6x7 apps: unlabeled logo or icon links (link-name), noindex left on from scaffolding (is-crawlable), low colour contrast in a theme, tap targets under 48px, animating non-composited properties (animate transform and opacity only), no Content-Security-Policy (csp-xss), too much JavaScript on the home page (total-byte-weight, unused-javascript).
- Signed-in pages are not covered by the CI job. To score them, run Lighthouse in a signed-in browser (Chrome DevTools > Lighthouse) with the student present.
