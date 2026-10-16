import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTools, playwrightCacheDir, parseVersion, versionAtLeast, osName, INSTALL } from '../scripts/check-tools.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-tools.mjs');

const GOOD = {
  'git --version': { code: 0, stdout: 'git version 2.45.1\n', stderr: '' },
  'gh --version': { code: 0, stdout: 'gh version 2.60.0 (2026-01-01)\nhttps://github.com/cli/cli\n', stderr: '' },
  'gh auth status': { code: 0, stdout: 'Logged in\n', stderr: '' },
  'npx --version': { code: 0, stdout: '10.8.2\n', stderr: '' },
};

function deps(over = {}) {
  const table = { ...GOOD, ...(over.table ?? {}) };
  return {
    run: async (cmd, args) => table[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: 'not found' },
    which: async (cmd) => (cmd === 'gh' && table['gh --version'] ? '/usr/bin/gh' : null),
    platform: 'darwin',
    nodeVersion: 'v22.4.1',
    cacheDir: null,
    ...over,
    table: undefined,
  };
}

const byId = (r, id) => r.tools.find((t) => t.id === id);

test('everything installed: ok, only playwright is a warning', async () => {
  const r = await checkTools(deps());
  assert.equal(r.ok, true);
  assert.equal(r.os, 'macOS');
  for (const id of ['node', 'git', 'gh', 'gh-auth', 'npx']) assert.equal(byId(r, id).ok, true, id);
  assert.equal(byId(r, 'playwright').ok, false);
  assert.equal(byId(r, 'playwright').required, false);
  assert.match(byId(r, 'playwright').install, /playwright install chromium/);
  assert.equal(byId(r, 'git').detail, 'version 2.45.1');
  assert.equal(byId(r, 'gh').detail, 'version 2.60.0');
});

test('old Node fails with the install line for the system', async () => {
  const r = await checkTools(deps({ nodeVersion: 'v18.19.0', platform: 'win32' }));
  assert.equal(r.ok, false);
  assert.equal(byId(r, 'node').ok, false);
  assert.match(byId(r, 'node').detail, /too old/);
  assert.equal(byId(r, 'node').install, INSTALL.node.Windows);
  assert.match(byId(r, 'node').install, /winget/);
  assert.equal(r.os, 'Windows');
});

test('Node 20.9 is the minimum', async () => {
  assert.equal((await checkTools(deps({ nodeVersion: 'v20.8.9' }))).ok, false);
  assert.equal((await checkTools(deps({ nodeVersion: 'v20.9.0' }))).ok, true);
});

test('missing git and gh are required and show install lines per OS', async () => {
  const table = { 'git --version': undefined, 'gh --version': undefined };
  for (const [platform, want] of [['darwin', /brew install gh/], ['win32', /winget install GitHub\.cli/], ['linux', /cli\/cli/]]) {
    const r = await checkTools(deps({ platform, table }));
    assert.equal(r.ok, false);
    assert.equal(byId(r, 'git').ok, false);
    assert.equal(byId(r, 'gh').ok, false);
    assert.match(byId(r, 'gh').install, want);
    assert.equal(byId(r, 'gh-auth').ok, false);
    assert.equal(byId(r, 'gh-auth').required, false);
  }
});

test('not logged in to GitHub is a warning, not a failure', async () => {
  const r = await checkTools(deps({ table: { 'gh auth status': { code: 1, stdout: '', stderr: 'You are not logged in' } } }));
  assert.equal(r.ok, true);
  assert.equal(byId(r, 'gh-auth').ok, false);
  assert.match(byId(r, 'gh-auth').install, /gh auth login --web/);
});

test('npx not working fails', async () => {
  const r = await checkTools(deps({ table: { 'npx --version': { code: 1, stdout: '', stderr: 'boom' } } }));
  assert.equal(r.ok, false);
  assert.equal(byId(r, 'npx').ok, false);
});

