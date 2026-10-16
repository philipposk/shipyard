import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { addShell, nextSteps, appHosts, loadVersions } from '../scripts/shells/add-core.mjs';
import { readFacts, pickLiveUrl, readColors, brightness, googleEnabled } from '../scripts/shells/facts.mjs';
import { main as addShellMain } from '../scripts/add-shell.mjs';
import { ROOT, makeShellApp, fakeProfile, FAKE_URL } from './shells-helpers.mjs';

const read = (dir, rel) => readFile(path.join(dir, ...rel.split('/')), 'utf8');
const readJson = async (dir, rel) => JSON.parse(await read(dir, rel));
const exists = (dir, rel) => readFile(path.join(dir, ...rel.split('/'))).then(() => true, () => false);

async function make(t, opts) {
  const app = await makeShellApp(opts);
  t.after(() => rm(app.parent, { recursive: true, force: true }));
  return app;
}

const MOBILE_FILES = [
  'mobile/capacitor.config.json', 'mobile/package.json', 'mobile/.gitignore', 'mobile/native-config.json', 'mobile/www/index.html',
  'mobile/resources/PrivacyInfo.xcprivacy', 'mobile/STORE.md', 'mobile/README.md',
  'mobile/scripts/apply-native-config.mjs', 'mobile/scripts/generate-icons.mjs', 'mobile/scripts/native-edit.mjs', 'mobile/scripts/png.mjs',
];
const GOOGLE_FILES = ['src/lib/native-auth.ts', 'src/components/NativeAuthReturn.tsx'];

// ---------------------------------------------------------------- mobile generation

test('mobile: writes the whole phone folder, every JSON file is valid, and nothing else in the app is touched except the two ignore lists', async (t) => {
  const app = await make(t);
  const prof = fakeProfile();
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: prof });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.created].sort(), [...MOBILE_FILES].sort());
  assert.deepEqual(r.patched.sort(), ['eslint.config.mjs', 'tsconfig.json']);
  for (const rel of MOBILE_FILES) assert.ok(await exists(app.dir, rel), rel);
  for (const rel of GOOGLE_FILES) assert.ok(!(await exists(app.dir, rel)), `${rel} only with Google sign-in`);

  const cap = await readJson(app.dir, 'mobile/capacitor.config.json');
  assert.equal(cap.appId, 'io.github.sambaker.bakerynotes');
  assert.equal(cap.appName, 'Bakery Notes');
  assert.equal(cap.server.url, FAKE_URL);
  assert.equal(cap.server.cleartext, false);
  assert.equal(cap.server.errorPath, 'index.html');
  assert.deepEqual(cap.server.allowNavigation, ['bakery-notes.example.net']);
  const versions = await loadVersions();
  const pkg = await readJson(app.dir, 'mobile/package.json');
  assert.equal(pkg.name, 'bakery-notes-mobile');
  assert.equal(pkg.dependencies['@capacitor/core'], versions.capacitor['@capacitor/core']);
  assert.equal(pkg.devDependencies['@capacitor/cli'], versions.capacitor['@capacitor/cli']);
  for (const v of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) assert.match(v, /^\d+\.\d+\.\d+$/, 'exact versions only');
  const native = await readJson(app.dir, 'mobile/native-config.json');
  assert.deepEqual([native.permissions, native.authReturn], [{}, false]);
  assert.match(await read(app.dir, 'mobile/resources/PrivacyInfo.xcprivacy'), /NSPrivacyAccessedAPITypes/);
  assert.match(await read(app.dir, 'mobile/www/index.html'), /id="retry"/);
  const store = await read(app.dir, 'mobile/STORE.md');
  assert.match(store, /Bakery Notes/);
  assert.match(store, new RegExp(`${FAKE_URL}/privacy`));
  assert.match(await read(app.dir, 'eslint.config.mjs'), /"mobile\/\*\*"/);
  assert.match(await read(app.dir, 'tsconfig.json'), /"mobile"/);
  // Saved for later runs and for the settings page.
  const saved = await readJson(app.dir, '.shipyard-app.json');
  assert.equal(saved.shells.mobile.appId, 'io.github.sambaker.bakerynotes');
  assert.deepEqual(prof.state.upserts.at(-1), { slug: 'bakery-notes', shells: ['mobile'] });
});

