#!/usr/bin/env node
// Create the app's Vercel project and copy its settings there.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { provisionVercel } from './provision/vercel-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up Vercel (where the app runs on the internet) for an app made with Shipyard.

Usage:
  node provision-vercel.mjs <app-folder> [--json]

  --json   print the result as JSON
  --help   show this text

Needs: the app saved to GitHub with the main branch pushed, provision-supabase.mjs done,
and a Vercel login from the setup step.
What it does: creates a Vercel project named after the app, copies the settings the app needs
from .env.local (never printing them), opens the site to visitors and connects GitHub.
It does not deploy: use deploy.mjs for that. You can run it again safely.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node provision-vercel.mjs ./recipe-box');
  }
  const appDir = await resolveAppDir(args._[0]);
  const result = await provisionVercel({ appDir });
  log.ok(`Vercel project "${result.project}" is ready.`);
  log.info('Next: run deploy.mjs to put the app online.');
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
