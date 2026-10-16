# Lessons

One line each. A star means `verify.mjs` or the app's own tests check it automatically. Add new ones to `~/.shipyard/learnings.md`.

## Sign-in and security
- ★ Never set a password from an email address alone (account takeover).
- ★ The login cookie name in `proxy.ts` must match the one Supabase sets; otherwise sign-in appears to work and then loops. Do not share a cookie across domains you do not control.
- ★ Next.js 16 renamed `middleware.ts` to `proxy.ts`. All `/api/auth/*` routes must be public in it or sign-up answers 405 or shows the sign-in page.
- ★ Row level security update rules must limit columns, or a user can make themself admin.
- ★ Admin comes from a database flag only the server key can set, never from an email address. Starter-mode sign-up does not prove the person owns the email, so an email match would hand admin to the first stranger who types the owner's address.
- ★ The secret server key skips every privacy rule. A route that uses it and does `select *` without a user filter hands out everyone's rows even when every table has RLS. Use the signed-in person's own client.
- ★ Never put a wildcard host (`https://<app>-*.vercel.app/**`) in Supabase's redirect list: anyone can register a matching address and receive sign-in tokens.
- Views ignore RLS unless `with (security_invoker = true)`; a policy without `to authenticated` applies to visitors who are not signed in; security definer functions must be revoked from public, anon and authenticated. The app's `schema-rules` test checks all three.
- A key deleted in the next commit is still in the history that gets pushed. The pre-push hook and CI scan every pushed commit, not just the files on disk.
- Account-level keys (Supabase access token) never go into an app's hosting settings.
- ★ No secrets in `NEXT_PUBLIC_*` variables. `.env*` stays ignored by git. Scan for keys before every push.
- Build links sent by email from the configured site address, never from the Host header. Check redirect targets are on the same site.
- Email link scanners (some corporate mail) open links before the person does and use up one-time tokens. If people say "link expired" on first click, make the page a button that confirms.
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

## Building
- Scripts must work on Windows and macOS: avoid bash-only syntax.
- Test with a real second account, not only simulated sessions.
- Test passwords containing `$` and `!` through code, not through a shell, which rewrites them.
- Phone: use `100dvh` and safe-area padding, pin chat inputs to the bottom, never rely on hover.
- A stale service worker can show old pages: it should cache only static files, never pages or data.
- OpenRouter: some models reject the `temperature` setting when `require_parameters` is on; drop it.
- OpenAI voice can take 30 seconds: longer timeout and cache the audio.
- Webhooks: verify the signature, store event ids, ignore out-of-order events.
- Spend limits at every AI provider, plus a daily cap in the app.
- Optimistic send plus polling can show a message twice; dedupe by id.

## Working with the agent
- A helper agent's "passed" is not evidence. Re-run the flow that was reported broken before saying done.
- Keys pasted into the chat are saved in transcripts. Rotate any key that was pasted.
- Say what was not verified.
