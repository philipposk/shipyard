import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateLegal } from '../scripts/launch/legal-run.mjs';
import { parseLegalFile, lintLegalContent } from '../scripts/launch/legal-core.mjs';
import { loadServices } from '../scripts/launch/common.mjs';
import { tempApp, readConfig, fakeProfile } from './launch-helpers.mjs';

const LEGAL = 'src/lib/legal-content.ts';
const readSource = async () => new Set();
const read = async (dir) => readFile(path.join(dir, LEGAL), 'utf8');
const sectionText = (sections, id) => {
  const s = sections.find((x) => x.id === id);
  assert.ok(s, `section ${id} exists`);
  return [...s.paragraphs, ...(s.table ? s.table.rows.flat() : [])].join('\n');
};
// Array.from: the parsed file comes from another JavaScript realm, so copy it before comparing.
const ids = (sections) => Array.from(sections, (s) => s.id);

async function make(t, config, profile, opts = {}) {
  const app = await tempApp(config, opts);
  t.after(app.cleanup);
  const prof = fakeProfile(profile);
  const run = (more = {}) => generateLegal({ appDir: app.dir, today: '2027-01-01', ...more }, { profile: prof, readSource });
  return { app, prof, run };
}

// ---------------------------------------------------------------- three profiles

test('profile 1, no billing: the basic pages, with no subscription text and only essential cookies', async (t) => {
  const { app, run } = await make(t, { modules: [] }, {}, { withPlans: false });
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.withdrawalText, false);
  const c = parseLegalFile(await read(app.dir));
  assert.deepEqual(ids(c.privacy), ['who-we-are', 'what-we-collect', 'why-we-use-it', 'who-processes-your-data', 'moving-data-abroad', 'how-long-we-keep-it', 'your-rights', 'cookies', 'keeping-your-data-safe', 'children', 'changes', 'contact']);
  assert.deepEqual(ids(c.terms), ['the-service', 'your-account', 'fair-use', 'your-content', 'availability', 'liability', 'governing-law', 'changes-to-terms', 'contact-us']);
  assert.equal(c.controller.name, 'Tea Ltd');
  assert.equal(c.controller.email, 'hi@tea.example');
  const rows = c.privacy.find((s) => s.id === 'who-processes-your-data').table.rows.map((row) => row[0]);
  assert.deepEqual(Array.from(rows), ['Supabase', 'Vercel']);
  assert.match(sectionText(c.privacy, 'cookies'), /essential|necessary/i);
  assert.doesNotMatch(sectionText(c.privacy, 'cookies'), /analytics/i);
  assert.match(sectionText(c.privacy, 'how-long-we-keep-it'), /90 days/);
  assert.match(sectionText(c.privacy, 'children'), /16/);
  assert.match(sectionText(c.privacy, 'your-rights'), /europa\.eu/);
  assert.equal(lintLegalContent(c).length, 0);
  assert.ok(!ids(c.terms).includes('right-to-withdraw'));
});

test('profile 2, billing + newsletter + OpenAI: payments, withdrawal, email list and the AI service all appear', async (t) => {
  const { app, run } = await make(t, { modules: ['billing', 'newsletter'], env: ['NEXT_PUBLIC_SITE_URL', 'OPENAI_API_KEY'] });
  const r = await run();
  assert.equal(r.withdrawalText, true);
  assert.deepEqual(r.services.map((s) => s.id), ['supabase', 'vercel', 'resend', 'stripe', 'openai']);
  const c = parseLegalFile(await read(app.dir));
  assert.deepEqual(ids(c.terms), ['the-service', 'your-account', 'fair-use', 'your-content', 'ai-features', 'subscriptions-and-payments', 'right-to-withdraw', 'free-plan', 'availability', 'liability', 'governing-law', 'changes-to-terms', 'contact-us']);
  assert.ok(ids(c.privacy).includes('email-updates'));
  assert.match(sectionText(c.terms, 'subscriptions-and-payments'), /9\.00|9,00|€9/);
  assert.match(sectionText(c.terms, 'subscriptions-and-payments'), /cancel/i);
  assert.match(sectionText(c.terms, 'right-to-withdraw'), /14 days/);
  assert.match(sectionText(c.terms, 'right-to-withdraw'), /refund/i);
  assert.match(sectionText(c.privacy, 'what-we-collect'), /Stripe/);
  const names = c.privacy.find((s) => s.id === 'who-processes-your-data').table.rows.map((row) => row[0]);
  assert.deepEqual(Array.from(names), ['Supabase', 'Vercel', 'Resend', 'Stripe', 'OpenAI']);
  assert.match(sectionText(c.terms, 'ai-features'), /OpenAI|AI/);
  assert.equal(c.controller.phone, '+30 210 0000000');
});

