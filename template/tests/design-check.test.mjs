import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSource, checkApp, isSmallFontSize, RULES } from "../scripts/design-check.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(APP, "scripts", "design-check.mjs");

/** Rules found in a snippet, as a sorted list of "rule@line". */
const found = (file, text) => checkSource(file, text).map((f) => `${f.rule}@${f.line}`);
const rules = (file, text) => [...new Set(checkSource(file, text).map((f) => f.rule))];

// Fixtures are built at test time. Characters that the rules look for are written as escapes.
const EM = "—";
const PARTY = "\u{1F389}";
const SPARKLES = "✨";
const STARS = "★".repeat(5);

test("every rule has a test below", () => {
  assert.equal(RULES.length, 10);
});

// ---- 1. hard-coded-colour ----------------------------------------------------------------

test("hard-coded-colour: hex, rgb and hsl are found", () => {
  assert.deepEqual(found("src/components/A.tsx", `const a = "#abc";\nconst b = "#aabbcc";\nconst c = "#aabbccdd";`), [
    "hard-coded-colour@1", "hard-coded-colour@2", "hard-coded-colour@3",
  ]);
  assert.deepEqual(rules("src/lib/x.mjs", `export const c = "rgb(10, 20, 30)";`), ["hard-coded-colour"]);
  assert.deepEqual(rules("src/lib/x.ts", "const c = `hsla(10 20% 30% / .5)`;"), ["hard-coded-colour"]);
  assert.deepEqual(rules("src/app/extra.css", ".a { color: #fff; }"), ["hard-coded-colour"]);
});

test("hard-coded-colour: Tailwind palette classes are found, token classes are not", () => {
  for (const cls of ["bg-blue-500", "text-gray-700", "hover:bg-red-600", "dark:border-slate-800", "bg-white", "text-black/50", "ring-offset-white", "fill-emerald-400", "from-pink-500"]) {
    assert.ok(rules("src/components/A.tsx", `<div className="p-4 ${cls}" />`).includes("hard-coded-colour"), cls);
  }
  for (const cls of ["bg-card", "text-foreground", "bg-[var(--card)]", "text-(--muted)", "border", "text-sm", "bg-accent/50", "rounded-[var(--radius)]", "backdrop:bg-[var(--overlay)]"]) {
    assert.deepEqual(rules("src/components/A.tsx", `<div className="p-4 ${cls}" />`), [], cls);
  }
});

test("hard-coded-colour: tokens, keywords and var() colours are fine", () => {
  const css = `.a { color: var(--foreground); background: currentColor; border-color: transparent; outline: inherit; }\n.b { color: rgb(var(--x) / 50%); }`;
  assert.deepEqual(rules("src/app/extra.css", css), []);
});

test("hard-coded-colour: allowed in globals.css and opengraph images, and in the generated files", () => {
  assert.deepEqual(rules("src/app/globals.css", ":root { --accent: #2563eb; }"), []);
  assert.deepEqual(rules("src/app/opengraph-image.tsx", `const bg = "#112233";`), []);
  assert.deepEqual(rules("src/app/blog/opengraph-image-2.tsx", `const bg = "#112233";`), []);
  assert.deepEqual(rules("src/lib/theme.ts", `export const T = { light: "#f6f7f9" };`), []);
  assert.deepEqual(rules("src/lib/fonts.ts", `const x = "#fff";`), []);
  assert.deepEqual(rules("src/app/page.tsx", `const bg = "#112233";`), ["hard-coded-colour"]);
});

test("hard-coded-colour: html entities, page anchors and comments are not colours", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <a href="#add">x</a>;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = "&#8212; and &#x27;";`), []);
  assert.deepEqual(rules("src/app/p.tsx", `// the old colour was #ff0000\n/* #00ff00 and rgb(1,2,3) */\nexport const a = 1;`), []);
  assert.deepEqual(rules("src/app/e.css", `/* #ff0000 */\n.a { color: var(--foreground); }`), []);
});

test("hard-coded-colour: allow comment and whole-file allow", () => {
  assert.deepEqual(rules("src/components/L.tsx", `// design-check: allow-colour\nconst a = "#4285F4";`), []);
  assert.deepEqual(rules("src/components/L.tsx", `const a = "#4285F4"; // design-check: allow-colour`), []);
  assert.deepEqual(rules("src/components/L.tsx", `// design-check: allow-file colour\nconst a = "#4285F4";\n\n\n\nconst b = "#000";`), []);
  // The allow comment covers its own line and the next one only.
  assert.deepEqual(found("src/components/L.tsx", `// design-check: allow-colour\nconst a = "#4285F4";\nconst b = "#000";`), ["hard-coded-colour@3"]);
});

