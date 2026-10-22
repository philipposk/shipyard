#!/usr/bin/env node
// Session-start update check. At most once a day it asks GitHub for the latest Shipyard release
// and, if that is newer than this copy, prints one line saying how to update.
// It never blocks a session: offline, slow, rate-limited or broken all mean "say nothing", fast.
// Turn it off with SHIPYARD_NO_UPDATE_CHECK=1.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;
const REPO = 'philipposk/shipyard';
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const UPDATE_HINT = 'run /plugin, then Marketplaces, then shipyard, then Update marketplace (or `claude plugin update shipyard@shipyard`)';

/** "v1.2.3" -> [1,2,3]; anything that is not a plain release version -> null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** True only when `latest` is a valid version strictly above `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeCache(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch { /* a read-only home just means we check again next time */ }
}

async function fetchLatest(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'shipyard-update-check' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const tag = (await res.json())?.tag_name;
    return parseVersion(tag) ? String(tag).replace(/^v/, '') : null;
  } catch { return null; }
}

/** Returns the notice line, or '' when there is nothing to say. Never throws. */
export async function checkForUpdate({ env = process.env, now = Date.now(), root } = {}) {
  try {
    if (env.SHIPYARD_NO_UPDATE_CHECK === '1') return '';
    const pluginRoot = root || env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const current = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version;
    if (!parseVersion(current)) return '';
    const home = env.SHIPYARD_HOME ? path.resolve(env.SHIPYARD_HOME) : path.join(os.homedir(), '.shipyard');
    const cacheFile = path.join(home, 'update-check.json');
    const cache = readJson(cacheFile);
    let latest = cache?.latest ?? null;
    const fresh = typeof cache?.checkedAt === 'number' && now - cache.checkedAt >= 0 && now - cache.checkedAt < DAY_MS;
    if (!fresh) {
      const timeout = Number(env.SHIPYARD_UPDATE_TIMEOUT_MS) || TIMEOUT_MS;
      const fetched = await fetchLatest(env.SHIPYARD_UPDATE_URL || RELEASE_URL, timeout);
      // Offline or a failed lookup still counts as today's check, so an offline laptop
      // does not pay the timeout on every session. Keep the last known version.
      if (fetched) latest = fetched;
      writeCache(cacheFile, { checkedAt: now, latest });
    }
    return isNewer(latest, current) ? `Shipyard ${latest} is out (you have ${current}). To update: ${UPDATE_HINT}.` : '';
  } catch { return ''; }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const line = await checkForUpdate();
  // systemMessage is shown to the person; Claude Code ignores unknown or empty output.
  if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
  process.exit(0);
}
