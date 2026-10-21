#!/usr/bin/env node
// Sets up Shipyard for Codex and Cursor. Claude Code users do not need this: the Claude Code plugin
// does it all, and this script never writes to ~/.claude.
//
// What it writes, after showing the plan and asking:
//   ~/.agents/skills/shipyard-<skill>/   the skills, rewritten for Codex and Cursor ("the pack")
//   ~/.codex/hooks.json, ~/.cursor/hooks.json   the key guard hook (other entries are kept)
//   ~/.shipyard/install.json             where Shipyard is and what was installed (no keys)
//   ~/.codex/rules/shipyard.rules        only if the student says yes (Codex runs Shipyard's scripts without asking)
//
// --check, --update and --uninstall look after what it wrote. Built-ins only.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from './lib/log.mjs';
import * as core from './agents/core.mjs';
import { startedAs } from './agents/entry.mjs';

const { PlainError, fwd } = core;
const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_NAMES = { codex: 'Codex', cursor: 'Cursor' };
const CLONE_LINE = 'git clone --depth 1 https://github.com/philipposk/shipyard.git "$HOME/.local/share/shipyard"';

const USAGE = `Usage: node install-agents.mjs [options]

Sets up Shipyard for Codex and Cursor: the skills, and the hook that keeps your keys out of the chat.
Claude Code users do not need this (the Claude Code plugin does it).

  --agent codex|cursor|both   which agents to set up (default: the ones found on this computer)
  --yes                       do not ask before changing files
  --dry-run                   show what would change, change nothing
  --check                     look for problems (exits 1 if there are any)
  --update                    update Shipyard (git pull) and the installed files
  --uninstall                 remove what Shipyard installed for Codex and Cursor
  --skills-dir <path>         put the skills here instead of ~/.agents/skills
  --node <path>               the node program the hooks run
  --codex-allow-scripts       let Codex run Shipyard's own scripts without asking each time
  --no-codex-allow-scripts    do not (the default)
`;

const say = (text = '') => process.stdout.write(`${text}\n`);

/** A path as the student reads it: ~ for the home folder. */
export function show(p) {
  const home = fwd(os.homedir()).replace(/\/+$/, '');
  const f = fwd(p);
  if (f === home) return '~';
  return f.startsWith(`${home}/`) ? `~${f.slice(home.length)}` : f;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new PlainError(`Shipyard could not read ${show(file)} (${e?.code ?? 'error'}).`);
  }
}

