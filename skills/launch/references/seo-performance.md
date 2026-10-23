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
- Lighthouse on mobile above 90 after launch; fix the top item it names.
