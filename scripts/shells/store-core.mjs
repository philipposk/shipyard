// The checks behind store-check.mjs: what Apple and Google (and a desktop download) would still ask for.
// Everything is read from the app folder; the only network use is asking the live website for its public pages.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readFacts, exists, readText } from './facts.mjs';
import { validateAppId } from './appid.mjs';
import { pngInfo } from '../../shells/mobile/scripts/png.mjs';
import { PERMISSIONS, pbxBundleId, plistHasKey } from '../../shells/mobile/scripts/native-edit.mjs';

const ok = (id, message) => ({ id, status: 'ok', message });
const fail = (id, message, next) => ({ id, status: 'fail', message, next });
const warn = (id, message, next) => ({ id, status: 'warn', message, next });
const info = (id, message) => ({ id, status: 'info', message });

/** `- **Field:** value` lines of STORE.md, as { field: value }. */
export function parseStoreMd(text) {
  const out = {};
  for (const m of text.matchAll(/^- \*\*([^*:]+):\*\*[ \t]*(.*)$/gm)) out[m[1].trim().toLowerCase()] = m[2].trim();
  return out;
}

/** The text under a "## Heading" until the next heading. */
export function section(text, heading) {
  const m = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

const REQUIRED_FIELDS = ['name', 'subtitle', 'short description', 'category', 'age rating suggestion', 'keywords', 'support url', 'privacy policy url', 'terms url'];
const LIMITS = { name: 30, subtitle: 30, 'short description': 80, keywords: 100 };
const MISSING_WORDS = /\b(todo|tbd|fill in|lorem ipsum)\b|\[[A-Z ]{2,}\]|<[A-Za-z ]+>/i;

async function readJson(file) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

async function pngAt(file) {
  try {
    return pngInfo(await readFile(file));
  } catch {
    return null;
  }
}

async function listPngs(dir) {
  try {
    return (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.png')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function checkUrl(fetchFn, url) {
  try {
    const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'shipyard-store-check' } });
    return res.status;
  } catch {
    return 0;
  }
}

