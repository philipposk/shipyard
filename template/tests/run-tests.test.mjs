import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(APP, "scripts", "run-tests.mjs");

const PASSING = `import { test } from "node:test";\ntest("passes", () => {});\n`;
const FAILING = `import { test } from "node:test";\ntest("fails", () => { throw new Error("on purpose"); });\n`;

/** A small app folder with the runner and the given test files; returns the runner's result. */
function runIn(files, args = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-tests-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "tests"));
    copyFileSync(RUNNER, path.join(dir, "scripts", "run-tests.mjs"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, "tests", name), text);
    // Without this the inner `node --test` would think it is a child of this test run.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [path.join(dir, "scripts", "run-tests.mjs"), ...args], {
      cwd: os.tmpdir(), // not the app folder: the runner must find tests/ by itself
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("npm test runs the runner, not a shell wildcard", () => {
  const pkg = JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs");
  assert.ok(!pkg.scripts.test.includes("*"));
});

test("runs every *.test.mjs file and exits 0 when they pass", () => {
  const r = runIn({ "a.test.mjs": PASSING, "b.test.mjs": PASSING, "helper.mjs": "throw new Error('not a test file');\n" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tests 2/);
  assert.match(r.stdout, /pass 2/);
});

test("exits with a failing code when a test fails", () => {
  const r = runIn({ "a.test.mjs": PASSING, "b.test.mjs": FAILING });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /fail 1/);
});

test("says so and exits 1 when there are no test files", () => {
  const r = runIn({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No test files found/);
});

test("passes extra arguments to node --test", () => {
  const r = runIn({ "a.test.mjs": `import { test } from "node:test";\ntest("keep me", () => {});\ntest("skip me", () => { throw new Error("should not run"); });\n` }, ["--test-name-pattern=keep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
