// Shared fixtures for the shells tests: a copy of the real template with placeholders filled, marked live.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplateDir, tempDir } from './verify-helpers.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const FAKE_URL = 'https://bakery-notes.example.net';

const FILL = {
  '<APP_SLUG>': 'bakery-notes', '<APP_NAME>': 'Bakery Notes', '<APP_SHORT_NAME>': 'Bakery',
  '<APP_DESCRIPTION>': 'Keep your bread recipes, timings and tasting notes in one place.',
  '<APP_TAGLINE>': 'Keep your bread recipes, timings and tasting notes in one place.', '<APP_LAYOUT>': 'bottom-nav',
};

async function walk(dir, fn) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, fn);
    else await fn(p);
  }
}

/** A filled copy of the template. opts: { url, google, modules, config } */
export async function makeShellApp({ url = FAKE_URL, google = false, modules = [], config = {}, prefix = 'shipyard-shells-' } = {}) {
  const parent = await tempDir(prefix);
  const dir = path.join(parent, 'bakery-notes');
  await mkdir(dir, { recursive: true });
  await copyTemplateDir(dir);
  await walk(dir, async (p) => {
    if (!/\.(?:ts|tsx|mjs|json|md|css|webmanifest|svg)$/.test(p)) return;
    let text = await readFile(p, 'utf8');
    if (!text.includes('<APP_')) return;
    for (const [k, v] of Object.entries(FILL)) text = text.replaceAll(k, v);
    await writeFile(p, text);
  });
  const full = {
    slug: 'bakery-notes', name: 'Bakery Notes', description: FILL['<APP_DESCRIPTION>'], layout: 'bottom-nav', modules, pwa: true, private: false,
    env: ['NEXT_PUBLIC_SUPABASE_URL'], createdAt: '2026-10-01T00:00:00.000Z', pluginVersion: '0.4.0', url, siteUrl: url, ...config,
  };
  await writeFile(path.join(dir, '.shipyard-app.json'), `${JSON.stringify(full, null, 2)}\n`);
  if (google) await writeFile(path.join(dir, '.env.local'), 'NEXT_PUBLIC_GOOGLE_SIGNIN_ENABLED=true\n');
  return { dir, parent };
}

/** profile double: no file access */
export const fakeProfile = (extra = {}) => {
  const state = { upserts: [] };
  return {
    state,
    loadProfile: async () => ({ owner: { name: 'Sam Baker', email: 'sam@example.net', country: 'GR' }, accounts: { github: { user: 'sam-baker' } }, company: {}, domain: {}, apps: [], ...extra }),
    upsertApp: async (app) => { state.upserts.push(app); return app; },
  };
};
