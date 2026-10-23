// Check (no network): problems found across real 6x7 apps in Oct 2026 that the other checks miss.
//   1. Links and buttons with no accessible name (icon-only, or text hidden at phone size). Lighthouse "link-name"/"button-name".
//   2. The app is still marked private (noindex) although it has public pages. Reported as a warning, not a failure:
//      private can be on purpose, but the owner must say so.
//   3. CI that cannot pass: `uses: ./local-action` that does not exist, `npm ci` with no package-lock.json,
//      a package-lock.json out of step with package.json, or workspace packages tests import from dist/ without a build step first.
//   4. Sign-in API routes that crash when Supabase env vars are missing (`process.env.X!`) instead of answering cleanly.
//   5. Pages that lock zoom, an SPA rewrite that serves index.html as /robots.txt, no meta description,
//      and an accent colour used as text that is unreadable on the dark background.
//   6. Search and launch (warnings): no robots or sitemap, no canonical/metadataBase, a hard-coded noindex outside the
//      private switch, a shared Supabase app whose auth cookie has no domain, images in public/ without a source log.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripComments, pass, failed } from './util.mjs';

const exists = async (p) => stat(p).then(() => true, () => false);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', '.vercel']);

async function walk(dir, test, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

const HIDDEN_CLASS = /className\s*=\s*["{`][^>]*?(?:^|[\s"'`:])hidden\b/;

/** Links/buttons in JSX source with no accessible name. Returns [{ line, snippet }]. Pure: exported for tests. */
export function unlabeledControls(source) {
  const code = stripComments(source);
  const out = [];
  const re = /<(Link|a|button)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(code))) {
    const [whole, tag, attrs, selfClose] = m;
    if (/\baria-label(?:ledby)?\s*=|\btitle\s*=|\{\s*\.\.\./.test(attrs)) continue;
    if (selfClose) { out.push({ index: m.index, snippet: whole }); continue; }
    const end = code.indexOf(`</${tag}>`, re.lastIndex);
    if (end < 0) continue;
    let inner = code.slice(re.lastIndex, end);
    // Text inside elements hidden at some size does not name the control at that size.
    inner = inner.replace(/<(\w+)\b([^>]*)>[\s\S]*?<\/\1>/g, (all, _t, a) => (HIDDEN_CLASS.test(`className=${a.split('className=')[1] ?? ''}`) && /\bhidden\b/.test(a) ? '' : all));
    // Elements whose own attributes say aria-label count as a name.
    if (/aria-label\s*=|\balt\s*=\s*["{][^"}]/.test(inner)) continue;
    const text = inner.replace(/<[A-Z][\w.]*\b[^>]*\/>/g, '').replace(/<\/?[^>]+>/g, '').trim();
    if (!text) out.push({ index: m.index, snippet: whole });
  }
  return out.map((o) => ({ line: code.slice(0, o.index).split('\n').length, snippet: o.snippet.replace(/\s+/g, ' ').slice(0, 90) }));
}

/** package-lock.json root deps must equal package.json deps. Returns problem strings. Pure: exported for tests. */
export function lockDrift(pkg, lock) {
  const root = lock?.packages?.[''];
  if (!root) return [];
  const problems = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const want = pkg[field] ?? {};
    const have = root[field] ?? {};
    for (const [name, spec] of Object.entries(want)) {
      if (have[name] !== spec) problems.push(`${name} ${spec} is in package.json ${field} but the lock file has ${have[name] ?? 'nothing'}`);
    }
    for (const name of Object.keys(have)) if (!(name in want)) problems.push(`${name} is in the lock file but not in package.json ${field}`);
  }
  return problems;
}

/** Viewport settings that stop pinch-zoom (WCAG 1.4.4, Lighthouse meta-viewport). Pure: exported for tests. */
export function zoomLock(source) {
  const code = stripComments(source);
  return /maximumScale\s*:\s*1(?:\.0)?\b|userScalable\s*:\s*false|user-scalable\s*=\s*(?:no|0)\b|maximum-scale\s*=\s*1(?:\.0)?\b/.test(code);
}

