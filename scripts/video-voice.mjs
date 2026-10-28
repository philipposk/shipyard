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
                       [--voice <name>] [--pace normal|fast] [--lang <code>] [--wpm <n>] [--style <text>]
                       [--retime] [--dry-run] [--json]
  node video-voice.mjs <app-folder> --script <id> --takes <n> --lines <id,id>   (listen and pick, see below)

  --tag        name of this cut (a short word like "launch"). Its voice files and timeline are named after it.
  --script     which script to voice: video/src/scripts/<id>.json. Default: the same as --tag.
  --provider   who makes the voice. openai (default), gemini or deepgram.
  --voice      a voice name for that provider (OpenAI default: marin).
  --pace       "fast" gives tighter pauses and quicker speech.
  --lang       the language the script is in, for the word timings (for example el). Default: let the recogniser decide.
  --wpm        target speaking speed in words a minute. Lower it for other languages so nothing is sped up (Greek: 100).
  --style      how the voice should speak, written in the script's language (replaces the default style).
  --retime     fetch the word timings again without making new voice.
  --takes      make this many fresh takes (1 to 8) of the lines named in --lines, to listen to and pick from. They land
               in video/out/takes/<script>/. Then put "take": <number> on the line in the script and run the voice step
               again. No timeline is made. Each take costs like one line of voice.
  --lines      the line ids for --takes, separated by commas.
  --dry-run    only check the script and keys and show what would happen. Costs nothing.

