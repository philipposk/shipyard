import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthsSince, licenseId, mergeResults, summarizeTree, flagsFor, makeGh, repoSearchArgs, codeSearchArgs, scan, main } from '../scripts/prior-art.mjs';

const NOW = Date.parse('2026-11-19T00:00:00Z');
const repo = (fullName, o = {}) => ({ fullName, stargazersCount: 10, pushedAt: '2026-10-01T00:00:00Z', license: { key: 'mit' }, language: 'JavaScript', description: `${fullName} does it`, isArchived: false, isFork: false, ...o });

test('monthsSince and licenseId read GitHub values', () => {
  assert.ok(Math.abs(monthsSince('2025-11-19T00:00:00Z', NOW) - 12) < 0.1);
  assert.equal(monthsSince(undefined, NOW), Infinity);
  assert.equal(licenseId({ key: 'mit' }), 'mit');
  assert.equal(licenseId('Apache-2.0'), 'Apache-2.0');
  assert.equal(licenseId({ key: 'other' }), null);
  assert.equal(licenseId('NOASSERTION'), null);
  assert.equal(licenseId(null), null);
});

test('mergeResults dedupes, drops forks and archived, flags stale and unlicensed, ranks by hits then stars', () => {
  const searches = [
    { query: 'idea finder', kind: 'name', rows: [repo('a/one', { stargazersCount: 5 }), repo('b/two', { stargazersCount: 50 }), repo('c/fork', { isFork: true }), repo('d/old', { isArchived: true })] },
    { query: 'idea suggester', kind: 'name', rows: [repo('a/one', { stargazersCount: 5 }), repo('e/stale', { pushedAt: '2024-01-01T00:00:00Z' }), repo('f/nolic', { license: null }), repo('g/few', { stargazersCount: 1 })] },
    { query: 'idea', kind: 'skill', rows: [{ fullName: 'a/one' }, { fullName: 'h/skillonly', url: 'https://github.com/h/skillonly' }, { fullName: 'c/fork' }] },
  ];
  const { repos, dropped } = mergeResults(searches, { minStars: 3, staleMonths: 18, now: NOW });
  assert.deepEqual(dropped, { forks: 1, archived: 1 });
  assert.equal(repos[0].fullName, 'a/one');
  assert.equal(repos[0].hits, 3);
  assert.deepEqual(repos[0].foundBy, ['name:idea finder', 'name:idea suggester', 'skill:idea']);
  assert.equal(repos.find((r) => r.fullName === 'g/few'), undefined);
  assert.equal(repos.find((r) => r.fullName === 'e/stale').stale, true);
  assert.equal(repos.find((r) => r.fullName === 'f/nolic').referenceOnly, true);
  assert.equal(repos.find((r) => r.fullName === 'b/two').referenceOnly, false);
  assert.equal(repos.find((r) => r.fullName === 'h/skillonly').stars, null);
  assert.equal(new Set(repos.map((r) => r.fullName)).size, repos.length);
});

test('summarizeTree tells real code from prompt-only and finds tests', () => {
  const t = (paths, truncated = false) => ({ truncated, tree: paths.map((path) => ({ path, type: path.endsWith('/') ? 'tree' : 'blob' })) });
  assert.deepEqual(summarizeTree(t(['SKILL.md', 'README.md', 'references/a.md'])), { codeFiles: 0, markdownFiles: 3, hasTests: false, promptOnly: true, truncated: false });
  const real = summarizeTree(t(['src/index.ts', 'src/util.ts', 'tests/util.test.ts', 'README.md']));
  assert.equal(real.codeFiles, 3);
  assert.equal(real.hasTests, true);
  assert.equal(real.promptOnly, false);
  assert.equal(summarizeTree(t(['lib/a.py', 'test_a.py'], true)).hasTests, true);
  assert.equal(summarizeTree(t(['lib/a.py'], true)).truncated, true);
  assert.equal(summarizeTree({}).promptOnly, false);
});

