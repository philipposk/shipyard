#!/usr/bin/env node
// Checks that the tools Shipyard needs are on this computer.
// It never installs anything: it only prints the exact line to run for your system.
import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { run as realRun, which as realWhich } from './lib/run.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, warn, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const MIN_NODE = [20, 9]; // Next.js 16 needs Node 20.9 or newer

const HELP = `Usage: check-tools.mjs [--json]

Checks Node.js, git, GitHub CLI (gh) and its login, npx, the Playwright
browser used for app checks, and ffmpeg (only needed for videos). Prints what
to run for anything missing.
Exit code: 0 = everything needed is there, 1 = something needed is missing, 2 = bad usage.
`;

export function osName(platform = process.platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

/** The line to type for each tool, per system. Never run by this script. */
export const INSTALL = {
  node: {
    macOS: 'brew install node   (no Homebrew? download the LTS installer from https://nodejs.org)',
    Windows: 'winget install OpenJS.NodeJS.LTS   (or download the LTS installer from https://nodejs.org)',
    Linux: 'Install Node 20 or newer from https://nodejs.org/en/download (or with your package manager / nvm)',
  },
  git: {
    macOS: 'xcode-select --install   (or: brew install git)',
    Windows: 'winget install Git.Git',
    Linux: 'sudo apt install git   (or your distribution\'s package manager)',
  },
  gh: {
    macOS: 'brew install gh',
    Windows: 'winget install GitHub.cli',
    Linux: 'See https://github.com/cli/cli#installation (for Ubuntu/Debian: sudo apt install gh)',
  },
  npx: {
    macOS: 'Reinstall Node from https://nodejs.org (npx comes with it)',
    Windows: 'Reinstall Node: winget install OpenJS.NodeJS.LTS (npx comes with it)',
    Linux: 'Reinstall Node from https://nodejs.org (npx comes with it)',
  },
  'gh-auth': {
    all: 'gh auth login --web   then   gh auth setup-git',
  },
  playwright: {
    all: 'npx --yes playwright install chromium',
  },
  ffmpeg: {
    macOS: 'brew install ffmpeg',
    Windows: 'winget install Gyan.FFmpeg   (then open a new terminal)',
    Linux: 'sudo apt install ffmpeg   (or your distribution\'s package manager)',
  },
};

const installLine = (id, os) => INSTALL[id]?.[os] ?? INSTALL[id]?.all ?? '';

/** Parse "v22.4.1" -> [22, 4, 1]. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(have, min) {
  for (let i = 0; i < min.length; i++) {
    if ((have[i] ?? 0) > min[i]) return true;
    if ((have[i] ?? 0) < min[i]) return false;
  }
  return true;
}

/** Folder where Playwright keeps its browsers on this system (null when it can't be known). */
export function playwrightCacheDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0') return path.resolve(custom);
  if (custom === '0') return null; // browsers live inside each project's node_modules
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

async function hasChromium(dir) {
  if (!dir) return false;
  try {
    const names = await readdir(dir);
    return names.some((n) => /^chromium(_headless_shell)?-\d+/.test(n));
  } catch {
    return false;
  }
}

const firstLine = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

/**
 * Run every check. Everything outside this function (the programs, the system,
 * the folders) can be swapped in `deps` so tests don't touch the real machine.
 * Returns { ok, os, tools: [{ id, name, ok, required, detail, install? }] }.
 */
export async function checkTools(deps = {}) {
  const {
    run = realRun,
    which = realWhich,
    platform = process.platform,
    nodeVersion = process.version,
    env = process.env,
    home = os.homedir(),
    cacheDir,
  } = deps;
  const system = osName(platform);
  const tools = [];
  const add = (id, name, isOk, required, detail) => {
    const t = { id, name, ok: isOk, required, detail };
    if (!isOk) t.install = installLine(id, system);
    tools.push(t);
    return t;
  };

  // Node.js
  const nv = parseVersion(nodeVersion);
  const nodeOk = nv !== null && versionAtLeast(nv, MIN_NODE);
  add('node', 'Node.js', nodeOk, true, nodeOk
    ? `version ${nodeVersion.replace(/^v/, '')}`
    : `version ${String(nodeVersion).replace(/^v/, '')} is too old (need ${MIN_NODE.join('.')} or newer)`);

  // git
  const git = await run('git', ['--version'], { timeoutMs: 15_000 });
  add('git', 'git', git.code === 0, true, git.code === 0
    ? firstLine(git.stdout).replace(/^git version\s*/i, 'version ')
    : 'not installed');

  // GitHub CLI: installed, then logged in
  const ghPath = await which('gh');
  let ghOk = false;
  if (ghPath) {
    const gh = await run('gh', ['--version'], { timeoutMs: 15_000 });
    ghOk = gh.code === 0;
    add('gh', 'GitHub CLI (gh)', ghOk, true, ghOk ? firstLine(gh.stdout).replace(/^gh version\s*/i, 'version ').replace(/\s*\(.*$/, '') : 'installed but not working');
  } else {
    add('gh', 'GitHub CLI (gh)', false, true, 'not installed');
  }
  if (ghOk) {
    const auth = await run('gh', ['auth', 'status'], { timeoutMs: 30_000 });
    add('gh-auth', 'GitHub login', auth.code === 0, false, auth.code === 0
      ? 'logged in'
      : 'not logged in yet (the GitHub step of setup does this)');
  } else {
    add('gh-auth', 'GitHub login', false, false, 'install the GitHub CLI first');
  }

  // npx
  const npx = await run('npx', ['--version'], { timeoutMs: 30_000 });
  add('npx', 'npx', npx.code === 0, true, npx.code === 0 ? `version ${firstLine(npx.stdout)}` : 'not working');

  // Playwright's Chromium (used by the app check). Optional until the first app check.
  const dir = cacheDir === undefined ? playwrightCacheDir({ platform, env, home }) : cacheDir;
  const pw = await hasChromium(dir);
  add('playwright', 'Playwright browser (for app checks)', pw, false, pw
    ? 'Chromium found'
    : 'not installed yet (needed for the phone-screen check; takes about a minute)');

  // ffmpeg + ffprobe (used only by the video skill). Optional.
  const ff = await run('ffmpeg', ['-version'], { timeoutMs: 15_000 });
  const fp = ff.code === 0 ? await run('ffprobe', ['-version'], { timeoutMs: 15_000 }) : { code: 127, stdout: '' };
  const ffOk = ff.code === 0 && fp.code === 0;
  add('ffmpeg', 'ffmpeg (only needed for videos)', ffOk, false, ffOk
    ? firstLine(ff.stdout).replace(/^ffmpeg version\s+(\S+).*$/i, 'version $1')
    : ff.code === 0 ? 'ffmpeg is there but ffprobe is missing (they come together; reinstall ffmpeg)' : 'not installed yet (only needed when you make a video)');

  return { ok: tools.every((t) => t.ok || !t.required), os: system, tools };
}

function printHuman(result) {
  info(`System: ${result.os}`);
  for (const t of result.tools) {
    const line = `${t.name}: ${t.detail}`;
    if (t.ok) ok(line);
    else if (t.required) fail(line);
    else warn(line);
    if (!t.ok && t.install) info(`  To fix, run: ${t.install}`);
  }
  if (result.ok) ok('Everything needed is installed.');
  else fail('Install the missing tools above, then run this check again.');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help'], alias: { h: 'help' } });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args._.length > 0) {
    process.stderr.write(`Unexpected "${args._[0]}". Try --help.\n`);
    return 2;
  }
  if (args.json) setQuiet(true);
  const result = await checkTools();
  if (args.json) json(result);
  else printHuman(result);
  return result.ok ? 0 : 1;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Could not check your tools: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
