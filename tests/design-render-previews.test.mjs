// Renderer: the pure helpers, the "stop the dev server for sure" machinery and the plain-English failures,
// all without a browser. The real browser run is in design-render-browser.test.mjs (opt-in).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-render-'));
process.env.SHIPYARD_HOME = path.join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true }));

const { previewIdFor, checkViews, checkItems, tailOf, explainServerFailure, findFreePort, portIsOpen, stopTree, renderPreviews, RenderError, PREVIEW_ID_RE } =
  await import('../scripts/design/render-previews.mjs');
const { loadPreset } = await import('../scripts/design/presets.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('previewIdFor: always an id the preview route accepts', () => {
  assert.equal(previewIdFor('calm-blue'), 'calm-blue');
  assert.equal(previewIdFor('Direction A'), 'direction-a');
  assert.equal(previewIdFor('../../etc/passwd'), 'etc-passwd');
  assert.equal(previewIdFor('x'.repeat(60)).length, 40);
  assert.equal(previewIdFor(''), '');
  assert.equal(previewIdFor('///'), '');
  for (const id of ['calm-blue', 'a'.repeat(41), 'Weird_Name!']) {
    const p = previewIdFor(id);
    assert.ok(p === '' || PREVIEW_ID_RE.test(p), id);
  }
});

test('checkViews: sizes and names are checked, theme defaults to light', () => {
  const ok = checkViews([{ name: 'phone-light', width: 390, height: 800, theme: 'light' }, { name: 'phone-dark', width: 390, height: 800, theme: 'dark' }, { name: 'd', width: 1280, height: 800 }]);
  assert.deepEqual(ok.map((v) => v.theme), ['light', 'dark', 'light']);
  assert.throws(() => checkViews([]), RenderError);
  assert.throws(() => checkViews([{ name: '../x', width: 390, height: 800 }]), /not a good name/);
  assert.throws(() => checkViews([{ name: 'a', width: 10, height: 800 }]), /strange size/);
  assert.throws(() => checkViews([{ name: 'a', width: 390, height: 800 }, { name: 'a', width: 390, height: 800 }]), /both called/);
});

test('checkItems: ids are cleaned and must not collide', async () => {
  const tokens = (await loadPreset('calm-blue')).tokens;
  const items = checkItems([{ id: 'calm-blue', tokens }, { id: 'direction-a', tokens }]);
  assert.deepEqual(items.map((i) => i.pid), ['calm-blue', 'direction-a']);
  assert.throws(() => checkItems([]), RenderError);
  assert.throws(() => checkItems([{ id: 'x', tokens: null }]), /no design/);
  assert.throws(() => checkItems([{ id: 'a b', tokens }, { id: 'a-b', tokens }]), /both called/);
  assert.throws(() => checkItems([{ id: '///', tokens }]), /not a usable/);
});

test('explainServerFailure: plain sentences for the usual dev server problems', () => {
  assert.match(explainServerFailure('Error: Another next dev server is already running.\n  - Local: http://localhost:3000'), /already running.*Ctrl\+C/s);
  assert.match(explainServerFailure('Error: listen EADDRINUSE: address already in use :::3000'), /port .* taken/);
  const generic = explainServerFailure('\x1b[31mBuild error\x1b[0m\nModule not found: foo\n');
  assert.match(generic, /would not start/);
  assert.match(generic, /Module not found/);
  assert.ok(!generic.includes('\x1b'));
  assert.equal(tailOf('a\nb\nc\nd', 2), 'c\nd');
});

test('findFreePort / portIsOpen see a real listening port', async () => {
  const port = await findFreePort();
  assert.ok(port > 1023);
  assert.equal(await portIsOpen(port), false);
  const server = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  assert.equal(await portIsOpen(port), true);
  await new Promise((r) => server.close(r));
  assert.equal(await portIsOpen(port), false);
});

test('stopTree: stops the child AND what the child started, and the port is closed afterwards', { skip: process.platform === 'win32' }, async () => {
  const port = await findFreePort();
  // parent starts a grandchild that holds the port, like next dev starting a helper process
  const grandchild = `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: 'ignore' });
  const until = Date.now() + 8000;
  while (!(await portIsOpen(port)) && Date.now() < until) await sleep(100);
  assert.equal(await portIsOpen(port), true, 'the helper started listening');
  const result = await stopTree(child, port, { graceMs: 1500, closeMs: 8000 });
  assert.equal(result.closed, true);
  assert.equal(await portIsOpen(port), false);
});

test('stopTree: a process that ignores the polite stop is still killed', { skip: process.platform === 'win32' }, async () => {
  const port = await findFreePort();
  const stubborn = `process.on('SIGTERM',()=>{});require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', stubborn], { detached: true, stdio: 'ignore' });
  const until = Date.now() + 8000;
  while (!(await portIsOpen(port)) && Date.now() < until) await sleep(100);
  const result = await stopTree(child, port, { graceMs: 600, closeMs: 8000 });
  assert.equal(result.closed, true);
});

