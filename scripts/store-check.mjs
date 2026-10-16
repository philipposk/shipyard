#!/usr/bin/env node
// Checks what the App Store, Google Play or a desktop download would still ask for. Reads files only.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { storeCheck } from './shells/store-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Check an app's phone and desktop apps for store problems.

Usage:
  node store-check.mjs <app-folder> [--offline] [--json]

  --offline  do not ask the live website for its privacy, terms and support pages
  --json     print the result as JSON

Looks at the mobile and desktop folders of the app: app id, https address, offline page, privacy manifest,
permission texts, icons, STORE.md, account deletion, the public pages, and the desktop window's safety settings.
It also reminds you of Apple's rule 4.2 and Google Play's testing rule. It changes nothing.
Exit code: 0 no problems (reminders are fine), 1 something to fix, 2 wrong options.
`;

export async function main(args, deps = {}) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node store-check.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const result = await storeCheck({ appDir, offline: args.offline }, deps);
  for (const c of result.checks) {
    const text = c.next ? `${c.message} ${c.next}` : c.message;
    if (c.status === 'ok') log.ok(c.message);
    else if (c.status === 'fail') log.fail(text);
    else if (c.status === 'warn') log.warn(text);
    else log.info(c.message);
  }
  const fails = result.checks.filter((c) => c.status === 'fail').length;
  if (!result.skipped) {
    if (fails) log.fail(`${fails} thing${fails === 1 ? '' : 's'} to fix before a store will take the app.`);
    else log.ok('No blocking problems. Read the reminders above before you submit.');
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['offline'] }, help: HELP, main });
}
