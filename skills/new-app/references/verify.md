# Verify

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" <appDir>` (add `--url <address>` if the address is not saved yet, `--only routes,auth` to re-run some checks). It prints a tick or cross per check, plus what it could not check and why. It saves `<appDir>/.shipyard/verify.json` and writes the result to the profile. Exit 0 = every check that ran passed; exit 1 = a check failed, or nothing could be verified (no check ran, or a check you picked with `--only` was skipped). A line that says NOT VERIFIED or NOT FULLY VERIFIED is not a pass: do not tell the student the app works. An app that shares its Supabase project with other apps (`--shared`) skips the `auth` and `isolation` checks unless you add `--allow-test-users`: a test user runs the other apps' sign-up triggers, so it only happens when the owner agrees. Say so; do not call those checks passed.

Re-run after every fix. "Vercel says ready" is not proof; only the real address passing is.

| Check | What it proves | If it fails |
|---|---|---|
| routes | Home, about, help, privacy, terms, sign-in, manifest, icons, robots, sitemap and llms.txt answer 200; a made-up page gives a styled 404 with the app name; sign-up is not blocked | A route 404 or 500: look at the page file. Sign-up 405: the route is not public in `src/proxy.ts` |
| protection | Visitors are not stopped by a Vercel login wall | Run `provision-vercel.mjs` again, or turn off Deployment Protection in the Vercel project settings (the script prints the click path) |
| auth | A throwaway user can be created, sign in, load their profile and sign out | Cookie name in `proxy.ts` must match `src/lib/supabase/cookies.ts`; check Supabase redirect URLs include the app address (`deploy.mjs` adds it) |
| isolation | User B cannot see, change or delete user A's rows when asking the database directly; signed-out visitors see nothing. It does not call the app's own API routes, which is why `secrets` also bans the server key outside a few files | A table lacks row level security or has a too wide rule. Add a migration; never loosen the test |
| browser | At phone size, light and dark: no console errors, no failed requests, no sideways scrolling; two screenshots saved | Fix the error shown. If skipped, run `npm install` in the app (Playwright) and `npx playwright install chromium` |
| proxy | `src/proxy.ts` exists, exports `proxy`, covers every `/api/auth/*` route, cookie name matches | Add the missing prefix to `PUBLIC_PREFIXES` |
| secrets | No key-shaped text in tracked files; `.env` and `.env.local` are not tracked; the secret server key (`@/lib/admin`, `createSupabaseAdmin`, `SUPABASE_SERVICE_ROLE_KEY`) is used only in `lib/admin.ts`, `lib/auth/*` and the sign-up and forgot-password routes | For the server key: use the signed-in person's own client (`createSupabaseServer`) in routes and server actions, so the database privacy rules apply. For keys: remove the key from the file, rotate it at the provider (a leaked key counts as stolen), and if it was committed ask before rewriting history |

## Reporting

- Say which checks passed and which were skipped, with the reason.
- Show the screenshot paths and say what you see. If you did not look, say so.
- Things verify does not cover: forgot-password email (needs a verified domain), Google sign-in, payments, real devices, accessibility. Say "not verified" for what applies.
