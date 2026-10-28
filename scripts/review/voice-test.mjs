#!/usr/bin/env node
// Play a scripted two-voice conversation through the computer's speakers, so an app that records from the
// microphone (live transcription, meeting notes, voice input) hears a real conversation during a release check.
// macOS only for playback (it uses the built-in `say` and `afplay`); --dry-run works everywhere. No network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, isMain, ProvisionError } from '../provision/common.mjs';
import { UsageError } from '../lib/log.mjs';
import * as log from '../lib/log.mjs';

const HELP = `
Play a short two-person conversation through the speakers for a live microphone test.

Usage:
  node voice-test.mjs [--script <file.txt>] [--out <folder>] [--voice-a Samantha] [--voice-b Daniel] [--pause 0.6] [--dry-run] [--json]

  --script    one line per turn, "A: text" or "B: text" (default: a built-in one-minute release check)
  --out       where to keep the audio files (default: a new temporary folder)
  --pause     seconds between turns
  --dry-run   show the turns without playing anything

Before playing: headphones off (the microphone cannot hear them), volume up, and the app already recording
from the microphone. macOS only; on other systems, read the script aloud near the microphone instead.
`;

export const DEFAULT_SCRIPT = `A: Good morning. This is a short release check for the live transcript. We record for about a minute, then stop and save.
B: Thanks. After we stop, the meeting should open with a summary, the notes and one action item.
A: Daniel, can you check that the recording keeps going if the connection drops for a few seconds?
B: Yes. I will test that this afternoon and send the test report by Friday.
A: Great. So the action is: Daniel sends the test report by Friday. That is everything, thank you.
`;

/** "A: text" / "B: text" lines as [{ who, text }]. Blank lines and lines starting with # are skipped. Pure. */
export function parseScript(text) {
  const turns = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^([AB])\s*:\s*(.+)$/.exec(t);
    if (!m) throw new ProvisionError(`Line ${i + 1} of the script does not start with "A:" or "B:".`);
    turns.push({ who: m[1], text: m[2] });
  });
  if (!turns.length) throw new ProvisionError('The script has no turns. Write lines like "A: Hello".');
  return turns;
}

/**
 * Is the default output a headphone or AirPods device, from `system_profiler SPAudioDataType` text?
 * Looks inside each device block whose name says headphones or AirPods for "Default Output Device: Yes". Pure.
 */
export function headphonesDefault(profiler) {
  const lines = String(profiler).split(/\r?\n/);
  const indent = (l) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    if (!/airpods|headphones|headset|earbuds/i.test(lines[i]) || !/:\s*$/.test(lines[i])) continue;
    const own = indent(lines[i]);
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > own); j++) {
      if (/Default Output Device:\s*Yes/i.test(lines[j])) return true;
    }
  }
  return false;
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export async function main(args) {
  const scriptText = args.script ? (() => {
    try { return readFileSync(args.script, 'utf8'); } catch { throw new ProvisionError(`${args.script} does not exist.`); }
  })() : DEFAULT_SCRIPT;
  const turns = parseScript(scriptText);
  const voices = { A: args['voice-a'] ?? process.env.VOICE_A ?? 'Samantha', B: args['voice-b'] ?? process.env.VOICE_B ?? 'Daniel' };
  const pause = Number(args.pause ?? process.env.PAUSE ?? 0.6);
  if (!Number.isFinite(pause) || pause < 0 || pause > 10) throw new UsageError('--pause takes seconds between 0 and 10, like 0.6.');

  if (args['dry-run']) {
    for (const t of turns) log.info(`${t.who} (${voices[t.who]}): ${t.text}`);
    log.ok(`dry run: ${turns.length} turns, nothing played`);
    return { ok: true, dryRun: true, turns: turns.length, voices };
  }
  if (process.platform !== 'darwin') throw new ProvisionError('Playback needs macOS (say and afplay). On this computer, read the script aloud near the microphone instead: run again with --dry-run to see it.');
  if (run('osascript', ['-e', 'output muted of (get volume settings)']).trim() === 'true') throw new ProvisionError('The sound is muted. Unmute it and run again.');
  let profiler = '';
  try { profiler = run('system_profiler', ['SPAudioDataType']); } catch { /* not readable: skip the headphone check */ }
  if (headphonesDefault(profiler)) throw new ProvisionError('The sound goes to headphones or AirPods, so the microphone will not hear it. Switch the output to the speakers.');

  const out = args.out ? path.resolve(args.out) : mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  mkdirSync(out, { recursive: true });
  const files = turns.map((t, i) => {
    const file = path.join(out, `${String(i).padStart(2, '0')}.aiff`);
    run('say', ['-v', voices[t.who], '-o', file, t.text]);
    return file;
  });
  for (const file of files) {
    run('afplay', ['-v', '1', file]);
    if (pause) await new Promise((r) => setTimeout(r, pause * 1000));
  }
  log.ok(`played ${turns.length} turns (audio in ${out})`);
  return { ok: true, turns: turns.length, voices, out };
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: { string: ['script', 'out', 'voice-a', 'voice-b', 'pause'], boolean: ['dry-run'] }, help: HELP, main });
}
