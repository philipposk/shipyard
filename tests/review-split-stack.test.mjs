// split-stack.mjs from the review skill: the pure helpers, and a real split of a small git repo where a fake
// type check fails while an import is missing. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aliasFromTsconfig, assignStages, compileStages, errorFiles, filesToPull, importsIn, pairLockFiles, parseNameStatus, resolveImport, testSiblings,
} from '../scripts/review/split-stack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'review', 'split-stack.mjs');

test('parseNameStatus reads git -z output, spaces and all', () => {
  const m = parseNameStatus('M\0src/a b.ts\0A\0src/new.ts\0D\0old.ts\0');
  assert.deepEqual([...m], [['src/a b.ts', 'M'], ['src/new.ts', 'A'], ['old.ts', 'D']]);
  assert.equal(parseNameStatus('').size, 0);
});

test('compileStages refuses bad stage files in plain words', () => {
  assert.throws(() => compileStages([]), /must be a list/);
  assert.throws(() => compileStages({}), /must be a list/);
  assert.throws(() => compileStages([{ name: 'a b', match: '.*' }]), /Stage 1 needs a "name"/);
  assert.throws(() => compileStages([{ name: 'a', match: '.*' }, { name: 'a', match: '.*' }]), /Two stages are called "a"/);
  assert.throws(() => compileStages([{ name: 'a', match: '(' }]), /not a valid pattern/);
  const stages = compileStages([{ name: '1-auth', match: '^src/lib/auth/' }, { name: '2-rest', match: '.*' }]);
  const { stageOf, unmatched } = assignStages(['src/lib/auth/x.ts', 'README.md'], stages);
  assert.deepEqual([...stageOf], [['src/lib/auth/x.ts', '1-auth'], ['README.md', '2-rest']]);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(assignStages(['a.ts'], compileStages([{ name: 'x', match: '^b' }])).unmatched, ['a.ts']);
});

test('importsIn finds every import form', () => {
  const src = `import a from "./a";\nimport { b } from '@/lib/b';\nexport { c } from "./c";\nimport "./side.css";\nconst d = await import("./d");\nconst e = require('./e');\nimport type { F } from "./f";`;
  assert.deepEqual(importsIn(src), ['./a', '@/lib/b', './c', './side.css', './d', './e', './f']);
});

test('aliasFromTsconfig reads paths, with comments, baseUrl and the root form', () => {
  const template = readFileSync(path.join(ROOT, 'template', 'tsconfig.json'), 'utf8');
  assert.deepEqual(aliasFromTsconfig(template), { '@/': 'src/' });
  assert.deepEqual(aliasFromTsconfig('{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }'), { '@/': '' });
  assert.deepEqual(aliasFromTsconfig('{\n // note: "x"\n "compilerOptions": { /* a */ "baseUrl": "src", "paths": { "~/*": ["*"], "#lib/*": ["lib/*"], }, },\n}'), { '~/': 'src/', '#lib/': 'src/lib/' });
  assert.deepEqual(aliasFromTsconfig('{ "compilerOptions": { "paths": { "x": ["y"] } } }'), {});
  assert.deepEqual(aliasFromTsconfig('not json'), {});
});

test('resolveImport finds the changed file an import means, and ignores packages', () => {
  const known = new Set(['src/lib/b.ts', 'src/lib/c/index.tsx', 'src/app/page.tsx', 'src/lib/e.ts', 'src/lib/util.mjs']);
  const alias = { '@/': 'src/' };
  assert.equal(resolveImport('src/app/page.tsx', '@/lib/b', known, alias), 'src/lib/b.ts');
  assert.equal(resolveImport('src/app/page.tsx', '@/lib/c', known, alias), 'src/lib/c/index.tsx');
  assert.equal(resolveImport('src/lib/b.ts', './e.js', known, alias), 'src/lib/e.ts');
  assert.equal(resolveImport('src/lib/b.ts', './util.mjs', known, alias), 'src/lib/util.mjs');
  assert.equal(resolveImport('src/app/x/y.ts', '../page', known, alias), 'src/app/page.tsx');
  assert.equal(resolveImport('src/lib/b.ts', 'next/server', known, alias), null);
  assert.equal(resolveImport('src/lib/b.ts', './unchanged', known, alias), null);
});

test('errorFiles reads plain and pretty tsc output', () => {
  const plain = "src/a.ts(3,7): error TS2304: Cannot find name 'x'.\nsrc\\b c.ts(1,1): error TS2307: nope\n  src/a.ts(9,1): note";
  assert.deepEqual(errorFiles(plain).sort(), ['src/a.ts', 'src/b c.ts']);
  const pretty = '\x1b[96msrc/d.tsx\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m2\x1b[0m - \x1b[91merror\x1b[0m TS2322: bad';
  assert.deepEqual(errorFiles(pretty), ['src/d.tsx']);
  assert.deepEqual(errorFiles('Found 0 errors.'), []);
  // Next.js route groups and dynamic folders keep their brackets.
  assert.deepEqual(errorFiles('src/app/(marketing)/page.tsx(3,5): error TS2304: x\nsrc/app/[id]/(x)/a.ts(1,1): error TS1: y'), ['src/app/(marketing)/page.tsx', 'src/app/[id]/(x)/a.ts']);
  assert.deepEqual(errorFiles('src/app/(app)/b.tsx:2:3 - error TS2322: bad'), ['src/app/(app)/b.tsx']);
});