// ---- 2. gradient ---------------------------------------------------------------------------

test("gradient: CSS and Tailwind gradients are found", () => {
  assert.ok(rules("src/app/extra.css", ".a { background: linear-gradient(var(--a), var(--b)); }").includes("gradient"));
  assert.deepEqual(rules("src/app/globals.css", ".a { background: radial-gradient(circle, var(--a), var(--b)); }"), ["gradient"]);
  assert.deepEqual(rules("src/app/globals.css", ".a { background-image: conic-gradient(var(--a), var(--b)); }"), ["gradient"]);
  assert.deepEqual(rules("src/app/p.tsx", `<div className="bg-gradient-to-r p-4" />`), ["gradient"]);
  assert.deepEqual(rules("src/app/p.tsx", `<div className="bg-linear-to-r p-4" />`), ["gradient"]);
  assert.deepEqual(rules("src/app/p.tsx", `<div className="from-[var(--a)] to-[var(--b)]" />`), ["gradient"]);
});

test("gradient: allow comment on the line or the line before, plain backgrounds are fine", () => {
  assert.deepEqual(rules("src/app/globals.css", ".s {\n  /* design-check: allow-gradient */\n  background: linear-gradient(90deg, var(--a), var(--b));\n}"), []);
  assert.deepEqual(rules("src/app/globals.css", ".s { background: linear-gradient(var(--a), var(--b)); /* design-check: allow-gradient */ }"), []);
  assert.deepEqual(rules("src/app/p.tsx", `<div className="bg-card p-4" />`), []);
  assert.deepEqual(rules("src/app/globals.css", ".a { background: var(--card); }"), []);
});

// ---- 3. em-dash ------------------------------------------------------------------------------

test("em-dash: found in JSX text and strings, ignored in comments", () => {
  assert.deepEqual(found("src/app/p.tsx", `export const a = <p>Hello ${EM} world</p>;`), ["em-dash@1"]);
  assert.deepEqual(found("src/app/p.ts", `export const t = "Plan ${EM} pro";`), ["em-dash@1"]);
  assert.deepEqual(found("src/app/p.ts", "export const t = `a " + EM + " b`;"), ["em-dash@1"]);
  assert.deepEqual(rules("src/app/p.ts", `// note ${EM} fine\n/* also ${EM} fine */\nexport const t = 1;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Hello, world. Plain - hyphen and – en dash.</p>;`), []);
});

test("em-dash: an apostrophe in JSX text does not hide the next lines", () => {
  const text = `export const a = (\n  <p>\n    Don't miss it\n    and ${EM} more\n  </p>\n);`;
  assert.deepEqual(found("src/app/p.tsx", text), ["em-dash@4"]);
});

// ---- 4. emoji-in-ui ---------------------------------------------------------------------------

test("emoji-in-ui: emoji found, typography symbols are not", () => {
  assert.deepEqual(found("src/app/p.tsx", `export const a = <p>Saved ${PARTY}</p>;`), ["emoji-in-ui@1"]);
  assert.deepEqual(rules("src/app/p.ts", `export const a = "Done ✅";`), ["emoji-in-ui"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>© 2026 Name ™ → ✓</p>;`), []);
  assert.deepEqual(rules("src/app/p.ts", `// celebrate ${PARTY}\nexport const a = 1;`), []);
});

// ---- 5. placeholder-text -------------------------------------------------------------------------

test("placeholder-text: found in JSX text and strings only", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Lorem ipsum dolor sit amet</p>;`), ["placeholder-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <h2>Your tagline here</h2>;`), ["placeholder-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <h3>Feature 1</h3>;`), ["placeholder-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>TODO</p>;`), ["placeholder-text"]);
  assert.deepEqual(rules("src/app/p.ts", `export const title = "Feature 2";`), ["placeholder-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = (\n  <p>\n    Lorem ipsum\n  </p>\n);`), ["placeholder-text"]);
  // Not UI text.
  assert.deepEqual(rules("src/app/p.ts", `// TODO: later\nconst TODO_LIMIT = 3; // Feature 1 is done\nexport const a = TODO_LIMIT;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Todo list</p>;`), []);
});

// ---- 6. fake-proof ----------------------------------------------------------------------------------

test("fake-proof: invented numbers and logos are found", () => {
  for (const t of ["10,000+ users", "Trusted by teams", "#1 rated app", "As seen on TV", "Join thousands of happy people", "500+ customers", "5 star reviews"]) {
    const want = t === "5 star reviews" ? [] : ["fake-proof"];
    assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>${t}</p>;`), want, t);
  }
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>${STARS}</p>;`).includes("fake-proof"), true);
});