export function readVersion(root) {
  try {
    return String(JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** This Shipyard folder, with symlinks resolved and forward slashes (what the hooks and skills use). */
function thisRoot() {
  return fwd(realpathSync(HERE_ROOT));
}

function parseAgents(value) {
  if (value === 'codex' || value === 'cursor') return [value];
  if (value === 'both') return ['codex', 'cursor'];
  throw new UsageError('--agent must be codex, cursor or both.');
}

const listAgents = (agents) => agents.map((a) => AGENT_NAMES[a]).join(' and ');
const recordAgents = (record) => Object.keys(record?.agents ?? {}).filter((a) => AGENT_NAMES[a]);

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Keep the student's own hooks file once, before Shipyard first changes it. */
function backupOnce(file) {
  const backup = `${file}.shipyard-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
}

async function askYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

// ---------- planning an install ----------

/**
 * Everything an install (or refresh) would change, without changing anything.
 * Throws PlainError when it must refuse.
 */
export function planInstall({ root, opts, env = process.env, platform = process.platform, now = new Date() }) {
  const loc = core.locations(env);
  const refused = core.checkRoot(root, { shipyardHome: loc.shipyardHome, platform });
  if (refused) throw new PlainError(refused);
  const version = readVersion(root);
  const record = core.readInstallRecord(loc.installFile);

  let agents;
  if (opts.agent) agents = parseAgents(opts.agent);
  else if (opts.refresh || recordAgents(record).length) agents = recordAgents(record);
  else agents = core.detectAgents({ env, platform, loc });
  if (!agents.length) {
    throw new PlainError(
      opts.refresh
        ? 'Shipyard is not installed for Codex or Cursor yet, so there is nothing to refresh. Run install-agents.mjs without --refresh.'
        : 'Shipyard could not find Codex or Cursor on this computer. Run this again with --agent codex, --agent cursor or --agent both.',
    );
  }

  // The node the hooks run. A recorded one is kept while it exists, so the Codex hook (and its trust) stays the same.
  let node;
  let nodeOnPath = true;
  if (opts.node) {
    node = fwd(path.resolve(opts.node));
    if (!existsSync(node)) throw new PlainError(`There is no node program at ${node}.`);
  } else if (record?.node && existsSync(record.node)) {
    node = fwd(record.node);
  } else {
    const found = core.findNode(env, platform);
    node = found.node;
    nodeOnPath = found.onPath;
  }
  if (platform === 'win32' && !core.findOnPath('node', env, platform)) {
    throw new PlainError('The hooks run "node", but node is not on your PATH. Install Node 20 or newer from nodejs.org (it adds itself to PATH), open a new terminal and run this again.');
  }
  const badNode = core.checkPathChars(node, 'node');
  if (badNode) throw new PlainError(`${badNode} Pass another one with --node.`);

  const skillsDir = fwd(path.resolve(opts['skills-dir'] ?? record?.skillsDir ?? loc.skillsDir));
  const badSkills = core.checkPathChars(skillsDir, 'skills folder');
  if (badSkills) throw new PlainError(`${badSkills} Pass another one with --skills-dir.`);

  // Same Shipyard, same version: keep the first install time, so a second run writes the same bytes.
  const marker = core.readMarker(path.join(skillsDir, `${core.PACK_PREFIX}setup`));
  const generatedAt = marker && marker.root === root && marker.version === version && typeof marker.generatedAt === 'string' ? marker.generatedAt : now.toISOString();

  const pack = core.planPack({ root, skillsDir, version, generatedAt });
  const lint = core.lintPack(pack);
  if (lint.length) {
    throw new PlainError(`Shipyard's copy of the skills for Codex and Cursor failed its own check (${lint[0].file}: ${lint[0].problem}). Please report this at github.com/philipposk/shipyard/issues.`);
  }
  const pp = core.packPlan(skillsDir, pack);
  if (pp.conflicts.length) {
    throw new PlainError(
      `There is already a folder Shipyard did not make: ${show(pp.conflicts[0])}. Shipyard did not overwrite it. Rename or remove it (it may be an old copy of Shipyard), then run this again.`,
    );
  }

  const changes = [];
  for (const f of pp.folders) changes.push({ kind: 'pack', path: f.dir, action: f.action, files: f.files });
  for (const s of pp.stale) changes.push({ kind: 'pack', path: s, action: 'remove' });
  // A different skills folder than last time: the old copy goes.
  if (record?.skillsDir && fwd(path.resolve(record.skillsDir)) !== skillsDir) {
    for (const skill of core.SKILLS) {
      const old = path.join(record.skillsDir, `${core.PACK_PREFIX}${skill}`);
      if (core.readMarker(old)) changes.push({ kind: 'pack', path: old, action: 'remove' });
    }
  }

  const agentsRecord = { ...(record?.agents ?? {}) };
  if (agents.includes('codex')) {
    const before = readText(loc.codexHooks);
    const merged = core.mergeCodexHooks(before, core.codexHookEntry({ node, root, platform }), show(loc.codexHooks));
    changes.push({ kind: 'hooks', agent: 'codex', path: loc.codexHooks, action: before === null ? 'create' : merged.changed ? 'update' : 'unchanged', text: merged.text });
    agentsRecord.codex = { hooksFile: fwd(loc.codexHooks) };
  }
  if (agents.includes('cursor')) {
    const before = readText(loc.cursorHooks);
    const merged = core.mergeCursorHooks(before, core.cursorHookEntries({ node, root, platform }), show(loc.cursorHooks));
    changes.push({ kind: 'hooks', agent: 'cursor', path: loc.cursorHooks, action: before === null ? 'create' : merged.changed ? 'update' : 'unchanged', text: merged.text });
    agentsRecord.cursor = { hooksFile: fwd(loc.cursorHooks) };
  }

  // Codex rules (optional): true = write it, false = remove a Shipyard one, 'ask' = ask after installing.
  let rules = null;
  if (agents.includes('codex')) {
    const text = readText(loc.codexRules);
    const ours = core.isShipyardRules(text);
    let want;
    if (opts['codex-allow-scripts']) want = true;
    else if (opts['no-codex-allow-scripts']) want = false;
    else if (ours) want = true;
    else if (opts.yes || opts.refresh || text !== null) want = false;
    else want = 'ask';
    if (text !== null && !ours) {
      rules = { kind: 'rules', path: loc.codexRules, action: 'unchanged', foreign: want === true };
    } else if (want === true) {
      const next = core.codexRules({ root });
      rules = { kind: 'rules', path: loc.codexRules, action: text === null ? 'create' : text === next ? 'unchanged' : 'update', text: next };
    } else if (want === false) {
      rules = { kind: 'rules', path: loc.codexRules, action: ours ? 'remove' : 'none' };
    } else {
      rules = { kind: 'rules', path: loc.codexRules, action: 'ask', text: core.codexRules({ root }) };
    }
  }

  const ordered = {};
  for (const a of ['codex', 'cursor']) if (agentsRecord[a]) ordered[a] = agentsRecord[a];
  const next = { schema: 1, root, node, skillsDir, version, installedAt: record?.installedAt ?? now.toISOString(), agents: ordered };
  const strip = (r) => JSON.stringify({ ...r, installedAt: null });
  const same = record !== null && strip(record) === strip(next);
  if (!same) next.installedAt = now.toISOString();
  changes.push({ kind: 'record', path: loc.installFile, action: record === null ? 'create' : same ? 'unchanged' : 'update', record: next });

  return { loc, root, version, agents, node, nodeOnPath, skillsDir, changes, rules, record: next };
}

const VERB = { create: 'create', update: 'update', remove: 'remove' };

function describe(c) {
  const where = c.kind === 'pack' ? `${show(c.path)}/` : show(c.path);
  if (c.kind === 'hooks') {
    const what = c.action === 'create' ? '(the Shipyard key guard)' : `(adds the Shipyard key guard, keeps your other entries; the old file is kept as ${path.basename(c.path)}.shipyard-backup)`;
    return `${VERB[c.action]}  ${where} ${what}`;
  }
  if (c.kind === 'record') return `${VERB[c.action]}  ${where} (where Shipyard is, no keys)`;
  if (c.kind === 'rules') return `${VERB[c.action]}  ${where} (lets Codex run Shipyard's own scripts without asking)`;
  return `${VERB[c.action]}  ${where}`;
}

function printPlan(plan, title) {
  say(title);
  say(`  From: ${show(plan.root)}`);
  say(`  For: ${listAgents(plan.agents)}`);
  say(`  Node for the hooks: ${plan.node}`);
  say('');
  const all = [...plan.changes, ...(plan.rules ? [plan.rules] : [])];
  const todo = all.filter((c) => VERB[c.action]);
  const same = all.filter((c) => c.action === 'unchanged' && !c.foreign).length;
  if (todo.length) {
    say('This will:');
    for (const c of todo) say(`  ${describe(c)}`);
  }
  if (todo.length && plan.rules?.action === 'ask') say(`  then ask whether Codex may run Shipyard's own scripts without asking (${show(plan.rules.path)})`);
  if (todo.length && same) say(`  (${same} already up to date)`);
  return todo.length;
}

function applyChanges(changes, { backup = true } = {}) {
  for (const c of changes) {
    if (!VERB[c.action]) continue;
    if (c.kind === 'pack') {
      if (c.action === 'remove') core.removePackFolder(c.path);
      else core.writePackFolder(c.path, c.files);
    } else if (c.kind === 'hooks') {
      if (backup) backupOnce(c.path);
      writeAtomic(c.path, c.text);
    } else if (c.kind === 'rules') {
      if (c.action === 'remove') rmSync(c.path, { force: true });
      else writeAtomic(c.path, c.text);
    } else if (c.kind === 'record') {
      if (c.action === 'remove') rmSync(c.path, { force: true });
      else core.writeInstallRecord(c.path, c.record);
    }
  }
}

function nextSteps(plan) {
  const lines = [''];
  if (plan.agents.includes('codex')) {
    lines.push(
      'Next, in Codex:',
      '  1. In a terminal, run: codex',
      '  2. Type /hooks and trust the entry whose command ends in guard-codex.mjs. Then quit.',
      '  3. Start a new Codex session and type: $shipyard-setup',
      '  Using the ChatGPT desktop app or the IDE extension? Do the /hooks step once in the terminal anyway.',
    );
  }
  if (plan.agents.includes('cursor')) {
    if (lines.length > 1) lines.push('');
    lines.push(
      'Next, in Cursor:',
      '  1. Open the Command Palette and choose "Developer: Reload Window" (or quit and reopen Cursor).',
      '  2. In Agent chat, type: /shipyard-setup',
      '  In the Cursor CLI: run agent, then type /shipyard-setup',
    );
  }
  if (/\/(\.nvm|\.volta|\.fnm|fnm|fnm_multishells)\//.test(plan.node)) {
    lines.push('', 'Your node comes from a version manager. If you switch Node versions, run this again with --update.');
  }
  if (!plan.nodeOnPath) lines.push('', `node was not found on your PATH, so the hooks run ${plan.node}.`);
  return lines;
}

async function install(opts, env) {
  const root = thisRoot();
  const plan = planInstall({ root, opts, env });
  const title = `Shipyard ${plan.version} for Codex and Cursor`;
  const todo = printPlan(plan, title);
  if (plan.rules?.foreign) say(`! ${show(plan.rules.path)} was not made by Shipyard, so it was left alone.`);
  if (!todo) {
    say('Everything is already installed and unchanged.');
    if (plan.rules?.action === 'ask') say("(To let Codex run Shipyard's own scripts without asking, run this again with --codex-allow-scripts.)");
    if (!opts.refresh) for (const l of nextSteps(plan)) say(l);
    return 0;
  }
  if (opts['dry-run']) {
    say('');
    say('Dry run: nothing was written.');
    return 0;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      say('');
      say('This changes files, so it needs a yes first. Run it in a terminal, or add --yes.');
      return 1;
    }
    say('');
    if (!(await askYes('Go ahead? (y/N) '))) {
      say('Nothing was changed.');
      return 1;
    }
  }
  applyChanges(plan.changes);
  if (plan.rules && plan.rules.action !== 'ask') applyChanges([plan.rules]);
  say('');
  say('Done.');
  if (plan.rules?.action === 'ask') {
    say('');
    say('Codex asks before it runs each command. Shipyard can let it run Shipyard\'s own scripts (and nothing else) without asking.');
    if (await askYes("Let Codex run Shipyard's own scripts without asking each time? (y/N) ")) {
      writeAtomic(plan.rules.path, plan.rules.text);
      say(`Added ${show(plan.rules.path)}. Delete that file to undo it.`);
    } else {
      say('Fine. Codex will ask each time (choose the option that stops it asking again for that command).');
    }
  }
  if (!opts.refresh) for (const l of nextSteps(plan)) say(l);
  return 0;
}

// ---------- --check ----------

const SAMPLE = 'cat ~/.shipyard/secrets.env';

/** Run a hook command the way the agent would, with the keys-file sample. Returns true when it blocked it. */
export function hookBlocks(command, agent, { env = process.env, platform = process.platform } = {}) {
  const home = os.homedir();
  const input =
    agent === 'codex'
      ? { session_id: 'shipyard-check', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: SAMPLE }, cwd: home }
      : { hook_event_name: 'beforeShellExecution', command: SAMPLE, cwd: home, cursor_version: 'shipyard-check', workspace_roots: [home] };
  // An app started from the Dock gets a short PATH. The hook must still work there.
  const runEnv = platform === 'win32' ? { ...env } : { HOME: home, PATH: '/usr/bin:/bin' };
  if (env.SHIPYARD_HOME) runEnv.SHIPYARD_HOME = env.SHIPYARD_HOME;
  const r = spawnSync(command, { shell: true, input: JSON.stringify(input), env: runEnv, encoding: 'utf8', timeout: 20_000 });
  try {
    const out = JSON.parse(String(r.stdout).trim());
    if (agent === 'codex') return r.status === 0 && out?.hookSpecificOutput?.permissionDecision === 'deny';
    return r.status === 2 && out?.permission === 'deny';
  } catch {
    return false;
  }
}