test('mobile: the package.json of the web app is left alone unless Google sign-in needs the Capacitor packages', async (t) => {
  const app = await make(t);
  const before = await read(app.dir, 'package.json');
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.equal(r.needsInstall, false);
  assert.equal(await read(app.dir, 'package.json'), before);
});

test('mobile: Google sign-in adds the return files, mounts the component, adds the packages, and registers the return address (add-only)', async (t) => {
  const app = await make(t, { google: true, config: { supabaseRef: 'abcdefghijklmnopqrst' } });
  const calls = [];
  const state = { uri_allow_list: 'https://bakery-notes.example.net/**' };
  const fetch = async (url, init = {}) => {
    calls.push({ method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'PATCH') Object.assign(state, JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(state), headers: new Map() };
  };
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile(), fetch, getSecret: async () => `sbp_${'x'.repeat(30)}` });
  for (const rel of GOOGLE_FILES) assert.ok(r.created.includes(rel), rel);
  assert.ok(r.needsInstall);
  assert.match(await read(app.dir, 'src/lib/native-auth.ts'), /io\.github\.sambaker\.bakerynotes:\/\/auth\/callback/);
  assert.ok(!(await read(app.dir, 'src/lib/native-auth.ts')).includes('__APP_ID__'));
  assert.match(await read(app.dir, 'src/app/layout.tsx'), /<NativeAuthReturn \/>/);
  assert.match(await read(app.dir, 'src/components/GoogleSignInButton.tsx'), /signInGoogleNative/);
  const pkg = await readJson(app.dir, 'package.json');
  for (const n of ['@capacitor/app', '@capacitor/browser', '@capacitor/core']) assert.ok(pkg.dependencies[n], n);
  assert.equal((await readJson(app.dir, 'mobile/native-config.json')).authReturn, true);
  assert.equal(r.supabase.status, 'added');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.body.uri_allow_list.includes('https://bakery-notes.example.net/**'), 'the old address stays');
  assert.ok(patch.body.uri_allow_list.includes('io.github.sambaker.bakerynotes://auth/callback'));
  // Running it again changes nothing in the app files (the patches are already in).
  const again = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile(), fetch, getSecret: async () => `sbp_${'x'.repeat(30)}` });
  assert.deepEqual([again.created, again.updated, again.patched], [[], [], []]);
  assert.equal(again.supabase.status, 'present');
});

test('mobile: --no-google keeps the Google files out even when the app has Google sign-in', async (t) => {
  const app = await make(t, { google: true });
  const r = await addShell({ appDir: app.dir, kind: 'mobile', google: false }, { profile: fakeProfile() });
  assert.equal(r.google, false);
  for (const rel of GOOGLE_FILES) assert.ok(!(await exists(app.dir, rel)), rel);
});

test('mobile: when Supabase can not be reached the student gets the exact manual step, and --skip-supabase skips the call', async (t) => {
  const app = await make(t, { google: true, config: { supabaseRef: 'abcdefghijklmnopqrst' } });
  const fetch = async () => { throw new Error('offline'); };
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile(), fetch, getSecret: async () => `sbp_${'x'.repeat(30)}` });
  assert.equal(r.supabase.status, 'failed');
  assert.ok(r.manual.some((m) => m.includes('io.github.sambaker.bakerynotes://auth/callback')));
  const other = await make(t, { google: true, config: { supabaseRef: 'abcdefghijklmnopqrst' } });
  const skipped = await addShell({ appDir: other.dir, kind: 'mobile', skipSupabase: true }, { profile: fakeProfile(), fetch });
  assert.equal(skipped.supabase, null);
});

// ---------------------------------------------------------------- refusals

test('mobile: refuses without a live https address, with a plain "deploy first"', async (t) => {
  for (const url of ['', 'http://bakery-notes.example.net', 'https://localhost:3000', 'http://127.0.0.1:3000']) {
    const app = await make(t, { url, config: { url, siteUrl: url } });
    await assert.rejects(() => addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() }), (e) => e.data?.reason === 'not-live' && /deploy first/.test(e.message), JSON.stringify(url));
    assert.ok(!(await exists(app.dir, 'mobile')), 'nothing was written');
  }
  const desktop = await make(t, { url: '', config: { url: '', siteUrl: '' } });
  await assert.rejects(() => addShell({ appDir: desktop.dir, kind: 'desktop' }, { profile: fakeProfile() }), /no live web address/);
});

