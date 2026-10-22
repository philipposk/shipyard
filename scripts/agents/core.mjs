// The logic behind install-agents.mjs, kept free of prompts and printing so it can be tested:
// the Codex and Cursor copy of the skills ("the pack"), the hook entries in each agent's hooks file,
// the optional Codex rules file, and the install record in ~/.shipyard/install.json. Built-ins only.
import os from 'node:os';
import path from 'node:path';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { REWRITES } from './rewrites.mjs';

export const SKILLS = ['setup', 'new-app', 'design', 'launch', 'video', 'ops'];
export const PACK_PREFIX = 'shipyard-';
export const MARKER = '.shipyard-generated.json';
export const RULES_MARKER = '# shipyard';
export const CODEX_SCRIPT = 'guard-codex.mjs';
export const CURSOR_SCRIPT = 'guard-cursor.mjs';
export const CURSOR_EVENTS = ['beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution', 'preToolUse'];
export const CURSOR_TOOL_MATCHER = 'Read|ReadFile|Grep|Write|Edit';
export const HOOK_TIMEOUT = 10;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
export const fwd = (p) => String(p).replace(/\\/g, '/');

/** A problem the student can fix, worded for them. */
export class PlainError extends Error {}

// ---------- where things live ----------

/** Every folder the installer reads or writes. `env` overrides are for tests. */
export function locations(env = process.env) {
  const home = env.SHIPYARD_AGENTS_HOME ? path.resolve(env.SHIPYARD_AGENTS_HOME) : os.homedir();
  const shipyardHome = env.SHIPYARD_HOME ? path.resolve(env.SHIPYARD_HOME) : path.join(os.homedir(), '.shipyard');
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const cursorHome = path.join(home, '.cursor');
  return {
    home,
    claudeHome: path.join(home, '.claude'),
    shipyardHome,
    installFile: path.join(shipyardHome, 'install.json'),
    codexHome,
    codexHooks: path.join(codexHome, 'hooks.json'),
    codexRules: path.join(codexHome, 'rules', 'shipyard.rules'),
    cursorHome,
    cursorHooks: path.join(cursorHome, 'hooks.json'),
    skillsDir: path.join(home, '.agents', 'skills'),
  };
}

// ---------- the Shipyard folder ----------

