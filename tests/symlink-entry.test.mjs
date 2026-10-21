// Every script must still run when the plugin folder is reached through a symlink
// (a symlinked home or dev folder, /tmp on macOS, a --plugin-dir link). Node resolves the
// symlink for import.meta.url but not for process.argv[1], so a naive "am I the main file"
// check makes the script silently do nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  ['profile.mjs', ['--help'], /Usage/],
  ['setup-status.mjs', ['--help'], /Usage/],
  ['secrets-init.mjs', ['--help'], /Usage/],
  ['secrets-check.mjs', ['--help'], /Usage/],
  ['check-tools.mjs', ['--help'], /Usage/],
  ['settings-page.mjs', ['--help'], /Usage/],
  ['guard-secrets.mjs', ['--help'], /secrets guard/i],
  ['guard-codex.mjs', ['--help'], /secrets guard for Codex/i],
  ['guard-cursor.mjs', ['--help'], /secrets guard for Cursor/i],
  ['guard-check.mjs', ['--help'], /Usage/],
];

for (const [script, args, expected] of CASES) {
  test(`${script} prints output when started through a symlinked folder`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ship-link-'));
    try {
      const link = path.join(dir, 'scripts-link');
      symlinkSync(path.join(ROOT, 'scripts'), link, 'dir');
      const r = spawnSync(process.execPath, [path.join(link, script), ...args], {
        encoding: 'utf8',
        env: { ...process.env, SHIPYARD_HOME: path.join(dir, 'home') },
        timeout: 20_000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout + r.stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
