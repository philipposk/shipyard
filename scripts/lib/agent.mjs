// Which coding agent the student uses, so Shipyard's messages name the right one and the right way
// to start a skill. Claude Code is the default: with no sign of another agent, every message reads
// exactly as it did before Codex and Cursor were supported.
//
//   claude   Claude Code runs this (it sets CLAUDECODE), or nothing says otherwise
//   codex    install-agents.mjs set Shipyard up for Codex only
//   cursor   ... for Cursor only
//   any      ... for both, so the message cannot know which one is reading it
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const KNOWN = ['codex', 'cursor'];

function homeDir(env) {
  return env.SHIPYARD_HOME ? path.resolve(env.SHIPYARD_HOME) : path.join(os.homedir(), '.shipyard');
}

/** 'claude' | 'codex' | 'cursor' | 'any'. Never throws. */
export function currentAgent(env = process.env, home = homeDir(env)) {
  if (env.CLAUDECODE) return 'claude';
  try {
    const record = JSON.parse(readFileSync(path.join(home, 'install.json'), 'utf8'));
    const agents = Object.keys(record?.agents ?? {}).filter((a) => KNOWN.includes(a));
    if (agents.length === 1) return agents[0];
    if (agents.length > 1) return 'any';
  } catch {
    // no install record: Claude Code
  }
  return 'claude';
}

const NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', any: 'your coding agent' };

/** The agent's name in the middle of a sentence ("tell Claude 'done'", "tell your coding agent 'done'"). */
export function agentName(agent = currentAgent()) {
  return NAMES[agent] ?? NAMES.any;
}

/** The agent's name at the start of a sentence. */
export function agentNameStart(agent = currentAgent()) {
  const n = agentName(agent);
  return n[0].toUpperCase() + n.slice(1);
}

/** How the student starts a Shipyard skill: /shipyard:setup, $shipyard-setup, /shipyard-setup or Shipyard setup. */
export function skillHint(skill, agent = currentAgent()) {
  const [name, ...rest] = String(skill).split(' ');
  const tail = rest.length ? ` ${rest.join(' ')}` : '';
  if (agent === 'claude') return `/shipyard:${name}${tail}`;
  if (agent === 'codex') return `$shipyard-${name}${tail}`;
  if (agent === 'cursor') return `/shipyard-${name}${tail}`;
  return `Shipyard ${name}${tail}`;
}

/** The free code review to suggest before merging. */
export function reviewHint(agent = currentAgent()) {
  return agent === 'claude' ? 'run /code-review in Claude Code before you merge' : 'ask your coding agent to review the branch before you merge';
}
