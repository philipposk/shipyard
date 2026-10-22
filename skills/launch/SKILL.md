---
name: launch
description: "Take an app from a free test address to a real product: own domain, real sign-up emails, privacy and terms pages, payments, an email list, phone and desktop apps, and a go-live check. Use for \"launch\", \"go live\", \"custom domain\", \"real emails\", \"privacy policy\", \"terms\", \"payments\", \"Stripe\", \"subscriptions\", \"newsletter\", \"app store\", \"play store\", \"desktop app\", or \"/shipyard:launch\"."
---

# Shipyard launch

You take a working app (from `/shipyard:new-app`) to something real users can sign up for, trust and pay. You run every script. The student only does what a human must: buy a domain, paste DNS records at the registrar, verify their identity with Stripe, and pay store fees.

## Rules (always)

- You do the work. Never hand the student a command you could run.
- Never ask for keys in the chat and never read `~/.shipyard/secrets.env` or `.env*` files. Keys go in the keys file via `node "${CLAUDE_PLUGIN_ROOT}/scripts/secrets-init.mjs"`; scripts show only names with a tick or a cross. Live Stripe keys, Resend keys and SMTP passwords never go in argv, files in the repo, or logs.
- Plain English, short messages, one question at a time with your recommended answer. Explain any new word in five words or fewer.
- **Never fake legal certainty.** Legal text and country notes are drafts and research, not legal or tax advice. Say "draft, have it checked" in chat, in `HANDOFF.md` and in the checklist. The public pages themselves do not carry that wording; the admin Health page does.
- Real money only after the student says so, in chat, for that step. Test mode first, always.
- Commits and pushes are the student's call: ask "OK to save this to GitHub?". Never push to a branch that publishes automatically once the app is live; use a branch and a pull request, merge when checks are green, then redeploy with `deploy.mjs`.
- Helper agents: one model cheaper than yours, mechanical work only (same rule as new-app). Keep legal text, keys, payments, sign-in and the final check on your own model.
- Every script can be run again safely and accepts `--json` and `--help`. Run `--help` if you are unsure of a flag.

## 0. Find the app and check setup

Use the current folder if it has `.shipyard-app.json`; otherwise `node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show` lists apps. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-status.mjs"`. If the app is not live yet, offer `/shipyard:new-app` and stop. An old app without the launch pieces (signup modes, `/privacy`, account deletion, Health page): offer the upgrade in new-app's `references/upgrade.md` first.

## 1. Ask one question

"What do you want to do now?" Recommend the first one that is not done. Read the matching reference, then follow it:

1. **Own web address and real sign-up emails** -> `references/domain-email.md`
2. **Privacy and terms pages** -> `references/legal.md`
3. **Payments in test mode** -> `references/payments.md`
4. **Take real payments (go live)** -> `references/go-live.md`
5. **An email list (newsletter)** -> `references/newsletter.md`
6. **A phone or desktop app** -> `references/stores.md`
7. **Check if I am ready** -> run the go-live check below

For options 2 and 4 also read `references/country.md` (rules differ by country: tax, company registration, consumer rights).

The order that works for most people: 1, 2, country checklist, 3, then 4. Payments need legal pages and a real address first.

## What each script does

All are in `${CLAUDE_PLUGIN_ROOT}/scripts/`, run with `node`:

- `launch-domain.mjs <appDir> <domain>` adds the domain to Vercel and prints the DNS table; `--check` waits until it works, then updates the app address and sign-in settings.
- `launch-email.mjs <appDir> --domain send.<domain>` sets up Resend and the Supabase sign-up emails; `--check` waits for verification; `--switch-to-verified` turns on confirmed sign-ups.
- `legal-generate.mjs <appDir>` writes `src/lib/legal-content.ts` from the profile, the modules and the services the app uses.
- `add-module.mjs <appDir> billing|newsletter` adds a feature (use `--dry-run` first if unsure). Then run `provision-supabase.mjs` (new tables), `npm install`, and `provision-vercel.mjs` (new settings).
- `stripe-setup.mjs <appDir> [--live]` makes products, prices, portal and webhook in Stripe.
- `add-shell.mjs <appDir> mobile|desktop` and `store-check.mjs <appDir>` for store apps.
- `launch-check.mjs <appDir> [--live]` is the go-live gate.

If a script is missing or a flag is rejected, run its `--help`, use what it says, and tell the student plainly; do not invent a workaround that touches keys.

## Changing the app and redeploying

Template changes (signup mode, legal text, plans) are code changes: branch, small commit with the student's OK, pull request, green checks, merge, `deploy.mjs`. Settings that start with `NEXT_PUBLIC_` are baked in at build time: after changing one in Vercel, redeploy. Regenerate legal text when a service or module is added, a price changes, or the company details change.

## Go-live check

`node "${CLAUDE_PLUGIN_ROOT}/scripts/launch-check.mjs" <appDir>` (add `--live` before taking real money). It runs the full verify plus launch checks (legal pages, domain, email, Stripe objects, account deletion, store files). Show the tick/cross list. For each cross say what it means for their users, then fix it or give the one thing the student must do. The admin Health page (`/admin/health`, admins only) shows the same kind of list on the live site.

## Hand off

- Add a "Launch" section to `HANDOFF.md`: what is on (domain, email, payments mode, shells), how to regenerate the legal pages, how to run the check, and the words: "The privacy policy and terms are a draft made from your settings. Have them checked, especially before taking real payments. Country notes in `LAUNCH-CHECKLIST.md` are research, not legal or tax advice."
- Update the profile through the scripts, not by hand.
- Final message: what is now live, what was checked, what was not, and what the student does next. Short.
