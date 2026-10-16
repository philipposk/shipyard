#!/usr/bin/env node
// Draft a look from a website the student likes. Opens the page in a real browser (Playwright from the
// APP's node_modules) at a computer size and a phone size, reads the computed colours, fonts, corner size
// and layout feel, and writes a draft token file plus two screenshots into <app>/.shipyard/design/.
// Style, not brand: no logos, images, icons, text, fonts or brand names are saved. The screenshots stay
// on this computer (the folder is ignored by git).
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { missingGitignore } from './design/gitignore.mjs';
import { loadProfile } from './lib/profile.mjs';
import { validateTokens, autoFix } from './design/validate.mjs';
import { withDefaults } from './design/tokens.mjs';
import { BrowserError, launchChromium, loadPlaywright } from './design/capture/browser.mjs';
import { extractPageData } from './design/capture/extract.mjs';
import { buildDraft, describeDraft } from './design/capture/draft.mjs';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const NETWORK_IDLE_CAP_MS = 20_000;
const NAV_TIMEOUT_MS = 30_000;
const TOTAL_CAP_MS = 120_000;

const HELP = `
Draft a look from a website you like, as a starting point.

Usage:
  node design-from-url.mjs <web-address> --app <app-folder> [--json]

It opens the page in a real browser on a computer-sized and a phone-sized screen (and once more asking
for dark mode), reads the colours, fonts, corner size and layout, and writes into <app-folder>/.shipyard/design/:
  url-draft.tokens.json   the draft look (check it, then apply it)
  url-desktop.png         what the page looked like on a computer
  url-phone.png           what it looked like on a phone

Only the style is copied: colours, the nearest free font, corner size and layout feel. Never logos, images,
icons, text or brand names. The screenshots stay on your computer.
Your app needs npm install to have been run first (it brings the browser tool).

  --app <folder>  the app the look is for (required)
  --json          print the result as JSON
  --help          show this text

Only http and https addresses work. Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

/** Turns what a person typed into an address we may open, or throws a plain-English error. */
export function checkUrl(input) {
  let text = String(input ?? '').trim();
  if (text === '') throw new ProvisionError('Give a web address, for example: https://example.com');
  if (text.length > 2000) throw new ProvisionError('That web address is far too long.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new ProvisionError(`"${input}" is not a web address. Use something like https://example.com`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ProvisionError(`Only web addresses starting with http:// or https:// work here, not ${u.protocol}`);
  }
  if (u.username || u.password) throw new ProvisionError('Please remove the user name and password from the address. Do not put a password in a web address.');
  if (!u.hostname) throw new ProvisionError(`"${input}" is not a web address. Use something like https://example.com`);
  return u.href;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function pickLanguages(config) {
  const clean = (list) => (Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(x)) : []);
  const fromApp = clean(config.languages);
  if (fromApp.length > 0) return fromApp;
  let profile = null;
  try {
    profile = await loadProfile();
  } catch {
    profile = null;
  }
  const fromProfile = clean(profile?.owner?.languages);
  return fromProfile.length > 0 ? fromProfile : ['en'];
}

/** Load the page once and read it. Returns { data, finalUrl, status }. Clicks nothing, closes nothing on the page. */
async function readPage(browser, url, { width, height, scheme, screenshot, deadline }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    acceptDownloads: false,
    serviceWorkers: 'block',
    locale: 'en-US',
  });
  try {
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {})); // an alert would freeze the page; this does not click anything on it
    const left = Math.max(5000, Math.min(NAV_TIMEOUT_MS, deadline - Date.now()));
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left });
    } catch (err) {
      const why = String(err?.message ?? err).split('\n')[0];
      if (/ERR_NAME_NOT_RESOLVED/.test(why)) throw new ProvisionError('I could not find that website. Check the spelling of the address and your internet connection.');
      if (/ERR_UNSAFE_PORT/.test(why)) throw new ProvisionError('Browsers refuse to open addresses with that port number. Check the address.');
      if (/ERR_CONNECTION_REFUSED/.test(why)) throw new ProvisionError('The website refused the connection. Is the address right, and is it running?');
      if (/Timeout/i.test(why)) throw new ProvisionError('The page took too long to open (more than 30 seconds).');
      throw new ProvisionError(`I could not open that page: ${why.slice(0, 160)}`);
    }
    const status = response?.status() ?? 0;
    if (status >= 400) throw new ProvisionError(`The website answered with an error (status ${status}), so there is nothing to copy the look from.`);
    await page.waitForLoadState('networkidle', { timeout: Math.min(NETWORK_IDLE_CAP_MS, Math.max(1000, deadline - Date.now())) }).catch(() => {});
    await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true)).catch(() => {});
    await page.waitForTimeout(400);
    const data = await page.evaluate(extractPageData, { maxButtons: 16 });
    if (screenshot) await page.screenshot({ path: screenshot, type: 'png' });
    return { data, finalUrl: page.url(), status };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * captureUrl({ url, appDir, onProgress }) -> { ok, draftPath, desktopPng, phonePng, tokens, summary: [lines], ... }
 */
