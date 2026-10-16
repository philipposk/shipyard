#!/usr/bin/env node
// Keep an eye on a live app: health checks, code review, auto-merge of small safe changes, Dependabot.
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { opsSetup, parseOnly } from './ops/setup-core.mjs';
import { PART_HELP } from './ops/common.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Set up the "keep an eye on my app" tools for an app made with Shipyard.

Usage:
  node ops-setup.mjs <app-folder> [--only health,review,automerge,deps] [--apply-settings] [--force-file <path>] [--rotate-secret] [--json]

Parts (all four unless you pick with --only):
  health     ${PART_HELP.health}
  review     ${PART_HELP.review}
  automerge  ${PART_HELP.automerge}
  deps       ${PART_HELP.deps}

  --only LIST        only these parts, separated by commas
  --apply-settings   change the GitHub repository settings that auto-merge needs. Without this flag the settings are only
                     looked at and listed. Use it after the student said yes.
  --force-file PATH  replace one file you changed with the Shipyard version (repeat for more)
  --rotate-secret    make a new CRON_SECRET (the password the health check uses) and send it to Vercel and GitHub again
  --json             print the result as JSON
  --help             show this text

What it does: adds the error log module if the health check needs it, writes the workflow files into
.github/ (and .coderabbit.yaml), makes the labels, sets the SITE_URL variable and the CRON_SECRET password on
GitHub and Vercel (the password is made here and goes through stdin, it is never shown). It never overwrites a
file you changed: it shows what differs. Running it again is safe. Needs: the app on GitHub (pushed), the GitHub
program (gh) logged in, and for the health check an app linked to Vercel.
Exit code: 0 done, 1 something failed, 2 wrong options.
`;

export async function main(args, deps = {}) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node ops-setup.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  const only = parseOnly(args.only);
  const result = await opsSetup({
    appDir, only, forceFiles: args['force-file'], applySettings: args['apply-settings'], rotateSecret: args['rotate-secret'],
  }, deps);
  if (result.ok && result.complete) log.ok('Ops setup is done.');
  else if (result.ok) log.warn('Ops setup is done except for the parts listed above.');
  if (result.next.length > 0) {
    log.info('Next:');
    result.next.forEach((n, i) => log.info(`  ${i + 1}. ${n}`));
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['only', 'force-file'], multiple: ['only', 'force-file'], boolean: ['apply-settings', 'rotate-secret'] },
    help: HELP,
    main,
  });
}
