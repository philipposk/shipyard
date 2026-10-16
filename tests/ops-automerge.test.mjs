// The auto-merge rules: which paths are risky, what counts as big, what Dependabot may merge, and what the
// script does against a fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { TEMPLATES, ROOT } from './ops-helpers.mjs';

const SCRIPT = path.join(TEMPLATES, '.github', 'ops', 'automerge-check.mjs');
const M = await import(SCRIPT);

const file = (filename, additions = 3, deletions = 1, extra = {}) => ({ filename, additions, deletions, ...extra });
const pr = (over = {}) => ({ author: 'someone', labels: ['automerge'], files: [file('src/components/Card.tsx')], filesComplete: true, ...over });

// ---------------------------------------------------------------------------------------------
// Paths

test('risky paths: every folder and file from the spec is caught', () => {
  const risky = [
    'supabase/migrations/0004_add_notes.sql', 'src/proxy.ts', 'src/app/api/auth/signup/route.ts', 'src/lib/auth/session.ts',
    'src/lib/supabase/server.ts', 'src/lib/billing/plans.ts', 'src/app/api/billing/webhook/route.ts',
    'src/app/api/account/delete/route.ts', '.github/workflows/test.yml', '.github/ops/automerge-check.mjs', 'package.json',
    'next.config.ts',
  ];
  for (const p of risky) assert.equal(M.isRiskyPath(p), true, p);
});

test('risky paths: ordinary files are not', () => {
  const fine = [
    'src/components/Card.tsx', 'src/app/page.tsx', 'src/app/items/page.tsx', 'README.md', 'public/icon.svg',
    'src/lib/format.ts', 'src/app/globals.css', 'DESIGN.md', 'src/lib/session-notes.md', 'src/app/authors/page.tsx',
    'src/app/administrator/page.tsx', 'src/lib/safe-next-notes.md', 'src/app/api/profiles/route.ts',
  ];
  for (const p of fine) assert.equal(M.isRiskyPath(p), false, p);
});

test('risky paths: look-alike names are told apart from the real folders', () => {
  assert.equal(M.isRiskyPath('src/lib/auth-helpers.ts'), false);
  assert.equal(M.isRiskyPath('src/lib/auth/helpers.ts'), true);
  assert.equal(M.isRiskyPath('src/lib/authors/list.ts'), false);
  assert.equal(M.isRiskyPath('src/lib/billing-notes.md'), false);
  assert.equal(M.isRiskyPath('src/lib/billing/notes.md'), true);
  assert.equal(M.isRiskyPath('src/proxy.tsx'), false);
  assert.equal(M.isRiskyPath('src/proxy.ts.bak'), false);
  assert.equal(M.isRiskyPath('docs/src/proxy.ts'), false);
  assert.equal(M.isRiskyPath('supabase/migrations-notes.md'), true, 'inside supabase/');
  assert.equal(M.isRiskyPath('supabasex/notes.md'), false);
  assert.equal(M.isRiskyPath('supabase/seed.sql'), true, 'the whole supabase folder is risky, not only migrations');
  assert.equal(M.isRiskyPath('supabase-notes.md'), false);
  assert.equal(M.isRiskyPath('src/app/api/authors/route.ts'), false);
  assert.equal(M.isRiskyPath('src/app/api/auth/signup/route.ts'), true);
  assert.equal(M.isRiskyPath('.githubx/readme.md'), false);
  assert.equal(M.isRiskyPath('github/readme.md'), false);
});

test('risky paths: tricks do not get past (case, ./, double slashes, links standing in for a folder, odd paths)', () => {
  assert.equal(M.isRiskyPath('SRC/LIB/AUTH/session.ts'), true);
  assert.equal(M.isRiskyPath('./src/proxy.ts'), true);
  assert.equal(M.isRiskyPath('src//lib//auth//x.ts'), true);
  assert.equal(M.isRiskyPath('src\\lib\\auth\\x.ts'), true);
  assert.equal(M.isRiskyPath('src/lib/auth'), true, 'a link named like the folder');
  assert.equal(M.isRiskyPath('.github'), true);
  assert.equal(M.isRiskyPath('../outside.txt'), true);
  assert.equal(M.isRiskyPath('src/../package-lock.json'), true);
  assert.equal(M.isRiskyPath('/etc/passwd'), true);
  assert.equal(M.isRiskyPath(''), true);
  assert.equal(M.isRiskyPath('packages/web/package.json'), true, 'any package.json');
});

