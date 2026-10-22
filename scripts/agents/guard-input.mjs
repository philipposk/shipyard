// Reads tool calls from Codex, Cursor and other agents as Claude Code shaped calls, so the one
// secrets check in guard-secrets.mjs (evaluate) decides for every agent. Built-ins only, no network.
//
// Claude Code never reaches this file: guard-secrets.mjs sends its own payloads straight to evaluate().
// Everything here fails open: an input it cannot read is allowed, never blocked.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { evaluate, splitCommand, REASON } from '../guard-secrets.mjs';

export const OPEN_SHELL_REASON =
  'Shipyard keeps your keys out of the chat. Start the exact command you need instead of an open shell or interpreter: what is typed into it later is not checked.';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const SHELL_NAMES = new Set(['Bash', 'Shell', 'shell', 'exec_command', 'local_shell', 'unified_exec', 'container.exec', 'run_terminal_cmd']);
const PATCH_NAMES = new Set(['apply_patch', 'ApplyPatch']);
const WRAP_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const WRAP_FLAGS = new Set(['-c', '-lc', '-lic', '-ic', '-cl']);
const INTERACTIVE = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'node', 'irb', 'ruby', 'perl', 'php']);
// Flags that make one of those programs print something and stop, instead of waiting for typed input.
const ONE_SHOT_FLAGS = new Set(['--version', '-v', '-V', '-version', '-Version', '--help', '-h', '-help', '-Help', '-?', '/?', '--test']);
const PROGRAM_PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', '!']);
const PATH_KEY = /^(path|paths|file|files|file_?path|file_?paths|filepath|filepaths|target_?file|target_?directory|directory|dir|dir_?path|absolute_?path)$/i;
const CANARY = /\.env\.shipyard-guard-check-([0-9a-f]{16})(?![0-9a-f])/;
const GREP_TIP = ' For a recursive search use the Grep tool, or add ';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x) => typeof x === 'string' && x !== '';
const norm = (p) => String(p).replace(/\\/g, '/');
const programName = (w) => {
  const s = norm(w).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd)$/, '');
};
const isAbsoluteLike = (p) => /^([/~]|\$\{?HOME\}?(\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(p);

function shipyardHomeDir(env) {
  return env.SHIPYARD_HOME ? path.resolve(env.SHIPYARD_HOME) : path.join(os.homedir(), '.shipyard');
}

// ---------- where the command runs ----------

/** The folder a call runs in: the call's own folder first, then the session's, then the project's. */
function pickCwd(input, ti, env) {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const base = [input.cwd, roots[0], env.CURSOR_PROJECT_DIR, env.CLAUDE_PROJECT_DIR].find(nonEmpty) ?? null;
  if (isObj(ti)) {
    for (const key of ['workdir', 'cwd', 'working_directory']) {
      const v = ti[key];
      if (!nonEmpty(v)) continue;
      if (isAbsoluteLike(v) || !base) return v;
      return path.posix.normalize(`${norm(base).replace(/\/+$/, '')}/${norm(v)}`);
    }
  }
  return base;
}

// ---------- shell commands ----------

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~^-]+$/;
const shQuote = (w) => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function commandOf(ti) {
  if (!isObj(ti)) return null;
  for (const key of ['command', 'cmd', 'commands']) {
    const v = ti[key];
    if (typeof v === 'string' || Array.isArray(v)) return v;
  }
  return null;
}

/** `bash -lc 'X'` (up to two levels) becomes X, so trusted Shipyard scripts inside a wrapper are seen as such. */
export function unwrapCommand(cmd) {
  let c = String(cmd);
  for (let n = 0; n < 2; n++) {
    let segments;
    try {
      segments = splitCommand(c);
    } catch {
      break;
    }
    if (segments.length !== 1 || segments[0].unsafe) break;
    const w = segments[0].words;
    if (w.length === 3 && WRAP_SHELLS.has(programName(w[0])) && WRAP_FLAGS.has(w[1])) c = w[2];
    else break;
  }
  return c;
}

/** An argument list (no shell involved) as one command line, quoted so each word stays one word. */
export function joinArgv(words) {
  const w = words.map((x) => String(x));
  if (w.length === 3 && WRAP_SHELLS.has(programName(w[0])) && WRAP_FLAGS.has(w[1])) return w[2];
  return w.map(shQuote).join(' ');
}

/** Does this command open a shell or interpreter that waits for typed input (which no hook sees)? */
export function opensInteractive(cmd) {
  let segments;
  try {
    segments = splitCommand(cmd);
  } catch {
    return false;
  }
  // After a pipe a program reads the pipe, not the keyboard, so only plain sequences are checked.
  const candidates = segments.length === 1 || !String(cmd).includes('|') ? segments : [];
  return candidates.some(({ words }) => {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PROGRAM_PREFIXES.has(words[i]))) i++;
    if (i >= words.length) return false;
    const name = programName(words[i]);
    if (!INTERACTIVE.has(name)) return false;
    const args = words.slice(i + 1);
    if (args.includes('<')) return false; // input comes from a file or a heredoc
    if (args.some((a) => ONE_SHOT_FLAGS.has(a))) return false;
    if (args.some((a) => !a.startsWith('-') && !(name === 'cmd' && a.startsWith('/')))) return false;
    if (args.some((a) => a === '-c' || a === '-e' || a === '-p' || WRAP_FLAGS.has(a))) return false;
    return true;
  });
}

