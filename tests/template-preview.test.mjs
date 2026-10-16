import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRESET_ORDER, loadPreset } from '../scripts/design/presets.mjs';
import { toPreview } from '../scripts/design/preview.mjs';
import { TEMPLATE } from './verify-helpers.mjs';

// What the design step writes (toPreview) must be fully understood by the template's preview page (readPreview):
// nothing dropped, nothing rejected. Fixtures come from the real presets.
const { readPreview } = await import(pathToFileURL(path.join(TEMPLATE, 'src', 'lib', 'preview.mjs')).href);

const COLOURS = ['--background', '--foreground', '--card', '--muted', '--line', '--line-strong', '--accent', '--accent-contrast', '--focus', '--danger', '--danger-contrast'];
const SHAPE = ['--font-size-base', '--h1-size', '--h2-size', '--h3-size', '--heading-weight', '--heading-tracking', '--space', '--pad-card', '--gap', '--content-max'];

for (const id of PRESET_ORDER) {
  test(`preview page reads the ${id} preview in light and dark`, async () => {
    const { tokens } = await loadPreset(id);
    const json = JSON.parse(JSON.stringify(toPreview(tokens)));
    for (const theme of ['light', 'dark']) {
      const p = readPreview(json, theme);
      assert.ok(p, `${id} ${theme} is a preview`);
      for (const name of [...COLOURS, '--radius', '--radius-sm', '--shadow', '--accent-soft', ...SHAPE]) {
        assert.equal(p.vars[name], json.theme[theme][name] ?? json.shape[name], `${id} ${theme} ${name} arrives unchanged`);
      }
      assert.deepEqual(p.look, json.look);
      assert.equal(p.home, json.home);
      assert.equal(p.layout, json.layout);
      assert.equal(p.background, json.theme[theme]['--background']);
      assert.equal(p.baseSize, json.shape['--font-size-base']);
      const wantedUrls = [json.fonts.body.cssUrl, json.fonts.heading.cssUrl].filter(Boolean);
      assert.deepEqual(p.fontUrls, [...new Set(wantedUrls)]);
      assert.ok(p.headingFont, 'heading font is set');
    }
  });
}
