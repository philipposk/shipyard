// Warn when an app's .gitignore does not hide the folders that can hold other sites' screenshots or brand files.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const listed = (text, dir) => new RegExp(`^/?${dir.replace('.', '\\.')}/?\\s*$`, 'm').test(text);

/** Returns a plain-English warning, or null when every folder in `dirs` is ignored. */
export async function missingGitignore(appDir, dirs = ['.shipyard']) {
  let text;
  try {
    text = await readFile(path.join(appDir, '.gitignore'), 'utf8');
  } catch {
    return `This app has no .gitignore, so ${dirs.map((d) => `${d}/`).join(' and ')} could end up in git (and on GitHub). Add a .gitignore with ${dirs.map((d) => `a line ${d}/`).join(' and ')} in it.`;
  }
  const missing = dirs.filter((d) => !listed(text, d));
  if (missing.length === 0) return null;
  const why = missing.includes('design-input')
    ? 'it can hold screenshots or style files from other sites, which should not go to GitHub'
    : 'the screenshots could end up in git';
  return `This app's .gitignore does not list ${missing.map((d) => `${d}/`).join(' and ')}, so ${why}. Add ${missing.length > 1 ? 'lines' : 'a line'} with ${missing.map((d) => `${d}/`).join(' and ')} to .gitignore.`;
}