// ---------- patches (Codex apply_patch) ----------

const PATCH_LINE = /^\*\*\* (Add File|Update File|Move to): (.+?)\s*$/gm;
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';

function patchTextOf(ti) {
  for (const key of ['command', 'input', 'patch']) {
    const v = ti[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const strings = v.filter((x) => typeof x === 'string');
      if (strings.length) return strings[strings.length - 1];
    }
  }
  return '';
}

/** Every file a patch adds, changes or moves to becomes an Edit of that file. Deleting is like `rm`: allowed. */
function patchEdits(text, call) {
  const calls = [];
  for (const m of String(text).matchAll(PATCH_LINE)) calls.push(call('Edit', { file_path: m[2].trim() }));
  return calls;
}

/** `apply_patch <<'EOF' ... EOF; more`: the patch body, and the command without it. */
function splitPatch(cmd) {
  const begin = cmd.indexOf(BEGIN);
  if (begin === -1) return { text: '', rest: cmd };
  const endAt = cmd.indexOf(END, begin);
  const end = endAt === -1 ? cmd.length : endAt + END.length;
  return { text: cmd.slice(begin, end), rest: cmd.slice(0, begin) + cmd.slice(end) };
}

function shellCalls(ti, call) {
  const raw = commandOf(ti);
  if (raw === null) return { calls: [] };
  let cmd;
  if (Array.isArray(raw)) {
    const words = raw.map((x) => String(x));
    if (words.length && programName(words[0]) === 'apply_patch') {
      const text = words.slice(1).filter((w) => w.includes('***')).pop() ?? words[words.length - 1] ?? '';
      return { calls: patchEdits(text, call) };
    }
    cmd = joinArgv(words);
  } else {
    cmd = String(raw);
  }
  cmd = unwrapCommand(cmd);
  if (/^\s*apply_patch(\s|$)/.test(cmd)) {
    const { text, rest } = splitPatch(cmd);
    return { calls: [...patchEdits(text, call), call('Bash', { command: rest })] };
  }
  if (opensInteractive(cmd)) return { calls: [], deny: OPEN_SHELL_REASON };
  return { calls: [call('Bash', { command: cmd })] };
}

// ---------- file and search tools ----------

const firstString = (ti, keys) => keys.map((k) => ti[k]).find(nonEmpty);

function fileAliases(ti) {
  const t = { ...ti };
  if (typeof t.file_path !== 'string') {
    const v = firstString(ti, ['path', 'target_file']);
    if (v !== undefined) t.file_path = v;
  }
  return t;
}

function searchAliases(ti, tool) {
  const t = { ...ti };
  if (typeof t.path !== 'string') {
    const v = firstString(ti, ['target_directory', 'directory', 'dir', 'dir_path']);
    if (v !== undefined) t.path = v;
  }
  if (tool === 'Glob') {
    if (typeof t.pattern !== 'string') {
      const v = firstString(ti, ['glob_pattern', 'glob', 'include', 'include_pattern']);
      if (v !== undefined) t.pattern = v;
    }
    return t;
  }
  if (typeof t.glob !== 'string') {
    const v = firstString(ti, ['include', 'include_pattern', 'glob_pattern']);
    if (v !== undefined) t.glob = v;
  }
  if (typeof t.pattern !== 'string') {
    const v = firstString(ti, ['query', 'regex']);
    if (v !== undefined) t.pattern = v;
  }
  return t;
}

