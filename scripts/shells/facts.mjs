// Reads what add-shell and store-check need to know about an app: its name, live address, colours, icon and sign-in setup.
// Everything is read from the app folder and the Shipyard profile; nothing is changed here.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readAppConfig, isLocalOrigin, ProvisionError } from '../provision/common.mjs';
import * as realProfile from '../lib/profile.mjs';
import { parseHex } from '../../shells/mobile/scripts/png.mjs';

export const exists = (p) => stat(p).then(() => true, () => false);
export const readText = async (p) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return '';
  }
};

const LIGHT_DEFAULT = {
  background: '#f6f7f9', foreground: '#14161a', card: '#ffffff', muted: '#5b6270', line: '#e3e6eb',
  accent: '#2563eb', 'accent-contrast': '#ffffff',
};
const DARK_DEFAULT = {
  background: '#0e1116', foreground: '#eceff4', card: '#171b22', muted: '#9aa3b2', line: '#262c36',
  accent: '#6b9bff', 'accent-contrast': '#0a0f1a',
};

/** The `--name: value;` lines between the Shipyard marker comments of one token block. */
export function parseTokenBlock(css, block) {
  const m = new RegExp(`shipyard:tokens:${block}:start\\s*\\*/([\\s\\S]*?)/\\*\\s*shipyard:tokens:${block}:end`).exec(css);
  const out = {};
  if (!m) return out;
  for (const line of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[line[1]] = line[2].trim();
  return out;
}

const hexOr = (value, fallback) => (parseHex(value) ? value : fallback);

/** Colours from the app's globals.css, always plain hex (anything else falls back to the starter value). */
export function readColors(css) {
  const light = parseTokenBlock(css, 'light');
  const dark = parseTokenBlock(css, 'dark');
  const pick = (src, def) => Object.fromEntries(Object.keys(def).map((k) => [k, hexOr(src[k], def[k])]));
  const shape = parseTokenBlock(css, 'shape');
  const radius = /^\d+(\.\d+)?px$/.test(light.radius ?? '') ? light.radius : '14px';
  return { light: pick(light, LIGHT_DEFAULT), dark: pick(dark, DARK_DEFAULT), radius, shape };
}

/** Relative brightness 0..1 of a hex colour (used to choose light or dark status bar text). */
export function brightness(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 1;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** A string constant from src/lib/constants.ts, or ''. */
function constant(text, name) {
  const m = new RegExp(`export const ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** The three short points on the home page, when they are plain strings. */
export function readHomePoints(text) {
  const out = [];
  const block = /points:\s*\[([\s\S]*?)\]\s*,\s*entries/.exec(text)?.[1] ?? '';
  for (const m of block.matchAll(/title:\s*"((?:[^"\\]|\\.)*)"\s*,\s*text:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      out.push({ title: JSON.parse(`"${m[1]}"`), text: JSON.parse(`"${m[2]}"`) });
    } catch {
      // skip a line we can not read
    }
  }
  return out;
}

/** True when `NEXT_PUBLIC_GOOGLE_SIGNIN_ENABLED=true` is set for this app (config, or the app's own .env.local). */
export async function googleEnabled(appDir, config) {
  if (config.googleSignin === true) return true;
  const local = await readText(path.join(appDir, '.env.local'));
  return /^\s*NEXT_PUBLIC_GOOGLE_SIGNIN_ENABLED\s*=\s*["']?true["']?\s*$/m.test(local);
}

/** First live https address (not localhost) among the candidates, or ''. */
export function pickLiveUrl(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(String(c));
      if (u.protocol === 'https:' && !isLocalOrigin(u.origin)) return u.origin;
    } catch {
      // not an address
    }
  }
  return '';
}

export async function readFacts(appDir, deps = {}) {
  const config = await readAppConfig(appDir);
  const profileApi = deps.profile ?? realProfile;
  let profile = {};
  try {
    profile = await profileApi.loadProfile();
  } catch {
    profile = {};
  }
  const app = (profile.apps ?? []).find((a) => a.slug === config.slug) ?? null;
  const constants = await readText(path.join(appDir, 'src', 'lib', 'constants.ts'));
  const css = await readText(path.join(appDir, 'src', 'app', 'globals.css'));
  const theme = await readText(path.join(appDir, 'src', 'lib', 'theme.ts'));
  const home = await readText(path.join(appDir, 'src', 'lib', 'home-content.ts'));
  const colors = readColors(css);
  const defaultTheme = /DEFAULT_THEME:\s*"light"\s*\|\s*"dark"\s*=\s*"(light|dark)"/.exec(theme)?.[1] ?? 'light';

  // The custom domain first when the app has one (launch-domain records it), then the address the deploy found.
  const liveCandidates = [
    config.customDomainUrl,
    typeof config.domain === 'string' && config.domain ? `https://${config.domain}` : '',
    config.url,
    app?.status === 'live' ? app?.url : '',
  ];
  const url = pickLiveUrl(liveCandidates);
  const hosts = [];
  for (const c of liveCandidates) {
    try {
      if (c) hosts.push(new URL(c).hostname);
    } catch {
      // skip
    }
  }

  const name = config.name || constant(constants, 'SITE_NAME') || config.slug;
  const iconSvgPath = path.join(appDir, 'public', 'icon.svg');
  return {
    appDir,
    config,
    profile,
    slug: config.slug,
    name,
    shortName: constant(constants, 'SITE_SHORT_NAME') || name,
    description: config.description || constant(constants, 'SITE_DESCRIPTION') || '',
    tagline: constant(constants, 'SITE_TAGLINE') || config.description || '',
    url,
    host: url ? new URL(url).hostname : '',
    domainHosts: hosts,
    githubUser: profile.accounts?.github?.user ?? '',
    contactEmail: profile.company?.contactEmail || profile.owner?.email || '',
    modules: Array.isArray(config.modules) ? config.modules : [],
    colors,
    defaultTheme,
    startColor: defaultTheme === 'dark' ? colors.dark.background : colors.light.background,
    iconSvg: (await exists(iconSvgPath)) ? await readText(iconSvgPath) : '',
    homePoints: readHomePoints(home),
    google: await googleEnabled(appDir, config),
  };
}

/** Plain-English refusal when the app is not live yet. */
export function needLiveUrl() {
  return new ProvisionError('This app has no live web address yet. Phone and desktop apps open your live website, so deploy first: run /shipyard:new-app until the app is live (or run deploy.mjs), then run this again.', { reason: 'not-live' });
}
