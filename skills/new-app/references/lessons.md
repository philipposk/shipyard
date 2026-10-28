# Lessons

One line each. A star means `verify.mjs` or the app's own tests check it automatically. Add new ones to `~/.shipyard/learnings.md`.

## Sign-in and security
- ★ Never set a password from an email address alone (account takeover).
- ★ The login cookie name in `proxy.ts` must match the one Supabase sets; otherwise sign-in appears to work and then loops. Do not share a cookie across domains you do not control.
- ★ Next.js 16 renamed `middleware.ts` to `proxy.ts`. All `/api/auth/*` routes must be public in it or sign-up answers 405 or shows the sign-in page.
- ★ Row level security update rules must limit columns, or a user can make themself admin.
- ★ Admin comes from a database flag only the server key can set, never from an email address. Starter-mode sign-up does not prove the person owns the email, so an email match would hand admin to the first stranger who types the owner's address.
- ★ The secret server key skips every privacy rule. A route that uses it and does `select *` without a user filter hands out everyone's rows even when every table has RLS. Use the signed-in person's own client.
- ★ A "finished setup" cookie (onboarding, age check, consent) is signed with a server secret and bound to the user id (`<userId>.<HMAC>`, `src/lib/auth/onboarded-cookie.mjs`). A plain `1` or bare user id can be typed into the browser to skip setup. API routes enforce the same gate (403 `onboarding_required`), not only pages, or a script skips the setup page.
- A column people may write but only under a rule (an `onboarding_complete` flag that needs a name first, counters, plan, Stripe ids) needs the rule on the server: the route sets it only after checking the required fields and never lets the client set it back, and a `before update` trigger (or no grant at all) stops a direct write with the browser key. Write counters and billing columns with the server key, filtered to the person's id.
- ★ Never put a wildcard host (`https://<app>-*.vercel.app/**`) in Supabase's redirect list: anyone can register a matching address and receive sign-in tokens.
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

## Deploy and hosting
- ★ Deployment Protection must be off, or every visitor gets 401.
- ★ Verify on the real address, not "Vercel says ready".
- Commit and push before deploying, and check the deployed commit matches. A deploy from unsaved local files followed by an automatic deploy from GitHub can silently roll the site back.
- `vercel env add` needs an explicit type for `NEXT_PUBLIC_*` values; preview environment values need a branch name, so Shipyard sets production and development only.
- A production deploy can end up staged and not live; check the address, and set the alias if needed.
- Vercel Hobby allows 100 deploys a day: skip deploys for data-only commits.
- Free Supabase projects pause after a week of no use; wake it in the dashboard before testing.
- Vercel Hobby forbids commercial use, including taking payments.
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
- Leaderboards and group stats must include things done late (archive days), marked as late. Hiding them made two players who both scored 100 show "Not played yet". Keep streaks for on-the-day only and say so in the help text.
- A daily-content app with an empty archive at launch has nothing to do after day one: ship a back catalogue (Ballpark launched again with 300 past days), with every fact sourced.

## Working with the agent
- A helper agent's "passed" is not evidence. Re-run the flow that was reported broken before saying done.
- Keys pasted into the chat are saved in transcripts. Rotate any key that was pasted.
- Say what was not verified.
