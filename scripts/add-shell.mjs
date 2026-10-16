#!/usr/bin/env node
// Add a phone app (iPhone and Android) or a desktop app (Mac and Windows) around an app that is already live.
import path from 'node:path';
import { runCli, isMain, resolveAppDir } from './provision/common.mjs';
import { addShell, nextSteps } from './shells/add-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Add a phone or desktop app around your live website.

Usage:
  node add-shell.mjs <app-folder> mobile|desktop [--app-id <id>] [--google | --no-google]
                     [--skip-supabase] [--dry-run] [--force-file <path>] [--json]

  mobile   Writes <app>/mobile: an iPhone and Android app that opens your live website (Capacitor),
           an offline page, store listing draft (STORE.md), icons, privacy manifest and a README with the commands.
  desktop  Writes <app>/desktop: a Mac and Windows window that shows your live website (Electron),
           plus a GitHub workflow that builds the installers when you push a tag like desktop-v1.0.0.

  --app-id ID      the app's permanent name on phones, like com.yourname.recipes. Default: your custom domain
                   reversed, or io.github.<your github name>.<app name>. Chosen once; it cannot change later.
  --google         add Google sign-in through the phone's own browser (default: on when the app has Google sign-in)
  --no-google      leave that out
  --skip-supabase  do not touch the Supabase sign-in settings (you add the return address by hand)
  --dry-run        show what would change and change nothing
  --force-file P   replace one existing file with the new version (repeat for more)
  --json           print the result as JSON

The app must be deployed first (it needs a live https address). This never builds the phone projects and never
calls Xcode or Android Studio; mobile/README.md lists the commands you run. It never overwrites a file you changed.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args, deps = {}) {
  if (args._.length !== 2) {
    throw new log.UsageError('Give the app folder and the kind, for example: node add-shell.mjs ./recipe-box mobile');
  }
  const kind = args._[1];
  if (!['mobile', 'desktop'].includes(kind)) throw new log.UsageError(`"${kind}" is not a kind of app. Use mobile or desktop.`);
  if (args.google && args['no-google']) throw new log.UsageError('Use either --google or --no-google, not both.');
  const appDir = await resolveAppDir(args._[0]);
  const result = await addShell({
    appDir,
    kind,
    appId: args['app-id'],
    google: args.google ? true : args['no-google'] ? false : undefined,
    skipSupabase: args['skip-supabase'],
    dryRun: args['dry-run'],
    forceFiles: args['force-file'],
  }, deps);

  const say = (w, past) => (result.dryRun ? `Would ${w}` : past);
  log.ok(`${result.dryRun ? 'Dry run: ' : ''}${kind === 'mobile' ? 'Phone app' : 'Desktop app'} for ${result.url} (app id ${result.appId}${result.appIdSource === 'saved' ? ', as before' : ''}).`);
  if (result.created.length) log.info(`${say('write', 'Wrote')} ${result.created.length} new file${result.created.length === 1 ? '' : 's'}: ${result.created.join(', ')}`);
  if (result.updated.length) log.info(`${say('update', 'Updated')}: ${result.updated.join(', ')}`);
  if (result.same.length && !result.created.length && !result.updated.length) log.info('Everything was already there. Nothing changed.');
  for (const f of result.kept) log.warn(`${f} was changed by you, so it was kept. Use --force-file ${f} to replace it.`);
  for (const p of result.patched) log.info(`${say('edit', 'Edited')} ${p}`);
  if (result.supabase?.status === 'added') log.ok(`Supabase now accepts ${result.supabase.added.join(', ')} as a sign-in return address.`);
  if (result.supabase?.status === 'present') log.info('Supabase already accepts the sign-in return address.');
  for (const w of result.warnings) log.warn(w);
  for (const m of result.manual) log.warn(`Do this by hand: ${m}`);
  if (!result.dryRun) {
    log.info('Next:');
    nextSteps(result).forEach((s, i) => log.info(`  ${i + 1}. ${s}`));
  }
  return { ...result, appDir: path.resolve(appDir), next: nextSteps(result) };
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['app-id', 'force-file'], boolean: ['google', 'no-google', 'skip-supabase', 'dry-run'], multiple: ['force-file'] },
    help: HELP,
    main,
  });
}
