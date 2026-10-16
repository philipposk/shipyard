// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// Helpers for the design preview page (src/app/design-preview/[id]/page.tsx). That page reads a small JSON file that
// the Shipyard design step writes, so everything in it is checked here before it is used as CSS.

export const PREVIEW_ID_RE = /^[a-z0-9-]{1,40}$/;

export const LAYOUTS = ["bottom-nav", "sidebar", "top-nav"];
export const HOMES = ["focus", "split", "editorial", "cards", "list"];
export const LOOK_CHOICES = {
  density: ["compact", "regular", "airy"],
  cards: ["flat", "bordered", "elevated", "tinted"],
  buttons: ["solid", "pill", "outline", "sharp"],
  header: ["plain", "bar", "centered"],
};
export const DEFAULT_LOOK = { density: "regular", cards: "bordered", buttons: "solid", header: "bar" };

/** The only CSS variables a preview file may set: the colours, corners, shadow and the shape (type and spacing) values. */
export const ALLOWED_VARS = new Set([
  "--background", "--foreground", "--card", "--muted", "--line", "--line-strong",
  "--accent", "--accent-contrast", "--focus", "--danger", "--danger-contrast",
  "--radius", "--radius-sm", "--shadow", "--accent-soft",
  "--font-size-base", "--h1-size", "--h2-size", "--h3-size", "--heading-weight", "--heading-tracking",
  "--space", "--pad-card", "--gap", "--content-max",
]);

const SAFE_VALUE = /^[#a-zA-Z0-9 .,%()+\-*/]+$/;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,60}$/;
const FONT_ITEM = '(?:"[A-Za-z0-9][A-Za-z0-9 -]{0,60}"|-?[A-Za-z][A-Za-z0-9-]*)';
const FONT_STACK = new RegExp(`^${FONT_ITEM}(?:\\s*,\\s*${FONT_ITEM}){0,12}$`);
const SYSTEM_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** @param {unknown} id */
export function isPreviewId(id) {
  return typeof id === "string" && PREVIEW_ID_RE.test(id);
}

/**
 * A CSS value we are happy to put in a style: colours, lengths, shadows, calc() and clamp(). No quotes, braces,
 * semicolons, url() or comments, so a value can never end the declaration or load something.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeCssValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 200) return null;
  if (!SAFE_VALUE.test(v) || v.includes("/*") || /url\(|expression\(|@import/i.test(v)) return null;
  return v;
}

/**
 * Keep only the allowed variables with safe values.
 * @param {unknown} map
 * @returns {Record<string, string>}
 */
export function safeVars(map) {
  /** @type {Record<string, string>} */
  const out = {};
  if (map === null || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [name, value] of Object.entries(map)) {
    if (!ALLOWED_VARS.has(name)) continue;
    const v = safeCssValue(value);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Only Google Fonts stylesheets are loaded. @param {unknown} url @returns {string | null} */
export function safeFontUrl(url) {
  if (typeof url !== "string" || url.length > 600) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "fonts.googleapis.com") return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * The font-family value for a font entry (a name like Fraunces, or a ready stack like "Fraunces", Georgia, serif),
 * or null to keep the device font.
 * @param {unknown} font
 * @returns {string | null}
 */
export function fontStack(font) {
  const family = font && typeof font === "object" ? /** @type {{ family?: unknown }} */ (font).family : null;
  if (typeof family !== "string" || family === "system") return null;
  const f = family.trim();
  if (f.length > 300) return null;
  if (FONT_STACK.test(f)) return f;
  return FONT_NAME.test(f) ? `"${f}", ${SYSTEM_STACK}` : null;
}

/** @param {unknown} value @param {string[]} allowed @param {string} fallback */
const pick = (value, allowed, fallback) => (typeof value === "string" && allowed.includes(value) ? value : fallback);

/**
 * Turn the JSON from a preview file into something safe to render, or null when it is not a preview.
 * The shape is what the design step's toPreview() writes.
 * @param {unknown} json
 * @param {"light" | "dark"} theme
 */
export function readPreview(json, theme = "light") {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const j = /** @type {Record<string, any>} */ (json);
  const light = safeVars(j.theme?.light);
  // Corners and shadow sit in the light block only, so dark starts from the light values.
  const vars = { ...light, ...(theme === "dark" ? safeVars(j.theme?.dark) : {}), ...safeVars(j.shape) };
  const look = { ...DEFAULT_LOOK };
  for (const key of /** @type {const} */ (["density", "cards", "buttons", "header"])) {
    look[key] = pick(j.look?.[key], LOOK_CHOICES[key], DEFAULT_LOOK[key]);
  }
  const body = j.fonts?.body;
  const heading = j.fonts?.heading;
  /** @type {string[]} */
  const fontUrls = [];
  for (const url of [safeFontUrl(body?.cssUrl), safeFontUrl(heading?.cssUrl)]) {
    if (url && !fontUrls.includes(url)) fontUrls.push(url);
  }
  return {
    name: typeof j.name === "string" ? j.name.slice(0, 80) : "",
    vars,
    look,
    home: pick(j.home, HOMES, "focus"),
    layout: pick(j.layout, LAYOUTS, "bottom-nav"),
    bodyFont: fontStack(body),
    headingFont: fontStack(heading) ?? fontStack(body),
    fontUrls: fontUrls,
    baseSize: safeCssValue(vars["--font-size-base"]),
    background: vars["--background"] ?? null,
  };
}
