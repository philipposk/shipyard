// /shipyard:quick-sketch: checks SVG sketches, builds the comparison page, encodes GIFs (and the
// animated SVG fallback without a browser). The GIF is decoded here with a small reference decoder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'ship-sketch-'));
after(() => rm(tmp, { recursive: true, force: true }));
(await import('../scripts/lib/log.mjs')).setQuiet(true);
const qs = await import('../scripts/quick-sketch.mjs');
const { encodeGif, lzwEncode, fallbackPalette } = await import('../scripts/lib/gif.mjs');

// ---- a reference GIF decoder (only what the encoder writes) ----
function lzwDecode(bytes, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let size = minCodeSize + 1, next = eoi + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    size = minCodeSize + 1;
    next = eoi + 1;
  };
  reset();
  const out = [];
  let pos = 0, prev = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const bit = (bytes[(pos + i) >> 3] >> ((pos + i) & 7)) & 1;
      code |= bit << i;
    }
    pos += size;
    return code;
  };
  while (pos + size <= bytes.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev) {
      if (next < 4096) dict[next++] = [...prev, entry[0]];
      if (next === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  assert.equal(out.length, pixelCount, 'decoded pixel count');
  return out;
}

function decodeGif(buf) {
  assert.equal(buf.subarray(0, 6).toString('latin1'), 'GIF89a');
  const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
  const flags = buf[10];
  const tableSize = 1 << ((flags & 7) + 1);
  const palette = [];
  let p = 13;
  for (let i = 0; i < tableSize; i++, p += 3) palette.push((buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]);
  const frames = [];
  let loop = null;
  const delays = [];
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      const blocks = [];
      while (buf[p] !== 0) {
        blocks.push(buf.subarray(p + 1, p + 1 + buf[p]));
        p += buf[p] + 1;
      }
      p++;
      if (label === 0xff && blocks[0].toString('latin1') === 'NETSCAPE2.0') loop = blocks[1].readUInt16LE(1);
      if (label === 0xf9) delays.push(blocks[0].readUInt16LE(1) * 10);
      continue;
    }
    assert.equal(b, 0x2c, 'image descriptor');
    const w = buf.readUInt16LE(p + 4), h = buf.readUInt16LE(p + 6);
    p += 9;
    const min = buf[p++];
    const data = [];
    while (buf[p] !== 0) {
      data.push(...buf.subarray(p + 1, p + 1 + buf[p]));
      p += buf[p] + 1;
    }
    p++;
    frames.push(lzwDecode(data, min, w * h).map((i) => palette[i]));
  }
  return { width, height, frames, loop, delays };
}

function solid(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      rgba.set([r, g, b, a], (y * width + x) * 4);
    }
  return { width, height, rgba };
}
const rgb = (r, g, b) => (r << 16) | (g << 8) | b;

test('encodeGif: two frames round-trip exactly, loop forever, delays kept', () => {
  const a = solid(37, 23, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [20, 20, 20]));
  const b = solid(37, 23, (x) => (x < 10 ? [37, 99, 235] : [255, 255, 255]));
  const gif = decodeGif(encodeGif([a, b], { delayMs: [500, 900] }));
  assert.equal(gif.width, 37);
  assert.equal(gif.height, 23);
  assert.equal(gif.loop, 0);
  assert.deepEqual(gif.delays, [500, 900]);
  assert.equal(gif.frames.length, 2);
  assert.equal(gif.frames[0][0], rgb(20, 20, 20));
  assert.equal(gif.frames[0][1], rgb(255, 255, 255));
  assert.equal(gif.frames[1][0], rgb(37, 99, 235));
  assert.equal(gif.frames[1][36], rgb(255, 255, 255));
});

test('encodeGif: a noisy frame long enough to fill the code table still round-trips', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 200;
  const f = solid(160, 120, () => {
    const v = rand();
    return [v, v, v];
  });
  const gif = decodeGif(encodeGif([f]));
  for (let i = 0; i < 160 * 120; i += 997) {
    const v = f.rgba[i * 4];
    assert.equal(gif.frames[0][i], rgb(v, v, v));
  }
});

test('encodeGif: transparent pixels land on white; more than 256 colours fall back to the cube', () => {
  const t = solid(4, 1, () => [0, 0, 0, 0]);
  assert.equal(decodeGif(encodeGif([t])).frames[0][0], rgb(255, 255, 255));
  const many = solid(32, 32, (x, y) => [x * 8, y * 8, (x * y) % 256]);
  const gif = decodeGif(encodeGif([many]));
  const cube = new Set(fallbackPalette());
  assert.ok(gif.frames[0].every((c) => cube.has(c)));
});