const UNSAFE_CHARS = /["`$%\r\n]/;

/** Why this folder cannot hold Shipyard for Codex and Cursor, or null if it can. */
export function checkRoot(root, { shipyardHome, platform = process.platform } = {}) {
  const r = fwd(root);
  if (UNSAFE_CHARS.test(r)) {
    return `Shipyard is in a folder whose path has a character the hooks cannot use safely (" \` $ % or a line break): ${r}. Move the Shipyard folder somewhere without these and run this again.`;
  }
  if (r.split('/').includes('.shipyard')) {
    return `Shipyard is inside a folder named .shipyard (${r}). That name is kept for your keys, so the guard would block Shipyard's own files. Clone Shipyard to ~/.local/share/shipyard instead.`;
  }
  if (shipyardHome) {
    const real = (p) => {
      try {
        return fwd(realpathSync(p));
      } catch {
        return fwd(path.resolve(p));
      }
    };
    const lower = platform === 'win32' ? (x) => x.toLowerCase() : (x) => x;
    const home = lower(real(shipyardHome).replace(/\/+$/, ''));
    const here = lower(real(root).replace(/\/+$/, ''));
    if (here === home || here.startsWith(`${home}/`)) {
      return `Shipyard is inside your keys folder (${fwd(shipyardHome)}). Clone it to ~/.local/share/shipyard instead.`;
    }
  }
  return null;
}

/** Why a path (node, skills folder) cannot go into a command or a skill file, or null. */
export function checkPathChars(p, what) {
  return UNSAFE_CHARS.test(fwd(p)) ? `The ${what} path has a character that cannot be used safely (" \` $ % or a line break): ${fwd(p)}.` : null;
}

// ---------- programs on PATH ----------

/** The first `name` on PATH, as written there (symlinks are not followed), or null. */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== 'win32') accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * fnm puts a per-shell link to node on PATH (.../fnm_multishells/<id>/bin/node) and deletes it at logout
 * or reboot. A hook pinned to it would stop running, so use the node it points to (fnm's own copy of that version).
 */
export function stableNode(p) {
  if (!/[\\/]fnm_multishells[\\/]/.test(String(p))) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The node the hooks run: the first on PATH (not resolved, so upgrades keep working), else this one. */
export function findNode(env = process.env, platform = process.platform) {
  const onPath = findOnPath('node', env, platform);
  return { node: fwd(stableNode(onPath ?? process.execPath)), onPath: onPath !== null };
}

// Files Shipyard itself puts in ~/.codex and ~/.cursor. A folder holding only these is not a sign the agent is there.
const OWN_FILE = /^hooks\.json(\.shipyard-backup|\.tmp-\d+)?$/;

/** Does the agent's own folder look used by the agent (anything Shipyard did not put there, or a folder made empty)? */
function folderInUse(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  if (names.length === 0) return true;
  return names.some((n) => {
    if (OWN_FILE.test(n)) return false;
    if (n !== 'rules') return true;
    try {
      return readdirSync(path.join(dir, n)).some((r) => r !== 'shipyard.rules' && !r.startsWith('shipyard.rules.tmp-'));
    } catch {
      return true;
    }
  });
}

/** Is this agent on this computer? Its program on PATH, or its folder in use. */
export function agentPresent(agent, { env = process.env, platform = process.platform, loc = locations(env) } = {}) {
  // loc.codexHome is $CODEX_HOME when it is set, else ~/.codex.
  if (agent === 'codex') return folderInUse(loc.codexHome) || !!findOnPath('codex', env, platform);
  if (agent === 'cursor') return folderInUse(loc.cursorHome) || !!findOnPath('cursor', env, platform) || !!findOnPath('agent', env, platform);
  return false;
}

/** Which agents look installed on this computer. */
export function detectAgents({ env = process.env, platform = process.platform, loc = locations(env) } = {}) {
  return ['codex', 'cursor'].filter((a) => agentPresent(a, { env, platform, loc }));
}

/**
 * Which agents load skills from this folder, or null for a folder Shipyard does not know.
 * ~/.agents/skills: Codex and Cursor. ~/.codex/skills: Codex (its older folder) and Cursor (for compatibility).
 * ~/.cursor/skills and ~/.claude/skills: Cursor only (Claude Code is not set up by this installer).
 */
export function skillReaders(dir, loc, platform = process.platform) {
  const key = (p) => {
    const f = fwd(path.resolve(p)).replace(/\/+$/, '');
    return platform === 'win32' ? f.toLowerCase() : f;
  };
  const d = key(dir);
  if (d === key(loc.skillsDir) || d === key(path.join(loc.codexHome, 'skills'))) return ['codex', 'cursor'];
  if (d === key(path.join(loc.cursorHome, 'skills')) || d === key(path.join(loc.claudeHome, 'skills'))) return ['cursor'];
  return null;
}

// ---------- the pack (the skills, rewritten for Codex and Cursor) ----------

const PLACEHOLDER = /\{\{(ROOT|SKILLS_DIR|VERSION|DATE)\}\}/g;

function fill(text, vars) {
  return text.replace(PLACEHOLDER, (m, k) => (vars[k] === undefined ? m : vars[k]));
}

function countMatches(text, find) {
  if (typeof find === 'string') return find === '' ? 0 : text.split(find).length - 1;
  const re = new RegExp(find.source, find.flags.includes('g') ? find.flags : `${find.flags}g`);
  return [...text.matchAll(re)].length;
}

/** Apply the anchored rows for one source file. Returns the text and the ids whose anchor is not there exactly once. */
export function applyRewrites(text, file, rows = REWRITES) {
  let out = text;
  const missing = [];
  for (const row of rows) {
    if (row.file !== file) continue;
    if (countMatches(out, row.find) !== 1) {
      missing.push(row.id);
      continue;
    }
    out = typeof row.find === 'string' ? out.replace(row.find, () => row.replace) : out.replace(row.find, () => row.replace);
  }
  return { text: out, missing };
}

const SKILL_REF = /`?\/shipyard:([a-z-]+)`?/g;

/** One skill file (no header) rewritten for Codex and Cursor. `file` is its path inside skills/. */
export function rewriteText(text, { file, root, skillsDir, version = '', date = '', rows = REWRITES }) {
  const { text: anchored, missing } = applyRewrites(text, file, rows);
  if (missing.length) throw new Error(`scripts/agents/rewrites.mjs is out of date for skills/${file}: ${missing.join(', ')} no longer match exactly once.`);
  const generic = anchored
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', '{{ROOT}}')
    .replaceAll('`/shipyard:setup settings`', '`Shipyard settings`')
    .replace(SKILL_REF, '`Shipyard $1`');
  return fill(generic, { ROOT: fwd(root), SKILLS_DIR: fwd(skillsDir), VERSION: version, DATE: date });
}

/** Split a SKILL.md into its frontmatter fields and its body. */
export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        // keep as written
      }
    } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    fields[kv[1]] = v;
  }
  return { fields, body: text.slice(m[0].length) };
}

