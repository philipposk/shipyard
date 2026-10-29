# Shipyard — Perplexity Audit and Review

Audit date: 2026-10-30  
Repository: `philipposk/shipyard`  
Audited ref: `main` at `bad158cb3ed746900a767333c0c0461e92367171`

## Executive summary

Shipyard is a well-scoped Claude Code plugin for building, designing, provisioning, launching, and operating Next.js + Supabase + Vercel applications. Its major strengths are broad lifecycle coverage, an explicit security-hook layer, and an unusually extensive test suite.

The principal improvement area is maintainability: the `scripts/` directory has become the plugin’s de facto application, CLI, installer, provisioner, design engine, and operations toolkit. Several features have both flat scripts and feature directories, which creates ambiguity for contributors and AI agents.

Overall assessment:

- Product completeness: **strong**
- Security awareness: **strong**
- Test coverage: **strong**
- Architecture clarity: **needs work**
- Contributor experience: **needs work**

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---:|---|---|---|
| A-01 | P0 | Secret guard | `guard-secrets.mjs` runs on every `Read`, `Edit`, `Write`, `MultiEdit`, `Grep`, `Glob`, `Bash`, `NotebookEdit`, and MCP tool call, with a 10-second timeout. | Add a fast path/caching layer, measure hook latency, and ensure timeout or execution failure has an explicit fail-safe policy. |
| A-02 | P0 | Secret guard | Read-only tools such as `Read`, `Grep`, and `Glob` may trigger expensive secret inspection on large repositories. | Keep strict inspection for writes, shell commands, and MCP calls; use a lighter or size-bounded policy for read-only operations. |
| A-03 | P0 | Security operations | The repository has custom secret scanning, but the audit could not verify GitHub-native secret scanning or push protection settings through the available connector. | Enable GitHub secret scanning and push protection, and add a CI scanner such as Gitleaks or TruffleHog in addition to the in-repo guard. |
| A-04 | P1 | Entry points | `scripts/verify.mjs` and `scripts/verify/` coexist. | Consolidate verification into one canonical module or directory entry point; retain a compatibility wrapper only if necessary. |
| A-05 | P1 | Structure | Several domains have both flat scripts and directories: `launch`, `ops`, `video`, `provision`, `modules`, `shells`, and `design`. | Move each domain to one folder-based command module and publish a stable command map. |
| A-06 | P1 | Packaging | No root `package.json` was visible in the repository root listing. | Add a root manifest with Node engine constraints and scripts for test, lint, verify, and release. |
| A-07 | P1 | Large files | `guard-secrets.mjs` is approximately 34 KB and `install-agents.mjs` is approximately 36 KB. | Split security detection, policy decisions, reporting, and file operations into independently testable modules. |
| A-08 | P2 | Release process | Plugin version is `0.8.6`, but no changelog was present in the root listing. | Add `CHANGELOG.md`, semantic-version policy, and a release checklist connected to `check-release.mjs`. |
| A-09 | P2 | Documentation | `README.md` is approximately 24 KB. | Split into a concise README plus focused docs for installation, security, commands, and troubleshooting. |
| A-10 | P2 | Test execution | The test suite is extensive, but the audit could not execute it in the connected environment. | Run the full suite locally or in CI before applying behavioral refactors, especially to secret guards, provisioning, and deployment. |

## Positive findings

- The plugin manifest is coherent: name, display name, version, description, author, repository, license, keywords, and hook path are declared.
- `hooks/hooks.json` demonstrates a deliberate security-first design by invoking the secret guard before tool use.
- The test directory contains approximately 85 test/helper files covering secrets, guards, provisioning, modules, shells, launch, operations, verification, templates, and video workflows.
- Dedicated tests exist for `guard-secrets`, `lib-secrets`, `verify-secrets`, and `secrets-probes`.
- The plugin covers an end-to-end developer workflow rather than a narrow single-purpose utility.

## Proposed remediation sequence

1. Add root project metadata and a reproducible local development workflow.
2. Add CI for linting, tests, manifest validation, dependency audit, and secret scanning.
3. Consolidate duplicate command entry points without changing user-facing behavior.
4. Refactor the largest security and installer scripts into smaller modules.
5. Add performance benchmarks and failure-mode tests for hooks.
6. Split documentation into focused guides.
7. Add a changelog and release checklist.

## Scope and limitations

This audit was performed through the GitHub connector. It inspected repository structure, plugin metadata, hook configuration, script inventory, and test inventory. It did not execute the repository’s test suite, linting, builds, browser tests, or external Supabase/Vercel integrations.

Behavioral code changes to security, provisioning, deployment, or agent installation should be made only after the repository’s own tests are executed in a controlled environment.
