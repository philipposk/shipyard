import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadPreset } from '../scripts/design/presets.mjs';
import { planFiles } from '../scripts/design/write-files.mjs';
import { TEMPLATE, tempDir, removeDir } from './verify-helpers.mjs';

/** The files the design step touches, copied from the real template; the layout placeholder is filled in like scaffold does. */
async function designFilesCopy(dir) {
  for (const rel of ['src/app/globals.css', 'src/lib/theme.ts', 'src/lib/fonts.ts', 'src/lib/constants.ts', 'public/manifest.webmanifest', 'DESIGN.md']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await cp(path.join(TEMPLATE, rel), path.join(dir, rel));
  }
  const constants = path.join(dir, 'src/lib/constants.ts');
  await writeFile(constants, (await readFile(constants, 'utf8')).replace('<APP_LAYOUT>', 'bottom-nav'));
}

// The template's own design files must be exactly what the design step writes for the calm-blue look,
// so that applying that look to a fresh app changes nothing (apart from the timestamp in .shipyard-app.json).
test('the template ships the calm-blue look exactly', async () => {
  const dir = await tempDir('shipyard-template-design-');
  try {
    await designFilesCopy(dir);
    const { tokens } = await loadPreset('calm-blue');
    const plan = await planFiles(dir, tokens, { appName: '<APP_NAME>', source: 'preset', date: null });
    const changed = plan.files.filter((f) => f.changed).map((f) => f.rel);
    assert.deepEqual(changed, []);
    assert.deepEqual(plan.vars.light, []);
    assert.deepEqual(plan.vars.dark, []);
    assert.deepEqual(plan.vars.shape ?? [], []);
    assert.ok(plan.files.some((f) => f.rel === 'src/app/globals.css'));
    assert.ok(plan.files.some((f) => f.rel === 'src/lib/theme.ts'));
    assert.ok(plan.files.every((f) => !f.created));
    assert.ok(path.isAbsolute(plan.files[0].abs));
  } finally {
    await removeDir(dir);
  }
});
