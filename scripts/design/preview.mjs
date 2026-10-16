// toPreview(tokens): everything the app's /design-preview/<id> page needs to show a look on the
// student's own app, as plain JSON. The renderer writes it to <app>/.shipyard/design/<id>.preview.json.
//
// Shape (all values are strings unless noted):
//   { id, name, defaultTheme,
//     theme:  { light: { "--background": "#...", ... }, dark: { ... } },   // colours, corners, shadow, --accent-soft
//     shape:  { "--font-size-base": "16px", ... "--content-max": "960px" },
//     look:   { density, cards, buttons, header },
//     home:   "focus" | "split" | "editorial" | "cards" | "list",
//     layout: "bottom-nav" | "sidebar" | "top-nav",
//     fonts:  { body: { family, cssUrl }, heading: { family, cssUrl } } }   // cssUrl is null for the device font
import { COLOR_KEYS, CSS_VARS, deriveShape, headingFont, normalizeTokens, shadowCss, withDefaults } from './tokens.mjs';
import { cssFamily, googleFontCssUrl } from './fonts.mjs';

/** Colours + corners + shadow for one theme, as inline-style variables. Complete on its own. */
function themeVars(t, theme) {
  const block = t[theme];
  const vars = {};
  for (const k of COLOR_KEYS) vars[CSS_VARS[k]] = block[k];
  vars['--radius'] = `${t.radius.base}px`;
  vars['--radius-sm'] = `${t.radius.sm}px`;
  vars['--shadow'] = shadowCss(t.shadow, theme);
  // In the app this is declared once on :root with var(); inline on a wrapper it must be a plain value.
  vars['--accent-soft'] = `color-mix(in srgb, ${block.accent} ${theme === 'dark' ? 7 : 9}%, ${block.card})`;
  return vars;
}

export function toPreview(input) {
  const t = withDefaults(normalizeTokens(input));
  const shape = deriveShape(t);
  const bodyName = t.font.body;
  const headName = headingFont(t);
  const weight = Number(shape['--heading-weight']);
  const body = { family: cssFamily(bodyName), cssUrl: googleFontCssUrl(bodyName, { headingWeight: headName === bodyName ? weight : null }) };
  const heading = headName === bodyName ? { ...body } : { family: cssFamily(headName), cssUrl: googleFontCssUrl(headName, { headingWeight: weight }) };
  return {
    id: t.id,
    name: t.name,
    defaultTheme: t.defaultTheme === 'dark' ? 'dark' : 'light',
    theme: { light: themeVars(t, 'light'), dark: themeVars(t, 'dark') },
    shape,
    look: { density: t.layout.density, cards: t.layout.cards, buttons: t.layout.buttons, header: t.layout.header },
    home: t.layout.home,
    layout: t.layout.nav,
    fonts: { body, heading },
  };
}

/** The text of <id>.preview.json */
export const previewJson = (tokens) => `${JSON.stringify(toPreview(tokens), null, 2)}\n`;
