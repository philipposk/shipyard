# Method (proven on a real search)

## Queries

- 3 to 5 groups of synonyms for the one need. Example for "suggest a name for my app": `name generator`, `name suggester`, `naming tool`, `brand namer`.
- 2 or 3 words each. `gh` ANDs every word, so "tool that suggests names for a web app" returns nothing.
- Naming variants: finder, recommender, suggester, matcher, selector, generator, checker.
- Ecosystem words: library, sdk, mcp, skill, cli, api. Add one when the student's stack is known.
- Keep the queries that found good results; the answer lists them.

## By hand (what the script does)

Repos, matched on name and description:
`gh search repos "<q>" --match name,description --stars ">=3" --limit 30 --json fullName,stargazersCount,pushedAt,license,language,description,isArchived,isFork`

A second pass for niche needs, matched on the README text: the same command with `--match readme`.

Agent tooling (skills): `gh search code --filename SKILL.md "<q>"`, and `--filename README.md`. The MCP registry and skills.sh are also worth a web search when the need is agent-shaped.

Pause 2 or 3 seconds between calls. The search API allows about 30 a minute. On HTTP 403, wait 60 seconds and continue.

## Cleaning the list

- Merge duplicates (one repo found by several queries ranks higher).
- Drop forks and archived repos.
- No push for 18 months: stale. Say so; it may still be fine for a small stable tool.
- No LICENSE: reference only. Ideas are free, code is not.

## Vetting the top 5

For each: `gh api repos/<owner>/<repo>` (last push, open issues, default branch), `gh api repos/<owner>/<repo>/license` (a 404 means no licence), and the README: `gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"`.

Read for: the licence, the last push, open against closed issues, real code or only prompts (Markdown), and whether tests exist. Stars show attention, not quality.

## Packages

- npm: `https://registry.npmjs.org/-/v1/search?text=<words>&size=20`
- PyPI has no search API. Web-search the need, then read `https://pypi.org/pypi/<name>/json` for each named candidate (version, release dates, licence).
- Health of a package: `https://api.deps.dev/v3/systems/<npm|pypi>/packages/<name>`.
- Same cleaning as above: stale, no licence, one maintainer, few downloads.
