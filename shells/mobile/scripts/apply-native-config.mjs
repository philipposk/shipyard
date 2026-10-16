#!/usr/bin/env node
// Puts the app's settings into the phone projects that `npm run add:ios` and `npm run add:android` generate:
// permission texts, the sign-in return address, the privacy manifest (iOS), and the icon and splash pictures.
// Safe to run again: it never adds anything twice. Run it after every `cap add` and after changing native-config.json.
//   npm run apply-native
// Nothing here needs Xcode or Android Studio; it only edits text files and pictures.
import { readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, flatten, parseHex, pngInfo, resize, roundIcon, adaptiveForeground, splashPicture } from './png.mjs';
import {
  PERMISSIONS, plistSetString, plistAddUrlScheme, pbxAddPrivacyManifest,
  manifestAddPermission, manifestAddCallbackFilter, setLauncherBackground,
} from './native-edit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');

const exists = (p) => stat(p).then(() => true, () => false);
const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const readPng = async (p) => (await exists(p) ? decodePng(await readFile(p)) : null);

async function listFiles(dir, match) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (match.test(e.name)) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

export async function applyNative(root = mobileDir, say = console.log) {
  const result = { ios: false, android: false, notes: [] };
  const note = (kind, msg) => {
    result.notes.push(msg);
    say(`${kind} ${msg}`);
  };
  const config = await readJson(path.join(root, 'capacitor.config.json'), null);
  if (!config?.appId) {
    note('✗', 'capacitor.config.json is missing or has no appId.');
    return { ...result, ok: false };
  }
  const native = await readJson(path.join(root, 'native-config.json'), {});
  const permissions = Object.entries(native.permissions ?? {}).filter(([, text]) => typeof text === 'string' && text.trim());
  for (const [name] of Object.entries(native.permissions ?? {})) {
    if (!PERMISSIONS[name]) note('!', `native-config.json: "${name}" is not a permission this script knows (${Object.keys(PERMISSIONS).join(', ')}). Skipped.`);
  }
  const authReturn = native.authReturn === true;
  const scheme = config.appId;
  const bgHex = config.plugins?.SplashScreen?.backgroundColor ?? config.ios?.backgroundColor ?? '#ffffff';
  const bg = parseHex(bgHex) ?? [255, 255, 255];
  const icon = await readPng(path.join(root, 'resources', 'icon.png'));
  const mark = (await readPng(path.join(root, 'resources', 'icon-mark.png'))) ?? icon;
  if (!icon) note('!', 'resources/icon.png is missing, so the icons are not updated. Run "npm run icons" first.');

  // ----- iOS
  const plistPath = path.join(root, 'ios', 'App', 'App', 'Info.plist');
  if (await exists(plistPath)) {
    result.ios = true;
    let plist = await readFile(plistPath, 'utf8');
    const before = plist;
    for (const [name, text] of permissions) {
      if (PERMISSIONS[name]) plist = plistSetString(plist, PERMISSIONS[name].ios, text.trim());
    }
    if (authReturn) plist = plistAddUrlScheme(plist, scheme, `${scheme}.auth`);
    if (plist !== before) await writeFile(plistPath, plist);
    say(`✓ iOS: Info.plist ${plist !== before ? 'updated' : 'already up to date'}.`);

    const manifestSource = path.join(root, 'resources', 'PrivacyInfo.xcprivacy');
    if (await exists(manifestSource)) {
      await copyFile(manifestSource, path.join(root, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'));
      const pbxPath = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
      if (await exists(pbxPath)) {
        const pbx = pbxAddPrivacyManifest(await readFile(pbxPath, 'utf8'), config.appId);
        if (pbx.status === 'added') await writeFile(pbxPath, pbx.text);
        if (pbx.status === 'unsupported') note('!', 'iOS: could not add PrivacyInfo.xcprivacy to the Xcode project by itself. In Xcode, drag ios/App/App/PrivacyInfo.xcprivacy into the "App" folder and tick the App target.');
        else say(`✓ iOS: PrivacyInfo.xcprivacy ${pbx.status === 'added' ? 'added to the Xcode project' : 'already in the Xcode project'}.`);
      } else {
        note('!', 'iOS: the Xcode project file was not found. Add ios/App/App/PrivacyInfo.xcprivacy to the App target in Xcode.');
      }
    } else {
      note('!', 'iOS: resources/PrivacyInfo.xcprivacy is missing, so the privacy manifest was not added.');
    }

    if (icon) {
      const flat = flatten(icon, bg);
      const iconDir = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
      for (const file of await listFiles(iconDir, /\.png$/i)) {
        await writeFile(file, encodePng(resize(flat, 1024, 1024), { alpha: false }));
        say(`✓ iOS: icon -> ${path.relative(root, file)}`);
      }
      const splashDir = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'Splash.imageset');
      const splash = splashPicture(2732, 2732, bg, mark ?? icon);
      for (const file of await listFiles(splashDir, /\.png$/i)) {
        await writeFile(file, encodePng(splash, { alpha: false }));
        say(`✓ iOS: splash -> ${path.relative(root, file)}`);
      }
    }
  } else {
    say('  iOS: not generated yet (run "npm run add:ios" on a Mac with Xcode, then this again).');
  }

  // ----- Android
  const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (await exists(manifestPath)) {
    result.android = true;
    let manifest = await readFile(manifestPath, 'utf8');
    const before = manifest;
    manifest = manifestAddPermission(manifest, 'android.permission.INTERNET');
    for (const [name] of permissions) {
      for (const p of PERMISSIONS[name]?.android ?? []) manifest = manifestAddPermission(manifest, p);
    }
    if (authReturn) {
      const filter = manifestAddCallbackFilter(manifest, scheme);
      manifest = filter.text;
      if (filter.status === 'unsupported') note('!', 'Android: could not find MainActivity in AndroidManifest.xml, so the sign-in return address was not added. Add an intent-filter for the address by hand.');
    }
    if (manifest !== before) await writeFile(manifestPath, manifest);
    say(`✓ Android: AndroidManifest.xml ${manifest !== before ? 'updated' : 'already up to date'}.`);

    const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
    if (icon) {
      const flat = flatten(icon, bg);
      for (const file of await listFiles(res, /^ic_launcher(_round|_foreground)?\.png$/)) {
        const info = pngInfo(await readFile(file));
        if (!info) continue;
        const size = info.width;
        let out;
        if (file.endsWith('_foreground.png')) out = adaptiveForeground(mark ?? icon, size);
        else if (file.endsWith('_round.png')) out = roundIcon(resize(flat, size, size));
        else out = resize(flat, size, size);
        await writeFile(file, encodePng(out, { alpha: !file.endsWith('ic_launcher.png') }));
        say(`✓ Android: icon -> ${path.relative(root, file)}`);
      }
      const bgFile = path.join(res, 'values', 'ic_launcher_background.xml');
      if (await exists(bgFile)) {
        const iconColor = (() => {
          const px = flat.data;
          const mid = ((flat.height >> 1) * flat.width + 4) * 4; // left edge, middle row: the icon's own background
          return `#${[px[mid], px[mid + 1], px[mid + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        })();
        await writeFile(bgFile, setLauncherBackground(await readFile(bgFile, 'utf8'), iconColor));
      }
      const splashCache = new Map();
      for (const file of await listFiles(res, /^splash\.png$/)) {
        const info = pngInfo(await readFile(file));
        if (!info) continue;
        const key = `${info.width}x${info.height}`;
        if (!splashCache.has(key)) splashCache.set(key, splashPicture(info.width, info.height, bg, mark ?? icon));
        await writeFile(file, encodePng(splashCache.get(key), { alpha: false }));
        say(`✓ Android: splash -> ${path.relative(root, file)}`);
      }
    }
  } else {
    say('  Android: not generated yet (run "npm run add:android", then this again).');
  }

  if (!result.ios && !result.android) {
    say('  No phone projects on disk yet. After "npm run add:ios" or "npm run add:android", run "npm run apply-native".');
  }
  return { ...result, ok: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await applyNative();
    if (!r.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`✗ apply-native-config failed: ${err.message}`);
    process.exitCode = 1;
  }
}
