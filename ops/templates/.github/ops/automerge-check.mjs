// Decides whether a pull request may merge itself. Run by .github/workflows/automerge.yml.
//
// In plain words:
//   - Small, low-risk changes are allowed to merge themselves, but only AFTER the Tests check is green.
//   - Anything that touches sign-in, the database, payments, the build setup or GitHub's own settings, or
//     anything big, is never merged by a robot. It gets the "needs-review" label and waits for you.
//   - Dependabot (the bot that updates packages) may merge patch and minor updates. A major update never does.
//
// This file is read from the main branch, not from the pull request, so a pull request can not change the
// rules that judge it. It has no dependencies. Keep it that way.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------
// The rules. Edit the lists below if your app has other places you never want a robot to merge.

/** A folder (ends with "/") or one file. A change to any of these needs a human. */
export const RISKY_PATHS = [
  // The database: a wrong change can expose or delete everyone's data. The whole folder, not just migrations.
  "supabase/",
  // Who may see which page, and everything about signing in (the sign-in pages that swap a login code for a
  // session and send people on, the session, the "where to go next" guard, the "is this request from my own
  // site" guard, the slow-down for repeated requests, account deletion, the admin pages, profile edits).
  "src/proxy.ts",
  "src/app/auth/",
  "src/app/api/auth/",
  "src/lib/auth/",
  "src/lib/session.ts",
  "src/lib/safe-next.mjs",
  "src/lib/same-origin.mjs",
  "src/lib/rate-limit.mjs",
  "src/lib/supabase/",
  "src/lib/admin.ts",
  "src/lib/account/",
  "src/app/admin/",
  "src/app/api/admin/",
  "src/app/api/account/",
  "src/app/api/profile/",
  // Money.
  "src/lib/billing/",
  "src/app/api/billing/",
  // Modules that use the secret server key (it skips every privacy rule): the email list and the error log.
  "src/lib/newsletter/",
  "src/app/api/newsletter/",
  "src/lib/errors/",
  "src/app/api/errors/",
  // The tests that guard all of this. A pull request must not be able to delete the tests that would fail it.
  "tests/",
  // The robot's own rules and the checks that guard the app.
  ".github/",
  ".githooks/",
  "scripts/",
  "src/app/api/ops/",
  // How the app is built and shipped.
  "package.json",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "vercel.json",
  "eslint.config.mjs",
  "tsconfig.json",
  ".coderabbit.yaml",
  // The rules your coding agent follows, and what it may read.
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorignore",
  ".cursorrules",
  ".cursor/",
  ".codex/",
  ".agents/",
];

/** More than this many changed lines (not counting lock files) counts as big. */
export const BIG_LINES = 400;

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"]);
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const DEPENDABOT = "dependabot[bot]";
const REVIEW_LABEL = "needs-review";
const OK_LABEL = "automerge";
const MARKER = "<!-- shipyard-automerge -->";

// ---------------------------------------------------------------------------------------------
// Paths