/** A SKILL.md for Codex and Cursor: new name and description, the header, the rewritten body. */
export function rewriteSkillMd(text, { skill, header, ...opts }) {
  const { fields, body } = splitFrontmatter(text);
  const description = `Shipyard ${skill}: ${String(fields.description ?? '').replace(SKILL_REF, 'Shipyard $1')}`;
  const vars = { ROOT: fwd(opts.root), SKILLS_DIR: fwd(opts.skillsDir), VERSION: opts.version ?? '', DATE: opts.date ?? '' };
  const head = fill(header, vars).trimEnd();
  const rest = rewriteText(body, { ...opts, file: `${skill}/SKILL.md` }).replace(/^(\r?\n)+/, '');
  return `---\nname: ${PACK_PREFIX}${skill}\ndescription: ${JSON.stringify(description)}\n---\n\n${head}\n\n${rest}`;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.isFile()) out.push(fwd(path.relative(base, full)));
  }
  return out;
}

/**
 * The whole pack, in memory: [{ name: 'shipyard-setup', files: Map(relative path -> string | Buffer) }].
 * `generatedAt` (ISO time) goes in the marker; its date is the header's install date.
 */
export function planPack({ root, skillsDir, version, generatedAt = new Date().toISOString(), skillsSrc = path.join(root, 'skills'), header, rows = REWRITES }) {
  // Git for Windows checks text files out with CRLF line ends by default. The rewrites are written with \n.
  const lf = (t) => t.replace(/\r\n/g, '\n');
  const headerText = lf(header ?? readFileSync(path.join(root, 'scripts', 'agents', 'header.md'), 'utf8'));
  const date = generatedAt.slice(0, 10);
  const opts = { root: fwd(root), skillsDir: fwd(skillsDir), version, date, rows };
  return SKILLS.map((skill) => {
    const src = path.join(skillsSrc, skill);
    const files = new Map();
    for (const rel of walk(src)) {
      const full = path.join(src, rel);
      if (rel === 'SKILL.md') files.set(rel, rewriteSkillMd(lf(readFileSync(full, 'utf8')), { skill, header: headerText, ...opts }));
      else if (rel.endsWith('.md')) files.set(rel, rewriteText(lf(readFileSync(full, 'utf8')), { ...opts, file: `${skill}/${rel}` }));
      else files.set(rel, readFileSync(full));
    }
    files.set(MARKER, `${JSON.stringify({ root: fwd(root), version, generatedAt }, null, 2)}\n`);
    return { name: `${PACK_PREFIX}${skill}`, skill, files };
  });
}

