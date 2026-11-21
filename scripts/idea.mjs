#!/usr/bin/env node
// Files a plugin improvement idea as a GitHub issue labelled `idea`, without leaving the work at hand.
// If gh is missing, not signed in, or GitHub does not answer, the idea is saved to
// ~/.shipyard/ideas.md instead, so it is never lost. `--send-saved` files those later.
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, isMain, repoDisplay, git, APP_CONFIG_FILE } from './provision/common.mjs';
import { run as realRun } from './lib/run.mjs';
import { HOME_DIR, ensureHomeDir } from './lib/paths.mjs';
import { UsageError } from './lib/log.mjs';
import * as log from './lib/log.mjs';

export const DEFAULT_REPO = 'philipposk/shipyard';
export const LABEL = 'idea';
export const IDEAS_FILE = 'ideas.md';
const MARK = '<!-- shipyard-idea -->';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_TIMEOUT_MS = 20_000;

const HELP = `
File an idea for the Shipyard plugin as a GitHub issue labelled "idea".

Usage:
  node idea.mjs "<the idea>" [--context "<what you were working on>"] [--dir <folder>]
  node idea.mjs --send-saved

  --context     One sentence on what you were doing when the idea came up.
  --dir         The folder you are working in (default: the current folder). Used to name the app.
  --repo        Where to file it (default: ${DEFAULT_REPO}, or SHIPYARD_IDEA_REPO).
  --send-saved  File the ideas saved in ~/.shipyard/${IDEAS_FILE} while GitHub was out of reach.
  --json        Print the result as JSON.

Without the GitHub CLI (gh), or when it is not signed in, the idea is saved to
~/.shipyard/${IDEAS_FILE} and nothing is lost.
`;

/** A short issue title from the idea: first line, at most 80 characters, cut at a word. */
export function ideaTitle(text) {
  const first = String(text).trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  if (first.length <= 80) return first;
  const cut = first.slice(0, 79);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** Which app and repository the idea came from. Never includes a login or token from the remote. */
export async function sourceOf(dir, run = realRun) {
  const source = { folder: path.basename(dir) };
  try {
    const config = JSON.parse((await readFile(path.join(dir, APP_CONFIG_FILE), 'utf8')).replace(/^﻿/, ''));
    if (config && typeof config.slug === 'string') source.app = config.slug;
  } catch {
    // Not a Shipyard app, or no marker: the folder name is enough.
  }
  const remote = await git(run, dir, ['remote', 'get-url', 'origin']);
  if (remote.code === 0) {
    const shown = repoDisplay(remote.out);
    if (shown) source.repo = shown;
  }
  const branch = await git(run, dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code === 0 && branch.out && branch.out !== 'HEAD') source.branch = branch.out;
  return source;
}

export function sourceLine(source) {
  const name = source.app ?? source.folder;
  const parts = [source.repo ? `${name} (${source.repo})` : name];
  if (source.branch) parts.push(`branch \`${source.branch}\``);
  return parts.join(', ');
}

export function ideaBody({ text, context, source, date }) {
  const lines = [String(text).trim(), '', '---', `**From:** ${sourceLine(source)}`];
  if (context && String(context).trim()) lines.push(`**Working on:** ${String(context).trim()}`);
  lines.push(`**Filed:** ${date} with \`/shipyard:idea\``);
  return `${lines.join('\n')}\n`;
}

const labelMissing = (stderr) => /label/i.test(stderr) && /not found|could not add|does not exist/i.test(stderr);

/**
 * Create the issue with gh. Adds the label, creating it once if the repository lacks it.
 * Resolves to { ok: true, url } or { ok: false, reason }.
 */
export async function fileIssue({ repo, title, body }, run = realRun) {
  const create = (withLabel) => run('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-', ...(withLabel ? ['--label', LABEL] : [])], { input: body, timeoutMs: GH_TIMEOUT_MS });
  let r = await create(true);
  if (r.code !== 0 && labelMissing(r.stderr)) {
    await run('gh', ['label', 'create', LABEL, '--repo', repo, '--color', 'fbca04', '--description', 'An idea for the plugin, filed with /shipyard:idea'], { timeoutMs: GH_TIMEOUT_MS });
    r = await create(true);
    // Someone without rights to add labels can still open an issue: file it plain rather than lose it.
    if (r.code !== 0 && labelMissing(r.stderr)) r = await create(false);
  }
  if (r.code === 0) {
    const url = r.stdout.split(/\s+/).find((w) => /^https:\/\/github\.com\/.+\/issues\/\d+$/.test(w));
    return { ok: true, url: url ?? r.stdout.trim() };
  }
  if (r.code === 127) return { ok: false, reason: 'The GitHub CLI (gh) is not installed.' };
  if (r.code === 124) return { ok: false, reason: 'GitHub did not answer in time.' };
  if (/auth login|not logged|authenticat/i.test(r.stderr)) return { ok: false, reason: 'The GitHub CLI (gh) is not signed in. Run `gh auth login` once.' };
  return { ok: false, reason: `GitHub refused the issue: ${r.stderr.trim().split('\n')[0] || 'no reason given'}` };
}

