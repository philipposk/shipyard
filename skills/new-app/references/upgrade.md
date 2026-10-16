# Upgrade mode: bring an existing app up to standard

Use when the student already has an app (their own code, any stack) and wants it safer and more solid. Audit first, change nothing until they approve.

## 1. Audit (read only)

Ask for the project folder. Read the code and answer, with file names as evidence. Do not edit anything.

- **Secrets**: any keys in tracked files, `NEXT_PUBLIC_` or similar prefixes on secrets, `.env` files in git, a `.gitignore` that covers them.
- **Sign-in**: passwords set from an email alone, redirect values not checked, login cookie handling, public versus protected routes.
- **Data isolation**: does each person only see their own data? Row level security on every table? Admin flags editable by users? Server key used in browser code?
- **Costs**: AI or paid API calls without caps, keys shared between apps.
- **Tests and checks**: tests exist and run? A test gate on pull requests? A leaked-key scan?
- **Deploy**: pushing straight to the publishing branch, deployment protection, environment values.
- **Phone and look**: phone layout, light and dark, install shortcut, empty and error states, fake numbers or reviews, em dashes, the copy rules in `build-rules.md`.
- **Legal and basics**: privacy and terms pages, 404 page, favicon, robots, sitemap.
- **Lessons**: go through `lessons.md` and mark which apply.

## 2. Report

A short list sorted by risk: **Fix now** (secrets, data leaks, account takeover), **Should fix**, **Nice to have**. For each: one plain sentence about what could go wrong for their users, then the file. End with what you could not check.

## 3. Fix one at a time

Ask which to start with; recommend the first "Fix now" item. For each fix: work on a branch, make the smallest change, add a test where logic is involved, show what changed in plain words, get approval, then continue. Never commit or push without being told.

## 4. Stack differences

- **Next.js with Supabase**: use the template's pieces as the model (proxy, cookies, migrations with RLS, `secret-scan.mjs`, `.github/workflows/test.yml`, `AGENTS.md`). Copy the idea, adapt names.
- **Other stacks** (Flutter, plain HTML, other servers): no template. Turn the audit into a checklist, adapt each fix to their stack, and say clearly what could not be automated. For mobile apps, a web and install-shortcut version can be built later with `/shipyard:new-app` and share the same Supabase project.

## 5. Finish

Run the app's own tests. If it is a Shipyard app, run `verify.mjs`. Summarise what was fixed and what remains, then offer to record any new lesson in `~/.shipyard/learnings.md`.
