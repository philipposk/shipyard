import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { addShell } from '../scripts/shells/add-core.mjs';
import { storeCheck, parseStoreMd, section } from '../scripts/shells/store-core.mjs';
import { main as storeCheckMain } from '../scripts/store-check.mjs';
import { encodePng, solid } from '../shells/mobile/scripts/png.mjs';
import { makeShellApp, fakeProfile, FAKE_URL } from './shells-helpers.mjs';

const file = (dir, rel) => path.join(dir, ...rel.split('/'));
const read = (dir, rel) => readFile(file(dir, rel), 'utf8');
const write = async (dir, rel, text) => { await mkdir(path.dirname(file(dir, rel)), { recursive: true }); await writeFile(file(dir, rel), text); };
const edit = async (dir, rel, fn) => write(dir, rel, fn(await read(dir, rel)));
const editJson = async (dir, rel, fn) => write(dir, rel, JSON.stringify(fn(JSON.parse(await read(dir, rel))), null, 2));

const pageFetch = (bad = {}) => async (url) => {
  const p = new URL(url).pathname;
  return { status: p in bad ? bad[p] : 200 };
};
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));
const status = (r, id) => byId(r)[id]?.status;
const failing = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id).sort();

/** A phone + desktop app that should pass: the generated folders plus the pictures `npm run icons` would make. */
async function ready(t, { kinds = ['mobile', 'desktop'], app: appOpts } = {}) {
  const app = await makeShellApp(appOpts);
  t.after(() => rm(app.parent, { recursive: true, force: true }));
  const profile = fakeProfile();
  for (const kind of kinds) await addShell({ appDir: app.dir, kind, skipSupabase: true }, { profile });
  if (kinds.includes('mobile')) {
    await write(app.dir, 'mobile/resources/icon.png', '');
    await writeFile(file(app.dir, 'mobile/resources/icon.png'), encodePng(solid(1024, 1024, [37, 99, 235]), { alpha: false }));
    await writeFile(file(app.dir, 'mobile/resources/splash.png'), encodePng(solid(2048, 2048, [246, 247, 249]), { alpha: false }));
  }
  const run = (more = {}, deps = {}) => storeCheck({ appDir: app.dir, ...more }, { profile, fetch: pageFetch(), ...deps });
  return { app, profile, run };
}

// ---------------------------------------------------------------- a passing app

test('store-check: a generated phone + desktop app with its pictures passes, with only reminders left', async (t) => {
  const { run } = await ready(t);
  const r = await run();
  assert.deepEqual(failing(r), []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.kinds, ['mobile', 'desktop']);
  for (const id of ['app-id', 'server-url', 'offline-page', 'privacy-manifest', 'permissions', 'icons', 'store-md', 'page-privacy', 'page-terms', 'page-support', 'desktop-url', 'desktop-safety', 'desktop-pinned', 'desktop-icon', 'desktop-workflow', 'account-deletion']) {
    assert.equal(status(r, id), 'ok', id);
  }
  // Reminders the student must read.
  assert.equal(status(r, 'apple-4-2'), 'warn');
  assert.match(byId(r)['apple-4-2'].next, /demo login/);
  assert.equal(status(r, 'play-testers'), 'info');
  assert.match(byId(r)['play-testers'].message, /12 testers for 14 days/);
  assert.equal(status(r, 'store-checklist'), 'warn');
  assert.equal(status(r, 'desktop-signing'), 'info');
});

test('store-check: an app with no phone or desktop folder is skipped, not failed', async (t) => {
  const { run } = await ready(t, { kinds: [] });
  const r = await run();
  assert.deepEqual([r.ok, r.skipped, r.kinds], [true, true, []]);
  assert.equal(r.checks[0].id, 'no-shells');
});

