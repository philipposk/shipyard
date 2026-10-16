import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, hexToHsl, hslToHex, luminance, contrast, mix, normalizeHex, isHex, withLightness, colourName,
} from '../scripts/design/color.mjs';

test('hex <-> rgb round trip and normalising', () => {
  assert.deepEqual(hexToRgb('#336699'), [51, 102, 153]);
  assert.equal(rgbToHex([51, 102, 153]), '#336699');
  assert.equal(rgbToHex([300, -5, 12.4]), '#ff000c');
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' #AABBCC '), '#aabbcc');
  assert.equal(normalizeHex('aabbcc'), null);
  assert.equal(normalizeHex('#aabbccdd'), null);
  assert.equal(isHex('#aabbcc'), true);
  assert.equal(isHex('#abc'), false);
  assert.throws(() => hexToRgb('red'), /6-digit hex/);
});

test('hsl conversion matches known colours and round-trips', () => {
  const red = rgbToHsl([255, 0, 0]);
  assert.deepEqual([red.h, red.s, red.l], [0, 1, 0.5]);
  const grey = rgbToHsl([128, 128, 128]);
  assert.equal(grey.s, 0);
  assert.equal(hslToHex({ h: 120, s: 1, l: 0.5 }), '#00ff00');
  assert.equal(hslToHex({ h: 240, s: 1, l: 0.5 }), '#0000ff');
  for (const hex of ['#2563eb', '#c24a24', '#1b7a4b', '#f4f4f5', '#090d12']) {
    assert.equal(hslToHex(hexToHsl(hex)), hex);
  }
  assert.deepEqual(hslToRgb({ h: 360, s: 0, l: 1 }), [255, 255, 255]);
});

test('WCAG luminance and contrast match published values', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrast('#ffffff', '#ffffff') - 1) < 1e-9);
  // #777777 on white is the classic 4.48:1 (just under AA); #767676 is 4.54:1 (just over)
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.01);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
  // order does not matter
  assert.equal(contrast('#2563eb', '#ffffff'), contrast('#ffffff', '#2563eb'));
  assert.ok(contrast('#2563eb', '#ffffff') > 5);
});

test('mix and withLightness', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#ffffff', 0), '#102030');
  assert.equal(mix('#102030', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#102030', '#ffffff', 7), '#ffffff');
  const lighter = withLightness('#2563eb', 0.8);
  assert.ok(hexToHsl(lighter).l > 0.78);
  assert.ok(Math.abs(hexToHsl(lighter).h - hexToHsl('#2563eb').h) < 2);
});

test('colourName gives a plain family word', () => {
  assert.equal(colourName('#2563eb'), 'blue');
  assert.equal(colourName('#e8590c'), 'orange');
  assert.equal(colourName('#1b7a4b'), 'green');
  assert.equal(colourName('#111113'), 'near-black');
  assert.equal(colourName('#808080'), 'grey');
});
