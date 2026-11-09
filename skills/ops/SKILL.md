---
name: ops
description: "Keep a live app healthy: error alerts and a logs page, scheduled health checks, code review on every pull request, auto-merge for small safe changes, backups, and how problems get fixed. Use for \"errors\", \"logs\", \"monitoring\", \"health check\", \"alerts\", \"code review\", \"auto-merge\", \"backup\", \"self-healing\", or \"/shipyard:ops\". No .shipyard-app.json: do the asked monitoring task with the app's own tools, and offer the full upgrade separately."
---

# Shipyard ops

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.

You help the student keep a live app healthy without watching it all day. Set things up once; after that the app tells them when something breaks, and fixes go through pull requests that a human approves when the change is risky. You run every script. The student only does what a human must: click "install" in a GitHub app, say yes to repo settings, and review risky pull requests.

## First: which app is this?

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/which-app.mjs" <app folder>` on the current folder when that folder is the app.

- The output says `shipyard`: this folder was made by Shipyard. Continue with the steps below.
- The output says `general`: an existing app Shipyard did not make. Do not stop. Do the asked monitoring task with the app's own tools: an outside uptime check on its health address works for any app that has one (if it has none, the upgrade adds `/api/health`). The ops scripts need a Shipyard app and will refuse; that refusal is expected. The full upgrade lives in new-app's `references/upgrade.md`; offer it separately and start it only on a yes. Shared preflight: new-app's `references/which-app.md`.
- The output says `damaged`: `.shipyard-app.json` is here but broken. Say so. Do not treat the folder as a general app.

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

- Scripts handle `CRON_SECRET` and tokens; they never print them. Never put a secret in a command line or a file in the repo.
- Changing repo settings, adding workflows, merging, and anything that costs money: ask first, wait for a clear yes, once per action.
- Never push straight to `main` once the app is live. Do not invent a workaround that touches keys.

## 0. Find the app and check it is live

This step is only for a Shipyard app (see First). Use the current folder if it has `.shipyard-app.json`; otherwise `node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show` lists apps. If that folder is general, go back to First. Do not stop. If the Shipyard app is not live yet, offer `/shipyard:new-app` and stop. Then show where things stand:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/ops-status.mjs" <appDir>`

It lists what is on (error log, health workflow and its last run, review config, auto-merge, branch protection, whether the repo is public, whether `CRON_SECRET` is saved in Vercel and GitHub, last backup). Read it to the student as a short list of ticks and crosses.

## 1. Ask one question

"What do you want to do now?" Recommend the first one that is not done. Read the matching reference, then follow it:

1. **Error alerts and a logs page** -> `references/errors.md`
2. **Scheduled health checks** -> `references/health.md`
3. **Code review on every pull request** -> `references/review.md`
4. **Auto-merge small, safe changes** -> `references/automerge.md`
5. **A regular project review** -> `references/project-review.md`
6. **Backups of my users' data** -> `references/backups.md`
7. **How self-healing works here** -> `references/self-healing.md`

Good order for most people: 1, 2, 3, then 4. Option 1 is the base: the others read from it.

When sign-in or a page hangs, or `/api/health` is not 200, read `references/db-outage.md` before looking at the app or the browser. Check the Supabase project's health first.

## What each script does

All are in `${CLAUDE_PLUGIN_ROOT}/scripts/`, run with `node`:

- `ops-setup.mjs <appDir> [--only health,review,automerge,deps] [--json]` adds the errors module if missing, then writes the workflow and config files into the app, and makes `CRON_SECRET` (sent to Vercel and GitHub, never shown). Files the student edited are not overwritten; `--force-file <path>` replaces one on purpose.
- `ops-status.mjs <appDir> [--json]` shows what is set up and what the last health run said.
- `backup-export.mjs <appDir> [--json]` saves every table to a private folder on the student's computer.
- `add-module.mjs <appDir> errors` adds only the error log (use `--dry-run` first if unsure).

## After any change to the app

New workflow files and the error module are code changes: branch, small commit with the student's OK, pull request, green checks, merge, redeploy with `deploy.mjs`. `CRON_SECRET` only takes effect after a redeploy. Update the profile through the scripts, not by hand.

## Honest limits (say them when relevant)

- Alerts only reach the owner's email if Resend is set up (`/shipyard:launch`, real emails). Without it, errors are still logged on `/admin/logs`.
- GitHub cannot force the test check on a free private repo. Auto-merge then does not work, and the student keeps the rule themselves: never merge while red.
- Scheduled workflows on public repos pause after 60 days with no activity on the repo. The status script shows the last run, so a silent pause shows up.
- Reviews, fixes and project reviews use the student's Claude Pro allowance. Warn before long jobs.

## Hand off

- Add an "Ops" section to the app's `HANDOFF.md`: what is on, where the logs page is, who gets alert emails, what the `ops-alert` issue means, what auto-merge will and will not touch, where backups live and that they hold personal data.
- Final message: what is now watching the app, what was checked, what was not, and the one next step. Short.
