#!/usr/bin/env node
// Shipyard secrets guard. A Claude Code "PreToolUse" hook: Claude Code runs this
// before every file or shell tool, and every MCP tool (mcp__*), and sends the planned
// tool call as JSON on stdin.
//
// Contract (https://code.claude.com/docs/en/hooks):
//   stdin   {"tool_name": "...", "tool_input": {...}, ...}
//   deny    print {"hookSpecificOutput": {"hookEventName": "PreToolUse",
//           "permissionDecision": "deny", "permissionDecisionReason": "..."}} and exit 0
//   allow   print nothing and exit 0 (normal permission flow continues)
//
// Codex and Cursor run their own entry files (guard-codex.mjs, guard-cursor.mjs). A payload that is not
// in Claude Code's shape is read by scripts/agents/guard-input.mjs, loaded only for such payloads.
//
// It is a safety net, not a vault: it stops the common ways a key could end up
// in the chat (reading the keys file, printing the environment). It fails OPEN:
// if anything inside it breaks, the tool call is allowed. Built-ins only, no network.
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REASON =
  'Shipyard keeps your keys out of the chat. Use the Shipyard scripts instead (they never show the values).';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

const norm = (p) => String(p).replace(/\\/g, '/');
const baseName = (p) => {
  const s = norm(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
};
const BACKUPS_REASON =
  'Backups hold your users\' personal data, so Shipyard keeps them out of the chat. You can list the folders and delete old ones. To restore, a script on your computer reads them without printing them.';
const isExampleName = (s) => /\.(example|sample|template)$/i.test(s.replace(/[^A-Za-z0-9]+$/, ''));

/** secrets.env (and backups of it), .env, .env.local, .env.production ... but not .env.example. */
export function isSensitiveName(name) {
  const n = String(name).toLowerCase();
  if (n.startsWith('secrets.env')) return true;
  if (n === '.env') return true;
  if (n.startsWith('.env.')) return !isExampleName(n);
  return false;
}

// ".env" or ".env.something" as a whole name inside free text (a command or a glob).
// "process.env.X", ".envrc" and "foo.env" do not match.
const ENV_NAME = /(?<![A-Za-z0-9_-])\.env(?:\.[A-Za-z0-9_.*?[\]{},-]*)?(?![A-Za-z0-9_-])/g;

/** Does this text name a keys file? */
export function mentionsSecretFile(text) {
  const t = norm(text);
  if (/secrets\.env/i.test(t)) return true;
  for (const m of t.matchAll(ENV_NAME)) if (!isExampleName(m[0])) return true;
  return false;
}

/** Glob patterns (Glob tool, Grep `glob`) that could match a keys file. */
function globTargetsSecret(pattern) {
  return mentionsSecretFile(pattern) || /secrets[^/]*[*?[{]/i.test(norm(pattern));
}

// ---------- where Shipyard keeps its files ----------

function shipyardHome(env) {
  if (env.SHIPYARD_HOME) return norm(path.resolve(env.SHIPYARD_HOME));
  return norm(path.join(os.homedir(), '.shipyard'));
}

function expandHome(p) {
  const s = norm(p);
  if (s === '~') return norm(os.homedir());
  if (s.startsWith('~/')) return norm(os.homedir()) + s.slice(1);
  return s;
}

const sameOrInside = (p, dir) => {
  const a = expandHome(p).replace(/\/+$/, '');
  return a === dir || a.startsWith(`${dir}/`);
};

// ---------- backups (users' personal data) ----------

const BACKUPS_NAME = /(^|\/)\.shipyard\/+backups(\/|$)/;

/** Is this path (or a `--flag=path` word) the backups folder or something inside it? */
function inBackups(text, env) {
  const home = shipyardHome(env);
  const backups = `${home}/backups`;
  const check = (x) => {
    const p = path.posix.normalize(expandHome(norm(x).replace(/^file:\/\//i, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~'))).replace(/\/+$/, '');
    return sameOrInside(p, backups) || BACKUPS_NAME.test(p) || BACKUPS_NAME.test(norm(x));
  };
  const t = String(text);
  if (!t.includes('backups')) return false;
  if (check(t)) return true;
  const eq = t.indexOf('=');
  return eq > 0 && check(t.slice(eq + 1));
}

// Programs that only look at names, sizes or delete. Everything else pointed at the backups folder is refused.
const BACKUP_OK = new Set(['ls', 'cd', 'stat', 'test', '[', '[[', 'pwd', 'du', 'dir', 'rm', 'rmdir', 'chmod']);

/** `node script.mjs ...`: runs a file, so it is not one of the ways to print a file (-e, -p, a piped script). */
function isNodeScriptRun({ name, args }, env) {
  if (name !== 'node') return false;
  const script = args[0];
  if (!script || script.startsWith('-') || script.includes('\0')) return false;
  return !inBackups(script, env);
}

function pluginRoots(env) {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const roots = new Set([norm(here)]);
  if (env.CLAUDE_PLUGIN_ROOT) roots.add(norm(path.resolve(env.CLAUDE_PLUGIN_ROOT)));
  return [...roots].map((r) => r.replace(/\/+$/, ''));
}

// ---------- reading a shell command ----------

/**
 * Split a shell command into simple commands. Not a full shell parser, just
 * enough to see which program runs and what it is given. Each segment:
 *   { words: [unquoted words], unsafe: true if it has a redirect or $( ) / backticks }
 * `$(...)` and backticks start a new segment for what runs inside them.
 */
export function splitCommand(cmd) {
  const segments = [];
  let words = [];
  let word = '';
  let hasWord = false;
  let unsafe = false;

  const endWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0 || unsafe) segments.push({ words, unsafe });
    words = [];
    unsafe = false;
  };

  const s = String(cmd);
  let quote = null; // ' or "
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      word += s[++i];
      hasWord = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || (c === '$' && s[i + 1] === '(')) {
        unsafe = true;
        endSegment();
        if (c === '$') i++;
        unsafe = false;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
    } else if (c === '`' || (c === '$' && s[i + 1] === '(')) {
      unsafe = true;
      endSegment();
      if (c === '$') i++;
    } else if (c === '<' || c === '>') {
      unsafe = true;
      endWord();
      words.push(c);
    } else if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) {
      word += c; // part of a redirect like 2>&1 or &>file
      hasWord = true;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r' || c === '(' || c === ')') {
      endSegment();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      hasWord = true;
    }
  }
  endSegment();
  return segments;
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '}']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program a segment runs, plus its arguments. Skips VAR=x prefixes and wrappers like sudo. */
function programOf(words) {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  if (i >= words.length) return { name: '', args: [] };
  const name = baseName(words[i]).toLowerCase().replace(/\.(exe|cmd)$/, '');
  return { name, args: words.slice(i + 1) };
}

/** A lone node/npm/npx command that Shipyard trusts to handle keys itself. */
function isTrustedInvocation(segments, env) {
  if (segments.length !== 1 || segments[0].unsafe) return false;
  const { words } = segments[0];
  const first = words[0] ?? '';
  const prog = baseName(first).toLowerCase().replace(/\.(exe|cmd)$/, '');
  if (prog === 'node') {
    const script = words[1];
    if (!script || script.startsWith('-') || script.includes('\0')) return false;
    const target = expandHome(script);
    if (target.split('/').includes('..')) return false;
    const lower = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x;
    return pluginRoots(env).some((root) => lower(target).startsWith(`${lower(root)}/scripts/`) && target.endsWith('.mjs'));
  }
  if (prog === 'npm') {
    if (words[1] !== 'run' && words[1] !== 'run-script') return false;
    // `npm run env` is npm's built-in way to print the whole environment.
    const script = words.slice(2).find((w) => !w.startsWith('-'));
    return script !== 'env';
  }
  if (prog === 'npx') {
    const rest = words.slice(1).filter((w) => w !== '--yes' && w !== '-y' && w !== '--no-install');
    return rest[0] === 'next' || (rest[0] ?? '').startsWith('next@');
  }
  return false;
}

// Programs that only look at a keys file's name or delete it, never its contents.
function onlyTouchesName({ name, args }) {
  if (['ls', 'stat', 'test', '[', '[[', 'rm', 'chmod', 'dir'].includes(name)) return true;
  return name === 'git' && ['check-ignore', 'ls-files', 'rm'].includes(args.find((a) => !a.startsWith('-')));
}

// Programs allowed to be pointed at the whole ~/.shipyard folder or a glob inside it.
const DIR_OK = new Set(['ls', 'cd', 'stat', 'mkdir', 'test', '[', '[[', 'chmod', 'pwd', 'du', 'dir', 'rm']);

function printsEnvironment({ name, args }, segmentWords) {
  if (name === 'printenv') return true;
  if (name === 'env') {
    // `env` alone prints everything; `env FOO=1 some-command` just runs a command.
    return args.filter((a) => !a.startsWith('-') && !ASSIGNMENT.test(a)).length === 0;
  }
  if (name === 'set') return args.length === 0;
  if (name === 'export') return args.length === 0 || args.every((a) => a === '-p');
  if (name === 'declare' || name === 'typeset') return args.every((a) => /^-[pxg]+$/.test(a));
  // `npm run env` is npm's built-in way to print the whole environment.
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && (args[0] === 'run' || args[0] === 'run-script')) {
    if (args.slice(1).find((a) => !a.startsWith('-')) === 'env') return true;
  }
  // Tokens printed straight to the screen.
  if (name === 'gh') {
    const plain = args.filter((a) => !a.startsWith('-'));
    if (plain[0] === 'auth' && plain[1] === 'token') return true;
    if (plain[0] === 'auth' && plain[1] === 'status' && args.some((a) => a === '--show-token' || /^-[A-Za-z]*t[A-Za-z]*$/.test(a))) return true;
  }
  // `vercel env pull -` (and friends) writes every variable to the screen;
  // `vercel env pull` with no file name drops them into .env.local, which the chat would then read.
  const i = segmentWords.findIndex((w, k) => w === 'env' && segmentWords[k + 1] === 'pull');
  if (i !== -1) {
    const rest = segmentWords.slice(i + 2);
    if (rest.some((a) => a === '-' || a === '--stdout' || /^\/dev\/(stdout|fd\/1)$/.test(a) || /^\/proc\/self\/fd\/1$/.test(a))) return true;
    if (segmentWords.some((w) => /^vercel(@|$)/i.test(baseName(w)))) {
      const VALUE_FLAGS = new Set(['--environment', '--git-branch', '--scope', '-S', '--token', '-t', '--cwd', '--local-config', '-A', '--global-config', '-Q']);
      let fileGiven = false;
      for (let k = 0; k < rest.length; k++) {
        if (VALUE_FLAGS.has(rest[k])) k++;
        else if (!rest[k].startsWith('-')) fileGiven = true;
      }
      if (!fileGiven) return true;
    }
  }
  return false;
}

