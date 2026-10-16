import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { check } from '../scripts/verify/design.mjs';
import { CHECK_NAMES } from '../scripts/verify/index.mjs';
import { run } from '../scripts/lib/run.mjs';
import { tempDir, removeDir, makeAppFromTemplate, TEMPLATE } from './verify-helpers.mjs';

const ctxFor = (dir) => ({ appDir: dir, url: null, app: null, secrets: new Map() });

async function app(t) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  return dir;
}

test('design is registered, before the checks that need a web address', () => {
  assert.ok(CHECK_NAMES.includes('design'));
  assert.ok(CHECK_NAMES.indexOf('design') < CHECK_NAMES.indexOf('routes'));
});

test('a clean app passes and says how many files were checked', async (t) => {
  const dir = await app(t);
  const r = await check(ctxFor(dir));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!r.skipped);
  assert.match(r.details.join('\n'), /checked \d+ source files/);
});

test('a hard-coded colour fails with file, line and plain words', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'app', 'page.tsx'), 'export default function P() {\n  return <p style={{ color: "#ff0000" }}>Hi</p>;\n}\n');
  const r = await check(ctxFor(dir));
  assert.equal(r.ok, false);
  assert.match(r.summary, /1 design-rule problem$/);
  assert.match(r.problems[0], /^src\/app\/page\.tsx:2 a colour typed in directly: use a token/);
  assert.ok(!JSON.stringify(r).includes('#ff0000'));
});

test('a long list of problems is cut short and points to npm run check:design', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
  const lines = Array.from({ length: 20 }, (_, i) => `export const a${i} = <p>Feature ${i % 9 + 1}</p>;`);
  await writeFile(path.join(dir, 'src', 'app', 'many.tsx'), `${lines.join('\n')}\n`);
  const r = await check(ctxFor(dir));
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 16);
  assert.match(r.problems[15], /^\.\.\.and 5 more .*npm run check:design/);
});

test('an app without the script is skipped with the reason, not failed', async (t) => {
  const dir = await app(t);
  await rm(path.join(dir, 'scripts', 'design-check.mjs'));
  const r = await check(ctxFor(dir));
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true);
  assert.match(r.reason, /no scripts\/design-check\.mjs/);
});

test('a folder without src fails with a plain message', async (t) => {
  const dir = await app(t);
  await rm(path.join(dir, 'src'), { recursive: true });
  const r = await check(ctxFor(dir));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /src folder/);
});

test('the real template passes the plugin check', async () => {
  const r = await check(ctxFor(TEMPLATE));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('verify.mjs --only design runs just this check', async (t) => {
  const dir = await app(t);
  const home = await tempDir('shipyard-verify-home-');
  t.after(() => removeDir(home));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify.mjs');
  const r = await run(process.execPath, [script, dir, '--only', 'design', '--json'], { env: { SHIPYARD_HOME: home }, timeoutMs: 60_000 });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.checks.map((c) => c.name), ['design']);
  assert.equal(result.checks[0].ok, true);
});
