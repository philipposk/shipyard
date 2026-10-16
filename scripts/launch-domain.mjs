#!/usr/bin/env node
// Put the app on the student's own domain (for example example.com).
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { launchDomain } from './launch/domain-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Put your app on your own domain name.

Usage:
  node launch-domain.mjs <app-folder> <domain> [--check] [--json]

  <domain>         the name you bought, for example example.com
  --check          wait until the domain works (checks DNS and https every 15 seconds, up to 10 minutes),
                   then switch the app and Supabase over to the new address
  --timeout-min N  how long --check waits (default 10)
  --no-www         do not also set up www.<domain> (with www, you also turn on its redirect to the main address by hand; --check waits for it)
  --json           print the result as JSON
  --help           show this text

First run: adds the domain to your Vercel project and prints the DNS records to add where you bought the domain.
Second run with --check: waits until it works, then updates NEXT_PUBLIC_SITE_URL on Vercel, the sign-in addresses in
Supabase, and your profile. Deploy again afterwards (deploy.mjs). You can run it again safely.
Needs: provision-vercel.mjs done, and a Vercel login.
Exit code: 0 done (or records printed), 1 could not do it or not working yet, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 2) throw new log.UsageError('Give the app folder and the domain, for example: node launch-domain.mjs ./recipe-box example.com');
  const appDir = await resolveAppDir(args._[0]);
  const timeoutMin = args['timeout-min'] === undefined ? 10 : Number(args['timeout-min']);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 120) throw new log.UsageError('--timeout-min must be a number of minutes between 1 and 120.');
  const result = await launchDomain({ appDir, domain: args._[1], check: args.check, timeoutMin, www: !args['no-www'] });
  if (result.live && result.ok) log.ok(`${result.url} is live. ${result.next}`);
  else if (result.live) log.warn(`${result.url} works, but one thing is left (see above).`);
  else log.info(result.next);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { boolean: ['check', 'no-www'], string: ['timeout-min'] }, help: HELP, main });
}
