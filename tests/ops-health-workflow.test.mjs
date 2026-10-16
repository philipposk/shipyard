// Runs the real shell steps of health.yml the way GitHub does (bash -eo pipefail), with a stand-in curl and gh,
// so the logic of the scheduled health check is tested, not just its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { TEMPLATES, FAKE_SECRET } from './ops-helpers.mjs';

const haveTools = ['bash', 'jq'].every((t) => spawnSync(t, ['--version'], { encoding: 'utf8' }).status === 0) && process.platform !== 'win32';
const yaml = await readFile(path.join(TEMPLATES, '.github', 'workflows', 'health.yml'), 'utf8');

function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run: \|$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^\s*/.exec(lines[j])[0].length > indent); j++) body.push(lines[j].slice(indent + 2));
    out.push(body.join('\n'));
  }
  return out;
}
const [CHECK, ALERT] = runBlocks(yaml);

const NODE = process.execPath;
const CURL_SHIM = `#!${NODE}
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = "";
if (args.includes("--config")) { try { stdin = fs.readFileSync(0, "utf8"); } catch {} }
const url = args[args.length - 1];
const path = url.replace(/^https:\\/\\/[^/]+/, "") || "/";
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, "utf8"));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "curl", args, stdin }) + "\\n");
const hit = scenario[path] ?? { code: 200 };
if (hit.fail) { process.stdout.write("000"); process.exit(28); }
const o = args.indexOf("-o");
if (o !== -1 && hit.body !== undefined) fs.writeFileSync(args[o + 1], typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body));
else if (o !== -1) fs.writeFileSync(args[o + 1], "");
if (args.includes("-w")) process.stdout.write(String(hit.code));
`;
const GH_SHIM = `#!${NODE}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "gh", args }) + "\\n");
if (args[0] === "issue" && args[1] === "list") process.stdout.write((process.env.FAKE_OPEN_ISSUES || "").split(",").filter(Boolean).join("\\n") + (process.env.FAKE_OPEN_ISSUES ? "\\n" : ""));
`;

async function sandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-health-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'curl'), CURL_SHIM);
  await writeFile(path.join(bin, 'gh'), GH_SHIM);
  await chmod(path.join(bin, 'curl'), 0o755);
  await chmod(path.join(bin, 'gh'), 0o755);
  await writeFile(path.join(dir, 'check.sh'), CHECK);
  await writeFile(path.join(dir, 'alert.sh'), ALERT);
  const temp = path.join(dir, 'tmp');
  await mkdir(temp);
  return { dir, bin, temp, log: path.join(dir, 'calls.jsonl'), scenario: path.join(dir, 'scenario.json'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function bash(sb, script, env) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(sb.dir, script)], {
    encoding: 'utf8',
    env: {
      PATH: `${sb.bin}${path.delimiter}${process.env.PATH}`, HOME: sb.dir, RUNNER_TEMP: sb.temp, GITHUB_OUTPUT: path.join(sb.dir, 'output'),
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'me/app', GITHUB_RUN_ID: '42',
      FAKE_SCENARIO: sb.scenario, FAKE_LOG: sb.log, ...env,
    },
  });
}

