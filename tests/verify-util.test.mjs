import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.SHIPYARD_HOME = mkdtempSync(path.join(os.tmpdir(), 'shipyard-verify-home-'));

const util = await import('../scripts/verify/util.mjs');
const { formatReport, tally, summarizeForProfile, labelFor } = await import('../scripts/verify/format.mjs');
const { isVerified } = await import('../scripts/verify.mjs');
const { normalizeUrl } = await import('../scripts/verify.mjs');
const { readStringList } = await import('../scripts/verify/proxy.mjs');
const { supabaseFromEnv, randomPassword, randomTestEmail, isIdentifier } = await import('../scripts/verify/supabase.mjs');

test('stripComments removes comments but keeps strings that look like comments', () => {
  const code = 'const a = "http://x.y"; // note\nconst b = 1; /* block\nmore */ const c = `//`;';
  const out = util.stripComments(code);
  assert.match(out, /"http:\/\/x\.y"/);
  assert.match(out, /const c = `\/\/`/);
  assert.doesNotMatch(out, /note|block|more/);
});

test('decodeEntities handles the entities React writes', () => {
  assert.equal(util.decodeEntities('Tom &amp; Jerry&#x27;s &quot;x&quot; &lt;b&gt;'), `Tom & Jerry's "x" <b>`);
});

test('makeRedactor hides known values, JWTs and key prefixes', () => {
  const secret = 'my-very-secret-value';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoieCJ9.abcdefghij';
  const redact = util.makeRedactor([secret]);
  const out = redact(`bad ${secret} and ${jwt} and sbp_${'a'.repeat(20)} and sb_secret_${'b'.repeat(20)}`);
  assert.doesNotMatch(out, /very-secret|eyJ|sbp_a|sb_secret_b/);
  assert.match(out, /\*\*\*/);
});

test('errorText shortens provider errors and redacts', () => {
  const redact = util.makeRedactor(['topsecretvalue']);
  const res = { status: 400, text: JSON.stringify({ msg: 'oops topsecretvalue '.repeat(30) }) };
  const out = util.errorText(res, redact);
  assert.match(out, /^400: /);
  assert.ok(out.length < 200);
  assert.doesNotMatch(out, /topsecretvalue/);
  assert.equal(util.errorText({ status: 500, text: 'not json' }), 'status 500');
  assert.equal(util.errorText({ status: 0, error: 'connection refused' }), 'connection refused');
});

test('joinUrl and locationPath', () => {
  assert.equal(util.joinUrl('https://a.b/', '/x'), 'https://a.b/x');
  assert.equal(util.joinUrl('https://a.b', 'x'), 'https://a.b/x');
  assert.equal(util.locationPath('/sign-in?next=%2Fa', 'https://a.b'), '/sign-in');
  assert.equal(util.locationPath(null, 'https://a.b'), '(unknown)');
});

test('request never throws and describes a refused connection', async () => {
  const res = await util.request('http://127.0.0.1:1/');
  assert.equal(res.status, 0);
  assert.match(res.error, /refused|failed|cut off/);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('my-app.vercel.app/'), 'https://my-app.vercel.app');
  assert.equal(normalizeUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeUrl('https://x.y/base/'), 'https://x.y/base');
  assert.equal(normalizeUrl('ftp://x.y'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(undefined), null);
});

test('readStringList reads literals and ignores other text', () => {
  const code = `const PUBLIC_PREFIXES = [\n  "/a",\n  '/b/c',\n  \`/d\`,\n];\nconst OTHER = ["/z"];`;
  assert.deepEqual(readStringList(code, 'PUBLIC_PREFIXES'), ['/a', '/b/c', '/d']);
  assert.equal(readStringList(code, 'MISSING'), null);
  assert.deepEqual(readStringList('const PUBLIC_PREFIXES: string[] = ["/x"];', 'PUBLIC_PREFIXES'), ['/x']);
});

test('supabaseFromEnv reports what is missing', () => {
  assert.equal(supabaseFromEnv(new Map()).ok, false);
  const r = supabaseFromEnv(new Map([['NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co/']]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are missing/);
  const full = supabaseFromEnv(new Map([
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co/'], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'a'], ['SUPABASE_SERVICE_ROLE_KEY', 'b'],
  ]));
  assert.equal(full.ok, true);
  assert.equal(full.url, 'https://x.supabase.co');
  assert.equal(supabaseFromEnv(new Map([['NEXT_PUBLIC_SUPABASE_URL', 'ftp://x'], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'a'], ['SUPABASE_SERVICE_ROLE_KEY', 'b']])).ok, false);
});

