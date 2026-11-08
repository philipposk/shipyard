# Lessons from a full review

From one full review of a big Next.js, Supabase and AI app (October 2026): 148 raw findings, 117 confirmed and fixed, then 14 regressions found in those fixes by the second review, shipped as 5 stacked pull requests, each deployed and smoke-tested. One line each. new-app's `references/build-rules.md` and `references/lessons.md` carry the ones every new app must follow; a star means Shipyard `verify` checks it.

## Build and CI
- ★ `next build` type-checks every `.ts` file, tests included, but `node --test` only strips the types. A typo in a test passes CI and breaks the production build. CI runs `tsc --noEmit` (`npm run typecheck`) before the tests.
- ★ Next 16 removed `next lint`. Run ESLint directly (`eslint .`).
- Never change the deploy build script or the deploy workflow in a cleanup pass, however much simpler it looks. Hosting settings may depend on it, and a mistake there only shows in production.
- Preview deploys may lack the database settings. Check with a local production build (`next build`, then `next start`) and placeholder keys.

## Security and correctness
- ★ A signed-out call to `/api/*` answers 401 with JSON, never a redirect to sign-in. The browser follows the redirect, gets a 200 page, and the app thinks the call worked.
- A delete or write with the server key that is driven by a value the user can change (a storage path, a file name) checks it first: the right prefix, the right owner. Tables like that are written only from the server.
- Never let the browser pick the AI model on the app's key. Allowlist model ids, rate-limit every AI, speech-to-text and text-to-speech proxy, cap request body sizes, and clean ids before putting them in a provider's URL.
- MCP servers cap the number of calls in one batch and charge the rate limit for each tool call, not each HTTP request.
- Lookups with a key the user typed use `Object.hasOwn` (`?error=__proto__` otherwise finds a built-in).
- Deleting data never resets monthly usage or quota counters. Otherwise "delete and re-upload" is unlimited use.
- Debounced saves flush on `pagehide` and `visibilitychange` with `keepalive`, or the last edit is lost when the tab closes.
- After renewing a signed media URL, restore the playback position once `loadedmetadata` fires; setting it earlier is ignored.
- Chunked uploads cap the size of each part, and the page does not let the person leave while parts failed.
- Theme CSS like `:root:is(...) button:not([class])` outranks a component's own rules. Exclude containers such as menus and toggles from it.
- Keep a deprecated way of signing in (`?token=`) working with a log line, instead of breaking clients that already use it.
- When a feature ships, update the home page, help, privacy page, `llms.txt`, structured data and manifest, in every language the app has.

## Speed
- Vercel runs functions in Washington (`iad1`) unless `vercel.json` sets `regions`. With the database in Europe every page makes several ocean crossings: put functions next to the database (`fra1` for eu-central-1).
- A bottom tab lights up on tap (optimistic state), every tab has its own `loading.tsx` (except tabs that can answer "not found"; the 404 exception is in new-app's `references/build-rules.md`), and visited tabs stay cached (`staleTimes`). Measure taps with `references/speed.md`; a tab that "cannot be tapped" was usually a tap with no feedback for over a second.

## Server time
- Read real usage before reviewing: `vercel metrics vercel.function_invocation.function_cpu_time_ms -p <project> -a sum --group-by route --since 30d`, then `--group-by clientUserAgent`, and the same for `vercel.middleware_invocation.function_cpu_time_ms`. Code alone did not show that a client was reconnecting 169,000 times a month.
- Search the code for `setInterval`, repeating `setTimeout`, `cron.schedule`, `net.http_`, `crons` in `vercel.json`, and GET handlers on MCP routes. Check each against "Hosting costs" in `new-app/references/build-rules.md`.
- Crawlers are findings too: if most CPU on a public page comes from AI training or SEO crawlers, deny them with a firewall rule (list in `new-app/references/lessons.md`).

## Offline sync and shared sign-in (November 2026)
From a data-loss bug in an offline-first notes app on a shared sign-in: a laptop's local copy lost 414 notes, while the server and the phone were fine.
- With one sign-in cookie across subdomains, a second account signing in to another app switches the session under open tabs, and no event fires. Check that every sync and every queued write first compares the session's user id with the account the local data belongs to, and sends its requests with that checked token (`setHeader("Authorization", …)` on PostgREST and storage calls).
- Look for local rows deleted against a server list (`pruneMissing`-style code). It must be sure the list is this account's; one empty list wipes the copy.
- A pull that uses a "changed since" cursor needs a heal step that re-fetches rows missing on the device. Without it, any rows lost locally stay lost.
- Concurrency checks:
  - The set of rows waiting to upload is read again after every `await` before merging or deleting.
  - Nothing throws between merging into memory and saving to IndexedDB.
  - An account switch waits for the running sync, or makes it drop its results.
  - An op whose request succeeded just before the switch is still recorded in the old account's copy, or it is sent again later and overwrites newer edits.
- Signed-out reads should get 401 (no `anon` grants on user tables). Test it with one request using the public key; an empty 200 makes a sync think everything was deleted.

## Process
- Reviewers per area, the strongest model for security, live audio, AI and the database. Merge duplicates, then one skeptic per finding that tries to disprove it. About 85% of merged findings survived.
- Fix in waves whose batches share no file. Then a knip sweep for dead code, then a second, fresh review of the whole fix diff. Then type check, tests, build, a local production check and a real live session.
- Give every helper the absolute path of the worktree. Some drift into the main checkout otherwise.
- Another agent's commits may carry a different author email. List authors before choosing what gets extra scrutiny.
- Check another agent's diagnosis before acting on it. A bot blamed "the server returns an empty list when the session expires"; one request with the public key returned 401, which ruled that out.
- Read real data before guessing a cause. An admin read of which accounts own rows, plus each account's last sign-in time, found the second account and matched the time of the loss.
- Review fixes to sync and concurrency code until a round finds only rare edge cases. Here each of three rounds found a new, smaller bug in the previous round's fix.

## Pull requests
- CodeRabbit's free plan skips pull requests over 150 files: keep each one at 150 or fewer, and for a bigger release follow the procedure in the review skill's `references/ship.md` ("Stacked pull requests"): merge commits, retarget the next pull request after each merge, smoke-test the live app between merges.