async function check(scenario, env = {}) {
  const sb = await sandbox();
  try {
    await writeFile(sb.scenario, JSON.stringify(scenario));
    const r = bash(sb, 'check.sh', { SITE_URL: 'https://app.example.com', CRON_SECRET: FAKE_SECRET, ...env });
    const output = await readFile(path.join(sb.dir, 'output'), 'utf8').catch(() => '');
    const report = await readFile(path.join(sb.temp, 'health-report.md'), 'utf8').catch(() => '');
    const calls = (await readFile(sb.log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { r, failed: /failed=(\d)/.exec(output)?.[1], report, calls };
  } finally {
    await sb.cleanup();
  }
}

const SUMMARY_OK = { ok: true, checks: [{ id: 'database', status: 'ok' }, { id: 'errors-24h', status: 'ok' }], errors24h: 0, unresolved: 0 };

test('all fine: failed=0, every row ok, the secret goes to curl by stdin and never in arguments or the report', { skip: !haveTools }, async () => {
  const { r, failed, report, calls } = await check({ '/api/ops/summary': { code: 200, body: SUMMARY_OK } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(failed, '0');
  assert.match(report, /\| \/ \| ok \(200\) \|/);
  assert.match(report, /\| \/api\/health \| ok \(200\) \|/);
  assert.match(report, /\| App checks \| ok \|/);
  assert.match(report, /Errors logged in the last 24 hours: 0/);
  assert.match(report, /All checks passed for https:\/\/app\.example\.com\./);
  assert.ok(!/found a problem/.test(report));
  assert.match(report, /actions\/runs\/42/);
  const curls = calls.filter((c) => c.tool === 'curl');
  assert.equal(curls.length, 3);
  for (const c of curls) assert.ok(!c.args.join(' ').includes(FAKE_SECRET), 'the secret must not be in the arguments');
  const withSecret = curls.filter((c) => c.stdin.includes(FAKE_SECRET));
  assert.equal(withSecret.length, 1);
  assert.match(withSecret[0].stdin, /header = "x-cron-secret: /);
  assert.ok(withSecret[0].args.join(' ').includes('/api/ops/summary'));
  assert.ok(!report.includes(FAKE_SECRET));
  assert.ok(!r.stdout.includes(FAKE_SECRET) && !r.stderr.includes(FAKE_SECRET));
});

test('the home page answering 503 is a failure and the row says so', { skip: !haveTools }, async () => {
  const { failed, report } = await check({ '/': { code: 503 }, '/api/ops/summary': { code: 200, body: SUMMARY_OK } });
  assert.equal(failed, '1');
  assert.match(report, /\| \/ \| \*\*problem\*\* \(answer 503\) \|/);
  assert.match(report, /The scheduled health check found a problem with https:\/\/app\.example\.com\./);
});

test('a site that does not answer at all is a failure (code 000)', { skip: !haveTools }, async () => {
  const { failed, report } = await check({ '/': { fail: true }, '/api/health': { fail: true }, '/api/ops/summary': { fail: true } });
  assert.equal(failed, '1');
  assert.match(report, /answer 000/);
});

test('a failing app check is named, with only safe characters', { skip: !haveTools }, async () => {
  const body = { ok: false, checks: [{ id: 'database', status: 'fail' }, { id: 'evil `$(x)` <b>', status: 'fail' }, { id: 'resend', status: 'warn' }], errors24h: 7, unresolved: 3 };
  const { failed, report } = await check({ '/api/ops/summary': { code: 200, body } });
  assert.equal(failed, '1');
  assert.match(report, /failing: database,evilxb/);
  assert.ok(!/[`$<>]/.test(report.replace(/\$GITHUB/g, '')), 'no markup characters from the app\'s answer');
  assert.match(report, /Warnings: resend/);
  assert.match(report, /Errors logged in the last 24 hours: 7/);
  assert.match(report, /Problems not marked as resolved: 3/);
});

test('warnings alone do not raise an alert', { skip: !haveTools }, async () => {
  const body = { ok: true, checks: [{ id: 'resend', status: 'warn' }, { id: 'database', status: 'ok' }], errors24h: 2, unresolved: 1 };
  const { failed, report } = await check({ '/api/ops/summary': { code: 200, body } });
  assert.equal(failed, '0');
  assert.match(report, /Warnings: resend/);
});

test('ok:false without a named failing check is still a failure', { skip: !haveTools }, async () => {
  const { failed } = await check({ '/api/ops/summary': { code: 200, body: { ok: false, checks: [], errors24h: null, unresolved: null } } });
  assert.equal(failed, '1');
});

test('404, 401, an unreadable answer and a server error from the summary page are each explained', { skip: !haveTools }, async () => {
  const cases = [
    [{ code: 404 }, /the page is closed/],
    [{ code: 401 }, /the secret does not match/],
    [{ code: 200, body: 'not json' }, /not readable/],
    [{ code: 500 }, /answer 500/],
  ];
  for (const [hit, re] of cases) {
    const { failed, report } = await check({ '/api/ops/summary': hit });
    assert.equal(failed, '1', JSON.stringify(hit));
    assert.match(report, re);
  }
});

test('no CRON_SECRET yet: the app checks are skipped (not failed) and the secret is never sent', { skip: !haveTools }, async () => {
  const { failed, report, calls } = await check({}, { CRON_SECRET: '' });
  assert.equal(failed, '0');
  assert.match(report, /skipped \(no CRON_SECRET secret yet\)/);
  assert.equal(calls.filter((c) => c.tool === 'curl').length, 2);
});

test('SITE_URL missing or not https stops the job with a plain message', { skip: !haveTools }, async () => {
  for (const url of ['', 'http://app.example.com']) {
    const { r } = await check({}, { SITE_URL: url });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /::error::/);
  }
});

test('a trailing slash on SITE_URL does not double up', { skip: !haveTools }, async () => {
  const { calls, failed } = await check({ '/api/ops/summary': { code: 200, body: SUMMARY_OK } }, { SITE_URL: 'https://app.example.com/' });
  assert.equal(failed, '0');
  assert.ok(calls.some((c) => c.args.at(-1) === 'https://app.example.com/api/health'));
});

async function alert(failed, openIssues) {
  const sb = await sandbox();
  try {
    await writeFile(path.join(sb.temp, 'health-report.md'), 'REPORT TEXT');
    const r = bash(sb, 'alert.sh', { REPO: 'me/app', GH_TOKEN: 'x', FAILED: failed, FAKE_OPEN_ISSUES: openIssues });
    const calls = (await readFile(sb.log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tool === 'gh');
    return { r, calls };
  } finally {
    await sb.cleanup();
  }
}
const find = (calls, ...words) => calls.filter((c) => words.every((w) => c.args.includes(w)));

test('alert: a failure with no open issue opens exactly one, labelled ops-alert, with the report as its body', { skip: !haveTools }, async () => {
  const { r, calls } = await alert('1', '');
  assert.equal(r.status, 0, r.stderr);
  const create = find(calls, 'issue', 'create');
  assert.equal(create.length, 1);
  assert.ok(create[0].args.includes('ops-alert') && create[0].args.includes('--body-file'));
  assert.equal(find(calls, 'issue', 'edit').length, 0);
  assert.equal(find(calls, 'issue', 'close').length, 0);
  assert.ok(find(calls, 'label', 'create', 'ops-alert').length === 1, 'makes sure the label exists');
});

test('alert: a failure with an issue already open updates that one instead of opening another', { skip: !haveTools }, async () => {
  const { calls } = await alert('1', '7,5');
  assert.equal(find(calls, 'issue', 'create').length, 0);
  const edit = find(calls, 'issue', 'edit');
  assert.equal(edit.length, 1);
  assert.equal(edit[0].args[2], '7');
});

test('alert: when everything passes again, every open ops-alert issue is closed', { skip: !haveTools }, async () => {
  const { calls } = await alert('0', '7,5');
  assert.deepEqual(find(calls, 'issue', 'close').map((c) => c.args[2]), ['7', '5']);
  assert.equal(find(calls, 'issue', 'create').length, 0);
});

test('alert: all fine and nothing open does nothing to issues', { skip: !haveTools }, async () => {
  const { calls } = await alert('0', '');
  assert.equal(find(calls, 'issue', 'create').length + find(calls, 'issue', 'edit').length + find(calls, 'issue', 'close').length, 0);
});