// ---------- wildcards that could expand to a keys file ----------

const SECRET_FILE_NAMES = ['.env', '.env.local', '.env.production', 'secrets.env'];

function expandBraces(word, budget = { n: 64 }) {
  const m = /\{([^{}]*)\}/.exec(word);
  if (!m || budget.n <= 0) return [word];
  const parts = m[1].includes(',') ? m[1].split(',') : [m[1]];
  const out = [];
  for (const alt of parts) {
    budget.n--;
    out.push(...expandBraces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length), budget));
  }
  return out;
}

/** Shell wildcard (* ? [..]) to a regular expression for one file name. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls[0] === '!') cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Could this shell word (a wildcard) expand to a keys file name? `bareStarCounts`: also treat `*` as matching secrets.env. */
export function globMatchesSecret(word, bareStarCounts = false) {
  const w = norm(word).replace(/\$\{[^}]*\}/g, 'X');
  if (!/[*?[{]/.test(w)) return false;
  const base = w.slice(w.lastIndexOf('/') + 1);
  for (const g of expandBraces(base)) {
    let re;
    try {
      re = globToRegex(g);
    } catch {
      continue;
    }
    for (const name of SECRET_FILE_NAMES) {
      // A shell wildcard never matches a leading dot unless the pattern spells it out.
      if (name.startsWith('.') && !g.startsWith('.')) continue;
      if (name === 'secrets.env' && /^\*+$/.test(g) && !bareStarCounts) continue;
      if (re.test(name)) return true;
    }
  }
  return false;
}

// ---------- recursive searches (they ignore .gitignore and walk into .env files) ----------

const GREP_NAMES = new Set(['grep', 'egrep', 'fgrep', 'ggrep', 'zgrep']);

/** Does a glob (from --exclude or -g '!...') hide the usual keys files? */
function hidesEnvFiles(value) {
  const v = String(value ?? '').replace(/^!/, '');
  try {
    const re = globToRegex(v.slice(v.lastIndexOf('/') + 1));
    return ['.env', '.env.local'].every((n) => re.test(n));
  } catch {
    return false;
  }
}

function optionValues(args, longNames, shortNames) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const long = longNames.find((n) => a === n || a.startsWith(`${n}=`));
    if (long) out.push(a.startsWith(`${long}=`) ? a.slice(long.length + 1) : args[++k]);
    else if (shortNames.includes(a)) out.push(args[++k]);
    else if (a.length > 2 && !a.startsWith('--') && shortNames.includes(a.slice(0, 2))) out.push(a.slice(2));
  }
  return out;
}