export async function captureUrl({ url, appDir, onProgress = () => {} }) {
  const address = checkUrl(url);
  const config = await readAppConfig(appDir);
  const languages = await pickLanguages(config);
  const playwright = await loadPlaywright(appDir);

  const outDir = path.join(appDir, '.shipyard', 'design');
  await mkdir(outDir, { recursive: true });
  const desktopPng = path.join(outDir, 'url-desktop.png');
  const phonePng = path.join(outDir, 'url-phone.png');
  const draftPath = path.join(outDir, 'url-draft.tokens.json');
  const deadline = Date.now() + TOTAL_CAP_MS;

  const browser = await launchChromium(playwright);
  let desktop;
  let phone;
  let dark = null;
  let finalUrl = address;
  try {
    onProgress('Opening the page on a computer-sized screen...');
    ({ data: desktop, finalUrl } = await readPage(browser, address, { ...DESKTOP, scheme: 'light', screenshot: desktopPng, deadline }));
    onProgress('Opening it on a phone-sized screen...');
    ({ data: phone } = await readPage(browser, address, { ...PHONE, scheme: 'light', screenshot: phonePng, deadline }));
    onProgress('Checking if the site has a dark mode...');
    try {
      ({ data: dark } = await readPage(browser, address, { ...DESKTOP, scheme: 'dark', deadline }));
    } catch {
      dark = null; // the light reading is enough
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const draft = buildDraft({ desktop, phone, dark });
  let tokens = draft.tokens;
  let result = validateTokens(tokens, { languages });
  let fixed = [];
  if (!result.ok || result.warnings.length > 0) {
    const repaired = autoFix(tokens);
    if (repaired.changes.length > 0) {
      tokens = repaired.tokens;
      fixed = repaired.changes;
      result = validateTokens(tokens, { languages });
    }
  }
  tokens = withDefaults(tokens);
  await writeAtomic(draftPath, `${JSON.stringify(tokens, null, 2)}\n`);

  let host = '';
  try {
    host = new URL(finalUrl).host;
  } catch {
    host = '';
  }
  const summary = describeDraft(tokens, {
    fixed, warnings: result.warnings, hasOwnDark: draft.hasOwnDark, darkOnly: draft.darkOnly, fonts: draft.fonts, accentFrom: draft.accentFrom,
  });
  const gitignoreWarning = await missingGitignore(appDir, ['.shipyard', 'design-input']);
  return {
    ok: result.ok,
    error: result.ok ? undefined : `The draft still has problems:\n- ${result.errors.join('\n- ')}`,
    source: host,
    draftPath,
    desktopPng,
    phonePng,
    tokens,
    fixed,
    warnings: result.warnings,
    errors: result.errors,
    summary,
    guesses: draft.reasons,
    hasOwnDark: draft.hasOwnDark,
    gitignoreWarning,
  };
}

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the web address, for example: node design-from-url.mjs https://example.com --app ./my-app');
  if (!args.app) throw new log.UsageError('Say which app the look is for with --app <app-folder>.');
  const appDir = await resolveAppDir(args.app);
  checkUrl(args._[0]); // fail on a bad address before anything starts
  let r;
  try {
    r = await captureUrl({ url: args._[0], appDir, onProgress: (m) => log.info(m) });
  } catch (err) {
    if (err instanceof BrowserError) throw new ProvisionError(err.message);
    throw err;
  }
  log.ok(`Draft look written for ${r.source || 'that site'}: ${r.draftPath}`);
  log.info('I copied the style only (colours, nearest free font, corner size, layout feel), never logos, images, text or brand names.');
  for (const line of r.summary) log.info(line);
  log.info(`Screenshots: ${r.desktopPng}`);
  log.info(`             ${r.phonePng}`);
  if (r.gitignoreWarning) log.warn(r.gitignoreWarning);
  if (!r.ok) for (const e of r.errors) log.fail(e);
  log.info('Look at the two screenshots, then tell me what to change before I apply it.');
  return r;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['app'] }, help: HELP, main });
}
