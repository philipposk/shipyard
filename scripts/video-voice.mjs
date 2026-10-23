#!/usr/bin/env node
// Makes the narration for a video script and the word timings the scenes are built on. This is the step that costs money
// (a few cents per minute), so run it only after the student has approved the script.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { run as realRun } from './lib/run.mjs';
import { readSecrets as realReadSecrets } from './lib/secrets.mjs';
import { SECRETS_PATH } from './lib/paths.mjs';
import * as log from './lib/log.mjs';
import { runCli, isMain, resolveAppDir, ProvisionError } from './provision/common.mjs';
import {
  ID_RE, VOICE_KEYS, requireVideoDir, pathExists, readJson, redactSecrets, tailLines, checkMediaTools, mediaToolsError,
} from './video/common.mjs';

const HELP = `
Make the narration voice and word timings for a video script.

Usage:
  node video-voice.mjs <app-folder> --tag <name> [--script <id>] [--provider openai|gemini|deepgram]
                       [--voice <name>] [--pace normal|fast] [--retime] [--dry-run] [--json]

  --tag        name of this cut (a short word like "launch"). Its voice files and timeline are named after it.
  --script     which script to voice: video/src/scripts/<id>.json. Default: the same as --tag.
  --provider   who makes the voice. openai (default), gemini or deepgram.
  --voice      a voice name for that provider (OpenAI default: marin).
  --pace       "fast" gives tighter pauses and quicker speech.
  --retime     fetch the word timings again without making new voice.
  --dry-run    only check the script and keys and show what would happen. Costs nothing.

This costs a few cents for a minute of speech, so show the script to the student and get a yes first.
The keys come from your Shipyard keys file and are handed to the voice step privately. They are never printed or saved in video/.
Exit code: 0 ok, 1 something to fix, 2 wrong options.
`;

const PROVIDERS = ['openai', 'gemini', 'deepgram'];
const KEY_FOR = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', deepgram: 'DEEPGRAM_API_KEY' };

/** Check the script file and describe it. Throws a plain error for anything the voice step would choke on. */
export function inspectScript(lines, label = 'The script') {
  if (!Array.isArray(lines) || lines.length === 0) throw new ProvisionError(`${label} must be a list with at least one line.`);
  const seen = new Set();
  let words = 0;
  lines.forEach((l, i) => {
    const where = `${label}, line ${i + 1}`;
    if (!l || typeof l !== 'object') throw new ProvisionError(`${where}: each line must be an object like {"id": "hook", "text": "..."}.`);
    if (typeof l.id !== 'string' || !ID_RE.test(l.id)) throw new ProvisionError(`${where}: "id" must be a short word (letters, numbers, dashes), for example "hook".`);
    if (seen.has(l.id)) throw new ProvisionError(`${where}: the id "${l.id}" is used twice. Each line needs its own id.`);
    seen.add(l.id);
    if (typeof l.text !== 'string' || l.text.trim() === '') throw new ProvisionError(`${where} ("${l.id}"): "text" is empty.`);
    if (l.text.length > 800) throw new ProvisionError(`${where} ("${l.id}"): the text is very long. Split it into shorter lines (one idea each).`);
    words += l.text.trim().split(/\s+/).length;
  });
  return { lines: lines.length, words, seconds: Math.round(words / 3) };
}