export const LINT_RULES = [
  [/CLAUDE_PLUGIN_ROOT/, 'CLAUDE_PLUGIN_ROOT'],
  [/\/shipyard:/, 'the /shipyard: form'],
  [/~\/\.claude/, '~/.claude'],
  [/\bClaude\b(?! Code only)/, 'Claude (outside "Claude Code only")'],
  [/\bAnthropic\b/, 'Anthropic'],
  [/\b(Opus|Sonnet|Haiku)\b/, 'a Claude model name'],
  [/model: "/, 'model: "'],
  [/Read tool/, 'the Read tool'],
  [/\/plugin\b/, '/plugin'],
  [/\/usage/, '/usage'],
  [/\/code-review/, '/code-review'],
  [/\/install-github-app/, '/install-github-app'],
  [/claude-code-action/, 'claude-code-action'],
  [/CLAUDE_CODE_OAUTH_TOKEN/, 'CLAUDE_CODE_OAUTH_TOKEN'],
  [/claude plugin/, 'claude plugin'],
  [/--providers=claude/, '--providers=claude'],
  [/--ai claude/, '--ai claude'],
  [/—/, 'an em dash'],
  [/\{\{[A-Z_]+\}\}/, 'a leftover placeholder'],
];

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEADER_MARK = 'for Codex and Cursor, installed';

/**
 * Everything wrong with a pack, as [{ file, problem }]. Empty means it is fine.
 * `ignore`: texts to skip on each line, such as the Shipyard and skills folder paths filled in from this
 * computer (a home folder named Claude must not fail the check).
 */
export function lintPack(pack, { ignore = [] } = {}) {
  const problems = [];
  const skip = [...new Set(ignore.map((x) => fwd(x)).filter((x) => x.length > 1))].sort((a, b) => b.length - a.length);
  const clean = (line) => skip.reduce((l, x) => l.split(x).join('/'), line);
  for (const { name, files } of pack) {
    for (const [rel, data] of files) {
      if (typeof data !== 'string' || rel === MARKER) continue;
      const where = `${name}/${rel}`;
      data.split('\n').forEach((line, i) => {
        const checked = clean(line);
        for (const [re, label] of LINT_RULES) if (re.test(checked)) problems.push({ file: where, line: i + 1, problem: label, text: line.trim().slice(0, 160) });
      });
      const headers = data.split(HEADER_MARK).length - 1;
      if (rel === 'SKILL.md' ? headers !== 1 : headers !== 0) problems.push({ file: where, problem: `the header appears ${headers} times` });
    }
    const skill = files.get('SKILL.md');
    if (typeof skill !== 'string') {
      problems.push({ file: name, problem: 'no SKILL.md' });
      continue;
    }
    const { fields } = splitFrontmatter(skill);
    const keys = Object.keys(fields);
    if (keys.join(',') !== 'name,description') problems.push({ file: `${name}/SKILL.md`, problem: `frontmatter keys are ${keys.join(', ')}` });
    if (fields.name !== name || !NAME_RE.test(name) || name.length > 64) problems.push({ file: `${name}/SKILL.md`, problem: `bad name ${fields.name}` });
    const d = fields.description;
    if (typeof d !== 'string' || d.length < 1 || d.length > 1024) problems.push({ file: `${name}/SKILL.md`, problem: 'description must be 1 to 1024 characters' });
    if (!/^description: "/m.test(skill)) problems.push({ file: `${name}/SKILL.md`, problem: 'description is not a double-quoted string' });
  }
  return problems;
}

// ---------- writing the pack ----------

function readTree(dir) {
  const files = new Map();
  for (const rel of walk(dir)) files.set(rel, readFileSync(path.join(dir, rel)));
  return files;
}

const sameBytes = (a, b) => Buffer.compare(Buffer.isBuffer(a) ? a : Buffer.from(a), Buffer.isBuffer(b) ? b : Buffer.from(b)) === 0;

/** Is this folder on disk exactly this pack entry? */
export function folderMatches(dir, files) {
  let disk;
  try {
    disk = readTree(dir);
  } catch {
    return false;
  }
  if (disk.size !== files.size) return false;
  for (const [rel, data] of files) if (!disk.has(rel) || !sameBytes(disk.get(rel), data)) return false;
  return true;
}

/** The marker of a pack folder, or null when the folder is not one Shipyard made. */
export function readMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8'));
    return isObj(m) ? m : null;
  } catch {
    return null;
  }
}

