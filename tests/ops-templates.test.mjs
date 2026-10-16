// The generated workflows must be safe for public repositories. These tests read the templates as text
// and check the safety rules from the build spec, line by line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, TEMPLATES } from './ops-helpers.mjs';

const read = (rel) => readFile(path.join(TEMPLATES, ...rel.split('/')), 'utf8');
const WORKFLOWS = ['.github/workflows/health.yml', '.github/workflows/automerge.yml'];
const pins = JSON.parse(await readFile(path.join(ROOT, 'ops', 'actions-pins.json'), 'utf8'));

/** The bodies of all `run:` blocks (and the one-line `run: x` forms). */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] === '|' || m[2] === '>' || m[2] === '|-' || m[2] === '>-') {
      const indent = m[1].length;
      const body = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^\s*/.exec(lines[j])[0].length > indent); j++) body.push(lines[j]);
      out.push(body.join('\n'));
    } else out.push(m[2]);
  }
  return out;
}

// Anything an outsider can type into a pull request, issue, comment, branch name or commit.
const UNTRUSTED = [
  'github.event.pull_request.title', 'github.event.pull_request.body', 'github.event.pull_request.head.ref',
  'github.event.pull_request.head.label', 'github.event.pull_request.head.repo.default_branch', 'github.head_ref',
  'github.event.issue.title', 'github.event.issue.body', 'github.event.comment.body', 'github.event.review.body',
  'github.event.review_comment.body', 'github.event.pages', 'github.event.commits', 'github.event.head_commit.message',
  'github.event.head_commit.author', 'github.event.workflow_run.head_branch', 'github.event.workflow_run.head_commit',
];

test('every workflow template is plain, readable YAML (no tabs, even indentation)', async () => {
  for (const rel of [...WORKFLOWS, '.github/dependabot.yml', '.coderabbit.yaml']) {
    const text = await read(rel);
    assert.ok(!text.includes('\t'), `${rel} has a tab`);
    assert.ok(!text.includes('\r'), `${rel} has a carriage return`);
    assert.ok(text.endsWith('\n'), `${rel} should end with a newline`);
    for (const [i, line] of text.split('\n').entries()) {
      const indent = /^ */.exec(line)[0].length;
      assert.equal(indent % 2, 0, `${rel}:${i + 1} is indented by an odd number of spaces`);
    }
  }
});

test('the templates parse as YAML (when python3 with PyYAML is installed)', async (t) => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('python3 with PyYAML not available');
  for (const rel of [...WORKFLOWS, '.github/dependabot.yml', '.coderabbit.yaml']) {
    const r = spawnSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))', path.join(TEMPLATES, ...rel.split('/'))], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
  }
});