test('risky paths: the sign-in code, the guards, the modules that use the server key and the tests all need a person', () => {
  const risky = [
    'src/app/auth/callback/route.ts', 'src/app/auth/confirm/route.ts', 'src/app/auth/sign-out/route.ts',
    'src/lib/session.ts', 'src/lib/safe-next.mjs', 'src/lib/same-origin.mjs', 'src/lib/rate-limit.mjs',
    'src/lib/account/hooks.ts', 'src/app/admin/page.tsx', 'src/app/admin/logs/page.tsx', 'src/app/api/profile/route.ts',
    'src/lib/newsletter/store.ts', 'src/app/api/newsletter/subscribe/route.ts', 'src/lib/errors/report.ts',
    'src/app/api/errors/route.ts', 'tests/isolation.test.mjs', 'tests/auth.test.mjs', 'supabase/isolation.json',
    'supabase/migrations/0001_init.sql', 'supabase/config.toml', 'supabase/seed.sql',
  ];
  for (const p of risky) assert.equal(M.isRiskyPath(p), true, p);
  // a pull request that removes the open-redirect guard from the sign-in callback must not merge itself
  const r = M.classify(pr({ files: [file('src/app/auth/callback/route.ts', 0, 3)] }));
  assert.equal(r.decision, 'review');
  // deleting the tests that would catch it must not either
  assert.equal(M.classify(pr({ files: [file('tests/isolation.test.mjs', 0, 80)] })).decision, 'review');
});

test('risky paths: every file allowed to use the server key is covered (the lists must not drift apart)', async () => {
  const { SERVER_KEY_ALLOWED } = await import(path.join(ROOT, 'scripts', 'verify', 'server-key.mjs'));
  assert.ok(SERVER_KEY_ALLOWED.length > 0);
  for (const entry of SERVER_KEY_ALLOWED) {
    const file = `src/${entry}`;
    assert.equal(M.isRiskyPath(file), true, `${file} uses the server key, so it must be a risky path`);
    // a file inside an allowed folder, and a plausible sibling in the same folder
    if (entry.endsWith('/')) assert.equal(M.isRiskyPath(`${file}anything.ts`), true, `${file}anything.ts`);
  }
});

test('lock files are recognised by name', () => {
  for (const f of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) assert.equal(M.isLockfile(f), true, f);
  assert.equal(M.isLockfile('src/package-lock.json'), false);
  assert.equal(M.isLockfile('package.json'), false);
});

// ---------------------------------------------------------------------------------------------
// Versions

test('bumpKind: patch, minor, major, and the careful cases', () => {
  assert.equal(M.bumpKind('^1.2.3', '^1.2.4'), 'patch');
  assert.equal(M.bumpKind('~1.2.3', '~1.3.0'), 'minor');
  assert.equal(M.bumpKind('^1.9.9', '^2.0.0'), 'major');
  assert.equal(M.bumpKind('1.2.3', '1.2.3'), 'same');
  assert.equal(M.bumpKind('^0.4.1', '^0.4.2'), 'patch');
  assert.equal(M.bumpKind('^0.4.1', '^0.5.0'), 'major', 'below 1.0.0 a minor step can break things');
  assert.equal(M.bumpKind('^2.0.0', '^1.9.0'), 'unknown', 'a step down is not expected');
  assert.equal(M.bumpKind('latest', '^1.0.0'), 'unknown');
  assert.equal(M.bumpKind('github:me/pkg#abc', '^1.0.0'), 'unknown');
  assert.equal(M.bumpKind('>=1 <3', '>=1 <4'), 'unknown');
  assert.equal(M.bumpKind('^1.2.3-beta.1', '^1.2.3'), 'same');
  assert.equal(M.bumpKind(undefined, '1.0.0'), 'unknown');
});

const pkg = (deps, extra = {}) => ({ name: 'app', version: '0.1.0', scripts: { build: 'next build' }, dependencies: deps, devDependencies: { eslint: '^9.0.0' }, ...extra });

