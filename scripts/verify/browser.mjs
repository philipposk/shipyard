// Check: the home page opens in a real phone-sized browser, light and dark, with no errors and no sideways scroll.
// Uses the app's own Playwright (npm install in the app). Takes two screenshots into .shipyard/screens/.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { joinUrl, pass, failed, skip } from './util.mjs';

const VIEWPORT = { width: 390, height: 844 };
const NAV_TIMEOUT_MS = 30_000;
const SHOW_MAX = 5;

function loadPlaywright(appDir) {
  try {
    const req = createRequire(path.join(appDir, 'package.json'));
    const mod = req('playwright');
    return mod?.chromium ? mod : null;
  } catch {
    return null;
  }
}

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return x.pathname === '/' ? '/' : x.pathname;
  } catch {
    return 'a request';
  }
};

async function visit(browser, url, scheme, shotPath) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  const bad = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A failed download is reported by the response listener below, with the address.
    if (/^Failed to load resource/.test(text)) return;
    errors.push(text.replace(/\s+/g, ' ').slice(0, 140));
  });
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 140)));
  page.on('response', (r) => {
    const status = r.status();
    const pathname = shortUrl(r.url());
    if (status >= 400 && pathname !== '/favicon.ico') bad.push(`${status} ${pathname}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    if (/ERR_ABORTED/.test(why)) return; // the browser cancelled it on purpose (for example a prefetch)
    bad.push(`failed ${shortUrl(r.url())}`);
  });

  let navError = null;
  try {
    await page.goto(joinUrl(url, '/'), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    // networkidle never settling is not a bug in the app; an unreachable page is.
    try {
      await page.goto(joinUrl(url, '/'), { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    } catch {
      navError = String(err?.message ?? 'page did not load').split('\n')[0].slice(0, 140);
    }
  }

  let scroll = null;
  if (!navError) {
    scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    await page.screenshot({ path: shotPath });
  }
  await context.close();
  return { errors, bad, scroll, navError };
}

export async function check(ctx) {
  const name = 'browser';
  if (!ctx.url) return skip(name, 'no web address given (pass --url, or deploy first)');
  const playwright = loadPlaywright(ctx.appDir);
  if (!playwright) return skip(name, 'Playwright is not installed in the app (run npm install in the app folder)');

  const screensDir = path.join(ctx.appDir, '.shipyard', 'screens');
  await mkdir(screensDir, { recursive: true });

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(String(err?.message))) {
      return skip(name, 'the Chromium browser is not installed (run: npx playwright install chromium)');
    }
    return failed(name, 'could not start the browser', [String(err?.message ?? '').split('\n')[0].slice(0, 160)]);
  }

  const details = [];
  const problems = [];
  const screens = [];
  try {
    for (const scheme of ['light', 'dark']) {
      const file = path.join(screensDir, `home-${scheme}.png`);
      const r = await visit(browser, ctx.url, scheme, file);
      if (r.navError) {
        problems.push(`${scheme}: the home page did not load (${r.navError})`);
        continue;
      }
      screens.push(path.relative(ctx.appDir, file).split(path.sep).join('/'));
      if (r.scroll.scrollWidth > r.scroll.innerWidth + 1) {
        problems.push(`${scheme}: the page scrolls sideways on a phone (content is ${r.scroll.scrollWidth}px wide, the screen is ${r.scroll.innerWidth}px)`);
      }
      for (const e of r.errors.slice(0, SHOW_MAX)) problems.push(`${scheme}: error in the browser console: ${e}`);
      for (const b of r.bad.slice(0, SHOW_MAX)) problems.push(`${scheme}: a request failed: ${b}`);
      const hidden = Math.max(0, r.errors.length - SHOW_MAX) + Math.max(0, r.bad.length - SHOW_MAX);
      if (hidden > 0) problems.push(`${scheme}: ${hidden} more errors not shown`);
      if (r.errors.length === 0 && r.bad.length === 0 && r.scroll.scrollWidth <= r.scroll.innerWidth + 1) {
        details.push(`${scheme}: loads cleanly, fits a 390px phone screen`);
      }
    }
  } catch (err) {
    problems.push(`the browser stopped early: ${String(err?.message ?? '').split('\n')[0].slice(0, 140)}`);
  } finally {
    await browser.close().catch(() => {});
  }
  if (screens.length > 0) details.push(`screenshots: ${screens.join(', ')}`);

  if (problems.length > 0) return failed(name, `${problems.length} problem${problems.length === 1 ? '' : 's'} on the home page`, problems, { details, screens });
  return pass(name, 'home page looks fine in light and dark on a phone', details, { screens });
}
