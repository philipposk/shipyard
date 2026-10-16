// The app id: the permanent name phones use for the app, like com.yourname.recipes.
// Rules: lowercase letters and digits in each part, each part starts with a letter, at least two parts,
// and it must not be a made-up example id. (Android would also allow underscores, but Apple bundle ids and web
// address schemes do not, and one id has to work on both.) Changing it later breaks installed apps and sign-in,
// so it is chosen once.

export const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// Words Android (Java) does not allow as a part of the id.
const RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'false', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while',
]);

// Ids that come from sample code. Stores and sign-in settings must never use these.
const GENERIC_PREFIXES = [
  'com.example', 'org.example', 'net.example', 'io.example', 'com.yourcompany', 'com.mycompany', 'com.company',
  'com.test', 'com.sample', 'com.demo', 'io.ionic', 'com.getcapacitor', 'com.myapp', 'com.app',
];
const GENERIC_LAST = new Set(['app', 'myapp', 'starter', 'test', 'demo', 'sample', 'example', 'placeholder']);

/** { ok: true } or { ok: false, reason } in plain English. */
export function validateAppId(id) {
  const value = String(id ?? '');
  if (!APP_ID_RE.test(value)) {
    return { ok: false, reason: `"${value}" is not a valid app id. Use lowercase letters and digits only (no dashes or underscores, Apple does not allow them) in parts separated by dots, each part starting with a letter, for example com.yourname.recipes.` };
  }
  if (value.length > 100) return { ok: false, reason: 'The app id is too long (100 characters at most).' };
  const parts = value.split('.');
  const reserved = parts.find((p) => RESERVED.has(p));
  if (reserved) return { ok: false, reason: `"${reserved}" cannot be a part of an app id (Android reserves it). Change that part, for example to "${reserved}app".` };
  if (GENERIC_PREFIXES.some((p) => value === p || value.startsWith(`${p}.`))) {
    return { ok: false, reason: `"${value}" looks like a sample id. Use an id that belongs to you, for example io.github.<your github name>.<app name> or your own domain reversed.` };
  }
  if (GENERIC_LAST.has(parts[parts.length - 1])) {
    return { ok: false, reason: `"${value}" ends in a generic word. End it with your app's name.` };
  }
  return { ok: true };
}

/** One part of an id from any word: lowercase letters and digits only, never starting with a digit, never a reserved word. */
export function cleanPart(word) {
  let p = String(word ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!p) return '';
  if (/^[0-9]/.test(p)) p = `n${p}`;
  if (RESERVED.has(p)) p = `${p}app`;
  return p;
}

/** "recipes.bakery-notes.app" becomes "app.bakerynotes.recipes". Returns '' for an address without a real domain. */
export function reverseHost(hostname) {
  const labels = String(hostname ?? '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return '';
  const parts = labels.reverse().map(cleanPart);
  return parts.some((p) => !p) ? '' : parts.join('.');
}

const isPlatformHost = (host) => /(^|\.)(vercel\.app|localhost|local)$/i.test(host) || host === '127.0.0.1';

/**
 * Pick the app id. Order: --app-id, then the custom domain reversed, then io.github.<github user>.<slug>.
 * `hosts`: addresses of the live app (custom domain first if there is one).
 * Returns { appId, source } or { error }.
 */
export function deriveAppId({ explicit, hosts = [], githubUser, slug }) {
  if (explicit) {
    const v = validateAppId(explicit);
    return v.ok ? { appId: explicit, source: 'chosen' } : { error: v.reason };
  }
  for (const host of hosts) {
    if (!host || isPlatformHost(host)) continue;
    const reversed = reverseHost(host);
    if (reversed && validateAppId(reversed).ok) return { appId: reversed, source: 'domain' };
  }
  const user = cleanPart(githubUser);
  const name = cleanPart(slug);
  if (user && name) {
    const id = `io.github.${user}.${name}`;
    const v = validateAppId(id);
    if (v.ok) return { appId: id, source: 'github' };
  }
  return { error: 'Could not pick an app id by itself (the app has no custom domain and no GitHub name is saved). Choose one and run this again with --app-id, for example --app-id io.github.yourname.myapp' };
}