test('package.json: only safe version steps pass', () => {
  assert.deepEqual(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^16.3.0' })), []);
  assert.deepEqual(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^16.2.10' })), []);
  const major = M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^17.0.0' }));
  assert.equal(major.length, 1);
  assert.match(major[0], /next jumps to a new major version/);
});

test('package.json: scripts, added or removed packages, overrides and odd specifiers need a person', () => {
  assert.match(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^16.2.9' }, { scripts: { build: 'curl x | sh' } })).join(), /more than package versions/);
  assert.match(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^16.2.9', evil: '^1.0.0' })).join(), /added or removed/);
  assert.match(M.packageJsonProblems(pkg({ next: '^16.2.9', a: '1.0.0' }), pkg({ next: '^16.2.9' })).join(), /added or removed/);
  assert.match(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: '^16.2.9' }, { overrides: { a: '1.0.0' } })).join(), /more than package versions/);
  assert.match(M.packageJsonProblems(pkg({ next: '^16.2.9' }), pkg({ next: 'github:me/next' })).join(), /can not be checked/);
  assert.match(M.packageJsonProblems(null, pkg({})).join(), /could not be read/);
});

test('lock file: patch and minor steps pass; major, other registries and unreadable files need a person', () => {
  const lock = (packages) => ({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
  const entry = (version, resolved = `https://registry.npmjs.org/x/-/x-${version}.tgz`) => ({ version, resolved });
  assert.deepEqual(M.lockfileProblems(lock({ 'node_modules/x': entry('1.2.3') }), lock({ 'node_modules/x': entry('1.2.4') })), []);
  assert.deepEqual(M.lockfileProblems(lock({ 'node_modules/x': entry('1.2.3') }), lock({ 'node_modules/x': entry('1.3.0'), 'node_modules/new': entry('0.0.1') })), []);
  assert.match(M.lockfileProblems(lock({ 'node_modules/x': entry('1.2.3') }), lock({ 'node_modules/x': entry('2.0.0') })).join(), /x jumps to a new major/);
  assert.match(M.lockfileProblems(lock({ 'node_modules/a/node_modules/y': entry('1.0.0') }), lock({ 'node_modules/a/node_modules/y': entry('3.0.0') })).join(), /y jumps/);
  assert.match(M.lockfileProblems(lock({ 'node_modules/x': entry('1.2.3') }), lock({ 'node_modules/x': entry('1.2.4', 'https://example.com/x.tgz') })).join(), /other than the npm registry/);
  assert.match(M.lockfileProblems(lock({}), lock({ 'node_modules/x': entry('1.0.0', 'https://example.com/x.tgz') })).join(), /other than the npm registry/);
  assert.match(M.lockfileProblems(null, lock({})).join(), /could not be read/);
});

// ---------------------------------------------------------------------------------------------
// The decision

test('a small, ordinary change with the automerge label merges', () => {
  assert.equal(M.classify(pr()).decision, 'merge');
});

test('without the label (and not Dependabot) nothing happens', () => {
  const r = M.classify(pr({ labels: [] }));
  assert.equal(r.decision, 'hold');
  assert.equal(r.block, false);
});

test('the needs-review label stops it, and switches auto-merge off', () => {
  const r = M.classify(pr({ labels: ['automerge', 'needs-review'] }));
  assert.equal(r.decision, 'hold');
  assert.equal(r.block, true);
});

test('a risky file anywhere in the pull request sends it to a person, and says which file', () => {
  const r = M.classify(pr({ files: [file('src/components/Card.tsx'), file('src/lib/auth/session.ts')] }));
  assert.equal(r.decision, 'review');
  assert.match(r.reasons.join('\n'), /src\/lib\/auth\/session\.ts/);
});

test('a rename out of a risky folder is still risky (the old name counts)', () => {
  const r = M.classify(pr({ files: [file('src/lib/helpers/session.ts', 0, 0, { previous_filename: 'src/lib/auth/session.ts' })] }));
  assert.equal(r.decision, 'review');
});

test('big means more than 400 changed lines, lock files not counted', () => {
  assert.equal(M.classify(pr({ files: [file('src/a.ts', 300, 100)] })).decision, 'merge');
  const big = M.classify(pr({ files: [file('src/a.ts', 300, 101)] }));
  assert.equal(big.decision, 'review');
  assert.match(big.reasons.join(), /big \(401 changed lines/);
  assert.equal(M.classify(pr({ files: [file('src/a.ts', 10, 0), file('package-lock.json', 5000, 5000)] })).decision, 'review', 'a lock file from a person without package.json is not accepted');
  assert.equal(M.classify(pr({ files: [file('src/a.ts', 10, 0), file('package-lock.json', 5000, 5000)], author: 'dependabot[bot]', labels: [] })).decision, 'review', 'Dependabot lock file that can not be read');
  assert.equal(M.classify(pr({ files: [file('src/a.ts', 399, 1)] })).decision, 'merge');
});

test('too many files for GitHub to list, or none at all, goes to a person', () => {
  assert.equal(M.classify(pr({ filesComplete: false })).decision, 'review');
  assert.equal(M.classify(pr({ files: [] })).decision, 'review');
});

test('a person who changes package.json always needs a review', () => {
  const r = M.classify(pr({ files: [file('package.json', 1, 1)] }));
  assert.equal(r.decision, 'review');
  assert.match(r.reasons.join(), /package\.json/);
});

const dep = (over = {}) => ({ author: 'dependabot[bot]', labels: [], filesComplete: true, ...over });

test('Dependabot: a patch or minor update of package.json plus the lock file merges', () => {
  const r = M.classify(dep({
    files: [file('package.json', 1, 1), file('package-lock.json', 40, 40)],
    packageJson: { base: pkg({ next: '^16.2.9' }), head: pkg({ next: '^16.3.1' }) },
    lockfile: {
      base: { packages: { 'node_modules/next': { version: '16.2.9', resolved: 'https://registry.npmjs.org/next/-/next-16.2.9.tgz' } } },
      head: { packages: { 'node_modules/next': { version: '16.3.1', resolved: 'https://registry.npmjs.org/next/-/next-16.3.1.tgz' } } },
    },
  }));
  assert.equal(r.decision, 'merge', r.reasons.join());
});

test('Dependabot: a major update never merges itself', () => {
  const r = M.classify(dep({
    files: [file('package.json', 1, 1), file('package-lock.json', 40, 40)],
    packageJson: { base: pkg({ next: '^16.2.9' }), head: pkg({ next: '^17.0.0' }) },
    lockfile: { base: { packages: {} }, head: { packages: {} } },
  }));
  assert.equal(r.decision, 'review');
  assert.match(r.reasons.join(), /major/);
});

test('Dependabot: a lock-file-only update with a major step inside needs a person', () => {
  const r = M.classify(dep({
    files: [file('package-lock.json', 20, 20)],
    lockfile: {
      base: { packages: { 'node_modules/y': { version: '1.4.0', resolved: 'https://registry.npmjs.org/y/-/y-1.4.0.tgz' } } },
      head: { packages: { 'node_modules/y': { version: '2.0.0', resolved: 'https://registry.npmjs.org/y/-/y-2.0.0.tgz' } } },
    },
  }));
  assert.equal(r.decision, 'review');
});

test('Dependabot: if the files could not be read, it goes to a person', () => {
  assert.equal(M.classify(dep({ files: [file('package.json', 1, 1)], packageJson: { base: null, head: null } })).decision, 'review');
});

test('Dependabot: touching the workflows (an actions update) always needs a person', () => {
  const r = M.classify(dep({ files: [file('.github/workflows/test.yml', 1, 1)] }));
  assert.equal(r.decision, 'review');
});

test('Dependabot: an update that also edits the scripts in package.json is not a plain version bump', () => {
  const r = M.classify(dep({
    files: [file('package.json', 2, 1)],
    packageJson: { base: pkg({ next: '^16.2.9' }), head: pkg({ next: '^16.2.10' }, { scripts: { build: 'x' } }) },
  }));
  assert.equal(r.decision, 'review');
});

test('text from a pull request can not carry markup or workflow commands into a comment or the log', () => {
  const nasty = '::set-output name=x::y`rm -rf`<script>';
  const s = M.safe(nasty);
  assert.ok(!s.startsWith('::'));
  assert.ok(!/[`<>$]/.test(s));
  assert.ok(M.safe('x'.repeat(500)).length <= 80);
  const r = M.classify(pr({ files: [file('src/lib/auth/::warning::`x`.ts')] }));
  assert.ok(!/[`<>]/.test(r.reasons.join()));
});

// ---------------------------------------------------------------------------------------------
// The whole job, against a fake GitHub

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ENV = { REPO: 'me/app', PR_NUMBER: '12', BASE_REF: 'main', BASE_SHA: SHA_A, HEAD_SHA: SHA_B };

function fakeGh({ pr: prData = {}, files = [file('src/components/Card.tsx')], comments = [], protectedChecks = true, mergeFails = false, contents = {}, ruleChecks = false } = {}) {
  const calls = [];
  const gh = async (args, { input } = {}) => {
    calls.push({ args, input });
    const key = args.join(' ');
    if (key === 'api repos/me/app/pulls/12') {
      return JSON.stringify({ state: 'open', draft: false, head: { sha: SHA_B }, user: { login: 'someone' }, labels: [{ name: 'automerge' }], changed_files: files.length, ...prData });
    }
    if (args[0] === 'api' && args.includes('--paginate') && args[2]?.includes('/pulls/12/files')) {
      return files.map((f) => JSON.stringify([f.filename, f.previous_filename ?? '', f.additions, f.deletions])).join('\n');
    }
    if (args[0] === 'api' && args.includes('--paginate') && args[2]?.includes('/issues/12/comments')) return comments.join('\n');
    if (key === 'api repos/me/app/branches/main') {
      return JSON.stringify(protectedChecks ? { protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['test'], checks: [] } } } : { protected: false });
    }
    if (key === 'api repos/me/app/rules/branches/main') return JSON.stringify(ruleChecks ? [{ type: 'required_status_checks' }] : []);
    if (args[0] === 'api' && args[1] === '-H') {
      const m = /contents\/([^?]+)\?ref=([0-9a-f]+)/.exec(args[3]);
      const v = contents[`${m[1]}@${m[2] === SHA_A ? 'base' : 'head'}`];
      if (!v) throw new Error('not found');
      return JSON.stringify(v);
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto') && mergeFails) throw new Error('Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    return '';
  };
  const did = (...words) => calls.filter((c) => words.every((w) => c.args.includes(w)));
  return { gh, calls, did };
}

test('main: a clean small pull request gets auto-merge, tied to the exact commit that was judged', async () => {
  const f = fakeGh();
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'merge');
  const merge = f.did('pr', 'merge', '--auto')[0];
  assert.ok(merge, 'should turn on auto-merge');
  assert.deepEqual(merge.args, ['pr', 'merge', '12', '--repo', 'me/app', '--auto', '--squash', '--match-head-commit', SHA_B]);
  assert.equal(f.did('pr', 'edit').length, 0);
});

test('main: never merges when GitHub does not wait for the tests (it would merge at once)', async () => {
  const f = fakeGh({ protectedChecks: false });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.equal(f.did('pr', 'merge', '--auto').length, 0);
  const comment = f.did('pr', 'comment')[0];
  assert.ok(comment, 'should explain');
  assert.match(comment.input, /not set to wait for the Tests check/);
});

test('main: a rule set that requires checks counts as waiting', async () => {
  const f = fakeGh({ protectedChecks: false, ruleChecks: true });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'merge');
});

test('main: a risky pull request gets the label, auto-merge off, and one explaining comment', async () => {
  const f = fakeGh({ files: [file('supabase/migrations/0009_x.sql')] });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'review');
  assert.ok(f.did('pr', 'edit', '--add-label', 'needs-review')[0]);
  assert.ok(f.did('pr', 'merge', '--disable-auto')[0]);
  assert.equal(f.did('pr', 'merge', '--auto').length, 0);
  const comment = f.did('pr', 'comment')[0];
  assert.match(comment.input, /needs a person to look at it/);
  assert.match(comment.input, /supabase\/migrations\/0009_x\.sql/);
  assert.ok(comment.args.includes('--body-file') && comment.args.includes('-'), 'the comment text goes through stdin');
});

