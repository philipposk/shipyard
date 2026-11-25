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
const { encodeGif, lzwEncode, indexFrames } = await import('../scripts/lib/gif.mjs');

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
  let pos = 0, prev = null, sawEoi = false;
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
    if (code === eoi) {
      sawEoi = true;
      break;
    }
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
  assert.ok(sawEoi, 'the stream ends with an end-of-information code');
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

test('encodeGif: transparent pixels land on white; past 256 colours the most used stay exact', () => {
  const t = solid(4, 1, () => [0, 0, 0, 0]);
  assert.equal(decodeGif(encodeGif([t])).frames[0][0], rgb(255, 255, 255));
  // A sketch accent (#1b7a4b) on white, with 400 one-pixel anti-aliasing shades along one row.
  const many = solid(400, 40, (x, y) => (y === 0 ? [x % 256, Math.floor(x / 256) * 40, 7] : x < 200 ? [27, 122, 75] : [255, 255, 255]));
  assert.equal(indexFrames([many]).exact, false);
  const gif = decodeGif(encodeGif([many]));
  assert.equal(gif.frames[0][400 * 5 + 10], rgb(27, 122, 75));
  assert.equal(gif.frames[0][400 * 5 + 300], rgb(255, 255, 255));
  assert.ok(new Set(gif.frames[0]).size <= 256);
});

test('encodeGif refuses frames of different sizes', () => {
  assert.throws(() => encodeGif([solid(2, 2, () => [0, 0, 0]), solid(3, 2, () => [0, 0, 0])]), /same size/);
  assert.throws(() => encodeGif([]), /at least one/);
});

test('lzwEncode: every stream ends with a readable end code, at every code size (fuzzed)', () => {
  // The reviewed boundary case: the decoder widens to 5 bits right before the end code.
  assert.deepEqual(lzwDecode(lzwEncode([0, 0, 1, 0, 2, 0, 3, 1, 1, 2, 1], 2), 2, 11), [0, 0, 1, 0, 2, 0, 3, 1, 1, 2, 1]);
  let seed = 11;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (const min of [2, 3, 4, 8]) {
    for (let run = 0; run < 300; run++) {
      const len = 1 + rand(run < 200 ? 60 : 6000);
      const colours = 1 + rand(Math.min(1 << min, 1 + rand(1 << min)));
      const input = Array.from({ length: len }, () => rand(colours));
      assert.deepEqual(lzwDecode(lzwEncode(input, min), min, len), input);
    }
  }
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
  for (const attr of ['fill="url(#hatch)"', `fill="url('#hatch')"`, `fill='url( "#hatch" )'`]) assert.deepEqual(qs.checkSvg(GOOD(`<rect ${attr}/><text>x</text>`)).errors, [], attr);
  assert.ok(qs.checkSvg(GOOD(`<rect fill="url('https://x/y')"/><text>x</text>`)).errors.length > 0);
});

