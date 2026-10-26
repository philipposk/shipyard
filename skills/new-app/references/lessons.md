# Lessons

One line each. A star means `verify.mjs` or the app's own tests check it automatically. Add new ones to `~/.shipyard/learnings.md`.

## Sign-in and security
- ★ Never set a password from an email address alone (account takeover).
- ★ The login cookie name in `proxy.ts` must match the one Supabase sets; otherwise sign-in appears to work and then loops. Do not share a cookie across domains you do not control.
- ★ Next.js 16 renamed `middleware.ts` to `proxy.ts`. All `/api/auth/*` routes must be public in it or sign-up answers 405 or shows the sign-in page.
- ★ Sign out with `{ scope: "local" }`. Supabase's default is global: it ends the person's sessions on every device and in every app on a shared project.
- ★ `/api/health` is public, skips the sign-in check, and reads one database row with a 5 second limit (503 on failure, no user data). Answering 200 without asking the database hides an outage. `/auth/v1/health` can say OK while the database is stuck.
- ★ Browser sign-in calls (`/auth/v1/`) give up after about 20 seconds and the sign-in page says it is not responding. Proxy and server sign-in checks give up after 3 seconds each and 5 seconds overall. Storage uploads are never timed out.
- ★ Every new table has an explicit grant: `service_role`, and either `authenticated` or `revoke all` from `authenticated` for a server-only table. From 30 Oct 2026 Supabase does not grant new `public` tables. Do not grant `anon`. A cron schedule that runs more than once an hour fails the same test.
- ★ Row level security update rules must limit columns, or a user can make themself admin.
- ★ Admin comes from a database flag only the server key can set, never from an email address. Starter-mode sign-up does not prove the person owns the email, so an email match would hand admin to the first stranger who types the owner's address.
- ★ The secret server key skips every privacy rule. A route that uses it and does `select *` without a user filter hands out everyone's rows even when every table has RLS. Use the signed-in person's own client.
- ★ A "finished setup" cookie (onboarding, age check, consent) is signed with a server secret and bound to the user id (`<userId>.<HMAC>`, `src/lib/auth/onboarded-cookie.mjs`). A plain `1` or bare user id can be typed into the browser to skip setup. API routes enforce the same gate (403 `onboarding_required`), not only pages, or a script skips the setup page.
- A column people may write but only under a rule (an `onboarding_complete` flag that needs a name first, counters, plan, Stripe ids) needs the rule on the server: the route sets it only after checking the required fields and never lets the client set it back, and a `before update` trigger (or no grant at all) stops a direct write with the browser key. Write counters and billing columns with the server key, filtered to the person's id.
- ★ Never put a wildcard host (`https://<app>-*.vercel.app/**`) in Supabase's redirect list: anyone can register a matching address and receive sign-in tokens.
- ★ Policies run once per row: write `(select auth.uid())`, never a bare `auth.uid()`, and check membership as `col in (select private.allowed_ids())`, never `has_access(col)`. Index the columns policies compare. The `schema-rules` test flags it; `skills/review/references/rls-speed.mjs` checks a live project.
- Views ignore RLS unless `with (security_invoker = true)`; a policy without `to authenticated` applies to visitors who are not signed in; security definer functions must be revoked from public, anon and authenticated. The app's `schema-rules` test checks all three.
- A key deleted in the next commit is still in the history that gets pushed. The pre-push hook and CI scan every pushed commit, not just the files on disk.
- Account-level keys (Supabase access token) never go into an app's hosting settings.
- ★ No secrets in `NEXT_PUBLIC_*` variables. `.env*` stays ignored by git. Scan for keys before every push.
- ★ A one-time token is never used on a GET. Mail scanners open every link in an email and use the token up (the person sees "link expired"), and a crafted link can sign a visitor into the sender's account. The link opens a page with one button, and the button POSTs. `/auth/confirm` does this.
- No change on a GET at all (sign-out, delete, join links, auto-join): link previews, prefetch and image tags fire GETs.
- Limits on what strangers can trigger (sign-up, emails sent) must never lock out someone who already has an account. A cap per email address lets anyone block a person by typing their address; key on the caller's IP and answer identically whether or not the account exists.
- Build links sent by email from the configured site address, never from the Host header. Check redirect targets are on the same site.
- Supabase: only ever add redirect URLs, never change the Site URL of a project other apps use. Split large login cookies (over about 3.2 KB).
- Google sign-in redirects to `https://<project>.supabase.co/auth/v1/callback`, not the app's address. Hide the button if the client id is missing.
- Supabase's built-in mailer is for testing: very few emails an hour. Real sign-up email needs your own provider and a verified domain.

