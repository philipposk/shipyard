// install-agents.mjs, run as the student runs it. Every run points SHIPYARD_AGENTS_HOME, SHIPYARD_HOME
// and CODEX_HOME at temp folders, and PATH at a temp folder with only node in it, so nothing on this
// computer (a real ~/.codex, ~/.cursor, ~/.agents or ~/.shipyard) is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => p.replace(/\\/g, '/');
const SKILLS = ['setup', 'new-app', 'design', 'launch', 'video', 'ops', 'new-skill', 'email', 'apis', 'review'];
const OUTPUTS = [];
const unix = process.platform !== 'win32';

/** A fresh, empty computer: home folder, keys folder, and a PATH with only node on it. */
function sandbox() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ship-agents-')));
  const home = path.join(base, 'home');
  const keys = path.join(base, 'keys');
  const bin = path.join(base, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (unix) symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = {
    HOME: os.homedir(),
    USERPROFILE: process.env.USERPROFILE ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    PATH: unix ? `${bin}:/usr/bin:/bin` : `${path.dirname(process.execPath)};${process.env.PATH}`,
    SHIPYARD_AGENTS_HOME: home,
    SHIPYARD_HOME: keys,
    CODEX_HOME: path.join(home, '.codex'),
    GIT_CONFIG_GLOBAL: unix ? '/dev/null' : 'NUL',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  };
  return { base, home, keys, bin, env, skills: path.join(home, '.agents', 'skills'), codexHooks: path.join(home, '.codex', 'hooks.json'), cursorHooks: path.join(home, '.cursor', 'hooks.json'), record: path.join(keys, 'install.json'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function run(sb, args, { root = ROOT } = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-agents.mjs'), ...args], { encoding: 'utf8', env: sb.env, input: '', timeout: 60_000 });
  OUTPUTS.push(r.stdout + r.stderr);
  return { code: r.status, out: r.stdout + r.stderr };
}

/** Every file under a folder, with its bytes, for before/after comparisons. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = readFileSync(f).toString('base64');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** A copy of Shipyard somewhere else (what a student's clone looks like). */
function copyShipyard(dest) {
  mkdirSync(dest, { recursive: true });
  for (const d of ['scripts', 'skills', '.claude-plugin']) cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true });
  return realpathSync(dest);
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

test('detection: nothing found asks for --agent; a ~/.cursor folder means Cursor; a codex program on PATH means Codex', () => {
  const sb = sandbox();
  try {
    const none = run(sb, ['--yes']);
    assert.equal(none.code, 1);
    assert.match(none.out, /could not find Codex or Cursor.*--agent codex, --agent cursor or --agent both/s);
    assert.ok(!existsSync(sb.skills));

    mkdirSync(path.join(sb.home, '.cursor'));
    const cur = run(sb, ['--dry-run']);
    assert.equal(cur.code, 0, cur.out);
    assert.match(cur.out, /For: Cursor\n/);

    if (unix) {
      writeFileSync(path.join(sb.bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
      assert.match(run(sb, ['--dry-run']).out, /For: Codex and Cursor\n/);
    }
    rmSync(path.join(sb.home, '.cursor'), { recursive: true });
    mkdirSync(sb.env.CODEX_HOME);
    assert.match(run(sb, ['--dry-run']).out, /For: Codex\n/);
  } finally {
    sb.cleanup();
  }
});

test('--yes installs nine skill folders with markers, both hooks files and a private install record', () => {
  const sb = sandbox();
  try {
    const r = run(sb, ['--agent', 'both', '--yes']);
    assert.equal(r.code, 0, r.out);
    const root = fwd(realpathSync(ROOT));
    for (const s of SKILLS) {
      const dir = path.join(sb.skills, `shipyard-${s}`);
      assert.ok(existsSync(path.join(dir, 'SKILL.md')), s);
      const marker = JSON.parse(readFileSync(path.join(dir, '.shipyard-generated.json'), 'utf8'));
      assert.equal(marker.root, root);
    }
    const rec = JSON.parse(readFileSync(sb.record, 'utf8'));
    assert.equal(rec.schema, 1);
    assert.equal(rec.root, root);
    assert.equal(rec.skillsDir, fwd(sb.skills));
    assert.deepEqual(Object.keys(rec.agents), ['codex', 'cursor']);
    assert.equal(rec.agents.codex.hooksFile, fwd(sb.codexHooks));
    if (unix) {
      assert.equal(rec.node, fwd(path.join(sb.bin, 'node')), 'the first node on PATH, not resolved through the symlink');
      assert.equal(statSync(sb.record).mode & 0o777, 0o600);
    }
    assert.ok(!JSON.stringify(rec).match(/key|token|secret/i), 'no keys in the record');
    const codex = JSON.parse(readFileSync(sb.codexHooks, 'utf8'));
    assert.match(codex.hooks.PreToolUse[0].hooks[0].command, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/guard-codex\\.mjs"$`));
    const cursor = JSON.parse(readFileSync(sb.cursorHooks, 'utf8'));
    assert.equal(cursor.version, 1);
    assert.match(r.out, /Trust all and continue/);
    assert.match(r.out, /guard-codex\.mjs/);
    assert.match(r.out, /\$shipyard-setup/);
    assert.match(r.out, /Developer: Reload Window/);
    assert.match(r.out, /\/shipyard-setup/);
    assert.ok(!existsSync(path.join(sb.home, '.claude')), 'never writes to ~/.claude');
    assert.ok(!existsSync(path.join(sb.env.CODEX_HOME, 'rules')), 'no rules file without a yes');
  } finally {
    sb.cleanup();
  }
});

test('other skills stay, a stale Shipyard folder goes, and a folder Shipyard did not make is never overwritten', () => {
  const sb = sandbox();
  try {
    const other = path.join(sb.skills, 'my-skill');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'SKILL.md'), '---\nname: my-skill\ndescription: mine\n---\n');
    const stale = path.join(sb.skills, 'shipyard-old');
    mkdirSync(stale);
    writeFileSync(path.join(stale, '.shipyard-generated.json'), '{"root":"/x","version":"0.1.0"}');
    const r = run(sb, ['--agent', 'cursor', '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(other, 'SKILL.md'), 'utf8'), '---\nname: my-skill\ndescription: mine\n---\n');
    assert.ok(!existsSync(stale));

    const sb2 = sandbox();
    try {
      const mine = path.join(sb2.skills, 'shipyard-setup');
      mkdirSync(mine, { recursive: true });
      writeFileSync(path.join(mine, 'SKILL.md'), 'my own');
      const refused = run(sb2, ['--agent', 'cursor', '--yes']);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /already a folder Shipyard did not make: .*shipyard-setup\. Shipyard did not overwrite it/);
      assert.equal(readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'my own');
      assert.ok(!existsSync(sb2.record));
      assert.ok(!existsSync(sb2.cursorHooks));
    } finally {
      sb2.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test('--agent codex and --agent cursor write only their own hooks', () => {
  for (const [agent, mine, other] of [['codex', 'codexHooks', 'cursorHooks'], ['cursor', 'cursorHooks', 'codexHooks']]) {
    const sb = sandbox();
    try {
      const r = run(sb, ['--agent', agent, '--yes']);
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(sb[mine]), agent);
      assert.ok(!existsSync(sb[other]), agent);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(sb.record, 'utf8')).agents), [agent]);
    } finally {
      sb.cleanup();
    }
  }
});

test('a second run changes nothing and says so; the first change keeps a backup of the student\'s hooks file', () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.env.CODEX_HOME, { recursive: true });
    const mine = '{\n  "hooks": {\n    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "mine"}]}]\n  }\n}\n';
    writeFileSync(sb.codexHooks, mine);
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    assert.equal(readFileSync(`${sb.codexHooks}.shipyard-backup`, 'utf8'), mine);
    const before = snapshot(sb.base);
    const again = run(sb, ['--agent', 'both', '--yes']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /unchanged/);
    assert.deepEqual(snapshot(sb.base), before);
    const third = run(sb, ['--yes']);
    assert.match(third.out, /unchanged/);
    assert.deepEqual(snapshot(sb.base), before);
  } finally {
    sb.cleanup();
  }
});

test('--dry-run writes nothing', () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.base);
    const r = run(sb, ['--agent', 'both', '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Dry run: nothing was written/);
    assert.match(r.out, /create {2}.*shipyard-setup\//);
    assert.deepEqual(snapshot(sb.base), before);
  } finally {
    sb.cleanup();
  }
});

test('without a terminal and without --yes it refuses, and writes nothing', () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.base);
    const r = run(sb, ['--agent', 'both']);
    assert.equal(r.code, 1);
    assert.match(r.out, /needs a yes first.*add --yes/s);
    assert.deepEqual(snapshot(sb.base), before);
  } finally {
    sb.cleanup();
  }
});

