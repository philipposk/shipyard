#!/usr/bin/env node
// Copies the app's name and description from src/lib/constants.ts (the one place they are set) into the
// files that can not read code: public/*.webmanifest (the installed app's name) and public/llms.txt.
// Runs before every `npm run dev` and `npm run build`, so a rename in constants.ts reaches them by itself.
// Standalone (Node built-ins only).
//
//   node scripts/sync-brand.mjs            update the files
//   node scripts/sync-brand.mjs --check    change nothing; exit 1 if a file is out of date (used by the tests)
//   node scripts/sync-brand.mjs --root <dir>   another app folder (used by tests)
//
// Exit code: 0 done or already up to date, 1 out of date (--check only), 2 could not run.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONSTANTS = "src/lib/constants.ts";
const LLMS = "public/llms.txt";

/** A `export const NAME = "..."` string from constants.ts, or null. */
function stringConst(text, name) {
  const m = new RegExp(`export const ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/**
 * { name, shortName, description } from the text of constants.ts, or null while the values are still the
 * template's placeholders (or missing).
 */
export function readBrand(constantsText) {
  const name = stringConst(constantsText, "SITE_NAME");
  const shortName = stringConst(constantsText, "SITE_SHORT_NAME");
  const description = stringConst(constantsText, "SITE_DESCRIPTION");
  const values = [name, shortName, description];
  if (values.some((v) => typeof v !== "string" || v.trim() === "" || /<[A-Z][A-Z_]*>/.test(v))) return null;
  return { name, shortName, description };
}

/** The manifest text with name, short_name and description from `brand`. Returns the same text when nothing changes. */
export function syncManifest(text, brand) {
  const manifest = JSON.parse(text);
  if (manifest.name === brand.name && manifest.short_name === brand.shortName && manifest.description === brand.description) return text;
  // Keep the key order: replace the values in place, add a key only if it is missing.
  const next = { ...manifest, name: brand.name, short_name: brand.shortName, description: brand.description };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** llms.txt with its "# Name" title and first "> summary" line from `brand`. Other lines are kept as they are. */
export function syncLlms(text, brand) {
  const lines = text.split("\n");
  const title = lines.findIndex((l) => /^#\s/.test(l));
  if (title === -1) lines.unshift(`# ${brand.name}`, "");
  else lines[title] = `# ${brand.name}`;
  const summary = lines.findIndex((l) => /^>\s/.test(l));
  if (summary === -1) {
    const at = lines.findIndex((l) => /^#\s/.test(l)) + 1;
    lines.splice(at, 0, "", `> ${brand.description}`);
  } else {
    lines[summary] = `> ${brand.description}`;
  }
  return lines.join("\n");
}

/**
 * Bring every copy in line with constants.ts. Returns { brand, changed: [relative paths], skipped: reason|null }.
 * With { check: true } nothing is written; `changed` lists what is out of date.
 */
export function syncApp(root, { check = false } = {}) {
  const constantsPath = path.join(root, CONSTANTS);
  if (!existsSync(constantsPath)) return { brand: null, changed: [], skipped: `${CONSTANTS} is missing` };
  const brand = readBrand(readFileSync(constantsPath, "utf8"));
  if (!brand) return { brand: null, changed: [], skipped: "the app name in constants.ts is not filled in yet" };

  const targets = [];
  const publicDir = path.join(root, "public");
  let names = [];
  try {
    names = readdirSync(publicDir).filter((n) => n.endsWith(".webmanifest")).sort();
  } catch {
    names = [];
  }
  for (const n of names) targets.push({ rel: `public/${n}`, fix: syncManifest });
  if (existsSync(path.join(root, LLMS))) targets.push({ rel: LLMS, fix: syncLlms });

  const changed = [];
  for (const t of targets) {
    const full = path.join(root, t.rel);
    const before = readFileSync(full, "utf8");
    let after;
    try {
      after = t.fix(before, brand);
    } catch {
      throw new Error(`${t.rel} could not be read (it is not valid JSON). Fix it by hand, then run npm run sync:brand.`);
    }
    if (after === before) continue;
    changed.push(t.rel);
    if (!check) writeFileSync(full, after);
  }
  return { brand, changed, skipped: null };
}

function main(argv) {
  let root = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i] ?? "";
    else rest.push(argv[i]);
  }
  const check = rest.includes("--check");
  const appRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  let result;
  try {
    result = syncApp(appRoot, { check });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    // Never stop `npm run dev` or a deploy over this: only the check fails.
    return check ? 2 : 0;
  }
  if (result.skipped) return 0;
  if (check) {
    if (result.changed.length === 0) return 0;
    console.error(`✗ Out of date with ${CONSTANTS}: ${result.changed.join(", ")}. Run: npm run sync:brand`);
    return 1;
  }
  if (result.changed.length > 0) console.log(`✓ Updated the app name in ${result.changed.join(", ")}`);
  return 0;
}

function startedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.basename(process.argv[1]) === "sync-brand.mjs";
  }
}

if (startedAsScript()) {
  process.exitCode = main(process.argv.slice(2));
}
