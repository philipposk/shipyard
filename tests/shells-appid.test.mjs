import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAppId, deriveAppId, cleanPart, reverseHost, APP_ID_RE } from '../scripts/shells/appid.mjs';

test('app id: good ids pass', () => {
  for (const id of ['io.github.sambaker.bakerynotes', 'app.bakerynotes.recipes', 'gr.mydomain.vocab', 'com.acme.tea2go']) {
    assert.deepEqual(validateAppId(id), { ok: true }, id);
  }
});

test('app id: the shape rules (underscores are refused on purpose: Apple bundle ids and web address schemes do not allow them)', () => {
  for (const bad of ['', 'recipes', 'com', 'Com.Acme.Tea', 'com.acme.tea-shop', 'com.acme.tea_shop', 'com.acme.2go', 'com..acme', '.com.acme', 'com.acme.', 'com.acme tea.x']) {
    const r = validateAppId(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.reason.length > 20);
  }
  assert.equal(APP_ID_RE.test('com.acme.tea_shop'), false);
  assert.match(validateAppId('com.acme.tea_shop').reason, /no dashes or underscores/);
});

test('app id: Java reserved words are refused in any part', () => {
  const r = validateAppId('com.acme.new');
  assert.equal(r.ok, false);
  assert.match(r.reason, /"new" cannot be a part/);
  assert.equal(validateAppId('com.class.tea').ok, false);
  assert.equal(validateAppId('com.acme.newsletter').ok, true, 'only whole words are reserved');
});

test('app id: sample ids and generic endings are refused', () => {
  for (const bad of ['com.example.recipes', 'com.example', 'io.ionic.starter', 'com.getcapacitor.app', 'com.yourcompany.notes', 'org.example.x', 'com.acme.app', 'com.acme.test', 'com.acme.demo']) {
    assert.equal(validateAppId(bad).ok, false, bad);
  }
  assert.match(validateAppId('com.example.recipes').reason, /sample id/);
  assert.match(validateAppId('com.acme.app').reason, /generic word/);
  assert.equal(validateAppId('com.examples.recipes').ok, true, 'a prefix is matched by whole parts');
});

test('app id: a very long id is refused', () => {
  assert.match(validateAppId(`com.acme.${'a'.repeat(100)}`).reason, /too long/);
});

test('cleanPart and reverseHost: lowercase letters and digits, never a digit first, never a reserved word', () => {
  assert.equal(cleanPart('Bakery-Notes!'), 'bakerynotes');
  assert.equal(cleanPart('2go'), 'n2go');
  assert.equal(cleanPart('new'), 'newapp');
  assert.equal(cleanPart('---'), '');
  assert.equal(reverseHost('recipes.bakery-notes.app'), 'app.bakerynotes.recipes');
  assert.equal(reverseHost('Example.Co.UK'), 'uk.co.example');
  assert.equal(reverseHost('localhost'), '');
  assert.equal(reverseHost('bad_host.example.com'), '');
});

test('deriveAppId: --app-id wins, and a bad one is explained', () => {
  assert.deepEqual(deriveAppId({ explicit: 'gr.me.vocab', hosts: ['tea.example'], githubUser: 'sam', slug: 'x' }), { appId: 'gr.me.vocab', source: 'chosen' });
  assert.match(deriveAppId({ explicit: 'com.example.vocab' }).error, /sample id/);
});

test('deriveAppId: the custom domain reversed comes next, skipping vercel.app and localhost', () => {
  assert.deepEqual(deriveAppId({ hosts: ['bakery-notes.vercel.app', 'vocab.example.gr'], githubUser: 'sam', slug: 'vocab' }), { appId: 'gr.example.vocab', source: 'domain' });
  assert.deepEqual(deriveAppId({ hosts: ['localhost', '127.0.0.1', '', null, 'learn.tea.example'], slug: 'x' }), { appId: 'example.tea.learn', source: 'domain' });
});

test('deriveAppId: with no own domain it falls back to io.github.<user>.<slug>', () => {
  assert.deepEqual(deriveAppId({ hosts: ['bakery-notes.vercel.app'], githubUser: 'Sam-Baker', slug: 'bakery-notes' }), { appId: 'io.github.sambaker.bakerynotes', source: 'github' });
  assert.deepEqual(deriveAppId({ hosts: [], githubUser: 'sam', slug: '2048' }), { appId: 'io.github.sam.n2048', source: 'github' });
});

test('deriveAppId: a domain that gives a sample or generic id is skipped; with nothing to go on it asks for --app-id', () => {
  // my.app.example.com reversed is com.example.app.my: it starts with the sample prefix com.example, so it is not used.
  assert.deepEqual(deriveAppId({ hosts: ['my.app.example.com'], githubUser: 'sam', slug: 'tea' }), { appId: 'io.github.sam.tea', source: 'github' });
  assert.match(deriveAppId({ hosts: ['example.com'], githubUser: '', slug: 'tea' }).error, /--app-id/);
  assert.match(deriveAppId({ hosts: ['x.vercel.app'], githubUser: '', slug: '' }).error, /--app-id/);
});