test('store-check --offline: pages are not fetched, and the student is told', async (t) => {
  const { run } = await ready(t, { kinds: ['mobile'] });
  let fetched = 0;
  const r = await run({ offline: true }, { fetch: async () => { fetched += 1; return { status: 200 }; } });
  assert.equal(fetched, 0);
  assert.equal(status(r, 'pages'), 'warn');
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- one failing fixture per major check (phone)

test('fail: no live address', async (t) => {
  const { app, run } = await ready(t);
  await editJson(app.dir, '.shipyard-app.json', (c) => ({ ...c, url: '', siteUrl: '' }));
  const r = await run();
  assert.equal(status(r, 'live-url'), 'fail');
  assert.equal(status(r, 'server-url'), 'fail');
  assert.equal(r.ok, false);
});

test('fail: the phone app opens another address than the live app, or plain http, or has cleartext on', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await editJson(app.dir, 'mobile/capacitor.config.json', (c) => ({ ...c, server: { ...c.server, url: 'https://old.example.net' } }));
  const r = await run();
  assert.equal(status(r, 'server-url'), 'fail');
  assert.match(byId(r)['server-url'].message, /old\.example\.net.*bakery-notes\.example\.net/);
  assert.match(byId(r)['server-url'].next, /add-shell/);
  await editJson(app.dir, 'mobile/capacitor.config.json', (c) => ({ ...c, server: { ...c.server, url: 'http://bakery-notes.example.net', cleartext: true } }));
  const http = await run();
  assert.match(byId(http)['server-url'].message, /not https/);
  assert.equal(status(http, 'cleartext'), 'fail');
});

test('fail: the app id was changed after it was saved, or is a sample id', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await editJson(app.dir, 'mobile/capacitor.config.json', (c) => ({ ...c, appId: 'gr.me.different' }));
  const changed = await run();
  assert.equal(status(changed, 'app-id'), 'fail');
  assert.match(byId(changed)['app-id'].message, /not the one Shipyard saved/);
  await editJson(app.dir, 'mobile/capacitor.config.json', (c) => ({ ...c, appId: 'com.example.app' }));
  const sample = await run();
  assert.match(byId(sample)['app-id'].message, /sample id/);
});

test('fail: the mobile config is missing', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await rm(file(app.dir, 'mobile/capacitor.config.json'));
  const r = await run();
  assert.equal(status(r, 'mobile-config'), 'fail');
  assert.equal(r.ok, false);
});

test('offline page: missing is a failure, no Try again button is a warning', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await write(app.dir, 'mobile/www/index.html', '<p>hi</p>');
  assert.equal(status(await run(), 'offline-page'), 'warn');
  await rm(file(app.dir, 'mobile/www/index.html'));
  assert.equal(status(await run(), 'offline-page'), 'fail');
  await editJson(app.dir, 'mobile/capacitor.config.json', (c) => ({ ...c, server: { ...c.server, errorPath: undefined } }));
  assert.equal(status(await run(), 'offline-page-wired'), 'warn');
});

test('fail: no iOS privacy manifest; with an Xcode project it must be inside the project', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await rm(file(app.dir, 'mobile/resources/PrivacyInfo.xcprivacy'));
  assert.equal(status(await run(), 'privacy-manifest'), 'fail');
  await write(app.dir, 'mobile/resources/PrivacyInfo.xcprivacy', '<key>NSPrivacyAccessedAPITypes</key>');
  await write(app.dir, 'mobile/ios/App/App.xcodeproj/project.pbxproj', 'PRODUCT_BUNDLE_IDENTIFIER = io.github.sambaker.bakerynotes;');
  const noCopy = await run();
  assert.equal(status(noCopy, 'privacy-manifest'), 'fail');
  assert.match(byId(noCopy)['privacy-manifest'].next, /apply-native/);
});

test('permissions: a name the tool does not know, or a one-word reason, fails; a written reason passes', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await editJson(app.dir, 'mobile/native-config.json', (c) => ({ ...c, permissions: { camera: 'camera', lasers: 'This app uses lasers to scan receipts.' } }));
  const bad = await run();
  assert.equal(status(bad, 'permissions'), 'fail');
  assert.match(byId(bad).permissions.message, /camera, lasers/);
  await editJson(app.dir, 'mobile/native-config.json', (c) => ({ ...c, permissions: { camera: 'This app uses the camera to scan receipts.' } }));
  assert.equal(status(await run(), 'permissions'), 'ok');
});

test('iPhone usage strings: Info.plist must hold a reason for every permission, and Android must not ask for more than iPhone explains', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await editJson(app.dir, 'mobile/native-config.json', (c) => ({ ...c, permissions: { camera: 'This app uses the camera to scan receipts.' } }));
  await write(app.dir, 'mobile/ios/App/App/Info.plist', '<dict></dict>');
  const missing = await run();
  assert.equal(status(missing, 'ios-usage-strings'), 'fail');
  assert.match(byId(missing)['ios-usage-strings'].message, /NSCameraUsageDescription/);
  await write(app.dir, 'mobile/android/app/src/main/AndroidManifest.xml', '<uses-permission android:name="android.permission.RECORD_AUDIO"/>');
  const clash = await run();
  assert.equal(status(clash, 'permission-match'), 'fail');
  assert.match(byId(clash)['permission-match'].message, /microphone/);
  await write(app.dir, 'mobile/ios/App/App/Info.plist', '<dict><key>NSCameraUsageDescription</key><string>x</string><key>NSMicrophoneUsageDescription</key><string>y</string></dict>');
  const fixed = await run();
  assert.equal(status(fixed, 'ios-usage-strings'), 'ok');
  assert.equal(status(fixed, 'permission-match'), undefined);
});

