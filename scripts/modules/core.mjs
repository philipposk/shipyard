// The module mechanism: read a module from the plugin's modules/ folder, work out exactly what adding it to an
// app would change (plan), then make the changes (apply). add-module.mjs is the command-line wrapper.
//
// A module is a folder modules/<name>/ with module.json, files/ (copied into the app), migrations/ (database
// files, renumbered to fit the app) and nothing else. See modules/billing/module.json for every field.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PLUGIN_ROOT } from '../lib/paths.mjs';
import * as realProfile from '../lib/profile.mjs';
import { ProvisionError, readAppConfig, writeAppConfig, atomicWrite, DEFAULT_APP_ENV } from '../provision/common.mjs';
import { fillPlaceholders, shortNameOf } from '../provision/scaffold-core.mjs';
import { mergeEnv, readEnvText } from '../provision/envfile.mjs';
import { addImports, insertAtAnchor, addToArray, addNavItem } from './patch.mjs';

export const MODULES_DIR = path.join(PLUGIN_ROOT, 'modules');

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_RE = /^[a-z][a-z0-9_]*\.sql$/;
const NAV_ICONS = new Set(['home', 'items', 'settings', 'info', 'help']);
const POSIX_REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@()[\]. -]+(?:\/[A-Za-z0-9_@()[\]. -]+)*$/;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf']);

// ---------------------------------------------------------------------------------------------
// Reading and checking a module

/** Problems with a module.json, as plain sentences. Empty list = fine. */
export function validateManifest(m, dirName) {
  const p = [];
  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['module.json is not an object'];
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) p.push('name must be lowercase letters, numbers and dashes');
  else if (dirName && m.name !== dirName) p.push(`name "${m.name}" does not match the folder "${dirName}"`);
  if (typeof m.description !== 'string' || m.description.trim() === '') p.push('description is missing');
  if (!isStrArray(m.files) || m.files.length === 0) p.push('files must be a list of paths');
  else {
    for (const f of m.files) if (!POSIX_REL.test(f)) p.push(`file path "${f}" must be relative, with forward slashes and no ".."`);
    if (new Set(m.files).size !== m.files.length) p.push('files has duplicates');
  }
  if (m.migrations !== undefined) {
    if (!isStrArray(m.migrations)) p.push('migrations must be a list of file names');
    else for (const f of m.migrations) if (!MIGRATION_RE.test(f)) p.push(`migration "${f}" must be like name.sql (lowercase, no number: the number is added when the module is added)`);
  }
  const env = m.env ?? {};
  for (const key of ['required', 'optional']) {
    if (env[key] !== undefined && (!isStrArray(env[key]) || !env[key].every((n) => ENV_RE.test(n)))) p.push(`env.${key} must be a list of variable names`);
  }
  for (const key of ['perAppSecrets', 'generatedEnv', 'proxyPublic', 'dependsOn', 'stripeEvents', 'next', 'requiresFiles']) {
    if (m[key] !== undefined && !isStrArray(m[key])) p.push(`${key} must be a list of text`);
  }
  if (isStrArray(m.perAppSecrets) && !m.perAppSecrets.every((n) => ENV_RE.test(n))) p.push('perAppSecrets must be variable names');
  if (isStrArray(m.generatedEnv) && !m.generatedEnv.every((n) => ENV_RE.test(n))) p.push('generatedEnv must be variable names');
  if (isStrArray(m.proxyPublic) && !m.proxyPublic.every((x) => x.startsWith('/') && !/\s/.test(x))) p.push('proxyPublic paths must start with / and have no spaces');
  if (isStrArray(m.dependsOn) && !m.dependsOn.every((n) => NAME_RE.test(n))) p.push('dependsOn must be module names');
  if (m.nav !== undefined) {
    if (!Array.isArray(m.nav)) p.push('nav must be a list');
    else for (const n of m.nav) {
      if (!n || typeof n.href !== 'string' || !n.href.startsWith('/') || typeof n.label !== 'string' || !n.label || !NAV_ICONS.has(n.icon)) {
        p.push(`nav item ${JSON.stringify(n)} needs href (starting with /), label and icon (${[...NAV_ICONS].join(', ')})`);
      }
    }
  }
  if (m.isolation !== undefined) {
    if (!Array.isArray(m.isolation)) p.push('isolation must be a list');
    else for (const e of m.isolation) {
      if (!e || !IDENT_RE.test(e.table ?? '') || !IDENT_RE.test(e.ownerColumn ?? '')) p.push(`isolation entry ${JSON.stringify(e)} needs table and ownerColumn`);
      else if (e.seed !== undefined && e.seed !== 'server') p.push(`isolation entry for ${e.table}: seed can only be "server"`);
      else if (e.insert !== undefined && (typeof e.insert !== 'object' || Array.isArray(e.insert) || e.insert === null)) p.push(`isolation entry for ${e.table}: insert must be an object`);
    }
  }
  for (const key of ['dependencies', 'devDependencies']) {
    if (m[key] !== undefined) {
      const v = m[key];
      if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.entries(v).every(([k, x]) => /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(k) && typeof x === 'string' && x)) {
        p.push(`${key} must map package names to versions`);
      }
    }
  }
  if (m.envExample !== undefined) {
    if (!Array.isArray(m.envExample) || !m.envExample.every((e) => e && ENV_RE.test(e.name ?? '') && typeof e.comment === 'string')) p.push('envExample must be a list of { name, comment }');
  }
  if (m.patches !== undefined) {
    if (!Array.isArray(m.patches)) p.push('patches must be a list');
    else m.patches.forEach((x, i) => {
      const tag = `patch ${i + 1}${x?.id ? ` (${x.id})` : ''}`;
      if (!x || typeof x.id !== 'string' || typeof x.file !== 'string' || !POSIX_REL.test(x.file)) return p.push(`${tag} needs id and file`);
      if (typeof x.note !== 'string' || !x.note) p.push(`${tag} needs a note (plain English: what to do by hand if the edit can not be made)`);
      if (x.imports !== undefined && !isStrArray(x.imports)) p.push(`${tag}: imports must be a list`);
      if (x.kind === 'array') {
        if (typeof x.entry !== 'string' || !x.entry) p.push(`${tag}: entry is missing`);
      } else if (x.kind === 'anchor' || x.kind === undefined) {
        if (typeof x.anchor !== 'string' || typeof x.insert !== 'string' || !['before', 'after'].includes(x.position ?? 'before')) p.push(`${tag}: anchor, insert and position (before or after) are needed`);
        if (typeof x.already !== 'string' || !x.already) p.push(`${tag}: already (text that shows the edit was made) is needed`);
      } else p.push(`${tag}: kind must be "anchor" or "array"`);
    });
  }
  return p;
}