export async function main(args, deps = {}) {
  const { run = realRun, readSecrets = realReadSecrets, which } = deps;

  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node video-voice.mjs ./recipe-box --tag launch');
  const tag = args.tag;
  if (!tag) throw new log.UsageError('Say which cut this is with --tag <name>, for example --tag launch.');
  if (!ID_RE.test(tag)) throw new log.UsageError('--tag can use letters, numbers, dashes and underscores only (for example launch or promo-2).');
  const scriptId = args.script ?? tag;
  if (!ID_RE.test(scriptId)) throw new log.UsageError('--script can use letters, numbers, dashes and underscores only.');
  const provider = args.provider ?? 'openai';
  if (!PROVIDERS.includes(provider)) throw new log.UsageError(`--provider must be one of: ${PROVIDERS.join(', ')}.`);
  if (args.pace !== undefined && !['normal', 'fast'].includes(args.pace)) throw new log.UsageError('--pace must be normal or fast.');
  if (args.voice !== undefined && !/^[A-Za-z0-9_.-]{1,60}$/.test(args.voice)) throw new log.UsageError('--voice can only use letters, numbers, dots and dashes.');

  const appDir = await resolveAppDir(args._[0]);
  const videoDir = await requireVideoDir(appDir);
  if (which) {
    const media = await checkMediaTools(which);
    if (!media.ok) throw mediaToolsError(media);
  }

  // The script
  const scriptFile = path.join(videoDir, 'src', 'scripts', `${scriptId}.json`);
  if (!(await pathExists(scriptFile))) {
    throw new ProvisionError(`There is no script at video/src/scripts/${scriptId}.json yet. Write it first (one line per scene) and get the student's OK.`);
  }
  let lines;
  try {
    lines = await readJson(scriptFile);
  } catch {
    throw new ProvisionError(`video/src/scripts/${scriptId}.json is not valid JSON. Fix it (a list of {"id", "text"} lines) and try again.`);
  }
  const about = inspectScript(lines, `video/src/scripts/${scriptId}.json`);
  log.ok(`Script "${scriptId}": ${about.lines} lines, ${about.words} words, about ${about.seconds} seconds of speech.`);

  // The keys (names only are ever shown)
  const secrets = await readSecrets();
  const need = [KEY_FOR[provider]];
  if (provider === 'gemini' && !secrets.get('DEEPGRAM_API_KEY') && !secrets.get('OPENAI_API_KEY')) need.push('OPENAI_API_KEY');
  const missing = need.filter((n) => !secrets.get(n));
  const have = Object.fromEntries(VOICE_KEYS.map((n) => [n, Boolean(secrets.get(n))]));
  if (missing.length && !args['dry-run']) {
    throw new ProvisionError(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing from your Shipyard keys file (${SECRETS_PATH}). `
      + 'Open it with secrets-init.mjs, put the key after the = sign, save, and run this again. Never paste a key in the chat.',
      { missing },
    );
  }
  for (const n of VOICE_KEYS) {
    if (have[n]) log.ok(`${n} is in your keys file.`);
    else if (need.includes(n)) log.fail(`${n} is missing.`);
  }
  if (!have.DEEPGRAM_API_KEY) log.info('No Deepgram key: word timings come from OpenAI (works fine, slightly less tight).');

  const plan = { tag, script: scriptId, provider, voice: args.voice ?? null, pace: args.pace ?? 'normal', retime: !!args.retime, ...about };
  if (args['dry-run']) {
    log.info(`Dry run: would make the voice for "${tag}" with ${provider}. Nothing was sent and nothing was spent.`);
    return { ok: true, dryRun: true, plan, keys: have, missing };
  }

  // The child gets the keys through its environment only (not argv, not a file).
  const env = { VOICE_PROVIDER: provider };
  if (args.voice) env.VOICE = args.voice;
  if (args.pace) env.PACE = args.pace;
  const values = [];
  for (const n of VOICE_KEYS) {
    const v = secrets.get(n);
    if (v) {
      env[n] = v;
      values.push(v);
    } else {
      // run() merges over process.env, so a key exported in the shell would slip through
      // even though it is not in the keys file. Undefined drops it from the child's environment.
      env[n] = undefined;
    }
  }
  log.info('Making the voice and word timings. This usually takes under a minute...');
  const argv = ['scripts/voice.mjs', `--script=${scriptId}`, `--tag=${tag}`];
  if (args.retime) argv.push('--retime');
  const r = await run('node', argv, { cwd: videoDir, env, timeoutMs: 20 * 60_000, quiet: true });
  if (r.code !== 0) {
    const detail = redactSecrets(tailLines(`${r.stdout}\n${r.stderr}`, 6), values);
    throw new ProvisionError(`The voice step failed. ${/API key|401|403/i.test(detail) ? 'The key may be wrong or out of credit. ' : ''}Last lines:\n${detail}`);
  }
  for (const l of redactSecrets(r.stdout, values).split('\n').filter(Boolean)) log.info(l);

  // What came out
  const timelineFile = path.join(videoDir, 'src', 'timelines', `${tag}.json`);
  if (!(await pathExists(timelineFile))) throw new ProvisionError('The voice step finished but did not write the timeline. Run it again.');
  const tl = JSON.parse(await readFile(timelineFile, 'utf8'));
  const seconds = Math.round((tl.total / tl.fps) * 10) / 10;
  const vtt = path.join(videoDir, 'out', `${tag}.vtt`);
  let registered = [];
  try {
    const products = await readJson(path.join(videoDir, 'src', 'products.json'));
    registered = Object.keys(products).filter((k) => products[k]?.scripts?.includes(scriptId));
  } catch {
    // no products file: leave it to the next-step hint
  }
  log.ok(`Voice ready: ${tl.scenes.length} scenes, ${seconds} seconds in total.`);
  const next = registered.length
    ? [`Next: build or check the scenes, look at stills, then render with video-render.mjs (for example ${tag}:light).`]
    : [`Next: register the script in video/src/products.json and video/src/products.ts (the product key becomes the composition name), then build the scenes.`];
  if (!registered.length) log.warn(next[0]);
  return {
    ok: true,
    plan,
    timeline: timelineFile,
    captions: (await pathExists(vtt)) ? vtt : null,
    voiceFolder: path.join(videoDir, 'public', 'voice', tag),
    scenes: tl.scenes.length,
    seconds,
    registeredAs: registered,
    next,
  };
}

if (isMain(import.meta.url)) {
  const { which } = await import('./lib/run.mjs');
  await runCli({
    argv: process.argv.slice(2),
    spec: { string: ['tag', 'script', 'provider', 'voice', 'pace'], boolean: ['retime', 'dry-run'] },
    help: HELP,
    main: (args) => main(args, { which }),
  });
}
