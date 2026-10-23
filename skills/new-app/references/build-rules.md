# Build rules

Copy these into `SPEC.md` under "Hard rules" and follow them for every feature. The app's `AGENTS.md` repeats them for the coding agent.

## Data and keys
- Every table has row level security (RLS) switched on: the database itself only lets a person see and change their own rows. Add the table to `supabase/isolation.json`; the app's tests and the verify script fail without it.
- Database changes are new numbered files in `supabase/migrations/`. They can be run twice safely. Never edit one that already ran.
- If people may edit their own row but not every column (like an admin flag), limit the columns with grants. A row rule alone cannot do that.
- The server key lives only in server files. Never put a secret in a name starting with `NEXT_PUBLIC_`: that publishes it to every visitor.
- Never set or change a password from an email address alone. Passwords change only through the person's own session.
- Keys live in `.env.local` (never committed) and in Vercel settings. A leaked-key scan runs before every push and on every pull request.
- Every route under `/api/auth/` must be public in `src/proxy.ts`; other API routes need a signed-in person.
- Nothing changes on a GET (sign-out, delete, join, confirm are POST buttons). A one-time sign-in token is never used by opening a link: the link opens a page, and a button confirms. Mail scanners and crafted links fire GETs.
- Any link sent by email is built from the site address setting, never from the request's Host header. Check every `next` or redirect value points to the same site.
- Lists, totals and leaderboards read every row (the database returns at most 1000 per request) in a fixed order. Never trust one query for "all".
- Limits go on what strangers can trigger (sign-up, emails sent), never on the sign-in of someone who already has an account.
- If the app keeps score (points, streaks, correct answers), the server works it out and stores it. Answers and solutions never reach the browser before the person has played.

## Behaviour (pages)
- Each page sets its own canonical address (never one in the layout). A page that can say "not found" has no `loading.tsx`, so it answers 404 and not 200.
- The page never scrolls sideways, and the sticky header must stay stuck (`overflow-x: clip`, not `hidden`). The service worker caches built files and icons only.

## Costs
- Any AI feature has a spend limit at the provider, a per-app key, a daily cap inside the app, and a per-person limit.
- Do not build a feature that can run up a bill on anyone's key without a cap.

## Behaviour
- Brand name only from `BRAND` in `src/lib/constants.ts`.
- A designed empty state, loading skeleton and error message for every screen that loads data.
- Test with a real second account, not only simulated sessions.
- Webhooks (later): check the signature, store event ids, ignore out-of-order events.
- Work on a branch and open a pull request once the app is live; merge only on green checks.

## Copy and look (what visitors read)
- No fake numbers, fake reviews or invented testimonials. No "Made with AI" badges. No lorem ipsum.
- No purple gradients, no gradient card backgrounds. One accent colour.
- No em dashes in text people read. Use commas or full stops.
- No explanatory sentences in menus, no subtitle that repeats the title, no "Tip:" boxes, no developer words (API, token, schema, RLS) where visitors can see them. If something needs explaining, one plain line, or a small "?" that opens a popover on tap (never hover only: phones cannot hover).
- Legal links live in the account menu, not in a crowded footer.
- Touch targets at least 44px. Inputs at least 16px so iPhones do not zoom. Light mode by default with dark mode available, no flash on load.
- Do not hardcode copy that is really data. Do not show debug or backend wording to visitors.
- Phone-first does not mean phone-only. On a computer (1024px and wider) the app uses the screen: the tab bar becomes a left rail and pages use the content width. Do not wrap pages in a narrow `max-w-md mx-auto` column; lay lists out as a wider table or a grid of cards on big screens. Look at a 1440px wide screenshot too, and compare with how big comparable apps look on a desktop.
- Switching tabs must feel instant: every signed-in page folder has a `loading.tsx` that returns `<PageLoading />`, and data loads in the page, not in shared layouts.
- Before saying ready, look at the home page on a phone width and check it against this list.

## Lessons from the Oct 2026 audit of the 6x7 apps (each one is also caught by `verify --only hygiene`)
- Every link and button has a name a screen reader can read. An icon-only control, or a logo link whose text is hidden at phone size (`max-[430px]:hidden`), gets `aria-label` (logo: `` aria-label={`${BRAND.name} home`} ``). Lighthouse calls this "link-name" / "button-name".
- Private (noindex) is a choice the owner makes, not a default. Scaffold with `--private` only when they say the app is private; otherwise public pages (home, about, help, pricing, legal, sign-in) are indexable and in the sitemap, and signed-in routes are disallowed in robots.txt.
- CI must be able to pass on main: commit `package-lock.json` and re-run `npm install` after any dependency change (`npm ci` fails on drift); no `uses: ./local-action` that is not in the repo; in a workspace repo, build the workspace packages before the tests (`npm run build --workspaces --if-present`). No deploy workflow when Vercel deploys from GitHub; a build check is enough.
- API routes, sign-in ones above all, never read env vars with `!`. When Supabase is not configured (preview, CI), answer cleanly: "no user" or a 503 with a message, never a crash.
- Themes: one look = a light and dark pair (a pack). Extra looks only on request, always as packs in Settings > Appearance; never a theme that locks the mode (see the design skill).
- Optional extras (blur, glow, grain, sound) default off.
- Lighthouse budgets on public pages: performance 90 (phone), accessibility 95, best practices 95, SEO 90. See `launch/references/seo-performance.md`.