test('main: the comment is written only once', async () => {
  const f = fakeGh({ files: [file('src/proxy.ts')], comments: ['12345'] });
  await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(f.did('pr', 'comment').length, 0);
  assert.ok(f.did('pr', 'edit', '--add-label')[0], 'the label is still (re)applied');
});

test('main: every run starts by switching auto-merge off, and only the final step switches it back on', async () => {
  const f = fakeGh();
  await M.main({ env: ENV, gh: f.gh, log: () => {} });
  const merges = f.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').map((c) => c.args.includes('--disable-auto') ? 'off' : 'on');
  assert.deepEqual(merges, ['off', 'on'], 'off first, on last');
  assert.deepEqual(f.did('pr', 'merge', '--disable-auto')[0].args, ['pr', 'merge', '12', '--repo', 'me/app', '--disable-auto']);
});

test('main: label taken away, then a risky commit pushed: auto-merge is switched off and stays off', async () => {
  const f = fakeGh({ pr: { labels: [] }, files: [file('src/app/auth/callback/route.ts', 0, 3)] });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.ok(f.did('pr', 'merge', '--disable-auto')[0], 'switched off');
  assert.equal(f.did('pr', 'merge', '--auto').length, 0, 'never switched on');
});

test('main: every hold switches auto-merge off, not only the needs-review one', async () => {
  const f = fakeGh({ pr: { labels: [] } });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.equal(r.block, false);
  assert.ok(f.did('pr', 'merge', '--disable-auto')[0]);
});

