#!/usr/bin/env node
// Writes one key into ~/.shipyard/secrets.env. The value is read from stdin only (never argv).
// Agents use this instead of editing the file directly; the key guard allows this script.
import { setSecret } from './lib/secrets.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage: secrets-set.mjs <KEY> [--json]

Writes one KEY=value into ~/.shipyard/secrets.env. The value is read from stdin only.
Never put the value on the command line. Existing values for that KEY are replaced.
Exit code: 0 = ok, 1 = could not write, 2 = bad usage.
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { boolean: ['json', 'help'], alias: { h: 'help' } });
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
  const name = args._[0];
  if (!name || args._.length > 1) {
    process.stderr.write(HELP);
    return 2;
  }
  if (args.json) setQuiet(true);

  if (process.stdin.isTTY) {
    process.stderr.write('Paste the key value, then press Ctrl-D (Mac/Linux) or Ctrl-Z then Enter (Windows).\n');
  }
  let value;
  try {
    value = await readStdin();
  } catch (err) {
    process.stderr.write(`Could not read stdin: ${err.message}\n`);
    return 1;
  }
  if (!value) {
    process.stderr.write('No value on stdin.\n');
    return 2;
  }

  try {
    const result = await setSecret(name, value);
    if (args.json) {
      json({ ok: true, path: result.path, name: result.name, replaced: result.replaced });
      return 0;
    }
    ok(`Saved ${name} in your keys file.`);
    info('Run secrets-check.mjs --live if this key has a live check.');
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
