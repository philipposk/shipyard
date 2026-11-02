// The app logo as a light and dark pair: checks the approved drawings, combines them into one icon.svg that
// follows the device, lists the PNGs to draw, and writes the manifests, the head tags and the review sheet.
// No browser and no files here; design-logo.mjs does that.

const DARK_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_QUERY = '(prefers-color-scheme: light)';
const TILE_RX_SHARE = 112 / 512;

/** Problems with one drawing, in plain words. Empty when it can be used. */
export function logoProblems(text, label = 'logo') {
  const svg = String(text ?? '');
  const problems = [];
  if (!/<svg[\s>]/i.test(svg)) return [`${label} is not an SVG drawing.`];
  const box = /viewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/i.exec(svg);
  if (!box) problems.push(`${label} needs a viewBox such as 0 0 512 512.`);
  else if (box[1] !== box[2]) problems.push(`${label} must be square (its viewBox is ${box[1]} by ${box[2]}).`);
  if (/<script[\s>]|\son[a-z]+\s*=/i.test(svg)) problems.push(`${label} contains a script, which icons must not have.`);
  if (/(?:href|src)\s*=\s*"(?!#)/i.test(svg)) problems.push(`${label} links to another file. Draw everything inside it.`);
  if (/<text[\s>]/i.test(svg)) problems.push(`${label} uses text, which depends on the fonts of each device. Draw the shapes instead.`);
  return problems;
}

function viewBoxSize(svg) {
  return Number(/viewBox="\s*0\s+0\s+([\d.]+)/i.exec(svg)?.[1] ?? 512);
}

function innerOf(svg) {
  return String(svg).replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
}

/** Ids get a prefix so two drawings can live in one file. */
export function prefixIds(inner, prefix) {
  return inner
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`);
}

function nested(svg, cls, size) {
  const box = viewBoxSize(svg);
  return `<svg class="${cls}" x="0" y="0" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}">${prefixIds(innerOf(svg), `${cls}-`)}</svg>`;
}

/** One drawing with its full square kept (for maskable and iPhone icons, where the system cuts the corners). */
export function squareSvg(svg, size = 512) {
  const box = viewBoxSize(svg);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}">${innerOf(svg)}</svg>`;
}

/** One drawing with rounded corners (for browser tabs and plain icons). */
export function roundedSvg(svg, size = 512) {
  const rx = size * TILE_RX_SHARE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs><clipPath id="tile"><rect width="${size}" height="${size}" rx="${rx}"/></clipPath></defs><g clip-path="url(#tile)">${nested(svg, 'a', size)}</g></svg>`;
}

/** The icon.svg browsers use: both drawings in one file, and the device setting picks which one shows. */
export function combinedSvg({ light, dark }) {
  const size = 512;
  const rx = size * TILE_RX_SHARE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
<style>.d{display:none}@media ${DARK_QUERY}{.l{display:none}.d{display:inline}}</style>
<defs><clipPath id="tile"><rect width="${size}" height="${size}" rx="${rx}"/></clipPath></defs>
<g clip-path="url(#tile)">${nested(light, 'l', size)}${nested(dark, 'd', size)}</g>
</svg>
`;
}

export function logoFileNames(prefix = 'icon') {
  return {
    svg: `${prefix}.svg`,
    tab: { light: `${prefix}-32.png`, dark: `${prefix}-dark-32.png` },
    apple: { light: `${prefix}-apple-180.png`, dark: `${prefix}-dark-apple-180.png` },
    any192: { light: `${prefix}-192.png`, dark: `${prefix}-dark-192.png` },
    any512: { light: `${prefix}-512.png`, dark: `${prefix}-dark-512.png` },
    maskable: { light: `${prefix}-maskable-512.png`, dark: `${prefix}-dark-maskable-512.png` },
    mono: `${prefix}-mono-512.png`,
  };
}

/** Every PNG to draw: { file, size, svg, transparent }. */
export function logoJobs({ prefix = 'icon', light, dark, mono = null }) {
  const names = logoFileNames(prefix);
  const jobs = [];
  for (const [scheme, art] of [['light', light], ['dark', dark]]) {
    jobs.push({ file: names.tab[scheme], size: 32, svg: roundedSvg(art, 32), transparent: true });
    jobs.push({ file: names.any192[scheme], size: 192, svg: roundedSvg(art, 192), transparent: true });
    jobs.push({ file: names.any512[scheme], size: 512, svg: roundedSvg(art, 512), transparent: true });
    jobs.push({ file: names.apple[scheme], size: 180, svg: squareSvg(art, 180), transparent: false });
    jobs.push({ file: names.maskable[scheme], size: 512, svg: squareSvg(art, 512), transparent: false });
  }
  if (mono) jobs.push({ file: names.mono, size: 512, svg: squareSvg(mono, 512), transparent: true });
  return jobs;
}

