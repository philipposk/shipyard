// Turns what we know about the app into the text files of the mobile and desktop folders.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_ROOT } from '../lib/paths.mjs';
import { agentName } from '../lib/agent.mjs';

export const SHELLS_DIR = path.join(PLUGIN_ROOT, 'shells');

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON that is safe to put inside a <script> tag. */
export const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Replace {{KEY}} with values. A key that has no value is an error (a template typo must not ship). */
export function fill(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key) => {
    if (!(key in values)) throw new Error(`Template needs a value for ${key}.`);
    return values[key];
  });
}

/** Cut at a word boundary so the result has at most `max` characters. */
export function fitWords(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > 8 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[\s,;:–-]+$/, '');
}

const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'that', 'this', 'from', 'are', 'app', 'can', 'all', 'one', 'into', 'have', 'has', 'will', 'its', 'our', 'their', 'what', 'when', 'where', 'more', 'than', 'just', 'any', 'out']);

/** Up to 100 characters of comma-separated words (the App Store limit), taken from the name and the description. */
export function makeKeywords({ name, tagline, description }) {
  const seen = new Set();
  const words = [];
  for (const raw of `${name} ${tagline} ${description}`.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
  }
  let out = '';
  for (const w of words) {
    const next = out ? `${out},${w}` : w;
    if (next.length > 100) break;
    out = next;
  }
  return out;
}

export async function renderOffline(facts, targetUrl) {
  const template = await readFile(path.join(SHELLS_DIR, 'shared', 'offline.html'), 'utf8');
  const { light, dark, radius } = facts.colors;
  const icon = facts.iconSvg
    ? `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(facts.iconSvg).toString('base64')}">`
    : '';
  const values = {
    NAME: escapeHtml(facts.name),
    ICON: icon,
    RADIUS: radius,
    URL_JSON: jsonForScript(targetUrl),
  };
  for (const [prefix, set] of [['LIGHT', light], ['DARK', dark]]) {
    for (const key of ['background', 'foreground', 'card', 'muted', 'line', 'accent', 'accent-contrast']) {
      values[`${prefix}_${key.toUpperCase().replace(/-/g, '_')}`] = set[key];
    }
  }
  return fill(template, values);
}

