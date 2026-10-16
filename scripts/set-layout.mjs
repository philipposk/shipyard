#!/usr/bin/env node
// Switch an app between bottom tabs, a left sidebar and top-bar links.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig, writeAppConfig, atomicWrite } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { getApp, upsertApp } from './lib/profile.mjs';
import { LAYOUTS, withLayout, readLayout } from './design/layout-file.mjs';

export { LAYOUTS, withLayout };
const CONSTANTS = path.join('src', 'lib', 'constants.ts');

const HELP = `
Switch an app between its three menu layouts.

Usage:
  node set-layout.mjs <app-folder> bottom-nav|sidebar|top-nav [--json]

  bottom-nav   top bar plus tabs at the bottom (phone-first apps)
  sidebar      a menu on the left on wide screens, tabs on phones (tools and dashboards)
  top-nav      links in the top bar on wide screens, tabs on phones (content, shops, sites)

Changes the LAYOUT line in src/lib/constants.ts and the app's saved settings.
Exit code: 0 done, 1 could not change it, 2 wrong options.
`;

export async function setLayout(appDir, layout) {
  if (!LAYOUTS.includes(layout)) throw new log.UsageError(`The layout must be "bottom-nav", "sidebar" or "top-nav", not "${layout}".`);
  const config = await readAppConfig(appDir);
  const file = path.join(appDir, CONSTANTS);
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    throw new ProvisionError(`There is no ${CONSTANTS.replaceAll(path.sep, '/')} in this folder, so it does not look like a Shipyard app.`);
  }
  const next = withLayout(source, layout);
  if (next === null) {
    throw new ProvisionError(`I could not find the line "export const LAYOUT = ..." in ${CONSTANTS.replaceAll(path.sep, '/')}. Put it back the way the template has it, then try again.`);
  }
  const previous = readLayout(source);
  if (next !== source) await atomicWrite(file, next);
  await writeAppConfig(appDir, { ...config, layout });
  if (await getApp(config.slug)) await upsertApp({ slug: config.slug, layout });
  return { ok: true, layout, previous, changed: previous !== layout };
}

export async function main(args) {
  if (args._.length !== 2) throw new log.UsageError('Give the app folder and the layout, for example: node set-layout.mjs ./my-app sidebar');
  const appDir = await resolveAppDir(args._[0]);
  const r = await setLayout(appDir, args._[1]);
  if (r.changed) log.ok(`Layout is now ${r.layout}${r.previous ? ` (was ${r.previous})` : ''}.`);
  else log.ok(`Layout was already ${r.layout}. Nothing to change.`);
  return r;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