/** The node a hook command starts ("<node>" "<script>"), or null for a bare node. */
function hookNode(command) {
  const m = /^"([^"]+)"\s/.exec(String(command));
  return m ? m[1] : null;
}

export function runCheck({ root, env = process.env, platform = process.platform }) {
  const loc = core.locations(env);
  const problems = [];
  const notes = [];
  const record = core.readInstallRecord(loc.installFile);
  if (!record) {
    problems.push(`Shipyard is not installed for Codex or Cursor yet (no ${show(loc.installFile)}). Run: node "${root}/scripts/install-agents.mjs"`);
    return { problems, notes };
  }
  const version = readVersion(root);
  if (record.root !== root) {
    problems.push(`${show(loc.installFile)} says Shipyard is at ${show(record.root)}, but this copy is at ${show(root)}. Was the folder moved? Run: node "${root}/scripts/install-agents.mjs"`);
  }
  if (record.node && platform !== 'win32' && !existsSync(record.node)) {
    problems.push(`The node program the hooks run is gone (${record.node}). Run: node "${root}/scripts/install-agents.mjs" --update`);
  }

  const skillsDir = record.skillsDir ?? loc.skillsDir;
  let fresh = null;
  for (const skill of core.SKILLS) {
    const dir = path.join(skillsDir, `${core.PACK_PREFIX}${skill}`);
    const marker = core.readMarker(dir);
    if (!marker) {
      problems.push(`The skill folder ${show(dir)} is missing. Run the installer again.`);
      continue;
    }
    if (marker.root !== root || marker.version !== version) {
      problems.push(`${show(dir)} is from Shipyard ${marker.version} at ${show(marker.root ?? '?')}, not ${version} at ${show(root)}. Run the installer again.`);
      continue;
    }
    try {
      fresh ??= core.planPack({ root, skillsDir: fwd(skillsDir), version, generatedAt: marker.generatedAt });
      const entry = fresh.find((p) => p.skill === skill);
      if (entry && !core.folderMatches(dir, entry.files)) problems.push(`${show(dir)} was changed by hand. Run the installer again to put it back.`);
    } catch (e) {
      problems.push(`Shipyard could not rebuild its skills to compare them (${e.message}).`);
    }
  }

  for (const agent of recordAgents(record)) {
    const file = record.agents[agent]?.hooksFile ?? (agent === 'codex' ? loc.codexHooks : loc.cursorHooks);
    const script = agent === 'codex' ? core.CODEX_SCRIPT : core.CURSOR_SCRIPT;
    let text;
    try {
      text = readText(file);
    } catch (e) {
      problems.push(e.message);
      continue;
    }
    const found = text === null ? [] : core.shipyardHookCommands(text, agent);
    if (!found.length) {
      problems.push(`${AGENT_NAMES[agent]}: there is no Shipyard key guard in ${show(file)}. Run the installer again.`);
      continue;
    }
    if (agent === 'cursor') {
      const events = new Set(found.map((h) => h.event));
      const missing = core.CURSOR_EVENTS.filter((e) => !events.has(e));
      if (missing.length) problems.push(`Cursor: the key guard is missing for ${missing.join(', ')} in ${show(file)}. Run the installer again.`);
    }
    const expected = `${root}/scripts/${script}`;
    const elsewhere = found.find((h) => !String(h.command).includes(expected));
    if (elsewhere) problems.push(`${AGENT_NAMES[agent]}: the key guard in ${show(file)} runs another Shipyard folder (${elsewhere.command}). Run the installer again from the copy you use.`);
    const n = hookNode(found[0].command);
    if (n && !existsSync(n)) problems.push(`${AGENT_NAMES[agent]}: the hook's node program is gone (${n}). Run: node "${root}/scripts/install-agents.mjs" --update`);
    else if (!hookBlocks(found[0].command, agent, { env, platform })) {
      problems.push(`${AGENT_NAMES[agent]}: the key guard hook did not block a test read of the keys file. Run the installer again; if that does not help, report it at github.com/philipposk/shipyard/issues.`);
    }
  }

  for (const dir of core.oldCopies(loc)) {
    notes.push(`${show(dir)} looks like an older copy of a Shipyard skill. Use the shipyard-* ones. In Codex you can switch the old one off with [[skills.config]] enabled = false in ~/.codex/config.toml.`);
  }
  if (record.agents?.codex) {
    notes.push('Codex asks you to trust the hook once: run codex in a terminal, type /hooks, and trust guard-codex.mjs. This check cannot see that step; the guard check in a session can.');
  }
  return { problems, notes };
}

