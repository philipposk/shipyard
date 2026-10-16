// The work behind add-shell.mjs: plan every file, then write them. Nothing is written when a plan is a dry run,
// and an existing file the student may have changed is never overwritten (unless named with --force-file).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as log from '../lib/log.mjs';
import * as realProfile from '../lib/profile.mjs';
import { ProvisionError, readAppConfig, writeAppConfig } from '../provision/common.mjs';
import { deriveAppId, validateAppId } from './appid.mjs';
import { readFacts, exists, readText, needLiveUrl, brightness } from './facts.mjs';
import { SHELLS_DIR, renderOffline, renderStoreMd, renderMobileReadme, renderDesktopReadme } from './render.mjs';
import { patchEslint, patchTsconfig, patchPackageDeps, patchLayout, patchGoogleButton } from './app-patches.mjs';
import { addRedirects } from './supabase.mjs';

const readShell = (...parts) => readFile(path.join(SHELLS_DIR, ...parts));
const readShellText = (...parts) => readFile(path.join(SHELLS_DIR, ...parts), 'utf8');
const json = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

export async function loadVersions() {
  return JSON.parse(await readShellText('versions.json'));
}

/** The address with and without "www." when it is a plain website address (a bare domain or a www address). */
export function appHosts(host) {
  const labels = host.split('.');
  if (host.startsWith('www.')) return [host, host.slice(4)];
  if (labels.length === 2) return [host, `www.${host}`];
  return [host];
}

function mergeCapacitor(existingText, desired) {
  let cur;
  try {
    cur = JSON.parse(existingText);
  } catch {
    return null;
  }
  const next = structuredClone(cur);
  next.appName = desired.appName;
  next.server = { ...(next.server ?? {}), url: desired.server.url, cleartext: false, errorPath: desired.server.errorPath };
  const allow = new Set([...(next.server.allowNavigation ?? []), ...desired.server.allowNavigation]);
  next.server.allowNavigation = [...allow];
  return json(next);
}

function mergeAppJson(existingText, desired) {
  let cur;
  try {
    cur = JSON.parse(existingText);
  } catch {
    return null;
  }
  return json({ ...desired, permissions: Array.isArray(cur.permissions) ? cur.permissions : desired.permissions });
}

async function mobileFiles(facts, ctx) {
  const { appId, versions, google } = ctx;
  const base = JSON.parse(await readShellText('mobile', 'capacitor.config.json'));
  const bg = facts.startColor;
  const hosts = appHosts(facts.host);
  const desired = {
    ...base,
    appId,
    appName: facts.name,
    server: { url: facts.url, cleartext: false, allowNavigation: hosts, errorPath: 'index.html' },
    ios: { ...base.ios, backgroundColor: bg },
    android: { ...base.android, backgroundColor: bg },
    plugins: {
      SplashScreen: { ...base.plugins.SplashScreen, backgroundColor: bg },
      StatusBar: { ...base.plugins.StatusBar, style: brightness(bg) > 0.5 ? 'LIGHT' : 'DARK', backgroundColor: bg },
    },
  };
  const pkg = JSON.parse(await readShellText('mobile', 'package.json'));
  pkg.name = `${facts.slug}-mobile`;
  pkg.description = `Phone app (iOS and Android) for ${facts.name}, around the live website.`;
  const cap = versions.capacitor;
  pkg.dependencies = Object.fromEntries(['@capacitor/android', '@capacitor/app', '@capacitor/browser', '@capacitor/core', '@capacitor/ios', '@capacitor/splash-screen', '@capacitor/status-bar'].map((n) => [n, cap[n]]));
  pkg.devDependencies = { '@capacitor/cli': cap['@capacitor/cli'] };
  const native = JSON.parse(await readShellText('mobile', 'native-config.json'));
  native.authReturn = Boolean(google);

  const files = [
    { rel: 'mobile/capacitor.config.json', content: json(desired), merge: (t) => mergeCapacitor(t, desired) },
    { rel: 'mobile/package.json', content: json(pkg) },
    { rel: 'mobile/.gitignore', content: await readShellText('mobile', 'gitignore.txt') },
    { rel: 'mobile/native-config.json', content: json(native), merge: (t) => {
      try {
        const cur = JSON.parse(t);
        return json({ ...cur, authReturn: Boolean(google) || cur.authReturn === true });
      } catch {
        return null;
      }
    } },
    { rel: 'mobile/www/index.html', content: await renderOffline(facts, facts.url), replace: true },
    { rel: 'mobile/resources/PrivacyInfo.xcprivacy', content: await readShellText('mobile', 'resources', 'PrivacyInfo.xcprivacy') },
    { rel: 'mobile/STORE.md', content: renderStoreMd(facts, { appId, google }) },
    { rel: 'mobile/README.md', content: renderMobileReadme(facts, { appId, google, versions }) },
  ];
  for (const name of ['apply-native-config.mjs', 'generate-icons.mjs', 'native-edit.mjs', 'png.mjs']) {
    files.push({ rel: `mobile/scripts/${name}`, content: await readShellText('mobile', 'scripts', name), replace: true });
  }
  if (google) {
    const appFile = (name) => readShellText('mobile', 'app-files', ...name.split('/'));
    for (const rel of ['src/lib/native-auth.ts', 'src/components/NativeAuthReturn.tsx']) {
      files.push({ rel, content: (await appFile(rel)).replaceAll('__APP_ID__', appId) });
    }
  }
  return files;
}