## Offline copies and shared sign-in
- With one sign-in across subdomains, signing in as someone else in any app switches the session under every open tab, with no event in those tabs. An offline copy checks the session's user id before every sync and queued write, sends each request with that checked token, and opens the other account's own copy on a mismatch. Otherwise it syncs one account's list into the other's copy and wipes it. Details and the rest of the rules: `shared-sign-in.md`, "Data kept on the device".
- A sync that pulls only "changed since last time" also re-fetches rows the server has and the device lacks, so a copy damaged by any bug repairs itself.
- Same person, two accounts: Google and email with one address are one account, but a second Google account or Apple "Hide My Email" is a new, empty one. Show the signed-in email in the app.
- Never tell people to "Clear site data" to fix one app on a shared domain: it wipes every app's saved data there. Delete that app's own IndexedDB database instead.

## Deploy and hosting
- ★ Deployment Protection must be off, or every visitor gets 401.
- ★ Verify on the real address, not "Vercel says ready".
- Commit and push before deploying, and check the deployed commit matches. A deploy from unsaved local files followed by an automatic deploy from GitHub can silently roll the site back.
- `vercel env add` needs an explicit type for `NEXT_PUBLIC_*` values; preview environment values need a branch name, so Shipyard sets production and development only.
- A production deploy can end up staged and not live; check the address, and set the alias if needed.
- Vercel Hobby allows 100 deploys a day: skip deploys for data-only commits.
- Free Supabase projects pause after a week of no use; wake it in the dashboard before testing.
- A shared Supabase project has one disk IO budget. A job every minute, a new realtime feed, or tight polling can use it up and stall every app. Sign-in then hangs with no error. Check project health before the browser. Restart does not refill the budget. Filter `noreply@supabase.com` to starred and important.
- Vercel Hobby forbids commercial use, including taking payments.
- ★ Vercel Hobby has 4 hours of server CPU a month across all your apps, and going over stops all of them for up to 30 days. The rules are in `build-rules.md`, "Hosting costs".
- Crawlers can cost more than visitors. Search crawlers (Googlebot, Bingbot, OAI-SearchBot, PerplexityBot) and link previews (facebookexternalhit) bring people in, so keep them. AI training and SEO crawlers (Amazonbot, KeenableBot, MJ12bot, ElevenlabsCrawler, GPTBot, meta-externalagent, Bytespider, CCBot, AhrefsBot, SemrushBot, DotBot, PetalBot) bring almost nobody. Other AI companies run both kinds too: read their crawler pages for the exact names. Deny them with a Vercel firewall rule on `user_agent`: it stops them before the server wakes, needs no deploy, and is free. `robots.txt` is only a request.
- Changing a domain: payment webhooks do not follow redirects. Register the new endpoint first and use 308 redirects.
- When the app lives in a subfolder of its repo, set the Vercel project's Root Directory to that folder. Without it the build can pass and every page is a 404.
- Create SDK clients (Stripe, OpenAI, Resend, the server Supabase client) inside a function on first use, never at the top of a file. `next build` loads every route, so a top-level client breaks every preview and CI build that lacks the key. `verify` warns.
- Apps with a root `api/` folder (Vite, plain Node): every file in it is a separate Vercel function and Hobby allows 12. Put helpers in `api/_lib/`. In a `"type": "module"` package, relative imports need the `.js` extension (also in `.ts` files) or the function fails at runtime. `verify` warns on both.
- Every serverless function has a hard time limit (300 s on Vercel). A request that runs into it is killed before its `catch` runs, so the row stays "processing" forever. Give each outside call an abort timeout that leaves time to save the result or the error.