function check(env) {
  const root = thisRoot();
  const { problems, notes } = runCheck({ root, env });
  for (const p of problems) say(`✗ ${p}`);
  for (const n of notes) say(`! ${n}`);
  if (!problems.length) say('✓ No problems found.');
  return problems.length ? 1 : 0;
}

// ---------- --uninstall ----------

export function planUninstall({ opts, env = process.env }) {
  const loc = core.locations(env);
  const record = core.readInstallRecord(loc.installFile);
  const agents = opts.agent ? parseAgents(opts.agent) : ['codex', 'cursor'];
  const changes = [];
  for (const agent of agents) {
    const file = record?.agents?.[agent]?.hooksFile ?? (agent === 'codex' ? loc.codexHooks : loc.cursorHooks);
    const text = readText(file);
    if (text === null) continue;
    let removed;
    try {
      removed = core.removeShipyardHooks(text, agent, show(file));
    } catch (e) {
      throw new PlainError(`${e.message} Remove the Shipyard lines (the ones with ${agent === 'codex' ? core.CODEX_SCRIPT : core.CURSOR_SCRIPT}) by hand.`);
    }
    if (removed.changed) changes.push({ kind: 'hooks', agent, path: file, action: 'update', text: removed.text });
  }
  if (agents.includes('codex') && core.isShipyardRules(readText(loc.codexRules))) changes.push({ kind: 'rules', path: loc.codexRules, action: 'remove' });

  const left = recordAgents(record).filter((a) => !agents.includes(a));
  if (!left.length) {
    const dirs = new Set([fwd(record?.skillsDir ?? loc.skillsDir), fwd(loc.skillsDir)]);
    for (const dir of dirs) {
      const { stale } = core.packPlan(dir, []);
      for (const s of stale) changes.push({ kind: 'pack', path: s, action: 'remove' });
    }
    if (record) changes.push({ kind: 'record', path: loc.installFile, action: 'remove' });
  } else if (record) {
    const nextAgents = {};
    for (const a of left) nextAgents[a] = record.agents[a];
    changes.push({ kind: 'record', path: loc.installFile, action: 'update', record: { ...record, agents: nextAgents } });
  }
  return { changes, left, record };
}