test('flagsFor words each problem for a person', () => {
  const flags = flagsFor({ license: null, pushedAt: '2024-01-01T00:00:00Z', promptOnly: true, tree: true, hasTests: false, openIssues: 9, closedIssues: 2 }, 18, NOW);
  assert.equal(flags.length, 5);
  assert.match(flags[0], /do not copy code/);
  assert.deepEqual(flagsFor({ license: 'mit', pushedAt: '2026-10-01T00:00:00Z', tree: true, hasTests: true, openIssues: 1, closedIssues: 50 }, 18, NOW), []);
});

test('search arguments use name and description first, a star floor and a JSON field list', () => {
  const a = repoSearchArgs('idea finder', { minStars: 3, limit: 30 });
  assert.deepEqual(a.slice(0, 7), ['search', 'repos', 'idea finder', '--match', 'name,description', '--limit', '30']);
  assert.ok(a.join(' ').includes('--stars >=3'));
  assert.ok(a.join(' ').includes('isFork'));
  assert.ok(!repoSearchArgs('x', { minStars: 0 }).includes('--stars'));
  assert.ok(codeSearchArgs('idea').includes('SKILL.md'));
});

test('makeGh pauses between calls and waits once on a rate limit', async () => {
  const sleeps = [];
  const calls = [];
  const answers = [{ code: 0, stdout: '[]', stderr: '' }, { code: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' }, { code: 0, stdout: '[]', stderr: '' }, { code: 1, stdout: '', stderr: 'HTTP 403' }, { code: 1, stdout: '', stderr: 'HTTP 403' }];
  const gh = makeGh({ runner: async (_c, args) => { calls.push(args[0]); return answers.shift(); }, sleeper: async (ms) => { sleeps.push(ms); }, delayMs: 5, rateWaitMs: 99 });
  assert.equal((await gh(['a'])).code, 0);
  assert.equal((await gh(['b'])).code, 0);
  assert.deepEqual(sleeps, [5, 99]);
  assert.equal(calls.length, 3);
  const again = await gh(['c']);
  assert.equal(again.code, 1);
  assert.deepEqual(sleeps.slice(2), [5, 99]);
  assert.equal(calls.length, 5);
});

function fakeGh(log = []) {
  const treeOf = (paths) => JSON.stringify({ truncated: false, tree: paths.map((path) => ({ path, type: 'blob' })) });
  return async (args) => {
    log.push(args.join(' '));
    const [cmd, sub] = args;
    if (cmd === 'search' && sub === 'repos') {
      if (args[2] === 'broken') return { code: 1, stdout: '', stderr: 'HTTP 500' };
      return { code: 0, stdout: JSON.stringify([repo('a/one', { stargazersCount: 40 }), repo('b/two'), repo('c/fork', { isFork: true }), repo('d/nolic', { license: null })]), stderr: '' };
    }
    if (cmd === 'search' && sub === 'code') return { code: 0, stdout: JSON.stringify([{ repository: { nameWithOwner: 'a/one', url: 'https://github.com/a/one' } }, { repository: { nameWithOwner: 'z/skill', url: 'https://github.com/z/skill' } }]), stderr: '' };
    const target = args[1] ?? '';
    if (args.includes('search/issues')) return { code: 0, stdout: '12\n', stderr: '' };
    if (/\/license$/.test(target)) return target.includes('d/nolic') ? { code: 1, stdout: '', stderr: 'HTTP 404' } : { code: 0, stdout: JSON.stringify({ license: { spdx_id: 'MIT' } }), stderr: '' };
    if (/\/git\/trees\//.test(target)) return { code: 0, stdout: treeOf(target.includes('b/two') ? ['SKILL.md', 'README.md'] : ['src/a.js', 'tests/a.test.js']), stderr: '' };
    if (/\/readme$/.test(target)) return { code: 0, stdout: '# Title\n\nA   tool that does the thing.\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ pushed_at: '2026-10-01T00:00:00Z', stargazers_count: 40, open_issues_count: 3, default_branch: 'main', topics: ['x'], homepage: '' }), stderr: '' };
  };
}

test('scan searches every query kind, merges, vets the top repos and reports what was not verified', async () => {
  const log = [];
  const r = await scan({ queries: ['idea finder', 'broken'], readmeQueries: ['niche need'], codeQueries: ['idea'], vet: 2, minStars: 3 }, { gh: fakeGh(log), now: NOW });
  assert.equal(r.attempted, 4);
  assert.equal(r.failed, 1);
  assert.match(r.errors[0], /broken/);
  assert.equal(r.dropped.forks, 1);
  assert.equal(r.vetted.length, 2);
  assert.equal(r.shortlist[0].fullName, 'a/one');
  const v = r.vetted[0].vetting;
  assert.equal(v.license, 'MIT');
  assert.equal(v.closedIssues, 12);
  assert.equal(v.hasTests, true);
  assert.equal(v.readmeStart, '# Title A tool that does the thing.');
  assert.deepEqual(v.flags, []);
  assert.ok(r.vetted[1].vetting.flags.some((f) => /prompt-only/.test(f)));
  assert.ok(log.some((l) => l.includes('--match readme')));
  assert.ok(log.some((l) => l.includes('SKILL.md')));
  assert.ok(r.notVerified.some((n) => /security scan/i.test(n)));
});

test('scan with --vet 0 skips vetting, and a missing gh stops cleanly', async () => {
  const log = [];
  const r = await scan({ queries: ['idea finder'], vet: 0 }, { gh: fakeGh(log), now: NOW });
  assert.equal(r.vetted.length, 0);
  assert.ok(log.every((l) => l.startsWith('search')));
  const missing = await scan({ queries: ['x'] }, { gh: async () => ({ code: 127, stdout: '', stderr: '' }) });
  assert.equal(missing.missingGh, true);
});

async function capture(fn) {
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try { return { code: await fn(), out }; } finally { process.stdout.write = w; }
}

test('main prints JSON with --json, exits 2 without a query and 1 when every search fails', async () => {
  const { code, out } = await capture(() => main(['idea finder', '--json', '--vet', '1'], { gh: fakeGh(), now: NOW }));
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.vetted.length, 1);
  await assert.rejects(main([], { gh: fakeGh() }), /at least one short query/);
  await assert.rejects(main(['x', '--vet', 'lots'], { gh: fakeGh() }), /whole number/);
  await assert.rejects(main(['x', '--limit', '500'], { gh: fakeGh() }), /0 to 100/);
  const bad = await capture(() => main(['broken', '--json'], { gh: fakeGh() }));
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out).ok, false);
});

test('main in plain mode warns about a long query and shows flags', async () => {
  const { code, out } = await capture(() => main(['a very long natural language query here', '--vet', '0'], { gh: fakeGh(), now: NOW }));
  assert.equal(code, 0);
  assert.match(out, /is long/);
  assert.match(out, /no licence/);
  assert.match(out, /Not verified: No security scan/);
  const help = await capture(() => main(['--help']));
  assert.match(help.out, /Usage:/);
});

test('the skill is wired into new-app, new-skill, the alternatives list and the README', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const skill = read('skills/prior-art/SKILL.md');
  assert.match(skill, /scripts\/prior-art\.mjs/);
  assert.match(skill, /No security scan/);
  assert.match(skill, /Adopt, Extend, Compose or Build/);
  for (const p of ['skills/new-app/SKILL.md', 'skills/new-skill/SKILL.md', 'skills/new-skill/references/build-or-extend.md', 'skills/new-skill/references/external-skills.md', 'README.md']) assert.match(read(p), /prior-art/, p);
  assert.match(read('skills/new-skill/references/external-skills.md'), /Emanuelel\/dont-reinvent/);
});

test('main accepts repeated --readme and --code flags from the command line', async () => {
  const { code, out } = await capture(() => main(['--readme', 'idea finder', '--code', 'idea finder', '--json', '--vet', '0'], { gh: fakeGh(), now: NOW }));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).ok, true);
});
