// app-keys.mjs: gives one app the service keys it needs. Fake keys file, temp app folder, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = await mkdtemp(path.join(os.tmpdir(), 'appkeys-home-'));
process.env.SHIPYARD_HOME = HOME;
const { appKeys } = await import('../scripts/app-keys.mjs');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'app-keys.mjs');
after(() => rm(HOME, { recursive: true, force: true }));

const GROQ = 'gsk_' + 'g'.repeat(40);
const fakeSecrets = async () => new Map([['GROQ_API_KEY', GROQ], ['SUPABASE_ACCESS_TOKEN', 'sbp_' + 'x'.repeat(40)]]);

async function makeApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'appkeys-app-'));
  await writeFile(path.join(dir, '.shipyard-app.json'), JSON.stringify({ slug: 'demo', env: ['NEXT_PUBLIC_SUPABASE_URL'] }));
  return dir;
}

test('adds the name to the app config and the value to .env.local (private file), reports missing ones', async () => {
  const dir = await makeApp();
  const r = await appKeys({ appDir: dir, names: ['GROQ_API_KEY', 'DEEPGRAM_API_KEY'] }, { readSecrets: fakeSecrets });
  assert.equal(r.ok, false);
  assert.deepEqual(r.written, ['GROQ_API_KEY']);
  assert.deepEqual(r.missing, ['DEEPGRAM_API_KEY']);
  const cfg = JSON.parse(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'));
  assert.deepEqual(cfg.env, ['NEXT_PUBLIC_SUPABASE_URL', 'GROQ_API_KEY', 'DEEPGRAM_API_KEY']);
  const env = await readFile(path.join(dir, '.env.local'), 'utf8');
  assert.match(env, new RegExp(`^GROQ_API_KEY=${GROQ}$`, 'm'));
  assert.ok(!env.includes('DEEPGRAM'));
  assert.equal((await stat(path.join(dir, '.env.local'))).mode & 0o777, 0o600);
  await rm(dir, { recursive: true, force: true });
});

test('refuses account-level, full-access and real-money keys, and unknown names', async () => {
  const dir = await makeApp();
  for (const n of ['SUPABASE_ACCESS_TOKEN', 'RESEND_API_KEY', 'STRIPE_LIVE_SECRET_KEY', 'MY_THING']) {
    await assert.rejects(appKeys({ appDir: dir, names: [n] }, { readSecrets: fakeSecrets }), { name: 'UsageError' });
  }
  const cfg = JSON.parse(await readFile(path.join(dir, '.shipyard-app.json'), 'utf8'));
  assert.deepEqual(cfg.env, ['NEXT_PUBLIC_SUPABASE_URL'], 'nothing changed');
  await rm(dir, { recursive: true, force: true });
});

test('CLI never prints a key value', async () => {
  const dir = await makeApp();
  await writeFile(path.join(HOME, 'secrets.env'), `GROQ_API_KEY=${GROQ}\n`, { mode: 0o600 });
  const out = spawnSync(process.execPath, [SCRIPT, dir, 'GROQ_API_KEY', '--json'], { env: { ...process.env, SHIPYARD_HOME: HOME }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes(GROQ) && !out.stderr.includes(GROQ));
  assert.deepEqual(JSON.parse(out.stdout).written, ['GROQ_API_KEY']);
  await rm(dir, { recursive: true, force: true });
});