test('main: a GitHub error while listing the files switches auto-merge off, then still fails', async () => {
  const f = fakeGh();
  const gh = async (args, opts) => {
    if (args[0] === 'api' && args.includes('--paginate') && args[2]?.includes('/pulls/12/files')) throw new Error('API rate limit exceeded');
    return f.gh(args, opts);
  };
  await assert.rejects(M.main({ env: ENV, gh, log: () => {} }), /rate limit/);
  assert.ok(f.did('pr', 'merge', '--disable-auto')[0], 'switched off');
  assert.equal(f.did('pr', 'merge', '--auto').length, 0);
});

test('main: a GitHub error while reading the pull request, or a bad environment value, also switches it off', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'api') throw new Error('boom');
    return '';
  };
  await assert.rejects(M.main({ env: ENV, gh, log: () => {} }), /boom/);
  assert.ok(calls.some((a) => a.includes('--disable-auto')), 'read failure');
  calls.length = 0;
  await assert.rejects(M.main({ env: { ...ENV, BASE_SHA: 'nope' }, gh, log: () => {} }), /BASE_SHA/);
  assert.ok(calls.some((a) => a.includes('--disable-auto') && a.includes('me/app') && a.includes('12')), 'bad sha but a usable repo and number');
  calls.length = 0;
  await assert.rejects(M.main({ env: { ...ENV, REPO: 'x; rm -rf /' }, gh, log: () => {} }), /REPO/);
  assert.equal(calls.length, 0, 'a bad repo name is never put on a command line');
});

