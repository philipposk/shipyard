# When the database stops answering

On 25 Oct 2026 (and once before, on 15 Sep) every app in one shared Supabase project hung at the same time. The project is on the free plan, nano compute (0.5 GB of memory), with about 30 app schemas. Around 17:00 CET it used up its disk IO budget. The database stopped answering for about six hours, until someone restarted it by hand. Sign-in spun forever and showed no error. Google sign-in did nothing. An agent spent the session on the browser. Supabase's "running out of Disk IO Budget" email arrived at 17:50 and sat unread.

Do these in order. Do not start by changing the app.

## 1. Check the project before the app

When sign-in or a page hangs, check the project's health before reading app code and before opening the browser. The project ref is the `ref` (or the project id) in `.shipyard-app.json`. Never print the access token.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref>`

That calls the Management API:

`GET /v1/projects/{ref}/health?services=db&services=auth&services=rest`

`/auth/v1/health` returning 200 proves nothing. It kept returning 200 while the database was stuck.

## 2. Every app has /api/health

The template ships a public `/api/health`. It makes the database do real work: one row, read only, 5 second limit, no user data in the answer. It returns 503 when that read fails. The proxy lets `/api/health` through before any sign-in call, so a stuck database cannot hide the probe.

At launch, register an outside uptime check (about every 5 minutes) on `https://<the app>/api/health`. Expect 200. Alert on anything else, including a timeout. GitHub's health workflow only runs every 6 hours, so it is not enough on its own.

## 3. Sign-in must stop waiting

The browser Supabase client gives up on `/auth/v1/` after about 20 seconds. The sign-in page then says "Sign-in isn't responding, try again in a few minutes." instead of spinning. The proxy and server sign-in checks give up after 3 seconds each, and after 5 seconds for the whole check. Never put a timeout on storage uploads.

## 4. One disk IO budget

A shared project has one disk IO budget for every app in it. Do not add a `pg_cron` or `pg_net` job that runs every minute, a new realtime publication, or tight polling, without saying what it costs. The app's schema test fails a cron schedule that runs more than once an hour. Prefer running frequent work in the app.

Pruning `cron.job_run_details` is done once, for the whole project, by the person who owns it. Do not add that prune as a migration in every app.

## 5. Restart

Only after the student says yes:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref> --restart`

That is `POST /v1/projects/{ref}/restart`. It takes about 5 minutes. The disk IO budget does not refill on restart, so cut the load afterwards or the same stall comes back.

## 6. Alert email must reach a human

Supabase sends Disk IO, usage-quota and pausing warnings from `noreply@supabase.com`. In Gmail, make a filter: from that address, star the message and mark it important. Say this during setup, and check the filter exists when an outage is suspected.

## 7. A shared project that is already near its limit

If a shared project has outgrown its compute size, do not launch a heavy new app onto it until the owner has chosen a bigger compute size or moved the heavy apps into projects of their own. Heavy means realtime, a job every minute, tight polling, or a background worker.

## 8. Grants from 30 Oct 2026

From 30 Oct 2026 Supabase does not grant new tables in `public` to anyone. A missing grant fails with error 42501 before any privacy rule runs. Every new table needs an explicit `grant` to `service_role`, and either a `grant` to `authenticated` for what signed-in people may do, or `revoke all ... from authenticated` when only the server may touch it. Do not grant `anon`. The schema test checks this. Tables that already exist keep the grants they have.

## What a new app already has

`/api/health`, the sign-in timeouts (`src/lib/supabase/auth-fetch.mjs`), and the grant check. An app made before this does not have them until it is brought up to date. `verify` fails a sign-in gate that is missing the health route, the timeouts, or the early pass for `/api/health`.