async function desktopFiles(facts, ctx) {
  const { appId, versions } = ctx;
  const hosts = appHosts(facts.host);
  const appJson = {
    name: facts.name,
    url: facts.url,
    hosts,
    appId,
    permissions: [],
    lightBackground: facts.colors.light.background,
    darkBackground: facts.colors.dark.background,
  };
  const pkg = JSON.parse(await readShellText('desktop', 'package.json'));
  pkg.name = `${facts.slug}-desktop`;
  pkg.description = `Desktop window for ${facts.name}.`;
  pkg.author = facts.profile?.owner?.name || facts.name;
  pkg.devDependencies = { electron: versions.desktop.electron, 'electron-builder': versions.desktop['electron-builder'] };
  pkg.build.appId = appId;
  pkg.build.productName = facts.name;
  const files = [
    { rel: 'desktop/main.js', content: await readShellText('desktop', 'main.js'), replace: true },
    { rel: 'desktop/preload.js', content: await readShellText('desktop', 'preload.js'), replace: true },
    { rel: 'desktop/app.json', content: json(appJson), merge: (t) => mergeAppJson(t, appJson) },
    { rel: 'desktop/package.json', content: json(pkg) },
    { rel: 'desktop/offline.html', content: await renderOffline(facts, facts.url), replace: true },
    { rel: 'desktop/.gitignore', content: await readShellText('desktop', 'gitignore.txt') },
    { rel: 'desktop/README.md', content: renderDesktopReadme(facts, { appId, versions }) },
    { rel: '.github/workflows/desktop-release.yml', content: await readShellText('desktop', 'workflows', 'desktop-release.yml') },
  ];
  const icon = path.join(facts.appDir, 'public', 'icon-512.png');
  if (await exists(icon)) files.push({ rel: 'desktop/build/icon.png', content: await readFile(icon) });
  else ctx.warnings.push('public/icon-512.png is missing, so the desktop installer will use the default Electron icon. Add the icon and run this again.');
  return files;
}

async function classify(appDir, file, forced) {
  const target = path.join(appDir, ...file.rel.split('/'));
  const wanted = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
  if (!(await exists(target))) return { ...file, target, wanted, status: 'create' };
  const current = await readFile(target);
  if (current.equals(wanted)) return { ...file, target, wanted, status: 'same' };
  if (file.merge) {
    const merged = file.merge(current.toString('utf8'));
    if (merged === null) return { ...file, target, wanted, status: 'kept', reason: 'it is not valid JSON' };
    if (Buffer.from(merged).equals(current)) return { ...file, target, wanted, status: 'same' };
    return { ...file, target, wanted: Buffer.from(merged), status: 'update' };
  }
  if (file.replace || forced.has(file.rel)) return { ...file, target, wanted, status: 'update' };
  return { ...file, target, wanted, status: 'kept' };
}