test('test passwords and emails have the right shape', () => {
  const pw = randomPassword();
  assert.ok(pw.includes('$') && pw.includes('!'));
  assert.ok(Buffer.byteLength(pw) <= 72);
  assert.notEqual(pw, randomPassword());
  assert.match(randomTestEmail(), /^shipyard-test-[0-9a-f]{12}@example\.com$/);
});

test('isIdentifier only allows safe table and column names', () => {
  assert.ok(isIdentifier('items') && isIdentifier('user_id'));
  assert.ok(!isIdentifier('a;drop') && !isIdentifier('a.b') && !isIdentifier('1a') && !isIdentifier(''));
});

const sampleResult = (checks, extra = {}) => ({
  ok: checks.every((c) => c.ok), url: 'https://x.y', ranAt: '2026-01-01T00:00:00.000Z', checks, notRun: [], ...extra,
});

test('formatReport shows pass, fail, skipped and the not-checked list', () => {
  const checks = [
    util.pass('routes', '11 pages work', ['all fine']),
    util.failed('isolation', '1 privacy problem found', ['items: other users can read rows'], { details: ['profiles: ok'], warnings: ['careful'] }),
    util.skip('browser', 'Playwright is not installed in the app'),
  ];
  const lines = formatReport(sampleResult(checks, { notRun: ['auth'] }));
  const text = lines.map((l) => `${l.kind}:${l.text}`).join('\n');
  assert.match(text, /ok:Pages: 11 pages work/);
  assert.match(text, /fail:Privacy between users: 1 privacy problem found/);
  assert.match(text, /fail: {2}items: other users can read rows/);
  assert.match(text, /warn:Phone browser: not checked \(Playwright is not installed/);
  assert.match(text, /warn:careful/);
  assert.match(text, /1 of 2 checks failed/);
  assert.match(text, /What verify did not check/);
  assert.match(text, /Sign-in: left out with --only/);
  assert.match(text, /emails/);
});

test('formatReport: green tick only when every check ran; skips are never shown as a clean pass', () => {
  const all = formatReport(sampleResult([util.pass('proxy', 'ok'), util.pass('auth', 'ok')]));
  assert.ok(all.some((l) => l.kind === 'ok' && /All 2 checks passed\./.test(l.text)));

  const partial = formatReport(sampleResult([util.pass('proxy', 'ok'), util.skip('auth', 'no web address')]));
  assert.ok(!partial.some((l) => l.kind === 'ok' && /All /.test(l.text)));
  assert.ok(partial.some((l) => l.kind === 'warn' && /NOT FULLY VERIFIED: 1 check passed, 1 could not run \(Sign-in\)/.test(l.text)));

  const none = formatReport(sampleResult([util.skip('routes', 'no web address')], { ok: false }));
  assert.ok(none.some((l) => l.kind === 'fail' && /NOT VERIFIED: no check could run/.test(l.text)));

  const asked = formatReport(sampleResult([util.pass('proxy', 'ok'), util.skip('auth', 'no web address')], { ok: false }));
  assert.ok(asked.some((l) => l.kind === 'fail' && /NOT VERIFIED: 1 check passed, but these checks you asked for could not run: Sign-in/.test(l.text)));
});

test('isVerified: nothing ran or a picked check was skipped is not success', () => {
  assert.equal(isVerified({ passed: 3, failed: 0, skipped: 5 }, false), true);
  assert.equal(isVerified({ passed: 0, failed: 0, skipped: 8 }, false), false);
  assert.equal(isVerified({ passed: 0, failed: 0, skipped: 0 }, true), false);
  assert.equal(isVerified({ passed: 1, failed: 0, skipped: 1 }, true), false);
  assert.equal(isVerified({ passed: 2, failed: 0, skipped: 0 }, true), true);
  assert.equal(isVerified({ passed: 2, failed: 1, skipped: 0 }, true), false);
});

test('tally and summarizeForProfile', () => {
  const checks = [util.pass('a', 'x'), util.failed('b', 'y', ['p']), util.skip('c', 'r')];
  assert.deepEqual(tally(checks), { passed: 1, failed: 1, skipped: 1 });
  const s = summarizeForProfile(sampleResult(checks));
  assert.deepEqual(s, {
    at: '2026-01-01T00:00:00.000Z', ok: false, url: 'https://x.y', passed: 1, failed: 1, skipped: 1,
    failedChecks: ['b'], skippedChecks: ['c'],
  });
  assert.equal(labelFor('zzz'), 'zzz');
});
