#!/usr/bin/env node
// habits.md (shown to Codex and Cursor) is generated from starter/CLAUDE.md (shown to Claude Code):
// the same habits, with one line reworded for agents that may not offer helper agents.
// The tests fail when the committed habits.md does not match this script's output.
// Run: node scripts/agents/build-habits.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const starter = readFileSync(path.join(root, 'starter', 'CLAUDE.md'), 'utf8');
const habits = starter.replace(
  '- Use cheaper models or helper agents for mechanical work (renames, running tests, searching). Keep the strongest model for hard decisions and security.',
  '- If your agent offers helper agents or smaller models, use them for mechanical work (renames, running tests, searching). Keep the strongest model for hard decisions and security.',
);
writeFileSync(path.join(root, 'scripts', 'agents', 'habits.md'), habits);
