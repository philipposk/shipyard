#!/usr/bin/env node
// Shipyard guard check: proves, once per session, that the key guard really runs in Codex or Cursor.
//
//   start    makes a folder in the system temp folder with two files that hold no key:
//            plain.txt (safe to read) and .env.shipyard-guard-check-<nonce> (the guard must block it).
//   verify   checks what the agent saw. A block message carries a code made from the nonce, so the
//            result is checked by this script, not taken on the agent's word.
//
// Holds no state and records nothing. Built-ins only.
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guardCode } from './agents/guard-input.mjs';
import { startedAs } from './agents/entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const DIR_NAME = /^shipyard-guard-check-([0-9a-f]{16})$/;
const AGENTS = { codex: 'Codex', cursor: 'Cursor' };

export const checkFileName = (nonce) => `.env.shipyard-guard-check-${nonce}`;

const USAGE = `Usage:
  node guard-check.mjs start [--agent codex|cursor] [--json]
  node guard-check.mjs verify --dir <folder> --agent codex|cursor --plain <PLAIN-...> [--shell <code>] [--read <code>] [--saw-content]

Checks that the Shipyard key guard is on in Codex or Cursor. The files it makes hold no key.
verify exits 0 (ON), 1 (OFF) or 3 (inconclusive: the commands did not run).
`;

/** Make the check folder and its two files. Returns where they are. */
export function startCheck({ tmp = os.tmpdir(), nonce = randomBytes(8).toString('hex') } = {}) {
  const dir = path.join(tmp, `shipyard-guard-check-${nonce}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plainFile = path.join(dir, 'plain.txt');
  const checkFile = path.join(dir, checkFileName(nonce));
  writeFileSync(plainFile, `Shipyard guard check: safe to read. PLAIN-${nonce}\n`);
  writeFileSync(checkFile, `SHIPYARD_GUARD_CHECK=not-a-key-${nonce}\n`);
  return { dir, nonce, plainFile, checkFile };
}

export function startSteps({ dir, plainFile, checkFile }, agent) {
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  const forAgent = agent && AGENTS[agent] ? agent : 'codex|cursor';
  const lines = [
    'Shipyard guard check. It proves the key guard is on. Nothing in these files is a real key.',
    '',
    `1. Run this in the shell: cat ${q(plainFile)}`,
    '   It prints a line that ends with a PLAIN- value. Note that value.',
    `2. Run this in the shell: cat ${q(checkFile)}`,
    '   It should be blocked. The block message ends with "Guard check code (shell): ...". Note that code.',
  ];
  if (agent !== 'codex') {
    lines.push(
      `3. In Cursor only: open ${q(checkFile)} with your file-reading tool (not the shell).`,
      '   It should be blocked too, with "Guard check code (read): ...". Note that code.',
    );
  }
  lines.push(
    `${agent === 'codex' ? '3' : '4'}. Run: node "${ROOT}/scripts/guard-check.mjs" verify --dir ${q(dir)} --agent ${forAgent} --plain <value from step 1> --shell <shell code>${agent === 'codex' ? '' : ' --read <read code, Cursor only>'}`,
    '   If a step showed the text of the check file instead of being blocked, add --saw-content.',
  );
  return lines;
}

function fixLines(agent) {
  const lines = [];
  if (agent === 'codex') {
    lines.push('Fix: in a terminal run codex, type /hooks, trust the entry that ends in guard-codex.mjs, quit, start a new session, and run the check again.');
  } else {
    lines.push('Fix: in Cursor open the Command Palette, choose "Developer: Reload Window", and run the check again.');
  }
  lines.push(`Still OFF? In a terminal run: node "${ROOT}/scripts/install-agents.mjs" --check`);
  return lines;
}

/** Decide ON (exit 0), OFF (exit 1) or inconclusive (exit 3). Deletes the folder on ON. */
export function verifyCheck({ dir, agent, plain, shell, read, sawContent = false, tmp = os.tmpdir() } = {}) {
  const result = (status, exit, lines) => ({ status, exit, lines });
  if (!AGENTS[agent]) return result('inconclusive', 3, ['Say which agent ran the check: --agent codex or --agent cursor.']);
  const name = typeof dir === 'string' ? path.basename(dir.replace(/[\\/]+$/, '')) : '';
  const m = DIR_NAME.exec(name);
  if (!m) return result('inconclusive', 3, ['That is not a guard-check folder. Run "guard-check.mjs start" and use the folder it prints.']);
  const nonce = m[1];
  if (plain !== `PLAIN-${nonce}`) {
    return result('inconclusive', 3, [
      'Guard check: inconclusive. The plain file\'s value is missing or wrong, so the commands did not run.',
      'Run step 1 again and pass the exact PLAIN- value it prints.',
    ]);
  }
  const problems = [];
  if (sawContent) problems.push('The check file\'s text was shown, so nothing blocked it.');
  if (shell !== guardCode(nonce, 'shell')) problems.push(shell ? 'The shell code is wrong.' : 'No shell code: the shell read of the check file was not blocked by the guard.');
  if (agent === 'cursor' && read !== guardCode(nonce, 'read')) {
    problems.push(read ? 'The read code is wrong.' : 'No read code: opening the check file with the file tool was not blocked by the guard.');
  }
  const label = AGENTS[agent];
  if (problems.length) return result('OFF', 1, [`Guard check: OFF in ${label}. Your keys are not protected by the guard right now.`, ...problems, ...fixLines(agent)]);
  let removed = true;
  try {
    const parent = realpathSync(path.dirname(path.resolve(dir)));
    if (parent === realpathSync(tmp)) rmSync(path.resolve(dir), { recursive: true, force: true });
    else removed = false;
  } catch {
    removed = false;
  }
  return result('ON', 0, [`Guard check: ON in ${label}. The guard blocked the check file.${removed ? ' The check folder is deleted.' : ''}`]);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--saw-content') opts.sawContent = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (['--dir', '--agent', '--plain', '--shell', '--read'].includes(a)) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (opts.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'start') {
    const made = startCheck();
    if (opts.json) process.stdout.write(`${JSON.stringify({ dir: made.dir, plainFile: made.plainFile, checkFile: made.checkFile })}\n`);
    else process.stdout.write(`${startSteps(made, opts.agent).join('\n')}\n`);
    return;
  }
  if (cmd === 'verify') {
    const r = verifyCheck(opts);
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: r.status, lines: r.lines })}\n`);
    else process.stdout.write(`${r.lines.join('\n')}\n`);
    process.exitCode = r.exit;
    return;
  }
  process.stdout.write(USAGE);
  process.exitCode = 3;
}

if (startedAs(import.meta.url, 'guard-check.mjs')) main();
