#!/usr/bin/env node
// Runs every tests/*.test.mjs with Node's built-in test runner (`npm test`).
// Why not `node --test tests/*.test.mjs`? The * is expanded by the shell, and Windows
// shells do not do that, so on Windows with Node 20 it fails. This lists the files itself.
// Node built-ins only. Extra arguments go to `node --test` (for example --test-name-pattern).

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  console.error("No test files found in tests/ (looking for *.test.mjs).");
  process.exit(1);
}

const child = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

if (child.error) {
  console.error(`Could not start the tests: ${child.error.message}`);
  process.exit(1);
}
// A test run that was killed by a signal has no exit code.
process.exit(child.status ?? 1);
