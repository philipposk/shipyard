# Shipyard security model

## Purpose

Shipyard runs alongside AI coding agents and can inspect files, execute commands, provision cloud resources, and deploy applications. Its security model therefore needs to protect against both ordinary developer mistakes and unsafe agent-driven actions.

## Current protections

### Secret guard hook

`hooks/hooks.json` registers a `PreToolUse` hook that runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard-secrets.mjs"
```

It applies to:

- `Read`
- `Edit`
- `Write`
- `MultiEdit`
- `Grep`
- `Glob`
- `Bash`
- `NotebookEdit`
- MCP tools matching `mcp__.*`

The hook timeout is 10 seconds.

## Recommended policy

1. **Fail closed for high-risk operations.** Writes, shell execution, and MCP tool calls should be blocked when secret detection cannot complete safely.
2. **Use a lighter read path.** Read-only tools should not incur the same cost as write or execution paths.
3. **Cache safely.** Cache scan results by content hash, file path, and modification time, but invalidate on every change.
4. **Redact before logging.** Never write raw secret values to logs, test snapshots, error messages, or generated reports.
5. **Test adversarial fixtures.** Cover AWS keys, Supabase service keys, Stripe keys, OpenAI/Anthropic keys, Vercel tokens, GitHub tokens, private keys, JWTs, database URLs, and encoded secrets.
6. **Use defense in depth.** Keep Shipyard’s guard, but also enable GitHub secret scanning, push protection, and an independent CI scanner.

## Threat model

| Threat | Risk | Mitigation |
|---|---|---|
| Developer commits a real credential | Credential leakage | Pre-commit guard, CI scanner, GitHub push protection |
| Agent writes a secret into a generated file | Persistent leakage | Block or redact writes containing detected secrets |
| Agent runs a command that exfiltrates environment variables | Credential exfiltration | Inspect Bash commands and MCP invocations; require confirmation for risky operations |
| Prompt injection instructs unsafe behavior | Arbitrary command or file modification | Least-privilege defaults, allowlists, dry-run modes, explicit confirmation for destructive actions |
| Hook times out | Security control bypass | Define explicit timeout behavior; fail closed for high-risk operations |
| False positive blocks normal work | Poor developer experience | Maintain precise allowlists, contextual rules, and actionable error messages |

## Testing expectations

Security changes must include:

- Positive detections for supported secret formats
- Negative cases for common false positives
- Redaction tests
- Timeout and failure-mode tests
- Tests proving that secrets are not logged or written to output files
- Tests for Bash, file-write, and MCP tool pathways
