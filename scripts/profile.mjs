#!/usr/bin/env node
// Read and change your Shipyard profile (~/.shipyard/profile.json).
// The profile holds settings only. Keys never go in it.
import { loadProfile, saveProfile, getPath, setPath, markStep, STEP_IDS } from './lib/profile.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, fail, info, json, parseArgs, setQuiet, UsageError } from './lib/log.mjs';

const HELP = `Usage:
  profile.mjs show                    print the whole profile as JSON
  profile.mjs get <path>              print one value, e.g. defaults.layout
  profile.mjs set <path> <value>      change a value, e.g. set defaults.layout sidebar
  profile.mjs step-done <id>          mark a setup step finished
Steps: ${STEP_IDS.join(', ')}
Values "true", "false", numbers and JSON lists like ["en","el"] are saved as that type.
To save text starting with a dash, put -- before it:  set company.legalName -- "-Name"
Options: --json (machine-readable output)
Exit code: 0 = ok, 1 = failed (for example nothing at that path), 2 = bad usage.
`;

// Things that look like API keys. Refused: keys belong in the keys file only.
const LOOKS_LIKE_KEY = [
  /\bsbp_[A-Za-z0-9_]{10,}/,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bre_[A-Za-z0-9_]{16,}/,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
];

export function looksLikeKey(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return LOOKS_LIKE_KEY.some((re) => re.test(text));
}

export async function runProfile(argv) {
  const args = parseArgs(argv, { boolean: ['json', 'help'], alias: { h: 'help' } });
  if (args.json) setQuiet(true);
  const [cmd, ...rest] = args._;

  if (args.help || cmd === undefined || cmd === 'help') {
    process.stdout.write(HELP);
    return args.help || cmd === 'help' ? 0 : 2;
  }

  switch (cmd) {
    case 'show': {
      if (rest.length > 0) throw new UsageError('"show" takes no extra words.');
      json(await loadProfile());
      return 0;
    }
    case 'get': {
      if (rest.length !== 1) throw new UsageError('Usage: profile.mjs get <path>');
      let value;
      try {
        value = getPath(await loadProfile(), rest[0]);
      } catch (err) {
        throw new UsageError(err.message);
      }
      if (value === undefined) {
        fail(`There is nothing saved at "${rest[0]}".`);
        return 1;
      }
      if (typeof value === 'string' && !args.json) process.stdout.write(`${value}\n`);
      else process.stdout.write(`${JSON.stringify(value, null, args.json ? 2 : 0)}\n`);
      return 0;
    }
    case 'set': {
      if (rest.length !== 2) throw new UsageError('Usage: profile.mjs set <path> <value>');
      const [dotted, value] = rest;
      if (looksLikeKey(value)) {
        fail('That looks like a secret key. Keys go in your keys file, never in the profile.');
        info('Run secrets-init.mjs to open the keys file.');
        return 1;
      }
      if (dotted === 'defaults.layout' && !['bottom-nav', 'sidebar', 'top-nav'].includes(value)) {
        throw new UsageError('defaults.layout must be "bottom-nav", "sidebar" or "top-nav".');
      }
      const profile = await loadProfile();
      try {
        setPath(profile, dotted, value);
      } catch (err) {
        throw new UsageError(err.message);
      }
      await saveProfile(profile);
      const saved = getPath(profile, dotted);
      if (args.json) json({ ok: true, path: dotted, value: saved });
      else ok(`Saved ${dotted} = ${JSON.stringify(saved)}`);
      return 0;
    }
    case 'step-done': {
      if (rest.length !== 1) throw new UsageError('Usage: profile.mjs step-done <id>');
      if (!STEP_IDS.includes(rest[0])) throw new UsageError(`Unknown step "${rest[0]}". Steps: ${STEP_IDS.join(', ')}.`);
      const profile = await markStep(rest[0]);
      if (args.json) json({ ok: true, done: profile.setup.done, next: profile.setup.step });
      else {
        ok(`Step "${rest[0]}" is done.`);
        info(profile.setup.step === 'done' ? 'Setup is finished.' : `Next step: ${profile.setup.step}`);
      }
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}". Try --help.`);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  runProfile(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    },
  );
}