test('pairLockFiles keeps each lock file with its package.json, in the earlier stage', () => {
  const stageOf = new Map([['package.json', '1'], ['package-lock.json', '3'], ['apps/web/package.json', '3'], ['apps/web/pnpm-lock.yaml', '2'], ['yarn.lock', '2'], ['src/a.ts', '3']]);
  const moved = pairLockFiles(stageOf, ['1', '2', '3']);
  assert.deepEqual(moved.sort(), ['apps/web/package.json', 'package-lock.json', 'yarn.lock']);
  assert.equal(stageOf.get('package-lock.json'), '1');
  assert.equal(stageOf.get('yarn.lock'), '1', 'a lock file moves to its package.json stage when that is earlier');
  assert.equal(stageOf.get('apps/web/package.json'), '2');
  assert.equal(stageOf.get('src/a.ts'), '3');
  assert.deepEqual(pairLockFiles(new Map([['package-lock.json', '2']]), ['1', '2']), [], 'no package.json change, nothing to pair');
});

test('testSiblings and filesToPull pull later files, their tests, and nothing earlier', () => {
  assert.deepEqual(testSiblings('src/a.ts'), ['src/a.test.ts', 'src/a.test.tsx', 'src/a.test.mjs', 'src/a.test.js']);
  assert.deepEqual(testSiblings('README.md'), []);
  const stageOf = new Map([['a.ts', '1'], ['b.ts', '2'], ['b.test.ts', '3'], ['c.ts', '2'], ['early.ts', '0']]);
  const imports = { 'a.ts': ['b.ts', 'early.ts'], 'other.ts': ['c.ts'] };
  const pull = filesToPull({ errFiles: ['a.ts', 'other.ts'], stageOf, order: ['0', '1', '2', '3'], current: '1', importsOf: (f) => imports[f] ?? [] });
  assert.deepEqual(pull.sort(), ['b.test.ts', 'b.ts', 'c.ts']);
});

// ---------- a real split ----------

const FAKE_CHECK = `// Fails like tsc when a relative import has no file.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
let bad = 0;
for (const f of readdirSync('.').filter((n) => n.endsWith('.ts'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/from '\\.\\/(\\w+)'/g)) {
    if (!existsSync(m[1] + '.ts')) { console.log(f + "(1,1): error TS2307: Cannot find module './" + m[1] + "'."); bad++; }
  }
}
process.exit(bad ? 1 : 0);
`;