async function mobileChecks(appDir, facts, ctx) {
  const checks = [];
  const mobile = path.join(appDir, 'mobile');
  const cap = await readJson(path.join(mobile, 'capacitor.config.json'));
  if (!cap) {
    checks.push(fail('mobile-config', 'mobile/capacitor.config.json is missing or not valid JSON.', 'Run: node add-shell.mjs <app folder> mobile'));
    return checks;
  }
  // App id
  const appId = cap.appId ?? '';
  const v = validateAppId(appId);
  if (!v.ok) checks.push(fail('app-id', v.reason, 'Pick your own id. Before the app is in a store, delete the mobile folder and run add-shell again with --app-id.'));
  else if (facts.config.shells?.mobile?.appId && facts.config.shells.mobile.appId !== appId) {
    checks.push(fail('app-id', `The app id in capacitor.config.json (${appId}) is not the one Shipyard saved (${facts.config.shells.mobile.appId}).`, 'Put the saved id back. Changing it breaks installed apps and sign-in.'));
  } else checks.push(ok('app-id', `App id ${appId} is valid.`));

  // Live address
  const serverUrl = cap.server?.url ?? '';
  let origin = '';
  try {
    const u = new URL(serverUrl);
    origin = u.origin;
    if (u.protocol !== 'https:') checks.push(fail('server-url', `The phone app loads ${serverUrl}, which is not https. Stores require a secure address.`, 'Run add-shell mobile again once the app has an https address.'));
    else if (!facts.url) checks.push(fail('server-url', 'The app has no live address saved, so the phone app cannot be matched to it.', 'Deploy the app first.'));
    else if (origin !== facts.url) checks.push(fail('server-url', `The phone app opens ${origin}, but the live app is ${facts.url}.`, 'Run: node add-shell.mjs <app folder> mobile (it updates the address).'));
    else checks.push(ok('server-url', `The phone app opens the live app (${origin}) over https.`));
  } catch {
    checks.push(fail('server-url', 'capacitor.config.json has no valid server.url.', 'Run: node add-shell.mjs <app folder> mobile'));
  }
  if (cap.server?.cleartext === true) checks.push(fail('cleartext', 'server.cleartext is true. Plain http is not allowed in a store app.', 'Set "cleartext": false.'));

  // Offline page
  const www = await readText(path.join(mobile, 'www', 'index.html'));
  if (!www) checks.push(fail('offline-page', 'mobile/www/index.html (the offline page) is missing.', 'Run: node add-shell.mjs <app folder> mobile'));
  else if (!/id="retry"/.test(www) || !/offline/i.test(www)) checks.push(warn('offline-page', 'The offline page has no "Try again" button.', 'Run add-shell mobile with --force-file mobile/www/index.html to get the designed page back.'));
  else checks.push(ok('offline-page', 'The offline page is there, with a Try again button.'));
  if (cap.server?.errorPath !== 'index.html') checks.push(warn('offline-page-wired', 'capacitor.config.json does not point errorPath at the offline page, so people may see a blank screen when offline.', 'Set "errorPath": "index.html" under "server".'));

  // Privacy manifest
  const manifest = await readText(path.join(mobile, 'resources', 'PrivacyInfo.xcprivacy'));
  if (!manifest.includes('NSPrivacyAccessedAPITypes')) checks.push(fail('privacy-manifest', 'mobile/resources/PrivacyInfo.xcprivacy (the iOS privacy manifest) is missing.', 'Run: node add-shell.mjs <app folder> mobile'));
  else if (await exists(path.join(mobile, 'ios'))) {
    const inProject = await exists(path.join(mobile, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'));
    const pbx = await readText(path.join(mobile, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'));
    if (!inProject || !pbx.includes('PrivacyInfo.xcprivacy')) checks.push(fail('privacy-manifest', 'The iOS project does not include PrivacyInfo.xcprivacy. Apple rejects uploads without it.', 'In the mobile folder run: npm run apply-native'));
    else checks.push(ok('privacy-manifest', 'The iOS privacy manifest is in the Xcode project.'));
  } else checks.push(ok('privacy-manifest', 'The iOS privacy manifest is ready (it goes into the Xcode project when you run apply-native).'));

  // Permissions and usage strings
  const native = (await readJson(path.join(mobile, 'native-config.json'))) ?? {};
  const declared = Object.entries(native.permissions ?? {});
  const bad = declared.filter(([name, text]) => !PERMISSIONS[name] || typeof text !== 'string' || text.trim().length < 12);
  if (bad.length) checks.push(fail('permissions', `native-config.json: ${bad.map(([n]) => n).join(', ')} needs a known name (${Object.keys(PERMISSIONS).join(', ')}) and a plain sentence of at least a few words that tells the person why the app asks.`, 'Edit mobile/native-config.json, then run: npm run apply-native'));
  else if (declared.length === 0) checks.push(ok('permissions', 'The phone app asks for no special permissions.'));
  else checks.push(ok('permissions', `Permission texts are written for: ${declared.map(([n]) => n).join(', ')}.`));
  const plist = await readText(path.join(mobile, 'ios', 'App', 'App', 'Info.plist'));
  const androidManifest = await readText(path.join(mobile, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  if (plist) {
    const missing = declared.filter(([n]) => PERMISSIONS[n] && !plistHasKey(plist, PERMISSIONS[n].ios)).map(([n]) => PERMISSIONS[n].ios);
    if (missing.length) checks.push(fail('ios-usage-strings', `Info.plist is missing ${missing.join(', ')}. Apple rejects apps that ask without a reason text.`, 'In the mobile folder run: npm run apply-native'));
    else checks.push(ok('ios-usage-strings', 'Info.plist has the permission texts.'));
  }
  if (plist && androidManifest) {
    const clash = Object.entries(PERMISSIONS).filter(([, p]) => p.android.some((a) => androidManifest.includes(`android:name="${a}"`)) && !plistHasKey(plist, p.ios)).map(([n]) => n);
    if (clash.length) checks.push(fail('permission-match', `Android asks for ${clash.join(', ')} but the iPhone app has no reason text for it.`, 'Add it to native-config.json and run: npm run apply-native'));
  }

  // Icons
  const icon = await pngAt(path.join(mobile, 'resources', 'icon.png'));
  const splash = await pngAt(path.join(mobile, 'resources', 'splash.png'));
  if (!icon) checks.push(fail('icons', 'mobile/resources/icon.png is missing.', 'In the mobile folder run: npm run icons'));
  else if (icon.width !== 1024 || icon.height !== 1024) checks.push(fail('icons', `The icon is ${icon.width} x ${icon.height}. The App Store needs 1024 x 1024.`, 'In the mobile folder run: npm run icons'));
  else if (icon.hasAlpha) checks.push(fail('icons', 'The icon has a transparent layer. The App Store rejects that.', 'In the mobile folder run: npm run icons (it makes an icon without one).'));
  else checks.push(ok('icons', 'The icon is 1024 x 1024 with no transparent layer.'));
  if (!splash) checks.push(fail('splash', 'mobile/resources/splash.png is missing.', 'In the mobile folder run: npm run icons'));
  else if (splash.width < 2048 || splash.height < 2048) checks.push(warn('splash', `The splash picture is only ${splash.width} x ${splash.height}.`, 'Run: npm run icons'));
  if (await exists(path.join(mobile, 'ios'))) {
    const files = await listPngs(path.join(mobile, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset'));
    const infos = await Promise.all(files.map(pngAt));
    if (infos.length === 0 || infos.some((i) => !i || i.width !== 1024 || i.hasAlpha)) {
      checks.push(fail('ios-icon', 'The iOS project still has the sample icon, or one with a transparent layer.', 'In the mobile folder run: npm run icons, then npm run apply-native'));
    } else checks.push(ok('ios-icon', 'The iOS project has your icon.'));
    const pbx = await readText(path.join(mobile, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'));
    const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;\s]+);/g)].map((m) => m[1]);
    if (ids.length && ids.some((id) => id !== appId)) checks.push(fail('ios-bundle-id', `The Xcode project builds as ${[...new Set(ids)].join(', ')}, not ${appId}.`, 'Remove mobile/ios, then run: npm run add:ios and npm run apply-native'));
    else if (ids.length) checks.push(ok('ios-bundle-id', 'The iOS bundle id matches the app id.'));
    void pbxBundleId;
  }
  if (await exists(path.join(mobile, 'android'))) {
    const gradle = await readText(path.join(mobile, 'android', 'app', 'build.gradle'));
    const applicationId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1] ?? '';
    const namespace = /namespace\s*=?\s*"([^"]+)"/.exec(gradle)?.[1] ?? '';
    if (applicationId !== appId || (namespace && namespace !== appId)) checks.push(fail('android-id', `Android uses ${applicationId || '?'}${namespace && namespace !== applicationId ? ` / ${namespace}` : ''}, not ${appId}.`, 'Remove mobile/android, then run: npm run add:android and npm run apply-native'));
    else checks.push(ok('android-id', 'The Android application id matches the app id.'));
    const vars = await readText(path.join(mobile, 'android', 'variables.gradle'));
    const target = Number(/targetSdkVersion\s*=\s*(\d+)/.exec(vars)?.[1] ?? 0);
    if (target && target < 36) checks.push(warn('android-target-sdk', `Android targets API ${target}. Google Play asks new apps and updates to target the newest level (check the current number in the Play Console).`, 'Update @capacitor/android to the newest version.'));
  }

  // Sign-in through the system browser (only when Google sign-in is on)
  if (facts.google || native.authReturn === true) {
    const parts = [
      ['src/lib/native-auth.ts', (t) => t.includes(`${appId}://auth/callback`)],
      ['src/components/NativeAuthReturn.tsx', (t) => t.includes('appUrlOpen')],
      ['src/app/layout.tsx', (t) => t.includes('<NativeAuthReturn />')],
      ['src/components/GoogleSignInButton.tsx', (t) => t.includes('signInGoogleNative')],
    ];
    const broken = [];
    for (const [rel, test] of parts) {
      const t = await readText(path.join(appDir, ...rel.split('/')));
      if (!t || !test(t)) broken.push(rel);
    }
    if (broken.length) checks.push(fail('google-return', `Google sign-in in the phone app is not fully wired (${broken.join(', ')}).`, 'Run: node add-shell.mjs <app folder> mobile --google'));
    else checks.push(ok('google-return', 'Google sign-in opens the phone browser and comes back to the app.'));
    if (plist && !plist.includes(`<string>${appId}</string>`)) checks.push(fail('ios-scheme', 'Info.plist does not register the sign-in return address.', 'In the mobile folder run: npm run apply-native'));
    if (androidManifest && !androidManifest.includes(`android:scheme="${appId}"`)) checks.push(fail('android-scheme', 'AndroidManifest.xml does not register the sign-in return address.', 'In the mobile folder run: npm run apply-native'));
    checks.push(warn('sign-in-with-apple', 'The app offers Google sign-in. Apple rule 4.8 asks for an equivalent option such as Sign in with Apple in the iPhone app.', 'Add Sign in with Apple, or leave Google sign-in out of the iPhone app, before you submit.'));
    checks.push(info('supabase-redirect', `Supabase must list ${appId}://auth/callback under Authentication, URL Configuration, Redirect URLs (add-shell adds it when it can; check the dashboard if Google sign-in fails in the app).`));
  }

  // STORE.md
  const store = await readText(path.join(mobile, 'STORE.md'));
  if (!store) checks.push(fail('store-md', 'mobile/STORE.md (the listing draft) is missing.', 'Run: node add-shell.mjs <app folder> mobile'));
  else {
    const fields = parseStoreMd(store);
    const empty = REQUIRED_FIELDS.filter((f) => !fields[f]);
    const placeholders = Object.entries(fields).filter(([, v]) => MISSING_WORDS.test(v)).map(([k]) => k);
    const tooLong = Object.entries(LIMITS).filter(([f, max]) => (fields[f] ?? '').length > max).map(([f, max]) => `${f} (${(fields[f] ?? '').length} of ${max})`);
    const description = section(store, 'Description');
    const problems = [];
    if (empty.length) problems.push(`empty: ${empty.join(', ')}`);
    if (placeholders.length) problems.push(`still a placeholder: ${placeholders.join(', ')}`);
    if (tooLong.length) problems.push(`too long: ${tooLong.join(', ')}`);
    if (!description) problems.push('the Description section is empty');
    if (problems.length) checks.push(fail('store-md', `STORE.md needs work (${problems.join('; ')}).`, 'Edit mobile/STORE.md.'));
    else checks.push(ok('store-md', 'STORE.md has every required field.'));
    const open = (store.match(/^- \[ \]/gm) ?? []).length;
    if (open) checks.push(warn('store-checklist', `${open} step${open === 1 ? '' : 's'} in STORE.md "Before you submit" ${open === 1 ? 'is' : 'are'} still open (accounts, screenshots, reviewer login, forms).`, 'Tick them off in mobile/STORE.md as you finish them.'));
    // The public pages the stores need
    const urls = [['privacy policy url', '/privacy'], ['terms url', '/terms'], ['support url', '/help']];
    if (ctx.fetch) {
      for (const [field, fallback] of urls) {
        const url = fields[field] || (facts.url ? `${facts.url}${fallback}` : '');
        if (!/^https:\/\//.test(url)) {
          checks.push(fail(`page-${field.split(' ')[0]}`, `The ${field.replace(' url', '')} address in STORE.md is not an https address.`, 'Fix it in mobile/STORE.md.'));
          continue;
        }
        const status = await checkUrl(ctx.fetch, url);
        const label = field.replace(' url', '');
        if (status === 200) checks.push(ok(`page-${field.split(' ')[0]}`, `${url} opens (the ${label} page).`));
        else checks.push(fail(`page-${field.split(' ')[0]}`, `${url} did not open (${status || 'no answer'}). The stores need this page to work.`, 'Deploy the app, and check the page opens in a browser.'));
      }
    } else {
      checks.push(warn('pages', 'The privacy, terms and support pages were not tested (offline mode).', 'Run without --offline to test them.'));
    }
  }

  // Apple 4.2
  checks.push(warn(
    'apple-4-2',
    'Apple may refuse an app that is only a website in a frame (rule 4.2, minimum functionality).',
    'Before you submit: (1) use at least one phone feature in the main use (camera, share sheet, notifications, offline), (2) keep the designed offline page, (3) offer no payment links for digital goods unless the store region allows them, (4) put a demo login in the review notes.',
  ));
  checks.push(info('play-testers', 'Google Play: a new personal developer account must run a closed test with at least 12 testers for 14 days before it can publish. Start that early.'));
  if (facts.modules.includes('billing')) {
    checks.push(warn('apple-iap', 'The app takes payments (billing module). Apple rule 3.1.1 usually requires in-app purchase for digital things used inside an iPhone app.', 'Read the current rule, and in the iPhone app consider hiding prices and the Billing section.'));
  }
  return checks;
}

async function desktopChecks(appDir, facts) {
  const checks = [];
  const desktop = path.join(appDir, 'desktop');
  const app = await readJson(path.join(desktop, 'app.json'));
  if (!app) checks.push(fail('desktop-config', 'desktop/app.json is missing or not valid JSON.', 'Run: node add-shell.mjs <app folder> desktop'));
  else {
    try {
      const u = new URL(app.url);
      if (u.protocol !== 'https:') checks.push(fail('desktop-url', `The desktop app opens ${app.url}, which is not https.`, 'Run add-shell desktop again once the app has an https address.'));
      else if (facts.url && u.origin !== facts.url) checks.push(fail('desktop-url', `The desktop app opens ${u.origin}, but the live app is ${facts.url}.`, 'Run: node add-shell.mjs <app folder> desktop'));
      else checks.push(ok('desktop-url', `The desktop app opens ${u.origin} over https.`));
    } catch {
      checks.push(fail('desktop-url', 'desktop/app.json has no valid url.', 'Run: node add-shell.mjs <app folder> desktop'));
    }
    const v = validateAppId(app.appId ?? '');
    if (!v.ok) checks.push(fail('desktop-app-id', v.reason));
  }
  const main = await readText(path.join(desktop, 'main.js'));
  if (!main) checks.push(fail('desktop-main', 'desktop/main.js is missing.', 'Run: node add-shell.mjs <app folder> desktop'));
  else {
    const needed = [
      [/contextIsolation:\s*true/, 'contextIsolation: true'],
      [/nodeIntegration:\s*false/, 'nodeIntegration: false'],
      [/sandbox:\s*true/, 'sandbox: true'],
      [/setWindowOpenHandler/, 'a handler for links that open new windows'],
      [/will-navigate/, 'a handler that stops the window leaving the app'],
    ];
    const forbidden = [/nodeIntegration:\s*true/, /contextIsolation:\s*false/, /sandbox:\s*false/, /webSecurity:\s*false/, /allowRunningInsecureContent:\s*true/, /enableRemoteModule/];
    const missing = needed.filter(([re]) => !re.test(main)).map(([, label]) => label);
    const unsafe = forbidden.filter((re) => re.test(main)).map((re) => re.source.replace(/\\s\*/g, ' '));
    if (missing.length || unsafe.length) checks.push(fail('desktop-safety', `desktop/main.js is not safe${missing.length ? `: missing ${missing.join(', ')}` : ''}${unsafe.length ? `; unsafe setting ${unsafe.join(', ')}` : ''}.`, 'Run add-shell desktop with --force-file desktop/main.js to get the safe version back.'));
    else checks.push(ok('desktop-safety', 'The desktop window is locked down (isolated page, sandbox, links open in the browser).'));
  }
  const pkg = await readJson(path.join(desktop, 'package.json'));
  if (!pkg) checks.push(fail('desktop-package', 'desktop/package.json is missing.', 'Run: node add-shell.mjs <app folder> desktop'));
  else {
    const dev = pkg.devDependencies ?? {};
    const unpinned = ['electron', 'electron-builder'].filter((n) => !/^\d+\.\d+\.\d+$/.test(dev[n] ?? ''));
    if (unpinned.length) checks.push(warn('desktop-pinned', `${unpinned.join(', ')} ${unpinned.length === 1 ? 'is' : 'are'} not pinned to an exact version.`, 'Use an exact version number like 1.2.3 so builds repeat.'));
    else checks.push(ok('desktop-pinned', 'Electron and electron-builder are pinned to exact versions.'));
    if (!validateAppId(pkg.build?.appId ?? '').ok) checks.push(fail('desktop-build-id', 'desktop/package.json build.appId is not a valid, personal app id.', 'Run add-shell desktop with --app-id.'));
  }
  if (!(await exists(path.join(desktop, 'offline.html')))) checks.push(warn('desktop-offline', 'desktop/offline.html is missing, so people see a blank window offline.', 'Run: node add-shell.mjs <app folder> desktop'));
  const icon = await pngAt(path.join(desktop, 'build', 'icon.png'));
  if (!icon) checks.push(warn('desktop-icon', 'desktop/build/icon.png is missing, so the installer gets the default Electron icon.', 'Add public/icon-512.png to the app and run add-shell desktop again.'));
  else if (icon.width < 512) checks.push(warn('desktop-icon', `The desktop icon is ${icon.width} px; macOS needs at least 512.`, 'Use a 512 or 1024 px icon.'));
  else checks.push(ok('desktop-icon', 'The desktop icon is there.'));
  const wf = await readText(path.join(appDir, '.github', 'workflows', 'desktop-release.yml'));
  if (!/desktop-v\*/.test(wf)) checks.push(fail('desktop-workflow', '.github/workflows/desktop-release.yml is missing, or does not build on desktop-v tags.', 'Run: node add-shell.mjs <app folder> desktop'));
  else checks.push(ok('desktop-workflow', 'The GitHub workflow builds installers when you push a desktop-v tag.'));
  checks.push(info('desktop-signing', 'The installers are unsigned: people see a warning. Signing needs a paid Apple Developer account (macOS) and a code-signing certificate (Windows).'));
  return checks;
}

/**
 * Run every check that applies. opts: { appDir, offline }. deps: { fetch, profile }.
 * Returns { ok, skipped, kinds, checks }. `skipped` is true when the app has no phone or desktop folder.
 */
export async function storeCheck(opts, deps = {}) {
  const { appDir } = opts;
  const facts = await readFacts(appDir, deps);
  const hasMobile = await exists(path.join(appDir, 'mobile', 'capacitor.config.json')) || await exists(path.join(appDir, 'mobile'));
  const hasDesktop = await exists(path.join(appDir, 'desktop'));
  const kinds = [hasMobile && 'mobile', hasDesktop && 'desktop'].filter(Boolean);
  if (kinds.length === 0) {
    return { ok: true, skipped: true, kinds, checks: [info('no-shells', 'This app has no phone or desktop app yet. Add one with: node add-shell.mjs <app folder> mobile (or desktop).')] };
  }
  const ctx = { fetch: opts.offline ? null : (deps.fetch ?? fetch) };
  const checks = [];
  if (!facts.url) checks.push(fail('live-url', 'The app has no live https address yet.', 'Deploy the app first.'));
  if (hasMobile) checks.push(...(await mobileChecks(appDir, facts, ctx)));
  if (hasDesktop) checks.push(...(await desktopChecks(appDir, facts)));
  const deleteRoute = await exists(path.join(appDir, 'src', 'app', 'api', 'account', 'delete', 'route.ts'));
  checks.push(deleteRoute
    ? ok('account-deletion', 'People can delete their account inside the app (both stores require it).')
    : fail('account-deletion', 'The web app has no account deletion route (src/app/api/account/delete/route.ts). Apple and Google require in-app account deletion.', 'Update the app to the newest template, or ask Claude to add "Delete my account" to Settings.'));
  return { ok: !checks.some((c) => c.status === 'fail'), skipped: false, kinds, checks };
}
