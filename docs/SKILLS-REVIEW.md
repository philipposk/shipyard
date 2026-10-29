# Shipyard skill-by-skill review

Review date: 2026-10-30  
Scope: all 11 top-level skills in `skills/`.

## Coverage

All 11 `SKILL.md` files were read and reviewed:

- `apis`
- `design`
- `email`
- `launch`
- `new-app`
- `new-skill`
- `ops`
- `review`
- `setup`
- `ux-redesign`
- `video`

This review covers each skill’s main instructions and workflow. It does not execute skills in Claude Code, Codex, or Cursor, and it does not replace a local end-to-end test run.

## Overall assessment

The skills are unusually consistent. They share a clear safety model: never ask for keys in chat, never read secret files, route secrets through Shipyard scripts, ask before GitHub pushes or publishing, verify before claiming completion, and distinguish verified work from unverified work.

The main risks are not in the overall product concept. They are in a small number of concrete instruction defects, cross-skill reference coupling, and expensive workflows that need standardized cost disclosure.

## Skill assessments

### setup

**Assessment: strong.**

The skill provides staged onboarding for GitHub, Vercel, Supabase, optional AI keys, email, Stripe, domains, profile defaults, and working habits. Progress is stored in `~/.shipyard/profile.json`, allowing resumption after interruption.

Strengths:

- Uses `setup-status.mjs` to resume from the correct step.
- Keeps keys out of chat and uses `secrets-init.mjs` plus `secrets-check.mjs`.
- Explains optional services and free-tier limitations.
- Asks before modifying the user’s global Claude settings.

Findings:

- **P2 — pinned dependency:** The skill pins `vercel@64.3.1`. This improves reproducibility but needs a documented upgrade path so the pin does not become stale.
- **P2 — live credential check:** `secrets-check.mjs --live` sends the Supabase access token to Supabase. This is appropriate for validation, but the skill should make the network effect explicit before running it.

### new-app

**Assessment: strong workflow, two important defects.**

This is the central skill: it interviews the user, writes a specification, scaffolds an app, builds features, provisions Supabase, publishes to GitHub and Vercel, verifies the result, creates an owner account, and hands off.

Strengths:

- Clear handling of Shipyard-made, general, and damaged app folders.
- Strong rules around secrets, commits, branches, pull requests, and verification.
- Good database guidance: RLS, isolation metadata, numbered migrations, and shared-project safeguards.
- Requires verification after fixes rather than relying on an earlier clean run.

Findings:

- **P1 — possible missing script:** The skill instructs:

  ```bash
  node scripts/secret-scan.mjs --staged
  ```

  The repository script inventory reviewed during this audit listed `secrets-check.mjs`, `secrets-init.mjs`, and `guard-secrets.mjs`, but not `secret-scan.mjs`. Either the reference is stale or the script is missing.

- **P1 — secret in command line:** The skill instructs:

  ```bash
  SUPABASE_ACCESS_TOKEN=... node "${CLAUDE_PLUGIN_ROOT}/skills/review/references/rls-speed.mjs" <project-ref>
  ```

  This conflicts with Shipyard’s own rule against placing secrets in command lines. Command-line environment assignments can be exposed through process listings, shell history depending on the environment, and error/diagnostic tooling.

  **Recommendation:** Add a dedicated script or supported flag that reads the token from the Shipyard secrets store, or pass it through a protected temporary environment file.

- **P2 — cross-skill coupling:** The skill depends on references in `skills/review/` and `skills/launch/`. This is workable inside the monorepo, but it makes individual skills harder to test, package, and reuse independently.

### launch

**Assessment: strong.**

The launch skill covers domains, transactional email, legal pages, Stripe payments, newsletters, mobile/desktop shells, store publication, social media, SEO, and a go-live gate.

Strengths:

