// Real screenshots of the student's own app wearing a look.
//
//   renderPreviews({ appDir, items: [{ id, tokens }], views: [{ name, width, height, theme }] })
//     -> [{ id, view, png }]            (png is an absolute path)
//
// It writes <app>/.shipyard/design/<id>.preview.json for each item, starts the app's own `next dev` on a
// free port (loopback only), opens /design-preview/<id>?theme=... in a real browser (Playwright from the
// app's node_modules), waits for the fonts, takes the screenshots into <app>/.shipyard/design/previews/
// and ALWAYS stops the dev server again, checking that the port is closed. All of it happens inside one
// foreground call. Nothing is sent to Supabase or any other service: the preview page needs no sign-in
// and no app data, and the server is started with harmless placeholder keys.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { previewJson } from './preview.mjs';
import { BrowserError, launchChromium, loadPlaywright, NEEDS_INSTALL } from './capture/browser.mjs';

export const PREVIEW_ID_RE = /^[a-z0-9-]{1,40}$/;
export const VIEW_NAME_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_TIMEOUT_MS = 300_000;
const STARTUP_TIMEOUT_MS = 150_000;
const PAGE_TIMEOUT_MS = 60_000;
const FONT_WAIT_MS = 10_000;

/** An error whose message is already written for the student. */
export class RenderError extends Error {
  constructor(message, code = 'render') {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- small pure helpers ----------

/** The id the preview page takes in its address: lower-case words, at most 40 characters. */
export function previewIdFor(id) {
  const clean = String(id ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return PREVIEW_ID_RE.test(clean) ? clean : '';
}

/** Checks the screenshot sizes and names. Returns the cleaned list or throws a RenderError. */
export function checkViews(views) {
  if (!Array.isArray(views) || views.length === 0) throw new RenderError('Say which screenshots to take (for example a phone one and a computer one).', 'views');
  const seen = new Set();
  return views.map((v) => {
    const name = String(v?.name ?? '');
    if (!VIEW_NAME_RE.test(name)) throw new RenderError(`"${name}" is not a good name for a screenshot. Use lower-case words and dashes, like phone-light.`, 'views');
    if (seen.has(name)) throw new RenderError(`Two screenshots are both called "${name}".`, 'views');
    seen.add(name);
    const width = Number(v.width);
    const height = Number(v.height);
    if (!Number.isInteger(width) || width < 240 || width > 3000 || !Number.isInteger(height) || height < 240 || height > 4000) {
      throw new RenderError(`The screenshot "${name}" has a strange size (${v.width} by ${v.height}).`, 'views');
    }
    const theme = v.theme === 'dark' ? 'dark' : 'light';
    return { name, width, height, theme };
  });
}

/** Checks the looks to draw. Returns [{ id, pid, tokens }]. */
export function checkItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new RenderError('Give at least one look to draw.', 'items');
  const used = new Map();
  return items.map((item) => {
    const pid = previewIdFor(item?.id);
    if (!pid) throw new RenderError(`"${item?.id}" is not a usable look name (use lower-case words and dashes).`, 'items');
    if (used.has(pid)) throw new RenderError(`Two looks are both called "${item.id}".`, 'items');
    used.set(pid, true);
    if (!item.tokens || typeof item.tokens !== 'object') throw new RenderError(`The look "${item.id}" has no design in it.`, 'items');
    return { id: String(item.id), pid, tokens: item.tokens };
  });
}

/** The last few lines of the dev server's output, for a plain error message. */
export function tailOf(text, lines = 8) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/** Turns the dev server's own complaints into a sentence a student can act on. */
export function explainServerFailure(log) {
  const text = String(log ?? '');
  if (/another next dev server is already running/i.test(text)) {
    return 'Your app is already running (npm run dev). Stop it with Ctrl+C in the window where it runs, then try again.';
  }
  if (/EADDRINUSE|address already in use/i.test(text)) return 'The port for the preview was taken by something else. Try again.';
  const tail = tailOf(text, 6);
  return `The app would not start in preview mode.${tail ? ` It said:\n${tail}` : ''}`;
}

// ---------- ports and processes ----------

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** True while something answers on the port (127.0.0.1 and ::1). */
export function portIsOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function anyPortOpen(port) {
  return (await portIsOpen(port, '127.0.0.1')) || (await portIsOpen(port, '::1'));
}

function killGroup(pid, signal) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal); // the whole process group: next dev starts helper processes
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Stop a child process and everything it started, then wait until `port` is closed.
 * Returns { closed }. Never throws.
 */
export async function stopTree(child, port, { graceMs = 4000, closeMs = 10_000 } = {}) {
  if (child?.pid) {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else child.once('exit', () => resolve());
    });
    killGroup(child.pid, 'SIGTERM');
    await Promise.race([exited, sleep(graceMs)]);
    killGroup(child.pid, 'SIGKILL'); // anything left in the group
  }
  if (!port) return { closed: true };
  const until = Date.now() + closeMs;
  while (Date.now() < until) {
    if (!(await anyPortOpen(port))) return { closed: true };
    await sleep(200);
  }
  killGroup(child?.pid, 'SIGKILL');
  await sleep(500);
  return { closed: !(await anyPortOpen(port)) };
}