function clusterHas(args, chars, stopAt) {
  return args.some((a) => {
    if (!/^-[^-]/.test(a)) return false;
    for (const c of a.slice(1)) {
      if (chars.includes(c)) return true;
      if (stopAt.includes(c)) return false;
    }
    return false;
  });
}

/** Returns true when this search command would walk into keys files without excluding them. */
function searchesKeysFiles({ name, args }, segmentWords) {
  if (GREP_NAMES.has(name)) {
    const recursive =
      args.some((a) => a === '--recursive' || a === '--dereference-recursive' || a === '--directories=recurse') ||
      clusterHas(args, 'rR', 'efmABCdD') ||
      optionValues(args, ['--directories'], ['-d']).includes('recurse');
    if (!recursive) return false;
    return !optionValues(args, ['--exclude'], []).some(hidesEnvFiles);
  }
  if (name === 'rg') {
    const wide =
      args.some((a) => a === '--hidden' || a === '--unrestricted' || a === '-.' || /^--no-ignore/.test(a)) ||
      clusterHas(args, 'u.', 'egfmABCjtTMErd');
    if (!wide) return false;
    return !optionValues(args, ['--glob', '--iglob'], ['-g']).some((g) => g.startsWith('!') && hidesEnvFiles(g));
  }
  if (name === 'ag') {
    const wide = args.some((a) => a === '--unrestricted' || a === '--hidden') || clusterHas(args, 'u', 'ABCGgmpQ');
    if (!wide) return false;
    return !optionValues(args, ['--ignore'], []).some(hidesEnvFiles);
  }
  if (name === 'git' && args.find((a) => !a.startsWith('-')) === 'grep') {
    return args.includes('--no-exclude-standard');
  }
  return false;
}

