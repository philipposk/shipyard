#!/usr/bin/env node
// Makes the store icon and the splash picture from the app's own icon (public/icon.svg).
//   resources/icon.png       1024 x 1024, fills the whole square, no transparent layer (the App Store refuses one)
//   resources/icon-mark.png  the icon as it is drawn (rounded corners stay see-through), used for the splash and the Android icon
//   resources/splash.png     2732 x 2732, the app's background colour with the icon in the middle
// It draws the SVG with Playwright, which the app already has once `npm install` has run in the app folder.
// Run it with: npm run icons   (inside the mobile folder)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, flatten, parseHex, splashPicture } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const appDir = path.resolve(mobileDir, '..');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

/** The colour of the icon's first filled shape, which is the icon's background. */
export function iconFill(svg, fallback) {
  const rect = /<rect\b[^>]*\bfill="(#[0-9a-fA-F]{3,6})"/.exec(svg) ?? /<rect\b[^>]*\bfill='(#[0-9a-fA-F]{3,6})'/.exec(svg);
  return parseHex(rect?.[1]) ? rect[1] : fallback;
}

async function loadPlaywright() {
  try {
    return createRequire(path.join(appDir, 'package.json'))('playwright');
  } catch {
    return null;
  }
}

async function main() {
  let svg;
  try {
    svg = await readFile(path.join(appDir, 'public', 'icon.svg'), 'utf8');
  } catch {
    return fail('public/icon.svg is missing. The icons are made from it. Add the app icon there first.');
  }
  let config = {};
  try {
    config = JSON.parse(await readFile(path.join(mobileDir, 'capacitor.config.json'), 'utf8'));
  } catch {
    // fall back to the defaults below
  }
  const bgHex = config?.plugins?.SplashScreen?.backgroundColor ?? config?.ios?.backgroundColor ?? '#ffffff';
  const fill = iconFill(svg, bgHex);

  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    return fail('Playwright is not installed in the app. Run "npm install" in the app folder (one level up from mobile), then run this again.');
  }
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch {
    try {
      browser = await pw.chromium.launch({ channel: 'chrome' });
    } catch {
      return fail('No browser to draw the icon with. Run "npx playwright install chromium" in the app folder (or install Google Chrome), then run this again.');
    }
  }
  try {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const draw = async (background, omitBackground) => {
      const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:${background}"><img alt="" src="${dataUrl}" style="display:block;width:1024px;height:1024px"></body></html>`);
      await page.waitForFunction(() => document.images[0]?.complete);
      const shot = await page.screenshot({ type: 'png', omitBackground });
      await page.close();
      return decodePng(shot);
    };
    const full = await draw(fill, false);
    const mark = await draw('transparent', true);
    const resources = path.join(mobileDir, 'resources');
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, 'icon.png'), encodePng(flatten(full, parseHex(fill)), { alpha: false }));
    await writeFile(path.join(resources, 'icon-mark.png'), encodePng(mark));
    await writeFile(path.join(resources, 'splash.png'), encodePng(splashPicture(2732, 2732, parseHex(bgHex) ?? [255, 255, 255], mark), { alpha: false }));
    console.log('✓ Made resources/icon.png, resources/icon-mark.png and resources/splash.png.');
    console.log('  Next: run "npm run apply-native" after "npm run add:ios" / "npm run add:android" to put them into the phone projects.');
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((err) => fail(`Could not make the icons: ${err.message}`));
}