/** If this program is stopped (Ctrl+C) or crashes, the dev server must not stay behind. */
function installExitGuard(child) {
  const kill = () => killGroup(child.pid, 'SIGKILL');
  const onSignal = (signal) => {
    kill();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', kill);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('exit', kill);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

// ---------- the dev server ----------

async function exists(p, kind = 'any') {
  try {
    const s = await stat(p);
    return kind === 'dir' ? s.isDirectory() : kind === 'file' ? s.isFile() : true;
  } catch {
    return false;
  }
}

async function checkApp(appDir) {
  if (!(await exists(path.join(appDir, 'node_modules'), 'dir'))) throw new RenderError(NEEDS_INSTALL, 'no-node-modules');
  const nextBin = path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!(await exists(nextBin, 'file'))) throw new RenderError('Next.js is not installed in this app. Run npm install in your app folder first, then try again.', 'no-next');
  if (!(await exists(path.join(appDir, 'src', 'app', 'design-preview'), 'dir'))) {
    throw new RenderError('This app does not have the design preview page yet (src/app/design-preview), so it was made with an older Shipyard. Ask Shipyard to update the app\'s template files, then try again.', 'no-preview-route');
  }
  return nextBin;
}

/** Placeholder keys: the preview page never talks to Supabase, and this makes sure nothing real could be reached. */
function previewEnv() {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'shipyard-preview-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'shipyard-preview-placeholder',
    NEXT_PUBLIC_ENABLE_PWA: 'false',
    BROWSER: 'none',
  };
}

function startDevServer({ appDir, nextBin, port }) {
  const state = { log: '', exited: false, code: null };
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: appDir,
    env: previewEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const keep = (d) => {
    state.log = (state.log + d).slice(-6000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    state.exited = true;
    state.code = code;
  });
  child.on('error', (err) => {
    state.exited = true;
    state.log += `\n${err.message}`;
  });
  return { child, state };
}

/** Wait until the preview page of the first look answers. */
async function waitUntilReady({ port, pid, state, deadline }) {
  const url = `http://127.0.0.1:${port}/design-preview/${pid}?theme=light`;
  const started = Date.now();
  for (;;) {
    if (state.exited) throw new RenderError(explainServerFailure(state.log), 'server-exited');
    const left = deadline - Date.now();
    if (left <= 0 || Date.now() - started > STARTUP_TIMEOUT_MS) {
      throw new RenderError(`The app took too long to start in preview mode (more than ${Math.max(1, Math.round(Math.min(STARTUP_TIMEOUT_MS, deadline - started) / 1000))} seconds).${state.log ? `\nLast thing it said:\n${tailOf(state.log, 4)}` : ''}`, 'startup-timeout');
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(left, 120_000)), redirect: 'manual' });
      if (res.status === 200) return;
      if (res.status === 404) {
        throw new RenderError('The app answered, but it has no design preview page (it returned "not found"). Ask Shipyard to update the app\'s template files, then try again.', 'no-preview-route');
      }
      if (res.status >= 500) {
        await sleep(600);
        if (state.exited) throw new RenderError(explainServerFailure(state.log), 'server-exited');
        const body = tailOf(state.log, 6);
        throw new RenderError(`The app has an error, so the preview page would not open (status ${res.status}).${body ? `\nIt said:\n${body}` : ''}`, 'app-error');
      }
      throw new RenderError(`The preview page answered with status ${res.status}, which I did not expect.`, 'app-error');
    } catch (err) {
      if (err instanceof RenderError) throw err;
      await sleep(400); // not listening yet
    }
  }
}

// ---------- the browser part ----------

const SETTLE_CSS = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}nextjs-portal{display:none!important}';