test('add-shell: only mobile or desktop', async (t) => {
  const app = await make(t);
  await assert.rejects(() => addShell({ appDir: app.dir, kind: 'watch' }, { profile: fakeProfile() }), /mobile|desktop/);
  await assert.rejects(() => addShellMain({ _: [app.dir, 'watch'] }), /not a kind of app/);
  await assert.rejects(() => addShellMain({ _: [app.dir] }), /Give the app folder and the kind/);
  await assert.rejects(() => addShellMain({ _: [app.dir, 'mobile'], google: true, 'no-google': true }), /either --google or --no-google/);
});

// ---------------------------------------------------------------- app id rules in the real flow

test('app id: a custom domain reversed is preferred over the GitHub name', async (t) => {
  const app = await make(t, { config: { customDomainUrl: 'https://bakery.example.gr', url: 'https://bakery-notes.vercel.app', siteUrl: 'https://bakery.example.gr' } });
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.deepEqual([r.appId, r.appIdSource, r.url], ['gr.example.bakery', 'domain', 'https://bakery.example.gr']);
  const cap = await readJson(app.dir, 'mobile/capacitor.config.json');
  assert.deepEqual(cap.server.allowNavigation, ['bakery.example.gr'], 'a sub-address gets no www twin');
  const apex = await make(t, { config: { customDomainUrl: 'https://bakery.gr', url: 'https://bakery-notes.vercel.app', siteUrl: 'https://bakery.gr' } });
  await addShell({ appDir: apex.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.deepEqual((await readJson(apex.dir, 'mobile/capacitor.config.json')).server.allowNavigation, ['bakery.gr', 'www.bakery.gr']);
});

test('app id: --app-id is used, and sample, reserved or underscore ids are refused before anything is written', async (t) => {
  const app = await make(t);
  const good = await addShell({ appDir: app.dir, kind: 'mobile', appId: 'gr.me.bakery', dryRun: true }, { profile: fakeProfile() });
  assert.deepEqual([good.appId, good.appIdSource], ['gr.me.bakery', 'chosen']);
  for (const bad of ['com.example.bakery', 'com.me.new', 'com.me.bakery_notes', 'bakery', 'com.me.app']) {
    await assert.rejects(() => addShell({ appDir: app.dir, kind: 'mobile', appId: bad }, { profile: fakeProfile() }), (e) => e.data?.reason === 'app-id', bad);
  }
  assert.ok(!(await exists(app.dir, 'mobile')));
});

test('app id: without a custom domain or a GitHub name it asks for --app-id instead of guessing', async (t) => {
  const app = await make(t);
  const noGithub = { ...fakeProfile(), loadProfile: async () => ({ owner: {}, accounts: {}, apps: [] }) };
  await assert.rejects(() => addShell({ appDir: app.dir, kind: 'mobile' }, { profile: noGithub }), /--app-id/);
});

test('app id: once saved it never changes; asking for another one is refused, the same one is fine', async (t) => {
  const app = await make(t);
  await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  await assert.rejects(() => addShell({ appDir: app.dir, kind: 'mobile', appId: 'gr.me.other' }, { profile: fakeProfile() }), (e) => e.data.reason === 'app-id-set' && /io\.github\.sambaker\.bakerynotes/.test(e.message));
  const same = await addShell({ appDir: app.dir, kind: 'mobile', appId: 'io.github.sambaker.bakerynotes' }, { profile: fakeProfile() });
  assert.equal(same.appId, 'io.github.sambaker.bakerynotes');
  // A new GitHub name later does not move it either.
  const renamed = { ...fakeProfile(), loadProfile: async () => ({ owner: {}, accounts: { github: { user: 'someone-else' } }, apps: [] }) };
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: renamed });
  assert.deepEqual([r.appId, r.appIdSource], ['io.github.sambaker.bakerynotes', 'saved']);
  assert.equal((await readJson(app.dir, 'mobile/capacitor.config.json')).appId, 'io.github.sambaker.bakerynotes');
});

// ---------------------------------------------------------------- re-runs and files the student changed

