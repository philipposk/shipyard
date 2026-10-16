import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_REPO, ENGINE_SHA, ENGINE_SUBDIR, NEUTRAL_EXAMPLE, ID_RE, redactSecrets } from '../scripts/video/common.mjs';
import { copyEngine, fetchEngine, planExamples, isStudentOwned, isExampleFile, VIDEO_GITIGNORE } from '../scripts/video/engine.mjs';
import { tempDir, removeDir, makeFakeEngine, fakeRun, put } from './video-helpers.mjs';

const exists = async (p) => stat(p).then(() => true, () => false);
async function listAll(root) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

test('engine pin: a full 40-character commit, the public repo, the motion folder', () => {
  assert.match(ENGINE_SHA, /^[0-9a-f]{40}$/);
  assert.equal(ENGINE_REPO, 'https://github.com/philipposk/demo-pipeline');
  assert.equal(ENGINE_SUBDIR, 'motion');
  assert.equal(NEUTRAL_EXAMPLE, 'acme');
});

test('ids: tags and script names are safe to put in file names', () => {
  for (const ok of ['launch', 'promo-2', 'A1', 'a_b']) assert.ok(ID_RE.test(ok), ok);
  for (const bad of ['', '-x', 'a/b', '../x', 'a b', 'a;b', 'x'.repeat(41), 'a.b']) assert.ok(!ID_RE.test(bad), bad);
});

test('planExamples: every product except the neutral one is an example to drop', async () => {
  const { base, root } = await makeFakeEngine();
  try {
    const plan = await planExamples(root);
    assert.deepEqual([...plan.drop], ['Zeta']);
    assert.ok(plan.dirs.has('src/zeta'));
    assert.ok(plan.scripts.has('zeta'));
    assert.ok(isExampleFile('src/zeta/Demo.tsx', plan));
    assert.ok(isExampleFile('src/scripts/zeta.json', plan));
    assert.ok(isExampleFile('src/timelines/zeta.json', plan));
    assert.ok(isExampleFile('public/voice/zeta/hook.wav', plan));
    assert.ok(!isExampleFile('src/acme/Demo.tsx', plan));
    assert.ok(!isExampleFile('src/zetaish/x.tsx', plan), 'a folder that only starts with the name is not the example');
    assert.ok(!isExampleFile('public/voice/acme/hook.wav', plan));
  } finally {
    await removeDir(base);
  }
});