async function uninstall(opts, env) {
  const root = thisRoot();
  const plan = planUninstall({ opts, env });
  if (!plan.changes.length) {
    say('Nothing of Shipyard\'s is installed for Codex or Cursor here.');
    if (!plan.left.length) say(`You can now delete ${show(root)}`);
    return 0;
  }
  say('Remove Shipyard for Codex and Cursor. This will:');
  for (const c of plan.changes) {
    const where = c.kind === 'pack' ? `${show(c.path)}/` : show(c.path);
    const what = c.kind === 'hooks' ? ' (only the Shipyard entries; your other entries stay)' : '';
    say(`  ${c.kind === 'hooks' || (c.kind === 'record' && c.action === 'update') ? 'update' : 'remove'}  ${where}${what}`);
  }
  if (opts['dry-run']) {
    say('');
    say('Dry run: nothing was written.');
    return 0;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      say('This changes files, so it needs a yes first. Run it in a terminal, or add --yes.');
      return 1;
    }
    if (!(await askYes('Go ahead? (y/N) '))) {
      say('Nothing was changed.');
      return 1;
    }
  }
  applyChanges(plan.changes, { backup: false });
  say('Done. Reload Cursor and start a new Codex session so they forget the old skills.');
  if (!plan.left.length) say(`You can now delete ${show(root)}`);
  return 0;
}

