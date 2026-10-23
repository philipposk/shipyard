# Shipyard skills cleanup plan — v3 (final, merged and cross-verified)

Merged from two read-only audits (local `dc4c0e4`, 9 skills; GitHub `23d31e8`, 11 skills) plus four correction rounds, every contested claim verified against actual file contents. Nothing implemented yet. Token figures where given are characters ÷ 4.

> **Decided by the owner, 8 Nov 2026:** implementation runs in a **new session** starting from this file. The fate of `dc4c0e4`: **keep the fail-closed feature, anonymize the 6x7 text, then one cleaned push** — so no personal details ever enter public GitHub history.

**Line numbers** were verified at `origin/main` `38f2913` (8 Nov 2026) where shown; others are approximate from `23d31e8` or the local tree and marked `≈`. Items marked *(local)* exist only in the unpushed commit `dc4c0e4`. Re-verify all of them after the rebase (§0.4).

## 0. Before starting — sequencing and git state (do in this order)

1. **Sequencing rule (step 0).** Rebase `dc4c0e4` onto `origin/main` *locally* → apply the §2 anonymization → push **once** with the cleaned content. Never push `dc4c0e4` as-is: it contains the `6x7.gr` / `filippos@` text, and this repo is public — anything pushed enters permanent public history.
2. **Git state.** Local `main` = `dc4c0e4` ("fail closed when the shared database stops answering", 26 Oct 2026), ahead 1 / behind 32 of `origin/main` `38f2913`; merge base `5960a31`. The commit touches ~20 files that upstream rewrote across those 32 commits — expect real rebase conflicts. A plain `git push` will be rejected (non-fast-forward).
3. **Owner decision (resolved):** keep the fail-closed feature (e.g. `scripts/supabase-health.mjs`, the verify/proxy changes), anonymize the 6x7 text (§2), then push once.
4. **Tree drift since the audits.** The base tree now has **12 skills** — `look-packs` was added upstream after both audits, and the local checkout lacks `review` + `ux-redesign`. Give `look-packs` a quick audit pass before starting; the items below cover the other 11.

## Ground rules

- **Keep every step where it runs.** When duplicate text is removed, the old location keeps a short pointer to the one remaining copy.
- **Check outside facts live first** (platform limits, prices, quotas, versions) and put them in one dated reference.
- **Ask before big flows.** The full upgrade and the deep review are proposed and wait for a yes; keep separate approvals for commits, pushes, merges, money and deletions.
- Measure token size before/after; review the changes with the review skills before the PR; the PR says what was tested.

## 1. Safety and behaviour