/** The first flat colour in a drawing: its tile, used to colour the dark splash screen. */
export function tileColor(svg) {
  return /<rect\b[^>]*\bfill="(#[0-9a-fA-F]{3,8})"/i.exec(String(svg))?.[1] ?? null;
}

function manifestIcons({ prefix, base, scheme, mono }) {
  const names = logoFileNames(prefix);
  const url = (file) => `${base}${file}`;
  const icons = [
    { src: url(names.any192[scheme]), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: url(names.any512[scheme]), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: url(names.maskable[scheme]), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  if (mono) icons.push({ src: url(names.mono), sizes: '512x512', type: 'image/png', purpose: 'monochrome' });
  return icons;
}

/** The app's manifest with the light icons, and its twin with the dark ones. */
export function logoManifests(manifestText, { prefix = 'icon', base = '/', dark = null, mono = false } = {}) {
  const manifest = JSON.parse(manifestText);
  const lightOut = { ...manifest, icons: manifestIcons({ prefix, base, scheme: 'light', mono }) };
  const darkOut = { ...manifest, icons: manifestIcons({ prefix, base, scheme: 'dark', mono }) };
  const tile = dark ? tileColor(dark) : null;
  if (tile) {
    darkOut.background_color = tile;
    darkOut.theme_color = tile;
  }
  return { light: `${JSON.stringify(lightOut, null, 2)}\n`, dark: `${JSON.stringify(darkOut, null, 2)}\n` };
}

/** "/manifest.webmanifest" becomes "/manifest-dark.webmanifest". */
export function darkManifestName(file) {
  return String(file).replace(/(\.[^./]+)?$/, (ext) => `-dark${ext}`);
}

/** The tags for a page head. The manifest swap has to run as the page loads, before anyone installs it. */
export function logoHeadTags({ prefix = 'icon', base = '/', manifest = null } = {}) {
  const names = logoFileNames(prefix);
  const url = (file) => `${base}${file}`;
  const tags = [
    `<link rel="icon" type="image/png" sizes="32x32" href="${url(names.tab.light)}" media="${LIGHT_QUERY}">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="${url(names.tab.dark)}" media="${DARK_QUERY}">`,
    `<link rel="icon" type="image/svg+xml" href="${url(names.svg)}">`,
    `<link rel="apple-touch-icon" href="${url(names.apple.light)}" media="${LIGHT_QUERY}">`,
    `<link rel="apple-touch-icon" href="${url(names.apple.dark)}" media="${DARK_QUERY}">`,
  ];
  if (manifest) {
    tags.push(`<link rel="manifest" href="${manifest}">`);
    tags.push(`<script>if(matchMedia('${DARK_QUERY}').matches)document.querySelector('link[rel=manifest]').href='${darkManifestName(manifest)}'</script>`);
  }
  return tags.join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The page to review a logo on: both modes, sizes down to 16 pixels, a browser tab, and a phone's circle cut. */
export function logoSheetPage({ light, dark, name = 'App' }) {
  const cell = (art, mode, page, ink, chrome) => {
    const icon = (size) => `<span style="width:${size}px;height:${size}px">${roundedSvg(art, size)}</span>`;
    return `<div class="cell" style="background:${page};color:${ink}">
<div class="big">${roundedSvg(art, 220)}</div>
<div class="side"><div class="sizes">${[96, 64, 48, 32, 16].map(icon).join('')}</div>
<div class="tab" style="background:${chrome}">${icon(16)}<b>${esc(name)}</b></div>
<div class="circle">${squareSvg(art, 96)}</div></div>
<small>${mode}</small></div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:20px;display:flex;gap:16px;background:#777;font:14px system-ui,sans-serif;width:max-content}
.cell{padding:18px;border-radius:14px;display:grid;grid-template-columns:220px 300px;gap:16px}
.cell small{grid-column:1 / -1;opacity:.7}
.side{display:flex;flex-direction:column;gap:14px}
.sizes{display:flex;gap:10px;align-items:flex-end}
.sizes span,.tab span{display:block}
svg{display:block}
.tab{display:inline-flex;gap:8px;align-items:center;padding:8px 14px;border-radius:9px 9px 0 0;width:150px}
.tab b{font-weight:500;font-size:13px}
.circle{width:96px;height:96px;border-radius:50%;overflow:hidden}
</style></head><body>
${cell(light, 'Light', '#ffffff', '#111111', '#dee1e6')}
${cell(dark, 'Dark', '#202124', '#eeeeee', '#35363a')}
</body></html>`;
}
