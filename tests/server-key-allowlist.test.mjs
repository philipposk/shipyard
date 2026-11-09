import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISKY_PATHS } from '../ops/templates/.github/ops/automerge-check.mjs';
import { SERVER_KEY_ALLOWED, isAllowedForServerKey } from '../scripts/verify/server-key.mjs';

const FOLDERS = ['lib/readings/', 'lib/analysis/', 'lib/chat/', 'lib/projects/'];

test('one app cannot open the server key for every file in a shared folder name', () => {
  for (const folder of FOLDERS) {
    assert.equal(SERVER_KEY_ALLOWED.includes(folder), false, folder);
    assert.equal(isAllowedForServerKey(`${folder}store.ts`), false, folder);
    assert.equal(RISKY_PATHS.includes(`src/${folder}`), false, folder);
  }
  assert.equal(isAllowedForServerKey('app/api/health/route.ts'), true);
  assert.equal(isAllowedForServerKey('lib/errors/store.ts'), true);
  assert.equal(isAllowedForServerKey('lib/auth/ensure-profile.ts'), true);
});
