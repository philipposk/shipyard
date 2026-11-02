#!/usr/bin/env node
// Turn an approved logo (a light and a dark drawing) into every icon the app needs, and the review sheet.
// The PNGs are drawn by the app's own Playwright browser. Pages are not edited: it prints the tags for them.
import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runCli, isMain, ProvisionError, resolveAppDir } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { launchChromium, loadPlaywright } from './design/capture/browser.mjs';
import { combinedSvg, darkManifestName, logoFileNames, logoHeadTags, logoJobs, logoManifests, logoProblems, logoSheetPage } from './design/capture/logo.mjs';

const HELP = `
Make every icon from an approved light and dark logo, or a sheet to review a draft on.

Usage:
  node design-logo.mjs <app-folder> [options]

Reads, unless you name other files:
  public/brand-approved/logo-light.svg   the logo for light mode (a full square, no rounded corners)
  public/brand-approved/logo-dark.svg    the logo for dark mode
  public/brand-approved/logo-mono.svg    optional: one colour on see-through, for phones that tint icons

Writes into public/ (icon is the --prefix):
  icon.svg                               both logos in one file; the browser tab follows the device setting
  icon-32.png, icon-dark-32.png          for browsers that cannot use icon.svg
  icon-192.png, icon-512.png, icon-maskable-512.png, and the same with -dark-
  icon-apple-180.png, icon-dark-apple-180.png, icon-mono-512.png
  manifest.webmanifest and manifest-dark.webmanifest, when the app has a manifest

Options:
  --sheet <file>       only draw a review sheet to this image; nothing else is written
  --name <name>        the name shown on the sheet's browser tab
  --light, --dark, --mono <file>   other drawings
  --out <folder>       where to write, inside the app (default public, or the app folder if it has no public folder)
  --prefix <word>      the start of each file name (default icon)
  --base <path>        where those files are on the site (default /)
  --manifest <files>   manifests to update, separated by commas, inside --out
  --tools <folder>     a folder with Playwright installed, for an app that has none
  --json               print the result as JSON
  --help               show this text

Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function publicOr(appDir) {
  const hasPublic = await stat(path.join(appDir, 'public')).then((s) => s.isDirectory(), () => false);
  return hasPublic ? 'public' : '.';
}

/** The approved pair in public/brand-approved, or null when it is not there. design-icons leaves icons alone then. */
export async function readLogoPair(appDir, files = {}) {
  const dir = path.join(appDir, 'public', 'brand-approved');
  const light = await readIfExists(files.light ? path.resolve(appDir, files.light) : path.join(dir, 'logo-light.svg'));
  const dark = await readIfExists(files.dark ? path.resolve(appDir, files.dark) : path.join(dir, 'logo-dark.svg'));
  const mono = await readIfExists(files.mono ? path.resolve(appDir, files.mono) : path.join(dir, 'logo-mono.svg'));
  if (light === null || dark === null) return null;
  return { light, dark, mono };
}

async function draw(browser, { file, width, height, html, transparent }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const png = await page.screenshot({ type: 'png', omitBackground: transparent, fullPage: width !== height });
    await writeAtomic(file, png);
  } finally {
    await context.close().catch(() => {});
  }
}

const pngPage = (svg) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;

/** makeLogo({ appDir, ... }) -> { ok, files, tags } or, with sheet, { ok, sheet }. */
export async function makeLogo({ appDir, files = {}, out = null, prefix = 'icon', base = '/', manifests = null, sheet = null, name = 'App', tools = null, onProgress = () => {} }) {
  const pair = await readLogoPair(appDir, files);
  if (!pair) throw new ProvisionError('I need both drawings: public/brand-approved/logo-light.svg and logo-dark.svg (or name them with --light and --dark).');
  const problems = [...logoProblems(pair.light, 'The light logo'), ...logoProblems(pair.dark, 'The dark logo'), ...(pair.mono ? logoProblems(pair.mono, 'The one-colour logo') : [])];
  if (problems.length) throw new ProvisionError(problems.join(' '));

  const playwright = await loadPlaywright(tools ? path.resolve(tools) : appDir);
  onProgress('Opening a browser to draw the logo...');
  const browser = await launchChromium(playwright);
  try {
    if (sheet) {
      const file = path.resolve(appDir, sheet);
      await draw(browser, { file, width: 1200, height: 400, html: logoSheetPage({ light: pair.light, dark: pair.dark, name }), transparent: false });
      return { ok: true, sheet: file };
    }
    const outDir = path.resolve(appDir, out ?? (await publicOr(appDir)));
    const written = [];
    const svgFile = logoFileNames(prefix).svg;
    await writeAtomic(path.join(outDir, svgFile), combinedSvg(pair));
    written.push(svgFile);
    for (const job of logoJobs({ prefix, light: pair.light, dark: pair.dark, mono: pair.mono })) {
      onProgress(`Drawing ${job.file}...`);
      await draw(browser, { file: path.join(outDir, job.file), width: job.size, height: job.size, html: pngPage(job.svg), transparent: job.transparent });
      written.push(job.file);
    }
    const list = manifests ?? ((await readIfExists(path.join(outDir, 'manifest.webmanifest'))) !== null ? ['manifest.webmanifest'] : []);
    for (const file of list) {
      const text = await readIfExists(path.join(outDir, file));
      if (text === null) throw new ProvisionError(`The manifest ${file} is not there.`);
      const next = logoManifests(text, { prefix, base, dark: pair.dark, mono: !!pair.mono });
      await writeAtomic(path.join(outDir, file), next.light);
      await writeAtomic(path.join(outDir, darkManifestName(file)), next.dark);
      written.push(file, darkManifestName(file));
    }
    return { ok: true, files: written, tags: logoHeadTags({ prefix, base, manifest: list[0] ? `${base}${list[0]}` : null }) };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node design-logo.mjs ./my-app');
  const appDir = await resolveAppDir(args._[0]);
  const r = await makeLogo({
    appDir,
    files: { light: args.light, dark: args.dark, mono: args.mono },
    out: args.out,
    prefix: args.prefix || 'icon',
    base: args.base || '/',
    manifests: args.manifest ? String(args.manifest).split(',').map((s) => s.trim()).filter(Boolean) : null,
    sheet: args.sheet,
    name: args.name || path.basename(appDir),
    tools: args.tools,
    onProgress: (m) => log.info(m),
  });
  if (r.sheet) {
    log.ok(`Review sheet drawn: ${r.sheet}`);
    return r;
  }
  log.ok(`Logo drawn: ${r.files.length} files.`);
  log.info('Put these in the head of each page, replacing the old icon and manifest tags:');
  log.info(r.tags);
  return r;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['sheet', 'name', 'light', 'dark', 'mono', 'out', 'prefix', 'base', 'manifest', 'tools'] },
    help: HELP,
    main,
  });
}
