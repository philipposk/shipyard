// The app's name and words, read from the one place they are set: src/lib/constants.ts in the app.
// .shipyard-app.json keeps a copy from the day the app was made; when the two differ, constants.ts wins,
// so renaming an app is one edit there and every Shipyard script (phone and desktop apps, emails, Stripe,
// legal pages, verify) follows.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const BRAND_FILE = path.join('src', 'lib', 'constants.ts');

/** A `export const NAME = "..."` string from the text of constants.ts, or null. */
export function stringConst(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(String(text ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

const filled = (v) => (typeof v === 'string' && v.trim() !== '' && !v.includes('<APP_') ? v.trim() : null);

/** { name, shortName, description, tagline } from constants.ts text. A value that is missing or still a placeholder is null. */
export function parseBrand(text) {
  return {
    name: filled(stringConst(text, 'SITE_NAME')),
    shortName: filled(stringConst(text, 'SITE_SHORT_NAME')),
    description: filled(stringConst(text, 'SITE_DESCRIPTION')),
    tagline: filled(stringConst(text, 'SITE_TAGLINE')),
  };
}

/** parseBrand() of <appDir>/src/lib/constants.ts, or null when the file is not there. */
export async function readAppBrand(appDir) {
  let text;
  try {
    text = await readFile(path.join(appDir, BRAND_FILE), 'utf8');
  } catch {
    return null;
  }
  return parseBrand(text);
}

/** The config with `name` and `description` taken from constants.ts where it has them. Does not change `config`. */
export function withBrand(config, brand) {
  if (!brand) return config;
  const out = { ...config };
  if (brand.name) out.name = brand.name;
  if (brand.description) out.description = brand.description;
  return out;
}
