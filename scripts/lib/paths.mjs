// Where Shipyard keeps things. Everything personal lives in one folder in the
// student's home directory (~/.shipyard). Tests point SHIPYARD_HOME at a temp dir.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HOME_DIR = process.env.SHIPYARD_HOME
  ? path.resolve(process.env.SHIPYARD_HOME)
  : path.join(os.homedir(), '.shipyard');
export const PROFILE_PATH = path.join(HOME_DIR, 'profile.json');
export const SECRETS_PATH = path.join(HOME_DIR, 'secrets.env');
export const LEARNINGS_PATH = path.join(HOME_DIR, 'learnings.md');
export const SETTINGS_HTML = path.join(HOME_DIR, 'settings.html');

// scripts/lib -> scripts -> plugin root
export const PLUGIN_ROOT = path.resolve(here, '..', '..');
export const TEMPLATE_DIR = path.join(PLUGIN_ROOT, 'template');

/** Create ~/.shipyard if needed (private to the user on macOS/Linux). Returns its path. */
export async function ensureHomeDir() {
  await mkdir(HOME_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      await chmod(HOME_DIR, 0o700);
    } catch {
      // Not ours to chmod (for example a shared test dir). Not fatal.
    }
  }
  return HOME_DIR;
}

/**
 * Is this file the one Node was started with? Compares real paths on both sides,
 * so it still works when the plugin sits behind a symlink (a symlinked home or dev
 * folder, /tmp on macOS, a --plugin-dir link). Pass import.meta.url.
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