test('renderPreviews: says what to do when the app has no node_modules', async () => {
  const app = path.join(tmp, 'no-modules');
  await mkdir(app, { recursive: true });
  const tokens = (await loadPreset('calm-blue')).tokens;
  await assert.rejects(
    renderPreviews({ appDir: app, items: [{ id: 'calm-blue', tokens }], views: [{ name: 'phone-light', width: 390, height: 800, theme: 'light' }] }),
    (err) => err instanceof RenderError && /npm install/.test(err.message) && err.code === 'no-node-modules',
  );
});

test('renderPreviews: an app from an older Shipyard (no design preview page) gets a clear message, and nothing is started', async () => {
  const app = path.join(tmp, 'old-app');
  await mkdir(path.join(app, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  await writeFile(path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), '#!/usr/bin/env node\nprocess.exit(1)\n');
  const tokens = (await loadPreset('calm-blue')).tokens;
  let started = false;
  await assert.rejects(
    renderPreviews({ appDir: app, items: [{ id: 'calm-blue', tokens }], views: [{ name: 'phone-light', width: 390, height: 800, theme: 'light' }], onServerStart: () => { started = true; } }),
    (err) => err instanceof RenderError && err.code === 'no-preview-route' && /older Shipyard/.test(err.message),
  );
  assert.equal(started, false);
});

test('renderPreviews: bad input is refused before anything starts', async () => {
  const tokens = (await loadPreset('calm-blue')).tokens;
  await assert.rejects(renderPreviews({ appDir: tmp, items: [], views: [{ name: 'a', width: 390, height: 800 }] }), RenderError);
  await assert.rejects(renderPreviews({ appDir: tmp, items: [{ id: 'a', tokens }], views: [{ name: 'Bad Name', width: 390, height: 800 }] }), RenderError);
  await assert.rejects(renderPreviews({ items: [{ id: 'a', tokens }], views: [{ name: 'a', width: 390, height: 800 }] }), /app folder/);
});

test('renderPreviews: when next dev dies at once, the reason is passed on and nothing is left behind', { skip: process.platform === 'win32' }, async () => {
  const app = path.join(tmp, 'broken-app');
  await mkdir(path.join(app, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  await mkdir(path.join(app, 'node_modules', 'playwright'), { recursive: true });
  await mkdir(path.join(app, 'src', 'app', 'design-preview'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), '{"name":"broken"}');
  await writeFile(path.join(app, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
  await writeFile(path.join(app, 'node_modules', 'playwright', 'index.js'), 'module.exports={chromium:{launch(){throw new Error("never reached")}}}');
  await writeFile(path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), 'console.error("Error: Another next dev server is already running.");process.exit(1)\n');
  const tokens = (await loadPreset('calm-blue')).tokens;
  let port = 0;
  await assert.rejects(
    renderPreviews({ appDir: app, items: [{ id: 'calm-blue', tokens }], views: [{ name: 'phone-light', width: 390, height: 800, theme: 'light' }], onServerStart: (s) => { port = s.port; } }),
    (err) => err instanceof RenderError && err.code === 'server-exited' && /already running/.test(err.message),
  );
  assert.ok(port > 0);
  assert.equal(await portIsOpen(port), false);
});

test('renderPreviews: a start hook that throws still stops the server it started', { skip: process.platform === 'win32' }, async () => {
  const app = path.join(tmp, 'hook-app');
  await mkdir(path.join(app, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  await mkdir(path.join(app, 'node_modules', 'playwright'), { recursive: true });
  await mkdir(path.join(app, 'src', 'app', 'design-preview'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), '{"name":"hook"}');
  await writeFile(path.join(app, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
  await writeFile(path.join(app, 'node_modules', 'playwright', 'index.js'), 'module.exports={chromium:{launch(){throw new Error("never reached")}}}');
  // a "server" that just sits there until it is stopped
  await writeFile(path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), 'setInterval(()=>{},1000)\n');
  const tokens = (await loadPreset('calm-blue')).tokens;
  let pid = 0;
  await assert.rejects(
    renderPreviews({ appDir: app, items: [{ id: 'calm-blue', tokens }], views: [{ name: 'phone-light', width: 390, height: 800, theme: 'light' }], onServerStart: (s) => { pid = s.pid; throw new Error('hook broke'); } }),
    /hook broke|Taking the screenshots failed/,
  );
  assert.ok(pid > 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'the server process is gone');
});