test('main: failing to turn auto-merge on (a comment that can not be written) also leaves it off', async () => {
  const f = fakeGh({ mergeFails: true });
  const gh = async (args, opts) => {
    if (args[0] === 'pr' && args[1] === 'comment') throw new Error('comment failed');
    return f.gh(args, opts);
  };
  await assert.rejects(M.main({ env: ENV, gh, log: () => {} }), /comment failed/);
  const merges = f.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').map((c) => c.args.at(-1) === '--disable-auto' ? 'off' : 'on');
  assert.equal(merges.at(-1), 'off');
});

test('main: a human-set needs-review label is respected', async () => {
  const f = fakeGh({ pr: { labels: [{ name: 'automerge' }, { name: 'needs-review' }] } });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.ok(f.did('pr', 'merge', '--disable-auto')[0]);
  assert.equal(f.did('pr', 'comment').length, 0);
});

test('main: without the label nothing is merged or labelled, and auto-merge is off', async () => {
  const f = fakeGh({ pr: { labels: [] } });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.equal(f.did('pr', 'merge', '--auto').length, 0);
  assert.equal(f.did('pr', 'edit').length, 0);
  assert.equal(f.did('pr', 'comment').length, 0);
});

test('main: a closed pull request is left alone; a draft or an out-of-date commit is not merged and is switched off', async () => {
  const closed = fakeGh({ pr: { state: 'closed' }, files: [file('src/proxy.ts')] });
  await M.main({ env: ENV, gh: closed.gh, log: () => {} });
  assert.equal(closed.did('pr').length, 0);
  for (const over of [{ draft: true }, { head: { sha: 'c'.repeat(40) } }]) {
    const f = fakeGh({ pr: over, files: [file('src/proxy.ts')] });
    await M.main({ env: ENV, gh: f.gh, log: () => {} });
    assert.deepEqual(f.calls.filter((c) => c.args[0] === 'pr').map((c) => c.args.slice(0, 2).concat(c.args.at(-1))), [['pr', 'merge', '--disable-auto']], JSON.stringify(over));
  }
});