test('finds Chromium in the Playwright cache folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pw-'));
  try {
    assert.equal(byId(await checkTools(deps({ cacheDir: dir })), 'playwright').ok, false);
    await mkdir(path.join(dir, 'chromium-1148'));
    assert.equal(byId(await checkTools(deps({ cacheDir: dir })), 'playwright').ok, true);
    const other = await mkdtemp(path.join(os.tmpdir(), 'pw-'));
    await mkdir(path.join(other, 'chromium_headless_shell-1148'));
    assert.equal(byId(await checkTools(deps({ cacheDir: other })), 'playwright').ok, true);
    await rm(other, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('playwrightCacheDir per system', () => {
  assert.equal(playwrightCacheDir({ platform: 'darwin', env: {}, home: '/h' }), path.join('/h', 'Library', 'Caches', 'ms-playwright'));
  assert.equal(playwrightCacheDir({ platform: 'linux', env: {}, home: '/h' }), path.join('/h', '.cache', 'ms-playwright'));
  assert.equal(playwrightCacheDir({ platform: 'linux', env: { XDG_CACHE_HOME: '/x' }, home: '/h' }), path.join('/x', 'ms-playwright'));
  assert.equal(playwrightCacheDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\h' }), path.join('C:\\L', 'ms-playwright'));
  assert.equal(playwrightCacheDir({ platform: 'darwin', env: { PLAYWRIGHT_BROWSERS_PATH: '/custom' }, home: '/h' }), path.resolve('/custom'));
  assert.equal(playwrightCacheDir({ platform: 'darwin', env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, home: '/h' }), null);
});

test('version helpers', () => {
  assert.deepEqual(parseVersion('v22.4.1'), [22, 4, 1]);
  assert.deepEqual(parseVersion('git version 2.45'), [2, 45, 0]);
  assert.equal(parseVersion('nope'), null);
  assert.equal(versionAtLeast([20, 9, 0], [20, 9]), true);
  assert.equal(versionAtLeast([21, 0, 0], [20, 9]), true);
  assert.equal(versionAtLeast([20, 8, 9], [20, 9]), false);
  assert.equal(osName('darwin'), 'macOS');
  assert.equal(osName('freebsd'), 'Linux');
});

// ---- the real script, with stand-in programs on a private PATH (not on Windows) ----

async function stubEnv({ gh = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stubs-'));
  const stub = async (name, body) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
  };
  await symlink('/bin/sh', path.join(dir, 'sh'));
  await stub('git', 'echo "git version 2.40.0"');
  await stub('npx', 'echo "10.0.0"');
  if (gh) await stub('gh', 'if [ "$1" = "auth" ]; then exit 0; fi; echo "gh version 2.50.0 (x)"');
  const pw = await mkdtemp(path.join(os.tmpdir(), 'pwempty-'));
  return { dir, pw, env: { PATH: dir, PLAYWRIGHT_BROWSERS_PATH: pw, NO_COLOR: '1' } };
}

const posix = process.platform === 'win32' ? { skip: 'needs a POSIX shell' } : {};

test('script: exit 0 and readable output when required tools exist', posix, async () => {
  const { dir, pw, env } = await stubEnv();
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ git: version 2\.40\.0/);
    assert.match(r.stdout, /✓ GitHub CLI \(gh\): version 2\.50\.0/);
    assert.match(r.stdout, /! Playwright browser/);
    assert.match(r.stdout, /playwright install chromium/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(pw, { recursive: true, force: true });
  }
});

test('script: exit 1 with --json when gh is missing', posix, async () => {
  const { dir, pw, env } = await stubEnv({ gh: false });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    const gh = out.tools.find((t) => t.id === 'gh');
    assert.equal(gh.ok, false);
    assert.ok(gh.install.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(pw, { recursive: true, force: true });
  }
});

test('script: --help is 0, bad flag is 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
});

test('ffmpeg + ffprobe are optional ("only needed for videos"): missing is a warning with the install line', async () => {
  for (const [platform, want] of [['darwin', /brew install ffmpeg/], ['win32', /winget install Gyan\.FFmpeg/], ['linux', /apt install ffmpeg/]]) {
    const r = await checkTools(deps({ platform }));
    const t = byId(r, 'ffmpeg');
    assert.equal(t.ok, false);
    assert.equal(t.required, false);
    assert.match(t.install, want);
    assert.equal(r.ok, true, 'a missing ffmpeg must not fail the whole check');
  }
});

test('ffmpeg + ffprobe present: ok with the version', async () => {
  const r = await checkTools(deps({
    table: {
      'ffmpeg -version': { code: 0, stdout: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\n', stderr: '' },
      'ffprobe -version': { code: 0, stdout: 'ffprobe version 7.1.1 Copyright (c) 2007-2025\n', stderr: '' },
    },
  }));
  const t = byId(r, 'ffmpeg');
  assert.equal(t.ok, true);
  assert.equal(t.detail, 'version 7.1.1');
  assert.equal(t.install, undefined);
});

test('ffmpeg without ffprobe is not ok and says so', async () => {
  const r = await checkTools(deps({
    table: { 'ffmpeg -version': { code: 0, stdout: 'ffmpeg version 7.1.1\n', stderr: '' } },
  }));
  const t = byId(r, 'ffmpeg');
  assert.equal(t.ok, false);
  assert.match(t.detail, /ffprobe is missing/);
});