test('every action is pinned to a full commit with a version comment, and matches ops/actions-pins.json', async () => {
  const seen = new Set();
  for (const rel of WORKFLOWS) {
    const text = await read(rel);
    for (const [i, line] of text.split('\n').entries()) {
      const m = /^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/.exec(line);
      if (!m) continue;
      const [name, sha] = m[1].split('@');
      assert.match(sha ?? '', /^[0-9a-f]{40}$/, `${rel}:${i + 1} ${m[1]} is not pinned to a full commit`);
      assert.match(m[2] ?? '', /^v\d+\.\d+\.\d+$/, `${rel}:${i + 1} needs a version comment like # v1.2.3`);
      const pin = pins.actions[name];
      assert.ok(pin, `${name} is not in ops/actions-pins.json`);
      assert.equal(sha, pin.sha, `${name} sha differs from actions-pins.json`);
      assert.equal(m[2], pin.version, `${name} version comment differs from actions-pins.json`);
      seen.add(name);
    }
  }
  assert.deepEqual([...seen].sort(), ['actions/checkout', 'actions/setup-node']);
  assert.match(pins.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  for (const [name, p] of Object.entries(pins.actions)) {
    assert.match(p.sha, /^[0-9a-f]{40}$/, name);
    assert.match(p.version, /^v\d+\.\d+\.\d+$/, name);
  }
});

test('pull_request_target only where it is safe: never any checkout of the pull request\'s own code', async () => {
  const strip = (t) => t.replace(/^\s*#.*$/gm, '');
  for (const rel of WORKFLOWS) {
    const text = await read(rel);
    // health.yml has no pull request at all. automerge.yml uses it on purpose (see below).
    if (rel !== '.github/workflows/automerge.yml') assert.ok(!/pull_request_target/.test(strip(text)), `${rel} must not use pull_request_target`);
    assert.ok(!/ref:\s*\$\{\{\s*github\.(?:head_ref|event\.pull_request\.head)/.test(text), `${rel} must not check out the pull request's code`);
  }
  const auto = await read('.github/workflows/automerge.yml');
  // pull_request_target makes GitHub run the workflow file from the main branch, so a pull request can not rewrite it
  // to merge itself. That is only safe while nothing here runs the pull request's code.
  assert.match(strip(auto), /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, labeled, unlabeled, reopened\]/m);
  assert.ok(!/^\s*pull_request:/m.test(strip(auto)), 'automerge.yml must not also trigger on plain pull_request (that one runs the PR\'s copy of the file)');
  assert.match(auto, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/, 'the rules must come from the base branch');
  assert.match(auto, /persist-credentials:\s*false/);
  assert.ok(!/^\s*(?:- )?run:\s*.*(?:npm|npx|yarn|pnpm|make)\b/m.test(strip(auto)), 'automerge.yml must never install or run the pull request\'s code');
  assert.ok(!/uses:\s+(?!actions\/checkout@|actions\/setup-node@)/.test(strip(auto)), 'only checkout (of the base) and setup-node');
  // The label is not in the job condition: taking it away must still switch auto-merge off.
  const jobIf = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(auto)?.[1] ?? '';
  assert.ok(jobIf && !/labels/.test(jobIf), 'the job condition must not look at labels');
  assert.match(jobIf, /head\.repo\.full_name == github\.repository/);
  assert.match(jobIf, /base\.ref == github\.event\.repository\.default_branch/);
});

test('no untrusted text is ever put into a shell line: no ${{ }} inside any run: block', async () => {
  for (const rel of WORKFLOWS) {
    const text = await read(rel);
    const blocks = runBlocks(text);
    assert.ok(blocks.length > 0, `${rel} should have run steps`);
    for (const body of blocks) assert.ok(!body.includes('${{'), `${rel} puts an expression in a run block:\n${body.slice(0, 200)}`);
    for (const ctx of UNTRUSTED) assert.ok(!text.includes(ctx), `${rel} uses ${ctx}`);
  }
});

test('values reach the shell only through env: (the same names the scripts read)', async () => {
  const auto = await read('.github/workflows/automerge.yml');
  for (const name of ['REPO', 'PR_NUMBER', 'BASE_REF', 'BASE_SHA', 'HEAD_SHA', 'GH_TOKEN']) {
    assert.match(auto, new RegExp(`^\\s+${name}: \\$\\{\\{ `, 'm'), `automerge.yml should pass ${name} through env`);
  }
  const health = await read('.github/workflows/health.yml');
  for (const name of ['SITE_URL', 'CRON_SECRET', 'GH_TOKEN', 'REPO', 'FAILED']) {
    assert.match(health, new RegExp(`^\\s+${name}: \\$\\{\\{ `, 'm'), `health.yml should pass ${name} through env`);
  }
});

test('permissions are minimal and set at the top of each workflow', async () => {
  const health = await read('.github/workflows/health.yml');
  assert.match(health, /^permissions:\n {2}contents: read\n {2}issues: write\n/m);
  assert.ok(!/pull-requests:/.test(health) && !/contents: write/.test(health));
  const auto = await read('.github/workflows/automerge.yml');
  assert.match(auto, /^permissions:\n {2}contents: write\n {2}pull-requests: write\n/m);
  for (const text of [health, auto]) {
    assert.ok(!/write-all|permissions:\s*\{\s*\}|admin/i.test(text.replace(/^\s*#.*$/gm, '')));
  }
});

test('health.yml: every 6 hours + by hand, one ops-alert issue, closes itself, secret never on a command line', async () => {
  const text = await read('.github/workflows/health.yml');
  assert.match(text, /cron:\s*"\d+ \*\/6 \* \* \*"/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /vars\.SITE_URL/);
  assert.match(text, /secrets\.CRON_SECRET/);
  assert.match(text, /x-cron-secret/);
  assert.match(text, /\/api\/health/);
  assert.match(text, /\/api\/ops\/summary/);
  assert.match(text, /gh issue list --repo "\$REPO" --label ops-alert --state open/);
  assert.match(text, /gh issue close/);
  assert.match(text, /gh issue create/);
  assert.match(text, /gh issue edit/);
  // the secret goes in by stdin (curl --config -), never as -H "...$CRON_SECRET" on the command line
  assert.ok(!/-H\s+["'][^"']*\$\{?CRON_SECRET/.test(text), 'the secret must not be in a -H argument');
  assert.match(text, /printf 'header = "x-cron-secret: %s"\\n' "\$CRON_SECRET" \| curl --config -/);
  assert.ok(!/echo[^\n]*CRON_SECRET/.test(text), 'the secret must never be echoed');
  // the secret is only given to the one step that needs it
  const jobEnv = /^ {4}env:/m.test(text);
  assert.ok(!jobEnv, 'no job-level env: keep secrets in the step that needs them');
});

test('automerge.yml: the trigger, who may use it, and the single script it runs', async () => {
  const text = await read('.github/workflows/automerge.yml');
  assert.match(text, /types: \[opened, synchronize, labeled, unlabeled, reopened\]/);
  assert.match(text, /head\.repo\.full_name == github\.repository/, 'pull requests from forks must not be handled');
  assert.match(text, /node \.github\/ops\/automerge-check\.mjs/);
  assert.match(text, /default_branch/);
});

test('the automerge script has every risky path from the spec, and merges only with --auto --squash', async () => {
  const mod = await import(path.join(TEMPLATES, '.github', 'ops', 'automerge-check.mjs'));
  for (const p of [
    'supabase/', 'src/proxy.ts', 'src/app/api/auth/', 'src/lib/auth/', 'src/lib/supabase/', 'src/lib/billing/',
    'src/app/api/billing/', 'src/app/api/account/', '.github/', 'package.json', 'next.config.ts',
  ]) {
    assert.ok(mod.RISKY_PATHS.includes(p), `${p} should be risky`);
  }
  assert.equal(mod.BIG_LINES, 400);
  const src = await read('.github/ops/automerge-check.mjs');
  assert.match(src, /"--auto", "--squash", "--match-head-commit"/);
  assert.ok(!/"--admin"/.test(src), 'must never use --admin');
});

test('dependabot.yml: npm weekly, minor and patch grouped, at most 5 open', async () => {
  const text = await read('.github/dependabot.yml');
  assert.match(text, /package-ecosystem: "npm"/);
  assert.match(text, /interval: "weekly"/);
  assert.match(text, /open-pull-requests-limit: 5/);
  assert.match(text, /update-types:\n\s+- "minor"\n\s+- "patch"/);
});

test('.coderabbit.yaml: chill profile, English, the three path instructions, lock files skipped', async () => {
  const text = await read('.coderabbit.yaml');
  assert.match(text, /^language: "en-US"$/m);
  assert.match(text, /^ {2}profile: "chill"$/m);
  assert.match(text, /path: "supabase\/migrations\/\*\*"/);
  assert.match(text, /isolation\.json/);
  assert.match(text, /row level security/i);
  assert.match(text, /path: "src\/lib\/billing\/\*\*"/);
  assert.match(text, /path: "src\/app\/api\/\*\*"/);
  assert.match(text, /same origin/);
  assert.match(text, /"!\*\*\/package-lock\.json"/);
});

// Spelled out in pieces so this file itself stays clean for the same check.
const PERSONAL = new RegExp(['6x', '7|six', 'seven|fili', 'ppos|fmr', 'nq|pap', 'aki|phk', 'tistakis|philip', 'posk|Devol', 'oper'].join(''), 'i');

test('nothing personal or tied to one person is in the templates', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(ROOT, 'ops'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    assert.ok(!PERSONAL.test(text), `${f} mentions something personal`);
  }
});
