// hygiene's CI checks from the full-review lessons: CI must type-check (next build type-checks tests that
// node --test does not), and no script may call next lint on Next 16.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { check, ciTypeCheck, nextLintScripts, runCommands } from '../scripts/verify/hygiene.mjs';
import { tempDir, removeDir, makeAppFromTemplate, TEMPLATE } from './verify-helpers.mjs';

async function app(t) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  await makeAppFromTemplate(dir);
  for (const rel of ['package.json', 'tsconfig.json', '.github/workflows/test.yml']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), (await readFile(path.join(TEMPLATE, rel), 'utf8')).replaceAll('<APP_SLUG>', 'fake-planner'));
  }
  return dir;
}
const run = (dir) => check({ appDir: dir, url: null, app: null, secrets: new Map() });
const edit = async (dir, rel, fn) => writeFile(path.join(dir, rel), fn(await readFile(path.join(dir, rel), 'utf8')));

test('nextLintScripts: only next lint, only on Next 16 and later', () => {
  assert.deepEqual(nextLintScripts({ dependencies: { next: '^16.2.9' }, scripts: { lint: 'next lint --fix', build: 'next build', 'lint:css': 'stylelint .' } }), ['lint']);
  assert.deepEqual(nextLintScripts({ devDependencies: { next: '16.0.0' }, scripts: { check: 'npm test && next lint' } }), ['check']);
  assert.deepEqual(nextLintScripts({ dependencies: { next: '^15.3.0' }, scripts: { lint: 'next lint' } }), []);
  assert.deepEqual(nextLintScripts({ dependencies: { next: 'latest' }, scripts: { lint: 'next lint' } }), ['lint']);
  assert.deepEqual(nextLintScripts({ scripts: { lint: 'eslint .' } }), []);
  assert.deepEqual(nextLintScripts(null), []);
});

test('ciTypeCheck: a type check or a build anywhere counts; comments do not', () => {
  assert.deepEqual(ciTypeCheck(['run: npm ci\nrun: npm test']), { tests: true, typed: false });
  assert.deepEqual(ciTypeCheck(['run: npm run typecheck\nrun: npm test']), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['run: npx tsc --noEmit', 'run: node --test tests/']), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['run: npm test', 'run: npm run build']), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['run: npm test # tsc runs on Vercel']), { tests: true, typed: false });
  assert.deepEqual(ciTypeCheck(['run: npx lhci autorun']), { tests: false, typed: false });
  // npm test that type-checks through package.json counts too.
  assert.deepEqual(ciTypeCheck(['run: npm test'], { scripts: { pretest: 'tsc --noEmit', test: 'node --test' } }), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['run: npm test'], { scripts: { test: 'npm run typecheck && node --test' } }), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['run: node --test'], { scripts: { pretest: 'tsc --noEmit' } }), { tests: true, typed: false });
  // A step name is not a command, and npm runs pretest only for the exact test script.
  assert.deepEqual(ciTypeCheck(['      - name: Typecheck (tsc)\n        run: npm test']), { tests: true, typed: false });
  assert.deepEqual(ciTypeCheck(['run: npm run test:unit'], { scripts: { pretest: 'tsc --noEmit' } }), { tests: true, typed: false });
  assert.deepEqual(ciTypeCheck(['run: npm test -- --reporter dot'], { scripts: { pretest: 'tsc --noEmit' } }), { tests: true, typed: true });
  assert.deepEqual(ciTypeCheck(['      - run: |\n          npm ci\n          npx tsc --noEmit\n        name: x\n      - run: npm test']), { tests: true, typed: true });
});

test('runCommands reads one-line and block run steps, and nothing else', () => {
  const yml = `name: Tests # tsc
jobs:
  test:
    steps:
      - name: Typecheck with tsc
        run: npm run lint
      - run: "npm test"
      - name: Many
        run: |
          npm ci # install
          npm run build
        env:
          X: tsc
      - run: >-
          node --test
`;
  assert.deepEqual(runCommands(yml).map((c) => c.trim().replace(/\s+/g, ' ')), ['npm run lint', 'npm test', 'npm ci npm run build', 'node --test']);
});

test('the template CI and scripts pass the new checks', async (t) => {
  const dir = await app(t);
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const yml = await readFile(path.join(dir, '.github/workflows/test.yml'), 'utf8');
  assert.ok(yml.indexOf('npm run typecheck') < yml.indexOf('run: npm test'), 'the type check runs before the tests');
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /next lint/);
});

test('CI that runs tests with no type check and no build fails, with the reason', async (t) => {
  const dir = await app(t);
  await edit(dir, '.github/workflows/test.yml', (y) => y.replace(/ {6}- name: Typecheck[\s\S]*?run: npm run typecheck\n/, '').replace(/ {6}- name: Build[\s\S]*?run: npm run build\n/, ''));
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /CI runs the tests but never type-checks[\s\S]*npm run typecheck/);
});

test('a lint script that still calls next lint fails', async (t) => {
  const dir = await app(t);
  await edit(dir, 'package.json', (p) => p.replace('"lint": "eslint ."', '"lint": "next lint"'));
  const r = await run(dir);
  assert.match(r.problems.join('\n'), /script "lint" runs next lint, which Next 16 removed/);
});
