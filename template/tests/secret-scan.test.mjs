import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, scanRange } from "../scripts/secret-scan.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "secret-scan.mjs");

// Fake keys are built from pieces at test time, so this file never contains a string that looks like a real key.
const rand = (n) => "x9Zk3Qw7Lp2Vb8Nm4Ta6Ry1Hc5Jd0Gf".repeat(3).slice(0, n);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${rand(30)}`;

const cases = [
  ["Stripe live key", "Stripe secret key", `STRIPE=${["sk", "live", rand(24)].join("_")}`],
  ["Stripe test key", "Stripe secret key", `STRIPE=${["sk", "test", rand(24)].join("_")}`],
  ["Stripe restricted key", "Stripe secret key", `K=${["rk", "live", rand(24)].join("_")}`],
  ["Supabase secret key", "Supabase secret key", `K=${["sb", "secret", rand(24)].join("_")}`],
  ["Supabase access token", "Supabase access token", `K=${"sbp" + "_" + rand(40)}`],
  ["Resend API key", "Resend API key", `K=${"re" + "_" + rand(8)}_${rand(24)}`],
  ["OpenRouter API key", "OpenRouter API key", `K=${["sk", "or", "v1", rand(40)].join("-")}`],
  ["OpenAI API key", "OpenAI API key", `K=${["sk", "proj", rand(40)].join("-")}`],
  ["Private key block", "Private key block", `-----BEGIN ${"RSA "}PRIVATE KEY-----`],
  ["AWS access key id", "AWS access key id", `K=${"AKIA" + "IOSFODNN7EXAMPLE"}`],
  ["GitHub token", "GitHub token", `K=${"ghp" + "_" + rand(36)}`],
  ["OpenAI service-account key", "OpenAI API key", `K=${["sk", "svcacct", rand(40)].join("-")}`],
  ["OpenAI admin key", "OpenAI API key", `K=${["sk", "admin", rand(40)].join("-")}`],
  ["OpenAI older key", "OpenAI API key", `K=${"sk" + "-" + rand(48)}`],
  ["Anthropic API key", "Anthropic API key", `K=${["sk", "ant", "api03", rand(40)].join("-")}`],
  ["Google OAuth client secret", "Google OAuth client secret", `K=${"GOCSPX" + "-" + rand(28)}`],
  ["Google API key", "Google API key", `K=${"AIza" + rand(35)}`],
  ["GitHub fine-grained token", "GitHub token", `K=${"github_pat" + "_" + rand(40)}`],
  ["GitHub OAuth token", "GitHub token", `K=${"gho" + "_" + rand(36)}`],
  ["GitHub server token", "GitHub token", `K=${"ghs" + "_" + rand(36)}`],
  ["GitHub user token", "GitHub token", `K=${"ghu" + "_" + rand(36)}`],
  ["Supabase service_role key", "Supabase service_role key", `K=${jwt({ role: "service_role", iss: "supabase" })}`],
];

for (const [label, name, line] of cases) {
  test(`finds: ${label}`, () => {
    const found = scanText(`const a = 1;\n${line}\n`);
    assert.equal(found.length, 1, `expected one finding, got ${JSON.stringify(found)}`);
    assert.equal(found[0].line, 2);
    assert.equal(found[0].pattern, name);
  });
}

test("a public anon key is not a finding", () => {
  assert.deepEqual(scanText(`K=${jwt({ role: "anon", iss: "supabase" })}`), []);
});

test("ordinary code and short or similar-looking text is not a finding", () => {
  const text = [
    "const task_live_value_that_is_long_enough_to_match = 1;",
    "compare_something_long_name_with_underscores();",
    "const prefix = 'sk_live_';",
    "re_short",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("findings never include the matched value", () => {
  const secret = ["sk", "live", rand(24)].join("_");
  const found = scanText(`K=${secret}`);
  assert.ok(!JSON.stringify(found).includes(secret));
});

test("scans a real git repo: clean passes, a tracked key fails, an env file fails", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scan-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(path.join(dir, "ok.txt"), "nothing secret here\n");
    writeFileSync(path.join(dir, ".env.example"), `${["sk", "live", rand(24)].join("_")}\n`);
    git("add", "-A");

    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });

    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);

    mkdirSync(path.join(dir, "src"));
    const secret = ["sk", "live", rand(24)].join("_");
    writeFileSync(path.join(dir, "src", "leak.ts"), `export const k = "${secret}";\n`);
    git("add", "-A");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/leak\.ts:1/);
    assert.ok(!result.stderr.includes(secret) && !result.stdout.includes(secret));

    result = run("--json");
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).findings[0].file, "src/leak.ts");

    git("rm", "-q", "-f", "src/leak.ts");
    writeFileSync(path.join(dir, ".env.local"), "A=1\n");
    git("add", "-f", ".env.local");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.local/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help exits 0 and unknown options exit 2", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" }).status, 2);
});

// ---------- scanning history, not just the files on disk ----------

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scan-range-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

test("--range finds a key that a later commit deleted (the working files are clean)", () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const base = git("rev-parse", "HEAD").trim();

    const secret = ["sk", "live", rand(24)].join("_");
    writeFileSync(path.join(dir, "config.ts"), `// header\nexport const k = "${secret}";\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "add key");
    writeFileSync(path.join(dir, "config.ts"), "// header\nexport const k = process.env.K;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "remove key");

    // The files as they are now are clean...
    assert.deepEqual(execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort(), ["a.txt", "config.ts"]);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" }).status, 0);

    // ...but the history that would be pushed is not.
    const found = scanRange({ cwd: dir, range: `${base}..HEAD` });
    assert.equal(found.length, 1);
    assert.equal(found[0].file, "config.ts");
    assert.equal(found[0].line, 2);
    assert.equal(found[0].pattern, "Stripe secret key");
    assert.match(found[0].commit, /^[0-9a-f]{4,}$/);

    const cli = spawnSync(process.execPath, [SCRIPT, "--range", `${base}..HEAD`], { cwd: dir, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /config\.ts:2/);
    assert.ok(!cli.stderr.includes(secret) && !cli.stdout.includes(secret));
    assert.match(cli.stderr, /earlier commit/);

    // A range that starts after the bad commit is fine.
    const tip = git("rev-parse", "HEAD").trim();
    assert.deepEqual(scanRange({ cwd: dir, range: `${tip}..HEAD` }), []);
    // The new-branch form: everything no remote has.
    assert.equal(scanRange({ cwd: dir, range: "HEAD --not --remotes" }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--range reports a committed .env.local, ignores .env.example, and does not trip on '+++' content", () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(path.join(dir, ".env.local"), "A=1\n");
    writeFileSync(path.join(dir, ".env.example"), `${["sk", "live", rand(24)].join("_")}\n`);
    // A line that itself starts with "++ " shows up in the diff as "+++ ".
    writeFileSync(path.join(dir, "notes.md"), "++ plus plus\n");
    git("add", "-A", "-f");
    git("commit", "-q", "-m", "two");
    const found = scanRange({ cwd: dir, range: `${base}..HEAD` });
    assert.deepEqual(found.map((f) => f.file), [".env.local"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--range with a bad value exits 2 and never passes options to git", () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    for (const range of ["--output=/tmp/x", "HEAD --all", "nope..HEAD", ""]) {
      const r = spawnSync(process.execPath, [SCRIPT, "--range", range], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 2, `range ${JSON.stringify(range)}`);
    }
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--range", "HEAD", "--staged"], { cwd: dir, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--range"], { cwd: dir, encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the scan must run (and fail) when reached through a symlink ----------

test("a planted key is found when the scan is started by an absolute path through a symlinked folder", () => {
  const { dir, git } = makeRepo();
  try {
    const secret = ["sk", "live", rand(24)].join("_");
    writeFileSync(path.join(dir, "leak.ts"), `export const k = "${secret}";\n`);
    git("add", "-A");

    const holder = mkdtempSync(path.join(os.tmpdir(), "scan-link-"));
    try {
      const link = path.join(holder, "scripts-link");
      symlinkSync(path.dirname(SCRIPT), link, "dir");
      const r = spawnSync(process.execPath, [path.join(link, "secret-scan.mjs")], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stderr, /leak\.ts:1/);

      // And a clean repo still passes with a visible message (not a silent exit).
      git("rm", "-q", "-f", "leak.ts");
      const clean = spawnSync(process.execPath, [path.join(link, "secret-scan.mjs")], { cwd: dir, encoding: "utf8" });
      assert.equal(clean.status, 0);
      assert.match(clean.stdout, /No keys or passwords/);
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the pre-push hook, against a real (local) remote ----------

test("pre-push hook blocks a push whose history holds a key that was deleted again, and allows a clean one", { skip: process.platform === "win32" }, () => {
  const { dir, git } = makeRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), "scan-remote-"));
  try {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, ".githooks"));
    copyFileSync(SCRIPT, path.join(dir, "scripts", "secret-scan.mjs"));
    const hook = path.join(dir, ".githooks", "pre-push");
    copyFileSync(path.join(path.dirname(SCRIPT), "..", ".githooks", "pre-push"), hook);
    chmodSync(hook, 0o755);
    git("config", "core.hooksPath", ".githooks");
    git("remote", "add", "origin", remote);

    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    git("push", "-q", "origin", "main"); // clean: allowed

    const secret = ["sk", "live", rand(24)].join("_");
    writeFileSync(path.join(dir, "config.ts"), `export const k = "${secret}";\n`);
    git("add", "config.ts");
    git("commit", "-q", "-m", "add key");
    writeFileSync(path.join(dir, "config.ts"), "export const k = process.env.K;\n");
    git("add", "config.ts");
    git("commit", "-q", "-m", "I removed it");

    const blocked = spawnSync("git", ["push", "origin", "main"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /config\.ts:1/);
    assert.ok(!blocked.stderr.includes(secret));
    const blockedNew = spawnSync("git", ["push", "origin", "main:fresh-branch"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(blockedNew.status, 0);
    assert.match(blockedNew.stderr, /config\.ts:1/);
    const remoteRefs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: remote, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(remoteRefs, ["refs/heads/main"]);

    // Rewriting the history so the key was never committed lets the push through.
    git("reset", "-q", "--hard", "HEAD~2");
    writeFileSync(path.join(dir, "b.txt"), "fine\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "clean");
    git("push", "-q", "origin", "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
