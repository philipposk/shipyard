#!/usr/bin/env node
// Creates your private keys file (~/.shipyard/secrets.env) and opens it in an editor,
// so you can paste keys there instead of into the chat.
import { spawn } from 'node:child_process';
import { ensureSecretsFile } from './lib/secrets.mjs';
import { which } from './lib/run.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, info, warn, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';
import { agentName } from './lib/agent.mjs';

const HELP = `Usage: secrets-init.mjs [--no-open] [--json]

Creates ~/.shipyard/secrets.env (or adds any missing key lines to it) and opens it
in a text editor. Existing values are never changed.
  --no-open   do not open the editor
  --json      machine-readable output
Exit code: 0 = ok, 1 = could not create the file, 2 = bad usage.
`;

/** Start a program and let it live on its own (editors and browsers must not block us). */
export function launchDetached(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Which program opens a text file for editing on this system. */
export async function editorCommand(file, platform = process.platform, find = which) {
  if (platform === 'darwin') return ['open', ['-t', file]];
  if (platform === 'win32') return ['notepad', [file]];
  if (await find('code')) return ['code', [file]];
  return ['xdg-open', [file]];
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help', 'no-open'], alias: { h: 'help' } });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.json) setQuiet(true);

  let result;
  try {
    result = await ensureSecretsFile();
  } catch (err) {
    process.stderr.write(`Could not create your keys file: ${err.message}\n`);
    return 1;
  }

  let opened = false;
  if (!args['no-open']) {
    const [cmd, cmdArgs] = await editorCommand(result.path);
    opened = await launchDetached(cmd, cmdArgs);
  }

  if (args.json) {
    json({ ok: true, path: result.path, created: result.created, added: result.added, opened });
    return 0;
  }
  ok(result.created ? `Created your keys file: ${result.path}` : `Your keys file is ready: ${result.path}`);
  if (!result.created && result.added.length > 0) info(`Added empty lines for: ${result.added.join(', ')}`);
  if (opened) {
    info('It should open in a text editor now.');
  } else if (args['no-open']) {
    info('Open that file in any text editor.');
  } else {
    warn('Could not open an editor automatically. Open that file yourself in any text editor.');
  }
  info(`Paste your keys, save, close, then tell ${agentName()} 'done'.`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Could not set up the keys file: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
