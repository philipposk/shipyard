import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { check } from '../scripts/verify/browser.mjs';
import { tempDir, removeDir } from './verify-helpers.mjs';

// A stand-in for the `playwright` package: records what the check does and replays a scenario from scenario.json.
const FAKE_PLAYWRIGHT = `
const fs = require('node:fs');
const path = require('node:path');
const scenario = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
exports.chromium = {
  async launch(o = {}) {
    const s = scenario();
    globalThis.__launches = (globalThis.__launches ?? []).concat([o.channel ?? 'bundled']);
    if (s.launchError && !(o.channel === 'chrome' && s.chromeWorks)) throw new Error(s.launchError);
    return {
      async newContext(opts) {
        const handlers = {};
        const page = {
          on(evt, cb) { handlers[evt] = cb; },
          async goto(url) {
            if (s.navFail) throw new Error(s.navFail);
            for (const m of s.consoleErrors ?? []) handlers.console?.({ type: () => 'error', text: () => m });
            handlers.console?.({ type: () => 'error', text: () => 'Failed to load resource: the server responded with a status of 404' });
            for (const b of s.responses ?? []) handlers.response?.({ status: () => b.status, url: () => 'http://x.test' + b.path });
            for (const f of s.requestFailures ?? []) handlers.requestfailed?.({ failure: () => ({ errorText: f.why }), url: () => 'http://x.test' + f.path });
          },
          async evaluate() { return { scrollWidth: (s.scrollWidth?.[opts.colorScheme]) ?? 390, innerWidth: opts.viewport.width }; },
          async screenshot({ path: p }) { fs.writeFileSync(p, 'png'); },
        };
        globalThis.__viewports = (globalThis.__viewports ?? []).concat([[opts.viewport.width, opts.viewport.height, opts.colorScheme]]);
        return { async newPage() { return page; }, async close() {} };
      },
      async close() {},
    };
  },
};
`;

async function appWithPlaywright(t, scenario = {}) {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  const pkg = path.join(dir, 'node_modules', 'playwright');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.js' }));
  await writeFile(path.join(pkg, 'index.js'), FAKE_PLAYWRIGHT);
  await writeFile(path.join(pkg, 'scenario.json'), JSON.stringify(scenario));
  return dir;
}
const run = (dir) => check({ appDir: dir, url: 'https://app.test', app: null, secrets: new Map() });

test('skipped when Playwright is not installed in the app', async (t) => {
  const dir = await tempDir();
  t.after(() => removeDir(dir));
  const r = await run(dir);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /npm install/);
});

test('skipped without a web address', async (t) => {
  const dir = await appWithPlaywright(t);
  const r = await check({ appDir: dir, url: null, app: null, secrets: new Map() });
  assert.equal(r.skipped, true);
});

test('a clean page passes in light and dark and saves two screenshots', async (t) => {
  const dir = await appWithPlaywright(t);
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.screens, ['.shipyard/screens/home-light.png', '.shipyard/screens/home-dark.png']);
  assert.deepEqual((await readdir(path.join(dir, '.shipyard', 'screens'))).sort(), ['home-dark.png', 'home-light.png']);
  assert.match(r.details.join('\n'), /light: loads cleanly, fits a 390px/);
  assert.match(r.details.join('\n'), /dark: loads cleanly/);
  assert.deepEqual(globalThis.__viewports?.slice(-2), [[390, 844, 'light'], [390, 844, 'dark']]);
});

test('console errors, failed requests and sideways scroll are reported; favicon and aborted requests are not', async (t) => {
  const dir = await appWithPlaywright(t, {
    consoleErrors: ['Uncaught TypeError: x is not a function'],
    responses: [{ status: 404, path: '/api/missing?token=abc' }, { status: 404, path: '/favicon.ico' }, { status: 200, path: '/ok' }],
    requestFailures: [{ why: 'net::ERR_ABORTED', path: '/prefetch' }, { why: 'net::ERR_CONNECTION_REFUSED', path: '/font.woff2' }],
    scrollWidth: { dark: 520 },
  });
  const r = await run(dir);
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /light: error in the browser console: Uncaught TypeError/);
  assert.match(text, /light: a request failed: 404 \/api\/missing/);
  assert.match(text, /light: a request failed: failed \/font\.woff2/);
  assert.doesNotMatch(text, /favicon|prefetch|Failed to load resource|token=abc/);
  assert.match(text, /dark: the page scrolls sideways on a phone \(content is 520px wide, the screen is 390px\)/);
});

test('a missing Chromium download is a skip with the install command', async (t) => {
  const dir = await appWithPlaywright(t, { launchError: "browserType.launch: Executable doesn't exist at /x" });
  const r = await run(dir);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /npx playwright install chromium/);
});

test('a missing bundled Chromium falls back to the installed Google Chrome', async (t) => {
  const dir = await appWithPlaywright(t, { launchError: "browserType.launch: Executable doesn't exist at /x", chromeWorks: true });
  const r = await run(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(globalThis.__launches.slice(-2), ['bundled', 'chrome']);
});

test('another launch error fails with a short message', async (t) => {
  const dir = await appWithPlaywright(t, { launchError: 'out of memory\nlong stack' });
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['out of memory']);
});

test('a page that does not load is reported for both themes', async (t) => {
  const dir = await appWithPlaywright(t, { navFail: 'net::ERR_CONNECTION_REFUSED at http://app.test' });
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /light: the home page did not load/);
  assert.match(r.problems.join('\n'), /dark: the home page did not load/);
});
