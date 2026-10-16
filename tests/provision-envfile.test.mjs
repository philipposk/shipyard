import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const E = await import('../scripts/provision/envfile.mjs');
const C = await import('../scripts/provision/common.mjs');
const { mergeUriAllowList } = await import('../scripts/lib/supabase-api.mjs');
const { buildAllowList } = await import('../scripts/provision/supabase-core.mjs');

test('mergeEnv adds new keys and keeps every other line', () => {
  const before = '# my notes\nFOO=bar\n\nexport KEEP="me"\n';
  const after = E.mergeEnv(before, { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' });
  assert.equal(after, `${before}NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\n`);
});

test('mergeEnv changes an existing key in place (last one wins) and nothing else', () => {
  const before = 'A=1\nB=old\nC=3\nB=older\n';
  assert.equal(E.mergeEnv(before, { B: 'new' }), 'A=1\nB=old\nC=3\nB=new\n');
  assert.equal(E.mergeEnv('  export B = x\nZ=1\n', { B: 'y' }), 'B=y\nZ=1\n');
});

test('mergeEnv does not match keys that only share a prefix', () => {
  assert.equal(E.mergeEnv('NEXT_PUBLIC_SUPABASE_URL_OLD=x\n', { NEXT_PUBLIC_SUPABASE_URL: 'u' }), 'NEXT_PUBLIC_SUPABASE_URL_OLD=x\nNEXT_PUBLIC_SUPABASE_URL=u\n');
});

test('mergeEnv handles empty files, missing trailing newline and CRLF', () => {
  assert.equal(E.mergeEnv('', { A: '1' }), 'A=1\n');
  assert.equal(E.mergeEnv('X=1', { A: '1' }), 'X=1\nA=1\n');
  assert.equal(E.mergeEnv('X=1\r\nY=2\r\n', { A: '1', X: '9' }), 'X=9\r\nY=2\r\nA=1\r\n');
  assert.equal(E.mergeEnv(undefined, {}), '');
});

test('mergeEnv quotes values that need it and rejects unsafe ones', () => {
  assert.equal(E.mergeEnv('', { A: 'two words' }), "A='two words'\n");
  assert.equal(E.mergeEnv('', { A: 'a$b#c' }), "A='a$b#c'\n");
  assert.equal(E.mergeEnv('', { A: 'eyJhbGciOi.J9.abc-_=' }), 'A=eyJhbGciOi.J9.abc-_=\n');
  assert.equal(E.mergeEnv('', { A: '' }), 'A=\n');
  assert.throws(() => E.mergeEnv('', { A: 'line\nbreak' }), /line break/);
  assert.throws(() => E.mergeEnv('', { A: "it's with space" }), /single quote/);
  assert.throws(() => E.mergeEnv('', { 'bad name': 'x' }), /not a valid variable name/);
});

test('updateEnvFile creates the file privately and keeps unrelated lines on update', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-env-'));
  try {
    const file = path.join(dir, '.env.local');
    await E.updateEnvFile(file, { A: '1' });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0);
    await writeFile(file, '# mine\nA=1\nOTHER=keep\n');
    await E.updateEnvFile(file, { A: '2', B: '3' });
    assert.equal(await readFile(file, 'utf8'), '# mine\nA=2\nOTHER=keep\nB=3\n');
    assert.equal(await E.readEnvText(path.join(dir, 'missing')), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('allow-list merge adds, never removes, and has no duplicates', () => {
  const additions = buildAllowList({ slug: 'box', appUrl: 'https://box.vercel.app', scope: 'my-team' });
  // Only the local address and the app's exact address. No wildcard host patterns: see the test below.
  assert.deepEqual(additions, ['http://localhost:3000/**', 'https://box.vercel.app/**']);
  const merged = mergeUriAllowList('https://other.example/**,http://localhost:3000/**', additions);
  assert.deepEqual(merged.split(','), ['https://other.example/**', 'http://localhost:3000/**', 'https://box.vercel.app/**']);
  assert.equal(mergeUriAllowList(merged, additions), merged, 'a second merge changes nothing');
  // Without an address only the local one is listed.
  assert.deepEqual(buildAllowList({ slug: 'box' }), ['http://localhost:3000/**']);
  assert.deepEqual(buildAllowList({ slug: 'box', appUrl: 'https://box.vercel.app/' }).slice(1, 2), ['https://box.vercel.app/**']);
});

test('the sign-in allow list never contains a wildcard host, so nobody can register a matching address', () => {
  // `https://<slug>-*.vercel.app/**` would also match `https://<slug>-evil.vercel.app`, which anyone with a
  // Vercel account can create, and Supabase would send sign-in tokens there.
  for (const input of [{ slug: 'box' }, { slug: 'box', appUrl: 'https://box.vercel.app' }, { slug: 'box', appUrl: 'https://box.vercel.app', scope: 'my-team' }]) {
    for (const entry of buildAllowList(input)) {
      const host = new URL(entry.replace('/**', '/')).host;
      assert.ok(!host.includes('*'), `${entry} has a wildcard in the host`);
      assert.ok(!/vercel\.app/.test(host) || host === 'box.vercel.app', `${entry} allows more than the app's own address`);
    }
  }
});

test('repoDisplay removes logins and normalises addresses', () => {
  assert.equal(C.repoDisplay('https://me:ghp_secret@github.com/me/box.git'), 'https://github.com/me/box');
  assert.equal(C.repoDisplay('git@github.com:me/box.git'), 'https://github.com/me/box');
  assert.equal(C.repoDisplay('ssh://git@github.com/me/box.git'), 'https://github.com/me/box');
  assert.equal(C.repoDisplay('https://github.com/me/box'), 'https://github.com/me/box');
  assert.equal(C.repoDisplay('not a url'), '');
  assert.equal(C.repoDisplay(''), '');
});

test('originOf keeps only scheme and host, and rejects non-web addresses', () => {
  assert.equal(C.originOf('https://box.vercel.app/some/path?x=1'), 'https://box.vercel.app');
  assert.equal(C.originOf('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => C.originOf('javascript:alert(1)'), /not a web address/);
  assert.throws(() => C.originOf('box.vercel.app'), /not a web address/);
  assert.equal(C.isLocalOrigin('http://localhost:3000'), true);
  assert.equal(C.isLocalOrigin('https://box.vercel.app'), false);
});

test('appEnvNames uses the list in .shipyard-app.json, drops junk and duplicates', () => {
  assert.deepEqual(C.appEnvNames({ env: ['A', 'A', 'b c', 7, 'B_1'] }), ['A', 'B_1']);
  assert.ok(C.appEnvNames({}).includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('readAppConfig explains a missing or damaged file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-cfg-'));
  try {
    await assert.rejects(() => C.readAppConfig(dir), /not made by Shipyard/);
    await writeFile(path.join(dir, C.APP_CONFIG_FILE), '{nope');
    await assert.rejects(() => C.readAppConfig(dir), /damaged/);
    await writeFile(path.join(dir, C.APP_CONFIG_FILE), JSON.stringify({ slug: 'Bad Slug' }));
    await assert.rejects(() => C.readAppConfig(dir), /slug/);
    await C.writeAppConfig(dir, { slug: 'good-one' });
    assert.equal((await C.updateAppConfig(dir, { extra: 1 })).extra, 1);
    assert.equal((await C.readAppConfig(dir)).slug, 'good-one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