test('re-running changes nothing; a file the student edited is kept, and --force-file replaces just that one', async (t) => {
  const app = await make(t);
  await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  const again = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.deepEqual([again.created, again.updated, again.kept, again.patched], [[], [], [], []]);
  assert.equal(again.same.length, MOBILE_FILES.length);

  const storePath = path.join(app.dir, 'mobile', 'STORE.md');
  const mine = `${await readFile(storePath, 'utf8')}\nMy own note.\n`;
  await writeFile(storePath, mine);
  await writeFile(path.join(app.dir, 'mobile', 'README.md'), 'my readme');
  const kept = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.deepEqual(kept.kept.sort(), ['mobile/README.md', 'mobile/STORE.md']);
  assert.equal(await readFile(storePath, 'utf8'), mine);
  const forced = await addShell({ appDir: app.dir, kind: 'mobile', forceFiles: ['mobile/STORE.md'] }, { profile: fakeProfile() });
  assert.deepEqual(forced.updated, ['mobile/STORE.md']);
  assert.deepEqual(forced.kept, ['mobile/README.md']);
  assert.ok(!(await readFile(storePath, 'utf8')).includes('My own note.'));
  assert.equal(await read(app.dir, 'mobile/README.md'), 'my readme');
});

test('re-running: the helper scripts and the offline page are always brought up to date; capacitor.config.json keeps the student\'s extra settings', async (t) => {
  const app = await make(t);
  await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  await writeFile(path.join(app.dir, 'mobile', 'scripts', 'png.mjs'), '// old');
  const capPath = path.join(app.dir, 'mobile', 'capacitor.config.json');
  const cap = JSON.parse(await readFile(capPath, 'utf8'));
  cap.plugins.Keyboard = { resize: 'body' };
  cap.server.allowNavigation.push('auth.partner.example');
  await writeFile(capPath, JSON.stringify(cap));
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.ok(r.updated.includes('mobile/scripts/png.mjs'));
  assert.ok((await read(app.dir, 'mobile/scripts/png.mjs')).length > 100);
  const merged = await readJson(app.dir, 'mobile/capacitor.config.json');
  assert.deepEqual(merged.plugins.Keyboard, { resize: 'body' }, 'the student\'s own setting survives');
  assert.ok(merged.server.allowNavigation.includes('auth.partner.example'));
  assert.equal(merged.server.url, FAKE_URL);
});