/** Names of the modules in the plugin. */
export async function listModules(modulesDir = MODULES_DIR) {
  let entries;
  try {
    entries = await readdir(modulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await stat(path.join(modulesDir, e.name, 'module.json'));
      out.push(e.name);
    } catch {
      // not a module
    }
  }
  return out.sort();
}

/** Load and check one module: { name, dir, manifest }. Throws ProvisionError with a plain message. */
export async function loadModule(name, modulesDir = MODULES_DIR) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ProvisionError(`"${name}" is not a module name. Available: ${(await listModules(modulesDir)).join(', ') || 'none'}.`, { usage: true });
  }
  const dir = path.join(modulesDir, name);
  let manifest;
  try {
    manifest = JSON.parse((await readFile(path.join(dir, 'module.json'), 'utf8')).replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ProvisionError(`There is no module called "${name}". Available: ${(await listModules(modulesDir)).join(', ') || 'none'}.`, { usage: true });
    }
    throw new ProvisionError(`The module "${name}" is damaged (module.json is not valid JSON). Update the Shipyard plugin.`);
  }
  const problems = validateManifest(manifest, name);
  if (problems.length > 0) throw new ProvisionError(`The module "${name}" is damaged: ${problems.join('; ')}. Update the Shipyard plugin.`, { problems });
  return { name, dir, manifest };
}

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

const sameBytes = (a, b) => a.length === b.length && a.equals(b);

