# Shipyard

A plugin for Claude Code (beta: Codex and Cursor) that helps a beginner build and publish real web apps. You set up your accounts once, then describe an app and Shipyard builds it with Next.js, Supabase (database and sign-in) and Vercel (hosting), and checks it before calling it done.

**Guide and course:** https://shipyard.6x7.gr (install, setup, ten short modules, costs, troubleshooting).

## Install in one prompt (Codex, Cursor or Claude Code)

Open your coding agent and type this one line:

```
Install Shipyard: github.com/philipposk/shipyard
```

Your agent reads [INSTALL.md](INSTALL.md) and does the rest: it checks Node and Git, installs Shipyard for itself, and tells you the one step it cannot do for you. In Codex that step is a single keypress: Codex asks you to trust the key guard before it runs, and nobody (not Shipyard, not the agent) may approve that for you.

*Note to AI agents: if you were asked to install this repository, follow [INSTALL.md](INSTALL.md).*

## Install by hand in Claude Code

If you prefer to type the commands yourself, in Claude Code:

```
/plugin marketplace add philipposk/shipyard
/plugin install shipyard@shipyard
```

Then, once:

```
/shipyard:setup
```

And for every app:

```
/shipyard:new-app
```

When the app is live and you want a real address, emails, legal pages or payments:

```
/shipyard:launch
```

After installing, turn on updates: `/plugin`, then Marketplaces, then shipyard, then Enable auto-update.

## Using Codex or Cursor (beta)

Shipyard also runs in OpenAI Codex (the CLI, the IDE extension and the ChatGPT desktop app) and in Cursor (the editor and the Cursor CLI). It is a beta until it has been checked in real Codex and Cursor sessions. Step by step, including what the key guard does not cover: https://shipyard.6x7.gr/codex-and-cursor

