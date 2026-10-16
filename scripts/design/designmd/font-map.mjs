// Brand fonts are not free to use, so each family from a DESIGN.md is mapped to the nearest
// font Shipyard allows. Exact name first, then a hint table, then the generic family at the end of the stack.
import { SYSTEM_FONT, allowedFontNames } from '../fonts.mjs';

const HINTS = [
  [/\b(source sans|segoe|open sans|lato|fira sans|myriad|frutiger|calibri|ubuntu|selawik|proxima|ibm plex sans|noto sans)\b/i, 'Source Sans 3'],
  [/\b(nunito|rounded|quicksand|varela|baloo|fredoka|comfortaa)\b/i, 'Nunito'],
  [/\b(space grotesk|grotesk|grotesque|clash|monument|syne|neue machina)\b/i, 'Space Grotesk'],
  [/\b(fraunces|playfair|didot|bodoni|canela|garamond|cormorant|recoleta|tiempos|sectra|ivar|newsreader|abril)\b/i, 'Fraunces'],
  [/\b(georgia|merriweather|charter|lora|times|cambria|source serif|crimson|baskerville|pt serif|spectral|serif)\b/i, 'Source Serif 4'],
  [/\b(mono|monospace|courier|consolas|menlo|jetbrains|fira code|code)\b/i, 'IBM Plex Sans'],
  [/\b(manrope|figtree|plus jakarta|jakarta|outfit|urbanist|lexend|sora|satoshi|general sans)\b/i, 'Manrope'],
  [/\b(dm sans|circular|gotham|poppins|montserrat|avenir|futura|gilroy|sofia|cabinet|geometric)\b/i, 'DM Sans'],
  [/\b(inter|geist|helvetica|arial|roboto|sf pro|s[oö]hne|haas|aktiv|suisse|untitled|graphik|basier|favorit|sans)\b/i, 'Inter'],
];

const clean = (s) => s.trim().replace(/^["']|["']$/g, '').trim();

/**
 * mapFont("sohne-var, 'SF Pro Display', system-ui, sans-serif")
 *  -> { name: 'Inter', exact: false, from: 'sohne-var' }
 */
export function mapFont(stack) {
  const families = String(stack ?? '').split(',').map(clean).filter(Boolean);
  if (families.length === 0) return { name: SYSTEM_FONT, exact: false, from: '' };
  const allowed = allowedFontNames();
  const generic = /^(system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|cursive|fantasy)$/i;
  const named = families.filter((f) => !generic.test(f));
  for (const f of named) {
    const base = f.replace(/\s+(variable|var|display|text|pro|vf)\b/gi, '').trim();
    const hit = allowed.find((a) => a.toLowerCase() === base.toLowerCase());
    if (hit && hit !== SYSTEM_FONT) return { name: hit, exact: true, from: f };
  }
  for (const f of named) {
    for (const [re, name] of HINTS) if (re.test(f)) return { name, exact: false, from: f };
  }
  const tail = families.filter((f) => generic.test(f)).join(' ');
  const from = named[0] ?? families[0];
  if (/\bserif\b/i.test(tail) && !/sans-serif/i.test(tail)) return { name: 'Source Serif 4', exact: false, from };
  if (/monospace/i.test(tail)) return { name: 'IBM Plex Sans', exact: false, from };
  if (named.length === 0) return { name: SYSTEM_FONT, exact: false, from };
  return { name: 'Inter', exact: false, from };
}
