// Getting the video engine into an app: fetch one pinned commit, copy `motion/` into <app>/video/,
// drop the engine's own example products except the neutral one, and never touch the student's own work on --update.
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_REPO, ENGINE_SHA, ENGINE_SUBDIR, NEUTRAL_EXAMPLE, pathExists } from './common.mjs';
import { ProvisionError } from '../provision/common.mjs';

const FETCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Get the engine at the pinned commit into `workDir` and return the path of its `motion/` folder.
 * Uses git (init + fetch of that one commit, depth 1), so only that commit is downloaded.
 * `run` is injectable. Throws a plain-English ProvisionError.
 */
export async function fetchEngine({ run, workDir, repo = ENGINE_REPO, sha = ENGINE_SHA }) {
  await mkdir(workDir, { recursive: true });
  const steps = [
    ['init', '-q'],
    ['remote', 'add', 'origin', repo],
    ['fetch', '-q', '--depth', '1', 'origin', sha],
    ['checkout', '-q', '--detach', 'FETCH_HEAD'],
  ];
  for (const args of steps) {
    const r = await run('git', args, { cwd: workDir, timeoutMs: FETCH_TIMEOUT_MS });
    if (r.code !== 0) {
      if (r.code === 127) throw new ProvisionError('git is not installed, so the video engine cannot be downloaded. Run check-tools.mjs for the install line.');
      throw new ProvisionError(`Could not download the video engine from GitHub (${args[0]} failed). Check your internet connection and try again.`);
    }
  }
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: workDir });
  if (head.code !== 0 || head.stdout.trim() !== sha) {
    throw new ProvisionError('The downloaded video engine is not the version Shipyard expects, so it was not used. Try again later.');
  }
  const motion = path.join(workDir, ENGINE_SUBDIR);
  if (!(await pathExists(path.join(motion, 'package.json')))) {
    throw new ProvisionError('The downloaded video engine has no "motion" folder. Try again later.');
  }
  return motion;
}

// ---------------------------------------------------------------------------------------------------------------------
// What belongs to whom
// ---------------------------------------------------------------------------------------------------------------------

/** Never copied from the engine: build output, installs, git data, key files (we do not use the engine's .env flow). */
const SKIP_DIRS = new Set(['node_modules', 'out', '.git']);
const isSkippedFile = (rel) => {
  const base = path.posix.basename(rel);
  return base === '.DS_Store' || base === '.gitignore' || base.startsWith('.env');
};

/**
 * Files and folders that are the student's own work (or generated from it). `--update` never overwrites these.
 * Anything else that comes from the engine is engine code and is refreshed.
 */
export const STUDENT_OWNED = [
  'src/products.json', // which products exist (the student adds theirs)
  'src/products.ts', // which scene component belongs to which product
  'src/scripts/', // narration scripts
  'src/timelines/', // generated from the voice step
  'src/captures/', // list of real-app captures
  'public/voice/', // generated voice files
  'public/music/', // the student's own music + SOURCES.txt
  'public/capture/',
  'public/studio/',
];

