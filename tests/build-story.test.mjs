// build-story.mjs: turns Claude Code chat files into a build record. Synthetic chats, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStory, promptText, costOf, chatsFolderFor, storyMarkdown } from '../scripts/build-story.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-story.mjs');
const user = (t, content, extra = {}) => ({ type: 'user', timestamp: t, message: { role: 'user', content }, ...extra });
const reply = (t, id, model, usage) => ({ type: 'assistant', timestamp: t, message: { id, model, usage } });
const CHAT = [
  user('2026-10-01T10:00:00Z', 'Build a recipe box app\nwith tags'),
  reply('2026-10-01T10:00:30Z', 'm1', 'claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0 }),
  reply('2026-10-01T10:00:31Z', 'm1', 'claude-sonnet-4-5', { input_tokens: 1000, output_tokens: 1000 }), // same reply, second block
  user('2026-10-01T10:01:00Z', [{ type: 'tool_result', content: 'x' }]),
  reply('2026-10-01T10:02:00Z', 'm2', 'claude-sonnet-4-5', { input_tokens: 0, output_tokens: 1000 }),
  user('2026-10-01T10:05:00Z', '<system-reminder>hidden</system-reminder>ok'),
  user('2026-10-01T10:06:00Z', 'The save button still does not work'),
  reply('2026-10-01T10:07:00Z', 'm3', 'claude-opus-4-1', { input_tokens: 1_000_000, output_tokens: 0 }),
  user('2026-10-01T10:08:00Z', 'meta', { isMeta: true }),
];

test('prompts are the words typed: tool results, meta and reminders are dropped', () => {
  assert.equal(promptText(CHAT[3]), null);
  assert.equal(promptText(CHAT[8]), null);
  assert.equal(promptText(CHAT[5]), 'ok');
});

test('counts prompts, lines, tokens once per reply, cost per model and time per step', () => {
  const s = buildStory(CHAT);
  assert.equal(s.prompts, 3);
  assert.equal(s.promptLines, 4);
  assert.equal(s.corrections, 1);
  assert.equal(s.steps[0].tokens, 3000, 'the duplicated reply block is counted once');
  assert.equal(s.steps[0].seconds, 120);
  assert.equal(s.steps[1].ack, true);
  assert.equal(s.models['claude-opus-4-1'].cost, 15);
  assert.equal(s.cost, Math.round((15 + costOf('claude-sonnet-4-5', { input: 1000, output: 2000 })) * 100) / 100);
  const md = storyMarkdown('recipe-box', s);
  assert.match(md, /\(fix\) The save button/);
  assert.ok(!md.includes('| ok |'), 'acknowledgements are left out of the steps');
});

test('the chat folder matches how Claude Code names it', () => {
  assert.equal(chatsFolderFor('/Users/me/apps/recipe_box', '/H'), path.join('/H', '.claude', 'projects', '-Users-me-apps-recipe-box'));
});

test('CLI writes BUILD-STORY.md and the JSON for a showcase', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-'));
  const chats = path.join(dir, 'chats');
  await mkdir(chats);
  await writeFile(path.join(chats, 'a.jsonl'), CHAT.map((e) => JSON.stringify(e)).join('\n') + '\n{"half');
  const app = path.join(dir, 'app');
  await mkdir(app);
  const r = spawnSync(process.execPath, [SCRIPT, app, '--chats', chats, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).prompts, 3);
  assert.match(await readFile(path.join(app, 'BUILD-STORY.md'), 'utf8'), /# How app was made/);
  assert.equal(JSON.parse(await readFile(path.join(app, '.shipyard', 'build-story.json'), 'utf8')).app, 'app');
  const none = spawnSync(process.execPath, [SCRIPT, app, '--chats', path.join(dir, 'nope')], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  await rm(dir, { recursive: true, force: true });
});

test('pasted keys are blanked out of prompts', async () => {
  const { promptText } = await import('../scripts/build-story.mjs');
  const fake = ['gsk', 'a'.repeat(20)].join('_');
  const t = promptText({ type: 'user', message: { content: `use this key ${fake} and ${'f'.repeat(40)} please` } });
  assert.ok(!t.includes(fake));
  assert.ok(!t.includes('f'.repeat(40)));
  assert.match(t, /\[key removed\].*\[key removed\] please/);
});
