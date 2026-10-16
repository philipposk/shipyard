#!/usr/bin/env node
// Looks for keys and passwords in the files git tracks and fails if it finds any.
// Standalone (Node built-ins only). Runs in the pre-push hook, in CI, and from `verify`.
// It prints file:line and the kind of key, never the key itself.
//
//   node scripts/secret-scan.mjs            scan every tracked file
//   node scripts/secret-scan.mjs --staged   scan only what is staged for the next commit
//   node scripts/secret-scan.mjs --range a..b   scan every line added by the commits in a..b,
//                                               even if a later commit removed it (this is what
//                                               the pre-push hook and CI use, because history is
//                                               what reaches GitHub)
//   node scripts/secret-scan.mjs --json     machine-readable output
//
// Exit code: 0 clean, 1 something found, 2 could not run (not a git repo, bad option).

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// A key is not part of a longer word: "task_live_..." is not a Stripe key, "sk_live_..." is.
const NOT_AFTER_WORD = "(?<![A-Za-z0-9_])";

/** [name, regex]. Lines are tested one by one. */
export const PATTERNS = [
  ["Stripe secret key", new RegExp(`${NOT_AFTER_WORD}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`)],
  ["Supabase secret key", new RegExp(`${NOT_AFTER_WORD}sb_secret_[A-Za-z0-9_-]{20,}`)],
  ["Supabase access token", new RegExp(`${NOT_AFTER_WORD}sbp_[A-Za-z0-9]{20,}`)],
  ["Resend API key", new RegExp(`${NOT_AFTER_WORD}re_[A-Za-z0-9_]{20,}`)],
  ["OpenRouter API key", new RegExp(`${NOT_AFTER_WORD}sk-or-v1-[A-Za-z0-9_-]{20,}`)],
  ["OpenAI API key", /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})/],
  ["Anthropic API key", /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Google OAuth client secret", /(?<![A-Za-z0-9_])GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/],
  ["Private key block", /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],
  ["AWS access key id", /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/],
  ["GitHub token", new RegExp(`${NOT_AFTER_WORD}(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{30,}`)],
];

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Files that must never be committed, whatever is inside them. */
const ENV_FILE_RE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_FILE_OK = /\.(example|sample|template)$/;

/** Does this JWT carry the secret server role? (Public "anon" keys are fine to find.) */
function isServiceRoleJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Scan one file's text. Returns [{ line, pattern }].
 * @param {string} text
 */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [pattern, re] of PATTERNS) {
      if (re.test(line)) findings.push({ line: i + 1, pattern });
    }
    for (const match of line.matchAll(JWT_RE)) {
      if (isServiceRoleJwt(match[0])) findings.push({ line: i + 1, pattern: "Supabase service_role key" });
    }
  });
  return findings;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Paths git knows about, as `path` (tracked) or staged-only. */
function listFiles(cwd, staged) {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd)
    : git(["ls-files", "-z"], cwd);
  return out.split("\0").filter(Boolean);
}