- [ ] **The full upgrade becomes a proposal.** [upgrade.md:27](skills/new-app/references/upgrade.md#L27) treats "review and improve the app" as a yes to the whole list (and :61 does every item unless a smaller list was named). Change it to propose and wait, keeping the per-step approvals.
- [ ] **Scoped mode for existing apps.** A design or monitoring request on an existing app does only that task plus its needed checks; the full upgrade is offered separately, not auto-routed through `upgrade.md` from design/launch/ops/video.
- [ ] **Small review as the default.** The yes-gate already exists ([review SKILL.md:24](skills/review/SKILL.md#L24)). Make the changed-files + security-first review the default; propose the deep audit (whole app, one skeptic per finding, re-review of fixes) at the end of big jobs, before a release, or when something risky is touched.

## 2. Anonymize the 6x7 personal details (feeds step 0 sequencing)

Replace with "a production domain" phrasing; archive the anecdotes; no live decision-tracking inside instructions.

- [ ] [email-domain.md](skills/email/references/email-domain.md): production notes at :3, the `filippos@`/named-alias list at :20, Papaki's Greek UI labels at :11, "Measured on 6x7.gr" at :30 and :56.
- [ ] The mail-tester numbers (5.7/10 vs 10/10) appear in **4 places**: [email SKILL.md:26](skills/email/SKILL.md#L26), email-domain.md ×2, [launch/references/gmail-send-as.md](skills/launch/references/gmail-send-as.md) ≈:16. Keep one generic statement.
- [ ] [notify.md](skills/email/references/notify.md) ≈:3 ("Ported from 6x7-app-factory…"), [seo-performance.md](skills/launch/references/seo-performance.md) :3/:39, [social-media.md](skills/launch/references/social-media.md) :3 ("catchy.6x7.gr").
- [ ] [build-rules.md](skills/new-app/references/build-rules.md) ≈:65 ("Lessons from the Oct 2026 audit of the 6x7 apps") and [lessons.md](skills/new-app/references/lessons.md): keep the rules, archive the stories.
- [ ] *(local)* [new-app SKILL.md:59](skills/new-app/SKILL.md#L59) (shared 6x7 project, "free nano, decision still open"), [shared-project.md:9](skills/new-app/references/shared-project.md#L9), lessons.md:38, [db-outage.md §7](skills/ops/references/db-outage.md#L47).

## 3. Duplicates (keep one copy + pointers)

- [ ] **Gmail "send mail as" ×3**: [email-domain.md §3](skills/email/references/email-domain.md#L28) is the source; launch option 7 and [email SKILL.md:26](skills/email/SKILL.md#L26) become short pointers. (Also fixes the 4× numbers from §2.)
- [ ] **which-app preflight block** (6 copies on GitHub, 5 locally: new-app, design, launch, ops, video, review): one shared reference; each skill keeps its essential safety line.
- [ ] **Plugin boilerplate** ("Part of the Shipyard plugin…") in every SKILL.md (now 12): shorten to one line.
- [ ] **Shared working rules** rewritten with drift ("You do the work", "never ask for keys", "one question at a time", helper-model rule, "`--json`/`--help`"): one source, skills keep only what differs.
- [ ] **Build rules / lessons** repeated across `new-app/references/{build-rules,lessons,upgrade}.md` and `template/AGENTS.md`: merge into topic checklists with pointers. `template/AGENTS.md` stays self-contained (it ships in every app); `review/references/lessons.md` keeps its deliberate delegation to the new-app files.
- [ ] **SPEC copying** (build-rules ≈:3, interview ≈:21): replace the copied rule list with a reference + version + app exceptions.
- [ ] **SEO lists**: [seo-performance.md](skills/launch/references/seo-performance.md) has two overlapping lists at :5 and :15 — merge.
- [ ] **Release steps** (stacked PRs / 150 files / smoke tests) in `review/references/ship.md` :17, `review/references/lessons.md` ≈:36, `template/docs/RELEASE-CHECKS.md`, `template/AGENTS.md` ≈:9 and `build-rules.md` :100: RELEASE-CHECKS is the source for generated apps; keep one procedure for the plugin.
- [ ] **Habits**: [starter/CLAUDE.md](starter/CLAUDE.md) and [scripts/agents/habits.md](scripts/agents/habits.md) are near-identical — generate from one source. `header.md` is a different preamble and stays separate.
- [ ] **AI providers**: [apis/references/ai-router.md](skills/apis/references/ai-router.md) vs [new-app/references/ai-and-keys.md](skills/new-app/references/ai-and-keys.md) — one owns provider defaults + the `app-keys.mjs` flow, the other points.
- [ ] *(local)* **Uptime fact** in [new-app:86](skills/new-app/SKILL.md#L86) and [launch:87](skills/launch/SKILL.md#L87) ("every 5 minutes / GitHub only every 6 hours"): keep the source in `ops/references/health.md`, pointers in both.

## 4. Trim token cost

- [ ] **Front-matter descriptions** (design ~100 words, ops ~80, email ~85) load on every use: shorten, drop repeated triggers.
- [ ] **[design SKILL.md](skills/design/SKILL.md)** is 131 lines against the repo's own ~100-line rule ([new-skill:50](skills/new-skill/SKILL.md#L50)): move the optional packs, theme migration, galleries and script flags to references.
- [ ] **[video SKILL.md](skills/video/SKILL.md)**: move the voice, retake, language, quota and pacing details into a reference loaded only after the plan is approved.
- [ ] **build-rules + lessons**: keep the short rules, archive the historical anecdotes.
- [ ] **[social-media.md](skills/launch/references/social-media.md)**: trim only the "Lessons learned" story — the platform table (:43, :47) and rules section already exist.
- [ ] **ux-redesign**: scale the research, personas and mockups to the size of the change.
- [ ] *(optional)* [README.md:153–217](README.md#L153) release notes → `CHANGELOG.md`.

## 5. Contradictions (all verified at `38f2913`)

- [ ] **Touch targets**: 48px ([build-rules :57 and :77](skills/new-app/references/build-rules.md#L57), [design/anti-slop.md:42](skills/design/references/anti-slop.md#L42)) vs 44px ([template/AGENTS.md:63](template/AGENTS.md#L63), [template/DESIGN.md:55](template/DESIGN.md#L55), and `scripts/design/design-md.mjs` ≈:81 which generates DESIGN.md). Pick one baseline + explicit exceptions; the 24px small-controls exception lives at [build-rules.md:86](skills/new-app/references/build-rules.md#L86).
- [ ] **loading.tsx**: [build-rules.md:22](skills/new-app/references/build-rules.md#L22) (pages that can 404 have none — the exception already exists) vs :60 (every signed-in page folder has one). Fix :60's wording to carry the 404 exception; [review/lessons.md:27](skills/review/references/lessons.md#L27) repeats the "every tab" rule — keep in sync.
- [ ] **Auto-merge tests**: [automerge.md](skills/ops/references/automerge.md) lists tests as both safe (:7) and always human-reviewed (:15). Remove tests from the safe list.
- [ ] **Helper models**: [header.md:6](scripts/agents/header.md#L6) says helpers get a smaller, cheaper model; [review SKILL.md:26](skills/review/SKILL.md#L26) requires the strongest model for security/DB areas. Declare a bounded exception in header.md — and align with `scripts/agents/rewrites.mjs` + `core.mjs` :336, which already rewrite Claude model names for Codex/Cursor.
- [ ] **Design vs UX**: [design SKILL.md:104](skills/design/SKILL.md#L104) says a look carries its own menu style; [ux-redesign SKILL.md:17](skills/ux-redesign/SKILL.md#L17) requires theme and layout to stay two separate settings. Separate appearance from navigation, or make a combined preset opt-in.
- [ ] **Video order**: the voice runs in step 3, product registration in step 4, but [footage.md:127](skills/video/references/footage.md#L127) says "Register before the voice." Move registration before the voice step.
- [ ] **Video cleanup vs YouTube master**: [video SKILL.md:104](skills/video/SKILL.md#L104), [qa-render.md:55](skills/video/references/qa-render.md#L55) and `scripts/video-render.mjs` :45 say delete old renders from `video/out/`, while [youtube.md:7](skills/video/references/youtube.md#L7) uploads the master from `video/out/`. Keep the master until upload.
- [ ] **"live" wording**: [new-app:83](skills/new-app/SKILL.md#L83) sets profile `status: live` after a `*.vercel.app` deploy, while [notify.md:12](skills/email/references/notify.md#L12) forbids calling it live on vercel.app. Distinguish "deployed" from "launched on the custom domain".

## 6. Outdated

Confirmed in the repo:

- [ ] [modules/README.md](modules/README.md) is missing the `errors` module from its table.
- [ ] [email SKILL.md:10](skills/email/SKILL.md#L10) still says the student makes a Google app password — the flow uses a Resend key. Cut the phrase.
- [ ] **Node floor**: [README:52](README.md#L52), [INSTALL.md:21](INSTALL.md#L21), [setup SKILL.md:34](skills/setup/SKILL.md#L34) and [check-tools.mjs:32](scripts/check-tools.mjs#L32) say 20+; [check-tools.mjs:11](scripts/check-tools.mjs#L11) enforces 20.9 (Next.js 16 minimum — deliberate); [stores-gotchas.md:5](skills/launch/references/stores-gotchas.md#L5) says supabase-js needs 22; `scripts/video/common.mjs` sets `MIN_NODE_MAJOR = 20`. Node 20 is EOL since April 2026. Move to **Node 22 LTS everywhere**, including the check script and the video tools floor.
- [ ] **Hard-coded Claude model names** (Opus/Sonnet/Haiku) in [new-app:28](skills/new-app/SKILL.md#L28), [setup:19](skills/setup/SKILL.md#L19) and [workflows.md:18](skills/review/references/workflows.md#L18). Describe by tier instead, and extend the existing `rewrites.mjs` mechanism if needed.
- [ ] **vercel@64.3.1** ([vercel.mjs:21](scripts/lib/vercel.mjs#L21), [setup:40](skills/setup/SKILL.md#L40), accounts.md ≈:38): the pin is deliberate and test-enforced, but latest ≈ 64.5.0 — bump it on purpose after a test run, per the comment's own process.

Check live, then update (into one dated reference):

- [ ] Instagram carousel limit (10, [social-media.md:47](skills/launch/references/social-media.md#L47)) and Shorts length (<60 s, :43).
- [ ] Fixed prices, quotas, screenshot requirements and licensing thresholds in `skills/{setup,launch,video}/references`.

## 7. Not issues (checked — leave alone)

- The Vercel pin's reason is documented ([vercel.mjs:17-20](scripts/lib/vercel.mjs#L17)) and enforced by a test.
- Dependabot is properly covered in [automerge.md](skills/ops/references/automerge.md) (setup script writes `dependabot.yml`).
- The 404 exception already exists at [build-rules.md:22](skills/new-app/references/build-rules.md#L22).
- Review already waits for a yes before the full run ([review SKILL.md:24](skills/review/SKILL.md#L24)).
- The CVE-2025-66478 example in [launch SKILL.md:75](skills/launch/SKILL.md#L75) is fine as an illustrative example.

## 8. Rejected claims — do not act on these (kept dead)

- "The 'free nano, decision still open' line is made up" — false; it exists in local commit `dc4c0e4`.
- "The first audit missed `new-skill`" — false; it missed only `review` and `ux-redesign`, which the local checkout lacks.
- "The uptime duplication isn't there" — false for the local tree ([new-app:86](skills/new-app/SKILL.md#L86), [launch:87](skills/launch/SKILL.md#L87)).
- "INSTALL.md doesn't say Node 20+" — false; [INSTALL.md:21](INSTALL.md#L21) says "Node must be 20 or newer".
- "`header.md` is a near-duplicate of the habits files" — false; only `starter/CLAUDE.md` + `habits.md` are.
- "Token counts were inflated" — false; the plan's figures are chars ÷ 4.
- "`lessons.md:27` is a wrong citation" — weak but not wrong (it repeats the "every tab" rule).
- "The Vercel pin is aging / its reason is lost" — false; documented, tested, current.
- Process note from the reviews: the first audit made 2 false accusations of its own (token counts "inflated", lessons citation "wrong") — both retracted. Dead on both sides.

## Done when

- `dc4c0e4` rebased, §2 anonymization applied, **one cleaned push** — no 6x7 content ever enters public GitHub history.
- Every step still runs where it ran, via its content or a pointer.
- Line numbers re-verified after the rebase; the new `look-packs` skill given a quick audit pass.
- Token size measured before/after and lower; outside facts live-checked and dated.
- Tests pass; changes reviewed with the review skills before the PR; the PR says what was tested.