test('a hooks file that is not valid JSON is left exactly as it was', () => {
  const sb = sandbox();
  try {
    mkdirSync(path.join(sb.home, '.cursor'), { recursive: true });
    writeFileSync(sb.cursorHooks, '{"version": 1, "hooks": ');
    const r = run(sb, ['--agent', 'cursor', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.out, /is not valid JSON, so Shipyard did not touch it/);
    assert.equal(readFileSync(sb.cursorHooks, 'utf8'), '{"version": 1, "hooks": ');
    assert.ok(!existsSync(sb.skills));
  } finally {
    sb.cleanup();
  }
});

test('the Codex rules file is written only on request, and kept up to date after that', () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb, ['--agent', 'codex', '--yes', '--codex-allow-scripts']).code, 0);
    const rules = path.join(sb.env.CODEX_HOME, 'rules', 'shipyard.rules');
    const text = readFileSync(rules, 'utf8');
    assert.equal(text.split('\n')[0], '# shipyard');
    assert.match(text, /prefix_rule\(pattern=\["node", ".*\/scripts\/setup-status\.mjs"\], decision="allow"\)/);
    assert.match(run(sb, ['--yes']).out, /unchanged/);
    assert.equal(readFileSync(rules, 'utf8'), text);
    assert.equal(run(sb, ['--yes', '--no-codex-allow-scripts']).code, 0);
    assert.ok(!existsSync(rules));
    writeFileSync(rules, 'prefix_rule(pattern=["git"], decision="allow")\n');
    const foreign = run(sb, ['--yes', '--codex-allow-scripts']);
    assert.match(foreign.out, /was not made by Shipyard, so it was left alone/);
    assert.equal(readFileSync(rules, 'utf8'), 'prefix_rule(pattern=["git"], decision="allow")\n');
  } finally {
    sb.cleanup();
  }
});

