import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { run, which, npx, buildWindowsCommandLine } = await import('../scripts/lib/run.mjs');
const node = process.execPath;

test('run captures stdout, stderr and exit code 0', async () => {
  const r = await run(node, ['-e', 'console.log("out"); console.error("err")']);
  assert.deepEqual(r, { code: 0, stdout: 'out\n', stderr: 'err\n' });
});

test('run does not throw on non-zero exit', async () => {
  const r = await run(node, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('run passes stdin through (the secret path) and it never shows up in argv', async () => {
  const secret = 'fake-secret-value-123';
  const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify({got:d,argv:process.argv.slice(1)})))';
  const r = await run(node, ['-e', script], { input: secret });
  const out = JSON.parse(r.stdout);
  assert.equal(out.got, secret);
  assert.ok(!JSON.stringify(out.argv).includes(secret));
});

test('run passes env and cwd', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-run-'));
  try {
    const r = await run(node, ['-e', 'console.log(process.env.SHIPYARD_TEST_VAR + "|" + process.cwd())'], {
      cwd: dir,
      env: { SHIPYARD_TEST_VAR: 'hello' },
    });
    const [v, cwd] = r.stdout.trim().split('|');
    assert.equal(v, 'hello');
    assert.equal(await (await import('node:fs/promises')).realpath(cwd), await (await import('node:fs/promises')).realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run reports a missing program as code 127 without throwing or echoing args', async () => {
  const r = await run('shipyard-no-such-program-xyz', ['--token', 'SHOULD-NOT-APPEAR']);
  assert.equal(r.code, 127);
  assert.ok(!r.stderr.includes('SHOULD-NOT-APPEAR'));
});

test('run stops a child that takes too long (code 124)', async () => {
  const r = await run(node, ['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 300 });
  assert.equal(r.code, 124);
});

test('run does not hang when the child ignores stdin', async () => {
  const r = await run(node, ['-e', 'console.log("done")'], { input: 'ignored' });
  assert.equal(r.code, 0);
});

test('which finds node and returns null for nonsense', async () => {
  const found = await which('node');
  assert.ok(found && path.isAbsolute(found));
  assert.equal(await which('shipyard-no-such-program-xyz'), null);
  assert.equal(await which('node; echo hi'), null);
});

test('npx builds a non-interactive call', () => {
  assert.deepEqual(npx(['vercel@latest', 'whoami']), ['npx', ['--yes', 'vercel@latest', 'whoami']]);
});

test('Windows command line quoting', () => {
  assert.equal(buildWindowsCommandLine('npx.cmd', ['--yes', 'a b']), '"npx.cmd --yes "a b""');
  assert.equal(buildWindowsCommandLine('npx.cmd', ['bad"arg']), null);
  assert.equal(buildWindowsCommandLine('npx.cmd', ['100%']), null);
});
