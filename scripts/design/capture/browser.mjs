// Finds and starts the browser the design tools use (Playwright from the APP's own node_modules, so the
// plugin itself needs no dependencies). Shared by render-previews, design-from-url and design-icons.
import { createRequire } from 'node:module';
import { access, readdir, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** An error whose message is already written for the student. */
export class BrowserError extends Error {
  constructor(message, code = 'browser') {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

export const NEEDS_INSTALL = 'The app has no node_modules folder yet. Run npm install in your app folder first, then try again.';

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The app's own Playwright, or a BrowserError that says what to do. */
export async function loadPlaywright(appDirInput) {
  const appDir = path.resolve(appDirInput);
  if (!(await isDir(path.join(appDir, 'node_modules')))) throw new BrowserError(NEEDS_INSTALL, 'no-node-modules');
  try {
    const req = createRequire(path.join(appDir, 'package.json'));
    const mod = req('playwright');
    if (mod?.chromium) return mod;
  } catch {
    // fall through to the message below
  }
  throw new BrowserError('Playwright (the tool that opens a real browser) is not installed in this app. Run npm install in your app folder first, then try again.', 'no-playwright');
}

// ---- a browser that is already on this computer ----

/** Folders where Playwright keeps its browsers. */
export function browserCacheRoots(env = process.env, platform = process.platform, home = os.homedir()) {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0') return [path.resolve(custom)];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'ms-playwright')];
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright')];
  return [path.join(home, '.cache', 'ms-playwright')];
}

const EXECUTABLES = [
  // headless shell first: smaller and what Playwright itself uses for headless runs
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-mac/chrome-headless-shell',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-headless-shell-linux/chrome-headless-shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
];

/**
 * Browsers already downloaded into a Playwright cache folder, newest first:
 * [{ revision, path }]. Used when the exact version the app's Playwright wants is missing.
 */
export async function cachedChromiums(root) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name);
    if (!m) continue;
    const dir = path.join(root, name);
    for (const rel of EXECUTABLES) {
      const abs = path.join(dir, ...rel.split('/'));
      try {
        await access(abs, fsConstants.X_OK);
        found.push({ revision: Number(m[2]), shell: m[1] === 'chromium_headless_shell', path: abs });
        break;
      } catch {
        // not this layout
      }
    }
  }
  return found.sort((a, b) => b.revision - a.revision || Number(b.shell) - Number(a.shell));
}

const MISSING_RE = /Executable doesn't exist|playwright install|browserType\.launch: Failed to launch|looks like Playwright was just installed/i;

/**
 * Start headless Chromium. If the exact build is not installed, try any Chromium already in the
 * Playwright cache. Throws a BrowserError with the one command the student needs otherwise.
 */
export async function launchChromium(playwright, { roots = browserCacheRoots(), args = [] } = {}) {
  const options = { headless: true, args };
  let first;
  try {
    return await playwright.chromium.launch(options);
  } catch (err) {
    first = err;
  }
  if (MISSING_RE.test(String(first?.message ?? ''))) {
    for (const root of roots) {
      for (const candidate of await cachedChromiums(root)) {
        try {
          return await playwright.chromium.launch({ ...options, executablePath: candidate.path });
        } catch {
          // try the next one
        }
      }
    }
    throw new BrowserError('The Chromium browser is not installed yet. Run this once in your app folder: npx playwright install chromium', 'no-chromium');
  }
  throw new BrowserError(`The browser would not start: ${String(first?.message ?? first).split('\n')[0].slice(0, 200)}`, 'launch');
}