test('re-running after the site moves to a new address updates the phone app\'s address', async (t) => {
  const app = await make(t);
  await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  const file = path.join(app.dir, '.shipyard-app.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.customDomainUrl = 'https://bakery.example.gr';
  await writeFile(file, JSON.stringify(config));
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.equal(r.appId, 'io.github.sambaker.bakerynotes', 'the id stays');
  const cap = await readJson(app.dir, 'mobile/capacitor.config.json');
  assert.equal(cap.server.url, 'https://bakery.example.gr');
  assert.ok(cap.server.allowNavigation.includes('bakery-notes.example.net') && cap.server.allowNavigation.includes('bakery.example.gr'));
});

test('a file that is not valid JSON is kept, not overwritten', async (t) => {
  const app = await make(t);
  await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  await writeFile(path.join(app.dir, 'mobile', 'capacitor.config.json'), '{ not json');
  const r = await addShell({ appDir: app.dir, kind: 'mobile' }, { profile: fakeProfile() });
  assert.ok(r.kept.includes('mobile/capacitor.config.json'));
  assert.equal(await read(app.dir, 'mobile/capacitor.config.json'), '{ not json');
});

test('--dry-run lists the plan and writes nothing, not even the saved app id', async (t) => {
  const app = await make(t, { google: true });
  const before = await read(app.dir, '.shipyard-app.json');
  const r = await addShell({ appDir: app.dir, kind: 'mobile', dryRun: true }, { profile: fakeProfile() });
  assert.equal(r.dryRun, true);
  assert.ok(r.created.length > 5);
  assert.ok(!(await exists(app.dir, 'mobile')));
  assert.ok(!(await exists(app.dir, 'src/lib/native-auth.ts')));
  assert.equal(await read(app.dir, '.shipyard-app.json'), before);
});

test('if the lint or tsconfig spot can not be found, the student is told what to add by hand instead of a broken edit', async (t) => {
  const app = await make(t, { google: true });
  await writeFile(path.join(app.dir, 'src', 'app', 'layout.tsx'), 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
  const r = await addShell({ appDir: app.dir, kind: 'mobile', skipSupabase: true }, { profile: fakeProfile() });
  assert.ok(r.manual.some((m) => /NativeAuthReturn/.test(m)), JSON.stringify(r.manual));
});

// ---------------------------------------------------------------- desktop

test('desktop: writes the window, installer settings and the release workflow, and reuses the saved app id', async (t) => {
  const app = await make(t, { config: { shells: { mobile: { appId: 'gr.me.bakery' } } } });
  const r = await addShell({ appDir: app.dir, kind: 'desktop' }, { profile: fakeProfile() });
  assert.deepEqual([r.appId, r.appIdSource], ['gr.me.bakery', 'saved']);
  for (const rel of ['desktop/main.js', 'desktop/preload.js', 'desktop/app.json', 'desktop/package.json', 'desktop/offline.html', 'desktop/.gitignore', 'desktop/README.md', '.github/workflows/desktop-release.yml', 'desktop/build/icon.png']) {
    assert.ok(r.created.includes(rel), rel);
  }
  const appJson = await readJson(app.dir, 'desktop/app.json');
  assert.deepEqual([appJson.url, appJson.appId, appJson.name], [FAKE_URL, 'gr.me.bakery', 'Bakery Notes']);
  assert.deepEqual(appJson.hosts, ['bakery-notes.example.net']);
  const pkg = await readJson(app.dir, 'desktop/package.json');
  const versions = await loadVersions();
  assert.equal(pkg.build.appId, 'gr.me.bakery');
  assert.equal(pkg.build.productName, 'Bakery Notes');
  assert.deepEqual(pkg.devDependencies, { electron: versions.desktop.electron, 'electron-builder': versions.desktop['electron-builder'] });
  assert.equal(pkg.author, 'Sam Baker');
  assert.equal(await read(app.dir, 'desktop/main.js'), await readFile(path.join(ROOT, 'shells', 'desktop', 'main.js'), 'utf8'));
  assert.match(await read(app.dir, '.github/workflows/desktop-release.yml'), /desktop-v\*/);
  assert.match(await read(app.dir, 'eslint.config.mjs'), /"desktop\/\*\*"/);
  assert.equal((await readJson(app.dir, '.shipyard-app.json')).shells.desktop.appId, 'gr.me.bakery');
});

test('desktop: with no app icon the student is told, and the window still works', async (t) => {
  const app = await make(t);
  await rm(path.join(app.dir, 'public', 'icon-512.png'));
  const r = await addShell({ appDir: app.dir, kind: 'desktop' }, { profile: fakeProfile() });
  assert.ok(r.warnings.some((w) => /icon-512\.png is missing/.test(w)));
  assert.ok(!(await exists(app.dir, 'desktop/build/icon.png')));
});

test('the next steps are different for phone and desktop and always end with store-check', () => {
  const mobile = nextSteps({ kind: 'mobile', needsInstall: true });
  assert.match(mobile[0], /npm install" in the app folder/);
  assert.match(mobile.join('\n'), /npm run add:ios/);
  const desktop = nextSteps({ kind: 'desktop' });
  assert.match(desktop.join('\n'), /desktop-v1\.0\.0/);
  for (const steps of [mobile, desktop]) assert.match(steps.at(-1), /store-check\.mjs/);
});

// ---------------------------------------------------------------- facts

test('facts: only a live https address that is not local counts; colours and Google are read safely', async (t) => {
  assert.equal(pickLiveUrl([null, 'http://a.example', 'https://localhost:3000', 'not a url', 'https://b.example/path']), 'https://b.example');
  assert.equal(pickLiveUrl([]), '');
  assert.deepEqual(appHosts('example.com'), ['example.com', 'www.example.com']);
  assert.deepEqual(appHosts('www.example.com'), ['www.example.com', 'example.com']);
  assert.deepEqual(appHosts('app.example.com'), ['app.example.com']);
  assert.ok(brightness('#ffffff') > 0.999);
  assert.equal(brightness('#000000'), 0);
  assert.equal(brightness('not a colour'), 1);
  const colors = readColors('/* shipyard:tokens:light:start */ --background: red; --accent: #112233; /* shipyard:tokens:light:end */');
  assert.equal(colors.light.background, '#f6f7f9', 'a colour name falls back to the starter value');
  assert.equal(colors.light.accent, '#112233');
  const app = await make(t, { google: true });
  const facts = await readFacts(app.dir, { profile: fakeProfile() });
  assert.deepEqual([facts.name, facts.url, facts.host, facts.google], ['Bakery Notes', FAKE_URL, 'bakery-notes.example.net', true]);
  assert.equal(await googleEnabled(app.dir, { googleSignin: true }), true);
  const plain = await make(t);
  assert.equal(await googleEnabled(plain.dir, {}), false);
});
