// Edit a .env-style file without disturbing the lines we don't own.
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './common.mjs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Characters that never need quotes in a .env file.
const PLAIN_VALUE = /^[A-Za-z0-9_./:@+=,-]*$/;

/** Format a value for a .env line. Quotes it when it holds spaces, #, $ or similar. */
export function formatEnvValue(value) {
  const v = String(value);
  if (/[\r\n\0]/.test(v)) throw new Error('A value with a line break can not be stored in a .env file.');
  if (PLAIN_VALUE.test(v)) return v;
  if (v.includes("'")) throw new Error('A value with a single quote can not be stored in a .env file.');
  return `'${v}'`;
}

/**
 * Return `text` with these KEY=value pairs set. Existing lines for other keys,
 * comments and blank lines stay exactly as they were. A key that already exists
 * is changed in place (the last one wins, like dotenv); a new key is added at the end.
 */
export function mergeEnv(text, updates) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source === '' ? [] : source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a valid variable name.`);
    const line = `${key}=${formatEnvValue(value)}`;
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    let index = -1;
    lines.forEach((l, i) => {
      if (re.test(l)) index = i;
    });
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}

/** File text, or '' when it doesn't exist yet. */
export async function readEnvText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Set pairs in a .env file (created with mode 600 when new). Returns the names that were set. */
export async function updateEnvFile(file, updates) {
  const next = mergeEnv(await readEnvText(file), updates);
  await atomicWrite(file, next, 0o600);
  return Object.keys(updates);
}