const hexLum = (h) => {
  let x = h.replace('#', '');
  if (x.length === 3) x = [...x].map((c) => c + c).join('');
  const c = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const [x, y] = [hexLum(a), hexLum(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05); };

const DARK_BLOCK = /(?:\.dark|\[data-theme=["']?dark["']?\]|@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^{]*)\s*\{([^}]*)\}/g;
const varsIn = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

/** `color: var(--accent)` where the dark theme's accent (often unchanged from light) fails 4.5:1 on the dark background.
 *  Returns [{ token, ratio, fg, bg }]. Pure: exported for tests. */
export function darkAccentText(css) {
  const code = stripComments(css);
  const root = Object.assign({}, ...[...code.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => varsIn(m[1])));
  const dark = Object.assign({}, ...[...code.matchAll(DARK_BLOCK)].map((m) => varsIn(m[1])));
  if (!Object.keys(dark).length) return [];
  const bgName = ['background', 'bg', 'surface', 'card'].find((n) => /^#[0-9a-f]{3,6}$/i.test(dark[n] ?? ''));
  if (!bgName) return [];
  const used = new Set([...code.matchAll(/(?:^|[;{\s])color\s*:\s*var\(--(accent[\w-]*|primary[\w-]*|brand[\w-]*)\)/g)].map((m) => m[1]));
  const out = [];
  for (const token of used) {
    const fg = dark[token] ?? root[token];
    if (!/^#[0-9a-f]{3,6}$/i.test(fg ?? '')) continue;
    const ratio = contrast(fg, dark[bgName]);
    if (ratio < 4.5) out.push({ token, ratio: Math.round(ratio * 100) / 100, fg, bg: dark[bgName] });
  }
  return out;
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export async function check(ctx) {
  const name = 'hygiene';
  const problems = [];
  const details = [];
  const warnings = [];
  const dir = ctx.appDir;
  const srcDir = (await exists(path.join(dir, 'src'))) ? path.join(dir, 'src') : dir;

  // 1. Accessible names.
  const files = await walk(srcDir, (n) => /\.(tsx|jsx)$/.test(n) && !/\.test\./.test(n));
  let bad = 0;
  for (const f of files) {
    for (const u of unlabeledControls(await readFile(f, 'utf8'))) {
      bad++;
      if (bad <= 10) problems.push(`${path.relative(dir, f)}:${u.line} ${u.snippet} has no name a screen reader can read (text hidden at some sizes counts as none). Add aria-label`);
    }
  }
  // 1b. ARIA roles that promise a widget the markup does not deliver (Lighthouse aria-required-children).
  for (const f of files) {
    const code = stripComments(await readFile(f, 'utf8'));
    const lists = (code.match(/role\s*=\s*["']tablist["']/g) ?? []).length;
    const tabs = (code.match(/role\s*=\s*["']tab["']/g) ?? []).length;
    if (lists && !tabs) problems.push(`${path.relative(dir, f)} has role="tablist" but no role="tab" children. Use real tabs (tab, tabpanel, aria-selected, arrow keys) or drop the role and use plain buttons with aria-pressed`);
    const menus = (code.match(/role\s*=\s*["']menu["']/g) ?? []).length;
    if (menus && !/role\s*=\s*["']menuitem/.test(code)) problems.push(`${path.relative(dir, f)} has role="menu" but no role="menuitem" children. Drop the role or add the items`);
  }
  if (bad > 10) problems.push(`...and ${bad - 10} more links or buttons without a name`);
  if (!bad) details.push(`${files.length} component files: every link and button has a name`);

  // 1c. Animations of properties the browser cannot hand to the GPU (Lighthouse non-composited-animations). Warning.
  const styles = await walk(srcDir, (n) => /\.(css|scss)$/.test(n));
  const SLOW = /\b(border(?:-[a-z]+)*|width|height|top|left|right|bottom|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|box-shadow|background-color|color|filter)\b/;
  for (const f of styles) {
    const css = stripComments(await readFile(f, 'utf8'));
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)) {
      const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]).filter((p) => SLOW.test(p) && p !== 'transform' && p !== 'opacity');
      if (props.length) warnings.push(`${path.relative(dir, f)} @keyframes ${m[1]} animates ${[...new Set(props)].join(', ')}. Animate transform and opacity only (e.g. a scaled pseudo-element instead of border)`);
    }
  }

  // 1d. Content-Security-Policy with script-src (Lighthouse csp-xss). Warning.
  const nextConfig = await readFile(path.join(dir, 'next.config.ts'), 'utf8').catch(() => readFile(path.join(dir, 'next.config.mjs'), 'utf8').catch(() => ''));
  const proxyCode = await readFile(path.join(srcDir, 'proxy.ts'), 'utf8').catch(() => '');
  if (nextConfig && !/script-src/.test(nextConfig + proxyCode)) warnings.push('No Content-Security-Policy with script-src (Lighthouse csp-xss). Add one with a per-request nonce in src/proxy.ts');

  // 2. Private marker.
  const env = await readFile(path.join(dir, '.env.local'), 'utf8').catch(() => '');
  for (const marker of ['.6x7-private', '.shipyard-private']) {
    if (await exists(path.join(dir, marker))) warnings.push(`${marker} is present, so every page is noindex and the sitemap is empty. Keep it only if the owner said the app is private; delete it to go public`);
  }
  if (/^NEXT_PUBLIC_SITE_PRIVATE\s*=\s*"?true/m.test(env)) warnings.push('NEXT_PUBLIC_SITE_PRIVATE=true: search engines skip every page. Confirm with the owner that this is wanted');

  // 3. CI.
  const wfDir = path.join(dir, '.github', 'workflows');
  const workflows = await walk(wfDir, (n) => /\.ya?ml$/.test(n));
  const pkg = await readJson(path.join(dir, 'package.json'));
  const hasLock = await exists(path.join(dir, 'package-lock.json'));
  for (const wf of workflows) {
    const text = await readFile(wf, 'utf8');
    const rel = path.relative(dir, wf);
    for (const [, local] of text.matchAll(/uses:\s*['"]?(\.\/[^\s'"#]+)/g)) {
      if (!(await exists(path.join(dir, local)))) problems.push(`${rel} uses ${local}, which does not exist in the repo, so the job fails before it starts`);
    }
    if (/\bnpm ci\b/.test(text) && !hasLock && pkg) warnings.push(`${rel} runs npm ci but there is no package-lock.json. Run npm install and commit the lock file`);
    const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    if (ws?.length && /\bnpm (?:run )?test\b/.test(text)) {
      const testAt = text.search(/\bnpm (?:run )?test\b/);
      const buildBefore = /\bnpm run build\b|turbo (?:run )?build|--workspaces|-ws\b/.test(text.slice(0, testAt));
      const needsBuild = [];
      for (const pattern of ws) {
        const base = path.join(dir, pattern.replace(/\/\*.*$/, ''));
        const dirs = pattern.includes('*') ? (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name)) : [base];
        for (const d of dirs) {
          const p = await readJson(path.join(d, 'package.json'));
          if (p?.scripts?.build && /dist\//.test(JSON.stringify([p.main, p.module, p.exports, p.types]))) needsBuild.push(p.name ?? path.basename(d));
        }
      }
      if (needsBuild.length && !buildBefore) problems.push(`${rel} runs the tests before building the workspace packages ${needsBuild.join(', ')}, whose code lives in dist/. Add "npm run build --workspaces --if-present" before the tests`);
    }
  }
  if (hasLock && pkg) {
    const drift = lockDrift(pkg, await readJson(path.join(dir, 'package-lock.json')));
    if (drift.length) problems.push(`package-lock.json is out of step with package.json, so npm ci fails in CI: ${drift.slice(0, 3).join('; ')}. Run npm install and commit the lock file`);
  }
  if (workflows.length) details.push(`${workflows.length} workflow file(s) checked`);

  // 4. Sign-in routes and missing env.
  const authRoutes = await walk(path.join(srcDir, 'app', 'api', 'auth'), (n) => /^route\.(ts|js|mjs)$/.test(n));
  for (const f of authRoutes) {
    const code = stripComments(await readFile(f, 'utf8'));
    if (/process\.env\.\w+!/.test(code)) problems.push(`${path.relative(dir, f)} reads env vars with "!", so it throws a 500 when they are not set (preview, CI). Check them and answer cleanly (no user, or 503 with a message)`);
  }

  // 5. Zoom, robots.txt, description, accent text in dark mode.
  const pageFiles = [
    ...(await walk(path.join(srcDir, 'app'), (n) => /^layout\.(tsx|jsx|ts|js)$/.test(n))),
    ...(await walk(dir, (n) => n === 'index.html')).filter((f) => !f.includes(`${path.sep}public${path.sep}`)),
  ];
  for (const f of pageFiles) {
    const code = await readFile(f, 'utf8');
    if (zoomLock(code)) problems.push(`${path.relative(dir, f)} stops pinch-zoom (maximumScale 1 / user-scalable=no). Remove it: people with low vision must be able to zoom (Lighthouse meta-viewport)`);
  }
  const rootLayout = pageFiles.find((f) => path.relative(srcDir, f) === path.join('app', 'layout.tsx'));
  if (rootLayout) {
    const code = stripComments(await readFile(rootLayout, 'utf8'));
    if (/export\s+const\s+metadata/.test(code) && !/\bdescription\s*:/.test(code) && !/generateMetadata/.test(code)) problems.push(`${path.relative(dir, rootLayout)} metadata has no description, so search results show random page text (Lighthouse meta-description)`);
  }
  for (const f of pageFiles.filter((p) => p.endsWith('index.html'))) {
    const html = await readFile(f, 'utf8');
    if (/<head/i.test(html) && !/<meta\s+[^>]*name=["']description["']/i.test(html)) problems.push(`${path.relative(dir, f)} has no <meta name="description">, so search results show random page text (Lighthouse meta-description)`);
  }
  const vercel = await readJson(path.join(dir, 'vercel.json'));
  const catchAll = (vercel?.rewrites ?? []).some((r) => /index\.html$/.test(r.destination ?? '') && /^\/\(\.\*\)$|^\/:path\*$|^\/\(\(\?!/.test(r.source ?? ''));
  if (catchAll) {
    const publics = [path.join(dir, 'public'), ...(await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => path.join(dir, e.name, 'public'))];
    let found = false;
    for (const p of publics) if (await exists(path.join(p, 'robots.txt'))) found = true;
    if (!found) problems.push('vercel.json rewrites every path to index.html and there is no public/robots.txt, so /robots.txt returns the app page and search engines read it as invalid (Lighthouse robots-txt). Add public/robots.txt');
  }
  for (const f of styles) {
    for (const d of darkAccentText(await readFile(f, 'utf8'))) problems.push(`${path.relative(dir, f)} uses color: var(--${d.token}) as text but in dark mode ${d.fg} on ${d.bg} is only ${d.ratio}:1. Add a lighter --${d.token}-text for dark (e.g. color-mix toward the text colour) and use it for text`);
  }

  // 6. Search and launch.
  const appDir = path.join(srcDir, 'app');
  const isPrivate = (await exists(path.join(dir, '.shipyard-private'))) || (await exists(path.join(dir, '.6x7-private'))) || /^NEXT_PUBLIC_SITE_PRIVATE\s*=\s*"?true/m.test(env);
  const anyOf = async (list) => { for (const p of list) if (await exists(p)) return true; return false; };
  if (await exists(appDir)) {
    const pub = path.join(dir, 'public');
    if (!(await anyOf(['robots.ts', 'robots.js', 'robots.txt'].map((n) => path.join(appDir, n)).concat(path.join(pub, 'robots.txt'))))) warnings.push('No robots (src/app/robots.ts or public/robots.txt). Allow public pages, disallow /api, /admin, /settings, and point to the sitemap');
    if (!isPrivate && !(await anyOf(['sitemap.ts', 'sitemap.js', 'sitemap.xml'].map((n) => path.join(appDir, n)).concat(path.join(pub, 'sitemap.xml'))))) warnings.push('No sitemap (src/app/sitemap.ts). List the real public pages so search engines find them');
    if (rootLayout) {
      const code = stripComments(await readFile(rootLayout, 'utf8'));
      if (!/metadataBase|canonical/.test(code)) warnings.push(`${path.relative(dir, rootLayout)} sets no metadataBase or canonical, so share images get relative URLs and duplicate addresses compete. Set metadataBase from the lowercase site URL and alternates.canonical per page`);
    }
    if (!isPrivate) {
      for (const f of await walk(appDir, (n) => /\.(tsx|jsx|ts|js)$/.test(n))) {
        const code = stripComments(await readFile(f, 'utf8'));
        if (/index\s*:\s*false|["']noindex/.test(code) && !/SITE_PRIVATE|isPrivate/.test(code)) warnings.push(`${path.relative(dir, f)} hard-codes noindex although the app is not marked private. If this is a launched public page, remove it (a noindex left on from beta keeps it out of Google)`);
      }
    }
  }
  const appMeta = await readJson(path.join(dir, '.shipyard-app.json'));
  if (appMeta?.shared) {
    const cookieFile = await readFile(path.join(srcDir, 'lib', 'supabase', 'cookies.ts'), 'utf8').catch(() => '');
    if (cookieFile && !/\bdomain\s*:/.test(stripComments(cookieFile))) warnings.push('This app shares its Supabase project but its auth cookie has no domain, so people must sign in again on each subdomain. If the apps share one domain, set domain: ".<domain>" in production (see new-app references/shared-sign-in.md)');
  }
  const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
  const images = (await walk(path.join(dir, 'public'), (n) => IMG.test(n))).filter((f) => !/(^|[\\/])(icon|apple-touch|favicon|og-image|logo)[^\\/]*$/i.test(f));
  if (images.length && !(await anyOf(['IMAGE-SOURCES.md', 'docs/image-sources.md', 'image-sources.md'].map((n) => path.join(dir, n))))) warnings.push(`${images.length} image(s) in public/ but no IMAGE-SOURCES.md licence log. List each image's source and licence; replace unknown ones, especially real people's faces (see launch references/image-rights.md)`);

  const extra = warnings.length ? { warnings } : {};
  if (problems.length) return failed(name, `${problems.length} problem(s) that break accessibility, search or CI`, [...problems, ...warnings.map((w) => `warning: ${w}`)], extra);
  return pass(name, 'names, search settings, CI and sign-in routes look right', [...details, ...warnings.map((w) => `warning: ${w}`)], extra);
}