// ---------- --update ----------

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
}

function codexEntryText(file) {
  try {
    const text = readText(file);
    return text === null ? '' : JSON.stringify(core.shipyardHookCommands(text, 'codex'));
  } catch {
    return '';
  }
}

async function update(opts, env) {
  const root = thisRoot();
  const loc = core.locations(env);
  const record = core.readInstallRecord(loc.installFile);
  if (!record || !recordAgents(record).length) {
    say('Shipyard is not installed for Codex or Cursor yet. Run install-agents.mjs without --update first.');
    return 1;
  }
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    say(`This Shipyard folder (${show(root)}) is not a git clone, so it cannot update itself.`);
    say(`Clone it again with: ${CLONE_LINE}`);
    say('Then run the installer from the new folder.');
    return 1;
  }
  const status = git(root, ['status', '--porcelain']);
  if (status.status !== 0 || String(status.stdout).trim() !== '') {
    say(`This Shipyard folder (${show(root)}) has changes of its own (edited or added files), so updating could lose them. Nothing was changed.`);
    say('Move the folder away and clone Shipyard again, or ask for help at github.com/philipposk/shipyard/issues.');
    return 1;
  }
  const oldVersion = readVersion(root);
  const codexFile = record.agents?.codex?.hooksFile ?? loc.codexHooks;
  const before = codexEntryText(codexFile);
  say('Getting the latest Shipyard...');
  const pull = git(root, ['pull', '--ff-only']);
  if (pull.status !== 0) {
    const why = String(pull.stderr || pull.stdout).trim().split('\n')[0];
    say(`git pull did not work${why ? ` (${why})` : ''}. Check your internet connection and run --update again. Nothing else was changed.`);
    return 1;
  }
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-agents.mjs'), '--refresh', '--yes'], { stdio: 'inherit', env });
  const newVersion = readVersion(root);
  say('');
  say(oldVersion === newVersion ? `Shipyard is up to date (${newVersion}).` : `Updated Shipyard from ${oldVersion} to ${newVersion}.`);
  if (record.agents?.codex) {
    say(codexEntryText(codexFile) === before ? 'Codex hook unchanged, nothing to trust.' : 'Codex hook changed: open /hooks in Codex and trust it again.');
  }
  return child.status ?? 1;
}

