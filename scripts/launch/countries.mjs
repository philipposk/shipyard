// Country helpers for the launch scripts: names from the built-in Intl data (no list to maintain),
// plus the few groups that change what a legal page must say.

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const EEA_EXTRA = ['IS', 'LI', 'NO'];
const ALIASES = { UK: 'GB', EL: 'GR' };

const names = new Intl.DisplayNames(['en'], { type: 'region' });
let byName = null;

function nameOf(code) {
  try {
    const n = names.of(code);
    return n && n !== code ? n : null;
  } catch {
    return null;
  }
}

function nameIndex() {
  if (byName) return byName;
  byName = new Map();
  const A = 65;
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      const n = nameOf(code);
      if (n) byName.set(n.toLowerCase(), code);
    }
  }
  return byName;
}

/** "gr", "GR", "Greece" or "uk" -> { code: "GR", name: "Greece" }, or null when it is not a country. */
export function parseCountry(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text)) {
    const code = ALIASES[text.toUpperCase()] ?? text.toUpperCase();
    const name = nameOf(code);
    return name ? { code, name } : null;
  }
  const lower = text.toLowerCase();
  const aliasNames = { 'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'united states of america': 'US', usa: 'US', 'the netherlands': 'NL', holland: 'NL', czechia: 'CZ' };
  const code = aliasNames[lower] ?? nameIndex().get(lower);
  return code ? { code, name: nameOf(code) } : null;
}

export const isEu = (code) => EU.includes(code);
export const isEea = (code) => EU.includes(code) || EEA_EXTRA.includes(code);
export const isUk = (code) => code === 'GB';
/** Countries whose consumer law gives a 14-day withdrawal right to the people who buy (EU, EEA, UK). */
export const hasWithdrawalRight = (code) => isEea(code) || isUk(code);

/** Which data protection family a controller country falls under. */
export function privacyRegion(code) {
  if (isEea(code)) return 'eea';
  if (isUk(code)) return 'uk';
  if (code === 'CH') return 'ch';
  return 'other';
}

const NEEDS_THE = new Set(['United States', 'United Kingdom', 'Netherlands', 'Philippines', 'United Arab Emirates', 'Bahamas', 'Gambia', 'Maldives', 'Seychelles', 'Marshall Islands', 'Comoros', 'Czech Republic', 'Central African Republic', 'Dominican Republic', 'Congo - Kinshasa', 'Congo - Brazzaville', 'Solomon Islands', 'Cayman Islands']);

/** "United States" -> "the United States"; "Greece" stays "Greece". */
export const withArticle = (name) => (NEEDS_THE.has(name) ? `the ${name}` : name);

/** Countries with several legal systems inside (states, provinces): the student should say which law applies. */
export const hasSeveralLegalSystems = (code) => ['US', 'CA', 'AU', 'MX', 'BR', 'IN', 'AE'].includes(code);
