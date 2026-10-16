#!/usr/bin/env node
// The go-live gate: is the app ready for other people (and, with --live, for real money)?
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { launchCheck } from './launch/check-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Check that your app is ready to launch.

Usage:
  node launch-check.mjs <app-folder> [--live] [--url <address>] [--json]

  --live        the strict list for taking real money: things that are only warnings while you try things out
                (own domain, confirmed sign-ups, real emails, Vercel Pro, live Stripe) become failures
  --url <addr>  check this address instead of the one saved for the app
  --json        print the result as JSON

Runs the app's own checks (verify.mjs), then: the legal pages name you and list every service; the live site opens
/privacy, /terms and /pricing; the app can be installed; sign-ups need a confirmed email; the sending domain is
verified; Stripe has the prices, webhook and portal; people can delete their account and withdraw from a
subscription; the phone and desktop apps pass store-check. Each failure says what to run next.
It changes nothing. Keys are never printed.
Exit code: 0 nothing failed (warnings are fine), 1 something failed, 2 wrong options.
`;

const MARK = { ok: log.ok, fail: log.fail, warn: log.warn, skip: log.info };

export async function main(args) {
  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node launch-check.mjs ./recipe-box');
  const appDir = await resolveAppDir(args._[0]);
  if (args.url !== undefined) {
    try {
      new URL(args.url);
    } catch {
      throw new log.UsageError(`"${args.url}" is not a web address. Use something like https://example.com`);
    }
  }
  const result = await launchCheck({ appDir, live: args.live, url: args.url });
  for (const c of result.checks) {
    MARK[c.status](`${c.label}: ${c.detail}`);
    if (c.fix && (c.status === 'fail' || c.status === 'warn')) log.info(`Next: ${c.fix}`);
  }
  const { counts } = result;
  if (result.ok) log.ok(`Nothing failed (${counts.ok} ok, ${counts.warn} to look at).${result.live ? ' Ready for real payments.' : ''}`);
  else log.fail(`${counts.fail} thing${counts.fail === 1 ? '' : 's'} to fix${result.live ? ' before taking real payments' : ''}.`);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['live'], string: ['url'] }, help: HELP, main });
}
