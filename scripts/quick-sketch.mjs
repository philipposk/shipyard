#!/usr/bin/env node
// Quick sketches: cheap SVG drawings of two to four design options, side by side on one page,
// plus a looping GIF when a small change (a ticked box, a new colour) is easier to see than to read.
// The agent writes the SVG files and a sketch.json; this script checks them, builds the page and
// makes the GIFs. GIFs need a browser (Playwright); without one it writes an animated SVG instead.
import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { runCli, isMain } from './provision/common.mjs';
import { UsageError } from './lib/log.mjs';
import * as log from './lib/log.mjs';
import { encodeGif } from './lib/gif.mjs';

export const MANIFEST = 'sketch.json';
export const LIMITS = { minOptions: 2, maxOptions: 4, maxFrames: 6, minFrames: 2, maxBytes: 12_000, maxElements: 80, maxSide: 800, maxAccents: 2 };

const HELP = `
Check, lay out and animate quick design sketches (SVG).

Usage:
  node quick-sketch.mjs check <folder>     Check sketch.json and every SVG it names.
  node quick-sketch.mjs board <folder>     Check, then write index.html with the options side by side.
  node quick-sketch.mjs gif <folder>       Check, then turn each variation's frames into <name>.gif.
  node quick-sketch.mjs all <folder>       check + gif + board in one go.

  --tools <dir>  A folder whose node_modules has Playwright (default: the current folder).
  --scale <n>    Pixel scale for GIFs (default 1, at most 3).
  --json         Print the result as JSON.

The folder holds sketch.json:
  { "title": "...", "question": "...", "recommended": 1,
    "options": [{ "name": "Bottom bar", "file": "option-1.svg", "note": "One sentence." }],
    "variations": [{ "name": "tick-a-task", "frames": ["tick-1.svg", "tick-2.svg"], "delay": 700 }] }

Without a browser, gif writes <name>.anim.svg (it plays in any browser) and says so.
`;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.svg$/;