test('encodeGif refuses frames of different sizes', () => {
  assert.throws(() => encodeGif([solid(2, 2, () => [0, 0, 0]), solid(3, 2, () => [0, 0, 0])]), /same size/);
  assert.throws(() => encodeGif([]), /at least one/);
});

test('lzwEncode of nothing is a clear code and an end code', () => {
  assert.deepEqual(lzwDecode(lzwEncode([], 2), 2, 0), []);
});

// ---- SVG checks ----
const GOOD = (body = '<rect x="10" y="10" width="100" height="40" fill="#eee"/><text x="20" y="35">Save</text>', vb = '0 0 240 160') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;

test('checkSvg: a plain sketch passes and reports its viewBox', () => {
  const r = qs.checkSvg(GOOD());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.viewBox, [0, 0, 240, 160]);
});

test('checkSvg: scripts, handlers, links, outside files and foreignObject are refused', () => {
  const bad = [
    '<script>alert(1)</script>',
    '<rect onclick="x()" width="1" height="1"/>',
    '<a href="https://example.com"><text>x</text></a>',
    '<image href="https://example.com/a.png"/>',
    '<rect style="fill:url(https://x/y)"/>',
    '<foreignObject><div>x</div></foreignObject>',
  ];
  for (const body of bad) assert.ok(qs.checkSvg(GOOD(body)).errors.length > 0, body);
  assert.deepEqual(qs.checkSvg(GOOD('<rect fill="url(#hatch)"/><text>x</text>')).errors, []);
});

