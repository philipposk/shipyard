// Small, reversible edits to the student's app so the video folder does not get in the way of its normal checks,
// and so the published video files can be opened by signed-out visitors. Each patch is a no-op when already applied
// and tells the student plainly when the file looks different from the template (then they get the manual step).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './common.mjs';

/** Insert `entry` as the last item of the array literal found by `re` (its group 1 is the array's inner text). */
function appendToArray(text, re, entry) {
  const m = re.exec(text);
  if (!m) return null;
  const inner = m[1];
  const trimmed = inner.replace(/\s+$/, '');
  const tail = inner.slice(trimmed.length);
  const sep = trimmed === '' ? '' : trimmed.endsWith(',') ? ' ' : ', ';
  const replaced = m[0].replace(inner, `${trimmed}${sep}${entry}${tail}`);
  return text.slice(0, m.index) + replaced + text.slice(m.index + m[0].length);
}

/**
 * The app's `tsc` (npm run typecheck, the CI build) and `eslint .` would otherwise read the video folder's React code
 * and its installed packages. Add `video` to tsconfig "exclude" and `video/**` to the ESLint ignores.
 * Returns [{ file, status: 'patched'|'already'|'manual'|'missing', note }].
 */
export async function patchAppForVideo(appDir) {
  const results = [];

  const tsconfig = path.join(appDir, 'tsconfig.json');
  if (!(await pathExists(tsconfig))) {
    results.push({ file: 'tsconfig.json', status: 'missing', note: 'No tsconfig.json found, nothing to change.' });
  } else {
    const text = await readFile(tsconfig, 'utf8');
    if (/"exclude"\s*:\s*\[[^\]]*"video"/.test(text)) {
      results.push({ file: 'tsconfig.json', status: 'already', note: '' });
    } else {
      const next = appendToArray(text, /"exclude"\s*:\s*\[([^\]]*)\]/, '"video"');
      if (next) {
        await writeFile(tsconfig, next);
        results.push({ file: 'tsconfig.json', status: 'patched', note: 'Added "video" to "exclude" so the app checks skip the video folder.' });
      } else {
        results.push({ file: 'tsconfig.json', status: 'manual', note: 'Add "video" to the "exclude" list in tsconfig.json so the app checks skip the video folder.' });
      }
    }
  }

  let eslintFile = null;
  for (const name of ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts']) {
    if (await pathExists(path.join(appDir, name))) {
      eslintFile = name;
      break;
    }
  }
  if (!eslintFile) {
    results.push({ file: 'eslint.config.mjs', status: 'missing', note: 'No ESLint config found, nothing to change.' });
  } else {
    const file = path.join(appDir, eslintFile);
    const text = await readFile(file, 'utf8');
    if (/["']video\/\*\*["']/.test(text)) {
      results.push({ file: eslintFile, status: 'already', note: '' });
    } else {
      const next = appendToArray(text, /globalIgnores\(\s*\[([^\]]*)\]/, '"video/**"');
      if (next) {
        await writeFile(file, next);
        results.push({ file: eslintFile, status: 'patched', note: 'Added "video/**" to the ignored folders so the lint check skips the video folder.' });
      } else {
        results.push({ file: eslintFile, status: 'manual', note: `Add "video/**" to the ignored folders in ${eslintFile} so the lint check skips the video folder.` });
      }
    }
  }
  return results;
}

/**
 * The template's proxy sends signed-out visitors to /sign-in for every path except the static file types in its matcher.
 * A homepage video (mp4, webm) and its captions (vtt) must be reachable without signing in, so add them to that list.
 */
export async function patchProxyForVideo(appDir) {
  const file = path.join(appDir, 'src', 'proxy.ts');
  if (!(await pathExists(file))) {
    return { file: 'src/proxy.ts', status: 'missing', note: 'No src/proxy.ts found, nothing to change.' };
  }
  const text = await readFile(file, 'utf8');
  if (/\|mp4\b/.test(text)) return { file: 'src/proxy.ts', status: 'already', note: '' };
  const re = /(\.\*\\\\\.\(\?:[^)\n]*?\bxml)\)\$/;
  if (!re.test(text)) {
    return {
      file: 'src/proxy.ts',
      status: 'manual',
      note: 'Add mp4, webm and vtt to the list of static file types in the matcher at the bottom of src/proxy.ts, so signed-out visitors can play the video.',
    };
  }
  await writeFile(file, text.replace(re, '$1|mp4|webm|vtt)$'));
  return { file: 'src/proxy.ts', status: 'patched', note: 'Added mp4, webm and vtt to the static file types in the proxy matcher, so signed-out visitors can play the video.' };
}
