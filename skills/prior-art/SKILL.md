---
name: prior-art
description: "Before building a tool, feature, app or skill, search GitHub (and package registries when the need is package-shaped) for projects that already do all or part of it, vet the best ones, and give a verdict: Adopt, Extend, Compose or Build. Uses only the gh CLI, no paid services. Use for \"build a new tool\", \"implement a new capability\", \"make a new app\", \"make a new skill\", \"does something like this already exist\", \"find repos that do X\", \"is there a library for\", \"don't reinvent the wheel\", or \"/shipyard:prior-art\". Not for ordinary code edits."
---

# Shipyard prior art

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.

You check whether someone has already built what the student is about to build, so they do not spend days on something that exists. Prior art means earlier work on the same problem. You search GitHub, vet the best few projects, and answer with one verdict and a short list. You run every command yourself.

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

- Use the `gh` command line tool only (GitHub's own tool). No extra servers, no paid services, no keys.
- Run it only when the student wants to build something new or asks if it exists. Not on every code edit, bug fix or small change.
- Never install, clone and run, star, fork, or open issues on a project you found without the student's yes.
- A project with no licence file is reference only: its ideas may be used, its code may not be copied. Say so.
- Say plainly what you did not check. No security scan is run here; never call a project "safe".

## 1. Gate and capture the need

If the work is a small edit to code that already exists, skip this skill and say so in one line. Otherwise write the need back in one sentence and ask only what is missing, with your recommended answer: the must-haves (3 at most), the language or stack, and whether the licence must allow commercial use.

## 2. Plan the searches

Read `references/method.md`. Break the need into 3 to 5 groups of synonyms, and write SHORT queries (2 or 3 words each). GitHub needs every word to match, so a long sentence finds nothing. Mix naming variants (finder, recommender, suggester, matcher, selector) with ecosystem words (library, sdk, mcp, skill, cli, api).

## 3. Search

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/prior-art.mjs" "<query>" "<query>" ... --json`. Add `--readme "<query>"` for niche needs and `--code "<query>"` to find agent skills. The script pauses between calls, waits a minute if GitHub says slow down, drops forks and archived repos, marks projects with no push for 18 months as stale and unlicensed ones as reference only, and vets the top 5 (licence, last push, open against closed issues, tests, real code or prompt-only). If it cannot run, do the same by hand with the `gh` commands in `references/method.md`.

For a package-shaped need (a library, an SDK) also check npm and PyPI: `references/method.md`, "Packages".

## 4. Decide and answer

Read `references/verdict.md`. Give the verdict (Adopt, Extend, Compose or Build), a ranked table (repo, stars, last push, licence, what it covers, gaps), one line on why each runner-up lost, the queries that worked, and what was not verified. Keep it short. Save the raw results to a JSON file only if the student asks.

## 5. Next step

Ask one question with your recommendation: adopt it (install only with a yes), extend it, compose the pieces, or build. If they build, carry the shortlist into the plan so the new thing uses what exists.

## Done when

- A verdict is given, with the list and its gaps.
- The answer says what was not verified, including that no security scan was run.
- Nothing was installed, cloned, starred, forked or posted without a yes.
