import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPreviewId, safeCssValue, safeVars, safeFontUrl, fontStack, readPreview, DEFAULT_LOOK,
} from "../src/lib/preview.mjs";

test("isPreviewId: lower-case letters, digits and dashes, 1 to 40 characters", () => {
  for (const ok of ["calm-blue", "direction-a", "x", "a1-b2", "a".repeat(40)]) assert.equal(isPreviewId(ok), true, ok);
  for (const bad of ["", "A", "a b", "../x", "a/b", "a.b", "a".repeat(41), "a_b", null, undefined, 5]) assert.equal(isPreviewId(bad), false, String(bad));
});

test("safeCssValue: colours, lengths, shadows, clamp() pass; anything that could break out does not", () => {
  for (const ok of ["#2563eb", "14px", "0em", "clamp(25px, 6vw, 31.5px)", "0 6px 24px rgba(0, 0, 0, 0.07)", "0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--line)", "color-mix(in srgb, #2563eb 12%, #ffffff)", "-0.02em", 700]) {
    assert.notEqual(safeCssValue(ok), null, String(ok));
  }
  for (const bad of ["red; background: url(x)", "url(https://x.test/a.png)", "a}b{c", "x /* y */", "\"quoted\"", "'q'", "</style>", "@import x", "expression(1)", "", "a".repeat(201), {}, null, undefined, NaN]) {
    assert.equal(safeCssValue(bad), null, String(bad));
  }
});

test("safeVars: only the known variables survive", () => {
  const out = safeVars({ "--background": "#fff", "--accent": "#2563eb", "--header-h": "1px", "--evil": "1", "--radius": "url(x)", "--gap": "12px" });
  assert.deepEqual(out, { "--background": "#fff", "--accent": "#2563eb", "--gap": "12px" });
  assert.deepEqual(safeVars(null), {});
  assert.deepEqual(safeVars([1, 2]), {});
});

test("safeFontUrl: only https Google Fonts stylesheets", () => {
  assert.ok(safeFontUrl("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400..700&display=swap"));
  for (const bad of ["http://fonts.googleapis.com/css2?family=X", "https://evil.test/css", "https://fonts.googleapis.com.evil.test/x", "javascript:alert(1)", "", null, 5]) {
    assert.equal(safeFontUrl(bad), null, String(bad));
  }
});

test("fontStack: a name or a ready stack; device font and junk give null", () => {
  assert.match(fontStack({ family: "DM Sans" }), /^"DM Sans", ui-sans-serif/);
  assert.equal(fontStack({ family: '"Fraunces", ui-serif, Georgia, serif' }), '"Fraunces", ui-serif, Georgia, serif');
  assert.equal(fontStack({ family: "system" }), null);
  for (const bad of ["x; color: red", '"a"}body{x', "a{b}", "url(x)", "", "a".repeat(301)]) assert.equal(fontStack({ family: bad }), null, bad);
  assert.equal(fontStack(null), null);
});

const SAMPLE = {
  id: "t", name: "Test look",
  theme: {
    light: { "--background": "#fff", "--foreground": "#111", "--radius": "14px", "--shadow": "none" },
    dark: { "--background": "#000", "--foreground": "#eee", "--shadow": "none" },
  },
  shape: { "--font-size-base": "15px", "--content-max": "640px" },
  look: { density: "airy", cards: "flat", buttons: "pill", header: "centered" },
  home: "editorial", layout: "top-nav",
  fonts: {
    body: { family: '"Nunito", ui-sans-serif, system-ui, sans-serif', cssUrl: "https://fonts.googleapis.com/css2?family=Nunito:wght@400..700&display=swap" },
    heading: { family: "system", cssUrl: null },
  },
};

test("readPreview: light, then dark keeps the corners from light", () => {
  const light = readPreview(SAMPLE, "light");
  assert.equal(light.vars["--background"], "#fff");
  assert.equal(light.vars["--radius"], "14px");
  assert.equal(light.vars["--content-max"], "640px");
  assert.equal(light.baseSize, "15px");
  const dark = readPreview(SAMPLE, "dark");
  assert.equal(dark.vars["--background"], "#000");
  assert.equal(dark.vars["--radius"], "14px");
  assert.equal(dark.background, "#000");
  assert.deepEqual(dark.look, { density: "airy", cards: "flat", buttons: "pill", header: "centered" });
  assert.equal(dark.home, "editorial");
  assert.equal(dark.layout, "top-nav");
  assert.deepEqual(dark.fontUrls, ["https://fonts.googleapis.com/css2?family=Nunito:wght@400..700&display=swap"]);
  assert.match(dark.bodyFont, /^"Nunito"/);
  assert.equal(dark.headingFont, dark.bodyFont, "a device-font heading falls back to the body font");
});

test("readPreview: unknown choices fall back to the defaults, junk is not a preview", () => {
  const p = readPreview({ look: { density: "huge", cards: 3 }, home: "wild", layout: "../x", fonts: { body: { cssUrl: "https://evil.test/x" } } });
  assert.deepEqual(p.look, DEFAULT_LOOK);
  assert.equal(p.home, "focus");
  assert.equal(p.layout, "bottom-nav");
  assert.deepEqual(p.fontUrls, []);
  assert.equal(p.bodyFont, null);
  for (const junk of [null, undefined, "x", 5, []]) assert.equal(readPreview(junk), null);
});
