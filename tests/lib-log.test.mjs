import { test } from 'node:test';
import assert from 'node:assert/strict';

const log = await import('../scripts/lib/log.mjs');
const { parseArgs, UsageError } = log;

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('');
}

test('log helpers print the right marks', () => {
  const out = capture(() => {
    log.ok('good'); log.fail('bad'); log.warn('hmm'); log.info('note'); log.step(2, 5, 'doing');
  });
  assert.match(out, /✓ good/);
  assert.match(out, /✗ bad/);
  assert.match(out, /! hmm/);
  assert.match(out, /note/);
  assert.match(out, /\[2\/5\] doing/);
});

test('setQuiet silences human lines but not json()', () => {
  log.setQuiet(true);
  const out = capture(() => { log.ok('hidden'); log.json({ a: 1 }); });
  log.setQuiet(false);
  assert.ok(!out.includes('hidden'));
  assert.deepEqual(JSON.parse(out), { a: 1 });
});

const spec = { boolean: ['json', 'help', 'no-pwa'], string: ['name', 'dir', 'only'], alias: { h: 'help' } };

test('parseArgs: positionals, flags, values, --key=value, defaults', () => {
  const a = parseArgs(['my-app', '--name', 'My App', '--json', '--dir=/tmp/x', 'extra'], spec);
  assert.deepEqual(a._, ['my-app', 'extra']);
  assert.equal(a.name, 'My App');
  assert.equal(a.dir, '/tmp/x');
  assert.equal(a.json, true);
  assert.equal(a.help, false);
  assert.equal(a['no-pwa'], false);
  assert.equal(a.only, undefined);
});

test('parseArgs: alias, -- terminator, values that look like negative numbers', () => {
  const a = parseArgs(['-h', '--name', '-5', '--', '--json', 'x'], spec);
  assert.equal(a.help, true);
  assert.equal(a.name, '-5');
  assert.deepEqual(a._, ['--json', 'x']);
});

test('parseArgs: unknown flag, missing value, bad boolean value => UsageError (exit 2)', () => {
  for (const argv of [['--nope'], ['--name'], ['--name', '--json'], ['--json=maybe'], ['-z']]) {
    assert.throws(() => parseArgs(argv, spec), (e) => e instanceof UsageError && e.exitCode === 2, argv.join(' '));
  }
});

test('parseArgs: multiple collects repeats', () => {
  const a = parseArgs(['--only', 'a', '--only=b'], { string: ['only'], multiple: ['only'] });
  assert.deepEqual(a.only, ['a', 'b']);
});