function readFor(cwd, file, staged) {
  if (staged) return execFileSync("git", ["show", `:${file}`], { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const full = path.join(cwd, file);
  if (statSync(full).size > MAX_FILE_BYTES) return null;
  return readFileSync(full);
}

export function scanRepo({ cwd = process.cwd(), staged = false } = {}) {
  const findings = [];
  for (const file of listFiles(cwd, staged)) {
    if (ENV_FILE_RE.test(file) && !ENV_FILE_OK.test(file)) {
      findings.push({ file, line: 0, pattern: "Environment file is tracked by git (it holds keys; remove it with `git rm --cached`)" });
      continue;
    }
    if (ENV_FILE_OK.test(file) || file.split("/").includes("node_modules")) continue;
    let buffer;
    try {
      buffer = readFor(cwd, file, staged);
    } catch {
      continue; // deleted on disk, a submodule, or unreadable: nothing to scan
    }
    if (!buffer || buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;
    for (const f of scanText(buffer.toString("utf8"))) findings.push({ file, ...f });
  }
  return findings;
}

/** Words a --range value may contain besides commit names: nothing that could change what git prints. */
const RANGE_FLAGS = new Set(["--not", "--remotes"]);

/**
 * Scan every line ADDED by the commits in `range` (anything `git log` accepts, such as
 * `origin/main..HEAD` or `<sha> --not --remotes`). A key that was added in one commit and
 * deleted in the next is still in history, so it still counts.
 * Returns [{ file, line, pattern, commit }].
 */
export function scanRange({ cwd = process.cwd(), range }) {
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => (p.startsWith("-") && !RANGE_FLAGS.has(p)) || p.includes("\0"))) {
    throw new Error("bad range");
  }
  const out = git(["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--format=commit %h", ...parts, "--"], cwd);
  const findings = [];
  const seen = new Set();
  let commit = "";
  let file = "";
  let skip = false;
  let lineNo = 0;
  let inHunk = false;
  const add = (f) => {
    const key = `${f.commit}|${f.file}|${f.line}|${f.pattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };
  for (const row of out.split(/\r?\n/)) {
    if (/^commit [0-9a-f]{4,40}$/.test(row)) {
      commit = row.slice(7);
      file = "";
      skip = true;
      inHunk = false;
      continue;
    }
    if (row.startsWith("diff --git ")) {
      file = "";
      skip = true;
      inHunk = false;
      continue;
    }
    if (!inHunk && row.startsWith("+++ ")) {
      const target = row.slice(4).replace(/\t.*$/, "");
      file = target === "/dev/null" ? "" : target.replace(/^b\//, "").replace(/^"|"$/g, "");
      skip = !file || ENV_FILE_OK.test(file) || file.split("/").includes("node_modules");
      if (file && !skip && ENV_FILE_RE.test(file)) {
        add({ file, line: 0, pattern: "Environment file was committed (it holds keys; remove it with `git rm --cached`)", commit });
      }
      continue;
    }
    if (!inHunk && row.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      lineNo = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (skip || !row.startsWith("+")) continue;
    for (const f of scanText(row.slice(1))) add({ file, line: lineNo, pattern: f.pattern, commit });
    lineNo++;
  }
  return findings;
}

const HELP = `Usage: node scripts/secret-scan.mjs [--staged | --range <revisions>] [--json] [--help]

Looks for API keys and private keys in the files git tracks.
  --staged   only files staged for the next commit
  --range    every line added by the commits in a range, for example origin/main..HEAD
  --json     print the result as JSON
Exit code: 0 clean, 1 found something, 2 could not run.`;

function main(argv) {
  let range = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--range") range = argv[++i] ?? "";
    else if (argv[i].startsWith("--range=")) range = argv[i].slice(8);
    else rest.push(argv[i]);
  }
  const known = new Set(["--staged", "--json", "--help", "-h"]);
  const unknown = rest.filter((a) => !known.has(a));
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (unknown.length > 0 || (range !== null && (range.trim() === "" || rest.includes("--staged")))) {
    console.error(`${unknown.length > 0 ? `Unknown option: ${unknown[0]}` : "--range needs a value and can not be combined with --staged"}\n\n${HELP}`);
    return 2;
  }
  const json = argv.includes("--json");

  let findings;
  try {
    findings = range !== null ? scanRange({ range }) : scanRepo({ staged: rest.includes("--staged") });
  } catch {
    const message =
      range !== null
        ? "Could not read the commits to check. Run this inside the app folder, and make sure the range exists (git fetch first)."
        : "Could not list files. Run this inside the app folder, which must be a git repository.";
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`✗ ${message}`);
    return 2;
  }

  if (json) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(range !== null ? "✓ No keys or passwords found in the commits being pushed" : "✓ No keys or passwords found in tracked files");
  } else {
    console.error(`✗ Possible keys or passwords in ${findings.length} place${findings.length === 1 ? "" : "s"}:`);
    for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.pattern}${f.commit ? ` (commit ${f.commit})` : ""}`);
    console.error("Remove the value, put it in .env.local (never committed), and rotate the key if it was ever pushed.");
    if (range !== null) console.error("The key is in an earlier commit, so deleting it now is not enough. Ask Claude to rewrite those commits before you push, or create a fresh key.");
  }
  return findings.length === 0 ? 0 : 1;
}

// Compare real paths: Node resolves symlinks in import.meta.url but not in argv[1], so a plain
// string comparison silently does nothing when the app is reached through a symlinked folder
// (/tmp on macOS, a linked projects folder). A scan that prints nothing and exits 0 looks like a pass.
function startedAsScan() {
  if (!process.argv[1]) return false;
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch {
    // fall through to the name check
  }
  return path.basename(process.argv[1]) === "secret-scan.mjs";
}

if (startedAsScan()) {
  process.exitCode = main(process.argv.slice(2));
}
