#!/usr/bin/env node
// AI visibility for a live app: `audit` checks what crawlers and AI answer engines can read
// (llms.txt, llms-full.txt, JSON-LD, description, OG image, robots rules); `baseline` asks several
// models through OpenRouter whether they recommend the app. Never prints a key.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readSecrets } from './lib/secrets.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

export const DEFAULT_MODELS = [
  'openai/gpt-5.5', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'x-ai/grok-4.3',
  'perplexity/sonar', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-max-0902', 'moonshotai/kimi-k3',
];

const HELP = `Usage:
  ai-visibility.mjs audit <https://app.example> [--json]
  ai-visibility.mjs baseline <https://app.example> --name <App> --queries <file.json> [options]

audit     fetches the live site and checks llms.txt, llms-full.txt, JSON-LD
          (SoftwareApplication + WebApplication), one consistent description, a PNG/JPG
          OG image, robots.txt rules for AI crawlers and the sitemap. Exit 0 = all pass, 1 = gaps.
baseline  asks each model every query (a JSON array of strings) and records whether the
          answer names the app. Writes <out>/baseline-<date>.json and .md.
  --name <App>        the app name to look for (required for baseline)
  --match <regex>     extra pattern that counts as a mention (default: the URL's host)
  --models a,b,c      OpenRouter model ids (default: ${DEFAULT_MODELS.join(',')})
  --out <dir>         where to write results (default: ./ai-visibility)
  --json              machine-readable output
Uses OPENROUTER_API_KEY from ~/.shipyard/secrets.env. Exit 2 = bad usage.
`;


export const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot',
];

/** robots.txt text -> Map(lowercased agent -> list of Disallow paths). Groups share rules. */
export function parseRobots(text) {
  const groups = new Map();
  let agents = [];
  let inRules = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const k = key.toLowerCase();
    if (k === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
    } else if (k === 'disallow' || k === 'allow') {
      inRules = true;
      if (k === 'disallow') for (const a of agents) groups.get(a).push(value);
    }
  }
  return groups;
}

/** True when the agent may fetch "/" (its own group, else the * group). */
export function rootAllowed(groups, agent) {
  const rules = groups.get(agent.toLowerCase()) ?? groups.get('*') ?? [];
  return !rules.includes('/');
}

/** All JSON-LD nodes in an HTML page, flattened through @graph. Bad JSON is skipped. */
export function jsonLdNodes(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      for (const d of [data].flat()) out.push(...(d['@graph'] ?? [d]));
    } catch { /* not valid JSON-LD */ }
  }
  return out;
}

const types = (node) => [node['@type']].flat();
export const meta = (html, attr, name) =>
  new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`).exec(html)?.[1]
  ?? new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`).exec(html)?.[1];

/** Pure checks over fetched pages. Each result: { id, pass, detail }. */
export function auditChecks({ home, llms, llmsFull, robots, sitemapOk, ogImageType }) {
  const nodes = jsonLdNodes(home.body);
  const app = nodes.find((n) => types(n).includes('SoftwareApplication'));
  const desc = meta(home.body, 'name', 'description');
  const ogDesc = meta(home.body, 'property', 'og:description');
  const ogImage = meta(home.body, 'property', 'og:image');
  const groups = parseRobots(robots.status === 200 ? robots.body : '');
  const blocked = AI_CRAWLERS.filter((a) => !rootAllowed(groups, a));
  const named = AI_CRAWLERS.filter((a) => groups.has(a.toLowerCase()));
  const r = (id, pass, detail) => ({ id, pass: Boolean(pass), detail });
  return [
    r('llms.txt', llms.status === 200 && /^#\s/m.test(llms.body) && /^>\s/m.test(llms.body), `HTTP ${llms.status}; needs a "# Name" title and a "> summary" line`),
    r('llms-full.txt', llmsFull.status === 200 && llmsFull.body.length > (llms.body?.length ?? 0), `HTTP ${llmsFull.status}; should be longer than llms.txt`),
    r('json-ld', app && types(app).includes('WebApplication') && app.description && app.offers, app ? `types ${types(app).join('+')}` : 'no SoftwareApplication node'),
    r('description', desc && desc.length >= 80 && desc === ogDesc && (!app || app.description === desc), `meta ${desc?.length ?? 0} chars; must equal og:description and JSON-LD description`),
    r('og-image', ogImage && /image\/(png|jpe?g)/.test(ogImageType ?? ''), `${ogImage ?? 'none'} (${ogImageType ?? 'not fetched'})`),
    r('robots-ai', robots.status === 200 && blocked.length === 0 && named.length > 0, blocked.length ? `blocked: ${blocked.join(', ')}` : `named ${named.length}/${AI_CRAWLERS.length} AI crawlers`),
    r('sitemap', sitemapOk, sitemapOk ? 'sitemap.xml found' : 'no sitemap.xml'),
  ];
}

async function get(url, f) {
  try {
    const res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: res.status === 200 ? await res.text() : '' };
  } catch (e) {
    return { status: 0, type: '', body: '', error: e.message };
  }
}