test('--uninstall removes only what Shipyard installed', () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.env.CODEX_HOME, { recursive: true });
    mkdirSync(path.join(sb.home, '.cursor'), { recursive: true });
    const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] };
    writeFileSync(sb.codexHooks, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
    writeFileSync(sb.cursorHooks, JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './mine.sh' }] } }));
    const other = path.join(sb.skills, 'my-skill');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'SKILL.md'), 'mine');
    mkdirSync(sb.keys, { recursive: true });
    writeFileSync(path.join(sb.keys, 'profile.json'), '{"version":1}');
    assert.equal(run(sb, ['--agent', 'both', '--yes', '--codex-allow-scripts']).code, 0);

    const r = run(sb, ['--uninstall', '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /You can now delete /);
    assert.deepEqual(JSON.parse(readFileSync(sb.codexHooks, 'utf8')), { hooks: { PreToolUse: [userGroup] } });
    assert.deepEqual(JSON.parse(readFileSync(sb.cursorHooks, 'utf8')), { version: 1, hooks: { afterFileEdit: [{ command: './mine.sh' }] } });
    assert.deepEqual(readdirSync(sb.skills), ['my-skill']);
    assert.ok(!existsSync(path.join(sb.env.CODEX_HOME, 'rules', 'shipyard.rules')));
    assert.ok(!existsSync(sb.record));
    assert.equal(readFileSync(path.join(sb.keys, 'profile.json'), 'utf8'), '{"version":1}');
    assert.match(run(sb, ['--uninstall', '--yes']).out, /Nothing of Shipyard's is installed/);
  } finally {
    sb.cleanup();
  }
});

test('--uninstall --agent codex keeps the Cursor install', () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    const r = run(sb, ['--uninstall', '--agent', 'codex', '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!/You can now delete/.test(r.out));
    assert.ok(existsSync(path.join(sb.skills, 'shipyard-setup')));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(sb.record, 'utf8')).agents), ['cursor']);
    assert.equal(readFileSync(sb.codexHooks, 'utf8').includes('guard-codex.mjs'), false);
    assert.equal(readFileSync(sb.cursorHooks, 'utf8').includes('guard-cursor.mjs'), true);
  } finally {
    sb.cleanup();
  }
});