/** Problems that make an SVG unsafe or not cheap. Returns { errors, warnings, viewBox }. */
export function checkSvg(text, label = 'sketch') {
  const errors = [];
  const warnings = [];
  const svg = String(text);
  const bytes = Buffer.byteLength(svg);
  if (bytes > LIMITS.maxBytes) errors.push(`${label} is ${bytes} bytes; a quick sketch stays under ${LIMITS.maxBytes}. Draw fewer, simpler shapes.`);
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) {
    errors.push(`${label} has no <svg> element.`);
    return { errors, warnings, viewBox: null };
  }
  const vb = /\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(root[0]);
  let viewBox = null;
  if (!vb) errors.push(`${label} needs a viewBox on the <svg> element, for example viewBox="0 0 360 240".`);
  else {
    viewBox = vb.slice(1, 5).map(Number);
    if (!(viewBox[2] > 0 && viewBox[3] > 0)) errors.push(`${label} has an empty viewBox.`);
  }
  if (/<script\b/i.test(svg)) errors.push(`${label} has a <script>. Sketches are drawings only.`);
  if (/\son[a-z]+\s*=/i.test(svg)) errors.push(`${label} has an event handler (on...=). Sketches are drawings only.`);
  if (/<foreignObject\b/i.test(svg)) errors.push(`${label} has <foreignObject>. Use plain shapes and <text>.`);
  if (/<(image|use|iframe|embed|object)\b[^>]*\bhref\s*=\s*["'](?!#)/i.test(svg) || /<(image|iframe|embed|object)\b/i.test(svg)) errors.push(`${label} loads an image or another file. Draw it with shapes instead.`);
  if (/url\(\s*["']?(?!#)/i.test(svg) || /@import/i.test(svg)) errors.push(`${label} loads something from outside the file (url() or @import).`);
  if (/<a\b/i.test(svg)) errors.push(`${label} has a link. Sketches are drawings only.`);
  const elements = (svg.match(/<(rect|circle|ellipse|line|polyline|polygon|path|text|g)\b/gi) ?? []).length;
  if (elements > LIMITS.maxElements) warnings.push(`${label} has ${elements} shapes; a quick sketch reads better with fewer than ${LIMITS.maxElements}.`);
  if (!/<text\b/i.test(svg)) warnings.push(`${label} has no words. Label the main parts so the sketch explains itself.`);
  if (/<(linearGradient|radialGradient|filter)\b/i.test(svg)) warnings.push(`${label} uses a gradient or filter. Keep sketches flat.`);
  const accents = new Set();
  for (const m of svg.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1].toLowerCase();
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) accents.add(h);
  }
  if (accents.size > LIMITS.maxAccents) warnings.push(`${label} uses ${accents.size} colours besides grey. Use grey plus one accent for the part that differs.`);
  return { errors, warnings, viewBox };
}

/** Read and check sketch.json and its files. Throws UsageError for a missing or broken manifest. */
export async function loadSketch(dir) {
  const folder = path.resolve(dir);
  let raw;
  try {
    raw = await readFile(path.join(folder, MANIFEST), 'utf8');
  } catch {
    throw new UsageError(`No ${MANIFEST} in ${folder}. Write it first (see --help).`);
  }
  let spec;
  try {
    spec = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new UsageError(`${MANIFEST} is not valid JSON: ${err.message}`);
  }
  const errors = [];
  const warnings = [];
  const svgs = new Map();
  const readSvg = async (file, label) => {
    if (typeof file !== 'string' || !FILE_RE.test(file)) {
      errors.push(`${label}: "${file}" is not a plain .svg file name in this folder.`);
      return null;
    }
    if (svgs.has(file)) return svgs.get(file);
    let text;
    try {
      text = await readFile(path.join(folder, file), 'utf8');
    } catch {
      errors.push(`${label}: ${file} is missing.`);
      return null;
    }
    const res = checkSvg(text, file);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
    const entry = { text, viewBox: res.viewBox };
    svgs.set(file, entry);
    return entry;
  };

  if (!spec || typeof spec !== 'object') throw new UsageError(`${MANIFEST} must be an object.`);
  if (typeof spec.title !== 'string' || !spec.title.trim()) errors.push('sketch.json needs a "title".');
  const options = Array.isArray(spec.options) ? spec.options : [];
  const variations = Array.isArray(spec.variations) ? spec.variations : [];
  if (!options.length && !variations.length) errors.push('sketch.json needs "options" (two to four sketches), "variations" (frames for a GIF), or both.');
  if (options.length && (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions)) errors.push(`Give ${LIMITS.minOptions} to ${LIMITS.maxOptions} options, not ${options.length}. More than four is no longer quick to compare.`);
  for (const [i, opt] of options.entries()) {
    const label = `Option ${i + 1}`;
    if (!opt || typeof opt.name !== 'string' || !opt.name.trim()) errors.push(`${label} needs a short "name".`);
    else if (opt.name.trim().split(/\s+/).length > 4) warnings.push(`${label}: "${opt.name}" is long. One to three words read best.`);
    if (opt && opt.note !== undefined && typeof opt.note !== 'string') errors.push(`${label}: "note" must be text.`);
    await readSvg(opt?.file, label);
  }
  if (spec.recommended !== undefined) {
    const r = spec.recommended;
    if (!Number.isInteger(r) || r < 1 || r > options.length) errors.push(`"recommended" must be an option number from 1 to ${options.length}.`);
  }
  const names = new Set();
  for (const [i, v] of variations.entries()) {
    const label = `Variation ${i + 1}`;
    if (!v || typeof v.name !== 'string' || !NAME_RE.test(v.name)) {
      errors.push(`${label} needs a "name" in lowercase words joined by dashes (it becomes the file name).`);
      continue;
    }
    if (names.has(v.name)) errors.push(`${label}: the name "${v.name}" is used twice.`);
    names.add(v.name);
    const frames = Array.isArray(v.frames) ? v.frames : [];
    if (frames.length < LIMITS.minFrames || frames.length > LIMITS.maxFrames) errors.push(`${label} needs ${LIMITS.minFrames} to ${LIMITS.maxFrames} frames, not ${frames.length}. More frames is no longer a cheap change.`);
    if (v.delay !== undefined && !(Number.isFinite(v.delay) && v.delay >= 100 && v.delay <= 5000)) errors.push(`${label}: "delay" is milliseconds per frame, from 100 to 5000.`);
    let first = null;
    for (const f of frames) {
      const entry = await readSvg(f, label);
      if (!entry?.viewBox) continue;
      if (!first) first = entry.viewBox;
      else if (entry.viewBox.join(' ') !== first.join(' ')) errors.push(`${label}: ${f} has a different viewBox from the first frame. Frames must be the same size.`);
    }
  }
  return { folder, spec: { ...spec, options, variations }, svgs, errors, warnings, ok: errors.length === 0 };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Give the root <svg> an explicit pixel size (browsers rasterise an SVG at its own size). */
export function sizedSvg(text, width, height) {
  return String(text).replace(/<svg\b[^>]*>/i, (tag) => {
    const bare = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return bare.replace(/^<svg/i, `<svg width="${width}" height="${height}"`);
  });
}

/** Strip the XML prolog and comments so an SVG can sit inline in HTML. */
function inlineSvg(text) {
  return String(text).replace(/<\?xml[^>]*\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** One SVG that shows each frame in turn (SMIL, plays in browsers without any script). */
export function animatedSvg(frameTexts, viewBox, delayMs = 700) {
  const n = frameTexts.length;
  const dur = ((n * delayMs) / 1000).toFixed(2);
  const keyTimes = Array.from({ length: n }, (_, i) => (i / n).toFixed(4)).join(';');
  const layers = frameTexts.map((text, i) => {
    const values = Array.from({ length: n }, (_, j) => (j === i ? 'visible' : 'hidden')).join(';');
    const inner = inlineSvg(text).replace(/^<svg\b[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
    return `<g visibility="${i === 0 ? 'visible' : 'hidden'}"><animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>${inner}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" width="${viewBox[2]}" height="${viewBox[3]}">${layers.join('')}</svg>\n`;
}

/** The comparison page: options side by side, the recommended one marked, then the variations. */
export function boardHtml(sketch, { gifs = {} } = {}) {
  const { spec, svgs } = sketch;
  const cards = spec.options.map((opt, i) => {
    const pick = spec.recommended === i + 1;
    const body = inlineSvg(svgs.get(opt.file)?.text ?? '');
    return `<figure class="card${pick ? ' pick' : ''}"><div class="art">${body}</div><figcaption><strong>${i + 1}. ${esc(opt.name)}</strong>${pick ? ' <span class="badge">Recommended</span>' : ''}${opt.note ? `<p>${esc(opt.note)}</p>` : ''}</figcaption></figure>`;
  });
  const vars = spec.variations.map((v) => {
    const out = gifs[v.name];
    const img = out ? `<img src="${esc(out)}" alt="${esc(v.name.replace(/-/g, ' '))}">` : '';
    return `<figure class="card"><div class="art">${img}</div><figcaption><strong>${esc(v.label ?? v.name.replace(/-/g, ' '))}</strong>${v.note ? `<p>${esc(v.note)}</p>` : ''}</figcaption></figure>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>
:root { --bg: #f6f6f4; --card: #fff; --ink: #1a1a1a; --muted: #5f5f5f; --line: #d9d9d6; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --card: #222; --ink: #f2f2f2; --muted: #b0b0b0; --line: #3a3a3a; --accent: #7aa2ff; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem 1rem 3rem; background: var(--bg); color: var(--ink); font: 1rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 72rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
.question { color: var(--muted); margin: 0 0 1.25rem; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.grid.small { grid-template-columns: repeat(auto-fill, minmax(16rem, 22rem)); }
.card { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 0.75rem; overflow: hidden; }
.card.pick { border: 2px solid var(--accent); }
.art { background: #fff; padding: 0.75rem; }
.art svg, .art img { display: block; width: 100%; height: auto; }
figcaption { padding: 0.75rem 1rem 1rem; }
figcaption p { margin: 0.25rem 0 0; color: var(--muted); }
.badge { font-size: 0.8rem; color: var(--accent); font-weight: 600; }
</style></head>
<body><main>
<h1>${esc(spec.title)}</h1>
${spec.question ? `<p class="question">${esc(spec.question)}</p>` : ''}
${cards.length ? `<div class="grid">${cards.join('\n')}</div>` : ''}
${vars.length ? `<h2>Small changes</h2><div class="grid small">${vars.join('\n')}</div>` : ''}
</main></body></html>
`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A Playwright browser, or null with the reason (GIFs then fall back to animated SVG). */
async function openBrowser(toolsDir) {
  try {
    const { loadPlaywright, launchChromium } = await import('./design/capture/browser.mjs');
    const pw = await loadPlaywright(toolsDir);
    return { browser: await launchChromium(pw) };
  } catch (err) {
    return { browser: null, reason: err?.message ?? String(err) };
  }
}

/** Raster one SVG to RGBA pixels on a white background, in the page's canvas. */
async function rasterise(page, svgText, width, height) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg(svgText, width, height))}`;
  const b64 = await page.evaluate(
    async ({ url, width, height }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      let s = '';
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { url, width, height },
  );
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Pixel size for a viewBox at a scale, the longest side capped. */
export function pixelSize(viewBox, scale = 1) {
  const [, , w, h] = viewBox;
  const s = Math.min(scale, LIMITS.maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Write <name>.gif per variation (or <name>.anim.svg without a browser). Returns { files, gif, reason }. */
export async function makeGifs(sketch, { toolsDir = process.cwd(), scale = 1, browserOpener = openBrowser } = {}) {
  const { spec, svgs, folder } = sketch;
  const files = {};
  if (!spec.variations.length) return { files, gif: false, reason: 'no variations' };
  const opened = await browserOpener(toolsDir);
  try {
    let page = null;
    if (opened.browser) {
      page = await opened.browser.newPage();
      await page.setContent('<!doctype html><html><body></body></html>');
    }
    for (const v of spec.variations) {
      const frames = v.frames.map((f) => svgs.get(f));
      const viewBox = frames[0].viewBox;
      const delay = v.delay ?? 700;
      if (page) {
        const { width, height } = pixelSize(viewBox, scale);
        const rgbaFrames = [];
        for (const f of frames) rgbaFrames.push({ width, height, rgba: await rasterise(page, f.text, width, height) });
        const out = `${v.name}.gif`;
        await writeFile(path.join(folder, out), encodeGif(rgbaFrames, { delayMs: delay }));
        files[v.name] = out;
      } else {
        const out = `${v.name}.anim.svg`;
        await rm(path.join(folder, `${v.name}.gif`), { force: true });
        await writeFile(path.join(folder, out), animatedSvg(frames.map((f) => f.text), viewBox, delay));
        files[v.name] = out;
      }
    }
  } finally {
    if (opened.browser) await opened.browser.close();
  }
  return opened.browser ? { files, gif: true } : { files, gif: false, reason: opened.reason };
}

/** Variation outputs already on disk (a GIF wins over the animated SVG). */
async function existingOutputs(sketch) {
  const found = {};
  for (const v of sketch.spec.variations) {
    for (const name of [`${v.name}.gif`, `${v.name}.anim.svg`]) {
      if (await exists(path.join(sketch.folder, name))) {
        found[v.name] = name;
        break;
      }
    }
  }
  return found;
}

function report(sketch) {
  for (const w of sketch.warnings) log.warn(w);
  for (const e of sketch.errors) log.fail(e);
  if (sketch.ok) log.ok(`${MANIFEST} and ${sketch.svgs.size} sketch file(s) look fine.`);
}

export async function main(args, deps = {}) {
  const [command, dir] = args._;
  if (!['check', 'board', 'gif', 'all'].includes(command)) throw new UsageError('Say what to do: check, board, gif or all, then the folder. See --help.');
  if (!dir) throw new UsageError('Give the sketch folder, for example: quick-sketch.mjs board .shipyard/sketches/2511-save-button');
  const scale = args.scale === undefined ? 1 : Number(args.scale);
  if (!(scale > 0 && scale <= 3)) throw new UsageError('--scale is a number from 0.5 to 3.');
  const sketch = await loadSketch(dir);
  report(sketch);
  const result = { ok: sketch.ok, folder: sketch.folder, errors: sketch.errors, warnings: sketch.warnings };
  if (!sketch.ok || command === 'check') return result;

  let gifs = {};
  if (command === 'gif' || command === 'all') {
    const made = await makeGifs(sketch, { toolsDir: args.tools ? path.resolve(args.tools) : process.cwd(), scale, ...deps });
    gifs = made.files;
    result.variations = made.files;
    result.gif = made.gif;
    for (const f of Object.values(made.files)) log.ok(`Wrote ${path.join(sketch.folder, f)}`);
    if (!made.gif && made.reason !== 'no variations') {
      result.gifNote = made.reason;
      log.warn(`No browser for GIFs, so the variations are animated SVGs (they play in any browser). ${made.reason}`);
    }
  }
  if (command === 'board' || command === 'all') {
    if (command === 'board') gifs = await existingOutputs(sketch);
    const file = path.join(sketch.folder, 'index.html');
    await writeFile(file, boardHtml(sketch, { gifs }));
    result.board = file;
    log.ok(`Wrote ${file}`);
  }
  return result;
}

if (isMain(import.meta.url)) {
  runCli({ argv: process.argv.slice(2), spec: { string: ['tools', 'scale'] }, help: HELP, main: (args) => main(args) });
}