/**
 * What installing this pack would do in `skillsDir`:
 *   folders  [{ name, dir, action: 'create' | 'update' | 'unchanged' }]
 *   stale    marked shipyard-* folders that are no longer part of Shipyard (removed)
 *   conflicts  shipyard-<skill> folders Shipyard did not make (never overwritten)
 */
export function packPlan(skillsDir, pack) {
  const folders = [];
  const conflicts = [];
  for (const { name, files } of pack) {
    const dir = path.join(skillsDir, name);
    if (!existsSync(dir)) folders.push({ name, dir, files, action: 'create' });
    else if (!readMarker(dir)) conflicts.push(dir);
    else folders.push({ name, dir, files, action: folderMatches(dir, files) ? 'unchanged' : 'update' });
  }
  const names = new Set(pack.map((p) => p.name));
  const stale = [];
  try {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(PACK_PREFIX) && !names.has(e.name) && readMarker(path.join(skillsDir, e.name))) stale.push(path.join(skillsDir, e.name));
    }
  } catch {
    // no skills folder yet
  }
  return { folders, stale, conflicts };
}

/** Write one pack folder: into a sibling temp folder first, then swap it into place. */
export function writePackFolder(dir, files) {
  const parent = path.dirname(dir);
  mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(dir)}.tmp-${process.pid}-${Date.now()}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [rel, data] of files) {
      const file = path.join(tmp, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    if (existsSync(dir)) {
      if (!readMarker(dir)) throw new PlainError(`${dir} was not made by Shipyard, so it was left alone.`);
      const old = `${tmp}-old`;
      renameSync(dir, old);
      renameSync(tmp, dir);
      rmSync(old, { recursive: true, force: true });
    } else {
      renameSync(tmp, dir);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Remove a pack folder, only if Shipyard made it. Returns true when removed. */
export function removePackFolder(dir) {
  if (!existsSync(dir) || !readMarker(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------- hooks files ----------

/** The command a hook runs. macOS and Linux: an absolute node. Windows: bare node (PowerShell-safe). */
export function hookCommand({ node, root, script, platform = process.platform }) {
  const target = `${fwd(root)}/scripts/${script}`;
  return platform === 'win32' ? `node "${target}"` : `"${fwd(node)}" "${target}"`;
}

/** The PreToolUse entry for ~/.codex/hooks.json. Changing its bytes makes every Codex user trust it again. */
export function codexHookEntry({ node, root, platform = process.platform }) {
  const hook = { type: 'command', command: hookCommand({ node, root, script: CODEX_SCRIPT, platform }) };
  if (platform === 'win32') hook.commandWindows = `node "${fwd(root).replace(/\//g, '\\')}\\scripts\\${CODEX_SCRIPT}"`;
  hook.timeout = HOOK_TIMEOUT;
  return { matcher: '.*', hooks: [hook] };
}

/** The entries for ~/.cursor/hooks.json, one per event. */
export function cursorHookEntries({ node, root, platform = process.platform }) {
  const command = hookCommand({ node, root, script: CURSOR_SCRIPT, platform });
  const out = {};
  for (const event of CURSOR_EVENTS) {
    out[event] = event === 'preToolUse' ? { command, matcher: CURSOR_TOOL_MATCHER, timeout: HOOK_TIMEOUT } : { command, timeout: HOOK_TIMEOUT };
  }
  return out;
}

function parseHooksFile(text, file) {
  if (text === null || text === undefined || text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PlainError(`${file} is not valid JSON, so Shipyard did not touch it. Fix the file (or move it away) and run this again.`);
  }
  if (!isObj(data)) throw new PlainError(`${file} does not hold a JSON object, so Shipyard did not touch it.`);
  return data;
}

const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;
const mentions = (x, script) => isObj(x) && [x.command, x.commandWindows].some((c) => typeof c === 'string' && c.includes(script));

/** Codex: drop every Shipyard hook from PreToolUse. Returns the list and where the first one was. */
function stripCodex(list) {
  const kept = [];
  let first = -1;
  for (const group of list) {
    if (isObj(group) && Array.isArray(group.hooks) && group.hooks.some((h) => mentions(h, CODEX_SCRIPT))) {
      if (first === -1) first = kept.length;
      const rest = group.hooks.filter((h) => !mentions(h, CODEX_SCRIPT));
      if (rest.length) kept.push({ ...group, hooks: rest });
    } else kept.push(group);
  }
  return { kept, first };
}

function stripCursor(list) {
  const kept = [];
  let first = -1;
  for (const e of list) {
    if (mentions(e, CURSOR_SCRIPT)) {
      if (first === -1) first = kept.length;
    } else kept.push(e);
  }
  return { kept, first };
}

/** ~/.codex/hooks.json with Shipyard's entry in it (an older one replaced). Returns { text, changed }. */
export function mergeCodexHooks(text, entry, file = 'hooks.json') {
  const data = parseHooksFile(text, file);
  const before = JSON.stringify(data);
  if (data.hooks === undefined) data.hooks = {};
  if (!isObj(data.hooks)) throw new PlainError(`${file} has a "hooks" value that is not an object, so Shipyard did not touch it.`);
  const list = data.hooks.PreToolUse ?? [];
  if (!Array.isArray(list)) throw new PlainError(`${file} has a "PreToolUse" value that is not a list, so Shipyard did not touch it.`);
  const { kept, first } = stripCodex(list);
  kept.splice(first === -1 ? kept.length : first, 0, entry);
  data.hooks.PreToolUse = kept;
  return { text: serialize(data), changed: JSON.stringify(data) !== before };
}

/** ~/.cursor/hooks.json with Shipyard's entries in it. Refuses a hooks file version other than 1. */
export function mergeCursorHooks(text, entries, file = 'hooks.json') {
  const data = parseHooksFile(text, file);
  const before = JSON.stringify(data);
  if (data.version !== undefined && data.version !== 1) {
    throw new PlainError(`${file} uses hooks version ${JSON.stringify(data.version)}, which this Shipyard does not know. It was left alone. Update Shipyard, or ask for help on github.com/philipposk/shipyard.`);
  }
  const out = { version: 1, ...data };
  if (out.hooks === undefined) out.hooks = {};
  if (!isObj(out.hooks)) throw new PlainError(`${file} has a "hooks" value that is not an object, so Shipyard did not touch it.`);
  for (const [event, entry] of Object.entries(entries)) {
    const list = out.hooks[event] ?? [];
    if (!Array.isArray(list)) throw new PlainError(`${file} has a "${event}" value that is not a list, so Shipyard did not touch it.`);
    const { kept, first } = stripCursor(list);
    kept.splice(first === -1 ? kept.length : first, 0, entry);
    out.hooks[event] = kept;
  }
  return { text: serialize(out), changed: JSON.stringify(out) !== before };
}

/** Remove Shipyard's hook entries from a hooks file's text. Returns { text, changed }. Other entries stay. */
export function removeShipyardHooks(text, agent, file = 'hooks.json') {
  const data = parseHooksFile(text, file);
  const before = JSON.stringify(data);
  if (isObj(data.hooks)) {
    if (agent === 'codex' && Array.isArray(data.hooks.PreToolUse)) {
      data.hooks.PreToolUse = stripCodex(data.hooks.PreToolUse).kept;
      if (data.hooks.PreToolUse.length === 0) delete data.hooks.PreToolUse;
    }
    if (agent === 'cursor') {
      for (const event of Object.keys(data.hooks)) {
        if (!Array.isArray(data.hooks[event])) continue;
        const { kept, first } = stripCursor(data.hooks[event]);
        if (first === -1) continue;
        if (kept.length) data.hooks[event] = kept;
        else delete data.hooks[event];
      }
    }
  }
  return { text: serialize(data), changed: JSON.stringify(data) !== before };
}

/** The Shipyard hook commands found in a hooks file's text (for --check). */
export function shipyardHookCommands(text, agent) {
  let data;
  try {
    data = parseHooksFile(text, 'hooks.json');
  } catch {
    return [];
  }
  const out = [];
  if (!isObj(data.hooks)) return out;
  if (agent === 'codex') {
    for (const g of Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : []) {
      for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) if (mentions(h, CODEX_SCRIPT)) out.push({ event: 'PreToolUse', matcher: g.matcher, command: h.command });
    }
  } else {
    for (const [event, list] of Object.entries(data.hooks)) {
      for (const e of Array.isArray(list) ? list : []) if (mentions(e, CURSOR_SCRIPT)) out.push({ event, matcher: e.matcher, command: e.command });
    }
  }
  return out;
}

// ---------- Codex rules (optional) ----------

/** The scripts the optional Codex rules file lets run without asking: Shipyard's own, not the installer or guards. */
export function ruleScripts(root) {
  return readdirSync(path.join(root, 'scripts'))
    .filter((f) => f.endsWith('.mjs') && f !== 'install-agents.mjs' && !f.startsWith('guard-'))
    .sort();
}

export function codexRules({ root, scripts = ruleScripts(root) }) {
  const lines = [
    RULES_MARKER,
    "# Lets Codex run Shipyard's own scripts without asking each time. Added by install-agents.mjs.",
    '# Delete this file to undo: Codex then asks again before each script.',
  ];
  for (const s of scripts) lines.push(`prefix_rule(pattern=["node", ${JSON.stringify(`${fwd(root)}/scripts/${s}`)}], decision="allow")`);
  return `${lines.join('\n')}\n`;
}

export function isShipyardRules(text) {
  return typeof text === 'string' && text.split(/\r?\n/, 1)[0].trim() === RULES_MARKER;
}

// ---------- the install record (~/.shipyard/install.json, no keys in it) ----------

export function readInstallRecord(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return isObj(r) ? r : null;
  } catch {
    return null;
  }
}

export function serializeRecord(record) {
  return serialize(record);
}

/** Write the record privately (folder 0700, file 0600). */
export function writeInstallRecord(file, record) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeRecord(record), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // not fatal
    }
  }
}

const hasEntries = (dir) => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/**
 * Other Shipyard copies an agent may also load, for --check notes: [{ kind, dir }].
 *   codex-skill   ~/.codex/skills/<skill> (a Codex import or a manual copy; Cursor can read this folder too)
 *   cursor-skill  ~/.cursor/skills/<skill>
 *   claude-skill  ~/.claude/skills/<skill> (Cursor loads it while it includes third-party configs)
 *   claude-plugin Claude Code's Shipyard plugin (Cursor loads it while it includes third-party plugins)
 *   codex-plugin  Claude Code's Shipyard as a Codex plugin ($CODEX_HOME/plugins/cache/shipyard)
 */
export function oldCopies(loc) {
  const found = [];
  const bases = [
    ['codex-skill', path.join(loc.codexHome, 'skills')],
    ['cursor-skill', path.join(loc.cursorHome, 'skills')],
    ['claude-skill', path.join(loc.claudeHome, 'skills')],
  ];
  for (const [kind, base] of bases) {
    for (const skill of SKILLS) {
      const file = path.join(base, skill, 'SKILL.md');
      try {
        const { fields } = splitFrontmatter(readFileSync(file, 'utf8'));
        if (/shipyard/i.test(`${fields.name ?? ''} ${fields.description ?? ''}`)) found.push({ kind, dir: path.dirname(file) });
      } catch {
        // none
      }
    }
  }
  const claudePlugins = path.join(loc.claudeHome, 'plugins');
  let claudeHas = hasEntries(path.join(claudePlugins, 'cache', 'shipyard'));
  try {
    const rec = JSON.parse(readFileSync(path.join(claudePlugins, 'installed_plugins.json'), 'utf8'));
    if (isObj(rec?.plugins) && Object.keys(rec.plugins).some((k) => /^shipyard@/.test(k))) claudeHas = true;
  } catch {
    // no record
  }
  if (claudeHas) found.push({ kind: 'claude-plugin', dir: claudePlugins });
  const codexPlugin = path.join(loc.codexHome, 'plugins', 'cache', 'shipyard');
  if (hasEntries(codexPlugin)) found.push({ kind: 'codex-plugin', dir: codexPlugin });
  return found;
}
