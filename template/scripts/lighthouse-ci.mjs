#!/usr/bin/env node
// Runs Lighthouse CI (lhci) on the public pages with the budgets in lighthouserc.json.
//   node scripts/lighthouse-ci.mjs <base address> [--desktop]
// Also the manual pre-launch run: npm run lighthouse -- https://your-app.example
import { spawnSync } from "node:child_process";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/lighthouse-ci.mjs <https://address> [--desktop]");
  process.exit(2);
}
const pages = ["/", "/about", "/help", "/sign-in"];
const args = ["--yes", "@lhci/cli@0.15", "autorun", ...pages.map((p) => `--collect.url=${base}${p}`)];
if (process.argv.includes("--desktop")) args.push("--collect.settings.preset=desktop");
if (process.env.SKIP_SEO === "true") args.push("--assert.assertions.categories:seo=off");
const r = spawnSync("npx", args, { stdio: "inherit" });
process.exit(r.status ?? 1);