test('copy (fresh): only motion/ files, examples stripped except acme, registry files rewritten', async () => {
  const { base, root } = await makeFakeEngine();
  const dest = await tempDir('shipyard-video-dest-');
  try {
    const r = await copyEngine({ engineRoot: root, dest });
    const files = await listAll(dest);
    // The neutral example is kept, the other example is gone everywhere.
    for (const keep of ['src/acme/Demo.tsx', 'src/acme/scenes.tsx', 'src/scripts/acme.json', 'src/timelines/acme.json', 'public/voice/acme/hook.wav',
      'public/sfx/click.wav', 'scripts/render.mjs', 'scripts/voice.mjs', 'src/Root.tsx', 'package.json', 'package-lock.json', 'remotion.config.ts']) {
      assert.ok(files.includes(keep), `missing ${keep}`);
    }
    assert.ok(files.every((f) => !/zeta/i.test(f)), `an example file was copied: ${files.filter((f) => /zeta/i.test(f))}`);
    assert.ok(r.droppedExamples.length >= 4);

    const products = JSON.parse(await readFile(path.join(dest, 'src/products.json'), 'utf8'));
    assert.deepEqual(Object.keys(products), ['Acme']);
    const ts = await readFile(path.join(dest, 'src/products.ts'), 'utf8');
    assert.match(ts, /AcmeDemo/);
    assert.doesNotMatch(ts, /Zeta/);
    const idx = await readFile(path.join(dest, 'src/timelines/index.ts'), 'utf8');
    assert.match(idx, /'acme': tl_acme/);
    assert.doesNotMatch(idx, /zeta/);
    const readme = await readFile(path.join(dest, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /zeta|Zeta/);
    assert.match(readme, /Acme Tasks/);
    assert.match(readme, /An example product shows/);
    assert.match(readme, /No \.env file is needed/);
    assert.doesNotMatch(readme, /cp \.env\.example/);
    const sources = await readFile(path.join(dest, 'public/music/SOURCES.txt'), 'utf8');
    assert.doesNotMatch(sources, /zeta/i);
  } finally {
    await removeDir(base);
    await removeDir(dest);
  }
});

test('copy: never brings key files, .git, node_modules, out, or the engine .gitignore; writes ours', async () => {
  const { base, root } = await makeFakeEngine();
  await put(root, '.env', 'OPENAI_API_KEY=should-never-be-copied');
  await put(root, '.env.local', 'X=1');
  await put(root, 'node_modules/pkg/index.js', 'x');
  await put(root, 'out/x.mp4', 'x');
  await put(root, '.DS_Store', 'x');
  const dest = await tempDir('shipyard-video-dest-');
  try {
    await copyEngine({ engineRoot: root, dest });
    const files = await listAll(dest);
    assert.ok(!files.some((f) => f.startsWith('.env')), 'no .env* file may be copied');
    assert.ok(!files.some((f) => f.startsWith('node_modules/') || f.startsWith('out/') || f === '.DS_Store'));
    const gi = await readFile(path.join(dest, '.gitignore'), 'utf8');
    assert.equal(gi, VIDEO_GITIGNORE);
    for (const line of ['node_modules/', 'out/', '.env*', 'public/voice/_raw/']) assert.ok(gi.split('\n').includes(line), line);
  } finally {
    await removeDir(base);
    await removeDir(dest);
  }
});

test('student-owned paths are recognised', () => {
  for (const p of ['src/products.json', 'src/products.ts', 'src/scripts/launch.json', 'src/timelines/launch.json', 'src/timelines/index.ts',
    'public/voice/launch/hook.wav', 'public/music/track.mp3', 'src/captures/index.ts']) assert.ok(isStudentOwned(p), p);
  for (const p of ['scripts/render.mjs', 'src/lib.tsx', 'src/Root.tsx', 'package.json', 'src/acme/Demo.tsx', 'public/sfx/click.wav']) assert.ok(!isStudentOwned(p), p);
});

test('--update: engine code is refreshed, the student\'s scenes, scripts, voices, registry and timelines are never touched', async () => {
  const { base, root } = await makeFakeEngine();
  const dest = await tempDir('shipyard-video-dest-');
  try {
    await copyEngine({ engineRoot: root, dest });
    // The student works: own scenes folder, script, voice, timeline, registry edits, and also edits an engine file by mistake.
    await put(dest, 'src/mine/Demo.tsx', 'MY SCENES');
    await put(dest, 'src/scripts/launch.json', 'MY SCRIPT');
    await put(dest, 'src/scripts/acme.json', 'EDITED ACME SCRIPT');
    await put(dest, 'public/voice/launch/hook.wav', 'MY VOICE');
    await put(dest, 'src/timelines/launch.json', 'MY TIMELINE');
    await put(dest, 'src/timelines/index.ts', 'MY INDEX');
    await put(dest, 'src/products.json', '{"Mine":{"scripts":["launch"]}}');
    await put(dest, 'src/products.ts', 'MY REGISTRY');
    await put(dest, 'public/music/mine.mp3', 'MY MUSIC');
    await put(dest, 'scripts/render.mjs', 'OLD ENGINE CODE');
    await put(dest, 'package.json', '{"old":true}');

    // The engine moves on.
    await put(root, 'scripts/render.mjs', '// NEW engine render\n');
    await put(root, 'package.json', '{"name":"motion-video-engine","new":true}');
    await put(root, 'src/newfile.tsx', '// new engine file\n');

    const r = await copyEngine({ engineRoot: root, dest, update: true });
    const read = (rel) => readFile(path.join(dest, ...rel.split('/')), 'utf8');
    assert.equal(await read('scripts/render.mjs'), '// NEW engine render\n');
    assert.match(await read('package.json'), /"new":true/);
    assert.equal(await read('src/newfile.tsx'), '// new engine file\n');
    for (const [rel, text] of [['src/mine/Demo.tsx', 'MY SCENES'], ['src/scripts/launch.json', 'MY SCRIPT'], ['src/scripts/acme.json', 'EDITED ACME SCRIPT'],
      ['public/voice/launch/hook.wav', 'MY VOICE'], ['src/timelines/launch.json', 'MY TIMELINE'], ['src/timelines/index.ts', 'MY INDEX'],
      ['src/products.json', '{"Mine":{"scripts":["launch"]}}'], ['src/products.ts', 'MY REGISTRY'], ['public/music/mine.mp3', 'MY MUSIC']]) {
      assert.equal(await read(rel), text, `${rel} must be left alone`);
    }
    assert.ok(r.kept.includes('src/products.json') && r.kept.includes('src/scripts/acme.json'));
    assert.ok(!r.copied.includes('src/products.json'));
  } finally {
    await removeDir(base);
    await removeDir(dest);
  }
});

test('--update puts back a student-owned file that was deleted (so the example keeps working)', async () => {
  const { base, root } = await makeFakeEngine();
  const dest = await tempDir('shipyard-video-dest-');
  try {
    await copyEngine({ engineRoot: root, dest });
    await removeDir(path.join(dest, 'public/voice/acme'));
    await copyEngine({ engineRoot: root, dest, update: true });
    assert.ok(await exists(path.join(dest, 'public/voice/acme/hook.wav')));
  } finally {
    await removeDir(base);
    await removeDir(dest);
  }
});

test('fetchEngine: fetches exactly the pinned commit and checks it', async () => {
  const work = await tempDir('shipyard-video-fetch-');
  try {
    const run = fakeRun(async (cmd, args, opts) => {
      if (args[0] === 'checkout') {
        await put(opts.cwd, 'motion/package.json', '{}');
      }
      if (args[0] === 'rev-parse') return { stdout: `${ENGINE_SHA}\n` };
      return {};
    });
    const motion = await fetchEngine({ run, workDir: work });
    assert.equal(motion, path.join(work, 'motion'));
    const cmds = run.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    assert.ok(cmds.some((c) => c === `git fetch -q --depth 1 origin ${ENGINE_SHA}`), cmds.join('\n'));
    assert.ok(cmds.some((c) => c === `git remote add origin ${ENGINE_REPO}`));
    assert.ok(cmds.every((c) => !/main|master|latest/.test(c)), 'must never ask for a branch');
  } finally {
    await removeDir(work);
  }
});

test('fetchEngine: a different commit, a failed download or a missing git gives a plain error', async () => {
  const work = await tempDir('shipyard-video-fetch-');
  try {
    const wrongSha = fakeRun(async (cmd, args, opts) => {
      if (args[0] === 'checkout') await put(opts.cwd, 'motion/package.json', '{}');
      if (args[0] === 'rev-parse') return { stdout: `${'0'.repeat(40)}\n` };
      return {};
    });
    await assert.rejects(fetchEngine({ run: wrongSha, workDir: work }), /not the version Shipyard expects/);
    const offline = fakeRun(async (cmd, args) => (args[0] === 'fetch' ? { code: 128, stderr: 'fatal: unable to access' } : {}));
    await assert.rejects(fetchEngine({ run: offline, workDir: work }), /Check your internet connection/);
    const noGit = fakeRun(async () => ({ code: 127 }));
    await assert.rejects(fetchEngine({ run: noGit, workDir: work }), /git is not installed/);
  } finally {
    await removeDir(work);
  }
});

test('redactSecrets hides exact key values and key-looking text', () => {
  const key = 'sk-test-abcdefghijklmnop123456';
  const out = redactSecrets(`TTS 401: Incorrect API key provided: ${key}. Also Bearer abcdefghijklmnopqrstuvwxyz and sk-proj-********abcd`, [key]);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('sk-proj-'));
  assert.match(out, /TTS 401/);
});