test('profile 3, company details missing: it stops, writes nothing, and names each value with the command to set it', async (t) => {
  const { app, run } = await make(t, { modules: ['billing'] }, { company: {}, owner: {} });
  await assert.rejects(run, (e) => {
    assert.equal(e.data.reason, 'missing-facts');
    assert.deepEqual(e.data.needs.map((n) => n.path), ['company.legalName', 'company.address', 'company.contactEmail', 'company.phone', 'owner.country']);
    for (const n of e.data.needs) assert.match(n.command, /profile\.mjs" set /);
    for (const p of ['company.legalName', 'company.address', 'company.contactEmail']) assert.match(e.message, new RegExp(p.replace('.', '\\.')));
    return true;
  });
  await assert.rejects(() => readFile(path.join(app.dir, LEGAL), 'utf8'), { code: 'ENOENT' });
});

test('a phone number is only asked for when payments are on', async (t) => {
  const { run } = await make(t, { modules: [] }, { company: { legalName: 'Tea Ltd', address: '1 Tea St', contactEmail: 'hi@tea.example' } }, { withPlans: false });
  assert.equal((await run()).ok, true);
});

// ---------------------------------------------------------------- repeatable

test('running it again with the same input changes nothing, and the date stays', async (t) => {
  const { app, run } = await make(t, { modules: ['billing'] });
  const first = await run();
  assert.equal(first.changed, true);
  const text = await read(app.dir);
  const second = await run({ today: '2028-05-05' });
  assert.equal(second.changed, false);
  assert.equal(second.updatedAt, '2027-01-01');
  assert.equal(await read(app.dir), text);
});

test('changed words get a new date; a dry run writes nothing', async (t) => {
  const { app, prof, run } = await make(t, { modules: [] }, {}, { withPlans: false });
  await run();
  prof.profile.company.address = '2 New Road, Athens';
  const dry = await run({ today: '2028-05-05', dryRun: true });
  assert.equal(dry.changed, true);
  assert.match(await read(app.dir), /1 Tea St/, 'dry run wrote nothing');
  const real = await run({ today: '2028-05-05' });
  assert.equal(real.updatedAt, '2028-05-05');
  assert.match(await read(app.dir), /2 New Road/);
});

test('--also adds a service and --without leaves one out; unknown names are refused', async (t) => {
  const { app, run } = await make(t, { modules: [] }, {}, { withPlans: false });
  const r = await run({ also: ['posthog'], without: ['vercel'] });
  assert.deepEqual(r.services.map((s) => s.id), ['supabase', 'posthog']);
  const c = parseLegalFile(await read(app.dir));
  assert.match(sectionText(c.privacy, 'cookies'), /PostHog.*only if you agree/s);
  assert.ok(r.warnings.some((w) => /analytics only runs after the visitor agrees/.test(w)));
  await assert.rejects(() => run({ also: ['nope'] }), /"nope" is not a service Shipyard knows/);
});

test('the lint step stops text that would carry a placeholder or a stray bracket from the details', async (t) => {
  const { app, run } = await make(t, { modules: [] }, { company: { legalName: 'Tea Ltd', address: '[YOUR ADDRESS]', contactEmail: 'hi@tea.example' } }, { withPlans: false });
  await assert.rejects(run, (e) => e.data?.reason === 'lint' || /problems with your details|can not|Fix/.test(e.message));
  await assert.rejects(() => readFile(path.join(app.dir, LEGAL), 'utf8'), { code: 'ENOENT' });
});

test('the launch record is saved for the settings page, and the result says it is a draft', async (t) => {
  const { app, prof, run } = await make(t, { modules: ['billing'] });
  const r = await run();
  assert.match(r.reminder, /draft, not legal advice/);
  const cfg = await readConfig(app.dir);
  assert.equal(cfg.launch.legal.generatedAt, '2027-01-01');
  assert.equal(prof.profile.apps.find((a) => a.slug === 'tea-shop').launch.legalAt, '2027-01-01');
  assert.equal(r.readback.length, 5);
});

// ---------------------------------------------------------------- services.json

test('services.json: every service has the fields the privacy policy needs, and the ten expected ones exist', async () => {
  const cat = await loadServices();
  assert.match(cat.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(cat.verifiedAt)));
  assert.deepEqual(cat.services.map((s) => s.id).sort(), ['google', 'openai', 'openrouter', 'posthog', 'resend', 'sentry', 'stripe', 'supabase', 'upstash', 'vercel']);
  assert.equal(new Set(cat.services.map((s) => s.id)).size, cat.services.length, 'ids are unique');
  for (const s of cat.services) {
    for (const f of ['id', 'name', 'purpose', 'dataShared', 'location', 'privacyUrl', 'role']) assert.ok(typeof s[f] === 'string' && s[f].trim(), `${s.id}.${f}`);
    assert.match(s.privacyUrl, /^https:\/\/[^\s]+$/, `${s.id}.privacyUrl`);
    assert.ok(s.dpaUrl === null || s.dpaUrl === undefined || /^https:\/\/[^\s]+$/.test(s.dpaUrl), `${s.id}.dpaUrl`);
    assert.ok(['processor', 'processor-and-controller', 'independent-controller'].includes(s.role), `${s.id}.role ${s.role}`);
    assert.equal(typeof s.transfers?.sccs, 'boolean', `${s.id}.transfers.sccs`);
    assert.equal(typeof s.transfers?.dpf, 'boolean', `${s.id}.transfers.dpf`);
    assert.ok(Array.isArray(s.detectedBy?.env) && s.detectedBy.env.every((n) => /^[A-Z][A-Z0-9_]*$/.test(n)), `${s.id}.detectedBy.env`);
    assert.ok(s.detectedBy.module === null || s.detectedBy.module === undefined || typeof s.detectedBy.module === 'string', `${s.id}.detectedBy.module`);
  }
});

test('services.json: Upstash names standard contractual clauses (its DPA does), so the policy says so', async (t) => {
  const cat = await loadServices();
  const up = cat.services.find((s) => s.id === 'upstash');
  assert.equal(up.transfers.sccs, true);
  assert.equal(up.transfers.dpf, true);
  const { app, run } = await make(t, { modules: [], env: ['UPSTASH_REDIS_REST_URL'] }, {}, { withPlans: false });
  await run();
  const c = parseLegalFile(await read(app.dir));
  const table = c.privacy.find((s) => s.id === 'moving-data-abroad').table ?? c.privacy.find((s) => s.id === 'who-processes-your-data').table;
  const row = table.rows.find((r) => r[0] === 'Upstash');
  assert.ok(row, 'Upstash is listed');
  assert.match(row.join(' | '), /standard contractual clauses and the EU-US Data Privacy Framework/);
});
