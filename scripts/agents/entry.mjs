// Small pieces shared by the Codex and Cursor guard entry files. Built-ins only.
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Read all of stdin, but never wait longer than `limitMs` (a hook must not hang the agent). */
export function readStdin(limitMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(data);
    }, limitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      data += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Was Node started with this file? Real paths on both sides (symlinked folders), and if that
 * cannot say yes, the file name, so a hook behind a symlink never silently does nothing.
 * Importing the file from somewhere else never counts.
 */
export function startedAs(metaUrl, fileName) {
  if (!process.argv[1]) return false;
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))) return true;
  } catch {
    // fall through to the name check
  }
  const arg = process.argv[1].replace(/\\/g, '/');
  return path.posix.basename(arg) === fileName;
}
