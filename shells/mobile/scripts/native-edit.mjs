// Small text edits for the files Capacitor generates (iOS Info.plist and project file, Android manifest).
// Every function takes text and returns text, never edits twice, and never touches the disk.
// Shipyard copies this file into the app's mobile/scripts folder; the plugin's tests import it from shells/mobile/scripts.

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What each permission in native-config.json turns into on each phone system. */
export const PERMISSIONS = {
  camera: { ios: 'NSCameraUsageDescription', android: ['android.permission.CAMERA'] },
  microphone: { ios: 'NSMicrophoneUsageDescription', android: ['android.permission.RECORD_AUDIO'] },
  location: { ios: 'NSLocationWhenInUseUsageDescription', android: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'] },
  photos: { ios: 'NSPhotoLibraryUsageDescription', android: ['android.permission.READ_MEDIA_IMAGES'] },
};

// ---------------------------------------------------------------------------------------------
// iOS Info.plist

const keyRe = (key) => new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</key>`);

export function plistHasKey(text, key) {
  return keyRe(key).test(text);
}

/** Set a text value: replaces the current one, or adds the key before the end of the file. */
export function plistSetString(text, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[\\s\\S]*?(</string>)`);
  if (re.test(text)) return text.replace(re, (_m, a, b) => `${a}${xmlEscape(value)}${b}`);
  const end = text.lastIndexOf('</dict>');
  if (end === -1) throw new Error('Info.plist has no closing </dict>.');
  return `${text.slice(0, end)}\t<key>${key}</key>\n\t<string>${xmlEscape(value)}</string>\n${text.slice(end)}`;
}

/** Register a custom address scheme (used to come back from the system browser after Google sign-in). */
export function plistAddUrlScheme(text, scheme, name) {
  if (text.includes(`<string>${scheme}</string>`) && /CFBundleURLSchemes/.test(text)) return text;
  const entry = `\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>${xmlEscape(name)}</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${xmlEscape(scheme)}</string>\n\t\t\t</array>\n\t\t</dict>\n`;
  const m = /<key>CFBundleURLTypes<\/key>\s*<array>\s*\n/.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + entry + text.slice(m.index + m[0].length);
  const end = text.lastIndexOf('</dict>');
  if (end === -1) throw new Error('Info.plist has no closing </dict>.');
  return `${text.slice(0, end)}\t<key>CFBundleURLTypes</key>\n\t<array>\n${entry}\t</array>\n${text.slice(end)}`;
}

// ---------------------------------------------------------------------------------------------
// Xcode project: make sure PrivacyInfo.xcprivacy is part of the app

const pbxId = (seed, n) => {
  // 24 hex characters that depend on the seed (stable between runs, so a second run finds its own work).
  let h = 0x811c9dc5;
  const out = [];
  for (let i = 0; i < 24; i++) {
    for (const ch of `${seed}:${n}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out.push((h & 0xf).toString(16).toUpperCase());
  }
  return out.join('');
};

/** Returns { text, status: 'added' | 'present' | 'unsupported' }. */
export function pbxAddPrivacyManifest(text, seed = 'privacy-manifest') {
  if (text.includes('PrivacyInfo.xcprivacy')) return { text, status: 'present' };
  const info = /(\t+)([0-9A-F]{24}) \/\* Info\.plist \*\/,/.exec(text);
  const resources = /([0-9A-F]{24}) \/\* Resources \*\/ = \{\s*isa = PBXResourcesBuildPhase;[\s\S]*?files = \(\n/.exec(text);
  if (!info || !resources || !text.includes('/* End PBXBuildFile section */') || !text.includes('/* End PBXFileReference section */')) {
    return { text, status: 'unsupported' };
  }
  const fileId = pbxId(seed, 'file');
  const buildId = pbxId(seed, 'build');
  let out = text;
  out = out.replace('/* End PBXBuildFile section */', `\t\t${buildId} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* PrivacyInfo.xcprivacy */; };\n/* End PBXBuildFile section */`);
  out = out.replace('/* End PBXFileReference section */', `\t\t${fileId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n/* End PBXFileReference section */`);
  out = out.replace(info[0], `${info[0]}\n${info[1]}${fileId} /* PrivacyInfo.xcprivacy */,`);
  const again = /([0-9A-F]{24}) \/\* Resources \*\/ = \{\s*isa = PBXResourcesBuildPhase;[\s\S]*?files = \(\n/.exec(out);
  const at = again.index + again[0].length;
  out = `${out.slice(0, at)}\t\t\t\t${buildId} /* PrivacyInfo.xcprivacy in Resources */,\n${out.slice(at)}`;
  return { text: out, status: 'added' };
}

/** The bundle id Xcode will build with, or '' (it is set by `cap add ios`). */
export function pbxBundleId(text) {
  const m = /PRODUCT_BUNDLE_IDENTIFIER = ([^;\s]+);/.exec(text);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------------------------
// Android manifest

export function manifestHasPermission(text, name) {
  return text.includes(`android:name="${name}"`);
}

export function manifestAddPermission(text, name) {
  if (manifestHasPermission(text, name)) return text;
  const uses = [...text.matchAll(/^([ \t]*)<uses-permission [^>]*\/>[ \t]*$/gm)];
  const line = (indent) => `${indent}<uses-permission android:name="${name}" />`;
  if (uses.length > 0) {
    const last = uses[uses.length - 1];
    const at = last.index + last[0].length;
    return `${text.slice(0, at)}\n${line(last[1])}${text.slice(at)}`;
  }
  const close = text.lastIndexOf('</manifest>');
  if (close === -1) throw new Error('AndroidManifest.xml has no closing </manifest>.');
  return `${text.slice(0, close)}${line('    ')}\n${text.slice(close)}`;
}

/** The sign-in return address: `<scheme>://auth/callback` opens the app. Returns { text, status }. */
export function manifestAddCallbackFilter(text, scheme) {
  if (text.includes(`android:scheme="${scheme}"`)) return { text, status: 'present' };
  const idx = text.indexOf('android:name=".MainActivity"');
  const end = idx === -1 ? -1 : text.indexOf('</activity>', idx);
  if (end === -1) return { text, status: 'unsupported' };
  const lineStart = text.lastIndexOf('\n', end) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))[0];
  const block = [
    '<intent-filter>',
    '    <action android:name="android.intent.action.VIEW" />',
    '    <category android:name="android.intent.category.DEFAULT" />',
    '    <category android:name="android.intent.category.BROWSABLE" />',
    `    <data android:scheme="${xmlEscape(scheme)}" android:host="auth" android:pathPrefix="/callback" />`,
    '</intent-filter>',
    '',
  ].map((l) => (l ? `${indent}    ${l}` : l)).join('\n');
  return { text: `${text.slice(0, lineStart)}${block}\n${text.slice(lineStart)}`, status: 'added' };
}

/** `<color name="ic_launcher_background">#xxxxxx</color>` */
export function setLauncherBackground(text, hex) {
  const re = /(<color name="ic_launcher_background">)[^<]*(<\/color>)/;
  if (re.test(text)) return text.replace(re, `$1${hex}$2`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex}</color>\n</resources>\n`;
}