## Building
- ★ Supabase returns at most 1000 rows per request and says nothing. Lists, totals and leaderboards need paging (`fetchAll` in the template) and an `ORDER BY`, or they show a random 1000.
- Games and scores: the server works out and stores score, streak and "is it correct". Answers never go into the browser bundle, the first page load, or archive and preview pages, or players read them and win in one guess. When a question is reused, lock the earlier days that used it.
- One canonical tag in the layout tells search engines every page is a copy of the home page. Set `alternates.canonical` per page.
- A `loading.tsx` on a route that calls `notFound()` makes the 404 a 200 (streaming). Only add loading screens to routes that never say "not found".
- `overflow-x: hidden` on `html` and `body` turns the page into a scroll container, so sticky headers and bottom bars stop sticking. Use `overflow-x: clip`.
- Sheets and menus opened from a sticky header get trapped under the bottom bar: render them with `createPortal` into `document.body`. A fixed cookie notice can cover an on-screen keyboard or a bottom input.
- Dark mode "Auto" must follow the phone's setting, not stay light. The theme script and toggle handle it; do not replace them with a fixed theme.
- After you fix problems found in a review, review the fixed code again before launch. Fixes bring new bugs.
- Scripts must work on Windows and macOS: avoid bash-only syntax.
- Test with a real second account, not only simulated sessions.
- Test passwords containing `$` and `!` through code, not through a shell, which rewrites them.
- Phone: use `100dvh` and safe-area padding, pin chat inputs to the bottom, never rely on hover.
- A stale service worker can show old pages: it should cache only static files, never pages or data.
- OpenRouter: some models reject the `temperature` setting when `require_parameters` is on; drop it.
- OpenAI voice can take 30 seconds: longer timeout and cache the audio.
- Webhooks: verify the signature, store event ids, ignore out-of-order events.
- Payment webhooks: write the event id down only after the change is saved, re-read the subscription from Stripe instead of trusting the event copy, and answer 500 on any database error so Stripe retries. The event-id table has RLS on and no grants for the browser roles. (The billing module does all this.)
- Webhooks out to an address the person typed: https only, port 443, resolve the name and refuse if any address is private (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fc00::/7, IPv4-mapped IPv6), connect to the checked IP (no second lookup), no redirects, a timeout and a response size cap. Check at save time and again at send time.
- Tokens for agents and scripts expire: short access tokens with rotating refresh tokens (a reused refresh token revokes the whole family), personal tokens with a chosen lifetime and "last used", and per-IP / per-token rate limits answering 429 with `Retry-After`.
- Analytics (PostHog, GA) starts only after the visitor accepts it; withdrawing is one click in Settings and the footer and stops capture at once.
- A paid plan whose payments are not set up yet shows a disabled "Coming soon" button, never a checkout that cannot finish.
- Spend limits at every AI provider, plus a daily cap in the app.
- Fallback across AI providers: when a provider answers "out of credits" or 401/402/403, skip it for about 15 minutes so the next requests go straight to the next one instead of uploading to a provider that will refuse. Tell the user it is the service's limit, not their own minutes.
- Long sessions (live transcripts, chats, editors): never rewrite the whole record on every save. Store new lines append-only in a child table and keep the parent row small. A realtime subscription sends the whole row on every change, so poll one small column, or check `updated_at` before reading the full row.
- The last save of a long session retries network errors and 401/408/429/5xx with backoff. If it still fails, the data stays in the tab with a Retry button and a warning before closing. Plan limits are enforced during the session too, not only at the start.
- Ship a costly or risky AI feature dark: a server-side list of user ids in an environment variable (unset means off for everyone), checked before any model call.
- A file dropped anywhere on the page should start the upload. A drop zone that only exists inside a closed dialog lets the browser open the file and leave the app.
- Formats browsers and speech-to-text services can't read (WMA, AMR, AIFF, CAF): convert to MP3 on the server (ffmpeg) before sending, and keep the MP3 so the player works.
- Optimistic send plus polling can show a message twice; dedupe by id.
- A share button that only copies, with a short message at the bottom of the screen, feels broken. Change the button itself to "Copied!", use the share sheet on phones, and fall back to a copy-by-hand box when the browser blocks copying.
- Pop-up messages (toasts) go straight under `<body>` (a React portal) with their own animation; inside a moving or transformed parent, "fixed" stops meaning the screen, and an animation that ends in `transform: none` breaks the centring.
- Leaderboards and group stats must include things done late (archive days), marked as late. Keep streaks for on-the-day only and say so in the help text.
- A daily-content app with an empty archive at launch has nothing to do after day one: ship a back catalogue, with every fact sourced.

## Working with the agent
- A helper agent's "passed" is not evidence. Re-run the flow that was reported broken before saying done.
- Keys pasted into the chat are saved in transcripts. Rotate any key that was pasted.
- Say what was not verified.

## From a full review of a big app (Oct 2026)
- ★ `next build` type-checks test files that `node --test` does not. CI must run `tsc --noEmit` before the tests, or a typo in a test breaks the production deploy. Next 16 removed `next lint`.
- ★ A signed-out `/api/*` call must answer 401 JSON. A redirect to sign-in looks like success to `fetch` (it follows it and gets a 200 page).
- Never "simplify" the deploy build script during a cleanup. Verify on a local production build with placeholder keys when previews lack the database settings.
- A server-key delete steered by a path the person can write must check the prefix first, or one crafted row deletes someone else's files.
- AI proxies: allowlist the model, rate-limit per person, cap the body. An MCP batch of 1000 calls in one request must not cost one rate-limit unit.
- `map[userKey]` finds `__proto__` and `constructor`; use `Object.hasOwn`.
- Deleting data must not reset monthly quotas, or delete and re-upload is unlimited use.
- Debounced saves lose the last edit when the tab closes unless they flush on `pagehide`. Seeking a video before `loadedmetadata` is ignored. Chunked upload parts need a size cap.
- `:root:is(...) button:not([class])` in a theme outranks menu and toggle buttons.
- A big review found 117 real problems, and a second review of the fixes found 14 new ones. Review the fixes, not only the code.
- Pull requests over 150 files are skipped by CodeRabbit's free plan: stack them, and smoke-test between merges. The full procedure is the review skill's `references/ship.md` ("Stacked pull requests").
- Tabs as plain `<a>` reload the whole page on every tap: `next/link`, an optimistic active tab and `loading.tsx` skeletons cut Catchy's switches from ~360 to ~145 ms (see review/references/speed.md).