function pathValues(ti) {
  const out = [];
  for (const [k, v] of Object.entries(ti)) {
    if (!PATH_KEY.test(k)) continue;
    if (nonEmpty(v)) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (nonEmpty(x)) out.push(x);
  }
  return out;
}

function toolInputOf(input) {
  let ti = input.tool_input ?? input.arguments;
  if (typeof ti === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(ti);
    } catch {
      return { command: ti };
    }
    if (isObj(parsed)) return parsed;
    return { command: typeof parsed === 'string' || Array.isArray(parsed) ? parsed : ti };
  }
  if (Array.isArray(ti)) return { command: ti };
  return isObj(ti) ? ti : {};
}

/** Cursor's own hook events, for when one reaches a guard that is not guard-cursor.mjs. */
function cursorEventCalls(input, call) {
  const event = input.hook_event_name;
  if (event === 'beforeShellExecution' && nonEmpty(input.command)) return shellCalls({ command: input.command }, call);
  if (event === 'beforeReadFile') {
    const files = [input.file_path];
    if (Array.isArray(input.attachments)) for (const a of input.attachments) files.push(isObj(a) ? a.file_path : undefined);
    return { calls: files.filter(nonEmpty).map((p) => call('Read', { file_path: p })) };
  }
  if (event === 'beforeMCPExecution') {
    const server = nonEmpty(input.mcp_server_name) ? input.mcp_server_name : 'cursor';
    const name = nonEmpty(input.tool_name) ? input.tool_name : 'tool';
    return { calls: [call(`mcp__${server}__${name}`, mcpInputOf(input.tool_input))] };
  }
  return { calls: [] };
}

/** An MCP tool's input: an object, or a JSON string of one. Anything else is read as a command line. */
export function mcpInputOf(raw) {
  if (isObj(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (isObj(parsed)) return parsed;
  } catch {
    // not JSON
  }
  // `command`, never `text`: the MCP check skips prose keys like `text`.
  return { command: raw };
}

/**
 * Turn one planned tool call from any agent into zero or more Claude Code shaped calls.
 * Returns { calls, deny? }. `deny` is a reason when the call itself is refused (an open shell).
 */
export function normalizeInput(input, env = process.env) {
  if (!isObj(input)) return { calls: [] };
  let tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = toolInputOf(input);
  const cwd = pickCwd(input, ti, env);
  const call = (tool_name, tool_input) => ({ ...input, tool_name, tool_input, cwd: cwd ?? undefined });

  // Cursor's own events (beforeShellExecution, beforeReadFile, beforeMCPExecution) carry no tool name.
  if (tool === '') return cursorEventCalls(input, call);

  const cursorMcp = /^MCP:(.+)$/.exec(tool);
  if (cursorMcp) tool = `mcp__cursor__${cursorMcp[1]}`;

  if (tool.startsWith('mcp__')) return { calls: [call(tool, ti)] };
  if (FILE_TOOLS.has(tool)) return { calls: [call(tool, fileAliases(ti))] };
  if (SEARCH_TOOLS.has(tool)) return { calls: [call(tool, searchAliases(ti, tool))] };
  if (PATCH_NAMES.has(tool)) return { calls: patchEdits(patchTextOf(ti), call) };
  if (SHELL_NAMES.has(tool)) return shellCalls(ti, call);
  // Text typed into a program that is already running (Codex write_stdin), read like a command.
  if (/stdin/i.test(tool)) {
    const typed = firstString(ti, ['chars', 'input', 'text', 'data']);
    return { calls: typed === undefined ? [] : [call('Bash', { command: typed })] };
  }

  // Names this file does not know, from newer or other agents.
  if (/read|view|open|cat/i.test(tool)) {
    const paths = pathValues(ti);
    if (paths.length) return { calls: paths.map((p) => call('Read', { file_path: p })) };
  }
  if (/grep|search|find|glob/i.test(tool)) return { calls: [call('Grep', searchAliases(ti, 'Grep'))] };
  if (/exec|shell|command|terminal|run/i.test(tool) && commandOf(ti) !== null) return shellCalls(ti, call);
  return { calls: pathValues(ti).map((p) => call('Read', { file_path: p })) };
}

// ---------- trusting a second Shipyard install ----------

/** Other Shipyard folders whose scripts are trusted too (the Codex/Cursor clone, Claude Code's plugin copies). At most 8. */
export function extraRoots(env = process.env) {
  const roots = [];
  const add = (r) => {
    if (nonEmpty(r) && !roots.includes(r) && roots.length < 8) roots.push(r);
  };
  try {
    add(JSON.parse(readFileSync(path.join(shipyardHomeDir(env), 'install.json'), 'utf8'))?.root);
  } catch {
    // no install record
  }
  const home = env.SHIPYARD_AGENTS_HOME ? path.resolve(env.SHIPYARD_AGENTS_HOME) : os.homedir();
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  for (const dir of [path.join(home, '.claude', 'plugins', 'cache', 'shipyard', 'shipyard'), path.join(codexHome, 'plugins', 'cache', 'shipyard', 'shipyard')]) {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) add(path.join(dir, e.name));
    } catch {
      // not there
    }
  }
  return roots;
}

