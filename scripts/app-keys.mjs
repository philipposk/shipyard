#!/usr/bin/env node
// Give one app the AI, speech or email keys it needs, from the student's keys file. Never prints a value.
import path from 'node:path';
import { runCli, isMain, resolveAppDir, readAppConfig, updateAppConfig, appEnvNames } from './provision/common.mjs';
import { updateEnvFile } from './provision/envfile.mjs';
import { readSecrets as realReadSecrets, KNOWN_SECRETS, PER_APP_SECRETS } from './lib/secrets.mjs';
import * as log from './lib/log.mjs';

const HELP = `
Give an app made with Shipyard the service keys it needs (AI, speech-to-text, email).

Usage:
  node app-keys.mjs <app-folder> [KEY_NAME ...] [--json]

  KEY_NAME   one or more of: ${[...PER_APP_SECRETS].filter((n) => !n.startsWith('STRIPE') && !n.startsWith('GOOGLE')).join(', ')}
  (no names) list which of these keys the app uses and which are in your keys file
  --json     print the result as JSON
  --help     show this text

What it does: adds the names to the app's .shipyard-app.json (so provision-vercel.mjs copies them to the
live app) and writes the values from your keys file into the app's .env.local (for npm run dev).
Nothing secret is printed. Keys that control a whole account or real money are refused.
Exit code: 0 done, 1 a key is missing from your keys file, 2 wrong options.
`;

/** deps: { readSecrets } for tests. */
export async function appKeys({ appDir, names }, deps = {}) {
  const readSecrets = deps.readSecrets ?? realReadSecrets;
  for (const n of names) {
    if (!PER_APP_SECRETS.has(n)) {
      const known = KNOWN_SECRETS.some((k) => k.name === n);
      throw new log.UsageError(known
        ? `${n} is not given to apps (it controls a whole account or real money).`
        : `${n} is not a key Shipyard knows. Run --help for the list.`);
    }
  }
  const config = await readAppConfig(appDir);
  const secrets = await readSecrets();
  const before = appEnvNames(config);
  if (names.length) await updateAppConfig(appDir, { env: [...new Set([...before, ...names])] });
  const updates = {};
  const missing = [];
  for (const n of names) {
    const v = secrets.get(n);
    if (v) updates[n] = v;
    else missing.push(n);
  }
  if (Object.keys(updates).length) await updateEnvFile(path.join(appDir, '.env.local'), updates);
  const used = [...new Set([...before, ...names])].filter((n) => PER_APP_SECRETS.has(n));
  return {
    ok: missing.length === 0,
    added: names,
    written: Object.keys(updates),
    missing,
    used: used.map((n) => ({ name: n, inKeysFile: secrets.has(n) })),
  };
}

export async function main(args) {
  if (args._.length < 1) throw new log.UsageError('Give the app folder, for example: node app-keys.mjs ./recipe-box GROQ_API_KEY');
  const appDir = await resolveAppDir(args._[0]);
  const names = args._.slice(1).map(String);
  const result = await appKeys({ appDir, names });
  for (const n of result.written) log.ok(`${n} added to the app (local and live settings)`);
  for (const n of result.missing) {
    const hint = KNOWN_SECRETS.find((k) => k.name === n)?.hint ?? '';
    log.warn(`${n} is not in your keys file yet. ${hint} Add it with secrets-init.mjs, then run this again.`);
  }
  if (!names.length) {
    if (!result.used.length) log.info('This app uses no service keys yet.');
    for (const u of result.used) (u.inKeysFile ? log.ok : log.warn)(`${u.name}${u.inKeysFile ? '' : ' (not in your keys file)'}`);
  } else if (result.written.length) {
    log.info('Run provision-vercel.mjs and redeploy so the live app gets them.');
  }
  return result;
}

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: {}, help: HELP, main });
}