/**
 * `--exclude='.env*'` and `-g '!.env*'` name the keys files in order to hide them from a search.
 * Drop those words before looking for keys-file names.
 */
function withoutExclusions(words) {
  const name = programOf(words).name;
  if (!GREP_NAMES.has(name) && name !== 'rg' && name !== 'ag') return { words, dropped: false };
  let dropped = false;
  const kept = words.filter((w, k, all) => {
    const drop = /^--(exclude|glob|iglob|ignore)=/.test(w) || /^-g!/.test(w) || ['--exclude', '--glob', '--iglob', '--ignore', '-g'].includes(all[k - 1]);
    if (drop && mentionsSecretFile(w)) dropped = true;
    return !drop;
  });
  return { words: kept, dropped };
}

const TIP = ' For a recursive search use the Grep tool, or add --exclude=\'.env*\' (rg: -g \'!.env*\').';

/** Resolve a path the way `cd` would, without touching the disk. Returns null if it cannot be known. */
function resolveDir(target, from) {
  let t = norm(target).replace(/\$\{?HOME\}?/g, '~');
  if (/[$`*?[{]/.test(t)) return null;
  t = expandHome(t);
  const absolute = t.startsWith('/') || /^[A-Za-z]:\//.test(t);
  if (!absolute && !from) return null;
  return path.posix.normalize(absolute ? t : `${from}/${t}`).replace(/\/+$/, '');
}

/**
 * Returns false (fine), true (deny), or a string (deny, with a more specific reason).
 * `cwd` is the folder the shell is in when the command starts (Claude Code sends it).
 */
function bashDenies(command, env, cwd) {
  const raw = String(command);
  if (/\/proc\/[^\s'"]*\/environ/.test(raw)) return true;

  const segments = splitCommand(raw);
  // One plain `node <plugin script>` / `npm run` / `npx next` is trusted: those handle keys
  // themselves and print no values. Anything chained or redirected is not.
  if (isTrustedInvocation(segments, env)) return false;
  const home = shipyardHome(env);
  const insideHome = (d) => d !== null && (d === home || d.startsWith(`${home}/`) || /(^|\/)\.shipyard(\/|$)/.test(d));

  // The Bash tool keeps its folder between calls, and `cd` changes it inside one command.
  // While the shell is in ~/.shipyard, only folder-level commands are fine: `cat *` would show secrets.env.
  let here = cwd ? resolveDir(cwd, null) : null;

  for (const seg of segments) {
    const prog = programOf(seg.words);
    if (printsEnvironment(prog, seg.words)) return true;

    if (prog.name === 'cd' || prog.name === 'pushd') {
      const target = prog.args.find((a) => !a.startsWith('-') || a === '-');
      const next = target === undefined ? null : resolveDir(target, here);
      here = target === '-' ? here : next;
      continue;
    }

    if (insideHome(here) && !DIR_OK.has(prog.name)) return true;

    // Backups hold users' personal data: no program that could print or copy them may be pointed at that folder.
    if (!BACKUP_OK.has(prog.name) && !isNodeScriptRun(prog, env) && seg.words.some((w) => inBackups(w, env))) return BACKUPS_REASON;

    // The whole keys folder, or a wildcard inside it, would show secrets.env.
    const pointsAtFolder = seg.words.some((w) => {
      const x = expandHome(w).replace(/\/+$/, '');
      if (x === home || /(^|\/)\.shipyard$/.test(x)) return true;
      const inside = x.startsWith(`${home}/`) ? x.slice(home.length + 1) : /(^|\/)\.shipyard\/(.*)$/.exec(x)?.[2];
      return inside !== undefined && /[*?[{]/.test(inside);
    });
    if (pointsAtFolder && !DIR_OK.has(prog.name)) return true;

    // A wildcard can spell a keys file without naming it: `cat .e*`, `cat .en[v].local`, `cat s*`.
    if (!DIR_OK.has(prog.name) && !onlyTouchesName(prog)) {
      const inShipyard = insideHome(here);
      const hit = withoutExclusions(seg.words).words.some((w) => !/^(\[|\[\[|\]|\]\]|\{|\})$/.test(w) && globMatchesSecret(w, inShipyard || insideHome(resolveDir(w.slice(0, w.lastIndexOf('/') + 1) || '.', here))));
      if (hit) return true;
    }

    // Recursive searches ignore .gitignore and walk straight into .env files.
    if (searchesKeysFiles(prog, seg.words)) return REASON + TIP;
  }

  let strippedExclusion = false;
  const cleaned = segments.map((s) => {
    const { words, dropped } = withoutExclusions(s.words);
    if (dropped) strippedExclusion = true;
    return { ...s, words };
  });

  const mentioned = (mentionsSecretFile(raw) && !strippedExclusion) || cleaned.some((s) => s.words.some(mentionsSecretFile));
  if (!mentioned) return false;

  const mentioning = cleaned.filter((s) => s.words.some(mentionsSecretFile));
  if (mentioning.length === 0) return true; // the name is hidden somewhere we can't see: be careful
  return !mentioning.every((s) => !s.unsafe && onlyTouchesName(programOf(s.words)));
}

// ---------- MCP tools ----------

// MCP tools (Desktop Commander and other file or shell servers) take paths and commands in
// arguments with any name, nested any way. So every text value is looked at, except values that
// hold a file's contents or plain prose: a README that says "copy .env.example to .env.local"
// is not an attempt to read that file (the built-in Write tool is not checked on its content either).
const MCP_SKIP_KEYS = /^(content|contents|text|body|data|html|markdown|new_?str(ing)?|old_?str(ing)?|new_source|message|description|title|summary|prompt|comment|note)$/i;
// Arguments that hold a command line (or a list of its words).
const MCP_COMMAND_KEYS = /^(command|cmd|commands|script|shell|exec|args|argv|arguments|input|code)$/i;
const MCP_MAX_STRINGS = 10_000;
const MCP_MAX_DEPTH = 32;

/** Every [argument name, text] pair inside a tool_input, at any depth. Arrays keep their parent's name. */
function* mcpStrings(node, key = '', depth = 0, budget = { n: MCP_MAX_STRINGS }) {
  if (budget.n-- <= 0 || depth > MCP_MAX_DEPTH) return;
  if (typeof node === 'string') {
    yield [key, node];
  } else if (Array.isArray(node)) {
    if (MCP_COMMAND_KEYS.test(key) && node.length > 1 && node.every((x) => typeof x === 'string')) yield [key, node.join(' ')];
    for (const x of node) yield* mcpStrings(x, key, depth + 1, budget);
  } else if (node && typeof node === 'object') {
    for (const [k, x] of Object.entries(node)) {
      yield ['', k]; // a name can be a path too: {"/work/.env": ...}
      if (MCP_SKIP_KEYS.test(k) && typeof x === 'string') continue;
      yield* mcpStrings(x, k, depth + 1, budget);
    }
  }
}

/** Does this one argument value name a keys file, point into ~/.shipyard, or run a command that would show keys? */
function mcpValueDenies(key, value, env, cwd, home) {
  const v = value.slice(0, 20_000);
  const p = norm(v).replace(/^file:\/\//i, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
  if (isSensitiveName(baseName(p)) || sameOrInside(p, home) || /(^|\/)\.shipyard(\/|$)/.test(expandHome(p))) return true;
  // A command line, a wildcard, or anything with spaces or shell characters gets the same reading as the Bash tool.
  if (MCP_COMMAND_KEYS.test(key) || /[\s;&|<>$`*?[{(]/.test(v)) return bashDenies(v, env, cwd) !== false;
  return mentionsSecretFile(p);
}

function mcpDenies(toolInput, env, cwd, home) {
  try {
    for (const [key, value] of mcpStrings(toolInput)) {
      try {
        if (mcpValueDenies(key, value, env, cwd, home)) return true;
      } catch {
        // One odd value must not switch the check off for the others, and must not block the call.
      }
    }
  } catch {
    // Fail open on the guard's own errors.
  }
  return false;
}

// ---------- the decision ----------

/**
 * Decide on one planned tool call. Returns { deny: true, reason } or { deny: false }.
 * `env` is injectable for tests (CLAUDE_PLUGIN_ROOT, SHIPYARD_HOME).
 */
export function evaluate(input, env = process.env) {
  const allow = { deny: false };
  const tool = input?.tool_name;
  const ti = input?.tool_input;
  if (typeof tool !== 'string' || !ti || typeof ti !== 'object') return allow;
  const deny = { deny: true, reason: REASON };
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  const home = shipyardHome(env);
  const cwdInHome = cwd !== null && sameOrInside(cwd, home);

  const backupsDeny = { deny: true, reason: BACKUPS_REASON };
  const backupPath = (p) => inBackups(cwd && !/^([/~$]|[A-Za-z]:[\\/])/.test(p) ? `${norm(cwd)}/${p}` : p, env);

  if (FILE_TOOLS.has(tool)) {
    for (const key of ['file_path', 'notebook_path', 'path']) {
      if (typeof ti[key] === 'string' && isSensitiveName(baseName(ti[key]))) return deny;
      if (typeof ti[key] === 'string' && backupPath(ti[key])) return backupsDeny;
    }
    return allow;
  }

  if (SEARCH_TOOLS.has(tool)) {
    // No path means "search the current folder". If that is ~/.shipyard, it searches the keys file.
    if (cwdInHome && (typeof ti.path !== 'string' || ti.path === '')) return deny;
    // The backups folder is off limits to searches too (even a listing by pattern: use ls for names).
    if (typeof ti.path === 'string' && backupPath(ti.path)) return backupsDeny;
    for (const key of ['pattern', 'glob']) {
      if (typeof ti[key] === 'string' && inBackups(ti[key], env) && (tool === 'Glob' || key === 'glob')) return backupsDeny;
    }
    if (typeof ti.path === 'string') {
      if (isSensitiveName(baseName(ti.path))) return deny;
      const full = cwd && !/^([/~]|[A-Za-z]:[\\/])/.test(ti.path) ? `${norm(cwd)}/${ti.path}` : ti.path;
      if (tool === 'Grep' && (sameOrInside(ti.path, home) || sameOrInside(path.posix.normalize(norm(full)), home))) return deny;
      if (cwdInHome && tool === 'Glob' && !/^([/~]|[A-Za-z]:[\\/])/.test(ti.path) && sameOrInside(path.posix.normalize(norm(full)), home)) return deny;
    }
    if (tool === 'Glob' && typeof ti.pattern === 'string' && globTargetsSecret(ti.pattern)) return deny;
    if (tool === 'Grep' && typeof ti.glob === 'string' && globTargetsSecret(ti.glob)) return deny;
    return allow;
  }

  if (tool.startsWith('mcp__')) return mcpDenies(ti, env, cwd, home) ? deny : allow;

  if (tool === 'Bash') {
    if (typeof ti.command === 'string') {
      const verdict = bashDenies(ti.command, env, cwd);
      if (typeof verdict === 'string') return { deny: true, reason: verdict };
      if (verdict) return deny;
    }
    return allow;
  }
  return allow;
}

export function denyOutput(reason = REASON) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// ---------- command line entry ----------

async function readStdin(limitMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(data);
    }, limitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      data += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Claude Code's own tool names. A call in Claude Code's shape goes straight to evaluate(), as it always has:
// the Codex and Cursor adapter is never loaded for it.
const CLAUDE_TOOLS = new Set([...FILE_TOOLS, ...SEARCH_TOOLS, 'Bash']);

/** Is this payload in Claude Code's own shape (a known tool name, an object tool_input, a session folder)? */
export function isClaudeShaped(i) {
  const t = i?.tool_name;
  const ti = i?.tool_input;
  return (
    typeof t === 'string' &&
    (CLAUDE_TOOLS.has(t) || t.startsWith('mcp__')) &&
    !!ti &&
    typeof ti === 'object' &&
    !Array.isArray(ti) &&
    !Array.isArray(ti.command) &&
    !('workdir' in ti) &&
    typeof i.cwd === 'string' &&
    i.cwd !== '' &&
    !('cursor_version' in i)
  );
}

const out = (text) => process.stdout.write(`${text}\n`);

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Shipyard secrets guard (a Claude Code hook, not run by hand).\n' +
        'Reads a planned tool call as JSON on stdin. Prints a deny decision if it would expose your keys,\n' +
        'otherwise prints nothing. Exit code is 0 (when Cursor runs it, a deny also exits 2).\n',
    );
    return;
  }
  try {
    const text = await readStdin();
    const input = JSON.parse(text);
    if (isClaudeShaped(input)) {
      const result = evaluate(input);
      if (result.deny) out(denyOutput(result.reason));
      return;
    }
    // Not Claude Code's shape (for example Cursor running this hook from an imported Claude plugin).
    // The adapter reads other agents' tool calls. If it cannot load, the old check still runs.
    let adapter = null;
    try {
      adapter = await import('./agents/guard-input.mjs');
    } catch {
      adapter = null;
    }
    try {
      adapter?.logShape(input, process.env, 'claude-hook');
    } catch {
      // The debug log never matters for the decision.
    }
    const result = adapter ? adapter.decide(input, process.env, 'claude-hook') : evaluate(input);
    if (result.deny) {
      out(denyOutput(result.reason));
      if (adapter?.looksLikeCursor(input)) {
        process.stderr.write(`${result.reason}\n`);
        process.exitCode = 2;
      }
    }
  } catch {
    // Fail open: a bug in the guard must never block the session.
  }
}

// Compare real paths: Node gives import.meta.url with symlinks resolved, argv[1] as typed.
// Through a symlinked plugin folder the two differ, and a guard that silently does
// nothing is worse than none. So if the check cannot say yes, still run when the
// file we were started as is named guard-secrets.mjs (fail safe, not fail silent).
function startedAsGuard() {
  if (!process.argv[1]) return false;
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch {
    // fall through to the name check
  }
  return baseName(process.argv[1]) === 'guard-secrets.mjs';
}

if (startedAsGuard()) {
  main().catch(() => {});
}