- Keeps payments in test mode until the user explicitly approves live mode.
- Clearly labels legal and tax material as drafts rather than advice.
- Enforces branch/pull-request discipline after go-live.
- Provides a concrete go-live check through `launch-check.mjs`.

Findings:

- **P2 — external claims:** The skill includes deliverability and CVE-specific claims. These should be periodically validated or moved into dated reference documentation so they do not become stale in the main skill instructions.

### apis

**Assessment: strong.**

The skill covers API keys, web search, speech services, AI model routing, and Upstash-based rate limiting.

Strengths:

- Requires server-side routes for paid API calls.
- Requires authentication, rate limits, input-size limits, and failure handling.
- Keeps key entry and validation inside Shipyard scripts.
- Distinguishes tested guidance from features marked as untested in production.

Findings:

- **P2 — cost disclosure:** `secrets-check.mjs --live` can consume Brave or Serper search credits. The skill mentions this, but the agent should confirm before running quota-consuming checks.

### design

**Assessment: strong.**

The design skill supports presets, screenshots, external URLs, design files, and three-direction proposals. It produces light/dark pairs, checks contrast, and integrates with verification.

Strengths:

- Explicitly avoids copying logos, images, wording, brand names, or trademarks.
- Requires AA contrast in light and dark modes.
- Uses `--dry-run` where appropriate.
- Keeps design tokens script-managed rather than encouraging manual edits.

Findings:

- **P2 — external URL capture:** `design-from-url.mjs` fetches and screenshots third-party websites. The skill correctly says it does not save images, logos, or text, but the privacy/data-retention behavior should be documented in the security documentation.

### email

**Assessment: strong.**

The skill handles domain receiving through ImprovMX, Gmail send-as through Resend SMTP, SPF/DKIM/DMARC guidance, owner notifications, and deliverability checks.

Strengths:

- Checks public DNS before suggesting changes.
- Avoids modifying unrelated DNS records.
- Requires user consent before sending email to anyone other than the owner.
- Keeps SMTP credentials out of chat and the repository.

Findings:

- **P2 — evidence-based claims:** The mail-tester score comparison is based on a specific measurement. It is useful context, but should be dated or moved to a reference document to avoid presenting one result as a universal guarantee.

### new-skill

**Assessment: strong.**

This skill helps users create skills or plugins, including specification, pushback on weak ideas, scaffolding, testing, and publishing.

Strengths:

- Requires consent before reading codebases or agent chats.
- Restricts reading to relevant files and summaries rather than whole transcripts.
- Requires confirmation for publishing, pushing, opening PRs, and submissions.
- Encourages tests and real trigger-phrase validation.

Findings:

- **P2 — publication safety:** The skill asks before each publishing action, which is good. It should also explicitly warn that publishing may make content publicly accessible and cannot always be fully undone.

### ops

**Assessment: strong.**

The ops skill covers error logging, alerts, scheduled health checks, code review, auto-merge, project reviews, backups, and self-healing.

Strengths:

- Uses `ops-status.mjs` to show current state before making changes.
- Keeps `CRON_SECRET` handling inside scripts.
- Requires confirmation for repository settings, workflows, merges, and cost-incurring actions.
- Honestly documents free-tier limitations and scheduled-workflow pauses.

Findings:

- **P2 — backup privacy:** Backups contain user data. The skill correctly says so, but the handoff should also specify retention, encryption-at-rest expectations, and deletion procedures.

### review

**Assessment: powerful, but expensive.**

This is the largest workflow: multi-area review, skeptic validation, wave-based fixes, second review, production checks, performance checks, and stacked pull requests.

Strengths:

- Uses a fresh worktree from `origin/main`, protecting the user’s working folder.
- Requires baseline type checks, tests, and builds before review.
- Treats helper-agent claims as leads rather than proof.
- Requires a second review of fixes.
- Avoids changing deployment infrastructure during review.

Findings:

