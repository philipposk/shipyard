// The template carries the full-review lessons: release checks, a knip setup that fits Next.js, the pull request
// size rule, and API answers that are always JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template');
const read = (rel) => readFileSync(path.join(TEMPLATE, rel), 'utf8');

test('knip.json is valid and every file it names exists', () => {
  const knip = JSON.parse(read('knip.json'));
  assert.match(knip.$schema, /knip@5/);
  for (const f of knip.ignore) assert.ok(existsSync(path.join(TEMPLATE, f)), f);
  for (const dep of knip.ignoreDependencies) assert.ok(dep in { ...JSON.parse(read('package.json')).devDependencies } || dep === 'postcss', dep);
  assert.deepEqual(knip.rules, { exports: 'warn', types: 'warn' });
  assert.match(JSON.parse(read('package.json')).scripts.knip, /knip@5/);
});

test('docs/RELEASE-CHECKS.md covers the checks before a pull request, after a deploy, and the live voice test', () => {
  const doc = read('docs/RELEASE-CHECKS.md');
  for (const re of [/npm run typecheck/, /next lint/, /placeholder/, /150 changed files/, /401 with JSON/, /## After every deploy/, /## Live voice test/, /voice-test\.mjs/]) assert.match(doc, re);
  assert.doesNotMatch(doc, /—/);
});

test('AGENTS.md keeps pull requests reviewable and repeats the API and AI rules', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /150 changed files or fewer/);
  assert.match(agents, /docs\/RELEASE-CHECKS\.md/);
  assert.match(agents, /Never change the build script, the deploy workflow or the hosting settings/);
  for (const re of [/Object\.hasOwn/, /allowlist the model ids/, /pagehide/, /never resets usage or quota counters/]) assert.match(agents, re);
});

test('the proxy answers API calls with JSON: 401 before any sign-in redirect, and 503 when the database is not set up', () => {
  const proxy = read('src/proxy.ts');
  const unauthorized = proxy.indexOf('NextResponse.json({ error: "Unauthorized" }, { status: 401 })');
  const redirect = proxy.indexOf('url.pathname = "/sign-in"');
  assert.ok(unauthorized > 0 && redirect > unauthorized, 'signed-out /api/* gets 401 JSON before the redirect branch');
  assert.match(proxy, /if \(pathname\.startsWith\("\/api\/"\)\) \{\n\s+return NextResponse\.json\(\{ error: "Service temporarily unavailable" \}, \{ status: 503 \}\);/);
});
