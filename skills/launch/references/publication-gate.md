# Mandatory publication and crawler-safety gate

This is the minimum applicable gate for every new app, publication and app review, including private and internal apps, independent of framework or Shipyard provenance. Read it before framework-specific scripts. Use the app's own build and tests when template scripts do not apply; do not install a new framework just to pass. Read the small relevant references, not every unrelated skill.

## Scope and proof

Before first publication, check the built artifact or preview. After every authorized production deployment, repeat the live checks against the actual production hostname. During any app review, audit the existing deployment and report gaps; **review-only does not authorize fixes or publication**. Nothing here changes permission to commit, push, merge, deploy, submit to a search engine, sign up, spend money or contact anyone.

Write a dated `PUBLICATION-CHECKLIST.md` in an authorized implementation, or return the same table in an audit-only report. Record URL/file, command or method, observed result, commit/deployment where available and status: **PASS / FAIL / PENDING / N/A**. N/A needs a reason; untested means PENDING, never PASS. Evidence from before a fix does not prove the fix. A documentation-contract test checks the instructions, not a deployed app. No completion or publication-readiness claim while required applicable rows fail or remain pending; report deployed-but-not-ready honestly. External account steps may remain PENDING without blocking a precisely qualified claim that the site is deployed, but never call them done.

For private/internal apps, public-discovery checks apply only to any public routes (such as a landing page). Mark inapplicable discovery, public sitemap, social-preview, schema and Search Console rows N/A with reasons. Always check audience/host policy, authentication/authorization, intentional noindex and the applicable security, privacy and regression checks. Do not expose private content to satisfy discovery checks.

## Discovery and crawler safety: required applicable rows

| Check | Evidence needed for PASS |
|---|---|
| Public/private decision | Record the owner's intended audience and production/preview hosts. Public production has no accidental `noindex` in raw HTML, rendered DOM or X-Robots-Tag and no hosting login wall. Private apps and previews intentionally use `noindex`; sensitive content also requires real authentication/authorization. |
| robots.txt | Fetch the production `/robots.txt`: correct status and actual text directives, not HTML or a false-200 SPA fallback. Public pages/assets needed for rendering are crawlable; advertise the absolute sitemap URL. Private policy is intentional. Robots is not authentication or a secrecy mechanism. |
| Sitemap | Fetch `/sitemap.xml`: valid XML, correct content type and absolute canonical URLs of real public indexable pages only. Check listed URLs actually load; exclude login-only, admin, API, redirect and error URLs. For a private app, document an intentionally empty/absent public sitemap. A missing sitemap is FAIL for this public-app baseline, even though Google can discover pages without it. |
| Metadata and language | Each public page has a descriptive title, description and one meaningful H1, a correct absolute canonical URL and correct `lang`. For multilingual content, use crawlable language URLs with reciprocal valid `hreflang` when applicable; a JS-only toggle is not proof of multilingual indexing. Avoid keyword stuffing. |
| Essential content | Inspect raw HTML and the rendered result: purpose, meaningful text, sources and discoverable links are available to crawlers without login, GPS, search submission or other user interaction. Prefer static/server-rendered or pre-rendered essential HTML; if relying on JS, record a rendered-content test and limitations for non-JS bots. Do not assert Google rendered it without URL Inspection evidence. |
| Social preview | Raw HTML has Open Graph and Twitter card title, description, canonical URL and absolute image URL. Fetch the image: HTTP 200, real image MIME and valid supported card dimensions and aspect ratio (1200x630 recommended for a landscape preview), not an HTML fallback, auth wall or relative URL. Check the rendered share card with a suitable preview checker when available; if not checked, mark that subcheck PENDING. |
| Structured data | Use only applicable valid schema reflecting visible content, such as WebSite or SoftwareApplication for a free web app. Validate if present; no invented ratings, reviews, availability or event dates, and no claim of guaranteed rich results. Record a reason if no schema applies. |
| Errors and assets | A made-up path returns a genuine 404, not the homepage with 200. Required JS/CSS/images are publicly fetchable; no blanket bot challenge preventing ordinary public crawling. |
| Crawler/security separation | Secrets stay out of browser bundles and git. Auth/admin/private data use real access checks; exposed APIs have appropriate body size and usage limits and rate limits. Check security headers fitted to the app without breaking public resources. Never disable private-route protection to admit crawlers. No automatic AI-bot blocking, blanket bad-bot rule or CAPTCHA: record owner policy and test allowed public access. |
| llms.txt (optional) | If offered, fetch real useful text with truthful current links, not a false-200 SPA shell. Absence is N/A, not a launch failure. It is not a Google indexing or AI Search prerequisite or ranking guarantee. |
| Search Console (account-dependent) | Separately record property coverage/verification, sitemap submission status, and URL Inspection indexing/rendering evidence. Existing verified parent Domain properties can cover subdomains; preserve them and avoid duplicate properties. A DNS TXT or HTML tag alone proves none of these account outcomes. No access means PENDING, not indexed. Submissions/account changes require authorization; no paid service is required. Bing Webmaster Tools is optional. |

Allowing crawling is not a promise of indexing, traffic, ranking or timing. A `site:` search with no result is not conclusive evidence of non-indexing.

## Remaining publishing checks: not replaced by SEO

Apply `new-app/references/verify.md`, `new-app/references/build-rules.md`, and this stack's relevant checks. Do not mark an entire category passed because its script exited zero with skips.

- **Build and regression:** exact-head type check where applicable, tests, production build, executed CI (not skipped), independent review of fixes and critical user-flow smoke tests.
- **Usability:** phone and desktop, keyboard/focus and accessible names/contrast, errors/empty states, no console failures or horizontal overflow, inspect actual screenshots. Run the applicable Lighthouse checks (phone and desktop performance 90, accessibility 95, best practices 95, SEO 90; private SEO intentionally excluded), and report measurements rather than assuming them.
- **Security and privacy:** secret scan, correct environment exposure, external data/API terms, privacy disclosures matching actual requests, consent assessment when applicable, data retention/minimization, abuse/cost caps. No tracking installation or consent claim merely because a tool is cookieless.
- **Accounts/data, if present:** sign-up/sign-in/sign-out, session and redirect safety, cross-user isolation and admin authorization; email/reset flows and account deletion. A no-account static finder can mark these N/A with a reason.
- **Legal/content:** applicable privacy/terms/contact details, truthful current dates/list provenance, image/source licences, no placeholder or fabricated claims; legal review remains a separate qualification. Do not invent corporate requirements for a simple free guide.
- **Paid features, only if requested/present:** test payments, cancellation/refunds/webhooks, plan/cost controls and applicable launch legal/business checks. Never enable billing or take a payment as a side effect of this gate.
- **Operations/handoff:** canonical production host/TLS, deploy rollback plan, documented refresh/data limitations, relevant monitoring/backup needs and unresolved checks. Optional analytics, alerts or recurring jobs need their own scope; their absence is not evidence of failure for every static app.

## Authoritative references

- Google JavaScript rendering and pre-rendering: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Robots controls versus indexing/security: https://developers.google.com/search/docs/crawling-indexing/robots/intro
- Sitemaps: https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview
- AI Search needs no special AI text file: https://developers.google.com/search/docs/appearance/ai-features
- Search Console Domain properties: https://support.google.com/webmasters/answer/9008080

See `seo-performance.md` for more detail and `search-console.md` for authorized account steps. Do not follow older setup prose as permission to broaden an audit-only request.