test('main: if GitHub refuses auto-merge (the setting is off) it explains and does not fail', async () => {
  const f = fakeGh({ mergeFails: true });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'hold');
  assert.match(f.did('pr', 'comment')[0].input, /Allow auto-merge/);
});

test('main: a pull request with more files than GitHub listed goes to a person', async () => {
  const f = fakeGh({ pr: { changed_files: 3200 } });
  const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
  assert.equal(r.decision, 'review');
});

test('main: Dependabot major update is labelled; a minor one merges', async () => {
  const base = pkg({ next: '^16.2.9' });
  for (const [head, expected] of [[pkg({ next: '^17.0.0' }), 'review'], [pkg({ next: '^16.4.0' }), 'merge']]) {
    const f = fakeGh({
      pr: { user: { login: 'dependabot[bot]' }, labels: [] },
      files: [file('package.json', 1, 1)],
      contents: { 'package.json@base': base, 'package.json@head': head },
    });
    const r = await M.main({ env: ENV, gh: f.gh, log: () => {} });
    assert.equal(r.decision, expected);
  }
});

test('main: a bad value in the environment stops with a plain message', async () => {
  for (const [name, value] of [['REPO', 'not a repo'], ['PR_NUMBER', '12; rm -rf /'], ['BASE_REF', '-evil'], ['HEAD_SHA', 'zzz'], ['BASE_SHA', '']]) {
    await assert.rejects(M.main({ env: { ...ENV, [name]: value }, gh: async () => '', log: () => {} }), new RegExp(name));
  }
});

test('main: only goes through gh with fixed argument lists (no shell, no text from the pull request in a command line)', async () => {
  const f = fakeGh({ files: [file('src/lib/auth/$(touch hacked).ts'), file('src/proxy.ts')], pr: { title: '$(evil)', body: '`evil`', head: { sha: SHA_B, ref: '$(evil)' } } });
  await M.main({ env: ENV, gh: f.gh, log: () => {} });
  for (const c of f.calls) {
    assert.ok(c.args.every((a) => typeof a === 'string'));
    assert.ok(!c.args.some((a) => /touch hacked|evil/.test(a)), `file or title text leaked into a command line: ${c.args.join(' ')}`);
  }
});

test('running the script as a program: reads its settings from the environment and uses the gh on the PATH', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-gh-'));
  try {
    const log = path.join(dir, 'calls.log');
    // A stand-in `gh` that answers like GitHub and writes down what it was asked.
    await writeFile(path.join(dir, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "api repos/me/app/pulls/12") echo '{"state":"open","draft":false,"head":{"sha":"${SHA_B}"},"user":{"login":"someone"},"labels":[{"name":"automerge"}],"changed_files":1}' ;;
  *"--paginate"*"/files"*) echo '["src/components/Card.tsx","",3,1]' ;;
  "api repos/me/app/branches/main") echo '{"protection":{"required_status_checks":{"enforcement_level":"everyone","contexts":["test"]}}}' ;;
esac
exit 0
`);
    await chmod(path.join(dir, 'gh'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, ...ENV, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Decision for #12: merge/);
    assert.match(await (await import('node:fs/promises')).readFile(log, 'utf8'), /pr merge 12 --repo me\/app --auto --squash --match-head-commit b{40}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
