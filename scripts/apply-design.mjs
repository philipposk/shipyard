#!/usr/bin/env node
// Put a look into an app: colours, fonts, corners, theme, DESIGN.md and icons, all from one token file.
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig, writeAppConfig, atomicWrite } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { run } from './lib/run.mjs';
import { loadProfile, saveProfile, getApp, upsertApp } from './lib/profile.mjs';
import { loadPreset, listPresetIds, saveCustomLook, LookError } from './design/presets.mjs';
import { validateTokens, autoFix } from './design/validate.mjs';
import { normalizeTokens, isObject, summarize, withDefaults } from './design/tokens.mjs';
import { planFiles, writePlanned, DesignFileError, FILES } from './design/write-files.mjs';
import { readLayout } from './design/layout-file.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = ['preset', 'screenshot', 'url', 'design-md', 'custom'];
const MAX_TOKEN_FILE = 256 * 1024;

const HELP = `
Put a look into an app: colours, fonts, corner size, text size, spacing, menu style, homepage style,
card and button style, dark mode, DESIGN.md and icons.

Usage:
  node apply-design.mjs <app-folder> --preset <look-name> [options]
  node apply-design.mjs <app-folder> --tokens <file.tokens.json> [--source screenshot|url|design-md] [options]

Options:
  --preset <name>     a ready-made look (see: node design-gallery.mjs) or one you saved
  --tokens <file>     your own look as a tokens file (from a screenshot, website or DESIGN.md)
  --source <kind>     where the look came from: preset, screenshot, url, design-md
  --fix               repair small readability problems (grey text too light, and so on) automatically
  --set-default       use this look for your next apps too
  --keep-layout       keep the app's current menu style (bottom tabs, sidebar or top links)
  --languages <list>  languages the app uses, like en,el (decides which letters the fonts must have)
  --dry-run           show what would change, change nothing
  --no-icons          do not redraw the app icons
  --json              print the result as JSON
  --help              show this text

Changes: src/app/globals.css (the marked colour and shape blocks only), src/lib/theme.ts, src/lib/fonts.ts,
the LAYOUT line in src/lib/constants.ts, public/manifest.webmanifest, DESIGN.md and .shipyard-app.json.
Running it twice gives the same result.
Exit code: 0 done, 1 could not apply, 2 wrong options.
`;

const dateOnly = (iso) => iso.slice(0, 10);

async function loadTokensFile(file) {
  const abs = path.resolve(file);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new ProvisionError(`The design file ${abs} does not exist.`);
  }
  if (!info.isFile()) throw new ProvisionError(`${abs} is not a file.`);
  if (info.size > MAX_TOKEN_FILE) throw new ProvisionError('That design file is too big to be a tokens file.');
  try {
    const parsed = JSON.parse((await readFile(abs, 'utf8')).replace(/^﻿/, ''));
    if (!isObject(parsed)) throw new Error('not an object');
    return normalizeTokens(parsed);
  } catch {
    throw new ProvisionError(`The design file ${abs} is not valid JSON.`);
  }
}

/** Languages: --languages, then the app's own list, then the owner's profile, then English. */
async function pickLanguages({ flag, config, profile }) {
  const clean = (list) => (Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(x)) : []);
  const fromFlag = clean(typeof flag === 'string' ? flag.split(',') : []);
  if (fromFlag.length > 0) return fromFlag;
  const fromApp = clean(config.languages);
  if (fromApp.length > 0) return fromApp;
  const fromProfile = clean(profile?.owner?.languages);
  return fromProfile.length > 0 ? fromProfile : ['en'];
}

/**
 * applyDesign({ appDir, preset | tokens, source, fix, setDefault, dryRun, languages, icons })
 * Returns { ok, ...details }. Throws ProvisionError / LookError / DesignFileError for problems with the inputs.
 */
