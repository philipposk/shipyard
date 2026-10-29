# Shipyard deep source review

Review date: 2026-10-30  
Scope: `scripts/guard-secrets.mjs`, `scripts/install-agents.mjs`, plugin hooks, and CI configuration.

## Corrections to earlier audit

### A-01 — Secret guard performance

The earlier finding overstated the performance risk. `guard-secrets.mjs` does not scan the contents of every file read by Claude. It inspects the planned tool input: file paths, glob patterns, shell commands, and MCP arguments.

The remaining performance concern is therefore moderate rather than P0. The guard performs regex parsing, wildcard expansion, shell segmentation, and recursive MCP-object traversal, but it applies bounds such as a 10,000-string budget, depth limit of 32, and a 20,000-character value limit.

**Revised severity:** P2.  
**Recommendation:** Add hook latency benchmarks and ensure pathological MCP payloads cannot cause excessive work.

### A-02 — Read-tool coverage

The guard intentionally covers `Read`, `Grep`, and `Glob` to prevent an agent from reading `.env`, `secrets.env`, `.env.*`, Shipyard backups, or wildcard paths that could resolve to those files.

This is a deliberate security control, not unnecessary overhead.

**Revised severity:** No change required.  
**Recommendation:** Preserve read-path protection and expand fixture coverage for encoded, nested, and platform-specific paths.

## High-priority source findings

### CR-01 — Guard fails open

`guard-secrets.mjs` explicitly states that it fails open: if something inside the guard breaks, the tool call is allowed.

This is understandable for usability, but it means a bug, timeout, malformed payload, or runtime failure can disable the security boundary.

**Severity:** P0.  
**Recommendation:**

- Add an explicit `SHIPYARD_GUARD_FAILURE_POLICY` setting.
- Default to `fail-open` only for low-risk read operations, preserving current usability.
- Use `fail-closed` for `Bash`, MCP tool calls, and file writes.
- Log a clear, non-secret-containing diagnostic when the guard fails.
- Add tests for malformed JSON, missing fields, exceptions, timeout behavior, and oversized payloads.

### CR-02 — Hook check executes commands from a user-modifiable file

`install-agents.mjs` uses `spawnSync(command, { shell: true })` in `hookBlocks()` to test whether the installed hook blocks a sample secret-file read.

The check does validate that the discovered hook command references the expected Shipyard root, but it can still execute `found[0].command` even when it detects a command from another Shipyard folder.

If an attacker or malformed process modifies the agent hooks file, `--check` could execute an unexpected command.

**Severity:** P1.  
**Recommendation:**

- Only execute a hook command after exact structural validation.
- Refuse to run commands that do not exactly match the expected Node binary plus expected Shipyard script path.
- Avoid `shell: true`; invoke Node directly with an argument array where possible.
- Add tests for tampered hooks files, path traversal, shell metacharacters, and commands from another Shipyard installation.

### CR-03 — Codex script trust expands blast radius

The optional Codex rule allows Codex to run Shipyard’s own scripts without asking, outside its sandbox, with access to files and the internet.

The installer explains this clearly and defaults it to off, which is good. However, this is still a high-consequence permission because a compromised or buggy Shipyard script could then perform destructive or network-enabled actions without per-command approval.

**Severity:** P1.  
**Recommendation:**

- Keep the default disabled.
- Show a stronger explicit warning before enabling it.
- Add an `--audit` mode that lists exactly which scripts would be trusted.
- Consider a narrow allowlist of individual scripts rather than trusting every script under `scripts/`.
- Add regression tests ensuring the generated rule cannot accidentally broaden beyond Shipyard’s own scripts.

### CR-04 — Non-interactive `--yes`

`--yes` allows the installer to modify files without an interactive confirmation, including in non-TTY environments.

This is useful for automation but reduces the human checkpoint for changes to agent configuration.

**Severity:** P2.  
**Recommendation:**

- Retain `--yes` for CI and scripted installation.
- Add `--require-interactive` or environment-specific guardrails for high-risk operations.
- Print a machine-readable plan with `--json` so automation can inspect intended changes before applying them.

## Strengths confirmed by source review

### Secret guard

- It protects `.env`, `.env.local`, `.env.production`, `secrets.env`, and related backup paths.
- It distinguishes example files such as `.env.example` from real secret files.
- It parses shell commands into segments and handles quotes, redirects, command substitution, pipes, and logical operators.
- It detects common environment-exposure commands, including `printenv`, bare `env`, `set`, `export`, `declare`, `npm run env`, and GitHub CLI token commands.
- It protects against wildcard paths such as `.e*`, `.en[v].local`, and patterns that could expand into the Shipyard home directory.
- It handles recursive grep, ripgrep, ag, and Git grep cases that may bypass ignore files.
- It applies bounded traversal to nested MCP tool inputs.

### Agent installer

- It separates planning from mutation.
- It supports `--dry-run`, `--check`, `--update`, and `--uninstall`.
- It creates a one-time backup before first modifying an existing hooks file.
- It writes files atomically through a temporary file and rename.
- It records installation metadata without storing secrets.
- It verifies that the installed hook actually blocks a test attempt to read `~/.shipyard/secrets.env`.
- It detects stale skills, changed skill folders, missing Node binaries, and hooks pointing at another Shipyard copy.

## Recommended implementation order

1. Add failure-policy tests and implement configurable fail-open/fail-closed behavior in the guard.
2. Harden `hookBlocks()` so it never executes an unvalidated hook command.
3. Add adversarial fixtures for shell parsing, MCP payloads, wildcards, encoded paths, and Windows paths.
4. Add latency benchmarks for the guard under normal and pathological inputs.
5. Narrow the Codex script-trust rule or add per-script allowlisting.
6. Add CI jobs for unit tests, linting, manifest validation, dependency audit, and independent secret scanning.
7. Keep behavioral refactors separate from security fixes so each change is easy to review and revert.

## Execution limitation

This review inspected source code through the GitHub connector. It did not execute the repository’s test suite, install the plugin locally, run Claude/Cursor hooks, or exercise live Supabase, Vercel, Stripe, email, browser, or video integrations.

The next phase should be a local verification run: install dependencies, execute the full test suite, run the guard against adversarial fixtures, and only then apply behavioral security patches.
