import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The home page shows a picture of the app. It must read as a picture: nothing in it may look like a working
// input or button, because visitors try to click what looks clickable. These tests read the source files.

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(APP, rel), "utf8");

/** The source of one exported function in a file (from `export function Name` to the next export, or the end). */
function functionSource(text, name) {
  const start = text.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = text.indexOf("\nexport function", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** The text of one CSS rule's selector list and body, for every rule whose selector mentions `needle`. */
function cssRulesMentioning(css, needle) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].includes(needle)) out.push(`${m[1].trim()} {${m[2]}}`);
  }
  return out;
}

test("home-content.ts has a preview: a title and 3 to 5 sample rows with a title and a short word", () => {
  const text = read("src/lib/home-content.ts");
  const block = /\n\s{2}preview:\s*\{([\s\S]*?)\n\s{2}\},/.exec(text)?.[1] ?? "";
  assert.ok(block, "HOME has a preview block");
  assert.match(block, /title:\s*"[^"]+"/, "the preview has a title");
  const rows = [...block.matchAll(/\{\s*title:\s*"([^"]+)",\s*meta:\s*"([^"]+)"\s*\}/g)];
  assert.ok(rows.length >= 3 && rows.length <= 5, `3 to 5 rows, found ${rows.length}`);
  const titles = rows.map((r) => r[1]);
  assert.equal(new Set(titles).size, titles.length, "row titles are different");
  // The rows are sample content of the app, never the site's own menu links.
  const entryTitles = [...text.matchAll(/\{\s*kicker:\s*"[^"]*",\s*title:\s*(?:"([^"]*)"|`[^`]*`)/g)].map((m) => m[1]).filter(Boolean);
  for (const t of titles) assert.ok(!entryTitles.includes(t), `preview row "${t}" is not a nav entry`);
  assert.ok(!/href/.test(block), "a preview row has no link");
  // The interface says the same.
  assert.match(text, /export interface HomePreview\b/);
  assert.match(text, /preview:\s*HomePreview;/);
});

test("the preview picture has no input, button, link or form control in it", () => {
  const parts = read("src/components/home/parts.tsx");
  const picture = functionSource(parts, "HomePreview");
  for (const tag of ["input", "button", "textarea", "select", "form", "label", "a", "Link", "details", "summary"]) {
    assert.ok(!new RegExp(`<${tag}(?=[\\s/>])`).test(picture), `no <${tag}> in the preview`);
  }
  assert.ok(!/(?<![\w-])(?:btn|input|list-row|menu-item|link)(?:-[\w-]+)?(?![\w-])/.test(picture.replace(/className="[^"]*hm-[^"]*"/g, "")), "no .btn, .input, .list-row, .menu-item or .link class");
  for (const bad of ["onClick", "onChange", "onSubmit", "href=", "tabIndex", "role=\"button\"", "role=\"textbox\""]) {
    assert.ok(!picture.includes(bad), `no ${bad} in the preview`);
  }
});

test("the preview is hidden from screen readers and cannot be focused, and has a visible caption", () => {
  const picture = functionSource(read("src/components/home/parts.tsx"), "HomePreview");
  assert.match(picture, /<figure[^>]*aria-hidden="true"/);
  assert.match(picture, /<figure[^>]*\binert\b/);
  assert.match(picture, /caption = "What it looks like inside"/, "the default caption");
  assert.match(picture, /<figcaption[^>]*>\{caption\}<\/figcaption>/);
  // A browser-window frame: a bar with three dots and the app name from BRAND.
  assert.equal((picture.match(/className="hm-window-dot"/g) ?? []).length, 3, "three dots");
  assert.match(picture, /\{BRAND\.name\}/, "the app name comes from BRAND");
  assert.match(picture, /content\.preview/, "the rows come from home-content.ts");
});

test("the picture is drawn with static text and chips, and its styles use tokens only", () => {
  const css = read("src/app/globals.css");
  for (const cls of [".hm-figure", ".hm-window", ".hm-window-bar", ".hm-window-dot", ".hm-window-row", ".hm-chip", ".hm-caption"]) {
    assert.ok(cssRulesMentioning(css, cls).length > 0, `${cls} is styled`);
  }
  const rules = ["hm-figure", "hm-window", "hm-chip", "hm-caption", "hm-dot"].flatMap((n) => cssRulesMentioning(css, n)).join("\n");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(rules), "no hard-coded colour in the picture's styles");
  assert.ok(!/gradient/.test(rules), "no gradient");
  assert.match(cssRulesMentioning(css, ".hm-figure")[0], /pointer-events:\s*none/, "the picture ignores the mouse");
  assert.ok(!/\.btn|\.input/.test(cssRulesMentioning(css, ".hm-window").join("\n")), "the frame does not borrow .btn or .input");
});

test("the split home draws the picture and the three points as cards", () => {
  const split = read("src/components/home/HomeSplit.tsx");
  assert.match(split, /<HomePreview content=\{content\} \/>/);
  assert.ok(!/<input|<button|hm-preview|list-row/.test(split), "HomeSplit has no input-looking pieces of its own");
  assert.match(split, /content\.points\.map/, "the points are shown");
  assert.match(split, /className="hm-point card card-pad"/, "as cards, like the focus home");
  assert.match(split, /hm-split-points/);
});

test("no home pattern draws a pretend control: everything that looks clickable is a real link", () => {
  for (const name of ["HomeFocus", "HomeSplit", "HomeEditorial", "HomeCards", "HomeList"]) {
    const src = read(`src/components/home/${name}.tsx`);
    assert.ok(!/<input|<button|<textarea|<select/.test(src), `${name} has no form control`);
    // A .btn is only used for the two real actions (HomeActions or the quick links, both real <Link>s).
    for (const m of src.matchAll(/<(\w+)[^>]*className="[^"]*\bbtn\b[^"]*"/g)) {
      assert.equal(m[1], "Link", `${name}: a .btn must be a <Link>`);
    }
  }
  const parts = read("src/components/home/parts.tsx");
  const actions = functionSource(parts, "HomeActions");
  assert.equal((actions.match(/<Link /g) ?? []).length, 2, "the two actions are real links");
});