export async function applyDesign({
  appDir, preset, tokensFile, tokens: givenTokens, source, fix = false, setDefault = false,
  dryRun = false, languages: languagesFlag, icons = true, keepLayout = false, now = new Date(),
}) {
  const config = await readAppConfig(appDir);
  const profile = await loadProfile();
  const languages = await pickLanguages({ flag: languagesFlag, config, profile });

  // 1. load the look
  let tokens;
  let origin = 'file';
  if (preset) {
    const loaded = await loadPreset(preset);
    tokens = loaded.tokens;
    origin = loaded.origin;
  } else if (givenTokens) {
    tokens = normalizeTokens(givenTokens);
  } else {
    tokens = await loadTokensFile(tokensFile);
  }
  const effectiveSource = source ?? (preset ? 'preset' : 'custom');
  const notes = [];

  // a screenshot/website look must not take over the name of a ready-made look
  if (effectiveSource !== 'preset' && origin === 'file' && typeof tokens.id === 'string') {
    const builtIn = await listPresetIds();
    if (builtIn.includes(tokens.id)) {
      const renamed = `${tokens.id}-custom`.slice(0, 41);
      notes.push(`Your look had the same id as a ready-made look, so it is saved as "${renamed}".`);
      tokens = { ...tokens, id: renamed };
    }
  }

  // 2. check it
  let result = validateTokens(tokens, { languages });
  const fixed = [];
  if (!result.ok && fix) {
    const repaired = autoFix(tokens);
    tokens = repaired.tokens;
    fixed.push(...repaired.changes);
    result = validateTokens(tokens, { languages });
  }
  if (!result.ok) {
    return {
      ok: false, applied: false, id: tokens?.id ?? null, errors: result.errors, warnings: result.warnings, fixed,
      error: `This look has problems, so I did not apply it:\n- ${result.errors.join('\n- ')}${fix ? '' : '\nRun again with --fix to let Shipyard repair readability problems.'}`,
    };
  }

  // the look always carries every type and layout setting from here on
  tokens = withDefaults(tokens);
  if (keepLayout) {
    let current = null;
    try {
      current = readLayout(await readFile(path.join(appDir, FILES.constants), 'utf8'));
    } catch {
      current = null;
    }
    if (current) tokens = { ...tokens, layout: { ...tokens.layout, nav: current } };
  }

  // 3. plan every file (fails before anything is written if the app lacks the colour markers)
  const appliedAt = now.toISOString();
  const plan = await planFiles(appDir, tokens, {
    languages, appName: config.name ?? config.slug, source: effectiveSource, date: dateOnly(appliedAt),
  });

  const summary = {
    ok: true, applied: !dryRun, dryRun, id: tokens.id, name: tokens.name, source: effectiveSource,
    summary: summarize(tokens), languages, warnings: result.warnings, fixed, notes: [...notes, ...plan.notes],
    layout: tokens.layout, type: tokens.type,
    files: plan.files.map((f) => ({ file: f.rel, status: f.created ? 'created' : f.changed ? 'changed' : 'unchanged' })),
    tokenChanges: { light: plan.vars.light, dark: plan.vars.dark, shape: plan.vars.shape },
    icons: 'skipped',
  };
  if (dryRun) return summary;

  // 4. write
  await writePlanned(plan.files);
  const design = { source: effectiveSource, id: tokens.id, name: tokens.name, appliedAt };
  await writeAppConfig(appDir, { ...config, layout: tokens.layout.nav, design });
  await mkdir(path.join(appDir, '.shipyard', 'design'), { recursive: true });
  await atomicWrite(path.join(appDir, '.shipyard', 'design', 'applied.tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`);

  // 5. profile: this app's look, and optionally the default for new apps
  const swatches = {
    light: { background: tokens.light.background, accent: tokens.light.accent },
    dark: { background: tokens.dark.background, accent: tokens.dark.accent },
  };
  if (await getApp(config.slug)) await upsertApp({ slug: config.slug, layout: tokens.layout.nav, design: { ...design, swatches } });
  if (setDefault) {
    if (origin === 'file') await saveCustomLook(tokens);
    const fresh = await loadProfile();
    fresh.defaults = { ...(fresh.defaults ?? {}), design: tokens.id };
    await saveProfile(fresh);
    summary.defaultSaved = true;
  }

  // 6. icons (need the app's own Playwright; otherwise they update after npm install)
  if (icons) summary.icons = await updateIcons(appDir);
  return summary;
}

async function updateIcons(appDir) {
  const script = path.join(here, 'design-icons.mjs');
  let hasPlaywright = false;
  try {
    hasPlaywright = (await stat(path.join(appDir, 'node_modules', 'playwright'))).isDirectory();
  } catch {
    hasPlaywright = false;
  }
  if (!hasPlaywright) return 'later';
  try {
    await stat(script);
  } catch {
    return 'later';
  }
  const r = await run('node', [script, appDir, '--json'], { cwd: appDir, timeoutMs: 120_000 });
  return r.code === 0 ? 'updated' : 'failed';
}

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node apply-design.mjs ./my-app --preset warm-friendly');
  }
  if (Boolean(args.preset) === Boolean(args.tokens)) {
    throw new log.UsageError('Choose one: --preset <look-name> or --tokens <file>.');
  }
  if (args.source && !SOURCES.includes(args.source)) {
    throw new log.UsageError(`--source must be one of: ${SOURCES.join(', ')}.`);
  }
  const appDir = await resolveAppDir(args._[0]);
  let r;
  try {
    r = await applyDesign({
      appDir, preset: args.preset, tokensFile: args.tokens, source: args.source, fix: args.fix,
      setDefault: args['set-default'], dryRun: args['dry-run'], languages: args.languages, icons: !args['no-icons'],
      keepLayout: args['keep-layout'],
    });
  } catch (err) {
    if (err instanceof LookError || err instanceof DesignFileError) throw new ProvisionError(err.message);
    throw err;
  }
  if (!r.ok) {
    for (const e of r.errors) log.fail(e);
    if (!args.fix) log.info('Run again with --fix to let Shipyard repair readability problems.');
    return r;
  }
  for (const note of r.notes) log.warn(note);
  for (const change of r.fixed) log.warn(`Fixed: ${change}.`);
  for (const w of r.warnings) log.warn(w);

  const changed = r.files.filter((f) => f.status !== 'unchanged').map((f) => f.file);
  if (r.dryRun) {
    log.ok(`Dry run: "${r.name}" would change ${changed.length === 0 ? 'nothing (already applied)' : changed.join(', ')}.`);
    const lines = [...r.tokenChanges.light.map((c) => ['light', c]), ...r.tokenChanges.dark.map((c) => ['dark', c]), ...r.tokenChanges.shape.map((c) => ['shape', c])];
    for (const [theme, c] of lines.slice(0, 30)) log.info(`${theme} ${c.name}: ${c.from ?? '(new)'} -> ${c.to}`);
    if (lines.length > 30) log.info(`...and ${lines.length - 30} more.`);
    return r;
  }
  log.ok(`Applied "${r.name}". ${r.summary}`);
  log.info(changed.length === 0 ? 'Nothing needed to change: this look was already in place.' : `Changed: ${changed.join(', ')}`);
  if (r.defaultSaved) log.ok('Saved as your default look for new apps.');
  if (r.icons === 'updated') log.ok('App icons redrawn to match.');
  else if (r.icons === 'failed') log.warn('Could not redraw the app icons. Run design-icons.mjs again after npm install.');
  else if (r.icons === 'later') log.info('Icons will update after npm install: run design-icons.mjs on this app folder.');
  return r;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: {
      string: ['preset', 'tokens', 'source', 'languages'],
      boolean: ['fix', 'set-default', 'dry-run', 'no-icons', 'keep-layout'],
    },
    help: HELP,
    main,
  });
}