test("fake-proof: real-data comment allows it, normal copy is fine", () => {
  assert.deepEqual(rules("src/app/p.tsx", `// design-check: real-data\nexport const a = <p>1,200+ users</p>;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>You have 3 users in this group.</p>;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Trust your own notes.</p>;`), []);
});

// ---- 7. ai-badge -----------------------------------------------------------------------------------

test("ai-badge: found in UI text, once for sparkles", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <span>Powered by AI</span>;`), ["ai-badge"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <span>AI-powered notes</span>;`), ["ai-badge"]);
  assert.deepEqual(rules("src/app/p.ts", `export const a = "${SPARKLES} Magic";`), ["ai-badge"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <span>Written by you, checked by a model you pick.</span>;`), []);
  assert.deepEqual(rules("src/app/p.ts", `// powered by AI later\nexport const a = 1;`), []);
});

// ---- 8. native-alert -------------------------------------------------------------------------------------

test("native-alert: alert, confirm and prompt calls are found", () => {
  assert.deepEqual(found("src/app/p.tsx", `export function f() {\n  alert("hi");\n}`), ["native-alert@2"]);
  assert.deepEqual(rules("src/app/p.tsx", `if (window.confirm("sure?")) go();`), ["native-alert"]);
  assert.deepEqual(rules("src/app/p.ts", `const name = prompt("name");`), ["native-alert"]);
  assert.deepEqual(rules("src/app/p.ts", `globalThis.alert("x");`), ["native-alert"]);
});

test("native-alert: similar names, methods, strings and comments are fine", () => {
  assert.deepEqual(rules("src/app/p.tsx", `onConfirm(); installEvent.prompt(); modal.confirm(); myalert(1); showAlert(2);`), []);
  assert.deepEqual(rules("src/app/p.ts", `const s = "call alert(1) here";\n// alert("x")\nexport { s };`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Please confirm (yes or no)</p>;`), []);
});

// ---- 9. small-input-text ------------------------------------------------------------------------------------

test("small-input-text: CSS rules for inputs under 16px are found", () => {
  assert.deepEqual(rules("src/app/globals.css", `input { font-size: 14px; }`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/globals.css", `.form textarea, .form select { font-size: 0.875rem; }`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/globals.css", `.input { font: inherit; font-size: .9rem; }`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/globals.css", `@media (max-width: 600px) {\n  input[type="text"] { font-size: small; }\n}`), ["small-input-text"]);
});

test("small-input-text: 16px and up, other elements and unknown values are fine", () => {
  assert.deepEqual(rules("src/app/globals.css", `input { font-size: 16px; }\ntextarea { font-size: 1rem; }\nselect { font-size: 1.1em; }`), []);
  assert.deepEqual(rules("src/app/globals.css", `.btn { font-size: 0.95rem; }\nbutton { font-size: 12px; }\n.input-hint { font-size: 12px; }`), []);
  assert.deepEqual(rules("src/app/globals.css", `.input { font: inherit; font-size: 16px; }\ninput { font-size: inherit; }\ninput { font-size: var(--x); }`), []);
  assert.equal(isSmallFontSize("15.9px"), true);
  assert.equal(isSmallFontSize("16px"), false);
  assert.equal(isSmallFontSize("0.99rem"), true);
  assert.equal(isSmallFontSize("1rem"), false);
  assert.equal(isSmallFontSize("90%"), true);
  assert.equal(isSmallFontSize("clamp(1rem, 2vw, 2rem)"), false);
});

test("small-input-text: Tailwind small text on a bare input is found, the .input class is fine", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <input className="w-full text-sm" />;`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <textarea className="md:text-xs" />;`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <input className="w-full text-[13px]" />;`), ["small-input-text"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <input className="input text-sm" />;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <input type="checkbox" className="text-sm" />;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <input className="w-full text-base" />;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p className="text-sm">hi</p>;`), []);
});

// ---- 10. tip-box ---------------------------------------------------------------------------------------------------

test("tip-box: text that starts with Tip: is found", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Tip: save often</p>;`), ["tip-box"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p><b>Pro tip:</b> save often</p>;`), ["tip-box"]);
  assert.deepEqual(rules("src/app/p.ts", `export const t = "Tip: save often";`), ["tip-box"]);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = (\n  <div>\n    Tip: save often\n  </div>\n);`), ["tip-box"]);
});