export function isStudentOwned(rel) {
  const r = rel.replace(/\\/g, '/');
  return STUDENT_OWNED.some((p) => (p.endsWith('/') ? r.startsWith(p) : r === p));
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (e.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * Which of the engine's own examples must not be copied: every product except the neutral one.
 * Returns { keep, drop: Set<product key>, dirs: Set<'src/x'>, scripts: Set<id>, tags: Set<tag> }.
 */
export async function planExamples(engineRoot) {
  const productsFile = path.join(engineRoot, 'src', 'products.json');
  const products = (await pathExists(productsFile)) ? JSON.parse(await readFile(productsFile, 'utf8')) : {};
  const drop = new Set();
  const dirs = new Set();
  const scripts = new Set();
  for (const [key, meta] of Object.entries(products)) {
    if (key.toLowerCase() === NEUTRAL_EXAMPLE) continue;
    drop.add(key);
    dirs.add(`src/${key.toLowerCase()}`);
    for (const s of meta?.scripts ?? []) scripts.add(s);
  }
  // A timeline's "script" says which product it belongs to; its file name is the tag (voice folder = tag).
  const tags = new Set([...scripts]);
  const tlDir = path.join(engineRoot, 'src', 'timelines');
  if (await pathExists(tlDir)) {
    for (const f of await readdir(tlDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const tl = JSON.parse(await readFile(path.join(tlDir, f), 'utf8'));
        if (scripts.has(tl.script)) tags.add(f.slice(0, -5));
      } catch {
        // an unreadable timeline is simply not an example we recognise
      }
    }
  }
  return { drop, dirs, scripts, tags };
}

export function isExampleFile(rel, plan) {
  for (const d of plan.dirs) if (rel === d || rel.startsWith(`${d}/`)) return true;
  for (const s of plan.scripts) if (rel === `src/scripts/${s}.json`) return true;
  for (const t of plan.tags) {
    if (rel === `src/timelines/${t}.json`) return true;
    if (rel.startsWith(`public/voice/${t}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Small text edits to the few engine files that mention the removed examples
// ---------------------------------------------------------------------------------------------------------------------

function transformProductsJson(text, plan) {
  const products = JSON.parse(text);
  for (const k of plan.drop) delete products[k];
  return `${JSON.stringify(products, null, 2)}\n`;
}

function transformProductsTs(text, plan) {
  const dirNames = [...plan.dirs].map((d) => d.slice('src/'.length));
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s*import\b/.test(line) && dirNames.some((d) => line.includes(`'./${d}/`) || line.includes(`"./${d}/`))) return false;
      for (const k of plan.drop) if (new RegExp(`^\\s*${k}\\s*:`).test(line)) return false;
      return true;
    })
    .join('\n');
}

const ident = (t) => `tl_${t.replace(/[^a-zA-Z0-9]/g, '_')}`;
function timelinesIndex(tags) {
  const sorted = [...tags].sort();
  return [
    '// Generated by scripts/voice.mjs — one entry per timeline JSON in this folder.',
    ...sorted.map((t) => `import ${ident(t)} from './${t}.json';`),
    '',
    `export const TIMELINES = {${sorted.map((t) => `'${t}': ${ident(t)}`).join(', ')}};`,
    '',
  ].join('\n');
}

/** The engine's README describes its own two examples. Keep the neutral one; best-effort, never throws. */
function transformReadme(text, plan) {
  if (plan.drop.size === 0) return text;
  try {
    const lines = text.split('\n');
    const names = [...plan.drop].map((k) => k.toLowerCase());
    const mentions = (l) => names.some((n) => l.toLowerCase().includes(n));
    const start = lines.findIndex((l) => /^\*\*[^*]+\*\*/.test(l) && mentions(l));
    if (start !== -1) {
      let end = lines.findIndex((l, i) => i > start && /^\*\*[^*]+\*\*/.test(l));
      if (end === -1) end = lines.length;
      lines.splice(start, end - start);
    }
    return lines
      .filter((l) => !mentions(l))
      .join('\n')
      .replace('Two example products show the whole pattern (see Examples).', 'An example product shows the whole pattern (see Examples).')
      .replace('Both voices are committed, so neither render needs an API key.', 'The voice is committed, so this render needs no API key.');
  } catch {
    return text;
  }
}

function transformSources(text, plan) {
  const names = [...plan.drop].map((k) => k.toLowerCase());
  return text.split('\n').filter((l) => !names.some((n) => l.toLowerCase().includes(n))).join('\n');
}

/** Keys do not live in a .env file here: Shipyard passes them to the voice step from the keys file. Say so in the README copy. */
function transformEnvMentions(text) {
  return text
    .split('\n')
    .map((l) => (/^cp \.env\.example \.env\b/.test(l)
      ? '# Keys: video-voice.mjs hands them to the voice step from your Shipyard keys file. No .env file is needed here.'
      : l))
    .join('\n');
}

/** Contents of <app>/video/.gitignore. The first four lines are what Shipyard promises; the rest keeps generated files out. */
export const VIDEO_GITIGNORE = [
  '# Shipyard video folder. Keys never live here (they come from your Shipyard keys file).',
  'node_modules/',
  'out/',
  '.env*',
  'public/voice/_raw/',
  '',
  '# Generated while working',
  'public/voice/*.raw.wav',
  'public/voice/*.trim.wav',
  'public/voice/**/*.trim.wav',
  'public/capture/',
  'public/studio/',
  '.DS_Store',
  '',
].join('\n');

/**
 * Copy the engine into `dest`.
 *  - fresh (update:false): copy everything allowed.
 *  - update:true: refresh engine code, but a file the student owns (see STUDENT_OWNED) is only written when it does not exist yet.
 * Returns { copied: [...], kept: [...], droppedExamples: [...] } with paths relative to dest.
 */
export async function copyEngine({ engineRoot, dest, update = false }) {
  const plan = await planExamples(engineRoot);
  const files = await listFiles(engineRoot);
  const copied = [];
  const kept = [];
  const dropped = [];
  await mkdir(dest, { recursive: true });

  const keptTimelineTags = new Set();
  for (const rel of files) {
    if (rel.startsWith('src/timelines/') && rel.endsWith('.json') && !isExampleFile(rel, plan)) {
      keptTimelineTags.add(path.posix.basename(rel, '.json'));
    }
  }

  for (const rel of files) {
    if (isSkippedFile(rel)) continue;
    if (isExampleFile(rel, plan)) {
      dropped.push(rel);
      continue;
    }
    const target = path.join(dest, ...rel.split('/'));
    if (update && isStudentOwned(rel) && (await pathExists(target))) {
      kept.push(rel);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    let data = await readFile(path.join(engineRoot, ...rel.split('/')));
    const edit = (fn) => {
      data = Buffer.from(fn(data.toString('utf8')));
    };
    if (rel === 'src/products.json') edit((t) => transformProductsJson(t, plan));
    else if (rel === 'src/products.ts') edit((t) => transformProductsTs(t, plan));
    else if (rel === 'src/timelines/index.ts') edit(() => timelinesIndex(keptTimelineTags));
    else if (rel === 'README.md') edit((t) => transformEnvMentions(transformReadme(t, plan)));
    else if (rel === 'public/music/SOURCES.txt') edit((t) => transformSources(t, plan));
    await writeFile(target, data);
    copied.push(rel);
  }

  await writeFile(path.join(dest, '.gitignore'), VIDEO_GITIGNORE);
  return { copied, kept, droppedExamples: dropped };
}

/** Remove a folder we created in a temp place. Never throws. */
export async function cleanup(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // nothing to do
  }
}
