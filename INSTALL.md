# Install Shipyard (instructions for the coding agent)

You are a coding agent (OpenAI Codex, Cursor or Claude Code). Your user asked you to install Shipyard, a plugin that helps a beginner build and publish web apps (Next.js, Supabase, Vercel) on their own accounts. Read this whole page, then do the installation yourself. Your user is probably a beginner: use plain English, short sentences, and explain any technical word in a few words.

The same page is at https://shipyard.6x7.gr/install and in the repo as `INSTALL.md`.

**The user does only what a product makes mandatory** (approving your commands, and in Codex one question about trusting the key guard). Everything else is yours. Never ask the user to type a command you can run.

## 1. Tell the user what will happen (one sentence)

Say something like: "I'll download Shipyard, install its skills and its key guard (a small check that keeps your keys out of the chat), and then start setup. You may be asked to approve a few commands."

## 2. Which agent are you?

You know which one you are. Follow the matching section: **A. Codex**, **B. Cursor**, **C. Claude Code**.

## 3. Check the prerequisites (A and B)

Run `node --version` and `git --version`.

- Node must be 20 or newer. Git must exist.
- If one is missing, do not run installers that need an administrator password. Tell the user the one install line for their system (Node: https://nodejs.org, the LTS version; Git on Windows: https://git-scm.com; on a Mac, `git --version` makes the computer offer to install Git) and re-check when they say it is done. If `brew` exists on a Mac you may offer `brew install node`, and run it only after they say yes.

## A. Codex

**A1. Install** (one command; Codex will ask the user to approve it because it writes outside the project and uses the network; that is expected):

```
git clone --depth 1 https://github.com/philipposk/shipyard.git "$HOME/.local/share/shipyard" && node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --agent codex --yes
```

If `$HOME/.local/share/shipyard` already exists, update it instead and then run the same installer:

```
git -C "$HOME/.local/share/shipyard" pull --ff-only && node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --agent codex --yes
```

On Windows PowerShell use `$env:USERPROFILE` in place of `$HOME`, and run the two commands one after the other. The installer prints every file it created or changed. If it stops with a message, read the message: it says what to do in plain words.

**A2. Check** with `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --check`. It should print "No problems found". The notes it prints under "!" are fine.

**A3. The one thing only the user can do.** Codex does not run a new hook until the user trusts it. The Shipyard hook is the key guard: it stops agents reading `~/.shipyard/secrets.env` and apps' `.env` files. The installer must not, and you must not, approve it for them. Tell the user, in these words or close to them:

> Shipyard is installed. One approval left, and only you can give it: Codex asks you to trust the key guard before it runs. Please quit Codex (press Ctrl+C twice), then run this in the terminal:
>
> `codex '$shipyard-setup'`
>
> Codex will say "Hooks need review". Press 2, then Enter ("Trust all and continue"). That is only Shipyard's key guard when it says "1 hook is new or changed". Setup then starts by itself and first checks that the guard is really on.

(If it says more hooks need review than that, tell the user to choose "Review hooks" and trust only the one whose command ends in `guard-codex.mjs`. Using the ChatGPT desktop app or the IDE extension: do this step once in the terminal anyway.)

Then stop. Do not start setup in this session: the guard is not on yet, and Codex only loads new skills in a new session.

## B. Cursor

**B1. Install:**

```
git clone --depth 1 https://github.com/philipposk/shipyard.git "$HOME/.local/share/shipyard" && node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --agent cursor --yes
```

If the folder already exists, use `git -C "$HOME/.local/share/shipyard" pull --ff-only && node ... --agent cursor --yes` instead (as in A1). On Windows PowerShell use `$env:USERPROFILE` for `$HOME`.

**B2. Check** with `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --check`. It should print "No problems found".

**B3. The one thing only the user can do.** Cursor loads new skills when it starts. Tell the user:

> Shipyard is installed. Last step: press Cmd+Shift+P (Ctrl+Shift+P on Windows), choose "Developer: Reload Window", then in Agent chat type `/shipyard-setup`. Setup starts by itself and first checks that the key guard is really on.

(In the Cursor CLI: run `agent`, then type `/shipyard-setup`.) Cursor has no approval step for the key guard.

Then stop.

## C. Claude Code

Claude Code has its own plugin system, so Shipyard installs as a normal plugin. Run:

```
claude plugin marketplace add philipposk/shipyard
claude plugin install shipyard@shipyard
```

Claude Code will ask the user to approve the commands. If you cannot run `claude` in a shell, ask the user to type `/plugin marketplace add philipposk/shipyard` and then `/plugin install shipyard@shipyard`.

Then tell the user:

> Shipyard is installed. Type `/reload-plugins`, then `/shipyard:setup`. The key guard is part of the plugin and is on once the plugin is.

Updates are automatic once the user turns on auto-update for the shipyard marketplace in `/plugin`; setup shows how.

## What you must never do

- Never edit `~/.codex/config.toml` to mark a hook trusted (the `[hooks.state]` entries), never start Codex with `--dangerously-bypass-hook-trust`, and never put Shipyard's hook in `requirements.toml`. The trust question belongs to the user.
- Never open, print or search `~/.shipyard/secrets.env` or any `.env` file.
- Never run `--codex-allow-scripts` unless the user asks for fewer prompts and has heard what it does (Codex then runs Shipyard's scripts outside its sandbox without asking).
- Never use `sudo` or an installer that needs an administrator password.
- Never change the agent's sandbox or approval settings.

## If something goes wrong

- `node: command not found`, or Node older than 20: see "Check the prerequisites".
- The installer says a folder "Shipyard did not make" is in the way: tell the user its name and ask before moving anything.
- No network: tell the user, and run the same command again when they say it is back.
- Anything else: show the user the message, and point them to https://github.com/philipposk/shipyard/issues. Do not improvise around errors by editing files by hand.

## Later: update and remove

- Update (Codex and Cursor): `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --update`. Claude Code updates through its plugin system.
- Remove: `node "$HOME/.local/share/shipyard/scripts/install-agents.mjs" --uninstall`.
- Full guide: https://shipyard.6x7.gr/codex-and-cursor