/** Patches to the web app's own files. Returns [{ rel, patch, label, manual }]. */
async function appPatches(appDir, { kind, google, versions }) {
  const out = [];
  const read = (rel) => readText(path.join(appDir, ...rel.split('/')));
  const dirs = [kind];
  out.push({ rel: 'eslint.config.mjs', label: `ESLint ignores the ${kind} folder`, run: (t) => patchEslint(t, dirs.map((d) => `${d}/**`)), manual: `Add "${kind}/**" to the globalIgnores list in eslint.config.mjs so the code checker skips the ${kind} folder.` });
  out.push({ rel: 'tsconfig.json', label: `TypeScript skips the ${kind} folder`, run: (t) => patchTsconfig(t, dirs), manual: `Add "${kind}" to "exclude" in tsconfig.json.` });
  if (kind === 'mobile' && google) {
    const cap = versions.capacitor;
    out.push({
      rel: 'package.json',
      label: 'package.json gets @capacitor/core, @capacitor/app and @capacitor/browser (Google sign-in in the phone app)',
      run: (t) => patchPackageDeps(t, { '@capacitor/app': cap['@capacitor/app'], '@capacitor/browser': cap['@capacitor/browser'], '@capacitor/core': cap['@capacitor/core'] }),
      manual: 'Add @capacitor/app, @capacitor/browser and @capacitor/core to the dependencies in package.json, then run npm install.',
    });
    out.push({ rel: 'src/app/layout.tsx', label: 'layout.tsx mounts NativeAuthReturn', run: patchLayout, manual: 'In src/app/layout.tsx, import NativeAuthReturn from "@/components/NativeAuthReturn" and put <NativeAuthReturn /> inside <body>.' });
    out.push({ rel: 'src/components/GoogleSignInButton.tsx', label: 'the Google button hands over to the phone browser', run: patchGoogleButton, manual: 'At the top of signIn() in src/components/GoogleSignInButton.tsx add: if (await signInGoogleNative()) return;  (import it from "@/lib/native-auth").' });
  }
  for (const p of out) p.text = await read(p.rel);
  return out;
}

/**
 * opts: { appDir, kind: 'mobile'|'desktop', appId, google, skipSupabase, dryRun, forceFiles }
 * deps: { profile, fetch, getSecret } (all optional, for tests)
 */
