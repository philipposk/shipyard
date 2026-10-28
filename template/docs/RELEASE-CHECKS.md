# Release checks for <APP_NAME>

What to run before a pull request, after each deploy, and (for apps that record from the microphone) with a real voice.
For a full review of the whole app with many helper agents, use the Shipyard review skill.

## Before every pull request

1. `npm run typecheck`. `next build` type-checks every `.ts` file, tests included, but `node --test` only strips the
   types, so a typo in a test can pass the tests and still break the production build. CI runs this before the tests.
2. `npm run lint` (ESLint directly: Next 16 has no `next lint`).
3. `npm test`.
4. A full build with placeholder keys, the same way CI does it:
   `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build`.
5. For a bigger change, a local production check: the same two values, then `npm run start`, and look at the signed-out
   pages at phone width and wide, light and dark. No errors in the browser console. Preview deploys may lack the
   database settings, so this is the check that tells you the build itself is fine.
6. Shipyard `verify` on the app folder (the new-app skill has the command).
7. Now and then, `npm run knip` for dead files and unused dependencies. Unused exports are only warnings: some are
   helpers kept for later. `knip.json` lists the entry points; it ignores `src/lib/auth/ensure-profile.mjs` (knip reads
   it as a build copy of `ensure-profile.ts`), and `tailwindcss`, `postcss` (used from CSS and the PostCSS config) and
   `playwright` (used by Shipyard's browser checks).
8. Keep the pull request at 150 changed files or fewer: CodeRabbit's free plan skips bigger ones. Ship a bigger change
   as a stack of pull requests, each building on the one before.

Never change the build script, the deploy workflow or the hosting settings as part of a cleanup.

## After every deploy (smoke test)

1. The deploy finished and its commit is the one you merged.
2. The public pages answer 200: `/`, `/about`, `/help`, `/privacy`, `/terms`, `/sign-in`, `/robots.txt`, `/sitemap.xml`.
3. A signed-out call to an API route answers 401 with JSON (`curl -i <address>/api/profile`), never a redirect to `/sign-in`.
4. One real signed-in action works (sign in, open the main screen, save something).
5. `/admin/health` (as the owner) shows no failures.

When a release is a stack of pull requests, merge one (with a merge commit: after a squash, the next pull request
shows the earlier files again), wait for its deploy, run this list, then point the next pull request at `main` and
merge it.

## Live voice test (apps that record from the microphone)

After the part of the app that records is deployed: headphones off, volume up, start a recording in the app from the
microphone, and play a two-voice conversation through the speakers (Shipyard's `scripts/review/voice-test.mjs` on a Mac,
or two people reading a short script). Stop and save, then check the saved result: the full length, both speakers, and
any notes or action items the app makes. Delete the test record afterwards.
