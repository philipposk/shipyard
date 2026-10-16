#!/usr/bin/env node
// Shipyard verify: checks that an app really works before anyone says "done".
//   node verify.mjs <appDir> [--url <address>] [--only a,b] [--json]
// Exit code: 0 all checks that ran passed, 1 a check failed, 2 wrong usage.
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from './lib/log.mjs';
import { parseEnv } from './lib/secrets.mjs';
import { getApp, upsertApp } from './lib/profile.mjs';
import { CHECK_NAMES, loadCheck } from './verify/index.mjs';
import { formatReport, summarizeForProfile, tally } from './verify/format.mjs';
import { readAppFile, makeRedactor } from './verify/util.mjs';

const HELP = `Usage: node verify.mjs <appDir> [--url <address>] [--only <checks>] [--json]

Checks that your app works: pages open, sign-in works, users cannot see each
other's data, nothing leaks keys, and the home page looks right on a phone.

  <appDir>        the app's folder
  --url <address> the live address (default: the one saved for this app)
  --only <list>   run only some checks, separated by commas
                  (${CHECK_NAMES.join(', ')})
  --json          print the result as JSON
  --help          show this text

Checks that need a web address are skipped when there is none.
The result is saved to <appDir>/.shipyard/verify.json.
Exit code: 0 = all good, 1 = a check failed, 2 = wrong usage.`;

/** Make a web address usable: add https:// if missing, drop trailing slashes. Returns null if it is not http(s). */
export function normalizeUrl(input) {
  if (!input) return null;
  let text = String(input).trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Read <appDir>/.env.local into a Map (used only to call the app's own Supabase). Missing file = empty Map. */
async function readEnvLocal(appDir) {
  try {
    return parseEnv(await readFile(path.join(appDir, '.env.local'), 'utf8'));
  } catch {
    return new Map();
  }
}

/** Run the chosen checks one after another. Never throws: a crashing check becomes a failed result. */
export async function runChecks(ctx, names) {
  const redact = makeRedactor([...ctx.secrets.values()]);
  const checks = [];
  for (const name of names) {
    try {
      const fn = await loadCheck(name);
      checks.push(await fn(ctx));
    } catch (err) {
      checks.push({
        name, ok: false, summary: 'the check crashed',
        problems: [redact(String(err?.message ?? 'unknown error')).slice(0, 200)], details: [],
      });
    }
  }
  return checks;
}

export async function main(argv) {
  let args;
  try {
    args = log.parseArgs(argv, { boolean: ['json', 'help'], string: ['url', 'only'], alias: { h: 'help' } });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const usage = (msg) => {
    process.stderr.write(`${msg}\n\n${HELP}\n`);
    return 2;
  };

  if (args._.length !== 1) return usage('Give the app folder, for example: node verify.mjs ./my-app');
  const appDir = path.resolve(args._[0]);
  const isDir = await stat(appDir).then((s) => s.isDirectory(), () => false);
  if (!isDir) return usage(`"${args._[0]}" is not a folder.`);

  let selected = CHECK_NAMES;
  if (args.only !== undefined) {
    const asked = args.only.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = asked.filter((n) => !CHECK_NAMES.includes(n));
    if (asked.length === 0 || unknown.length > 0) {
      return usage(`Unknown check${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(none given)'}. Choose from: ${CHECK_NAMES.join(', ')}.`);
    }
    selected = CHECK_NAMES.filter((n) => asked.includes(n));
  }

  const appFile = await readAppFile(appDir);
  let profileApp = null;
  try {
    profileApp = appFile?.slug ? await getApp(appFile.slug) : null;
  } catch {
    profileApp = null;
  }
  const app = { ...(appFile ?? {}), ...(profileApp ?? {}) };

  let url = null;
  if (args.url !== undefined) {
    url = normalizeUrl(args.url);
    if (!url) return usage(`"${args.url}" is not a web address. Use something like https://my-app.vercel.app`);
  } else {
    url = normalizeUrl(profileApp?.url || appFile?.url);
  }

  if (args.json) log.setQuiet(true);

  const ctx = {
    appDir,
    url,
    app: Object.keys(app).length > 0 ? app : null,
    secrets: await readEnvLocal(appDir),
    log,
  };

  if (!args.json) {
    log.info(url ? `Checking ${url}` : 'No web address known: checks that need one will be skipped.');
  }
  const checks = await runChecks(ctx, selected);
  const t = tally(checks);
  const result = {
    app: app.slug ?? path.basename(appDir),
    url,
    ranAt: new Date().toISOString(),
    ok: t.failed === 0,
    passed: t.passed,
    failed: t.failed,
    skipped: t.skipped,
    checks,
    notRun: CHECK_NAMES.filter((n) => !selected.includes(n)),
  };

  // Save the result (best effort: a read-only folder must not hide the report).
  try {
    await mkdir(path.join(appDir, '.shipyard'), { recursive: true });
    await writeFile(path.join(appDir, '.shipyard', 'verify.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    if (!args.json) log.warn('Could not save .shipyard/verify.json in the app folder.');
  }
  if (profileApp) {
    try {
      await upsertApp({ slug: profileApp.slug, lastVerify: summarizeForProfile(result) });
    } catch {
      if (!args.json) log.warn('Could not save the result to your Shipyard profile.');
    }
  }

  if (args.json) {
    log.json(result);
  } else {
    for (const line of formatReport(result)) {
      if (line.kind === 'blank') process.stdout.write('\n');
      else log[line.kind](line.text);
    }
  }
  return result.ok ? 0 : 1;
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`Verify stopped unexpectedly: ${String(err?.message ?? err).slice(0, 200)}\n`);
      process.exitCode = 1;
    },
  );
}