test('checkSvg: missing viewBox, too big, too many colours, no words', () => {
  assert.match(qs.checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>').errors.join(), /viewBox/);
  assert.match(qs.checkSvg(GOOD(`<text>x</text>${'<rect/>'.repeat(3000)}`)).errors.join(), /bytes/);
  const colours = qs.checkSvg(GOOD('<text>x</text><rect fill="#ff0000"/><rect fill="#00ff00"/><rect fill="#0000ff"/><rect fill="#888"/>'));
  assert.match(colours.warnings.join(), /3 colours/);
  assert.match(qs.checkSvg(GOOD('<rect/>')).warnings.join(), /no words/);
});

// ---- manifest, board, animation ----
async function folder(name, spec, files) {
  const dir = path.join(tmp, name);
  await rm(dir, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  if (spec) await writeFile(path.join(dir, 'sketch.json'), JSON.stringify(spec));
  for (const [f, t] of Object.entries(files)) await writeFile(path.join(dir, f), t);
  return dir;
}

const SPEC = {
  title: 'Where <the> save button goes',
  question: 'Bottom bar or top corner?',
  recommended: 2,
  options: [
    { name: 'Bottom bar', file: 'a.svg', note: 'Easy to reach.' },
    { name: 'Top corner', file: 'b.svg' },
  ],
  variations: [{ name: 'tick-a-task', frames: ['t1.svg', 't2.svg'], delay: 600 }],
};
const FILES = { 'a.svg': GOOD(), 'b.svg': GOOD(), 't1.svg': GOOD('<rect fill="#fff"/><text>Milk</text>'), 't2.svg': GOOD('<rect fill="#2563eb"/><text>Milk</text>') };

test('loadSketch: a good folder is ok', async () => {
  const s = await qs.loadSketch(await folder('good', SPEC, FILES));
  assert.deepEqual(s.errors, []);
  assert.equal(s.ok, true);
  assert.equal(s.svgs.size, 4);
});

test('loadSketch: wrong option count, bad names, path escapes, missing files and mismatched frames', async () => {
  const spec = {
    title: 'x',
    recommended: 9,
    options: [{ name: 'Only one', file: '../secret.svg' }],
    variations: [
      { name: 'Bad Name', frames: ['t1.svg', 't2.svg'] },
      { name: 'one-frame', frames: ['t1.svg'] },
      { name: 'mismatch', frames: ['t1.svg', 'wide.svg'], delay: 10 },
      { name: 'gone', frames: ['t1.svg', 'missing.svg'] },
    ],
  };
  const s = await qs.loadSketch(await folder('bad', spec, { ...FILES, 'wide.svg': GOOD('<text>x</text>', '0 0 300 160') }));
  const all = s.errors.join('\n');
  assert.equal(s.ok, false);
  assert.match(all, /2 to 4 options/);
  assert.match(all, /not a plain \.svg file name/);
  assert.match(all, /"recommended"/);
  assert.match(all, /lowercase words/);
  assert.match(all, /2 to 6 frames/);
  assert.match(all, /different viewBox/);
  assert.match(all, /"delay"/);
  assert.match(all, /missing\.svg is missing/);
});

test('loadSketch: no sketch.json or broken JSON is a usage error', async () => {
  await assert.rejects(qs.loadSketch(await folder('none', null, {})), /No sketch\.json/);
  const dir = await folder('broken', null, {});
  await writeFile(path.join(dir, 'sketch.json'), '{nope');
  await assert.rejects(qs.loadSketch(dir), /not valid JSON/);
});

test('boardHtml: options side by side, recommended marked, text escaped, variation image linked', async () => {
  const s = await qs.loadSketch(await folder('board', SPEC, FILES));
  const html = qs.boardHtml(s, { gifs: { 'tick-a-task': 'tick-a-task.gif' } });
  assert.match(html, /Where &lt;the&gt; save button goes/);
  assert.equal((html.match(/<figure class="card/g) ?? []).length, 3);
  assert.match(html, /2\. Top corner<\/strong> <span class="badge">Recommended/);
  assert.doesNotMatch(html, /1\. Bottom bar<\/strong> <span class="badge">/);
  assert.match(html, /<img src="tick-a-task\.gif"/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test('animatedSvg: one layer per frame, discrete timing, no script', () => {
  const out = qs.animatedSvg([GOOD('<text>A</text>'), GOOD('<text>B</text>'), GOOD('<text>C</text>')], [0, 0, 240, 160], 500);
  assert.equal((out.match(/<animate /g) ?? []).length, 3);
  assert.match(out, /dur="1\.50s"/);
  assert.match(out, /values="hidden;visible;hidden"/);
  assert.doesNotMatch(out, /<script/);
  assert.deepEqual(qs.checkSvg(out).errors.filter((e) => !/bytes/.test(e)), []);
});

test('sizedSvg and pixelSize: explicit size, longest side capped', () => {
  assert.match(qs.sizedSvg('<svg width="10" viewBox="0 0 2 1">', 200, 100), /^<svg width="200" height="100" viewBox/);
  assert.deepEqual(qs.pixelSize([0, 0, 240, 160], 2), { width: 480, height: 320 });
  assert.deepEqual(qs.pixelSize([0, 0, 2000, 1000], 1), { width: 800, height: 400 });
});

test('main all: without a browser, writes the animated SVG, removes a stale GIF and builds the page', async () => {
  const dir = await folder('nobrowser', SPEC, { ...FILES, 'tick-a-task.gif': 'old' });
  const res = await qs.main({ _: ['all', dir] }, { browserOpener: async () => ({ browser: null, reason: 'no browser here' }) });
  assert.equal(res.ok, true);
  assert.equal(res.gif, false);
  assert.equal(res.gifNote, 'no browser here');
  const names = await readdir(dir);
  assert.ok(names.includes('tick-a-task.anim.svg'));
  assert.ok(!names.includes('tick-a-task.gif'));
  assert.match(await readFile(path.join(dir, 'index.html'), 'utf8'), /<img src="tick-a-task\.anim\.svg"/);
});

test('main all: with a browser, rasterises each frame and writes a real GIF', async () => {
  const dir = await folder('browser', SPEC, FILES);
  const sizes = [];
  const fakeBrowser = {
    async newPage() {
      return {
        async setContent() {},
        async evaluate(_fn, { width, height }) {
          sizes.push([width, height]);
          return Buffer.alloc(width * height * 4, sizes.length === 1 ? 255 : 0x80).toString('base64');
        },
      };
    },
    async close() {
      this.closed = true;
    },
  };
  const res = await qs.main({ _: ['all', dir], scale: '2' }, { browserOpener: async () => ({ browser: fakeBrowser }) });
  assert.equal(res.gif, true);
  assert.ok(fakeBrowser.closed);
  assert.deepEqual(sizes, [[480, 320], [480, 320]]);
  const gif = decodeGif(await readFile(path.join(dir, 'tick-a-task.gif')));
  assert.equal(gif.frames.length, 2);
  assert.deepEqual(gif.delays, [600, 600]);
  assert.equal(gif.frames[0][0], rgb(255, 255, 255));
});

test('main: check stops at errors and writes nothing; bad commands are usage errors', async () => {
  const dir = await folder('stop', { title: 'x', options: [{ name: 'a', file: 'a.svg' }] }, { 'a.svg': GOOD() });
  const res = await qs.main({ _: ['all', dir] });
  assert.equal(res.ok, false);
  assert.ok(!(await readdir(dir)).includes('index.html'));
  await assert.rejects(qs.main({ _: ['draw', dir] }), /check, board, gif or all/);
  await assert.rejects(qs.main({ _: ['board'] }), /sketch folder/);
  await assert.rejects(qs.main({ _: ['board', dir], scale: '9' }), /--scale/);
});