test('checkSvg: anything outside the one <svg> root, unknown elements and outside hrefs are refused', () => {
  const tricks = [
    `${GOOD('<text>Safe</text>')}<img src="missing" /onerror="alert(1)">`,
    `<p>hi</p>${GOOD('<text>x</text>')}`,
    GOOD('<text>x</text><img src="a.png"/>'),
    GOOD('<text>x</text><iframe/>'),
    GOOD('<text>x</text><use href="https://x/y.svg#a"/>'),
    GOOD('<text>x</text></svg><g>'),
    GOOD('<text>x</text><![CDATA[ x ]]>'),
  ];
  for (const svg of tricks) assert.ok(qs.checkSvg(svg).errors.length > 0, svg);
  const fine = '<?xml version="1.0"?>\n<!-- a sketch -->\n' + GOOD('<defs><pattern id="h" width="4" height="4"><path d="M0 0L4 4" stroke="#ccc"/></pattern></defs><g><rect fill="url(#h)"/><use href="#h"/><text>x<tspan>y</tspan></text></g>');
  assert.deepEqual(qs.checkSvg(fine).errors, []);
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

test('animatedSvg keeps each frame root (a colour set on <svg> still changes between frames)', () => {
  const a = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" fill="#2563eb"><rect width="5" height="5"/><text>a</text></svg>';
  const b = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" fill="#777777"><rect width="5" height="5"/><text>a</text></svg>';
  const out = qs.animatedSvg([a, b], [0, 0, 10, 10]);
  assert.match(out, /fill="#2563eb"/);
  assert.match(out, /fill="#777777"/);
  assert.equal((out.match(/<svg /g) ?? []).length, 3);
});

test('loadSketch refuses a sketch file that an output would overwrite', async () => {
  const spec = { title: 'x', variations: [{ name: 'pulse', frames: ['pulse.anim.svg', 't2.svg'] }] };
  const s = await qs.loadSketch(await folder('collide', spec, { 'pulse.anim.svg': GOOD('<text>a</text>'), 't2.svg': GOOD('<text>b</text>') }));
  assert.equal(s.ok, false);
  assert.match(s.errors.join(), /pulse\.anim\.svg is both a sketch you wrote and a file this script writes/);
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

// ---- block sketches (the cheap path: a few words per option, the script draws the SVG) ----
const blocks = await import('../scripts/lib/sketch-blocks.mjs');

test('renderBlocks: every block draws a safe SVG that passes the checker, in every frame', () => {
  const all = blocks.BLOCK_HELP.map(([w]) => w.split(' ')[0]).filter((k) => k !== 'sidebar');
  const lines = all.map((k) => `${k} ${k === 'list' ? '3 check done:1' : k === 'text' || k === 'cards' ? '2' : 'One | Two'}`);
  for (const frame of Object.keys(blocks.FRAMES)) {
    const svg = blocks.renderBlocks(lines, { frame, accent: '#1b7a4b' });
    assert.deepEqual(qs.checkSvg(svg).errors, [], frame);
    assert.match(svg, new RegExp(`viewBox="0 0 ${blocks.FRAMES[frame].join(' ')}"`));
  }
  const desk = blocks.renderBlocks(['sidebar Home|Notes', 'title Notes', 'list 2'], { frame: 'desktop' });
  assert.deepEqual(qs.checkSvg(desk).errors, []);
});

test('renderBlocks: * marks the accent, done ticks a row, text is escaped', () => {
  assert.match(blocks.renderBlocks(['*fab +'], { accent: '#1b7a4b' }), /fill="#1b7a4b"/);
  assert.doesNotMatch(blocks.renderBlocks(['fab +'], { accent: '#1b7a4b' }), /#1b7a4b/);
  assert.match(blocks.renderBlocks(['list 2 check done:2'], { accent: '#1b7a4b' }), /<path d="M/);
  const svg = blocks.renderBlocks(['title <b>&"x"</b>']);
  assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;&lt;\/b&gt;/);
  assert.deepEqual(qs.checkSvg(svg).errors, []);
});

test('blockProblems: unknown words, empty lists, too many lines, sidebar off desktop, bad frame', () => {
  assert.match(blocks.blockProblems(['title x', 'banana 3']).join(), /"banana 3" is not a block/);
  assert.match(blocks.blockProblems([]).join(), /needs "blocks"/);
  assert.match(blocks.blockProblems(Array(15).fill('space')).join(), /at most 14/);
  assert.match(blocks.blockProblems(['sidebar a|b'], 'phone').join(), /only fits frame "desktop"/);
  assert.match(blocks.blockProblems(['title x'], 'watch').join(), /phone, desktop or card/);
});

test('main all with blocks: draws option and frame SVGs, a GIF, and a page with the reason', async () => {
  const spec = {
    title: 'Adding a note',
    accent: '#1b7a4b',
    recommended: 1,
    because: 'Notes are one line.',
    options: [
      { name: 'Input on top', note: 'Good: fast. Costs: space.', blocks: ['title Notes', '*input Write | Add', 'list 3'] },
      { name: 'Floating button', blocks: ['title Notes', 'list 3', '*fab +'] },
    ],
    variations: [{ name: 'tick', frames: [['list 2 check'], ['list 2 check done:1']] }],
  };
  const dir = await folder('blocks', spec, {});
  const fake = {
    async newPage() {
      return { async setContent() {}, async evaluate(_f, { width, height }) { return Buffer.alloc(width * height * 4, 200).toString('base64'); } };
    },
    async close() {},
  };
  const res = await qs.main({ _: ['all', dir] }, { browserOpener: async () => ({ browser: fake }) });
  assert.equal(res.ok, true, res.errors.join());
  assert.deepEqual(res.drawn, ['option-1.svg', 'option-2.svg', 'tick-1.svg', 'tick-2.svg']);
  const names = await readdir(dir);
  for (const f of [...res.drawn, 'tick.gif', 'index.html']) assert.ok(names.includes(f), f);
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /Recommended: 1\.<\/strong> Notes are one line\./);
  assert.match(html, /--accent: #1b7a4b/);
});

test('loadSketch with blocks: bad blocks, a bad accent and a file named like a drawn one are errors', async () => {
  const spec = {
    title: 'x',
    accent: 'green',
    options: [{ name: 'A', blocks: ['banana'] }, { name: 'B', file: 'option-1.svg' }],
  };
  const s = await qs.loadSketch(await folder('badblocks', spec, { 'option-1.svg': GOOD() }));
  const all = s.errors.join('\n');
  assert.match(all, /Option 1 "banana" is not a block/);
  assert.match(all, /"accent" is a colour/);
  assert.match(all, /option-1\.svg is drawn from blocks and also named as a file you wrote/);
  const warn = await qs.loadSketch(await folder('nobecause', { title: 'x', recommended: 1, options: [{ name: 'A', blocks: ['title a'] }, { name: 'B', blocks: ['title b'] }] }, {}));
  assert.match(warn.warnings.join(), /Add "because"/);
});
