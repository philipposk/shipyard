# Google Search Console: verify once, cover every subdomain

Use after the app is public (no `noindex`, see `seo-performance.md`). Placeholders: `<your-domain>` (e.g. `example.com`), `<dns-provider>` (where the domain's DNS records live: the registrar, Cloudflare, Vercel DNS, Route 53...).

## Agent rule: try first, ask last

Before asking the student to do anything, try it yourself in the browser session you already have (Search Console, the DNS provider's dashboard). Often the student is already signed in there. Ask only for the one step you really cannot do (a sign-in with a password or a second factor), say exactly which page and button, and never ask for a password in chat: let them type it into the page.

## 1. Prefer a Domain property

In Search Console > Add property, choose **Domain** (not URL prefix) and enter `<your-domain>` with no `https://` and no `www`. One Domain property covers `https`, `http`, `www` and every subdomain (`app1.<your-domain>`, `app2.<your-domain>`...), so new apps on the domain are covered with no new verification. Use a URL-prefix property only when you cannot edit DNS (then verify with the HTML file or meta tag, and make sure the proxy does not redirect that file to sign-in).

## 2. Add the TXT record at `<dns-provider>`

Search Console shows a value like `google-site-verification=...`. Copy it exactly.

1. Find where the DNS records live: check the domain's nameservers (`dig NS <your-domain> +short`). That company is `<dns-provider>`, even if you bought the domain elsewhere.
2. In its dashboard the records are usually under *DNS*, *DNS management*, *DNS zone*, *Advanced DNS* or *Records* for the domain.
3. Add a **new** record: type `TXT`, host/name `@` (some providers want it blank, or the full `<your-domain>.`; all three mean the root), value = the Google string, TTL default.
4. **Never edit or delete existing records.** Other TXT records (SPF `v=spf1`, DKIM, other verifications) stay as they are; a domain can have many TXT records. Do not touch A, CNAME or MX records.
5. Check it is live: `dig TXT <your-domain> +short` shows the Google string (can take minutes, rarely hours). Then press **Verify** in Search Console.
6. **Keep the record after verifying.** Google re-checks it; deleting it unverifies the property.

## 3. Submit sitemaps and request indexing

- Sitemaps (left menu): submit the full URL of each app's sitemap, e.g. `https://<your-domain>/sitemap.xml` and `https://app1.<your-domain>/sitemap.xml`. Status should become "Success"; "Couldn't fetch" usually means the proxy or an auth wall blocks it.
- URL Inspection: paste each app's home page, then **Request indexing**. Do it for the landing page of each app, not every page (the sitemap handles the rest).
- Check back after a few days: Pages report > "Why pages aren't indexed". "Excluded by noindex" on a public app means a `noindex` was left on.
