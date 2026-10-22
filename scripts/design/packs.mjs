// Theme packs: every look ships as a light + dark pair. Shared by the CLI
// (scripts/theme-packs.mjs), the tests and the app templates.
import { contrast, normalizeHex } from "./color.mjs";

export const MODES = ["light", "dark"];
export const REQUIRED_TOKENS = ["bg", "surface", "text", "muted", "border", "accent", "onAccent"];
// AA: body text 4.5:1. Muted text is still text, so 4.5 too. Borders are decoration.
export const CONTRAST_PAIRS = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["muted", "bg", 4.5],
  ["onAccent", "accent", 4.5],
];
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const CSS_VAR = { bg: "--bg", surface: "--surface", text: "--text", muted: "--muted", border: "--border", accent: "--accent", onAccent: "--on-accent" };

/** Returns a list of plain-English problems; empty means the packs are fine. */
export function checkPacks(packs, { defaultId } = {}) {
  const problems = [];
  if (!Array.isArray(packs) || packs.length === 0) return ["There are no theme packs."];
  const seen = new Set();
  for (const [i, p] of packs.entries()) {
    const name = p?.id ?? `pack #${i + 1}`;
    if (!p || typeof p.id !== "string" || !ID.test(p.id)) problems.push(`${name}: id must be lowercase letters, digits and dashes.`);
    if (seen.has(p?.id)) problems.push(`${name}: the id is used twice.`);
    seen.add(p?.id);
    if (!p?.label) problems.push(`${name}: needs a label.`);
    if (!p?.preview) problems.push(`${name}: needs a preview image path.`);
    if ("mode" in (p ?? {}) || "forcedMode" in (p ?? {})) problems.push(`${name}: a pack never forces light or dark; remove "mode".`);
    for (const mode of MODES) {
      const t = p?.tokens?.[mode];
      if (!t) { problems.push(`${name}: missing the ${mode} version. Every pack needs light and dark.`); continue; }
      let ok = true;
      for (const k of REQUIRED_TOKENS) {
        if (!normalizeHex(t[k] ?? "")) { problems.push(`${name} (${mode}): "${k}" must be a colour like #1a1a1a.`); ok = false; }
      }
      if (!ok) continue;
      for (const [fg, bg, min] of CONTRAST_PAIRS) {
        const r = contrast(t[fg], t[bg]);
        if (r < min) problems.push(`${name} (${mode}): ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1.`);
      }
    }
  }
  if (defaultId !== undefined && !packs.some((p) => p?.id === defaultId)) problems.push(`The default pack "${defaultId}" is not in the list.`);
  return problems;
}

function vars(t, mode) {
  const out = [`color-scheme:${mode}`];
  for (const k of REQUIRED_TOKENS) out.push(`${CSS_VAR[k]}:${normalizeHex(t[k])}`);
  for (const [k, v] of Object.entries(t.extra ?? {})) out.push(`${k}:${v}`);
  return out.join(";");
}

/** CSS for every pack. The default pack also owns bare :root so the page is right before any script runs. */
export function packsCss(packs, defaultId) {
  const out = [];
  for (const p of packs) {
    for (const mode of MODES) {
      const sel = [`:root[data-pack="${p.id}"][data-theme="${mode}"]`];
      if (p.id === defaultId) sel.push(`:root:not([data-pack])[data-theme="${mode}"]`);
      out.push(`${sel.join(",")}{${vars(p.tokens[mode], mode)}}`);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Inline pre-paint script: reads the pack and the Light/Dark/Auto choice and
 * stamps data-pack and data-theme before first paint, so nothing flashes.
 * Unknown or tampered values fall back to the default.
 */
export function bootScript({ ids, defaultId, defaultMode = "system", packKey = "theme-pack", modeKey = "theme" }) {
  const list = JSON.stringify(ids);
  return `(function(){try{var d=document.documentElement,ids=${list},p=localStorage.getItem(${JSON.stringify(packKey)});if(ids.indexOf(p)<0)p=${JSON.stringify(defaultId)};var m=localStorage.getItem(${JSON.stringify(modeKey)});if(m!=="light"&&m!=="dark"&&m!=="system")m=${JSON.stringify(defaultMode)};var k=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);d.setAttribute("data-pack",p);d.setAttribute("data-theme",k?"dark":"light");}catch(e){}})();`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * A very simple, self-contained comparison page: for each direction, an
 * optional mood image and a tiny mock (header, card, button, list) in light
 * and dark. Good enough to choose from; the real app is built after.
 */
export function mockPage({ app, directions }) {
  const cards = directions.map((d, i) => {
    const letter = String.fromCharCode(65 + i);
    const mock = (mode) => {
      const t = d.tokens[mode];
      return `<div class="mock" style="background:${t.bg};color:${t.text};border-color:${t.border};font-family:${esc(d.font ?? "system-ui, sans-serif")}">
<div class="bar" style="border-color:${t.border}"><b>${esc(app)}</b><span style="color:${t.muted}">${mode}</span></div>
<div class="card" style="background:${t.surface};border-color:${t.border};border-radius:${esc(d.radius ?? "10px")}"><b>${esc(d.sample?.title ?? "Today")}</b><p style="color:${t.muted}">${esc(d.sample?.line ?? "Three things need you.")}</p>
<button style="background:${t.accent};color:${t.onAccent};border-radius:${esc(d.radius ?? "10px")}">${esc(d.sample?.action ?? "Start")}</button></div>
<ul>${(d.sample?.items ?? ["First item", "Second item", "Third item"]).map((x) => `<li style="border-color:${t.border}">${esc(x)}</li>`).join("")}</ul></div>`;
    };
    const img = d.moodImage ? `<img class="mood" src="${esc(d.moodImage)}" alt="Mood image for ${esc(d.name)}">` : "";
    return `<section><h2>${letter}. ${esc(d.name)}</h2><p>${esc(d.description ?? "")}</p>${img}<div class="pair">${mock("light")}${mock("dark")}</div>
<p class="pick">To choose it, say: <code>Shipyard: use direction ${letter} for ${esc(app)}</code></p></section>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(app)}: pick a look</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f4f4f5;color:#18181b}h1{margin:0 0 16px}section{background:#fff;border-radius:12px;padding:20px;margin:0 0 20px}
.mood{width:100%;max-height:260px;object-fit:cover;border-radius:8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}@media(max-width:700px){.pair{grid-template-columns:1fr}}
.mock{border:1px solid;border-radius:10px;padding:14px}.bar{display:flex;justify-content:space-between;border-bottom:1px solid;padding-bottom:8px;margin-bottom:12px}
.card{border:1px solid;padding:12px}.card p{margin:4px 0 10px}button{border:0;padding:8px 14px;font:inherit;font-weight:600}ul{list-style:none;padding:0;margin:12px 0 0}li{border-top:1px solid;padding:8px 0}.pick code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style>
<h1>${esc(app)}: pick a look</h1>${cards}</html>\n`;
}