test("tip-box: the word tip elsewhere is fine", () => {
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Leave a tip: the waiter will smile</p>;`), []);
  assert.deepEqual(rules("src/app/p.tsx", `export const a = <p>Tips</p>;`), []);
  assert.deepEqual(rules("src/app/p.ts", `const tip: number = 3; export { tip };`), []);
  assert.deepEqual(rules("src/app/p.ts", `// Tip: a comment\nexport const a = 1;`), []);
});

// ---- the allow comments in general -----------------------------------------------------------------------------------

test("allow-<rule> works for every rule", () => {
  const samples = {
    "em-dash": `export const a = "x ${EM} y";`,
    "emoji-in-ui": `export const a = "x ${PARTY}";`,
    "placeholder-text": `export const a = "Feature 1";`,
    "ai-badge": `export const a = "Powered by AI";`,
    "native-alert": `alert("x");`,
    "tip-box": `export const a = "Tip: x";`,
  };
  for (const [rule, code] of Object.entries(samples)) {
    assert.deepEqual(rules("src/app/p.ts", code), [rule], `${rule} is found`);
    assert.deepEqual(rules("src/app/p.ts", `// design-check: allow-${rule}\n${code}`), [], `${rule} can be allowed`);
  }
});

test("other file types and folders are not checked", () => {
  assert.deepEqual(rules("src/app/data.json", `{"a": "#fff"}`), []);
  assert.deepEqual(rules("src/app/readme.md", `# #fff ${EM}`), []);
  // .mjs files are checked for colours and gradients, not for words.
  assert.deepEqual(rules("src/lib/x.mjs", `export const a = "${EM} Feature 1";`), []);
});

test("regex literals, division and templates do not confuse the reader", () => {
  const code = [
    "export const a = /\\/\\/ not a comment/.test(s) ? 1 : 2;",
    "export const b = x / 2 / 3;",
    "export const c = `${a} // still a string ${b ? `nested ${1}` : ''}`;",
    "export const d = '\"';",
    `export const e = "bad ${EM}";`,
  ].join("\n");
  assert.deepEqual(found("src/app/p.ts", code), ["em-dash@5"]);
});

// ---- running over a folder / the command line -------------------------------------------------------------------------------

function makeApp(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "design-check-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const cli = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, ...options });

test("the template itself passes", () => {
  const { files, findings } = checkApp(APP);
  assert.deepEqual(findings, []);
  assert.ok(files > 20);
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Design check passed/);
});