function appValues(config) {
  const name = config.name || config.slug;
  return {
    SLUG: config.slug,
    NAME: name,
    SHORT_NAME: shortNameOf(name),
    DESCRIPTION: config.description || '',
    TAGLINE: config.description || '',
    LAYOUT: config.layout || 'bottom-nav',
  };
}

/** File content for the app: text files get the app's name, address and so on in place of <APP_...>. */
function renderFile(buf, rel, values) {
  const ext = path.extname(rel).toLowerCase();
  if (BINARY_EXT.has(ext) || buf.subarray(0, 8192).includes(0)) return buf;
  const text = buf.toString('utf8');
  return text.includes('<APP_') ? Buffer.from(fillPlaceholders(text, ext, values), 'utf8') : buf;
}

/** One value on one line: { "a": 1, "b": { "c": 2 } }. */
function inlineJson(value) {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`);
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** supabase/isolation.json with one table per line, the way the template writes it. */
export function formatIsolation(list) {
  return `[\n${list.map((e) => `  ${inlineJson(e)}`).join(',\n')}\n]\n`;
}

// ---------------------------------------------------------------------------------------------
// Planning

/**
 * Work out everything adding `name` to `appDir` would change, without changing anything.
 * opts: { appDir, name, forceFiles: [rel paths] }
 * deps: { modulesDir }
 * Returns the plan (see the fields below). plan.blockers is a list of plain sentences; when it is not empty, apply refuses.
 */
export async function planAddModule(opts, deps = {}) {
  const modulesDir = deps.modulesDir ?? MODULES_DIR;
  const { appDir } = opts;
  const force = new Set((opts.forceFiles ?? []).map((f) => f.replace(/\\/g, '/')));
  const mod = await loadModule(opts.name, modulesDir);
  const m = mod.manifest;
  const config = await readAppConfig(appDir);
  const configured = Array.isArray(config.modules) ? config.modules : [];

  const plan = {
    module: mod.name,
    description: m.description,
    appDir,
    slug: config.slug,
    alreadyAdded: configured.includes(mod.name),
    blockers: [],
    files: { create: [], same: [], overwrite: [], conflict: [] },
    migrations: [],
    isolation: { added: [], present: [] },
    nav: { added: [], present: [], manual: [] },
    proxy: { added: [], present: [] },
    patches: [],
    manual: [],
    warnings: [],
    env: { recorded: [], exampleAdded: [], generated: [] },
    packages: { added: [], kept: [] },
    next: [],
    // internal: what apply will write
    _writes: new Map(), // rel -> Buffer | string
    _env: {},
    _config: null,
  };
  if (plan.alreadyAdded) return plan;

  // The app must look like a Shipyard app.
  if (!(await stat(path.join(appDir, 'src')).then((s) => s.isDirectory(), () => false))) {
    plan.blockers.push('This folder has no src/ folder, so it does not look like an app made with Shipyard. Check the folder.');
    return plan;
  }
  for (const rel of m.requiresFiles ?? []) {
    if (!(await readIfExists(path.join(appDir, ...rel.split('/'))))) {
      plan.blockers.push(`This app is missing ${rel}, which the "${mod.name}" module needs. The app was made with an older Shipyard: bring it up to date first (the upgrade steps in /shipyard:new-app), then add the module.`);
    }
  }
  for (const dep of m.dependsOn ?? []) {
    if (!configured.includes(dep)) plan.blockers.push(`Add the "${dep}" module first: node add-module.mjs ${appDir} ${dep}`);
  }

  const values = appValues(config);

  // 1. Files.
  for (const rel of m.files) {
    const source = await readIfExists(path.join(mod.dir, 'files', ...rel.split('/')));
    if (!source) {
      plan.blockers.push(`The module "${mod.name}" is damaged: files/${rel} is missing. Update the Shipyard plugin.`);
      continue;
    }
    const wanted = renderFile(source, rel, values);
    const existing = await readIfExists(path.join(appDir, ...rel.split('/')));
    if (!existing) {
      plan.files.create.push(rel);
      plan._writes.set(rel, wanted);
    } else if (sameBytes(existing, wanted)) {
      plan.files.same.push(rel);
    } else if (force.has(rel)) {
      plan.files.overwrite.push(rel);
      plan._writes.set(rel, wanted);
    } else {
      plan.files.conflict.push(rel);
    }
  }
  for (const f of force) if (!m.files.includes(f)) plan.warnings.push(`--force-file ${f} is not a file of this module, so it was ignored.`);
  if (plan.files.conflict.length > 0) {
    plan.blockers.push(
      `These files already exist and are different, so nothing was changed: ${plan.files.conflict.join(', ')}. `
      + 'Look at each one. To replace one with the module\'s version on purpose, run again with --force-file <path> for that file.',
    );
  }

  // 2. Database files, renumbered to the next free number.
  const migDir = path.join(appDir, 'supabase', 'migrations');
  let existingMig = [];
  try {
    existingMig = (await readdir(migDir)).filter((n) => /\.sql$/i.test(n));
  } catch {
    // no folder yet
  }
  let nextNumber = existingMig.reduce((max, n) => {
    const x = /^(\d{4})_/.exec(n);
    return x ? Math.max(max, Number(x[1])) : max;
  }, 0) + 1;
  for (const file of m.migrations ?? []) {
    const base = file.replace(/\.sql$/, '');
    const present = existingMig.find((n) => new RegExp(`^\\d{4}_${base}\\.sql$`).test(n));
    if (present) {
      plan.migrations.push({ file, to: `supabase/migrations/${present}`, status: 'present' });
      continue;
    }
    const source = await readIfExists(path.join(mod.dir, 'migrations', file));
    if (!source) {
      plan.blockers.push(`The module "${mod.name}" is damaged: migrations/${file} is missing. Update the Shipyard plugin.`);
      continue;
    }
    const target = `supabase/migrations/${String(nextNumber).padStart(4, '0')}_${base}.sql`;
    nextNumber += 1;
    plan.migrations.push({ file, to: target, status: 'create' });
    plan._writes.set(target, renderFile(source, file, values));
  }

  // 3. The list of tables the privacy test checks.
  if ((m.isolation ?? []).length > 0) {
    const isoRel = 'supabase/isolation.json';
    const raw = await readIfExists(path.join(appDir, ...isoRel.split('/')));
    let list = [];
    if (raw) {
      try {
        list = JSON.parse(raw.toString('utf8'));
        if (!Array.isArray(list)) throw new Error('not a list');
      } catch {
        plan.blockers.push('supabase/isolation.json is not a valid list. Fix or restore it (git checkout supabase/isolation.json) and run this again.');
        list = null;
      }
    }
    if (list) {
      for (const e of m.isolation) {
        if (list.some((x) => String(x?.table).toLowerCase() === e.table)) plan.isolation.present.push(e.table);
        else {
          list.push(e);
          plan.isolation.added.push(e.table);
        }
      }
      if (plan.isolation.added.length > 0) plan._writes.set(isoRel, formatIsolation(list));
    }
  }

  // 4. Edits to existing files: texts[rel] is the working copy; patches change it in order.
  const texts = new Map();
  const load = async (rel) => {
    if (texts.has(rel)) return texts.get(rel);
    const buf = await readIfExists(path.join(appDir, ...rel.split('/')));
    const text = buf ? buf.toString('utf8') : null;
    texts.set(rel, text);
    return text;
  };
  const touched = new Set();

  // 4a. nav items
  if ((m.nav ?? []).length > 0) {
    const rel = 'src/lib/nav.ts';
    let text = await load(rel);
    for (const item of m.nav) {
      if (text === null) {
        plan.nav.manual.push(`${item.label} (${item.href})`);
        continue;
      }
      const r = addNavItem(text, item);
      if (!r.ok) plan.nav.manual.push(`${item.label} (${item.href})`);
      else if (r.already) plan.nav.present.push(item.href);
      else {
        text = r.text;
        plan.nav.added.push(item.href);
        touched.add(rel);
      }
    }
    texts.set(rel, text);
    if (plan.nav.manual.length > 0) plan.manual.push(`Add ${plan.nav.manual.join(' and ')} to the page list in src/lib/nav.ts yourself (it is not in the menu yet).`);
  }

  // 4b. pages that visitors can open without signing in
  if ((m.proxyPublic ?? []).length > 0) {
    const rel = 'src/proxy.ts';
    let text = await load(rel);
    if (text === null) {
      plan.blockers.push('src/proxy.ts is missing, so the module\'s public pages could not be opened to visitors. Restore the file and run this again.');
    } else {
      for (const route of m.proxyPublic) {
        const r = addToArray(text, { name: 'PUBLIC_PREFIXES', entry: JSON.stringify(route), literal: JSON.stringify(route) });
        if (!r.ok) {
          plan.blockers.push(`Could not find the PUBLIC_PREFIXES list in src/proxy.ts, so ${route} would be hidden behind sign-in. Nothing was changed.`);
          break;
        }
        if (r.already) plan.proxy.present.push(route);
        else {
          text = r.text;
          plan.proxy.added.push(route);
          touched.add(rel);
        }
      }
      texts.set(rel, text);
    }
  }

  // 4c. patches (imports plus one line or one list entry)
  for (const patch of m.patches ?? []) {
    const result = { id: patch.id, file: patch.file, status: '' };
    plan.patches.push(result);
    const text = await load(patch.file);
    if (text === null) {
      result.status = 'file-missing';
      if (patch.required && !patch.skipIfFileMissing) plan.blockers.push(`${patch.file} is missing, so this could not be set up: ${patch.note}`);
      else if (patch.skipIfFileMissing) plan.warnings.push(`${patch.file} does not exist in this app, so "${patch.id}" was skipped. ${patch.note}`);
      else plan.manual.push(`${patch.note} (in ${patch.file})`);
      continue;
    }
    let working = text;
    let applied = false;
    if (patch.kind === 'array') {
      const r = addToArray(working, { name: patch.array ?? null, entry: patch.entry, literal: patch.already ?? patch.entry });
      if (!r.ok) {
        result.status = 'not-found';
        if (patch.required) plan.blockers.push(`Could not find the right place in ${patch.file}. ${patch.note} Nothing was changed.`);
        else plan.manual.push(`${patch.note} (in ${patch.file})`);
        continue;
      }
      working = r.text;
      applied = !r.already;
    } else {
      if (!working.includes(patch.already)) {
        const r = insertAtAnchor(working, { anchor: patch.anchor, position: patch.position ?? 'before', insert: patch.insert, occurrence: patch.occurrence });
        if (!r.ok) {
          result.status = 'not-found';
          if (patch.required) plan.blockers.push(`Could not find the right place in ${patch.file}. ${patch.note} Nothing was changed.`);
          else plan.manual.push(`${patch.note} (in ${patch.file})`);
          continue;
        }
        working = r.text;
        applied = true;
      }
    }
    if (patch.imports?.length) {
      const r = addImports(working, patch.imports);
      working = r.text;
      applied = applied || r.added.length > 0;
    }
    result.status = applied ? 'apply' : 'already';
    if (applied) {
      texts.set(patch.file, working);
      touched.add(patch.file);
    }
  }
  for (const rel of touched) plan._writes.set(rel, texts.get(rel));

  // 5. package.json
  const pkgDeps = { dependencies: m.dependencies ?? {}, devDependencies: m.devDependencies ?? {} };
  if (Object.keys(pkgDeps.dependencies).length + Object.keys(pkgDeps.devDependencies).length > 0) {
    const raw = await readIfExists(path.join(appDir, 'package.json'));
    let pkg = null;
    try {
      pkg = raw ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      pkg = null;
    }
    if (!pkg) plan.blockers.push('package.json is missing or damaged, so the module\'s packages could not be added. Restore it and run this again.');
    else {
      for (const [section, wanted] of Object.entries(pkgDeps)) {
        for (const [pkgName, range] of Object.entries(wanted)) {
          const have = pkg.dependencies?.[pkgName] ?? pkg.devDependencies?.[pkgName];
          if (have) {
            if (have !== range) plan.packages.kept.push(`${pkgName} ${have}`);
            continue;
          }
          pkg[section] = { ...(pkg[section] ?? {}), [pkgName]: range };
          plan.packages.added.push(`${pkgName} ${range}`);
        }
        if (pkg[section]) pkg[section] = Object.fromEntries(Object.entries(pkg[section]).sort(([a], [b]) => a.localeCompare(b)));
      }
      if (plan.packages.added.length > 0) plan._writes.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }

  // 6. .env.example (documentation only, never a value) and generated settings for .env.local
  if ((m.envExample ?? []).length > 0) {
    const rel = '.env.example';
    const current = (await readIfExists(path.join(appDir, rel)))?.toString('utf8') ?? '';
    const missing = m.envExample.filter((e) => !new RegExp(`^\\s*${e.name}\\s*=`, 'm').test(current));
    if (missing.length > 0) {
      const block = missing.map((e) => `${e.comment.split('\n').map((l) => `# ${l}`).join('\n')}\n${e.name}=`).join('\n');
      const sep = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
      plan._writes.set(rel, `${current}${sep}# --- ${mod.name} module ---\n${block}\n`);
      plan.env.exampleAdded.push(...missing.map((e) => e.name));
    }
  }
  if ((m.generatedEnv ?? []).length > 0) {
    const local = await readEnvText(path.join(appDir, '.env.local'));
    for (const key of m.generatedEnv) {
      if (new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*\\S`, 'm').test(local)) continue;
      plan.env.generated.push(key);
      plan._env[key] = randomBytes(32).toString('hex');
    }
  }

  // 7. What gets recorded in .shipyard-app.json
  const envNames = [...new Set([...(m.env?.required ?? []), ...(m.env?.optional ?? []), ...(m.perAppSecrets ?? []), ...(m.generatedEnv ?? [])])];
  const currentEnv = Array.isArray(config.env) ? config.env : [...DEFAULT_APP_ENV];
  const newEnv = [...currentEnv, ...envNames.filter((n) => !currentEnv.includes(n))];
  plan.env.recorded = envNames.filter((n) => !currentEnv.includes(n));
  plan._config = { ...config, modules: [...configured, mod.name], env: newEnv };

  plan.next = [...(m.next ?? [])];
  if (plan.packages.added.length > 0) plan.next.unshift(`Run npm install in the app folder to get ${plan.packages.added.map((x) => x.split(' ')[0]).join(', ')}.`);
  if (plan.migrations.some((x) => x.status === 'create')) plan.next.splice(plan.packages.added.length > 0 ? 1 : 0, 0, 'Run provision-supabase.mjs again so the new database tables are created.');
  if (plan.env.generated.length > 0) plan.next.push('Run provision-vercel.mjs again so the new app settings reach Vercel.');
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Applying

/** Make the changes in `plan`. Refuses when the plan has blockers. deps: { profile } */
export async function applyAddModule(plan, deps = {}) {
  if (plan.alreadyAdded) return plan;
  if (plan.blockers.length > 0) throw new ProvisionError(plan.blockers.join(' '), { blockers: plan.blockers });
  const profileApi = deps.profile ?? realProfile;

  for (const [rel, content] of plan._writes) {
    const file = path.join(plan.appDir, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  if (Object.keys(plan._env).length > 0) {
    const file = path.join(plan.appDir, '.env.local');
    await atomicWrite(file, mergeEnv(await readEnvText(file), plan._env), 0o600);
  }
  // Last: once the module is in the list, adding it again is a no-op.
  await writeAppConfig(plan.appDir, plan._config);

  try {
    const known = await profileApi.getApp(plan._config.slug);
    const modules = plan._config.modules;
    if (known) await profileApi.upsertApp({ slug: plan._config.slug, modules });
    else {
      await profileApi.upsertApp({
        slug: plan._config.slug, name: plan._config.name, dir: plan.appDir, layout: plan._config.layout,
        modules, status: 'scaffolded', step: 'scaffolded', url: '', repo: '', supabaseRef: '', vercelProject: '', lastVerify: null,
      });
    }
  } catch {
    plan.warnings.push('Could not update your Shipyard app list. The app itself is fine.');
  }
  return plan;
}

/** The plan without the internal fields, ready for --json. Generated values are never included. */
export function publicPlan(plan, { dryRun = false } = {}) {
  const { _writes, _env, _config, ...rest } = plan;
  void _writes; void _env; void _config;
  return { ok: plan.blockers.length === 0, dryRun, ...rest };
}
