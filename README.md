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
| new-app, design, launch, video, ops, new-skill | `/shipyard:<name>` | `$shipyard-<name>` | `/shipyard-<name>` | "Shipyard <name>" |

**The guard check.** Once per session, before anything touches keys, the agent runs a short check (`guard-check.mjs`) that proves the key guard is on: a test file with no key in it must be blocked, and the block message carries a code the script checks. If it says OFF, do the trust step (Codex) or reload the window (Cursor), then run `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --check` in a terminal.

**Updating:** `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --update` about once a month. It says when Codex needs you to trust the hook again.

**Fewer prompts in Codex:** when Codex asks to run `node ".../shipyard/scripts/..."`, choose the option that stops it asking again for that command. Or let the installer add a rules file for Shipyard's own scripts: `--codex-allow-scripts`. Codex then runs those scripts outside its sandbox (full access to your files and the internet) without asking, and picks the file up in a new session.

**Claude Code only:** auto-update, fixes inside GitHub Actions, and the `frontend-design` plugin.

**Seeing Shipyard twice?** If your agent also imported the Claude Code plugin, use the `shipyard-*` skills. `--check` looks for old copies (in `~/.codex/skills`, `~/.cursor/skills`, `~/.claude/skills`, and Claude Code's Shipyard plugin that Cursor can load) and says how to switch each one off.

**Removing it:** `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --uninstall`, then delete the folder. If you deleted the folder first, remove the Shipyard lines from `~/.codex/hooks.json` and `~/.cursor/hooks.json` by hand (until then they block nothing).

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
- `video`: make a product video of your app, built as code (not a screen recording): the script is approved before any voice cost, narration is timed to the words, and you get light and dark, wide and phone cuts. Web copy under 10 MB goes into your app. Needs ffmpeg (optional). Takes hours and uses a lot of your Claude allowance, so do it after launch. Run `/shipyard:video`.
- `ops`: keep a live app healthy. An error log and admin logs page with email alerts, health checks every 6 hours that open one GitHub issue when something is wrong, code review on every pull request (CodeRabbit, or `/code-review` for free), auto-merge for small safe changes (anything touching sign-in, data rules, payments or workflows waits for you), regular project reviews, backups kept on your own computer, and a clear loop for how problems get fixed. Run `/shipyard:ops`.
- `new-skill`: build your own skill or plugin for coding agents, or add one to Shipyard. It asks what you want, tells you when an idea is weak and offers a better one, looks at your code and agent chats (with your yes) to recommend building on Shipyard or from scratch, then writes the skill, a test, plugin files for Claude Code and Cursor, and a publishing checklist (skills.sh, ClawHub, Hermes, the Cursor and Claude Code marketplaces). Run `/shipyard:new-skill`.
- A settings page: `/shipyard:setup settings`.

Optional extras for design (not installed for you): the free `frontend-design` plugin, and Impeccable for a polish pass on one page.

## Safety

- Your keys live in `~/.shipyard/secrets.env` on your computer. You paste them there yourself. Never paste keys into the chat.
- A guard hook blocks your coding agent from reading that file or your `.env` files. Claude Code turns it on at install. For Codex and Cursor the installer adds it, and Codex asks you to trust it once. It is a safety net, not a vault. Shipyard scripts read keys directly and never print them.
- Every app gets a leaked-key scan before each push and in the pull request checks.
- Nothing is sent anywhere except to the services you sign up for (GitHub, Vercel, Supabase and any AI or email provider you add).

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
