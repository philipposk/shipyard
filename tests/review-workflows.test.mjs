// The review skill's workflow files, run with stand-in agents: the meta block is a pure literal whose phases
// match the phase() calls, and the orchestration (dedup, waves, clusters, models, failures) does what the skill says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'skills', 'review', 'workflows');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function load(name) {
  const text = readFileSync(path.join(DIR, name), 'utf8');
  const m = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(text);
  assert.ok(m, `${name} must start with export const meta = {...}`);
  const meta = new Function(`return (${m[1]})`)();
  const body = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', text.slice(m[0].length));
  return {
    text, meta, metaText: m[1],
    async run(args, answer) {
      const calls = [];
      const phases = [];
      const logs = [];
      const agent = async (prompt, opts = {}) => {
        calls.push({ prompt, ...opts });
        const out = await answer(opts.label ?? '', prompt, opts);
        return out === undefined ? null : out;
      };
      const parallel = (thunks) => Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));
      const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
        let v = item;
        try { for (const s of stages) v = await s(v, item, i); return v; } catch { return null; }
      }));
      const result = await body(args, agent, parallel, pipeline, (p) => phases.push(p), (l) => logs.push(l));
      return { result, calls, phases, logs };
    },
  };
}

const FILES = readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();

test('the four workflows are there', () => {
  assert.deepEqual(FILES, ['content-gaps.js', 'diff-review.js', 'fix-waves.js', 'review.js']);
});