**You need:** Node 20 or newer, and Git (on Windows install Git for Windows from git-scm.com: Codex and Cursor do not install it). For Codex, the Codex CLI 0.163 or newer: install or update it with `npm install -g @openai/codex@latest`, then check `codex --version` (other ways: https://learn.chatgpt.com/docs/cli).

**Install**: easiest is the one-prompt install above. By hand, in a terminal (macOS and Linux Terminal, or Windows PowerShell; not cmd.exe):

```
git clone --depth 1 https://github.com/philipposk/shipyard.git "$HOME/.local/share/shipyard"
node "$HOME/.local/share/shipyard/scripts/install-agents.mjs"
```

It finds Codex and Cursor (or use `--agent codex`, `--agent cursor` or `--agent both`), shows every file it will change and asks first. It puts Shipyard's skills in `~/.agents/skills/shipyard-*` and adds the key guard to `~/.codex/hooks.json` and `~/.cursor/hooks.json`, keeping your own entries. It never touches Claude Code's files. Codex and Cursor both read `~/.agents/skills`, so if the other agent is on your computer too it gets the key guard as well, and `--uninstall --agent ...` for one of them stops with a message instead of leaving the other without it.

**Then, in Codex:** quit Codex and run `codex '$shipyard-setup'` in a terminal. Codex says "Hooks need review": press 2, then Enter ("Trust all and continue"). Setup then starts and first checks that the key guard is on. (You can also type `/hooks` in Codex and trust the entry ending in `guard-codex.mjs`.) Do this once in the terminal even if you use the ChatGPT desktop app or the IDE extension.

**Then, in Cursor:** open the Command Palette and choose "Developer: Reload Window" (or quit and reopen). In Agent chat type `/shipyard-setup`. In the Cursor CLI, run `agent` and then `/shipyard-setup`.

**What to type:**

| Skill | Claude Code | Codex | Cursor | Any agent |
|---|---|---|---|---|
| setup | `/shipyard:setup` | `$shipyard-setup` (or the `/skills` list) | `/shipyard-setup` | "Shipyard setup" |
| settings page | `/shipyard:setup settings` | `$shipyard-setup settings` | `/shipyard-setup settings` | "Shipyard settings" |
| new-app, design, launch, video, ops, new-skill, email, apis | `/shipyard:<name>` | `$shipyard-<name>` | `/shipyard-<name>` | "Shipyard <name>" |

**The guard check.** Once per session, before anything touches keys, the agent runs a short check (`guard-check.mjs`) that proves the key guard is on: a test file with no key in it must be blocked, and the block message carries a code the script checks. If it says OFF, do the trust step (Codex) or reload the window (Cursor), then run `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --check` in a terminal.

**Updating:** `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --update` about once a month. It says when Codex needs you to trust the hook again.

**Fewer prompts in Codex:** when Codex asks to run `node ".../shipyard/scripts/..."`, choose the option that stops it asking again for that command. Or let the installer add a rules file for Shipyard's own scripts: `--codex-allow-scripts`. Codex then runs those scripts outside its sandbox (full access to your files and the internet) without asking, and picks the file up in a new session.

**Claude Code only:** auto-update, fixes inside GitHub Actions, and the `frontend-design` plugin.

**Seeing Shipyard twice?** If your agent also imported the Claude Code plugin, use the `shipyard-*` skills. `--check` looks for old copies (in `~/.codex/skills`, `~/.cursor/skills`, `~/.claude/skills`, and Claude Code's Shipyard plugin that Cursor can load) and says how to switch each one off.

**Removing it:** `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --uninstall`, then delete the folder. If you deleted the folder first, remove the Shipyard lines from `~/.codex/hooks.json` and `~/.cursor/hooks.json` by hand (until then they block nothing).

## Other agents and skill directories

Shipyard's skills follow the open [Agent Skills](https://agentskills.io) format, so skill directories list them too. These listings help people find Shipyard, but each skill runs Shipyard's scripts and key guard, so the real install is always the whole plugin (the one-prompt install above). A skill installed by itself through one of these commands tells the agent to install the full plugin first.

- **skills.sh** (Codex, Cursor, Claude Code and 40+ other agents): `npx skills add philipposk/shipyard`.
- **pi:** `pi install git:github.com/philipposk/shipyard`. Pi picks up the `skills/` folder; use `/skill:setup` to start.
- **Hermes:** `hermes skills tap add philipposk/shipyard`, then `hermes skills install philipposk/shipyard/setup`.
- **OpenClaw (ClawHub):** `clawhub install shipyard-setup` (each skill is listed as `shipyard-<skill>`).
- **aiden:** its skills marketplace lists skills from skills.sh, so Shipyard shows up there once it is on skills.sh.

## Updates

Shipyard tells you when a new version is out: once a day, when a Claude Code session starts, it asks GitHub for the latest release (a quick check that waits at most a second and a half and stays quiet when you are offline). If yours is older you see one line saying how to update. To turn this off, set `SHIPYARD_NO_UPDATE_CHECK=1`.

How to update, depending on how you installed:

- **Claude Code:** turn on auto-update once (`/plugin`, then Marketplaces, then shipyard, then Enable auto-update) and new versions arrive by themselves at the start of a session; run `/reload-plugins` or start a new session to use them. Third-party marketplaces have auto-update off until you turn it on. To update right now: `claude plugin update shipyard@shipyard`, or in a session `/plugin marketplace update shipyard`.
- **skills.sh** (`npx skills add philipposk/shipyard`): `npx skills check` shows what is new, `npx skills update` installs it.
- **ClawHub (OpenClaw):** `clawhub update --all`, or one skill with `clawhub update shipyard-<skill>`.
- **Hermes** (`hermes skills tap add philipposk/shipyard`): `hermes skills check`, then `hermes skills update`. Skills you edited yourself are skipped unless you add `--force`.

## What you need

You can start with $0 besides Claude Code Pro (about $20 a month, or a ChatGPT plan for Codex, or a Cursor plan): a free GitHub account, a free Vercel account, a free Supabase account and Node.js from nodejs.org. Setup walks you through each one.

| Stage | Cost |
|---|---|
| Learning and demo apps | $0 |
| Your own web address (optional) | about $10 to $15 a year |
| AI features inside your app | $5 or more, once, to your AI provider |
| Taking payments | Vercel Pro, $20 a month, plus payment fees |
| Serious database with real users | Supabase Pro, $25 a month |
| Phone app stores | Apple $99 a year, Google $25 once |

Free Supabase allows 2 active projects and pauses a project after a week of no use (one click wakes it).

## What is in this release

- `setup`: checks your tools, connects GitHub, Vercel and Supabase, stores your keys safely, saves your defaults. You can stop and continue later.
- `new-app`: asks a few questions, writes a plan, builds the app, creates the database, puts the code on GitHub, publishes it and runs checks (pages, sign-in, data isolation between users, phone layout, leaked keys).
- A starter app with sign-in, light and dark mode, a phone-first, sidebar or top-links layout, installable as a phone shortcut (PWA), and a test gate that GitHub runs on every pull request.
- `design`: choose how your app looks. Pick a site or screenshots you like, a free design file, three directions drafted for your own app (with real screenshots of it), or one of 8 ready-made looks. A look sets colours, fonts, menu style (bottom tabs, left sidebar or top links), homepage style, card and button feel, text size and spacing, in light and dark, and is checked for readability. Run `/shipyard:design`.
- `launch`: go from a free test address to a real product. Your own web address and real sign-up emails (people confirm their email), privacy and terms pages written from the services your app uses (a draft: have it checked), a country checklist from official sources, payments with Stripe (test first, then live), an email list with one-click unsubscribe, phone and desktop app wrappers, and a go-live check. Run `/shipyard:launch`.
- `video`: make a product video of your app, its screens rebuilt as code or the real app recorded from practice pages with made-up data: the script is approved before any voice cost, narration is timed to the words in any language, and you get light and dark, wide and phone cuts. Web copy under 10 MB goes into your app, and a guide helps put it on YouTube. Needs ffmpeg (optional). Takes hours and uses a lot of your Claude allowance, so do it after launch. Run `/shipyard:video`.
- `ops`: keep a live app healthy. An error log and admin logs page with email alerts, health checks every 6 hours that open one GitHub issue when something is wrong, code review on every pull request (CodeRabbit, or `/code-review` for free), auto-merge for small safe changes (anything touching sign-in, data rules, payments or workflows waits for you), regular project reviews, backups kept on your own computer, and a clear loop for how problems get fixed. Run `/shipyard:ops`.
- `new-skill`: build your own skill or plugin for coding agents, or add one to Shipyard. It asks what you want, tells you when an idea is weak and offers a better one, looks at your code and agent chats (with your yes) to recommend building on Shipyard or from scratch, then writes the skill, a test, plugin files for Claude Code and Cursor, and a publishing checklist (skills.sh, ClawHub, Hermes, the Cursor and Claude Code marketplaces). Run `/shipyard:new-skill`.
- Desktop that uses the screen: phone-first apps show a left rail instead of the tab bar on computers, with pages at full content width, and tab switches show the next page's outline at once.
- Service keys per app: `scripts/app-keys.mjs <app> GROQ_API_KEY ...` gives an app the AI, speech-to-text (Groq, Deepgram) or other keys from your keys file without showing them. The new-app skill also builds AI features on the server where they help, suggests the next best features, and can add an API, webhooks and an MCP server so other tools and AI assistants can use your app.
- Build story: `scripts/build-story.mjs <app>` turns the Claude Code chats that built an app into `BUILD-STORY.md`: the cleaned prompts, how many, tokens and estimated cost per model, and time per step.
- Gmail "send as" guide in `launch`: write and reply from your own domain in Gmail, and keep those emails out of junk (SPF, DKIM, DMARC, warm-up).
- `email`: email on your own domain. Receive at any `@yourdomain` address in Gmail (ImprovMX catch-all), reply from it in Gmail, SPF, DKIM and DMARC, DNS steps for Papaki, Cloudflare or any registrar, a deliverability test (`scripts/email-check.mjs`), and owner emails such as "<App> is live" sent with the app's name and a "why you got this" line (`scripts/notify.mjs`). Run `/shipyard:email`.
- `apis`: one guide and checker for every service key (OpenRouter, OpenAI, Groq, Deepgram, ElevenLabs, Gemini, NVIDIA, Brave, Serper, SerpAPI, Upstash, Resend, Stripe), web search with fallbacks, voice, an AI model router and shared rate limits. Run `/shipyard:apis`.
- A settings page: `/shipyard:setup settings`.

Optional extras for design (not installed for you): the free `frontend-design` plugin, and Impeccable for a polish pass on one page.

## Safety

- Your keys live in `~/.shipyard/secrets.env` on your computer. You paste them there yourself. Never paste keys into the chat.
- A guard hook blocks your coding agent from reading that file or your `.env` files. Claude Code turns it on at install. For Codex and Cursor the installer adds it, and Codex asks you to trust it once. It is a safety net, not a vault. Shipyard scripts read keys directly and never print them.
- Every app gets a leaked-key scan before each push and in the pull request checks.
- Nothing is sent anywhere except to the services you sign up for (GitHub, Vercel, Supabase and any AI or email provider you add), plus the once-a-day update check, which asks GitHub's public API for the latest Shipyard version and sends nothing about you (turn it off with `SHIPYARD_NO_UPDATE_CHECK=1`). Shipyard has no telemetry.
- Shipyard never needs Claude Code's bypass-permissions mode.

## What changed in 0.8.3

- `video` can show the real app: practice pages with made-up data (no sign-in, no database) are recorded with the new `video-capture.mjs`, which starts the app, records it and always stops it again, and the recording plays inside the same scenes. The engine moves to a newer pinned version with the recorder fixes: sharp big recordings, the right frames in long ones, captions in any alphabet.
- Voice: pick key lines by ear (`--takes`), fix one line without the rest (`say`, `style`, `pauseCap`, `leadIn`, `take`), other languages (`--lang`, `--wpm`, `--style`), and Gemini's free-tier limit explained.
- Renders stop early on a nearly full disk, clean up Remotion's working folders, and `--low-memory` handles long footage. Publishing sets the captions language (`--lang`). A new YouTube guide: Private first, subtitles, never delete a video for the student. Scripts are benefits-only.
- The video works on apps Shipyard did not make once the upgrade guide is done (`--general`). new-app, launch and the upgrade guide offer the video at the end, with its time and cost.

## What changed in 0.8.2

- `launch` gains a full App Store and Google Play guide from shipping a real app: a store-readiness audit (account deletion in the app and on the web, Sign in with Apple, OAuth in the system browser, permission strings, Apple 4.2, a privacy policy that matches the data, a reviewer password login and demo account), the Capacitor 7 wrapper, signing an Android AAB on Linux, iOS screenshots on a Mac, panoramic Playwright screenshots, listing text with App Privacy and Data safety answers, Apple and Google account types, and the gotchas that cost hours.

## What changed in 0.8.1

- Security from the CommitR review: the app template's "finished profile" cookie is now signed and tied to the person (a typed-in value no longer skips setup), and API routes refuse people who have not finished setup (403 `onboarding_required`). Existing apps keep working: old cookies are checked once against the database and replaced.
- New lessons and build rules: server-checked setup flags and protected billing/counter columns, safe outgoing webhooks (no calls to private addresses), token lifetimes and rate limits for agents, payment webhooks that record the event only after saving, analytics only after consent, and "Coming soon" instead of a checkout that cannot finish.

## What changed in 0.8.0

- New `email` skill: ImprovMX catch-all to Gmail, Gmail "Send mail as" through Resend SMTP (smtp.gmail.com fails DMARC), SPF/DKIM/DMARC, Papaki and Cloudflare DNS steps, `email-check.mjs` (reads public DNS, no keys) and `notify.mjs` (the "<App> is live" email from 6x7-app-factory, with the app as sender, a "why you got this" line and `--dry-run`).
- New `apis` skill: key guide for 13 services; `secrets-check.mjs --live` now also tests ElevenLabs, Gemini, Brave, Serper, SerpAPI and Upstash (NVIDIA by format). Web search, voice, AI router and Upstash rate-limit guides are marked new, untested in production.
- `new-skill` points to good existing skills (find-skills, superpowers, caveman, compound-engineering, Anthropic's skill-creator and engineering skills) instead of copying them.
- `launch` gains a search-engine and speed checklist from the 6x7 launches.

## What changed in 0.7.1

- Phone-first apps use the whole screen on computers (left rail, full-width pages), and tab switches show the next page's outline at once. Existing apps keep their look until you bring the change in.
- `scripts/app-keys.mjs` gives one app the service keys it needs; Groq and Deepgram keys are known to setup.
- `scripts/build-story.mjs` writes a "how this app was made" record from the Claude Code chats.
- New guides: AI features and feature ideas, API / webhooks / MCP for apps, and Gmail "send as" with a junk-folder checklist.

## What changed in 0.7.0

- New skill `new-skill`: build and publish your own skills and plugins. `scripts/skill-scaffold.mjs` writes a skill or plugin that works in Claude Code, Codex, Cursor and agents that read `~/.agents/skills`, and checks any skill folder (name, trigger words in the description, no placeholders). Codex and Cursor get it as `shipyard-new-skill` after `install-agents.mjs --update`.

## What changed in 0.6.2

- Sign-in links from emails now open a short page with a Continue button instead of signing in straight away, so mail scanners can't use them up and a forwarded link can't sign someone into the wrong account.
- New apps get a paging helper for long lists (the database returns at most 1000 rows at a time), a fix for sticky headers, and written rules in `AGENTS.md` and the build rules from the 6x7 launches: no changes on a plain link visit, server-side scores, offline cache for static files only, and a second review of fixed code before launch.

## What changed in 0.6.1

- One-prompt install for Codex, Cursor and Claude Code: [INSTALL.md](INSTALL.md). In Codex, setup now starts with a guard check, and `--check` says whether Codex has a trust record for the hook (it only reads Codex's files, it never writes trust).

## What changed in 0.6.0

- Shipyard runs in Codex and Cursor (beta), installed with `scripts/install-agents.mjs`. Nothing changes for Claude Code.
- New apps get a `.cursorignore` that keeps `.env` files away from Cursor, and their `AGENTS.md` gains a rule never to open keys files plus two reworded lines (which agents read it, and the design skill's name in each agent). Auto-merge now waits for you on changes to `.cursor/`, `.codex/`, `.agents/`, `.cursorignore` and `.cursorrules`.

## Contributing

Issues and pull requests are welcome. Run `node --test tests/*.test.mjs` before you send one.

## License

MIT, see `LICENSE`.