function normalize(file) {
  let p = String(file ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  p = p.replace(/\/{2,}/g, "/").toLowerCase();
  return p;
}

/**
 * Is this path one of the risky ones? A folder entry matches everything inside it, and the folder's own name
 * (a symlink can stand in for a folder). "src/lib/auth/" matches src/lib/auth/session.ts but not
 * src/lib/auth-helpers.ts. A file entry matches that file at the top of the app, and package.json anywhere.
 */
export function isRiskyPath(file) {
  const p = normalize(file);
  if (p === "" || p.startsWith("../") || p.includes("/../") || p.startsWith("/")) return true; // odd path: be careful
  for (const rule of RISKY_PATHS) {
    const r = rule.toLowerCase();
    if (r.endsWith("/")) {
      if (p.startsWith(r) || p === r.slice(0, -1)) return true;
    } else if (p === r) return true;
  }
  return p.split("/").pop() === "package.json";
}

export const isLockfile = (file) => LOCKFILES.has(normalize(file));

// ---------------------------------------------------------------------------------------------
// Versions

function parseVersion(spec) {
  const m = /^[\^~=v\s]*(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(spec ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * How big is the step from one version (or range like ^1.2.3) to another?
 * "patch" and "minor" are safe, "major" is not. A step down or something odd is "unknown".
 * Below 1.0.0 a minor step can break things, so it counts as "major".
 */
export function bumpKind(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (b[i] < a[i]) return "unknown";
    if (b[i] > a[i]) break;
  }
  if (b[0] !== a[0]) return "major";
  if (a[0] === 0 && b[1] !== a[1]) return "major";
  if (b[1] !== a[1]) return "minor";
  return b[2] !== a[2] ? "patch" : "same";
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** package.json before and after -> a list of reasons it needs a human (empty = only safe version bumps). */
export function packageJsonProblems(base, head) {
  if (!base || !head || typeof base !== "object" || typeof head !== "object") return ["package.json could not be read"];
  const problems = [];
  const rest = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !DEP_KEYS.includes(k)));
  if (stable(rest(base)) !== stable(rest(head))) problems.push("package.json changes more than package versions");
  for (const key of DEP_KEYS) {
    const before = base[key] ?? {};
    const after = head[key] ?? {};
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const name of names) {
      if (!(name in before) || !(name in after)) {
        problems.push(`a package was added or removed (${safe(name)})`);
        continue;
      }
      if (before[name] === after[name]) continue;
      const kind = bumpKind(before[name], after[name]);
      if (kind === "major") problems.push(`${safe(name)} jumps to a new major version`);
      else if (kind === "unknown") problems.push(`${safe(name)} changes in a way that can not be checked`);
    }
  }
  return [...new Set(problems)];
}

/** package-lock.json before and after -> reasons it needs a human. Only changed packages are looked at. */
export function lockfileProblems(base, head) {
  const a = base?.packages;
  const b = head?.packages;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return ["package-lock.json could not be read"];
  const problems = [];
  for (const [key, entry] of Object.entries(b)) {
    const old = a[key];
    if (old && old.version === entry.version && old.resolved === entry.resolved) continue;
    const name = key === "" ? "the app" : key.replace(/^.*node_modules\//, "");
    if (entry.resolved && !entry.link && !String(entry.resolved).startsWith("https://registry.npmjs.org/")) {
      problems.push(`${safe(name)} now comes from somewhere other than the npm registry`);
    }
    if (old && old.version !== entry.version) {
      const kind = bumpKind(old.version, entry.version);
      if (kind === "major") problems.push(`${safe(name)} jumps to a new major version`);
      else if (kind === "unknown") problems.push(`${safe(name)} changes in a way that can not be checked`);
    }
  }
  return [...new Set(problems)].slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// The decision

/** Keep only plain characters, so text from a pull request can never act as a command or markup. */
export function safe(text, max = 80) {
  return String(text ?? "").replace(/[^A-Za-z0-9_@()[\]. /+-]/g, "?").replace(/^:+/, "?").slice(0, max);
}

/**
 * input: {
 *   author, labels: [names],
 *   files: [{ filename, previous_filename?, additions, deletions }],
 *   filesComplete: boolean,           // false when GitHub cut the list short
 *   packageJson?: { base, head },     // only needed for Dependabot pull requests
 *   lockfile?: { base, head },
 * }
 * Returns { decision: "merge" | "review" | "hold", reasons: [plain sentences] }
 *   merge  = turn on auto-merge (GitHub merges once the Tests check is green)
 *   review = add the needs-review label and explain why
 *   hold   = do not merge it. main() also switches auto-merge off for every hold (block: true = a person said stop
 *            with the needs-review label)
 */
export function classify(input) {
  const labels = input.labels ?? [];
  const byDependabot = input.author === DEPENDABOT;
  if (labels.includes(REVIEW_LABEL)) return { decision: "hold", block: true, reasons: ["It has the needs-review label."] };
  if (!byDependabot && !labels.includes(OK_LABEL)) return { decision: "hold", block: false, reasons: ["Nobody asked for an automatic merge."] };

  const reasons = [];
  if (input.filesComplete === false) reasons.push("It changes too many files for a robot to check them all.");

  const touched = new Set();
  for (const f of input.files ?? []) {
    touched.add(f.filename);
    if (f.previous_filename) touched.add(f.previous_filename);
  }
  let packageChanged = false;
  let lockChanged = false;
  for (const file of touched) {
    if (isLockfile(file)) {
      lockChanged = true;
      continue;
    }
    if (normalize(file) === "package.json") {
      packageChanged = true;
      continue;
    }
    if (isRiskyPath(file)) reasons.push(`It changes ${safe(file)}, which could affect sign-in, your data, payments or how the app is built.`);
  }

  if (packageChanged || (byDependabot && lockChanged)) {
    if (!byDependabot) {
      reasons.push("It changes package.json, so a person should check the new or changed packages.");
    } else {
      if (packageChanged) for (const p of packageJsonProblems(input.packageJson?.base, input.packageJson?.head)) reasons.push(`Dependabot: ${p}.`);
      if (lockChanged) for (const p of lockfileProblems(input.lockfile?.base, input.lockfile?.head)) reasons.push(`Dependabot: ${p}.`);
    }
  }
  if (!byDependabot && lockChanged && !packageChanged) reasons.push("It changes a lock file without a matching package.json change.");

  let lines = 0;
  for (const f of input.files ?? []) {
    if (!isLockfile(f.filename)) lines += (Number(f.additions) || 0) + (Number(f.deletions) || 0);
  }
  if (lines > BIG_LINES) reasons.push(`It is big (${lines} changed lines; the limit for a robot is ${BIG_LINES}).`);

  if ((input.files ?? []).length === 0 && input.filesComplete !== false) reasons.push("It has no changed files.");
  return reasons.length > 0 ? { decision: "review", reasons: [...new Set(reasons)] } : { decision: "merge", reasons: [] };
}

// ---------------------------------------------------------------------------------------------
// Talking to GitHub (through the gh program that every GitHub runner has)

function realGh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { maxBuffer: 200 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        const e = new Error(String(stderr || error.message).trim().split("\n").slice(-2).join(" ").slice(0, 300));
        e.code = error.code;
        reject(e);
      } else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function ghJson(gh, args) {
  const out = await gh(args);
  return JSON.parse(out);
}

/** True only when GitHub is set to wait for a required check before it merges. Unknown counts as no. */
export async function requiredChecksEnforced(gh, repo, baseRef) {
  const ref = encodeURIComponent(baseRef);
  try {
    const branch = await ghJson(gh, ["api", `repos/${repo}/branches/${ref}`]);
    const req = branch?.protection?.required_status_checks;
    if (req && req.enforcement_level !== "off" && ((req.contexts?.length ?? 0) > 0 || (req.checks?.length ?? 0) > 0)) return true;
  } catch {
    // fall through to the rules check
  }
  try {
    const rules = await ghJson(gh, ["api", `repos/${repo}/rules/branches/${ref}`]);
    if (Array.isArray(rules) && rules.some((r) => r?.type === "required_status_checks")) return true;
  } catch {
    // unknown
  }
  return false;
}

async function listFiles(gh, repo, number) {
  const out = await gh([
    "api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`,
    "--jq", '.[] | [.filename, (.previous_filename // ""), .additions, .deletions] | @json',
  ]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [filename, previous, additions, deletions] = JSON.parse(line);
    return { filename, previous_filename: previous || undefined, additions, deletions };
  });
}

async function fileAt(gh, repo, file, sha) {
  try {
    const out = await gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${file}?ref=${sha}`]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function ensureLabel(gh, repo) {
  try {
    await gh(["label", "create", REVIEW_LABEL, "--repo", repo, "--color", "FBCA04", "--description", "A person must look at this before it merges"]);
  } catch {
    // already there
  }
}

async function commentOnce(gh, repo, number, kind, body) {
  const tag = `${MARKER}<!-- ${kind} -->`;
  try {
    const found = await gh([
      "api", "--paginate", `repos/${repo}/issues/${number}/comments?per_page=100`,
      "--jq", `.[] | select(.body | contains("${tag}")) | .id`,
    ]);
    if (found.trim() !== "") return false;
  } catch {
    // could not look: better one comment too many than none
  }
  await gh(["pr", "comment", String(number), "--repo", repo, "--body-file", "-"], { input: `${tag}\n${body}\n` });
  return true;
}

const ENV_RE = {
  REPO: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  PR_NUMBER: /^[0-9]{1,9}$/,
  BASE_REF: /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/,
  BASE_SHA: /^[0-9a-f]{40}$/,
  HEAD_SHA: /^[0-9a-f]{40}$/,
};

/**
 * Switch auto-merge off for this pull request, if the environment names one. Never throws: "it was not on" and
 * "GitHub is down" both just mean we can not do more. Used when anything goes wrong, so a failure never leaves an
 * earlier "yes" in place.
 */
export async function switchOffAutoMerge(env, gh) {
  if (!ENV_RE.REPO.test(String(env.REPO ?? "")) || !ENV_RE.PR_NUMBER.test(String(env.PR_NUMBER ?? ""))) return false;
  try {
    await gh(["pr", "merge", env.PR_NUMBER, "--repo", env.REPO, "--disable-auto"]);
    return true;
  } catch {
    return false; // auto-merge was not on
  }
}

/**
 * The whole job. env and gh can be swapped in tests. Returns what it did.
 * It fails closed: GitHub keeps auto-merge on when someone pushes again, so every run starts by switching it off,
 * and only the final "merge" step switches it back on. If anything throws, it is switched off again before exiting.
 */
export async function main({ env = process.env, gh = realGh, log = console.log } = {}) {
  try {
    return await decide({ env, gh, log });
  } catch (error) {
    await switchOffAutoMerge(env, gh);
    throw error;
  }
}

async function decide({ env, gh, log }) {
  for (const [name, re] of Object.entries(ENV_RE)) {
    if (!re.test(String(env[name] ?? ""))) throw new Error(`The value of ${name} is missing or has an unexpected shape.`);
  }
  const { REPO: repo, PR_NUMBER: number, BASE_REF: baseRef, BASE_SHA: baseSha, HEAD_SHA: headSha } = env;

  const pr = await ghJson(gh, ["api", `repos/${repo}/pulls/${number}`]);
  if (pr.state !== "open") return { decision: "hold", did: "nothing: the pull request is not open" };
  // Always start from "auto-merge off". A "yes" given for an earlier commit does not carry over to a new one.
  await switchOffAutoMerge(env, gh);
  if (pr.head?.sha !== headSha) return { decision: "hold", did: "nothing: a newer commit was pushed, a newer run will look at it" };
  if (pr.draft) return { decision: "hold", did: "nothing: it is a draft" };

  const labels = (pr.labels ?? []).map((l) => l.name);
  const author = pr.user?.login ?? "";
  const files = await listFiles(gh, repo, number);
  const filesComplete = typeof pr.changed_files !== "number" || files.length >= pr.changed_files;

  const input = { author, labels, files, filesComplete };
  const touched = new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  if (author === DEPENDABOT) {
    if (touched.has("package.json")) {
      input.packageJson = { base: await fileAt(gh, repo, "package.json", baseSha), head: await fileAt(gh, repo, "package.json", headSha) };
    }
    if (touched.has("package-lock.json")) {
      input.lockfile = { base: await fileAt(gh, repo, "package-lock.json", baseSha), head: await fileAt(gh, repo, "package-lock.json", headSha) };
    }
  }

  const verdict = classify(input);
  log(`Decision for #${number}: ${verdict.decision}`);
  for (const r of verdict.reasons) log(`  - ${r}`);

  if (verdict.decision === "hold") return { ...verdict, did: "left it alone, with auto-merge off" };

  if (verdict.decision === "review") {
    await ensureLabel(gh, repo);
    await gh(["pr", "edit", number, "--repo", repo, "--add-label", REVIEW_LABEL]);
    const body = [
      "**This pull request needs a person to look at it before it merges.**",
      "",
      ...verdict.reasons.map((r) => `- ${r}`),
      "",
      "Read it, and merge it yourself when you are happy. The robot will not merge it.",
    ].join("\n");
    const commented = await commentOnce(gh, repo, number, "review", body);
    return { ...verdict, did: commented ? "labelled it needs-review and explained why" : "labelled it needs-review" };
  }

  // merge: only if GitHub really waits for the Tests check. Without that, "auto-merge" would merge at once.
  if (!(await requiredChecksEnforced(gh, repo, baseRef))) {
    const body = [
      "**Automatic merge is switched off for this pull request.**",
      "",
      "GitHub is not set to wait for the Tests check on this branch, so an automatic merge could happen before the tests finish.",
      "Wait for the Tests check to turn green, then merge it yourself. (To turn automatic merging on: ask Claude to set up the repository settings for ops. It needs a public repository or a paid GitHub plan.)",
    ].join("\n");
    const commented = await commentOnce(gh, repo, number, "setup", body);
    return { decision: "hold", reasons: ["GitHub is not set to wait for the Tests check."], did: commented ? "did not turn on auto-merge and explained why" : "did not turn on auto-merge" };
  }
  try {
    await gh(["pr", "merge", number, "--repo", repo, "--auto", "--squash", "--match-head-commit", headSha]);
  } catch (error) {
    const body = [
      "**Automatic merge could not be turned on.**",
      "",
      `GitHub said: ${safe(error.message, 200)}`,
      "",
      "Most often the repository setting \"Allow auto-merge\" is off. Merge this one yourself once the Tests check is green.",
    ].join("\n");
    await commentOnce(gh, repo, number, "failed", body);
    return { decision: "hold", reasons: ["GitHub refused to turn on auto-merge."], did: "tried to turn on auto-merge and explained what went wrong" };
  }
  return { ...verdict, did: "turned on auto-merge (GitHub merges when the Tests check is green)" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((r) => console.log(`Done: ${r.did}.`))
    .catch((e) => {
      // main() has already switched auto-merge off (best effort) before it threw.
      console.error(`The automatic-merge check could not finish: ${safe(e.message, 300)}`);
      process.exitCode = 1;
    });
}
