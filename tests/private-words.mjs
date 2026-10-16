// The maker's private identifiers (old domains, account names) must never ship in the plugin.
// The list itself is private too, so it lives in .private-words.txt at the repo root (gitignored),
// one word per line. Tests that use it are skipped when the file is missing (e.g. on CI or a fork).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.private-words.txt');

export function privateWordsRegex() {
  let text;
  try { text = readFileSync(FILE, 'utf8'); } catch { return null; }
  const words = text.split(/\r?\n/).map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
  if (!words.length) return null;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(esc.join('|'), 'i');
}
