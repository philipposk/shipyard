// Shared fixtures for the video tests: a fake video engine, a fake app, and a recording stand-in for run().
// No network, no real keys, no real ffmpeg.
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const TEMPLATE = path.join(ROOT, 'template');

export const tempDir = (prefix = 'shipyard-video-test-') => mkdtemp(path.join(os.tmpdir(), prefix));
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

const put = async (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, text);
};

const README = `# Motion product videos (Remotion)

A small engine. Two example products show the whole pattern (see Examples).

## Examples

**Zeta** (\`src/zeta/\`): a real product, a meeting-notes app; this is its landing video (zeta.example.test). 52 s.

\`\`\`bash
node scripts/render.mjs zeta:light            # out/zeta-light-nomusic.mp4
node scripts/render.mjs zeta:dark             # dark cut
\`\`\`

**Acme Tasks** (\`src/acme/\`): a made-up to-do app and the smallest starting point.

\`\`\`bash
node scripts/render.mjs acme:light
\`\`\`

Both voices are committed, so neither render needs an API key.

## 1. Quick start

\`\`\`bash
npm install
cp .env.example .env            # add OPENAI_API_KEY; .env is gitignored
node scripts/render.mjs acme:light
\`\`\`

## 2. Layout

\`\`\`
src/
  zeta/               Example product (full landing video)
  acme/                 Example product (tiny)
\`\`\`
`;

/** A small engine tree (the `motion/` folder) with a made-up neutral example and one other example to be dropped. */
export async function makeFakeEngine(parent = null) {
  const base = parent ?? (await tempDir('shipyard-video-engine-'));
  const root = path.join(base, 'motion');
  await put(root, 'package.json', JSON.stringify({ name: 'motion-video-engine', private: true, dependencies: { remotion: '4.0.532' } }, null, 2));
  await put(root, 'package-lock.json', '{"lockfileVersion":3}');
  await put(root, 'README.md', README);
  await put(root, '.env.example', 'OPENAI_API_KEY=\n');
  await put(root, '.gitignore', 'node_modules\nout/\n.env\n');
  await put(root, 'remotion.config.ts', '// config\n');
  for (const s of ['render', 'voice', 'sheet', 'web', 'stills', 'vspecs', 'browser']) await put(root, `scripts/${s}.mjs`, `// engine ${s}\n`);
  await put(root, 'src/Root.tsx', '// root\n');
  await put(root, 'src/lib.tsx', '// kit\n');
  await put(root, 'src/products.json', '{\n  "Zeta": {"scripts": ["zeta"], "music": "music/pop-track-03.mp3"},\n  "Acme": {"scripts": ["acme"], "music": null, "vertical": true}\n}\n');
  await put(root, 'src/products.ts', "import React from 'react';\nimport {AcmeDemo} from './acme/Demo';\nimport {ZetaDemo} from './zeta/Demo';\nimport {DemoProps} from './types';\n\nexport const DEMOS: Record<string, React.FC<DemoProps>> = {\n  Zeta: ZetaDemo,\n  Acme: AcmeDemo,\n};\n");
  await put(root, 'src/acme/Demo.tsx', '// acme demo\n');
  await put(root, 'src/acme/scenes.tsx', '// acme scenes\n');
  await put(root, 'src/zeta/Demo.tsx', '// zeta demo\n');
  await put(root, 'src/zeta/scenes1.tsx', '// zeta scenes\n');
  await put(root, 'src/scripts/acme.json', '[{"id":"hook","text":"Meet Acme Tasks."}]\n');
  await put(root, 'src/scripts/zeta.json', '[{"id":"hook","text":"Meet Zeta."}]\n');
  await put(root, 'src/timelines/acme.json', JSON.stringify({ tag: 'acme', script: 'acme', fps: 30, xf: 10, total: 90, scenes: [] }));
  await put(root, 'src/timelines/zeta.json', JSON.stringify({ tag: 'zeta', script: 'zeta', fps: 30, xf: 10, total: 90, scenes: [] }));
  await put(root, 'src/timelines/index.ts', "import tl_acme from './acme.json';\nimport tl_zeta from './zeta.json';\n\nexport const TIMELINES = {'acme': tl_acme, 'zeta': tl_zeta};\n");
  await put(root, 'src/captures/index.ts', 'export const CAPTURES = {};\n');
  await put(root, 'public/voice/acme/hook.wav', 'RIFFacme');
  await put(root, 'public/voice/zeta/hook.wav', 'RIFFzeta');
  await put(root, 'public/sfx/click.wav', 'RIFFclick');
  await put(root, 'public/music/SOURCES.txt', 'Music sources.\n- pop-track-03.mp3 = a track: the default music of Zeta in src/products.json.\n');
  await put(root, 'public/music/.gitkeep', '');
  return { base, root };
}

/** A tiny Shipyard app: config + the template's real tsconfig, eslint config and proxy (so the patches are tested on the real text). */
export async function makeFakeApp({ slug = 'recipe-box', withVideo = false } = {}) {
  const parent = await tempDir('shipyard-video-app-');
  const dir = path.join(parent, slug);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await put(dir, '.shipyard-app.json', JSON.stringify({ slug, name: 'Recipe Box', layout: 'bottom-nav', modules: [], env: [] }, null, 2));
  await cp(path.join(TEMPLATE, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
  await cp(path.join(TEMPLATE, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
  await cp(path.join(TEMPLATE, 'src', 'proxy.ts'), path.join(dir, 'src', 'proxy.ts'));
  if (withVideo) await makeVideoDir(dir);
  return { dir, parent };
}

/** A set-up video folder whose scripts are stand-ins (tests replace voice.mjs/render.mjs as needed). */
export async function makeVideoDir(appDir) {
  const v = path.join(appDir, 'video');
  await put(v, 'package.json', '{"name":"motion-video-engine"}');
  await put(v, 'scripts/render.mjs', '// stand-in\n');
  await put(v, 'scripts/voice.mjs', '// stand-in\n');
  await put(v, 'src/products.json', '{"Acme":{"scripts":["acme"],"music":null,"vertical":true}}');
  await put(v, 'src/scripts/launch.json', JSON.stringify([{ id: 'hook', text: 'Meet Recipe Box.' }, { id: 'end', text: 'Try it today.' }]));
  return v;
}

/** run() stand-in: records every call (command, args, cwd, whether env/input were used) and answers from a function. */
export function fakeRun(answer = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const run = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd, env: opts.env, input: opts.input });
    const a = await answer(cmd, args, opts, calls.length - 1);
    return { code: 0, stdout: '', stderr: '', ...a };
  };
  run.calls = calls;
  return run;
}

export const whichAll = async (cmd) => `/usr/bin/${cmd}`;
export const whichNone = async () => null;

export { put, readFile, path };