export async function audit(base, f = fetch) {
  const u = (p) => new URL(p, base).toString();
  const [home, llms, llmsFull, robots, sitemap] = await Promise.all(
    ['/', '/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml'].map((p) => get(u(p), f)),
  );
  const og = meta(home.body, 'property', 'og:image');
  // Fetch the image path from the audited host, so a local or preview build checks its own file.
  const ogRes = og ? await get(u(new URL(og, base).pathname), f) : null;
  return auditChecks({ home, llms, llmsFull, robots, sitemapOk: sitemap.status === 200, ogImageType: ogRes?.type });
}

/** Does an answer name the app? Word match on the name, or the extra pattern (default: host). */
export function mentions(answer, name, match) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(answer) || (match ? new RegExp(match, 'i').test(answer) : false);
}

async function ask(key, model, query, f) {
  const res = await f('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // Reasoning models can spend the whole budget thinking; keep effort low and the budget roomy.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: query }], max_tokens: 6000, reasoning: { effort: 'low' } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content ?? '';
  return answer.trim() ? { answer } : { error: 'empty answer' };
}

export function summaryMarkdown({ name, date, models, queries, results }) {
  const cell = (m, q) => {
    const r = results.find((x) => x.model === m && x.query === q);
    return r.error ? 'E' : r.mentioned ? 'Y' : '–';
  };
  const valid = results.filter((r) => !r.error);
  return [
    `# ${name} AI-visibility baseline (${date})`, '',
    'Y = named, – = not named, E = error or empty. Plain model knowledge, no web search unless the model searches by itself.', '',
    ...queries.map((q, i) => `- Q${i + 1}: ${q}`), '',
    `| Model | ${queries.map((_, i) => `Q${i + 1}`).join(' | ')} |`,
    `|---|${queries.map(() => '---').join('|')}|`,
    ...models.map((m) => `| ${m} | ${queries.map((q) => cell(m, q)).join(' | ')} |`), '',
    `**${valid.filter((r) => r.mentioned).length}/${valid.length} valid answers name ${name}.**`, '',
  ].join('\n');
}

export async function baseline({ name, url, match, queries, models, key, f = fetch, concurrency = 8 }) {
  const jobs = models.flatMap((model) => queries.map((query) => ({ model, query })));
  const results = new Array(jobs.length);
  let next = 0;
  const pattern = match ?? new URL(url).host.replace(/\./g, '\\.');
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      const { model, query } = jobs[i];
      const r = await ask(key, model, query, f).catch((e) => ({ error: e.message }));
      results[i] = { model, query, ...r, mentioned: r.answer ? mentions(r.answer, name, pattern) : false };
    }
  }));
  return results;
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv, { boolean: ['json', 'help'], string: ['name', 'match', 'models', 'queries', 'out'], alias: { h: 'help' } });
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.json) setQuiet(true);
  const [cmd, url] = args._;
  if (!['audit', 'baseline'].includes(cmd) || !/^https?:\/\//.test(url ?? '')) throw new UsageError('Give audit or baseline and the site address. Run with --help for details.');
  const f = deps.fetch ?? fetch;

  if (cmd === 'audit') {
    const checks = await audit(url, f);
    if (args.json) json({ ok: checks.every((c) => c.pass), checks });
    else for (const c of checks) (c.pass ? ok : fail)(`${c.id}: ${c.detail}`);
    return checks.every((c) => c.pass) ? 0 : 1;
  }

  if (!args.name || !args.queries) throw new UsageError('baseline needs --name and --queries <file.json>.');
  const queries = JSON.parse(await (deps.readFile ?? readFile)(args.queries, 'utf8'));
  if (!Array.isArray(queries) || !queries.every((q) => typeof q === 'string')) throw new UsageError('--queries must be a JSON array of strings.');
  const key = (await (deps.readSecrets ?? readSecrets)()).get('OPENROUTER_API_KEY');
  if (!key) { fail('OPENROUTER_API_KEY is missing from your Shipyard keys file. Add it with secrets-init.mjs.'); return 1; }
  const models = args.models ? args.models.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  const results = await baseline({ name: args.name, url, match: args.match, queries, models, key, f });
  const date = new Date().toISOString().slice(0, 10);
  const out = args.out || 'ai-visibility';
  if (!deps.noWrite) {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, `baseline-${date}.json`), `${JSON.stringify({ name: args.name, url, date, models, queries, results }, null, 1)}\n`);
    await writeFile(path.join(out, `baseline-${date}.md`), summaryMarkdown({ name: args.name, date, models, queries, results }));
  }
  const valid = results.filter((r) => !r.error);
  const hits = valid.filter((r) => r.mentioned).length;
  if (args.json) json({ ok: true, mentioned: hits, valid: valid.length, total: results.length, out });
  else {
    (hits ? ok : warn)(`${hits}/${valid.length} valid answers name ${args.name}.`);
    if (valid.length < results.length) info(`${results.length - valid.length} answers failed or came back empty (see the JSON).`);
    info(`Saved to ${out}/baseline-${date}.json and .md`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.message}\n`); process.exitCode = err instanceof UsageError ? 2 : 1; },
  );
}
