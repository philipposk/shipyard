// The real previews show the app's own home text (src/lib/home-content.ts). A brand-new app still has the
// template's stand-in words, so every look is judged on filler. This spots that.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { agentName } from '../lib/agent.mjs';

const FILLER = 'A short description of this app.';

/** A plain-English warning when the home text is still the template's, else null. */
export async function homeContentWarning(appDir) {
  try {
    const text = await readFile(path.join(appDir, 'src', 'lib', 'home-content.ts'), 'utf8');
    if (text.includes(FILLER)) {
      return `The home text in src/lib/home-content.ts is still the template's stand-in words ("${FILLER}"). The screenshots will show them in every look. Write the real words for this app first (ask ${agentName()} to fill in home-content.ts), then take the screenshots again.`;
    }
  } catch { /* no such file (a custom app): nothing to say */ }
  return null;
}
