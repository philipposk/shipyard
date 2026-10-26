import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { check, unlabeledControls, lockDrift, zoomLock, darkAccentText, eagerClients, vercelApiFunctions, extensionlessImports } from '../scripts/verify/hygiene.mjs';
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

test('a fake tablist fails; a non-composited keyframe and missing CSP are warnings', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src/components'), { recursive: true });
  await writeFile(path.join(dir, 'src/components/Modes.tsx'), '<div role="tablist"><button aria-pressed="true">A</button></div>\n');
  await writeFile(path.join(dir, 'src/glow.css'), '@keyframes pulse { from { border-color: red; } to { border-color: blue; } }\n');
  await writeFile(path.join(dir, 'next.config.ts'), 'export default { headers: [] };\n');
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /tablist/);
  const w = r.warnings.join('\n');
  assert.match(w, /pulse animates border-color/);
  assert.match(w, /script-src/);
});

test('zoom lock is detected in Next viewport and plain HTML', () => {
  assert.equal(zoomLock('export const viewport = { width: "device-width", initialScale: 1, maximumScale: 1 };'), true);
  assert.equal(zoomLock('<meta name="viewport" content="width=device-width, user-scalable=no">'), true);
  assert.equal(zoomLock('export const viewport = { width: "device-width", initialScale: 1 };'), false);
  assert.equal(zoomLock('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">'), false);
});

test('accent used as text fails only when unreadable on the dark background', () => {
  const base = ':root { --accent: #5C6B4A; --bg: #FAF8F4; }\n[data-theme="dark"] { --bg: #15140F; }\n.link { color: var(--accent); }\n';
  const r = darkAccentText(base);
  assert.equal(r.length, 1);
  assert.equal(r[0].token, 'accent');
  assert.equal(darkAccentText(base.replace('--bg: #15140F;', '--bg: #15140F; --accent: #b8c79f;')).length, 0);
  assert.equal(darkAccentText(base.replace('color: var(--accent)', 'border-color: var(--accent)')).length, 0);
});

test('fails on locked zoom, missing description and an SPA rewrite without robots.txt', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src/app'), { recursive: true });
  await writeFile(path.join(dir, 'src/app/layout.tsx'), 'export const metadata = { title: "x", description: "y" };\nexport const viewport = { width: "device-width", maximumScale: 1 };\n');
  await writeFile(path.join(dir, 'vercel.json'), JSON.stringify({ rewrites: [{ source: '/(.*)', destination: '/index.html' }] }));
  await mkdir(path.join(dir, 'client'), { recursive: true });
  await writeFile(path.join(dir, 'client/index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  const r = await run(dir);
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /pinch-zoom/);
  assert.match(text, /robots\.txt/);
  assert.match(text, /client\/index\.html has no <meta name="description">/);
});

test('search and launch warnings: robots, sitemap, noindex, shared cookie, image log', async (t) => {
  const dir = await app(t);
  const { rm } = await import('node:fs/promises');
  await rm(path.join(dir, 'src/app/robots.ts'), { force: true });
  await rm(path.join(dir, 'src/app/sitemap.ts'), { force: true });
  await mkdir(path.join(dir, 'src/app/admin'), { recursive: true });
  await mkdir(path.join(dir, 'public'), { recursive: true });
  await writeFile(path.join(dir, 'src/app/page.tsx'), 'export const metadata = { robots: { index: false } };\nexport default function P() { return <h1>Home</h1>; }\n');
  await writeFile(path.join(dir, 'src/app/admin/page.tsx'), 'export const metadata = { robots: { index: false } };\nexport default function P() { return <h1>Admin</h1>; }\n');
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ shared: true }));
  await writeFile(path.join(dir, 'public/team-photo.jpg'), 'x');
  const r = await run(dir);
  const w = (r.warnings ?? []).join('\n');
  assert.match(w, /No robots/);
  assert.match(w, /No sitemap/);
  assert.match(w, /src\/app\/page\.tsx hard-codes noindex/);
  assert.doesNotMatch(w, /admin\/page\.tsx hard-codes noindex/);
  assert.match(w, /auth cookie has no domain/);
  assert.match(w, /IMAGE-SOURCES\.md/);
  await writeFile(path.join(dir, 'IMAGE-SOURCES.md'), '| file | source |\n');
  assert.doesNotMatch(((await run(dir)).warnings ?? []).join('\n'), /IMAGE-SOURCES/);
});