This costs a few cents for a minute of speech, so show the script to the student and get a yes first.
The keys come from your Shipyard keys file and are handed to the voice step privately. They are never printed or saved in video/.
Exit code: 0 ok, 1 something to fix, 2 wrong options.
`;

const PROVIDERS = ['openai', 'gemini', 'deepgram'];
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** Gemini's free tier: 10 voice requests a day per model. Its 429 names FreeTier when the key's project has no billing. */
export function explainVoiceFailure(detail) {
  if (/429/.test(detail) && /FreeTier|free_tier|RESOURCE_EXHAUSTED/i.test(detail)) {
    return 'Gemini said no more today: its free tier allows 10 voice requests a day per model, and an error that names '
      + "FreeTier means the key's Google project has no billing set up. Turn on billing for that project, or use --provider openai. ";
  }
  if (/take \d+ missing/.test(detail)) return 'A line asks for a take that does not exist yet. Make takes first with --takes and --lines, or remove "take" from that line. ';
  if (/API key|401|403/i.test(detail)) return 'The key may be wrong or out of credit. ';
  return '';
}
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
    for (const f of ['say', 'caption']) {
      if (l[f] !== undefined && typeof l[f] !== 'string') throw new ProvisionError(`${where} ("${l.id}"): "${f}" must be text.`);
    }
    if (l.say !== undefined && l.say.trim() === '') throw new ProvisionError(`${where} ("${l.id}"): "say" is empty. Remove it to read "text".`);
    if (l.style !== undefined && (typeof l.style !== 'string' || !l.style.trim() || l.style.length > 500)) {
      throw new ProvisionError(`${where} ("${l.id}"): "style" must be a short description of how to speak this line (at most 500 characters).`);
    }
    if (l.pauseCap !== undefined && !(num(l.pauseCap) && l.pauseCap >= 0.05 && l.pauseCap <= 2)) {
      throw new ProvisionError(`${where} ("${l.id}"): "pauseCap" is the longest pause in seconds, between 0.05 and 2.`);
    }
    if (l.leadIn !== undefined && !(num(l.leadIn) && l.leadIn >= 0 && l.leadIn <= 1)) {
      throw new ProvisionError(`${where} ("${l.id}"): "leadIn" is seconds of quiet before the first word, between 0 and 1.`);
    }
    if (l.take !== undefined && !(Number.isInteger(l.take) && l.take >= 1 && l.take <= 99)) {
      throw new ProvisionError(`${where} ("${l.id}"): "take" must be the number of a take you made with --takes, for example 2.`);
    }
    for (const f of ['minSec', 'holdSec', 'speed']) {
      if (l[f] !== undefined && !(num(l[f]) && l[f] >= 0)) throw new ProvisionError(`${where} ("${l.id}"): "${f}" must be a number.`);
    }
    words += l.text.trim().split(/\s+/).length;
  });
  return { lines: lines.length, words, seconds: Math.round(words / 3) };
}

export async function main(args, deps = {}) {
  const { run = realRun, readSecrets = realReadSecrets, which } = deps;

  if (args._.length !== 1) throw new log.UsageError('Give the app folder, for example: node video-voice.mjs ./recipe-box --tag launch');
  const takes = args.takes === undefined ? 0 : Number(args.takes);
  if (args.takes !== undefined && !(Number.isInteger(takes) && takes >= 1 && takes <= 8)) throw new log.UsageError('--takes must be a number from 1 to 8.');
  const takeLines = args.lines === undefined ? [] : String(args.lines).split(',').map((x) => x.trim()).filter(Boolean);
  if (takes && !takeLines.length) throw new log.UsageError('Say which lines to make takes of with --lines, for example --lines reveal,end.');
  if (!takes && args.lines !== undefined) throw new log.UsageError('--lines goes with --takes.');
  if (takeLines.some((id) => !ID_RE.test(id))) throw new log.UsageError('--lines must be line ids separated by commas, for example reveal,end.');
  const tag = args.tag ?? (takes ? args.script : undefined);
  if (!tag) throw new log.UsageError(takes ? 'Say which script with --script <id>.' : 'Say which cut this is with --tag <name>, for example --tag launch.');
  if (!ID_RE.test(tag)) throw new log.UsageError('--tag can use letters, numbers, dashes and underscores only (for example launch or promo-2).');
  if (args.lang !== undefined && !LANG_RE.test(args.lang)) throw new log.UsageError('--lang must be a language code like en, el or pt-BR.');
  const wpm = args.wpm === undefined ? null : Number(args.wpm);
  if (wpm !== null && !(wpm >= 60 && wpm <= 240)) throw new log.UsageError('--wpm must be a number of words a minute between 60 and 240 (Greek: 100).');
  if (args.style !== undefined && (!String(args.style).trim() || String(args.style).length > 500 || /[\r\n]/.test(args.style))) {
    throw new log.UsageError('--style must be one line of at most 500 characters describing how to speak.');
  }
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
  const unknown = takeLines.filter((id) => !lines.some((l) => l.id === id));
  if (unknown.length) throw new ProvisionError(`video/src/scripts/${scriptId}.json has no line called ${unknown.join(', ')}. Use the line ids from the script.`);

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

  const plan = {
    tag, script: scriptId, provider, voice: args.voice ?? null, pace: args.pace ?? 'normal', retime: !!args.retime,
    lang: args.lang ?? null, wpm, style: args.style ? 'custom' : 'default', takes: takes ? { count: takes, lines: takeLines } : null, ...about,
  };
  if (args['dry-run']) {
    log.info(takes
      ? `Dry run: would make ${takes} take(s) of ${takeLines.join(', ')} with ${provider}. Nothing was sent and nothing was spent.`
      : `Dry run: would make the voice for "${tag}" with ${provider}. Nothing was sent and nothing was spent.`);
    return { ok: true, dryRun: true, plan, keys: have, missing };
  }

  // The child gets the keys through its environment only (not argv, not a file).
  const env = { VOICE_PROVIDER: provider };
  if (args.voice) env.VOICE = args.voice;
  if (args.pace) env.PACE = args.pace;
  // Only what was asked for here: the same names set in the shell must not change the voice unseen.
  env.STT_LANG = args.lang ?? undefined;
  env.WPM = wpm === null ? undefined : String(wpm);
  env.VOICE_STYLE = args.style ? String(args.style) : undefined;
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
  log.info(takes ? `Making ${takes} take(s) of ${takeLines.join(', ')}...` : 'Making the voice and word timings. This usually takes under a minute...');
  const argv = ['scripts/voice.mjs', `--script=${scriptId}`, `--tag=${tag}`];
  if (args.retime) argv.push('--retime');
  if (takes) argv.push(`--takes=${takes}`, `--lines=${takeLines.join(',')}`);
  const r = await run('node', argv, { cwd: videoDir, env, timeoutMs: 20 * 60_000, quiet: true });
  if (r.code !== 0) {
    const detail = redactSecrets(tailLines(`${r.stdout}\n${r.stderr}`, 6), values);
    throw new ProvisionError(`The voice step failed. ${explainVoiceFailure(detail)}Last lines:\n${detail}`);
  }
  for (const l of redactSecrets(r.stdout, values).split('\n').filter(Boolean)) log.info(l);

  if (takes) {
    // "<id> take <n>: <path to mp3>", one per take
    const made = [...redactSecrets(r.stdout, values).matchAll(/^(\S+) take (\d+): (.+\.mp3)\s*$/gm)]
      .map((m) => ({ line: m[1], take: Number(m[2]), file: m[3].trim() }));
    if (!made.length) throw new ProvisionError('The takes step finished but did not say which files it made. Run it again.');
    log.ok(`${made.length} take(s) in ${path.join(videoDir, 'out', 'takes', scriptId)}.`);
    const next = ['Next: let the student listen (for a short line, with the sound just before it), then put "take": <number> on the line they pick and run the voice step again with --tag.'];
    log.info(next[0]);
    return { ok: true, plan, takes: made, next };
  }

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
    spec: { string: ['tag', 'script', 'provider', 'voice', 'pace', 'lang', 'wpm', 'style', 'takes', 'lines'], boolean: ['retime', 'dry-run'] },
    help: HELP,
    main: (args) => main(args, { which }),
  });
}