// ---------- messages ----------

/** The deny reason, worded for the agent that will show it. */
export function agentReason(reason, entry) {
  const r = String(reason ?? REASON);
  return entry === 'claude-hook' ? r : r.replace(GREP_TIP, ' For a recursive search add ');
}

/** The code a guard-check deny carries: proof that this hook, not the agent, refused the canary file. */
export function guardCode(nonce, kind) {
  return createHash('sha256').update(`${nonce}:${kind}`).digest('hex').slice(0, 8);
}

/** Adds " Guard check code (shell|read): XXXXXXXX." when a call names the guard-check file. */
export function guardCheckCode(calls, reason) {
  for (const c of calls) {
    let text;
    try {
      text = JSON.stringify(c?.tool_input ?? '');
    } catch {
      continue;
    }
    const m = CANARY.exec(text);
    if (!m) continue;
    const kind = c.tool_name === 'Bash' ? 'shell' : 'read';
    return `${reason} Guard check code (${kind}): ${guardCode(m[1], kind)}.`;
  }
  return reason;
}

export function looksLikeCursor(input) {
  return isObj(input) && ('cursor_version' in input || 'workspace_roots' in input);
}

/**
 * Decide on one planned tool call from any agent. Returns { deny, reason }.
 * `entry` is 'claude-hook' (guard-secrets.mjs given another agent's payload), 'codex' or 'cursor'.
 */
export function decide(input, env = process.env, entry = 'claude-hook') {
  try {
    const { calls, deny } = normalizeInput(input, env);
    if (deny) return { deny: true, reason: agentReason(deny, entry) };
    for (const c of calls) {
      let r = evaluate(c, env);
      if (r.deny && c.tool_name === 'Bash') {
        for (const root of extraRoots(env)) {
          if (!evaluate(c, { ...env, CLAUDE_PLUGIN_ROOT: root }).deny) {
            r = { deny: false };
            break;
          }
        }
      }
      if (r.deny) return { deny: true, reason: guardCheckCode([c, ...calls], agentReason(r.reason, entry)) };
    }
  } catch {
    // Fail open on the guard's own errors.
  }
  return { deny: false };
}

// ---------- debug shape log (live checks only) ----------

const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const nameOnly = (x) => (typeof x === 'string' && NAME_LIKE.test(x) ? x : x === undefined || x === null ? null : '<other>');
const keysOnly = (o) => (isObj(o) ? Object.keys(o).slice(0, 50).map(nameOnly) : []);

/**
 * While ~/.shipyard/guard-debug exists, append the SHAPE of a payload (names of fields, never values)
 * to <temp folder>/shipyard-guard-shapes.log. Returns true when a line was written.
 */
export function logShape(input, env = process.env, entry = '', logDir = os.tmpdir()) {
  try {
    if (!existsSync(path.join(shipyardHomeDir(env), 'guard-debug'))) return false;
    const ti = isObj(input) ? input.tool_input : undefined;
    const cmd = isObj(ti) ? (ti.command ?? ti.cmd ?? ti.commands) : isObj(input) ? input.command : undefined;
    let commandType = 'none';
    if (Array.isArray(cmd)) commandType = 'array';
    else if (typeof cmd === 'string') commandType = unwrapCommand(cmd) !== cmd ? 'wrapped' : 'string';
    else if (cmd !== undefined) commandType = typeof cmd;
    const line = {
      t: new Date().toISOString(),
      entry: nameOnly(entry),
      event: nameOnly(isObj(input) ? input.hook_event_name : undefined),
      tool_name: nameOnly(isObj(input) ? input.tool_name : undefined),
      keys: keysOnly(input),
      tool_input_keys: typeof ti === 'string' ? ['<string>'] : keysOnly(ti),
      command_type: commandType,
    };
    appendFileSync(path.join(logDir, 'shipyard-guard-shapes.log'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
