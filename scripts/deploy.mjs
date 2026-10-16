#!/usr/bin/env node
// Put an app online on Vercel and check it opens.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { deploy } from './provision/deploy-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Put an app made with Shipyard online (Vercel production) and check that it opens.

Usage:
  node deploy.mjs <app-folder> [--json]

  --json   print the result as JSON
  --help   show this text

Before it deploys it checks that everything is saved and pushed to GitHub, and that no
key or password is in your files. After it deploys it opens the public address to make
sure visitors can see the app (not a Vercel login page), then adds the address to the
Supabase sign-in settings.
Needs provision-supabase.mjs and provision-vercel.mjs done first.
Exit code: 0 online, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app folder, for example: node deploy.mjs ./recipe-box');
  }
  const appDir = await resolveAppDir(args._[0]);
  const result = await deploy({ appDir });
  if (result.ok) {
    log.ok(`Your app is online: ${result.url}`);
    log.info('Next: run verify.mjs to check sign-up, privacy rules and the pages.');
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