test('--check passes after an install, and fails on a missing hook or a moved Shipyard folder', () => {
  const sb = sandbox();
  try {
    const root = copyShipyard(path.join(sb.base, 'a', 'shipyard'));
    assert.match(run(sb, ['--check'], { root }).out, /not installed for Codex or Cursor yet/);
    assert.equal(run(sb, ['--agent', 'both', '--yes'], { root }).code, 0);
    const ok = run(sb, ['--check'], { root });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /No problems found/);
    assert.match(ok.out, /\/hooks/);

    // A hand edit in the skills is reported.
    const skill = path.join(sb.skills, 'shipyard-ops', 'SKILL.md');
    const original = readFileSync(skill, 'utf8');
    writeFileSync(skill, `${original}\nextra`);
    assert.match(run(sb, ['--check'], { root }).out, /changed by hand/);
    writeFileSync(skill, original);

    const cursor = readFileSync(sb.cursorHooks, 'utf8');
    rmSync(sb.cursorHooks);
    const missing = run(sb, ['--check'], { root });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Cursor: there is no Shipyard key guard/);
    writeFileSync(sb.cursorHooks, cursor);
    assert.equal(run(sb, ['--check'], { root }).code, 0);

    renameSync(path.join(sb.base, 'a'), path.join(sb.base, 'b'));
    const moved = run(sb, ['--check'], { root: path.join(sb.base, 'b', 'shipyard') });
    assert.equal(moved.code, 1);
    assert.match(moved.out, /Was the folder moved\?/);
    assert.match(moved.out, /runs another Shipyard folder/);
  } finally {
    sb.cleanup();
  }
});

test('a Shipyard folder inside the keys folder, or under a .shipyard name, is refused', () => {
  const sb = sandbox();
  try {
    const inside = copyShipyard(path.join(sb.keys, 'shipyard'));
    const r = run(sb, ['--agent', 'cursor', '--yes'], { root: inside });
    assert.equal(r.code, 1);
    assert.match(r.out, /inside your keys folder/);
    const named = copyShipyard(path.join(sb.base, 'x', '.shipyard', 'shipyard'));
    const r2 = run(sb, ['--agent', 'cursor', '--yes'], { root: named });
    assert.equal(r2.code, 1);
    assert.match(r2.out, /inside a folder named \.shipyard/);
    assert.ok(!existsSync(sb.skills));
  } finally {
    sb.cleanup();
  }
});