test('icons: missing, wrong size and a transparent layer each fail with the command that fixes it', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  const icon = file(app.dir, 'mobile/resources/icon.png');
  await writeFile(icon, encodePng(solid(512, 512, [1, 2, 3]), { alpha: false }));
  const small = await run();
  assert.equal(status(small, 'icons'), 'fail');
  assert.match(byId(small).icons.message, /512 x 512/);
  assert.match(byId(small).icons.next, /npm run icons/);
  await writeFile(icon, encodePng(solid(1024, 1024, [1, 2, 3], 200), { alpha: true }));
  assert.match(byId(await run()).icons.message, /transparent/);
  await rm(icon);
  await rm(file(app.dir, 'mobile/resources/splash.png'));
  const gone = await run();
  assert.deepEqual([status(gone, 'icons'), status(gone, 'splash')], ['fail', 'fail']);
  await writeFile(file(app.dir, 'mobile/resources/splash.png'), encodePng(solid(1000, 1000, [1, 2, 3]), { alpha: false }));
  assert.equal(status(await run(), 'splash'), 'warn');
});

test('Xcode and Android projects: the ids and the icon must match the app', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await write(app.dir, 'mobile/ios/App/App.xcodeproj/project.pbxproj', 'PRODUCT_BUNDLE_IDENTIFIER = com.getcapacitor.app; PrivacyInfo.xcprivacy');
  await write(app.dir, 'mobile/ios/App/App/PrivacyInfo.xcprivacy', '<key>NSPrivacyAccessedAPITypes</key>');
  await write(app.dir, 'mobile/android/app/build.gradle', 'namespace = "com.getcapacitor.app"\napplicationId "com.getcapacitor.app"');
  await write(app.dir, 'mobile/android/variables.gradle', 'targetSdkVersion = 33');
  const r = await run();
  assert.equal(status(r, 'ios-bundle-id'), 'fail');
  assert.equal(status(r, 'ios-icon'), 'fail');
  assert.equal(status(r, 'android-id'), 'fail');
  assert.equal(status(r, 'android-target-sdk'), 'warn');
  await write(app.dir, 'mobile/ios/App/App.xcodeproj/project.pbxproj', 'PRODUCT_BUNDLE_IDENTIFIER = io.github.sambaker.bakerynotes; PrivacyInfo.xcprivacy');
  await write(app.dir, 'mobile/android/app/build.gradle', 'namespace = "io.github.sambaker.bakerynotes"\napplicationId "io.github.sambaker.bakerynotes"');
  await mkdir(file(app.dir, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset'), { recursive: true });
  await writeFile(file(app.dir, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/icon.png'), encodePng(solid(1024, 1024, [1, 2, 3]), { alpha: false }));
  const fixed = await run();
  assert.deepEqual([status(fixed, 'ios-bundle-id'), status(fixed, 'ios-icon'), status(fixed, 'android-id')], ['ok', 'ok', 'ok']);
});

test('Google sign-in: every piece must be wired, with the Apple 4.8 reminder', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'], app: { google: true } });
  const good = await run();
  assert.equal(status(good, 'google-return'), 'ok');
  assert.equal(status(good, 'sign-in-with-apple'), 'warn');
  assert.equal(status(good, 'supabase-redirect'), 'info');
  await edit(app.dir, 'src/app/layout.tsx', (t0) => t0.replace('<NativeAuthReturn />', ''));
  const broken = await run();
  assert.equal(status(broken, 'google-return'), 'fail');
  assert.match(byId(broken)['google-return'].message, /layout\.tsx/);
  // With the iPhone and Android projects present, the return address must be registered in both.
  await write(app.dir, 'mobile/ios/App/App/Info.plist', '<dict></dict>');
  await write(app.dir, 'mobile/android/app/src/main/AndroidManifest.xml', '<manifest/>');
  const projects = await run();
  assert.equal(status(projects, 'ios-scheme'), 'fail');
  assert.equal(status(projects, 'android-scheme'), 'fail');
});

test('STORE.md: an empty field, a placeholder, a too-long name and an empty description each fail', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  const original = await read(app.dir, 'mobile/STORE.md');
  const fields = parseStoreMd(original);
  assert.ok(fields.name && fields['support url'] && fields.keywords);
  await edit(app.dir, 'mobile/STORE.md', (t0) => t0.replace(/^- \*\*Subtitle:\*\*.*$/m, '- **Subtitle:**'));
  assert.match(byId(await run())['store-md'].message, /empty: subtitle/);
  await write(app.dir, 'mobile/STORE.md', original.replace(/^- \*\*Keywords:\*\*.*$/m, '- **Keywords:** TODO'));
  assert.match(byId(await run())['store-md'].message, /placeholder: keywords/);
  await write(app.dir, 'mobile/STORE.md', original.replace(/^- \*\*Name:\*\*.*$/m, `- **Name:** ${'N'.repeat(31)}`));
  assert.match(byId(await run())['store-md'].message, /too long: name \(31 of 30\)/);
  await rm(file(app.dir, 'mobile/STORE.md'));
  assert.equal(status(await run(), 'store-md'), 'fail');
  assert.equal(section('## A\none\n## B\ntwo', 'B'), 'two');
});

test('the public pages the stores need: a page that does not open fails, a non-https address fails', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  const r = await run({}, { fetch: pageFetch({ '/privacy': 404, '/help': 500 }) });
  assert.equal(status(r, 'page-privacy'), 'fail');
  assert.match(byId(r)['page-privacy'].message, /did not open \(404\)/);
  assert.equal(status(r, 'page-support'), 'fail');
  assert.equal(status(r, 'page-terms'), 'ok');
  const down = await run({}, { fetch: async () => { throw new Error('offline'); } });
  assert.match(byId(down)['page-privacy'].message, /no answer/);
  await edit(app.dir, 'mobile/STORE.md', (t0) => t0.replace(/^(- \*\*Terms URL:\*\*).*$/m, '$1 http://insecure.example.net/terms'));
  assert.match(byId(await run())['page-terms'].message, /not an https address/);
});

