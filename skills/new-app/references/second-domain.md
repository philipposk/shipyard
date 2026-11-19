# A second domain for the same app (a mirror such as `<slug>.6x7.dk`)

Every app can also be served on a second domain (the `.dk` mirror of `<slug>.6x7.gr`). It is the same Vercel project with a second domain attached, so no code is copied. Four things break or go wrong if the app was not written for it. Build for them from the start.

1. **Sign-in must follow the address the person is on.**
   - Build OAuth, magic-link and reset redirects from `window.location.origin` (browser) or the request origin (server), never from a fixed `SITE_URL` or `NEXT_PUBLIC_*_URL`. A redirect to the other domain loses the PKCE verifier and the session.
   - Login cookies: keep them host-only (the template has no `domain`). A shared `domain=.6x7.gr` cookie is not sent on `.dk`; if an app needs single sign-on across subdomains, pick the cookie domain from the request host (`.6x7.gr` for `.gr`, `.6x7.dk` for `.dk`).
   - Links in emails sent by the server may stay on the primary domain.
2. **Register the address in two places, or sign-in fails.**
   - Supabase, Authentication, URL Configuration, Redirect URLs: `https://*.6x7.dk/**` next to `https://*.6x7.gr/**`. Without it Supabase sends people to the Site URL instead.
   - Google Cloud Console, the OAuth client behind Google sign-in, Authorized JavaScript origins: one entry per address (`https://<slug>.6x7.dk`). Google does not allow wildcards. A missing origin shows `Error 400: origin_mismatch` when the Google button is clicked. The Supabase redirect URI stays the same.
   - Until the origin is registered, `GoogleIdentityButton` uses the redirect button on that host (`GIS_UNREGISTERED_ORIGIN`). Remove the host from that pattern when the origin has been added.
3. **One canonical address.** The mirror must tell search engines the primary address is the real one: `metadataBase` and `alternates.canonical` built from the fixed primary `SITE_URL` (not the request host), `og:url` the same, `robots.txt` and `sitemap.xml` listing primary URLs only. A static site gets the same from `vercel.json`: a `Link: <https://<slug>.6x7.gr/$1>; rel="canonical"` header on the mirror host.
4. **Hard-coded hosts.** Search the app for the primary host in CSP, CORS, CSRF/origin checks and middleware, and allow the mirror too (`isSameOrigin` already trusts the request's own origin).

Check, on the mirror address: the page loads, the canonical tag points to the primary address, sign-in works (Google and email), and robots.txt and sitemap.xml contain no mirror URLs.
