import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { check, unlabeledControls, lockDrift } from '../scripts/verify/hygiene.mjs';
import { judge } from '../scripts/verify/lighthouse.mjs';
import { CHECK_NAMES, OPTIONAL_CHECKS } from '../scripts/verify/index.mjs';
import { tempDir, removeDir, makeAppFromTemplate } from './verify-helpers.mjs';

async function app(t) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  return dir;
}
const run = (dir) => check({ appDir: dir, url: null, app: null, secrets: new Map() });

test('hygiene runs by default, lighthouse only when asked', () => {
  assert.ok(CHECK_NAMES.includes('hygiene'));
  assert.ok(!CHECK_NAMES.includes('lighthouse'));
  assert.ok(OPTIONAL_CHECKS.includes('lighthouse'));
});

test('the real template passes hygiene', async (t) => {
  const r = await run(await app(t));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a logo link whose text is hidden on phones has no name', () => {
  const src = '<Link href="/" className="flex"><AppMark size={32} /><span className="max-[430px]:hidden">{BRAND.name}</span></Link>';
  assert.equal(unlabeledControls(src).length, 1);
  assert.equal(unlabeledControls(src.replace('<Link href="/"', '<Link href="/" aria-label="Home"')).length, 0);
});

test('visible text, sr-only text and aria-label all count as names', () => {
  assert.equal(unlabeledControls('<a href="/x">Help</a>').length, 0);
  assert.equal(unlabeledControls('<button><Icon /><span className="sr-only">Close</span></button>').length, 0);
  assert.equal(unlabeledControls('<button onClick={f}><XIcon /></button>').length, 1);
  assert.equal(unlabeledControls('<button aria-label="Close" onClick={f}><XIcon /></button>').length, 0);
});

test('lock file drift is reported', () => {
  const pkg = { dependencies: { next: '16.0.0' }, devDependencies: {} };
  assert.deepEqual(lockDrift(pkg, { packages: { '': { dependencies: { next: '16.0.0' } } } }), []);
  assert.equal(lockDrift(pkg, { packages: { '': { dependencies: { next: '15.0.0' } } } }).length, 1);
});

test('fails on a missing local action and an env-crashing sign-in route', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github/workflows/test.yml'), 'jobs:\n  t:\n    steps:\n      - uses: ./.github/actions/setup\n');
  await mkdir(path.join(dir, 'src/app/api/auth/me'), { recursive: true });
  await writeFile(path.join(dir, 'src/app/api/auth/me/route.ts'), 'export async function GET() { const u = process.env.NEXT_PUBLIC_SUPABASE_URL!; return Response.json({ u }); }\n');
  const r = await run(dir);
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /\.\/\.github\/actions\/setup/);
  assert.match(text, /api\/auth\/me\/route\.ts/);
});

test('a private marker is a warning, not a failure', async (t) => {
  const dir = await app(t);
  await writeFile(path.join(dir, '.6x7-private'), '');
  const r = await run(dir);
  assert.equal(r.ok, true);
  assert.match(r.warnings.join('\n'), /noindex/);
});

test('workspace packages built from dist must be built before tests', async (t) => {
  const dir = await app(t);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['packages/*'] }));
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github/workflows/test.yml'), 'jobs:\n  t:\n    steps:\n      - run: npm install\n      - run: npm test\n');
  await mkdir(path.join(dir, 'packages/core'), { recursive: true });
  await writeFile(path.join(dir, 'packages/core/package.json'), JSON.stringify({ name: '@x/core', main: 'dist/index.js', scripts: { build: 'tsc' } }));
  const r = await run(dir);
  assert.match(r.problems.join('\n'), /@x\/core/);
});

test('lighthouse budgets name the failing audits; SEO ignored for private apps', () => {
  const report = {
    categories: {
      performance: { score: 0.95, auditRefs: [] },
      accessibility: { score: 0.9, auditRefs: [{ id: 'link-name', weight: 7 }, { id: 'color-contrast', weight: 7 }] },
      'best-practices': { score: 1, auditRefs: [] },
      seo: { score: 0.6, auditRefs: [{ id: 'is-crawlable', weight: 1 }] },
    },
    audits: { 'link-name': { id: 'link-name', score: 0 }, 'color-contrast': { id: 'color-contrast', score: 1 }, 'is-crawlable': { id: 'is-crawlable', score: 0 } },
  };
  const pub = judge(report, { label: '/ mobile' });
  assert.equal(pub.problems.length, 2);
  assert.match(pub.problems[0], /accessibility 90 .*link-name/);
  assert.doesNotMatch(pub.problems[0], /color-contrast/);
  assert.equal(judge(report, { label: '/', privateApp: true }).problems.length, 1);
});