for (const file of FILES) {
  test(`${file}: meta is a pure literal, and nothing breaks resume`, () => {
    const { meta, metaText, text } = load(file);
    assert.match(meta.name, /^[a-z0-9-]+$/);
    assert.ok(meta.description && !meta.description.includes('—'));
    assert.ok(!/\$\{|\.\.\.|\(\s*\)/.test(metaText), 'meta must not compute anything');
    assert.ok(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(text), 'Date.now, Math.random and new Date() break resume');
    assert.ok(!/\/Users\/|\/home\/|~\/\.claude/.test(text), 'no machine paths');
    const used = [...text.matchAll(/\bphase\('([^']+)'\)/g)].map((x) => x[1]);
    assert.deepEqual([...new Set(used)], meta.phases.map((p) => p.title), 'phase() calls must match meta.phases in order');
    for (const m of text.matchAll(/phase: '([^']+)'/g)) assert.ok(meta.phases.some((p) => p.title === m[1]), `agent phase ${m[1]} is not in meta`);
  });
}

const finding = (o) => ({ title: 't', file: 'src/x.ts', line: 1, severity: 'medium', category: 'bug', focus_author: false, confidence: 0.8, description: 'd', failure_scenario: 's', suggested_fix: 'f', ...o });
const verdict = (v, o = {}) => ({ verdict: v, reasoning: 'r', severity: 'high', fix_plan: 'p', files_to_touch: ['src/x.ts'], fix_risk: 'low', needs_user_decision: false, ...o });

test('review.js: strong areas get the strong model, duplicates merge, skeptics decide, failed areas are named', async () => {
  const wf = load('review.js');
  const { result, calls, phases } = await wf.run({
    repo: '/work/app', app: 'A notes app.', openItems: 'docs/OPEN-ITEMS.md', focusAuthor: 'bot@example.com',
    areas: [{ key: 'auth', strong: true, scope: 'sign-in' }, { key: 'ui', strong: false, scope: 'pages' }, { key: 'gone', scope: 'x' }, { key: 'old', model: 'opus', scope: 'y' }],
  }, (label) => {
    if (label === 'find:auth') return { findings: [finding({ title: 'open redirect', file: 'src/proxy.ts', line: 10, severity: 'high', category: 'security' }), finding({ title: 'typo', file: 'src/lib/a.ts', line: 5, severity: 'low' }), finding({ title: 'lost', file: 'src/lib/b.ts', line: 7 })] };
    if (label === 'find:ui') return { findings: [finding({ title: 'same redirect', file: 'src/proxy.ts', line: 12 })] };
    if (label === 'find:old') return { findings: [] };
    if (label === 'find:gone') return null;
    if (label === 'dedup') return { groups: [{ keep: 0, merged: [3] }, { keep: 1, merged: [] }, { keep: 2, merged: [] }] };
    if (label === 'verify:auth:b.ts:7') throw new Error('verifier died');
    if (label === 'verify:auth:proxy.ts:10') return verdict('confirmed');
    if (label === 'verify:auth:a.ts:5') return verdict('refuted');
    throw new Error(`unexpected ${label}`);
  });
  assert.deepEqual(phases, ['Find', 'Dedup', 'Verify']);
  const model = (label) => calls.find((c) => c.label === label).model;
  assert.equal(model('find:auth'), 'opus');
  assert.equal(model('find:ui'), 'sonnet');
  assert.equal(model('find:old'), 'opus');
  assert.equal(model('verify:auth:proxy.ts:10'), 'opus');
  assert.equal(model('verify:auth:a.ts:5'), 'sonnet');
  assert.match(calls.find((c) => c.label === 'find:auth').prompt, /docs\/OPEN-ITEMS\.md[\s\S]*bot@example\.com/);
  assert.equal(result.repo, '/work/app');
  assert.deepEqual(result.failedAreas, ['gone']);
  assert.deepEqual(result.counts, { raw: 4, unique: 3, confirmed: 1, uncertain: 0, unverified: 1 });
  assert.deepEqual(result.unverified.map((u) => u.where), ['src/lib/b.ts:7'], 'a finding whose verifier failed is kept');
  assert.equal(result.confirmed[0].where, 'src/proxy.ts:10');
  assert.equal(result.confirmed[0].id, 0, 'every confirmed finding carries the number --skip and decisions use');
  assert.equal(result.confirmed[0].also.length, 1);
  assert.deepEqual(result.confirmed[0].files, ['src/x.ts']);
  assert.equal(result.refuted.length, 1);
});

test('review.js: one finding skips the dedup agent', async () => {
  const wf = load('review.js');
  const { result, calls } = await wf.run({ repo: '/r', app: 'x', areas: [{ key: 'a', scope: 's' }] }, (label) => (label === 'find:a' ? { findings: [finding()] } : verdict('uncertain')));
  assert.ok(!calls.some((c) => c.label === 'dedup'));
  assert.equal(result.counts.uncertain, 1);
});

test('fix-waves.js: waves run in order, fixers are told which files are taken, a failed fixer is reported', async () => {
  const wf = load('fix-waves.js');
  const order = [];
  const { result, calls } = await wf.run({
    repo: '/work/app', reviewJson: '/tmp/review.json', decisions: { 2: 'keep the old link working' },
    batches: [{ k: 'a', strong: true, ids: [0], files: ['f1', 'f3'] }, { k: 'b', ids: [1], files: ['f2'] }, { k: 'c', ids: [2], files: ['f1'] }],
    waves: [['a', 'b'], ['c']],
  }, async (label) => {
    order.push(label);
    if (label === 'fix:b') return null;
    if (label === 'sweep:knip') return 'removed 3 exports';
    return { results: [{ id: 0, status: 'fixed', summary: 's', files_changed: ['f1'], tests: 'ok', open_item: '' }], checks: 'tsc ok' };
  });
  assert.ok(order.indexOf('fix:c') > order.indexOf('fix:a') && order.indexOf('fix:c') > order.indexOf('fix:b'));
  const prompt = (k) => calls.find((c) => c.label === `fix:${k}`).prompt;
  assert.match(prompt('a'), /do not edit them: f2\./);
  assert.match(prompt('b'), /do not edit them: f1, f3\./);
  assert.match(prompt('c'), /do not edit them: \(none\)/);
  assert.match(prompt('c'), /#2: keep the old link working/);
  assert.equal(calls.find((c) => c.label === 'fix:a').model, 'opus');
  assert.equal(calls.find((c) => c.label === 'fix:b').model, 'sonnet');
  assert.deepEqual(result.fixes.map((f) => f.area), ['a', 'b', 'c']);
  assert.match(result.fixes[1].checks, /agent failed/);
  assert.equal(result.sweep, 'removed 3 exports');

  const noSweep = await wf.run({ repo: '/r', reviewJson: '/r.json', batches: [], waves: [], sweep: false }, () => 'x');
  assert.equal(noSweep.calls.length, 0);
});

test('diff-review.js: findings that share a file go to one fixer, odd file names included', async () => {
  const wf = load('diff-review.js');
  const regression = (o) => ({ title: 't', file: 'f1', line: 1, severity: 'high', kind: 'regression', scenario: 's', fix: 'f', ...o });
  const { result, calls, phases } = await wf.run({ repo: '/work/app', base: 'release/x', groups: { x: ['f1', 'f2'], y: ['constructor'], z: ['f9'] } }, (label) => {
    if (label === 'review:x') return { findings: [regression({ title: 'A', file: 'f1' }), regression({ title: 'B', file: 'f2', line: 2, severity: 'low' })] };
    if (label === 'review:y') return { findings: [regression({ title: 'C', file: 'constructor', line: 3 }), regression({ title: 'D', file: 'f9', line: 4 })] };
    if (label === 'verify:f9:4') return null;
    if (label === 'review:z') return null;
    if (label === 'verify:f1:1') return { real: true, reasoning: 'r', fix: 'f', files: ['f1', 'f2'] };
    if (label === 'verify:f2:2') return { real: true, reasoning: 'r', fix: 'f', files: ['/work/app/f2', './f2:12'] };
    if (label === 'verify:constructor:3') return { real: true, reasoning: 'r', fix: 'f', files: ['constructor'] };
    if (label.startsWith('fix:')) return { results: [] };
    if (label === 'check') return 'all green';
    throw new Error(`unexpected ${label}`);
  });
  assert.deepEqual(phases, ['Review', 'Verify', 'Fix', 'Check']);
  assert.match(calls.find((c) => c.label === 'review:x').prompt, /git diff release\/x -- <file>/);
  assert.equal(calls.find((c) => c.label === 'verify:f2:2').model, 'sonnet');
  assert.deepEqual(result.failedAreas, ['z']);
  assert.equal(result.clusters, 2, 'f2 named three ways is still one file');
  assert.deepEqual(result.unverified.map((u) => u.title), ['D'], 'a regression whose verifier failed is kept');
  assert.match(calls.find((c) => c.label === 'review:x').prompt, /untracked/);
  const fixPrompts = calls.filter((c) => c.label.startsWith('fix:')).map((c) => c.prompt);
  assert.ok(fixPrompts.some((p) => /edit only: f1, f2 /.test(p)));
  assert.ok(fixPrompts.some((p) => /edit only: constructor /.test(p)));
  assert.equal(result.check, 'all green');

  const clean = await wf.run({ repo: '/r', groups: { x: ['f1'] } }, () => ({ findings: [] }));
  assert.equal(clean.result.check, 'nothing to fix');
});

test('content-gaps.js: every language is required in the copy plan, and a failed inventory stops early', async () => {
  const wf = load('content-gaps.js');
  const { result, calls } = await wf.run({ repo: '/work/app', app: 'x', languages: ['en', 'el'], since: '2026-10-01', rules: 'free plan only' }, (label) => {
    if (label === 'features') return { features: [] };
    if (label === 'surfaces') return { surfaces: [] };
    if (label === 'copy-plan') return { edits: [], notes: '' };
    throw new Error(label);
  });
  const plan = calls.find((c) => c.label === 'copy-plan');
  assert.deepEqual(plan.schema.properties.edits.items.properties.text.required, ['en', 'el']);
  assert.match(plan.prompt, /en, el[\s\S]*free plan only/);
  assert.match(calls.find((c) => c.label === 'features').prompt, /--since=2026-10-01/);
  assert.deepEqual(result.plan, { edits: [], notes: '' });

  const failed = await wf.run({ repo: '/r', app: 'x' }, (label) => (label === 'surfaces' ? { surfaces: [] } : null));
  assert.match(failed.result.error, /inventory failed \(features\)/);
  assert.ok(!failed.calls.some((c) => c.label === 'copy-plan'));
});