/** One saved entry: a readable heading plus the exact title and body as JSON, so --send-saved can file it unchanged. */
export function savedEntry({ title, body, date }) {
  return `${MARK}\n## ${date}: ${title}\n\n${body}\n<!-- ${JSON.stringify({ title, body }).replace(/>/g, '\\u003e')} -->\n\n`;
}

export function parseSaved(text) {
  return String(text).split(MARK).slice(1).map((chunk) => {
    const m = /<!-- (\{.*\}) -->\s*$/s.exec(chunk.trim());
    if (!m) return null;
    try {
      const { title, body } = JSON.parse(m[1]);
      return typeof title === 'string' && typeof body === 'string' ? { title, body, raw: `${MARK}${chunk}` } : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function repoFrom(args) {
  const repo = args.repo ?? process.env.SHIPYARD_IDEA_REPO ?? DEFAULT_REPO;
  if (!REPO_RE.test(repo)) throw new UsageError(`"${repo}" is not a GitHub repository. Use owner/name, for example ${DEFAULT_REPO}.`);
  return repo;
}

async function sendSaved(repo, run) {
  const file = path.join(HOME_DIR, IDEAS_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.ok('No saved ideas to send.');
      return { ok: true, sent: [], left: 0 };
    }
    throw err;
  }
  const entries = parseSaved(text);
  const sent = [];
  const kept = [];
  for (const entry of entries) {
    const r = await fileIssue({ repo, title: entry.title, body: entry.body }, run);
    if (r.ok) {
      sent.push(r.url);
      log.ok(`Filed: ${r.url}`);
    } else {
      kept.push(entry.raw);
      log.warn(`Still saved: ${entry.title} (${r.reason})`);
    }
  }
  await writeFile(file, kept.join(''));
  if (!entries.length) log.ok('No saved ideas to send.');
  return { ok: kept.length === 0, sent, left: kept.length };
}

export async function main(args, { run = realRun, now = new Date() } = {}) {
  const repo = repoFrom(args);
  if (args['send-saved']) return sendSaved(repo, run);

  const text = args._.join(' ').trim();
  if (!text) throw new UsageError('Give the idea, for example: node idea.mjs "Let the design skill import a Figma link"');
  const dir = path.resolve(args.dir ?? process.cwd());
  const date = now.toISOString().slice(0, 10);
  const source = await sourceOf(dir, run);
  const title = ideaTitle(text);
  const body = ideaBody({ text, context: args.context, source, date });

  const filed = await fileIssue({ repo, title, body }, run);
  if (filed.ok) {
    log.ok(`Idea filed: ${filed.url}`);
    return { ok: true, filed: true, url: filed.url, title };
  }

  await ensureHomeDir();
  const file = path.join(HOME_DIR, IDEAS_FILE);
  await appendFile(file, savedEntry({ title, body, date }));
  log.warn(`Not filed on GitHub. ${filed.reason}`);
  log.ok(`Saved to ${file}. Send it later with: node "${fileURLToPath(import.meta.url)}" --send-saved`);
  // Saved safely counts as success: the idea is not lost, and the session carries on.
  return { ok: true, filed: false, saved: file, reason: filed.reason, title };
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: { string: ['context', 'dir', 'repo'], boolean: ['send-saved'] }, help: HELP, main: (args) => main(args) });
}
