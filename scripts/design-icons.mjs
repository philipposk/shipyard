#!/usr/bin/env node
// Draw the app's icons and share image from its own look and name.
//   public/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, og-image.png
// Uses public/brand-approved/icon.svg when the student put one there; otherwise a simple monogram
// (the first letter, or two for a two-word name) on an accent-coloured rounded square. No gradients.
// The PNGs are drawn by the app's own Playwright browser. Nothing else in the app is changed.
import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { BrowserError, launchChromium, loadPlaywright } from './design/capture/browser.mjs';
import { headingIsSerif, iconPage, monogramSvg, monogramText, ogPage, readAppLook, readBrand } from './design/capture/icons.mjs';

const HELP = `
Draw your app's icons and share image from its look and name.

Usage:
  node design-icons.mjs <app-folder> [--json]

Writes into <app-folder>/public/:
  icon.svg                 the icon (a letter on an accent-coloured rounded square)
  icon-192.png, icon-512.png, icon-maskable-512.png   app icons for phones
  og-image.png             the 1200 by 630 picture shown when the app's link is shared

If you put your own icon at public/brand-approved/icon.svg, that is used instead of the letter.
Nothing else in the app changes. Your app needs npm install to have been run first (it brings the browser tool).

  --json    print the result as JSON
  --help    show this text

Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

const MAX_APPROVED_SVG = 512 * 1024;

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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

/** Read everything the icons depend on from the app folder (no browser). */
export async function readIconInputs(appDir) {
  const config = await readAppConfig(appDir);
  const globalsCss = (await readIfExists(path.join(appDir, 'src', 'app', 'globals.css'))) ?? '';
  const themeTs = (await readIfExists(path.join(appDir, 'src', 'lib', 'theme.ts'))) ?? '';
  const constantsTs = (await readIfExists(path.join(appDir, 'src', 'lib', 'constants.ts'))) ?? '';
  const fontsTs = (await readIfExists(path.join(appDir, 'src', 'lib', 'fonts.ts'))) ?? '';
  const look = readAppLook({ globalsCss, themeTs });
  const brand = readBrand(constantsTs);
  const missing = Object.entries(look.colors).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new ProvisionError(`I could not read the app's colours (missing: ${missing.join(', ')}) from src/app/globals.css. Run the design step on this app first, or restore the marked colour block in that file.`);
  }
  const name = brand.name ?? (typeof config.name === 'string' && config.name.trim() ? config.name.trim() : config.slug);
  const tagline = brand.tagline ?? (typeof config.description === 'string' ? config.description.trim() : '');
  let approved = null;
  const approvedFile = path.join(appDir, 'public', 'brand-approved', 'icon.svg');
  try {
    const info = await stat(approvedFile);
    if (info.isFile() && info.size <= MAX_APPROVED_SVG) {
      const text = await readFile(approvedFile, 'utf8');
      if (/<svg[\s>]/i.test(text)) approved = text;
    }
  } catch {
    approved = null;
  }
  return { name, tagline, look, approved, serif: headingIsSerif(fontsTs) };
}

/**
 * makeIcons({ appDir }) -> { ok, source, text, files: [{ file, status }] }
 * Throws ProvisionError / BrowserError with plain messages.
 */
export async function makeIcons({ appDir, onProgress = () => {} }) {
  const inputs = await readIconInputs(appDir);
  const { name, tagline, look, approved, serif } = inputs;
  const { colors } = look;
  const publicDir = path.join(appDir, 'public');
  await mkdir(publicDir, { recursive: true });

  // 1. the SVG (always written; it needs no browser)
  const svg = approved ?? monogramSvg({ name, accent: colors.accent, accentContrast: colors.accentContrast });
  const files = [];
  const svgFile = path.join(publicDir, 'icon.svg');
  const before = await readIfExists(svgFile);
  if (before !== svg) await writeAtomic(svgFile, svg);
  files.push({ file: 'public/icon.svg', status: before === null ? 'created' : before === svg ? 'unchanged' : 'changed' });

  // 2. the PNGs
  const playwright = await loadPlaywright(appDir);
  onProgress('Opening a browser to draw the icons...');
  const browser = await launchChromium(playwright);
  const dataUrl = approved ? `data:image/svg+xml;base64,${Buffer.from(approved).toString('base64')}` : null;
  const accentSquare = monogramSvg({ name, accent: colors.accent, accentContrast: colors.accentContrast, maskable: true });
  const jobs = [
    { file: 'icon-192.png', width: 192, height: 192, html: iconPage(approved ? { imageDataUrl: dataUrl, size: 192 } : { svg, size: 192 }), transparent: true },
    { file: 'icon-512.png', width: 512, height: 512, html: iconPage(approved ? { imageDataUrl: dataUrl, size: 512 } : { svg, size: 512 }), transparent: true },
    {
      file: 'icon-maskable-512.png', width: 512, height: 512, transparent: false,
      // full-bleed accent, artwork inside the middle 80% (approved artwork is shrunk a little more so its own shape stays whole)
      html: approved ? iconPage({ imageDataUrl: dataUrl, size: 512, background: colors.accent, inset: 0.18 }) : iconPage({ svg: accentSquare, size: 512 }),
    },
    {
      file: 'og-image.png', width: 1200, height: 630, transparent: false,
      html: ogPage({ name, tagline, background: colors.background, foreground: colors.foreground, muted: colors.muted, accent: colors.accent, weight: look.headingWeight, serif, imageDataUrl: dataUrl }),
    },
  ];
  try {
    for (const job of jobs) {
      onProgress(`Drawing ${job.file}...`);
      const context = await browser.newContext({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        await page.setContent(job.html, { waitUntil: 'load' });
        const png = await page.screenshot({ type: 'png', omitBackground: job.transparent });
        const target = path.join(publicDir, job.file);
        const existed = await stat(target).then(() => true, () => false);
        await writeAtomic(target, png);
        files.push({ file: `public/${job.file}`, status: existed ? 'redrawn' : 'created' });
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { ok: true, source: approved ? 'brand-approved' : 'monogram', text: approved ? null : monogramText(name), name, files };
}

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node design-icons.mjs ./my-app');
  const appDir = await resolveAppDir(args._[0]);
  let r;
  try {
    r = await makeIcons({ appDir, onProgress: (m) => log.info(m) });
  } catch (err) {
    if (err instanceof BrowserError) {
      throw new ProvisionError(`${err.message} (The icon.svg file was still written.)`);
    }
    throw err;
  }
  log.ok(r.source === 'brand-approved' ? 'Icons drawn from your approved icon (public/brand-approved/icon.svg).' : `Icons drawn: the letters "${r.text}" in your accent colour.`);
  for (const f of r.files) log.info(`${f.status}: ${f.file}`);
  return r;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