test("CLI: findings print file:line rule and a fix hint, exit 1", () => {
  const dir = makeApp({ "src/app/page.tsx": `export default function P() {\n  return <p style={{ color: "#ff0000" }}>Hello</p>;\n}\n` });
  try {
    const r = cli(["--root", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src\/app\/page\.tsx:2 hard-coded-colour — use a token like var\(--accent\)/);
    assert.ok(!r.stderr.includes("#ff0000"), "the matched text is not repeated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --json, clean app, skipped generated files", () => {
  const dir = makeApp({
    "src/app/page.tsx": `export default function P() {\n  return <p className="muted">Hello</p>;\n}\n`,
    "src/lib/theme.ts": `export const THEME_COLORS = { light: "#f6f7f9" };\n`,
    "src/lib/fonts.ts": `export const fontClassName = "";\n`,
    "node_modules/pkg/index.mjs": `export const a = "#fff";\n`,
  });
  try {
    const r = cli(["--json", "--root", dir]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.findings, []);
    assert.equal(out.scanned, 1);
    writeFileSync(path.join(dir, "src", "bad.tsx"), `export const a = <p>Feature 1</p>;\n`);
    const bad = cli(["--json", "--root", dir]);
    assert.equal(bad.status, 1);
    const parsed = JSON.parse(bad.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.findings.map((f) => [f.file, f.line, f.rule]), [["src/bad.tsx", 1, "placeholder-text"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --help, bad option and missing src folder", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/design-check\.mjs/);
  for (const rule of RULES) assert.ok(help.stdout.includes(rule), rule);
  const bad = cli(["--nope"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option: --nope/);
  const empty = makeApp({ "README.md": "x" });
  try {
    const r = cli(["--root", empty]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /src folder/);
    const j = cli(["--json", "--root", empty]);
    assert.equal(j.status, 2);
    assert.equal(JSON.parse(j.stdout).ok, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("CLI: works when the script is reached through a symlinked folder", (t) => {
  const real = makeApp({ "src/app/page.tsx": `export const a = <p>Feature 1</p>;\n`, "scripts/design-check.mjs": readFileSync(SCRIPT, "utf8") });
  const link = path.join(os.tmpdir(), `design-check-link-${process.pid}`);
  try {
    symlinkSync(real, link, "dir");
  } catch {
    rmSync(real, { recursive: true, force: true });
    t.skip("symlinks are not available here");
    return;
  }
  try {
    const viaLink = spawnSync(process.execPath, [path.join(link, "scripts", "design-check.mjs")], { encoding: "utf8", cwd: os.tmpdir() });
    assert.equal(viaLink.status, 1, `${viaLink.stdout}${viaLink.stderr}`);
    assert.match(viaLink.stderr, /placeholder-text/);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------

test("npm script and CI step are in place", () => {
  const pkg = JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:design"], "node scripts/design-check.mjs");
  const ci = readFileSync(path.join(APP, ".github", "workflows", "test.yml"), "utf8");
  assert.match(ci, /run: npm run check:design/);
  const order = ["npm run lint", "npm run check:design", "npm test", "npm run build"].map((s) => ci.indexOf(`run: ${s}`));
  assert.ok(order.every((n) => n > 0), "all steps exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the design check runs after lint and before tests");
  const step = ci.slice(ci.indexOf("- name: Design check"), ci.indexOf("run: npm run check:design"));
  assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/);
});

test("the generated design files and the CSS markers are in place", () => {
  const css = readFileSync(path.join(APP, "src", "app", "globals.css"), "utf8");
  for (const mode of ["light", "dark"]) {
    const start = css.indexOf(`/* shipyard:tokens:${mode}:start */`);
    const end = css.indexOf(`/* shipyard:tokens:${mode}:end */`);
    assert.ok(start > 0 && end > start, `${mode} markers`);
    const inside = css.slice(start, end).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    const names = inside.map((l) => l.split(":")[0]);
    const colours = ["--background", "--foreground", "--card", "--muted", "--line", "--line-strong", "--accent", "--accent-contrast", "--focus", "--danger", "--danger-contrast"];
    const extra = mode === "light" ? ["--radius", "--radius-sm", "--shadow"] : ["--shadow"];
    assert.deepEqual(names, [...colours, ...extra], `${mode}: only token lines sit between the markers`);
  }
  assert.match(css, /--heading-font: var\(--font-heading, var\(--app-font\)\);/);
  assert.match(css, /--app-font: var\(--font-body, /);
  assert.match(css, /h1, h2, h3, \.heading \{ font-family: var\(--heading-font\); \}/);

  const theme = readFileSync(path.join(APP, "src", "lib", "theme.ts"), "utf8");
  assert.ok(theme.startsWith("// Generated by Shipyard design. Edit with /shipyard:design, not by hand."));
  // Any look may be applied to this app (dark by default, its own fonts), so these checks accept every look.
  const defaultTheme = /export const DEFAULT_THEME: "light" \| "dark" = "(light|dark)";/.exec(theme)?.[1];
  assert.ok(defaultTheme, "DEFAULT_THEME is light or dark");
  const colour = (mode, name) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css.slice(css.indexOf(`tokens:${mode}:start`)))[1].toLowerCase();
  assert.ok(theme.includes(`light: "${colour("light", "--background")}"`));
  assert.ok(theme.includes(`dark: "${colour("dark", "--background")}"`));

  const fonts = readFileSync(path.join(APP, "src", "lib", "fonts.ts"), "utf8");
  assert.ok(fonts.startsWith("// Generated by Shipyard design."));
  assert.match(
    fonts,
    /export const fontClassName = (?:""|\[[^\]]*\]\.filter\(Boolean\)\.join\(" "\));/,
    "fontClassName is empty (device font) or joins the font variables",
  );

  const manifest = JSON.parse(readFileSync(path.join(APP, "public", "manifest.webmanifest"), "utf8"));
  // The browser bar and install splash use the page colour of the default theme.
  assert.equal(manifest.background_color, colour(defaultTheme, "--background"));
  assert.equal(manifest.theme_color, colour(defaultTheme, "--background"));

  const layout = readFileSync(path.join(APP, "src", "app", "layout.tsx"), "utf8");
  assert.match(layout, /THEME_COLORS\.light/);
  assert.match(layout, /DEFAULT_THEME/);
  assert.match(layout, /fontClassName/);
});

test("DESIGN.md has the sections the design step writes", () => {
  const md = readFileSync(path.join(APP, "DESIGN.md"), "utf8");
  for (const h of ["## Look", "## Colours", "## Type", "## Corners and depth", "## Rules", "## Source"]) assert.ok(md.includes(h), h);
  const css = readFileSync(path.join(APP, "src", "app", "globals.css"), "utf8");
  const accent = /--accent:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.ok(md.toLowerCase().includes(accent.toLowerCase()), "the accent colour in DESIGN.md matches globals.css");
});