function repo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ship split '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'check.mjs'), FAKE_CHECK);
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'gone.ts'), 'export const gone = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'big');
  writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  writeFileSync(path.join(dir, 'b.test.ts'), "import { b } from './b';\n");
  writeFileSync(path.join(dir, 'c.ts'), 'export const c = 3;\n');
  git('rm', '-q', 'gone.ts');
  git('add', '-A');
  git('commit', '-q', '-m', 'big change');
  git('checkout', '-q', 'main');
  const stages = path.join(dir, '..', `${path.basename(dir)}-stages.json`);
  writeFileSync(stages, JSON.stringify([{ name: '1-a', match: '^a\\.ts$' }, { name: '2-rest', match: '.*' }]));
  t.after(() => rmSync(stages, { force: true }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--from', 'big', '--base', 'main', '--stages', stages, '--check', `"${process.execPath}" check.mjs`, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { dir, git, run, stages };
}

test('a dry run shows the stages and changes nothing', (t) => {
  const { git, run } = repo(t);
  const r = run('--dry-run', '--json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.stages.map((s) => [s.name, s.count]), [['1-a', 1], ['2-rest', 4]]);
  assert.equal(git('branch', '--list', 'split/*').trim(), '');
});

test('each stage passes the check on its own; imports and their tests are pulled forward; the last stage is the big branch', (t) => {
  const { dir, git, run } = repo(t);
  const r = run('--json', '--test', `"${process.execPath}" check.mjs`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.identical, true);
  assert.deepEqual(out.stages.map((s) => s.branch), ['split/1-a', 'split/2-rest']);
  assert.deepEqual(out.stages[0].pulled.sort(), ['b.test.ts', 'b.ts']);
  assert.equal(out.stages[0].files, 3);
  assert.equal(out.stages[1].files, 2, 'c.ts added and gone.ts deleted');
  assert.deepEqual(git('diff', '--name-only', 'main', 'split/1-a').trim().split('\n').sort(), ['a.ts', 'b.test.ts', 'b.ts']);
  assert.equal(git('diff', 'big', 'split/2-rest'), '');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'split/2-rest');
  assert.equal(readFileSync(path.join(dir, 'c.ts'), 'utf8'), 'export const c = 3;\n');

  // Running again refuses to reset the stage branches unless asked.
  git('checkout', '-q', 'main');
  const again = run('--json');
  assert.equal(again.status, 1);
  assert.match(JSON.parse(again.stdout).error, /already exists/);
  assert.equal(run('--json', '--force').status, 0);
});

test('a stage over the file limit is flagged, and unsafe starts are refused', (t) => {
  const { dir, git, run, stages } = repo(t);
  const over = JSON.parse(run('--json', '--max-files', '2').stdout);
  assert.equal(over.ok, true);
  assert.deepEqual(over.stages.map((s) => s.over), [true, false]);

  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(JSON.parse(run('--json', '--prefix', 'other/').stdout).error, /uncommitted changes/);
  rmSync(path.join(dir, 'dirty.txt'));

  writeFileSync(stages, JSON.stringify([{ name: 'only-a', match: '^a\\.ts$' }]));
  assert.match(JSON.parse(run('--json', '--prefix', 'other/').stdout).error, /match no stage/);
  assert.equal(run('--max-files', 'lots').status, 2);
  const missing = spawnSync(process.execPath, [SCRIPT, '--stages', stages], { cwd: dir, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  const noBase = spawnSync(process.execPath, [SCRIPT, '--from', 'big', '--base', 'nope', '--stages', stages, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.match(JSON.parse(noBase.stdout).error, /nope is not a branch/);
});

test('a branch that is behind its base is refused', (t) => {
  const { dir, git, run } = repo(t);
  writeFileSync(path.join(dir, 'later.ts'), 'export const later = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'newer main');
  assert.match(JSON.parse(run('--json').stdout).error, /does not contain the latest main/);
});

test('--from HEAD means the big branch, even after stage branches are checked out', (t) => {
  const { git, stages, dir } = repo(t);
  git('checkout', '-q', 'big');
  const r = spawnSync(process.execPath, [SCRIPT, '--from', 'HEAD', '--base', 'main', '--stages', stages, '--check', `"${process.execPath}" check.mjs`, '--json'], { cwd: dir, encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.identical, true, r.stdout);
  assert.equal(out.stages[0].files, 3);
  assert.equal(git('diff', 'big', 'split/2-rest'), '');
  const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', 'split/1-a@{upstream}'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(upstream.status, 0, 'a stage branch tracks nothing, so a plain push cannot reach the base branch');
});

test('paths with [brackets] and (groups) are taken literally, and it works from a subfolder', (t) => {
  const { dir, git, stages } = repo(t);
  git('checkout', '-q', 'big');
  mkdirSync(path.join(dir, 'app', '[id]'), { recursive: true });
  mkdirSync(path.join(dir, 'app', 'i'), { recursive: true });
  writeFileSync(path.join(dir, 'app', '[id]', 'page.ts'), 'export const p = 1;\n');
  writeFileSync(path.join(dir, 'app', 'i', 'page.ts'), 'export const q = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'pages');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'big');
  git('checkout', '-q', 'big');
  git('rm', '-q', '--', ':(literal)app/[id]/page.ts');
  git('commit', '-q', '-m', 'drop the dynamic page');
  writeFileSync(stages, JSON.stringify([{ name: '1-app', match: '^app/' }, { name: '2-rest', match: '.*' }]));
  const sub = path.join(dir, 'app', 'i');
  const r = spawnSync(process.execPath, [SCRIPT, '--from', 'big', '--base', 'main', '--stages', stages, '--check', `"${process.execPath}" -e 0`, '--prefix', 'lit/', '--json'], { cwd: sub, encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.identical, true, r.stdout);
  assert.ok(existsSync(path.join(dir, 'app', 'i', 'page.ts')), 'app/i/page.ts was not taken for app/[id]/page.ts');
  assert.deepEqual(git('diff', '--name-only', 'main', 'lit/1-app').trim().split('\n'), ['app/[id]/page.ts']);
});

test('a failing stage goes back to the starting branch and leaves the checkout clean', (t) => {
  const { git, run } = repo(t);
  const r = run('--json', '--test', `"${process.execPath}" -e "process.exit(1)"`);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.match(out.error, /Stage 1-a fails[\s\S]*Back on main/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(git('status', '--porcelain'), '');
});

test('a stage branch may never be the --from or --base branch, or one that is checked out', (t) => {
  const { git, stages, dir } = repo(t);
  const bigBefore = git('rev-parse', 'big');
  writeFileSync(stages, JSON.stringify([{ name: 'main', match: '.*' }]));
  const r = spawnSync(process.execPath, [SCRIPT, '--from', 'big', '--base', 'main', '--stages', stages, '--prefix', '', '--force', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.match(JSON.parse(r.stdout).error, /is checked out|--from or --base/);
  writeFileSync(stages, JSON.stringify([{ name: 'big', match: '.*' }]));
  const r2 = spawnSync(process.execPath, [SCRIPT, '--from', 'big', '--base', 'main', '--stages', stages, '--prefix', '', '--force', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.match(JSON.parse(r2.stdout).error, /the --from or --base branch/);
  assert.equal(git('rev-parse', 'big'), bigBefore, '--force did not reset the big branch');
});