export function renderStoreMd(facts, { appId, google }) {
  const { name, url, host } = facts;
  const subtitle = fitWords(facts.tagline || facts.description || name, 30) || fitWords(name, 30);
  const shortDescription = fitWords(facts.description || facts.tagline || `${name} on your phone.`, 80);
  const keywords = makeKeywords(facts) || name.toLowerCase().replace(/[^a-z0-9]+/g, ',');
  const points = facts.homePoints.map((p) => `- ${p.title}: ${p.text}`).join('\n');
  const signIn = google ? 'Sign in with Google, or with your email and a password.' : 'Sign in with your email and a password.';
  const hasBilling = facts.modules.includes('billing');
  const hasNewsletter = facts.modules.includes('newsletter');
  const lines = [];
  const add = (...l) => lines.push(...l);
  add(
    `# ${name}: store listing draft`,
    '',
    `The phone app is your live website (${url}) inside an app. This is draft text for App Store Connect and Google Play Console. Nothing here was uploaded. Edit anything, then copy it into the consoles. Run \`node store-check.mjs <app folder>\` (in the Shipyard scripts folder) to see what is still missing.`,
    '',
    '## Listing',
    '',
    'Limits: name 30 characters, subtitle 30 (App Store), short description 80 (Google Play), keywords 100 in total. Category: pick the one that fits your app best.',
    '',
    `- **Name:** ${fitWords(name, 30)}`,
    `- **Subtitle:** ${subtitle}`,
    `- **Short description:** ${shortDescription}`,
    '- **Category:** Productivity',
    '- **Age rating suggestion:** 4+. This is only a starting point: answer the age questionnaires from what people can really do in the app. If people can post things that other people see, say so.',
    `- **Keywords:** ${keywords}`,
    `- **Support URL:** ${url}/help`,
    `- **Privacy policy URL:** ${url}/privacy`,
    `- **Terms URL:** ${url}/terms`,
    `- **Marketing URL:** ${url}`,
    `- **Support email:** ${facts.contactEmail}`,
    `- **App id:** ${appId}`,
    '',
    '## Description',
    '',
    facts.description || `${name} for your phone.`,
  );
  if (points) add('', points);
  add(
    '',
    `Your account and everything you add is the same as on ${host}. ${signIn}`,
    '',
    'You can delete your account at any time in Settings.',
    '',
    "## What's new (1.0)",
    '',
    'First release.',
    '',
    '## Privacy answers (App Privacy form and Data safety form)',
    '',
    'The phone app adds no analytics, no ads and no tracking of its own. It only shows the website, so the answers are the ones in your privacy policy:',
    '',
    '- Account: email address, and the profile details the person enters.',
    '- Content: what the person saves in the app.',
  );
  if (hasBilling) add('- Payments: handled by Stripe. The app never sees or stores a card number.');
  if (hasNewsletter) add('- Email: only people who tick the box get updates, and every email has an unsubscribe link.');
  add(
    '- Not collected: location, contacts, photos, advertising id (unless you added a feature that asks for them in native-config.json).',
    '',
    'Keep these answers the same as `' + url + '/privacy`. If the policy changes, update the forms.',
    '',
    '## Notes for the app reviewers',
    '',
    `- The app opens ${url} in a web view. It also works as a website.`,
    '- Account deletion: Settings, then "Delete my account".',
    '- Give reviewers a demo login in the review notes box of App Store Connect and Play Console. Never write the password in this file or in git.',
  );
  if (google) {
    add(
      '- Apple rule 4.8: an app that offers Google sign-in must also offer an equivalent option such as Sign in with Apple. Add it before you submit to the App Store, or remove Google sign-in from the iPhone app.',
    );
  }
  if (hasBilling) {
    add('- Apple rule 3.1.1: digital things used inside an iPhone app usually must be sold with Apple in-app purchase. Read the current rule before you show prices in the iPhone app.');
  }
  add(
    '',
    '## Before you submit',
    '',
    '- [ ] Apple Developer Program (99 USD a year) and Google Play Console (25 USD once) accounts',
    '- [ ] Screenshots from a real build, in the sizes the store consoles ask for',
    '- [ ] Demo login for reviewers written into the review notes',
    '- [ ] App Privacy form and Data safety form filled in to match the privacy policy',
    '- [ ] Age rating and content rating questionnaires answered honestly',
    '- [ ] Version and build number raised for every upload',
    '- [ ] Google Play: a closed test with at least 12 testers for 14 days before you can publish (personal accounts opened after 13 November 2023)',
    '',
  );
  return lines.join('\n');
}

