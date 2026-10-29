# Shipyard execution and secrets-check review

Review date: 2026-10-30  
Scope: CI workflows, `scripts/secrets-check.mjs`, and `scripts/verify.mjs`.

## Corrections to the audit

### CI is present

The repository contains GitHub Actions workflows:

- `.github/workflows/test.yml`
- `.github/workflows/release.yml`

Therefore, the earlier recommendation to “add CI” should be narrowed: review and strengthen the existing workflows rather than create CI from scratch.

**Corrected action:** Inspect `test.yml` and `release.yml` for Node versions, caching, concurrency, permissions, artifact retention, secret handling, and whether the full test suite runs on pull requests.

### Verify entry point is intentional

`scripts/verify.mjs` is the CLI entrypoint, while `scripts/verify/` contains its check modules, formatting, utilities, and check registry.

This is a normal and reasonable structure.

**Closed:** Original audit item A-04 is withdrawn. Do not consolidate `verify.mjs` and `scripts/verify/`.

## Secrets checker findings

### SC-01 — SerpAPI key appears in a URL

`secrets-check.mjs` performs a live SerpAPI check by placing the API key in the request URL:

```text
https://serpapi.com/account.json?api_key=<key>
```

URLs are more likely than headers to appear in provider logs, proxy logs, error messages, or monitoring systems.

**Severity:** P2.  
**Recommendation:** Use a header-based authentication probe if SerpAPI supports one. If URL authentication is unavoidable, ensure errors and diagnostics never include the full URL.

### SC-02 — Live checks have provider costs

The Brave and Serper probes consume one search credit each. This is documented in the help text, but it is still a side effect that may surprise users.

**Severity:** P2.  
**Recommendation:** Before running `--live`, print the exact providers that will be contacted and any known credit cost. Add a `--yes` confirmation or explicit opt-in for paid/quota-consuming checks.

### SC-03 — Live checks are intentionally network-bound

`--live` sends keys to Supabase, OpenRouter, OpenAI, Groq, Deepgram, Resend, Stripe, ElevenLabs, Gemini, Brave, Serper, SerpAPI, and Upstash.

This is appropriate for credential validation, but it should remain explicit and opt-in.

**Severity:** No defect.  
**Recommendation:** Keep `--live` opt-in, preserve the format gate that prevents sending malformed keys, and continue avoiding key values in JSON or human-readable output.

## Verifier findings

### VR-01 — Report redaction should be comprehensive

`verify.mjs` creates a redactor from the app’s `.env.local` secrets and applies it to crash messages. However, individual checks may place sensitive values into `details` or other report fields.

The final report is written to `<appDir>/.shipyard/verify.json` and may also be summarized into the Shipyard profile.

**Severity:** P2.  
**Recommendation:** Apply the redactor to every string field in the final report, including `summary`, `problems`, `details`, nested objects, and URLs. Add tests using fake secrets in headers, query strings, HTML, JSON responses, and error messages.

### VR-02 — Verification semantics are strong

The verifier correctly avoids treating “nothing verified” as success:

- A crashing check becomes a failed check.
- A successful result requires at least one passed check.
- When specific checks are requested, skipped checks prevent a successful result.
- Checks that require a URL are skipped when no URL is available.

This is a good CI-friendly design.

## Final audit status

### Completed through GitHub

- Repository and plugin structure review
- Claude plugin manifest and hook configuration review
- Script and test inventory review
- Deep review of `guard-secrets.mjs`
- Deep review of `install-agents.mjs`
- Review of `secrets-check.mjs`
- Review of `verify.mjs`
- CI workflow inventory
- Security architecture and threat-model documentation
- Audit findings, severity ratings, and remediation plan

### Requires local execution

The following cannot be completed through the GitHub connector:

- Dependency installation
- Full test-suite execution
- Linting and type/format checks, if configured
- Claude Code, Codex, and Cursor hook execution
- Browser-based verification
- Live Supabase, Vercel, Stripe, email, search, and AI-provider checks
- Dynamic fuzzing of shell parsing and MCP input handling

### Final priority queue

1. **P0 — CR-01:** Make guard failure behavior explicit and fail closed for high-risk operations.
2. **P1 — CR-02:** Prevent `install-agents.mjs --check` from executing unvalidated hook commands.
3. **P1 — CR-03:** Narrow or make more explicit the Codex outside-sandbox script-trust permission.
4. **P2 — SC-01:** Avoid placing the SerpAPI key in a URL.
5. **P2 — VR-01:** Apply report-wide redaction in `verify.mjs`.
6. **P2 — SC-02:** Make live-check costs and network effects explicit.
7. **P2 — A-07:** Split the largest guard and installer modules into smaller testable units.
8. **P2 — A-08/A-09:** Continue improving release documentation and split the long README into focused guides.
