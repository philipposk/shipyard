import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('all publication entry points require the framework-independent gate before routing', () => {
  for (const name of ['new-app', 'launch', 'review']) {
    const text = read(`skills/${name}/SKILL.md`);
    assert.match(text, /^---\nname: /);
    assert.match(text, /## Mandatory publication gate \(every framework\)/);
    assert.ok(text.indexOf('publication-gate.md') < text.indexOf('## First:'), name);
    for (const required of ['Vite', 'review-only', 'PASS, FAIL, PENDING or N/A', 'real production address'])
      assert.ok(text.toLowerCase().includes(required.toLowerCase()), `${name}: ${required}`);
  }
});

test('general-app upgrade and SEO reference cannot bypass the gate', () => {
  for (const file of ['skills/new-app/references/upgrade.md', 'skills/launch/references/seo-performance.md'])
    assert.match(read(file), /publication-gate\.md/);
  assert.doesNotMatch(read('skills/launch/references/seo-performance.md'), /minus what Shipyard/);
});

test('gate defines concrete evidence, privacy boundaries and full applicable release checks', () => {
  const text = read('skills/launch/references/publication-gate.md');
  for (const term of ['PASS / FAIL / PENDING / N/A', 'false-200 SPA', 'X-Robots-Tag', '1200x630', 'hreflang', 'raw HTML', 'rate limits', 'Robots is not authentication', 'no invented ratings', 'llms.txt (optional)', 'Domain properties', 'URL Inspection', 'review-only does not authorize fixes', 'independent review', 'Lighthouse', 'cross-user isolation', 'retention', 'rollback', 'No tracking installation', 'no paid service is required'])
    assert.ok(text.includes(term), term);
  assert.match(text, /not a promise of indexing/);
  assert.match(text, /External account steps may remain PENDING/);
});


test('private and internal apps cannot skip the gate; only inapplicable discovery is N/A', () => {
  for (const name of ['new-app', 'launch', 'review']) {
    const text = read(`skills/${name}/SKILL.md`);
    assert.match(text, /reviewing any app, including private and internal apps/);
    assert.match(text, /Discovery checks apply only to public routes/);
    assert.match(text, /private apps still require.*authentication, authorization and intentional noindex/);
    assert.match(text, /N\/A with reasons/);
    assert.doesNotMatch(text, /whenever building, publishing, or reviewing an app that is public/);
  }
  const gate = read('skills/launch/references/publication-gate.md');
  assert.match(gate, /Do not expose private content/);
  assert.match(gate, /valid supported card dimensions and aspect ratio/);
  assert.match(gate, /1200x630 recommended/);
  assert.match(gate, /Always check audience\/host policy, authentication\/authorization, intentional noindex/);
  for (const path of ['skills/new-app/references/upgrade.md', 'skills/launch/references/seo-performance.md'])
    assert.match(read(path), /private[\/ ](?:and )?internal apps/);
});
