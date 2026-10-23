---
name: ai-visibility
description: "Make a live app easy for AI assistants and search to understand, cite and recommend: audit llms.txt, llms-full.txt, JSON-LD, the description, the OG image and robots rules for AI crawlers, fix them on a branch, measure a baseline of whether the big assistants (GPT, Gemini, Grok, Perplexity, DeepSeek, Qwen, Kimi and others) name the app, and draft honest directory listings. Use for \"AI visibility\", \"AI SEO\", \"GEO\", \"llms.txt\", \"get recommended by ChatGPT\", \"does ChatGPT know my app\", \"list my app on Product Hunt\", \"directories\", or \"/shipyard:ai-visibility\"."
---

# Shipyard AI visibility

> Part of the Shipyard plugin. This skill runs Shipyard's own scripts and key guard, so it does not work on its own. If it was installed by itself (for example through skills.sh, ClawHub, Hermes, pi or aiden) and Shipyard's `scripts/` folder is not on this computer, stop and install the full plugin first by following https://github.com/philipposk/shipyard/blob/main/INSTALL.md, then start again.

You make a live app readable for AI answer engines, measure whether they recommend it, and prepare honest listings. You run every script. The student approves anything public.

## Rules (always)

- You do the work. Never hand the student a command you could run.
- Never ask for keys in the chat and never read `~/.shipyard/secrets.env` or `.env*` files. The baseline reads `OPENROUTER_API_KEY` itself and never prints it.
- Plain English, short messages, one question at a time with your recommended answer.
- **Nothing public without a clear yes.** Directory submissions, launch posts, Product Hunt, Reddit, Hacker News, emails to editors: draft them, show them, wait for a yes for each one. Never create accounts, fake reviews, upvote rings, or post the same text to many places.
- Never claim what the app does not do. Every listing line must match the live app.
- Changes go on a branch and a pull request, never straight to a branch that deploys. If someone else has uncommitted work in the repo, use a separate `git worktree`.
- Verify before saying done: a production build, the real pages served locally, and signed-in pages still behind sign-in.

## 1. Find the app and write the one-liner

Use the current folder or `node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" show`. Find the live address (`.shipyard-app.json`, the Vercel project, `SITE_URL`). Read the home, about and help pages and write **one sentence** that says what it is, who it is for and the key differentiator. Show it and ask "Is this right?". This sentence becomes the description everywhere.

## 2. Audit the live site

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-visibility.mjs" audit <live-url>` and read the ticks and crosses. Read `references/checklist.md` for what each check means and how to fix it in a Next.js app.

## 3. Measure a baseline

Write 5 realistic questions a future user would ask an assistant, where this app is a good answer, into `ai-visibility/queries.json` (a JSON array of strings). Do not name the app in the questions. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-visibility.mjs" baseline <live-url> --name "<App>" --queries ai-visibility/queries.json --out ai-visibility`. If a model id is gone, list current ones at https://openrouter.ai/models and pass `--models`. Show the table and which tools the models recommend instead (those are the "alternative to" targets for listings).

## 4. Fix on a branch

Make the fixes from `references/checklist.md` on a branch. Then build for production, start it locally with the app's settings, and run the audit against the local address: all ticks except the ones that only change after deploy. Check that signed-in pages still redirect to sign-in and private APIs still return 401. Review the diff, fix what the review finds, review again. Open a pull request whose description lists exactly what was tested. Merging is the student's call.

## 5. Draft listings

Read `references/directories.md`. Write `ai-visibility/directories-draft.md`: the one-liner, a 60 character tagline, a 100 word description, tags, and the prioritised list of places with a ready-to-paste draft for each. Show it. Submit nothing until the student says yes for that place.

## 6. Re-measure

Tell the student to re-run step 3 four to eight weeks after the fixes are live and listings are up, and compare. Models learn slowly; search-enabled ones (Perplexity, GPT with search) change first.

## Done when

- The audit is all ticks on the deployed site (or on the local build, with the pull request open).
- The baseline JSON and Markdown are saved, and the student saw the table.
- The directory drafts are written and nothing was posted without a yes.