test('billing apps get the Apple in-app purchase warning', async (t) => {
  const { run } = await ready(t, { kinds: ['mobile'], app: { modules: ['billing'] } });
  assert.equal(status(await run(), 'apple-iap'), 'warn');
});

test('fail: the web app has no account deletion (both stores require it)', async (t) => {
  const { app, run } = await ready(t, { kinds: ['mobile'] });
  await rm(file(app.dir, 'src/app/api/account/delete'), { recursive: true });
  const r = await run();
  assert.equal(status(r, 'account-deletion'), 'fail');
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- desktop

test('desktop: an unsafe window, a wrong address, a missing workflow and unpinned packages are each caught', async (t) => {
  const { app, run } = await ready(t, { kinds: ['desktop'] });
  await edit(app.dir, 'desktop/main.js', (t0) => t0.replace(/nodeIntegration:\s*false/, 'nodeIntegration: true').replace(/sandbox:\s*true/, 'sandbox: false'));
  const unsafe = await run();
  assert.equal(status(unsafe, 'desktop-safety'), 'fail');
  assert.match(byId(unsafe)['desktop-safety'].message, /missing nodeIntegration: false, sandbox: true/);
  assert.match(byId(unsafe)['desktop-safety'].message, /unsafe setting nodeIntegration: true/);
  await rm(file(app.dir, 'desktop/main.js'));
  assert.equal(status(await run(), 'desktop-main'), 'fail');

  await editJson(app.dir, 'desktop/app.json', (c) => ({ ...c, url: 'https://elsewhere.example.net' }));
  assert.match(byId(await run())['desktop-url'].message, /elsewhere\.example\.net.*bakery-notes\.example\.net/);
  await editJson(app.dir, 'desktop/app.json', (c) => ({ ...c, url: 'http://bakery-notes.example.net' }));
  assert.match(byId(await run())['desktop-url'].message, /not https/);

  await editJson(app.dir, 'desktop/package.json', (c) => ({ ...c, devDependencies: { electron: '^44.0.0', 'electron-builder': '26.15.3' } }));
  const loose = await run();
  assert.equal(status(loose, 'desktop-pinned'), 'warn');
  assert.match(byId(loose)['desktop-pinned'].message, /electron is not pinned/);

  await rm(file(app.dir, '.github/workflows/desktop-release.yml'));
  assert.equal(status(await run(), 'desktop-workflow'), 'fail');
  await rm(file(app.dir, 'desktop/build/icon.png'));
  assert.equal(status(await run(), 'desktop-icon'), 'warn');
});

test('desktop: a sample app id in app.json or package.json fails', async (t) => {
  const { app, run } = await ready(t, { kinds: ['desktop'] });
  await editJson(app.dir, 'desktop/app.json', (c) => ({ ...c, appId: 'com.example.app' }));
  await editJson(app.dir, 'desktop/package.json', (c) => ({ ...c, build: { ...c.build, appId: 'com.example.app' } }));
  const r = await run();
  assert.equal(status(r, 'desktop-app-id'), 'fail');
  assert.equal(status(r, 'desktop-build-id'), 'fail');
});

// ---------------------------------------------------------------- the command

test('store-check command: prints every line and exits through the result', async (t) => {
  const { app, profile } = await ready(t);
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  let result;
  try {
    result = await storeCheckMain({ _: [app.dir], offline: true }, { profile });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(result.ok, true);
  const text = lines.join('');
  assert.match(text, /No blocking problems/);
  assert.match(text, /Apple may refuse/);
  assert.ok(text.includes(FAKE_URL));
});