export async function addShell(opts, deps = {}) {
  const { appDir, kind } = opts;
  if (!['mobile', 'desktop'].includes(kind)) throw new log.UsageError('Say which one: "mobile" (iPhone and Android) or "desktop" (Mac and Windows).');
  const profileApi = deps.profile ?? realProfile;
  const facts = await readFacts(appDir, deps);
  if (!facts.url) throw needLiveUrl();
  const versions = await loadVersions();
  const config = facts.config;
  const forced = new Set(opts.forceFiles ?? []);

  // The app id is chosen once. Later runs reuse it; asking for another one is refused.
  const saved = config.shells?.[kind]?.appId || (kind === 'desktop' ? config.shells?.mobile?.appId : '') || '';
  if (opts.appId && config.shells?.[kind]?.appId && opts.appId !== config.shells[kind].appId) {
    throw new ProvisionError(`This app's ${kind} app id is already ${config.shells[kind].appId}. Changing it breaks installed apps and sign-in. If the app was never published, delete the ${kind} folder and the "shells.${kind}" part of .shipyard-app.json, then run this again.`, { reason: 'app-id-set' });
  }
  let appId = saved;
  let appIdSource = 'saved';
  if (!appId || opts.appId) {
    const derived = deriveAppId({ explicit: opts.appId, hosts: facts.domainHosts, githubUser: facts.githubUser, slug: facts.slug });
    if (derived.error) throw new ProvisionError(derived.error, { reason: 'app-id' });
    appId = derived.appId;
    appIdSource = derived.source;
  }
  const valid = validateAppId(appId);
  if (!valid.ok) throw new ProvisionError(valid.reason, { reason: 'app-id' });

  const google = opts.google ?? facts.google;
  const ctx = { appId, versions, google, warnings: [] };
  const files = kind === 'mobile' ? await mobileFiles(facts, ctx) : await desktopFiles(facts, ctx);
  const planned = [];
  for (const f of files) planned.push(await classify(appDir, f, forced));
  const patches = await appPatches(appDir, { kind, google, versions });
  const patchPlan = patches.map((p) => {
    if (!p.text) return { ...p, status: 'absent' };
    const r = p.run(p.text);
    return { ...p, status: r.status, newText: r.text, added: r.added };
  });

  const changes = {
    created: planned.filter((f) => f.status === 'create').map((f) => f.rel),
    updated: planned.filter((f) => f.status === 'update').map((f) => f.rel),
    kept: planned.filter((f) => f.status === 'kept').map((f) => f.rel),
    same: planned.filter((f) => f.status === 'same').map((f) => f.rel),
  };
  const manual = [];
  for (const p of patchPlan) {
    if (p.status === 'missing' || (p.status === 'absent' && ['src/app/layout.tsx', 'src/components/GoogleSignInButton.tsx'].includes(p.rel))) manual.push(p.manual);
  }
  const needsInstall = patchPlan.some((p) => p.status === 'apply' && p.rel === 'package.json');

  const result = {
    ok: true, kind, appId, appIdSource, url: facts.url, google: Boolean(google), dryRun: Boolean(opts.dryRun),
    ...changes, patched: patchPlan.filter((p) => p.status === 'apply').map((p) => p.rel), manual, warnings: ctx.warnings, supabase: null, needsInstall,
  };
  if (opts.dryRun) return result;

  for (const f of planned) {
    if (f.status !== 'create' && f.status !== 'update') continue;
    await mkdir(path.dirname(f.target), { recursive: true });
    await writeFile(f.target, f.wanted);
  }
  for (const p of patchPlan) {
    if (p.status === 'apply') await writeFile(path.join(appDir, ...p.rel.split('/')), p.newText);
  }

  // Google sign-in needs the phone app's return address in Supabase's allowed list (add-only).
  if (kind === 'mobile' && google && !opts.skipSupabase) {
    try {
      result.supabase = await addRedirects({ appDir, redirects: [`${appId}://auth/callback`] }, deps);
    } catch (err) {
      result.supabase = { status: 'failed', added: [], error: err.message };
    }
    if (result.supabase.status === 'no-project' || result.supabase.status === 'no-token' || result.supabase.status === 'failed') {
      manual.push(`In the Supabase dashboard: Authentication, URL Configuration, Redirect URLs. Add ${appId}://auth/callback (Google sign-in in the phone app does not work until it is there).`);
    }
  }

  const now = new Date().toISOString();
  const shells = { ...(config.shells ?? {}) };
  shells[kind] = { ...(shells[kind] ?? {}), appId, url: facts.url, google: kind === 'mobile' ? Boolean(google) : undefined, addedAt: shells[kind]?.addedAt ?? now, updatedAt: now };
  if (shells[kind].google === undefined) delete shells[kind].google;
  const fresh = await readAppConfig(appDir);
  await writeAppConfig(appDir, { ...fresh, shells });
  try {
    await profileApi.upsertApp({ slug: facts.slug, shells: Object.keys(shells) });
  } catch {
    // The profile is a convenience copy; the app folder is the source of truth.
  }
  return result;
}

/** What to tell the student to do next, in order. */
export function nextSteps(result) {
  const steps = [];
  if (result.kind === 'mobile') {
    if (result.needsInstall) steps.push('Run "npm install" in the app folder, then commit package.json and package-lock.json (the checks on GitHub need the new packages).');
    steps.push('cd mobile, then "npm install".');
    steps.push('"npm run icons" makes the store icon and splash picture from your app icon.');
    steps.push('"npm run add:ios" (Mac with Xcode) and/or "npm run add:android" (Android Studio), then "npm run apply-native".');
    steps.push('"npm run open:ios" or "npm run open:android" to try it on a phone. Read mobile/README.md for the rest.');
    steps.push('Deploy the web app again if package.json changed, so the website and the phone app match.');
  } else {
    steps.push('cd desktop, "npm install", then "npm start" to try the window. Commit the package-lock.json that "npm install" makes: GitHub builds the installers from it.');
    steps.push('Push a tag like desktop-v1.0.0 to build installers on GitHub (see desktop/README.md).');
  }
  steps.push('Run "node store-check.mjs <app folder>" to see what a store would still ask for.');
  return steps;
}