export function renderMobileReadme(facts, { appId, google, versions }) {
  const { name, url } = facts;
  return `# ${name}: phone app

A thin iPhone and Android app around your live website. \`capacitor.config.json\` points the app at ${url}, so every time you deploy the website, the phone app shows the new version. No new store upload is needed for website changes.

Built with Capacitor ${versions.capacitor['@capacitor/core'].split('.')[0]} (the tool that wraps a website in a phone app). The folder \`www/\` only holds the "You're offline" page.

App id: \`${appId}\`. It is the app's permanent name on phones. Do not change it after the app is in a store.

## Costs and rules

- Apple Developer Program: 99 USD a year, and a Mac with Xcode (free) to build the iPhone app.
- Google Play Console: 25 USD once. New personal accounts must run a closed test with 12 testers for 14 days before they can publish.
- Apple may refuse an app that is only a website in a frame (rule 4.2). Give the app something that feels like an app: a designed offline page (done), a native feature in the main use (camera, share, notifications), and a demo login for reviewers. \`STORE.md\` lists the review notes.

## Steps (you run these, ${agentName()} does not build the phone projects)

1. Install what the phone tools need: Node 22 or newer. For iPhone: a Mac with Xcode. For Android: Android Studio.
2. In this folder run \`npm install\`.
3. Make the icon and splash picture from the app's icon: \`npm run icons\`. (Needs \`npm install\` to have run in the app folder one level up, and a browser for Playwright: \`npx playwright install chromium\` there.)
4. Add the phone projects once:
   - iPhone (Mac only): \`npm run add:ios\`
   - Android: \`npm run add:android\`
5. Put the app's settings into them: \`npm run apply-native\`. Run it again after every \`add:ios\` or \`add:android\`, and after changing \`native-config.json\`.
6. Open the project and run it on a real phone or a simulator: \`npm run open:ios\` or \`npm run open:android\`.
7. Test sign-in${google ? ' (including Google) ' : ' '}on a real phone, not only the simulator.
8. Fill in \`STORE.md\`, take screenshots, build the release in Xcode or Android Studio and upload it in the store console.

Check your progress any time with \`node store-check.mjs <app folder>\` from the Shipyard scripts folder.

## Permissions

If your app uses the camera, microphone, location or photos, add a line in \`native-config.json\` with a plain sentence that the person sees in the permission box, then run \`npm run apply-native\`. Apple rejects apps that ask without a good reason in that sentence.

${google ? `## Google sign-in

Google does not allow sign-in inside an app's built-in browser. In the phone app, "Continue with Google" opens the phone's own browser and comes back to the app on \`${appId}://auth/callback\`. Shipyard added the pieces to the web app (\`src/lib/native-auth.ts\`, \`src/components/NativeAuthReturn.tsx\`) and the address to your Supabase sign-in settings. Because Google is offered, Apple also requires Sign in with Apple in the iPhone app (rule 4.8).

` : ''}## Good to know

- Edit the website, not this folder, to change what the app does.
- If the website is down, people see the offline page in \`www/index.html\`.
- Pinned versions are in \`package.json\`. Update them on purpose, one at a time.
`;
}

export function renderDesktopReadme(facts, { appId, versions }) {
  const { name, url } = facts;
  return `# ${name}: desktop app

A small desktop window (Electron, a tool that puts a website in its own window) that shows ${url}. It adds no extra features. The page cannot touch the computer's files, links to other sites open in the normal browser, and the window cannot leave the app's own address.

## Try it on your computer

\`\`\`bash
cd desktop
npm install      # downloads Electron, a few hundred MB, first time only
npm start
\`\`\`

To try it against the app running on your own computer: \`SHIPYARD_DESKTOP_URL=http://localhost:3000 npm start\` (works only before the app is installed).

## Make installers

\`npm run dist:mac\` (on a Mac) or \`npm run dist:win\` (on Windows) makes an installer in \`dist/\`. Both are unsigned, so people see a warning the first time:

- macOS (version 15 and newer): the first time, open the app and let macOS refuse it, then go to System Settings > Privacy & Security, scroll down and press "Open Anyway". A downloaded unsigned app can also show as "damaged"; the same button fixes it. Signing and notarizing for everyone needs a paid Apple Developer account (99 USD a year).
- Windows: SmartScreen says "unknown publisher". A code-signing certificate (paid) removes that.

## Releases from GitHub

\`.github/workflows/desktop-release.yml\` builds both installers on GitHub's computers. Run \`npm install\` once in \`desktop/\` and commit the \`package-lock.json\` it makes (GitHub then installs exactly those versions). Set \`version\` in \`desktop/package.json\`, commit, then:

\`\`\`bash
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
\`\`\`

GitHub then attaches the installers to a Release. On a private repository this uses your free Actions minutes, and macOS minutes count about 10 times as much as Linux minutes.

## Good to know

- Google sign-in does not work inside a desktop window (Google blocks it). Use email and password in the desktop app.
- If a feature needs the camera or microphone, add "media" to \`permissions\` in \`app.json\`. Everything not listed there is refused.
- Microsoft Store: opening a developer account is free for individuals, but a store package needs its own steps. Mac App Store needs more work (sandboxing). Neither is set up here.
- App id: \`${appId}\`. Pinned versions: Electron ${versions.desktop.electron}, electron-builder ${versions.desktop['electron-builder']}.
`;
}
