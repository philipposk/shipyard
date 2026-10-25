#!/usr/bin/env node
// Says which path an app folder takes.
//   shipyard  .shipyard-app.json is present and valid: design, ops, launch and video apply
//   general   no such file: an existing app Shipyard did not make. Follow the upgrade guide
//   damaged   the file is present but broken. Do not treat that as a general app
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli, isMain, resolveAppDir, APP_CONFIG_FILE, SLUG_RE } from './provision/common.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Say whether a folder is a Shipyard app.

Usage:
  node which-app.mjs <app-folder> [--json]

  shipyard   made by Shipyard. Continue with design, ops, launch or video.
  general    not made by Shipyard. Follow the new-app upgrade guide. Do not stop.
  damaged    .shipyard-app.json is here but broken. Do not treat it as a general app.
`;

/** @returns {Promise<{ kind: 'shipyard' | 'general' | 'damaged', slug?: string }>} */
export async function classifyApp(appDir) {
  const file = path.join(appDir, APP_CONFIG_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'general' };
    throw err;
  }
  try {
    const config = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (config && typeof config.slug === 'string' && SLUG_RE.test(config.slug)) {
      return { kind: 'shipyard', slug: config.slug };
    }
  } catch {
    return { kind: 'damaged' };
  }
  return { kind: 'damaged' };
}

const SAY = {
  general: 'general. This folder was not made by Shipyard. Follow the new-app upgrade guide and do the full standard. Do not stop.',
  damaged: 'damaged. .shipyard-app.json is here but broken. Do not treat this folder as a general app.',
};

export async function main(args) {
  const appDir = await resolveAppDir(args._[0]);
  const found = await classifyApp(appDir);
  if (found.kind === 'shipyard') log.ok(`shipyard. This folder was made by Shipyard (${found.slug}). Continue with this skill.`);
  else if (found.kind === 'general') log.info(SAY.general);
  else log.fail(SAY.damaged);
  return { ok: found.kind !== 'damaged', kind: found.kind, ...(found.slug ? { slug: found.slug } : {}) };
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