// ---------- entry ----------

const SPEC = {
  boolean: ['yes', 'dry-run', 'check', 'update', 'uninstall', 'refresh', 'codex-allow-scripts', 'no-codex-allow-scripts', 'help'],
  string: ['agent', 'skills-dir', 'node'],
  alias: { h: 'help', y: 'yes' },
};

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, SPEC);
  } catch (e) {
    say(e.message);
    return 2;
  }
  if (opts.help) {
    say(USAGE.trimEnd());
    return 0;
  }
  if (opts['codex-allow-scripts'] && opts['no-codex-allow-scripts']) {
    say('Choose one: --codex-allow-scripts or --no-codex-allow-scripts.');
    return 2;
  }
  const modes = ['check', 'update', 'uninstall'].filter((m) => opts[m]);
  if (modes.length > 1) {
    say(`Choose one of --${modes.join(', --')}.`);
    return 2;
  }
  try {
    if (opts.check) return check(env);
    if (opts.update) return await update(opts, env);
    if (opts.uninstall) return await uninstall(opts, env);
    return await install(opts, env);
  } catch (e) {
    if (e instanceof PlainError || e instanceof UsageError) {
      say(e.message);
      return e instanceof UsageError ? 2 : 1;
    }
    say(`Something went wrong: ${e?.message ?? e}. Run the same command again. If it fails again, report it at github.com/philipposk/shipyard/issues.`);
    return 1;
  }
}

if (startedAs(import.meta.url, 'install-agents.mjs')) {
  main().then((code) => {
    process.exitCode = code;
  });
}
