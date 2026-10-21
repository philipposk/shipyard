#!/usr/bin/env node
// Shipyard secrets guard for Cursor. Cursor runs this before shell commands, file reads, MCP tools and
// some built-in tools (hooks in ~/.cursor/hooks.json, added by install-agents.mjs), with the event as
// JSON on stdin.
//
// Contract:
//   deny    print {"permission":"deny","user_message":"...","agent_message":"..."}, the reason on
//           stderr, and exit 2
//   allow   beforeReadFile: print {"permission":"allow"} (it needs an answer, or the read is blocked).
//           Every other event: print nothing, so Cursor's own approval prompts still run.
//
// It fails OPEN: if anything inside it breaks, the call is allowed. A file's content is never printed.
// Built-ins only, no network.
import { decide, logShape, mcpInputOf } from './agents/guard-input.mjs';
import { readStdin, startedAs } from './agents/entry.mjs';

const NOTHING = { stdout: '', stderr: '', code: 0 };
const ALLOW_READ = { stdout: '{"permission":"allow"}\n', stderr: '', code: 0 };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x) => typeof x === 'string' && x !== '';

function denied(reason) {
  return {
    stdout: `${JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason })}\n`,
    stderr: `${reason}\n`,
    code: 2,
  };
}

/** The fields every mapped call keeps. Never the file content. */
function context(input) {
  const c = {};
  for (const k of ['cwd', 'workspace_roots', 'cursor_version', 'hook_event_name']) if (k in input) c[k] = input[k];
  return c;
}

function firstDeny(inputs, env) {
  for (const i of inputs) {
    const r = decide(i, env, 'cursor');
    if (r.deny) return r;
  }
  return { deny: false };
}

/** A beforeReadFile body too big to parse (cut off): find the file names alone and check them. */
function cutOffRead(text, env) {
  const event = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/.exec(text)?.[1];
  const found = [...text.matchAll(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const isRead = event === 'beforeReadFile' || (event === undefined && found.length > 0 && !/"(command|tool_name)"\s*:/.test(text));
  if (!isRead) return NOTHING;
  for (const raw of found) {
    let filePath;
    try {
      filePath = JSON.parse(`"${raw}"`);
    } catch {
      continue;
    }
    const r = decide({ tool_name: 'Read', tool_input: { file_path: filePath } }, env, 'cursor');
    if (r.deny) return denied(r.reason);
  }
  return ALLOW_READ;
}

/** What the hook prints for this stdin. Pure apart from the optional debug shape log. */
export function respond(text, env = process.env) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    try {
      return cutOffRead(String(text), env);
    } catch {
      return NOTHING;
    }
  }
  try {
    if (!isObj(input)) return NOTHING;
    logShape(input, env, 'cursor');
    const base = context(input);
    switch (input.hook_event_name) {
      case 'beforeReadFile': {
        const files = [input.file_path];
        if (Array.isArray(input.attachments)) for (const a of input.attachments) files.push(isObj(a) ? a.file_path : undefined);
        const calls = files.filter(nonEmpty).map((p) => ({ ...base, tool_name: 'Read', tool_input: { file_path: p } }));
        const r = firstDeny(calls, env);
        return r.deny ? denied(r.reason) : ALLOW_READ;
      }
      case 'beforeShellExecution': {
        if (!nonEmpty(input.command)) return NOTHING;
        const r = firstDeny([{ ...base, tool_name: 'Shell', tool_input: { command: input.command } }], env);
        return r.deny ? denied(r.reason) : NOTHING;
      }
      case 'beforeMCPExecution': {
        const server = nonEmpty(input.mcp_server_name) ? input.mcp_server_name : 'cursor';
        const tool = nonEmpty(input.tool_name) ? input.tool_name : 'tool';
        const r = firstDeny([{ ...base, tool_name: `mcp__${server}__${tool}`, tool_input: mcpInputOf(input.tool_input) }], env);
        return r.deny ? denied(r.reason) : NOTHING;
      }
      case 'preToolUse': {
        const r = decide(input, env, 'cursor');
        return r.deny ? denied(r.reason) : NOTHING;
      }
      default:
        return NOTHING;
    }
  } catch {
    return input?.hook_event_name === 'beforeReadFile' ? ALLOW_READ : NOTHING;
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Shipyard secrets guard for Cursor (a Cursor hook, not run by hand).\n' +
        'Reads a hook event as JSON on stdin. Blocks it (exit 2) if it would expose your keys.\n' +
        'Otherwise it allows file reads and prints nothing for other events.\n',
    );
    return;
  }
  const r = respond(await readStdin());
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (startedAs(import.meta.url, 'guard-cursor.mjs')) {
  main().catch(() => {});
}
