import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, rootAllowed, decodeEntities, jsonLdNodes, auditChecks, audit, mentions, baseline, summaryMarkdown, main, AI_CRAWLERS } from '../scripts/ai-visibility.mjs';

const DESC = 'A free idea notebook for developers that turns GitHub repos into projects and sorts notes-to-self.';
const goodHome = `<html><head><meta name="description" content="${DESC}"/><meta property="og:description" content="${DESC}"/>
<meta property="og:image" content="https://prod.example/og-image.png"/>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"#org"}]}</script>
<script type="application/ld+json">{"@type":["SoftwareApplication","WebApplication"],"name":"Demo","description":"${DESC}","offers":{"price":"0"}}</script>
</head></html>`;
const robotsOk = `User-Agent: *\nAllow: /\nDisallow: /api/\n\n${AI_CRAWLERS.map((a) => `User-Agent: ${a}`).join('\n')}\nAllow: /\n`;
const page = (status, body = '', type = 'text/plain') => ({ status, body, type });

test('parseRobots groups consecutive user-agents and rootAllowed falls back to *', () => {
  const g = parseRobots('User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nDisallow: /api/');
  assert.equal(rootAllowed(g, 'GPTBot'), false);
  assert.equal(rootAllowed(g, 'ccbot'), false);
  assert.equal(rootAllowed(g, 'ClaudeBot'), true);
});

test('jsonLdNodes flattens @graph and skips invalid JSON', () => {
  const nodes = jsonLdNodes(`${goodHome}<script type="application/ld+json">{bad</script>`);
  assert.equal(nodes.length, 2);
});

test('auditChecks passes a complete site', () => {
  const checks = auditChecks({ home: page(200, goodHome), llms: page(200, '# Demo\n\n> Demo is x.'), llmsFull: page(200, '# Demo\n\n> Demo is x.\n\nMore detail here.'), robots: page(200, robotsOk), sitemapOk: true, ogImageType: 'image/png' });
  assert.deepEqual(checks.filter((c) => !c.pass).map((c) => c.id), []);
});

test('auditChecks flags each gap', () => {
  const home = goodHome.replace('og:description" content="', 'og:description" content="other ').replace(',"WebApplication"', '');
  const checks = auditChecks({ home: page(200, home), llms: page(404), llmsFull: page(307), robots: page(200, 'User-agent: GPTBot\nDisallow: /'), sitemapOk: false, ogImageType: 'image/svg+xml' });
  assert.deepEqual(checks.filter((c) => !c.pass).map((c) => c.id), ['llms.txt', 'llms-full.txt', 'json-ld', 'description', 'og-image', 'robots-ai', 'sitemap']);
});

test('audit fetches the OG image path from the audited host', async () => {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    const p = new URL(url).pathname;
    const body = p === '/' ? goodHome : p === '/robots.txt' ? robotsOk : '# Demo\n\n> x';
    return { status: 200, headers: new Map([['content-type', p.endsWith('.png') ? 'image/png' : 'text/html']]), text: async () => body };
  };
  const checks = await audit('http://localhost:3000', f);
  assert.ok(seen.includes('http://localhost:3000/og-image.png'));
  assert.equal(checks.find((c) => c.id === 'og-image').pass, true);
});

test('mentions matches whole words or the host pattern', () => {
  assert.equal(mentions('Try Sparks for this', 'Sparks', 'sparks\\.6x7\\.gr'), true);
  assert.equal(mentions('it sparkles', 'Sparks'), false);
  assert.equal(mentions('quick sparks you capture on the go', 'Sparks'), false);
  assert.equal(mentions('total recall of your chats', 'Recall', 'recall\\.6x7\\.gr'), false);
  assert.equal(mentions('see HTTPS://RECALL.6X7.GR', 'Recall', 'recall\\.6x7\\.gr'), true);
  assert.equal(mentions('see https://sparks.6x7.gr', 'Nope', 'sparks\\.6x7\\.gr'), true);
});

test('baseline records mentions and errors, and the summary counts only valid answers', async () => {
  const f = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === 'bad/model') return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ choices: [{ message: { content: model === 'a/yes' ? 'Use Demo.' : 'Use Notion.' } }] }) };
  };
  const results = await baseline({ name: 'Demo', url: 'https://demo.example', queries: ['q1'], models: ['a/yes', 'b/no', 'bad/model'], key: 'k', f });
  assert.deepEqual(results.map((r) => [r.model, r.mentioned, Boolean(r.error)]), [['a/yes', true, false], ['b/no', false, false], ['bad/model', false, true]]);
  const md = summaryMarkdown({ name: 'Demo', date: '2026-01-01', models: ['a/yes', 'b/no', 'bad/model'], queries: ['q1'], results });
  assert.match(md, /\*\*1\/2 valid answers name Demo\.\*\*/);
  assert.match(md, /\| bad\/model \| E \|/);
});

test('main: bad usage and missing key', async () => {
  await assert.rejects(main(['nope']), /audit or baseline/);
  await assert.rejects(main(['baseline', 'https://x.example']), /--name and --queries/);
  const code = await main(['baseline', 'https://x.example', '--name', 'X', '--queries', 'q.json', '--json'], { readFile: async () => '["q"]', readSecrets: async () => new Map(), noWrite: true });
  assert.equal(code, 1);
});

test('rootAllowed honours an allowlist (Allow: /$ beats Disallow: /) and decodeEntities unescapes meta', () => {
  const g = parseRobots('User-agent: GPTBot\nAllow: /$\nDisallow: /\n\nUser-agent: *\nDisallow: /\nAllow: /\n');
  assert.equal(rootAllowed(g, 'GPTBot'), true);
  assert.equal(rootAllowed(g, 'CCBot'), true);
  assert.equal(rootAllowed(parseRobots('User-agent: *\nAllow: /help\nDisallow: /'), 'GPTBot'), false);
  assert.equal(decodeEntities('a business&#x27;s &amp; &quot;x&quot; &#39;y&#39;'), 'a business\'s & "x" \'y\'');
});