test('--update pulls the new version and refreshes; a changed or non-git folder is refused in plain words', () => {
  const sb = sandbox();
  try {
    const work = copyShipyard(path.join(sb.base, 'work'));
    git(work, ['init', '-q', '-b', 'main'], sb.env);
    git(work, ['add', '-A'], sb.env);
    git(work, ['commit', '-q', '-m', 'start'], sb.env);
    const origin = path.join(sb.base, 'origin.git');
    git(sb.base, ['clone', '-q', '--bare', work, origin], sb.env);
    const clone = path.join(sb.base, 'clone', 'shipyard');
    git(sb.base, ['clone', '-q', origin, clone], sb.env);
    const root = realpathSync(clone);

    assert.equal(run(sb, ['--update'], { root }).out.includes('not installed for Codex or Cursor yet'), true);
    assert.equal(run(sb, ['--agent', 'both', '--yes'], { root }).code, 0);
    const oldVersion = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;

    const manifest = path.join(work, '.claude-plugin', 'plugin.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    git(work, ['commit', '-q', '-am', 'bump'], sb.env);
    git(work, ['push', '-q', origin, 'main'], sb.env);

    const r = run(sb, ['--update'], { root });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Updated Shipyard from ${oldVersion.replace(/\./g, '\\.')} to 9\\.9\\.9`));
    assert.match(r.out, /Codex hook unchanged, nothing to trust/);
    assert.equal(JSON.parse(readFileSync(sb.record, 'utf8')).version, '9.9.9');
    for (const s of SKILLS) assert.equal(JSON.parse(readFileSync(path.join(sb.skills, `shipyard-${s}`, '.shipyard-generated.json'), 'utf8')).version, '9.9.9');
    assert.match(readFileSync(path.join(sb.skills, 'shipyard-setup', 'SKILL.md'), 'utf8'), /> Shipyard 9\.9\.9 for Codex and Cursor/);
    assert.equal(run(sb, ['--check'], { root }).code, 0);

    const again = run(sb, ['--update'], { root });
    assert.match(again.out, /Shipyard is up to date \(9\.9\.9\)/);

    writeFileSync(path.join(root, 'scripts', 'mine.mjs'), '// mine\n');
    const dirty = run(sb, ['--update'], { root });
    assert.equal(dirty.code, 1);
    assert.match(dirty.out, /has changes of its own .* Nothing was changed/);

    const plain = copyShipyard(path.join(sb.base, 'plain', 'shipyard'));
    const sb2 = { ...sb, env: { ...sb.env, SHIPYARD_HOME: path.join(sb.base, 'keys2') } };
    assert.equal(run(sb2, ['--agent', 'cursor', '--yes'], { root: plain }).code, 0);
    const notGit = run(sb2, ['--update'], { root: plain });
    assert.equal(notGit.code, 1);
    assert.match(notGit.out, /is not a git clone, so it cannot update itself/);
    assert.match(notGit.out, /git clone --depth 1 https:\/\/github\.com\/philipposk\/shipyard\.git/);
  } finally {
    sb.cleanup();
  }
});

test('a Windows-style checkout (CRLF line ends) installs the same pack', () => {
  const sb = sandbox();
  try {
    const lf = copyShipyard(path.join(sb.base, 'lf', 'shipyard'));
    const crlf = copyShipyard(path.join(sb.base, 'crlf', 'shipyard'));
    const toCrlf = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) toCrlf(f);
        else if (/\.(md|mjs|json)$/.test(e.name)) writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'));
      }
    };
    toCrlf(path.join(crlf, 'skills'));
    toCrlf(path.join(crlf, 'scripts', 'agents'));
    const r = run(sb, ['--agent', 'both', '--yes'], { root: crlf });
    assert.equal(r.code, 0, r.out);
    for (const s of SKILLS) assert.ok(!readFileSync(path.join(sb.skills, `shipyard-${s}`, 'SKILL.md'), 'utf8').includes('\r'), `${s} has no CR`);
    assert.ok(existsSync(path.join(sb.skills, 'shipyard-design', 'references', 'polish.md')));
    assert.ok(run(sb, ['--check'], { root: crlf }).out.includes('No problems found'));
    assert.ok(lf);
  } finally {
    sb.cleanup();
  }
});

test('a Shipyard or home folder named Claude (or with Opus, /plugin, an em dash) does not fail the pack check', () => {
  const sb = sandbox();
  try {
    const root = copyShipyard(path.join(sb.base, 'Claude Opus', 'plugin', 'shipyard'));
    const home = path.join(sb.base, 'Claude', 'home');
    mkdirSync(home, { recursive: true });
    sb.env.SHIPYARD_AGENTS_HOME = home;
    sb.env.CODEX_HOME = path.join(home, '.codex');
    const r = run(sb, ['--agent', 'both', '--yes'], { root });
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(home, '.agents', 'skills', 'shipyard-setup', 'SKILL.md')));
  } finally {
    sb.cleanup();
  }
});

test('--agent codex also guards Cursor when Cursor is here (it reads the same skills folder); a partial uninstall that would leave an unguarded agent is refused', () => {
  const sb = sandbox();
  try {
    mkdirSync(path.join(sb.home, '.cursor'), { recursive: true });
    writeFileSync(path.join(sb.home, '.cursor', 'settings.json'), '{}');
    mkdirSync(sb.env.CODEX_HOME, { recursive: true });
    writeFileSync(path.join(sb.env.CODEX_HOME, 'config.toml'), '');
    const r = run(sb, ['--agent', 'codex', '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Cursor is on this computer too and loads skills from/);
    assert.ok(readFileSync(sb.cursorHooks, 'utf8').includes('guard-cursor.mjs'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(sb.record, 'utf8')).agents), ['codex', 'cursor']);

    const before = snapshot(sb.skills);
    const u = run(sb, ['--uninstall', '--agent', 'codex', '--yes']);
    assert.equal(u.code, 1, u.out);
    assert.match(u.out, /both load Shipyard's skills/);
    assert.match(u.out, /Nothing was changed/);
    assert.deepEqual(snapshot(sb.skills), before);
    assert.ok(readFileSync(sb.codexHooks, 'utf8').includes('guard-codex.mjs'));
    assert.equal(run(sb, ['--uninstall', '--yes']).code, 0);
  } finally {
    sb.cleanup();
  }
});

test('a skills folder only one agent reads is called out, in the install and in --check', () => {
  const sb = sandbox();
  try {
    const cursorOnly = path.join(sb.home, '.cursor', 'skills');
    const r = run(sb, ['--agent', 'both', '--yes', '--skills-dir', cursorOnly]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Codex does not load skills from .* so Shipyard's skills will not show there/);
    const c = run(sb, ['--check']);
    assert.equal(c.code, 1);
    assert.match(c.out, /Codex does not load skills from/);
  } finally {
    sb.cleanup();
  }
});

test('--check: old copies come with a config block Codex can read, and the Claude Code plugin Cursor loads is found', () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    const old = path.join(sb.env.CODEX_HOME, 'skills', 'setup');
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, 'SKILL.md'), '---\nname: setup\ndescription: Shipyard setup\n---\nold\n');
    mkdirSync(path.join(sb.home, '.claude', 'plugins', 'cache', 'shipyard', 'shipyard'), { recursive: true });
    const r = run(sb, ['--check']);
    const lines = r.out.split('\n').map((l) => l.trim());
    assert.ok(lines.includes('[[skills.config]]'), r.out);
    assert.ok(lines.some((l) => l.startsWith('path = "') && l.endsWith('SKILL.md"')), r.out);
    assert.ok(lines.includes('enabled = false'));
    assert.match(r.out, /Claude Code's Shipyard plugin is installed/);
    assert.match(r.out, /Include Third-Party Plugins, Skills, and Other Configs/);
  } finally {
    sb.cleanup();
  }
});

test('--update (--refresh) moves the install date, so the 30 day update offer stops; a plain re-run keeps it', () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    const markers = SKILLS.map((s) => path.join(sb.skills, `shipyard-${s}`, '.shipyard-generated.json'));
    const OLD = '2020-01-01T00:00:00.000Z';
    for (const m of markers) writeFileSync(m, JSON.stringify({ ...JSON.parse(readFileSync(m, 'utf8')), generatedAt: OLD }));
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    assert.equal(JSON.parse(readFileSync(markers[0], 'utf8')).generatedAt, OLD);
    assert.equal(run(sb, ['--refresh', '--yes']).code, 0);
    const today = new Date().toISOString().slice(0, 10);
    for (const m of markers) assert.equal(JSON.parse(readFileSync(m, 'utf8')).generatedAt.slice(0, 10), today);
  } finally {
    sb.cleanup();
  }
});

test('a node that is fnm\'s per-shell link is recorded as the real node', { skip: !unix }, () => {
  const sb = sandbox();
  try {
    const real = path.join(sb.base, 'fnm', 'node-versions', 'v22', 'installation', 'bin');
    const link = path.join(sb.base, 'fnm', 'fnm_multishells', '123_456', 'bin');
    mkdirSync(real, { recursive: true });
    mkdirSync(link, { recursive: true });
    symlinkSync(process.execPath, path.join(real, 'node'));
    symlinkSync(path.join(real, 'node'), path.join(link, 'node'));
    sb.env.PATH = `${link}:/usr/bin:/bin`;
    assert.equal(run(sb, ['--agent', 'both', '--yes']).code, 0);
    assert.equal(JSON.parse(readFileSync(sb.record, 'utf8')).node, fwd(realpathSync(path.join(link, 'node'))));
  } finally {
    sb.cleanup();
  }
});

test('--help works, unknown flags are explained, and no output has an em dash', () => {
  const sb = sandbox();
  try {
    const help = run(sb, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: node install-agents\.mjs/);
    const bad = run(sb, ['--agent', 'chatgpt']);
    assert.equal(bad.code, 2);
    assert.match(bad.out, /--agent must be codex, cursor or both/);
    assert.equal(run(sb, ['--check', '--uninstall']).code, 2);
    for (const out of OUTPUTS) assert.ok(!out.includes('\u2014'), out);
  } finally {
    sb.cleanup();
  }
});
