#!/usr/bin/env node
// Theme packs CLI.
//   check <packs.json> [--default <id>]   fail on a missing light/dark version, a forced mode or low contrast
//   css   <packs.json> --default <id>     print the CSS for every pack
//   boot  <packs.json> --default <id>     print the no-flash pre-paint script
//   mock  <directions.json> --app <name> [--out file.html]   write the simple comparison page
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bootScript, checkPacks, mockPage, packsCss } from "./design/packs.mjs";

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const usage = () => { console.error("usage: theme-packs.mjs check|css|boot|mock <file.json> [--default id] [--app name] [--out file]"); process.exit(2); };
if (!cmd || !file) usage();
let data;
try { data = JSON.parse(readFileSync(resolve(file), "utf8")); } catch (e) { console.error(`Could not read ${file}: ${e.message}`); process.exit(2); }
const packs = Array.isArray(data) ? data : data.packs;
const defaultId = opt("default") ?? data.defaultId;

if (cmd === "check") {
  const problems = checkPacks(packs, { defaultId });
  if (problems.length) { for (const p of problems) console.error(`- ${p}`); process.exit(1); }
  console.log(`OK: ${packs.length} pack(s), each with light and dark, all text at AA contrast.`);
} else if (cmd === "css" || cmd === "boot") {
  const problems = checkPacks(packs, { defaultId });
  if (problems.length || !defaultId) { for (const p of problems.length ? problems : ["--default is required."]) console.error(`- ${p}`); process.exit(1); }
  process.stdout.write(cmd === "css" ? packsCss(packs, defaultId) : bootScript({ ids: packs.map((p) => p.id), defaultId }) + "\n");
} else if (cmd === "mock") {
  const dirs = Array.isArray(data) ? data : data.directions;
  const problems = checkPacks(dirs.map((d, i) => ({ id: d.id ?? `direction-${i + 1}`, label: d.name, preview: "mock", tokens: d.tokens })));
  if (problems.length) { for (const p of problems) console.error(`- ${p}`); process.exit(1); }
  const out = resolve(opt("out") ?? "design-mock.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, mockPage({ app: opt("app") ?? data.app ?? "Your app", directions: dirs }));
  console.log(`Wrote ${out}`);
} else usage();
