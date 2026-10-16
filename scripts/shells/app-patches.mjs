// Edits add-shell makes to the web app's own files. Each takes text and returns { status, text }:
//   'apply' (changed), 'present' (already done) or 'missing' (the spot was not found: tell the student what to add by hand).
import { addImports, insertAtAnchor } from '../modules/patch.mjs';

/** Add folders to ESLint's ignore list so it does not check the phone and desktop code. */
export function patchEslint(text, globs) {
  const m = /globalIgnores\(\[([^\]]*)\]\)/.exec(text);
  if (!m) return { status: 'missing', text };
  const need = globs.filter((g) => !m[1].includes(`"${g}"`) && !m[1].includes(`'${g}'`));
  if (need.length === 0) return { status: 'present', text };
  const inner = m[1].trimEnd().replace(/,$/, '');
  const next = `${inner}, ${need.map((g) => `"${g}"`).join(', ')}`;
  return { status: 'apply', text: text.replace(m[0], `globalIgnores([${next}])`) };
}

/** Add folders to tsconfig's "exclude" so TypeScript does not look inside them. */
export function patchTsconfig(text, dirs) {
  const m = /("exclude"\s*:\s*\[)([^\]]*)(\])/.exec(text);
  if (!m) return { status: 'missing', text };
  const need = dirs.filter((d) => !m[2].includes(`"${d}"`));
  if (need.length === 0) return { status: 'present', text };
  const inner = m[2].trimEnd().replace(/,$/, '');
  const next = `${inner}${inner ? ', ' : ''}${need.map((d) => `"${d}"`).join(', ')}`;
  return { status: 'apply', text: text.replace(m[0], `${m[1]}${next}${m[3]}`) };
}

/** Add packages to package.json dependencies (an existing entry is left alone). Returns { status, text, added }. */
export function patchPackageDeps(text, deps) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { status: 'missing', text, added: [] };
  }
  pkg.dependencies = pkg.dependencies ?? {};
  const added = [];
  for (const [name, version] of Object.entries(deps)) {
    if (!(name in pkg.dependencies)) {
      pkg.dependencies[name] = version;
      added.push(`${name}@${version}`);
    }
  }
  if (added.length === 0) return { status: 'present', text, added };
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = `${JSON.stringify(pkg, null, 2)}\n`.replace(/\n/g, eol);
  return { status: 'apply', text: out, added };
}

/** Mount <NativeAuthReturn /> once in the root layout. */
export function patchLayout(text) {
  if (text.includes('NativeAuthReturn')) return { status: 'present', text };
  const placed = insertAtAnchor(text, { anchor: '<PwaRegister />', position: 'before', insert: '<NativeAuthReturn />' });
  if (!placed.ok) return { status: 'missing', text };
  // The anchor line is `{ENABLE_PWA ? <PwaRegister /> : null}`; put the component on its own line before it.
  const withImport = addImports(placed.text, ['import NativeAuthReturn from "@/components/NativeAuthReturn";']);
  return { status: 'apply', text: withImport.text };
}

/** Let the Google button hand over to the phone browser when it runs inside the phone app. */
export function patchGoogleButton(text) {
  if (text.includes('signInGoogleNative')) return { status: 'present', text };
  const placed = insertAtAnchor(text, { anchor: 'async function signIn() {', position: 'after', insert: '  if (await signInGoogleNative()) return;' });
  if (!placed.ok) return { status: 'missing', text };
  const withImport = addImports(placed.text, ['import { signInGoogleNative } from "@/lib/native-auth";']);
  return { status: 'apply', text: withImport.text };
}
