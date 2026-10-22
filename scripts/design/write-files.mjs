// Turns a token file into the files of an app. Pure planning first (what each file would look like),
// then writing. Nothing is written unless every file can be written.
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../provision/common.mjs';
import { tokenLines, shapeLines, renderThemeTs, manifestColor, resolveHeadingWeight, withDefaults } from './tokens.mjs';
import { renderFontsTs } from './fonts.mjs';
import { renderDesignMd } from './design-md.mjs';
import { withLayout } from './layout-file.mjs';
import { skillHint } from '../lib/agent.mjs';

export const FILES = {
  css: 'src/app/globals.css',
  theme: 'src/lib/theme.ts',
  fonts: 'src/lib/fonts.ts',
  constants: 'src/lib/constants.ts',
  manifest: 'public/manifest.webmanifest',
  designMd: 'DESIGN.md',
};

/** Thrown when an app is missing something the design step needs. The message is for the student. */
export class DesignFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DesignFileError';
  }
}

// `theme` is "light", "dark" or "shape" (type sizes, spacing, widths)
const marker = (theme, edge) => `/* shipyard:tokens:${theme}:${edge} */`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Put `lines` between the start and end markers of one theme in globals.css.
 * Anything that was between the markers is replaced. Keeps the file's line endings.
 */
export function replaceMarkerBlock(css, theme, lines) {
  const start = marker(theme, 'start');
  const end = marker(theme, 'end');
  const re = new RegExp(`^([ \\t]*)${escapeRe(start)}[ \\t]*(\\r?\\n)([\\s\\S]*?)^([ \\t]*)${escapeRe(end)}`, 'm');
  const count = (needle) => css.split(needle).length - 1;
  if (count(start) !== 1 || count(end) !== 1 || !re.test(css)) {
    throw new DesignFileError(
      `src/app/globals.css has no "${start}" and "${end}" lines (exactly one of each, start first). `
      + `Without them Shipyard cannot change the ${theme === 'shape' ? 'text sizes and spacing' : 'colours'} safely. Add the two marker comments around the ${theme === 'shape' ? 'size and spacing' : 'colour'} variables, or restore the file from the template, then try again.`,
    );
  }
  return css.replace(re, (_all, indent, eol, _old, endIndent) => `${indent}${start}${eol}${lines.map((l) => `${indent}${l.replace(/^ {2}/, '')}${eol}`).join('')}${endIndent}${end}`);
}

/** Does the file have the pair of markers for this block? 'both', 'none' or 'half' (a broken pair). */
export function markerState(css, theme) {
  const has = (edge) => css.includes(marker(theme, edge));
  return has('start') && has('end') ? 'both' : !has('start') && !has('end') ? 'none' : 'half';
}

/** The lines currently between a theme's markers (for the "what changed" summary). */
export function readMarkerBlock(css, theme) {
  const start = escapeRe(marker(theme, 'start'));
  const end = escapeRe(marker(theme, 'end'));
  const m = new RegExp(`${start}[^\\n]*\\n([\\s\\S]*?)^[ \\t]*${end}`, 'm').exec(css);
  if (!m) return {};
  const vars = {};
  for (const line of m[1].split(/\r?\n/)) {
    const v = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (v) vars[v[1]] = v[2];
  }
  return vars;
}

/** [{ name, from, to }] for every variable whose value differs */
export function diffVars(before, after) {
  const out = [];
  for (const [name, to] of Object.entries(after)) {
    if (before[name] !== to) out.push({ name, from: before[name] ?? null, to });
  }
  return out;
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function setManifestColors(text, color) {
  let out = text;
  for (const key of ['theme_color', 'background_color']) {
    const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
    if (re.test(out)) out = out.replace(re, `$1${color}$2`);
    else out = out.replace(/\{\s*\r?\n?/, (open) => `${open}  "${key}": "${color}",\n  `);
  }
  return out;
}

/**
 * planFiles(appDir, tokens, { languages, appName, source, date }) ->
 *   { files: [{ rel, abs, before, after, changed, created }], vars: { light: [...], dark: [...] } }
 * Throws DesignFileError when the app lacks the markers or the folders.
 */
export async function planFiles(appDir, tokens, { languages = ['en'], appName = 'This app', source = 'preset', date = null } = {}) {
  const abs = (rel) => path.join(appDir, ...rel.split('/'));
  const look = withDefaults(tokens);
  const notes = [];
  const css = await readIfExists(abs(FILES.css));
  if (css === null) {
    throw new DesignFileError(`This folder has no src/app/globals.css, so it does not look like a Shipyard app. Run this from the app folder, or create the app with ${skillHint('new-app')}.`);
  }
  let nextCss = replaceMarkerBlock(css, 'light', tokenLines(look, 'light'));
  nextCss = replaceMarkerBlock(nextCss, 'dark', tokenLines(look, 'dark'));
  // The shape block (type sizes, spacing, widths) arrived with template v3. An older app has no markers for it:
  // colours still apply, and we say what was skipped. A half-broken pair is an error, like the colour markers.
  const shape = markerState(css, 'shape');
  if (shape === 'none') {
    notes.push('This app was made with an older template, so text sizes, spacing and page width were not changed. Colours, fonts, corners and the layout style were.');
  } else {
    nextCss = replaceMarkerBlock(nextCss, 'shape', shapeLines(look));
  }

  const files = [{ rel: FILES.css, before: css, after: nextCss }];
  const add = async (rel, after) => files.push({ rel, before: await readIfExists(abs(rel)), after });
  await add(FILES.theme, renderThemeTs(look));
  await add(FILES.fonts, renderFontsTs({
    body: look.font.body, heading: look.font.heading, languages, headingWeight: resolveHeadingWeight(look).weight,
  }));
  const constants = await readIfExists(abs(FILES.constants));
  if (constants !== null) {
    const next = withLayout(constants, look.layout.nav);
    if (next === null) {
      throw new DesignFileError(`I could not find the line "export const LAYOUT = ..." in ${FILES.constants}, so I cannot set the menu style. Put it back the way the template has it, then try again.`);
    }
    files.push({ rel: FILES.constants, before: constants, after: next });
  }
  const manifest = await readIfExists(abs(FILES.manifest));
  if (manifest !== null) files.push({ rel: FILES.manifest, before: manifest, after: setManifestColors(manifest, manifestColor(look)) });
  await add(FILES.designMd, renderDesignMd(look, { appName, source, date }));

  for (const f of files) {
    f.abs = abs(f.rel);
    f.created = f.before === null;
    f.changed = f.before !== f.after;
  }
  const vars = {
    light: diffVars(readMarkerBlock(css, 'light'), parseLines(tokenLines(look, 'light'))),
    dark: diffVars(readMarkerBlock(css, 'dark'), parseLines(tokenLines(look, 'dark'))),
    shape: shape === 'none' ? [] : diffVars(readMarkerBlock(css, 'shape'), parseLines(shapeLines(look))),
  };
  return { files, vars, notes };
}

function parseLines(lines) {
  const out = {};
  for (const l of lines) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Write every changed file (each one in a single step, so a crash never leaves half a file). */
export async function writePlanned(files) {
  for (const f of files) {
    if (!f.changed) continue;
    await mkdir(path.dirname(f.abs), { recursive: true });
    await atomicWrite(f.abs, f.after);
  }
}