test('the full template raises none of the search and launch warnings', async () => {
  const tpl = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'template');
  const w = ((await run(tpl)).warnings ?? []).join('\n');
  assert.doesNotMatch(w, /No robots|No sitemap|metadataBase or canonical|hard-codes noindex|auth cookie has no domain|IMAGE-SOURCES/);
});

test('adding robots and sitemap clears their warnings', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src/app'), { recursive: true });
  assert.match(((await run(dir)).warnings ?? []).join('\n'), /No robots[\s\S]*No sitemap|No sitemap[\s\S]*No robots/);
  await writeFile(path.join(dir, 'src/app/robots.ts'), 'export default function r() { return {}; }\n');
  await writeFile(path.join(dir, 'src/app/sitemap.ts'), 'export default function s() { return []; }\n');
  assert.doesNotMatch(((await run(dir)).warnings ?? []).join('\n'), /No robots|No sitemap/);
});

test('eagerClients flags SDK clients built at the top of a file only', () => {
  assert.deepEqual(eagerClients("import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n").map((e) => e.what), ['Stripe']);
  assert.equal(eagerClients("const db = createClient(process.env.URL!, process.env.KEY!);").length, 1);
  assert.equal(eagerClients("const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);").length, 0);
  assert.equal(eagerClients("let c;\nexport function get() { if (!c) c = new Stripe(key); return c; }\n").length, 0);
  assert.equal(eagerClients("export async function POST() { const ai = new OpenAI({ apiKey: process.env.K }); }").length, 0);
  assert.equal(eagerClients("// const s = new Stripe(k);\n").length, 0);
});

test('vercelApiFunctions skips helpers under _ and test files', () => {
  assert.deepEqual(vercelApiFunctions(['search.ts', 'lib/db.ts', '_lib/db.ts', 'users/_shared.ts', 'users/[id].ts', 'search.test.ts', 'README.md']), ['search.ts', 'lib/db.ts', 'users/[id].ts']);
});

test('extensionlessImports finds relative imports Node ESM cannot resolve', () => {
  const src = "import a from './_lib/db';\nimport b from './_lib/ok.js';\nimport x from 'zod';\nexport { y } from '../util';\nconst z = await import('./lazy');\nimport './side';\nimport type { T } from './types';\n";
  assert.deepEqual(extensionlessImports(src), ['./_lib/db', '../util', './lazy', './side']);
});

test('warns on top-level SDK clients, too many api/ functions and extensionless ESM imports', async (t) => {
  const dir = await app(t);
  await mkdir(path.join(dir, 'src/app/api/pay'), { recursive: true });
  await writeFile(path.join(dir, 'src/app/api/pay/route.ts'), "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nexport async function POST() { return Response.json({}); }\n");
  await mkdir(path.join(dir, 'api/lib'), { recursive: true });
  for (let i = 0; i < 12; i++) await writeFile(path.join(dir, `api/fn${i}.ts`), "import { db } from './lib/db';\nexport default function h() { return db; }\n");
  await writeFile(path.join(dir, 'api/lib/db.ts'), 'export const db = 1;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
  const w = ((await run(dir)).warnings ?? []).join('\n');
  assert.match(w, /src\/app\/api\/pay\/route\.ts:2 builds a Stripe client/);
  assert.match(w, /api\/ has 13 files Vercel deploys as functions/);
  assert.match(w, /12 file\(s\) in api\/ import relative paths with no extension: api\/fn0\.ts \(\.\/lib\/db\)/);
});

test('the full template builds no SDK client at the top of a file', async () => {
  const tpl = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'template');
  assert.doesNotMatch(((await run(tpl)).warnings ?? []).join('\n'), /client at the top of the file|deploys as functions|with no extension/);
});
