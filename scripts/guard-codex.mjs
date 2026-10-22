#!/usr/bin/env node
// Shipyard secrets guard for Codex. Codex runs this before every tool call (a "PreToolUse" hook in
// ~/.codex/hooks.json, added by install-agents.mjs) and sends the planned call as JSON on stdin.
//
// Contract (the same JSON as Claude Code's):
//   deny    print {"hookSpecificOutput": {"hookEventName": "PreToolUse",
//           "permissionDecision": "deny", "permissionDecisionReason": "..."}} and exit 0
//   allow   print nothing and exit 0 (Codex's own approval flow continues)
//
// It fails OPEN: if anything inside it breaks, the call is allowed. Built-ins only, no network.
import { denyOutput } from './guard-secrets.mjs';
import { decide, logShape } from './agents/guard-input.mjs';
import { readStdin, startedAs } from './agents/entry.mjs';

/** What the hook prints for this stdin. Pure apart from the optional debug shape log. */
export function respond(text, env = process.env) {
  try {
    const input = JSON.parse(text);
    logShape(input, env, 'codex');
    const r = decide(input, env, 'codex');
    if (r.deny) return { stdout: `${denyOutput(r.reason)}\n`, stderr: '', code: 0 };
  } catch {
    // Fail open: a bug in the guard must never block the session.
  }
  return { stdout: '', stderr: '', code: 0 };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Shipyard secrets guard for Codex (a Codex hook, not run by hand).\n' +
        'Reads a planned tool call as JSON on stdin. Prints a deny decision if it would expose your keys,\n' +
        'otherwise prints nothing. Exit code is always 0.\n',
    );
    return;
  }
  const r = respond(await readStdin());
  if (r.stdout) process.stdout.write(r.stdout);
  process.exitCode = r.code;
}

if (startedAs(import.meta.url, 'guard-codex.mjs')) {
  main().catch(() => {});
}
