#!/usr/bin/env node
// What is set up to keep an eye on an app, and is it working?
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { opsStatus, printStatus } from './ops/status-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Show what is set up to keep an eye on an app, and whether it is working.

Usage:
  node ops-status.mjs <app-folder> [--json]

  --json   print the result as JSON
  --help   show this text

Looks at: the error log module, the health check (and its last run and any open alert), the private password and
address the health check uses (names only, never values), code review settings, auto-merge and the repository
settings it needs, Dependabot, and the date of the last backup. Only reads; changes nothing.
Parts that need GitHub or Vercel say so when they cannot be reached.
Exit code: 0 nothing is broken (parts that are not set up are fine), 1 something that is set up is broken, 2 wrong options.
`;

export async function main(args, deps = {}) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node ops-status.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const result = await opsStatus({ appDir }, deps);
  printStatus(result);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