- **P2 — cost and scale:** A full review may run 100 or more helper agents and consume a large share of the user’s plan. The warning exists, but Shipyard should standardize a pre-flight estimate and require explicit confirmation.
- **P2 — helper-agent boundaries:** The skill gives good model-tier guidance, but helper prompts should also include explicit prohibitions on network access, secret access, and modifying files outside the assigned worktree.

### ux-redesign

**Assessment: strong.**

The skill performs a code-based UX audit, workflow analysis, competitive pattern research, mockups, and incremental rollout behind a beta switch.

Strengths:

- Requires file-path evidence for audit claims.
- Measures current versus proposed workflow step counts.
- Uses mockups and user approval before implementation.
- Separates theme from layout.
- Uses stacked pull requests and a beta flag.

Findings:

- **P2 — optional external tool:** The skill optionally uses Superdesign CLI. It correctly continues if setup fails, but should clarify what data, if any, is sent to that external service.

### video

**Assessment: strong.**

The video skill creates product videos using rebuilt UI, real-app footage, or an advanced real-run recording. It includes voice generation, rendering, captions, web publishing, and YouTube guidance.

Strengths:

- Requires script approval before paid voice generation.
- Uses invented data and forbids real customer data, names, emails, or account screenshots.
- Requires AI-voice disclosure.
- Keeps renders in the foreground and avoids background dev servers.
- Makes publishing and GitHub saves explicit user decisions.

Findings:

- **P2 — licensing disclosure:** The skill correctly mentions Remotion’s licensing threshold. This should be checked on each release because third-party license terms can change.
- **P2 — cost transparency:** Voice generation, re-takes, rendering, and model usage can add up. The skill discloses this, but a standardized pre-flight estimate would improve consistency.

## Cross-cutting findings

### SK-01 — Validate every referenced script

Skills reference many scripts. The `new-app` reference to `scripts/secret-scan.mjs` appears inconsistent with the reviewed script inventory.

**Severity:** P1.  
**Recommendation:** Add a CI test that extracts every `scripts/*.mjs` reference from all `SKILL.md` and `references/` files and verifies the target exists.

### SK-02 — Standardize secret handling

Most skills are excellent, but `new-app` includes a command-line environment assignment containing `SUPABASE_ACCESS_TOKEN`.

**Severity:** P1.  
**Recommendation:** Create one supported mechanism for scripts that need a Supabase token, such as reading from the Shipyard secrets store or a protected temporary file.

### SK-03 — Reduce cross-skill reference coupling

Skills refer to references in other skills, especially `new-app/references/upgrade.md`, `skills/review/references/speed.md`, and `skills/review/references/rls-speed.mjs`.

**Severity:** P2.  
**Recommendation:** Keep shared guidance in a top-level `docs/` or shared references area, or generate per-skill packs with resolved references.

### SK-04 — Standardize cost and side-effect disclosure

`setup`, `apis`, `review`, and `video` can trigger network calls, provider quota usage, paid API usage, or heavy model usage.

**Severity:** P2.  
**Recommendation:** Add a common pre-flight pattern: list providers, expected cost, expected duration, and whether the action is reversible; require explicit confirmation for paid or quota-consuming actions.

### SK-05 — Add skill contract tests

The plugin has strong script tests, but skill instructions should also have contract tests.

**Severity:** P2.  
**Recommendation:** Validate front matter, trigger phrases, referenced files, referenced scripts, command syntax, and required safety statements for every skill.

## Priority queue

1. **P1:** Resolve the `secret-scan.mjs` reference in `new-app`.
2. **P1:** Remove the `SUPABASE_ACCESS_TOKEN=...` command-line pattern from `new-app`.
3. **P2:** Add a reference/script existence test across all skills.
4. **P2:** Standardize cost, quota, and network-effect disclosure.
5. **P2:** Reduce or resolve cross-skill reference coupling.
6. **P2:** Add skill front-matter and safety-language contract tests.
7. **P2:** Document external-service data handling for design URL capture and optional UX tools.
