#!/usr/bin/env node
// Turn the Claude Code chats that built an app into a short "how it was made" record:
// the prompts (cleaned), how many, tokens and estimated cost per model, and time per step.
// Reads ~/.claude/projects/<app folder>/*.jsonl on this computer. Nothing is sent anywhere.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Write a "how this app was made" record from the Claude Code chats that built it.

Usage:
  node build-story.mjs <app-folder> [--chats <folder>] [--json]

  --chats  folder with the chat files (default: ~/.claude/projects/<app folder, with / as ->)
  --json   print the result as JSON
  --help   show this text

Writes BUILD-STORY.md (for people: the cleaned prompts and the numbers) and .shipyard/build-story.json
(for a showcase page) in the app folder. Costs are estimates at public API prices; on a Claude plan you
pay the plan, not these amounts. Read BUILD-STORY.md before sharing it: prompts can contain private details.
Exit code: 0 done, 1 no chats found, 2 wrong options.
`;

// US$ per million tokens: input, output, cache write, cache read. Matched in order, first hit wins.
const PRICES = [
  [/opus-4-[5-9]|opus-[5-9]/, [5, 25, 6.25, 0.5]],
  [/opus/, [15, 75, 18.75, 1.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4|haiku-[5-9]/, [1, 5, 1.25, 0.1]],
  [/haiku/, [0.8, 4, 1, 0.08]],
];

export function priceFor(model) {
  const hit = PRICES.find(([re]) => re.test(String(model)));
  return hit ? hit[1] : null;
}

export function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  return ((u.input ?? 0) * p[0] + (u.output ?? 0) * p[1] + (u.cacheWrite ?? 0) * p[2] + (u.cacheRead ?? 0) * p[3]) / 1e6;
}

/** Claude Code stores each project's chats under its folder path with every non-letter/digit turned into "-". */
export function chatsFolderFor(appDir, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', path.resolve(appDir).replace(/[^A-Za-z0-9]/g, '-'));
}

const NOISE = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;
const ACK = /^(ok(ay)?|yes|y|go|go on|continue|next|sure|thanks?|thank you|do it|proceed|👍)[.! ]*$/i;
const CORRECTION = /\b(again|still|wrong|not working|doesn'?t work|didn'?t|broken|you forgot|why did|instead)\b/i;

/** The words a person typed, or null for tool results, meta messages and empty turns. */
export function promptText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
  text = text.replace(NOISE, '').trim();
  return text || null;
}

/** Build the record from parsed chat entries (all sessions, any order). */
export function buildStory(entries) {
  const sorted = entries.filter((e) => e?.timestamp).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const steps = [];
  const models = {};
  const seen = new Set();
  let cur = null;
  for (const e of sorted) {
    const text = promptText(e);
    if (text) {
      cur = { at: e.timestamp, end: e.timestamp, prompt: text, lines: text.split(/\r?\n/).length, tokens: 0, cost: 0, ack: ACK.test(text), correction: CORRECTION.test(text) };
      steps.push(cur);
      continue;
    }
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    // One reply is stored once per content block with the same id and usage: count it once.
    const id = e.message.id ?? e.uuid;
    if (id && seen.has(id)) { if (cur) cur.end = e.timestamp; continue; }
    if (id) seen.add(id);
    const u = e.message.usage;
    const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    const model = e.message.model ?? 'unknown';
    const m = (models[model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    for (const k of Object.keys(usage)) m[k] += usage[k];
    const cost = costOf(model, usage);
    m.cost += cost;
    if (cur) {
      cur.tokens += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
      cur.cost += cost;
      cur.end = e.timestamp;
    }
  }
  for (const s of steps) s.seconds = Math.max(0, Math.round((Date.parse(s.end) - Date.parse(s.at)) / 1000));
  const totals = Object.values(models).reduce((t, m) => ({
    tokens: t.tokens + m.input + m.output + m.cacheWrite + m.cacheRead,
    cost: t.cost + m.cost,
  }), { tokens: 0, cost: 0 });
  return {
    prompts: steps.length,
    promptLines: steps.reduce((n, s) => n + s.lines, 0),
    corrections: steps.filter((s) => s.correction).length,
    workSeconds: steps.reduce((n, s) => n + s.seconds, 0),
    started: sorted[0]?.timestamp ?? null,
    finished: sorted.at(-1)?.timestamp ?? null,
    tokens: totals.tokens,
    cost: Math.round(totals.cost * 100) / 100,
    models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, { ...m, cost: Math.round(m.cost * 100) / 100 }])),
    steps: steps.map((s) => ({ at: s.at, prompt: s.prompt, lines: s.lines, tokens: s.tokens, cost: Math.round(s.cost * 100) / 100, seconds: s.seconds, ack: s.ack, correction: s.correction })),
  };
}

const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function storyMarkdown(name, s) {
  const out = [`# How ${name} was made`, '',
    `- Prompts: ${s.prompts} (${s.promptLines} lines typed), of which ${s.corrections} were corrections`,
    `- Agent working time: ${fmtTime(s.workSeconds)}`,
    `- Tokens: ${fmtTokens(s.tokens)}, about $${s.cost.toFixed(2)} at API prices (a Claude plan pays a flat fee instead)`,
    `- Models: ${Object.entries(s.models).map(([m, v]) => `${m} ($${v.cost.toFixed(2)})`).join(', ') || 'none'}`,
    '', '## Steps', '',
    '| # | What was asked | Time | Tokens | Cost |', '|---|---|---|---|---|'];
  let i = 0;
  for (const st of s.steps) {
    if (st.ack) continue; // "ok", "go on": counted above, not worth reading
    i += 1;
    const short = st.prompt.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 200);
    out.push(`| ${i} | ${st.correction ? '(fix) ' : ''}${short}${st.prompt.length > 200 ? '…' : ''} | ${fmtTime(st.seconds)} | ${fmtTokens(st.tokens)} | $${st.cost.toFixed(2)} |`);
  }
  out.push('', 'Steps marked (fix) are corrections. If Shipyard now does that by itself, add it to ~/.shipyard/learnings.md and leave the step out when you share this.', '');
  return out.join('\n');
}

async function readChats(folder) {
  let files;
  try { files = (await readdir(folder)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const entries = [];
  for (const f of files) {
    for (const line of (await readFile(path.join(folder, f), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* a half-written last line: skip */ }
    }
  }
  return entries;
}

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node build-story.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const folder = args.chats ? path.resolve(args.chats) : chatsFolderFor(appDir);
  const entries = await readChats(folder);
  if (!entries.length) {
    log.fail(`No Claude Code chats found in ${folder}. Use --chats <folder> if the app was built from another folder.`);
    return { ok: false, folder };
  }
  const story = buildStory(entries);
  const name = path.basename(appDir);
  await writeFile(path.join(appDir, 'BUILD-STORY.md'), storyMarkdown(name, story));
  await mkdir(path.join(appDir, '.shipyard'), { recursive: true });
  await writeFile(path.join(appDir, '.shipyard', 'build-story.json'), `${JSON.stringify({ app: name, ...story }, null, 2)}\n`);
  log.ok(`BUILD-STORY.md written: ${story.prompts} prompts, ${fmtTokens(story.tokens)} tokens, about $${story.cost.toFixed(2)}, ${fmtTime(story.workSeconds)} of agent time`);
  log.info('Read it before sharing: prompts can contain private details.');
  return { ok: true, folder, prompts: story.prompts, tokens: story.tokens, cost: story.cost, workSeconds: story.workSeconds };
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['chats'] }, help: HELP, main });
}