async function shoot({ context, base, item, view, file, deadline }) {
  const page = await context.newPage();
  try {
    const left = Math.max(5000, Math.min(PAGE_TIMEOUT_MS, deadline - Date.now()));
    const res = await page.goto(`${base}/design-preview/${item.pid}?theme=${view.theme}`, { waitUntil: 'load', timeout: left });
    if (!res || res.status() !== 200) {
      throw new RenderError(`The preview page for "${item.id}" did not open (status ${res?.status() ?? 'none'}).`, 'page');
    }
    // fonts: the Google CSS link blocks rendering, so this is only the file downloads (capped, offline is fine)
    await page.evaluate((ms) => Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]), FONT_WAIT_MS);
    await page.addStyleTag({ content: SETTLE_CSS });
    try {
      await page.waitForSelector('[data-layout]', { timeout: 15_000 });
    } catch {
      throw new RenderError(`The preview page for "${item.id}" opened but showed nothing from your app.`, 'blank');
    }
    const problem = await page.evaluate(() => {
      const portal = document.querySelector('nextjs-portal');
      const dialog = portal?.shadowRoot?.querySelector('[data-nextjs-dialog], [data-nextjs-dialog-overlay], [role="dialog"]');
      if (dialog) return `Next.js showed an error: ${(dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`;
      if (((document.body.innerText || '').trim()).length < 20) return 'the page is empty';
      return '';
    });
    if (problem) throw new RenderError(`The preview of "${item.id}" is broken: ${problem}`, 'page');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(150);
    await page.screenshot({ path: file, type: 'png' });
  } finally {
    await page.close().catch(() => {});
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Take real screenshots of the app in each look.
 *   options: { appDir, items: [{ id, tokens }], views: [{ name, width, height, theme }],
 *              timeoutMs (whole run, default 5 minutes), onProgress(message), onServerStart({ port, pid }) }
 * Returns [{ id, view, png }] in the order items x views. Throws a RenderError (or BrowserError)
 * with a plain-English message; the dev server is stopped in every case.
 */
export async function renderPreviews({ appDir, items, views, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {}, onServerStart = () => {} }) {
  if (!appDir) throw new RenderError('Say which app folder to take screenshots of.', 'app');
  const root = path.resolve(appDir);
  const list = checkItems(items);
  const sizes = checkViews(views);
  const nextBin = await checkApp(root);
  const playwright = await loadPlaywright(root);

  const designDir = path.join(root, '.shipyard', 'design');
  const outDir = path.join(designDir, 'previews');
  await mkdir(outDir, { recursive: true });
  for (const item of list) await writeAtomic(path.join(designDir, `${item.pid}.preview.json`), previewJson(item.tokens));

  const deadline = Date.now() + timeoutMs;
  const port = await findFreePort();
  onProgress('Starting your app in preview mode...');
  const { child, state } = startDevServer({ appDir: root, nextBin, port });
  const removeGuard = installExitGuard(child);
  let browser;
  let failure = null;
  const results = [];
  try {
    onServerStart({ port, pid: child.pid });
    await waitUntilReady({ port, pid: list[0].pid, state, deadline });
    onProgress('Opening a browser...');
    browser = await launchChromium(playwright);
    const base = `http://127.0.0.1:${port}`;
    const contexts = new Map();
    for (const view of sizes) {
      contexts.set(view.name, await browser.newContext({
        viewport: { width: view.width, height: view.height },
        colorScheme: view.theme,
        deviceScaleFactor: view.width <= 600 ? 2 : 1,
        serviceWorkers: 'block',
      }));
    }
    let n = 0;
    const total = list.length * sizes.length;
    for (const item of list) {
      for (const view of sizes) {
        if (Date.now() > deadline) throw new RenderError('Taking the screenshots took too long, so I stopped. Try fewer looks at once.', 'timeout');
        n += 1;
        onProgress(`Screenshot ${n} of ${total}: ${item.id}, ${view.name}`);
        const file = path.join(outDir, `${item.pid}-${view.name}.png`);
        await shoot({ context: contexts.get(view.name), base, item, view, file, deadline });
        results.push({ id: item.id, view: view.name, png: file });
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    removeGuard();
    if (browser) await browser.close().catch(() => {});
    const { closed } = await stopTree(child, port);
    if (!closed) {
      const msg = `I could not stop the preview server on port ${port}. Close it by hand (look for a node process) before running this again.`;
      if (failure) failure.message = `${failure.message}\n${msg}`;
      else failure = new RenderError(msg, 'server-left-running');
    }
  }
  if (failure) {
    if (failure instanceof RenderError || failure instanceof BrowserError) throw failure;
    throw new RenderError(`Taking the screenshots failed: ${String(failure?.message ?? failure).split('\n')[0]}`, 'render');
  }
  return results;
}

/** Tiny helper for tests and callers: is this file a real PNG (signature check)? */
export async function looksLikePng(file) {
  try {
    const buf = await readFile(file);
    return buf.length > 1000 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    return false;
  }
}
