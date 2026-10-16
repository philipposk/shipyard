#!/usr/bin/env node
// Writes the text of DESIGN.md: the plain-language record of the app's look, for people and for
// the coding agent. Also a tiny command so the template can ship the file for its default look:
//   node design-md.mjs <preset-id> [app name]
import { COLOR_KEYS, CSS_VARS, COLOR_WORDS, DETAILS, WORDS, deriveShape, headingFont, shadowCss, typeSizes, withDefaults } from './tokens.mjs';
import { SYSTEM_FONT } from './fonts.mjs';
import { isMainModule } from '../lib/paths.mjs';

const fontWords = (name) => (name === SYSTEM_FONT ? 'the device font (system)' : name);
const cornerWords = (n) => (n <= 6 ? 'sharp' : n <= 12 ? 'slightly rounded' : n <= 18 ? 'rounded' : 'very round');

const SOURCES = {
  preset: (t) => `A ready-made Shipyard look: "${t.name}" (\`${t.id}\`).`,
  screenshot: () => 'Drawn from screenshots the owner chose. Only colours, fonts, corner size and layout feel were taken, never logos, images or text.',
  url: () => 'Drawn from the style of a website the owner chose. Only colours, fonts, corner size and layout feel were taken, never logos, images or text.',
  'design-md': () => 'Adapted from a DESIGN.md file in the free awesome-design-md collection (MIT). Brand names and logos were removed; only the style was kept.',
  custom: () => 'A custom look.',
};

/**
 * renderDesignMd(tokens, { appName, source, date })
 * `date` is "YYYY-MM-DD"; pass null to leave the date out (used for the template's own copy).
 */
export function renderDesignMd(input, { appName = 'This app', source = 'preset', date = null } = {}) {
  const t = withDefaults(input);
  const head = headingFont(t);
  const shape = deriveShape(t);
  const sizes = typeSizes(t.type.scale);
  const L = t.layout;
  const px = (name) => shape[name];
  const rows = COLOR_KEYS.map(
    (k) => `| ${COLOR_WORDS[k]} | \`${CSS_VARS[k]}\` | \`${t.light[k]}\` | \`${t.dark[k]}\` |`,
  ).join('\n');
  const sourceLine = (SOURCES[source] ?? SOURCES.custom)(t);
  const defaultWord = t.defaultTheme === 'dark' ? 'Dark' : 'Light';
  const otherWord = t.defaultTheme === 'dark' ? 'light' : 'dark';
  return `# ${appName} design

## Look

${t.name}.${t.description ? ` ${t.description}` : ''}${t.goodFor ? ` Good for ${t.goodFor}.` : ''}
${defaultWord} is the default; ${otherWord} switches on with \`data-theme="${otherWord}"\` on \`<html>\`, set before the first paint by the small script in \`src/app/layout.tsx\`. The person's choice (\`light\`, \`dark\` or \`system\`) is saved in \`localStorage\` under \`theme\`.

## Colours

Defined in \`src/app/globals.css\` between the \`shipyard:tokens:light\` and \`shipyard:tokens:dark\` markers. Never write a colour value in a component; use these variables (and \`--accent-soft\`, a pale mix of the accent and the card).

| Use | Variable | Light | Dark |
|---|---|---|---|
${rows}

## Type

Body: ${fontWords(t.font.body)}. Headings: ${head === t.font.body ? 'same as body' : fontWords(head)}, weight ${shape['--heading-weight']}, letter spacing ${WORDS.tracking[t.type.headingTracking]}. Loaded in \`src/lib/fonts.ts\` and used through \`--app-font\` and \`--heading-font\`.
Text size is ${WORDS.scale[t.type.scale]}: body ${sizes.base}px, \`h1\` ${sizes.h1}px (smaller on phones), \`h2\` ${sizes.h2}px, \`h3\` ${sizes.h3}px. They come from the variables \`--font-size-base\`, \`--h1-size\`, \`--h2-size\`, \`--h3-size\`, \`--heading-weight\` and \`--heading-tracking\`; never type a size into a component. Inputs stay 16px or bigger. One \`h1\` per page.

## Layout

Written by the design step; change it there. The shape variables sit in \`src/app/globals.css\` between the \`shipyard:tokens:shape\` markers.

- Menu: ${WORDS.nav[L.nav]} (\`${L.nav}\`, \`LAYOUT\` in \`src/lib/constants.ts\`). On phones every layout shows a tab bar at the bottom.
- Homepage: ${WORDS.home[L.home]} (\`${L.home}\`, \`HOME_STYLE\` in \`src/lib/theme.ts\`). The words on it live in \`src/lib/home-content.ts\`.
- Cards: ${DETAILS.cards[L.cards]} (\`${L.cards}\`).
- Buttons: ${DETAILS.buttons[L.buttons]} (\`${L.buttons}\`).
- Top bar: ${DETAILS.header[L.header]} (\`${L.header}\`).
- Spacing: ${WORDS.density[L.density]}. Unit ${px('--space')}, card padding ${px('--pad-card')}, gaps ${px('--gap')}.
- Page width: ${WORDS.maxWidth[L.maxWidth]}, up to ${px('--content-max')}.

Cards, buttons and the top bar take their style from \`data-cards\`, \`data-buttons\` and \`data-header\` on \`<html>\` (from \`LOOK\` in \`src/lib/theme.ts\`). Use \`.card\`, \`.btn\`, \`.btn-primary\`, \`.btn-secondary\` and \`.app-header\` and the look follows; do not restyle them per page.

## Corners and depth

Cards use \`--radius\` (${t.radius.base}px, ${cornerWords(t.radius.base)}). Buttons and inputs use \`--radius-sm\` (${t.radius.sm}px).
Depth: ${t.shadow === 'none' ? 'no shadows, only thin lines' : t.shadow === 'crisp' ? 'a thin crisp outline, no blur' : 'a soft shadow'} (\`--shadow: ${shadowCss(t.shadow, 'light')}\`).

## Rules

- One accent colour. No gradients, no purple glow, no gradient text.
- Colours only through the variables above, so dark mode keeps working. Use the classes in \`globals.css\` (\`.btn\`, \`.card\`, \`.input\`, \`.list-row\`) before writing new CSS.
- No em dashes in text people read. No emoji as icons. No fake numbers, reviews or "trusted by".
- 44px touch targets, visible focus, respect reduced motion.
- Empty, loading and error states are designed, not blank.
- Run \`npm run check:design\` before saying a screen is done.

## Source

${sourceLine}${date ? ` Applied ${date}.` : ''}
Change it with \`/shipyard:design\`. That rewrites this file, the colour block in \`globals.css\`, \`src/lib/theme.ts\` and \`src/lib/fonts.ts\` together, so edit through the design step, not by hand.
`;
}

async function cli(argv) {
  const [id, name = '<APP_NAME>'] = argv;
  if (!id || id === '--help') {
    process.stdout.write('Usage: node design-md.mjs <preset-id> [app name]\nPrints the DESIGN.md text for a ready-made look.\n');
    return id ? 0 : 2;
  }
  const { loadPreset } = await import('./presets.mjs');
  const { tokens } = await loadPreset(id);
  process.stdout.write(renderDesignMd(tokens, { appName: name, source: 'preset' }));
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
