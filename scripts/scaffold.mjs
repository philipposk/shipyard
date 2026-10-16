#!/usr/bin/env node
// Create a new app folder from the Shipyard template.
import { runCli, isMain } from './provision/common.mjs';
import { scaffold } from './provision/scaffold-core.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Create a new app folder from the Shipyard template.

Usage:
  node scaffold.mjs <app-name> --name "Display Name" --description "What it does"
       [--dir <parent-folder>] [--layout bottom-nav|sidebar|top-nav] [--no-pwa] [--private] [--json]

  <app-name>     short, lowercase, letters/numbers/dashes (becomes the folder and web address)
  --name         the name people see (default: made from <app-name>)
  --description  one or two sentences about the app
  --dir          folder to create the app in (default: the current folder)
  --layout       bottom-nav = phone-first, sidebar = tool-like, top-nav = site-like (default: your saved choice)
  --no-pwa       do not make the app installable on phones
  --private      hide the app from search engines
  --json         print the result as JSON
  --help         show this text

It makes the folder, fills in your app's name, starts git and turns on the key-leak check.
It does not install anything, save to GitHub or contact any service.
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

export async function main(args) {
  if (args._.length !== 1) {
    throw new log.UsageError('Give the app a name, for example: node scaffold.mjs recipe-box --name "Recipe Box" --description "Save recipes"');
  }
  let result;
  try {
    result = await scaffold({
      slug: args._[0],
      name: args.name,
      description: args.description,
      parent: args.dir,
      layout: args.layout,
      pwa: args['no-pwa'] ? false : undefined,
      isPrivate: args.private,
    });
  } catch (err) {
    if (err?.data?.usage) {
      throw new log.UsageError(err.message);
    }
    throw err;
  }
  log.ok(`Created ${result.name} in ${result.dir}`);
  log.info(`${result.files} files copied. Layout: ${result.layout}.${result.private ? ' Hidden from search engines.' : ''}`);
  if (result.git.initialized) log.ok('Git is ready, with the key-leak check turned on for every push.');
  for (const note of result.notes) log.warn(note);
  log.info(`Next: ${result.next}`);
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['name', 'description', 'dir', 'layout'], boolean: ['no-pwa', 'private'] },
    help: HELP,
    main,
  });
}
