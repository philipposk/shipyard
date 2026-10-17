// Shared helpers for the modules tests: a tiny fake app, and a fake module folder.
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const NAV_TS = `export type NavIconName = "home" | "items" | "settings" | "info" | "help";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/items", label: "Items", icon: "items" },
  { href: "/settings", label: "Settings", icon: "settings" },
];
`;

export const PROXY_TS = `import { NextResponse } from "next/server";

const PUBLIC_PREFIXES = [
  "/sign-in",
  "/privacy",
  "/api/health",
];

export async function proxy() {
  return NextResponse.next();
}
`;

export const SETTINGS_TSX = `export default function SettingsPage() {
  return (
    <AppShell signedIn>
      <div className="space-y-4">
        <section>Account</section>
        {/* shipyard:settings-sections:start */}
        {/* shipyard:settings-sections:end */}
      </div>
    </AppShell>
  );
}
`;

export const HEALTH_TS = `import "server-only";

export const HEALTH_CHECKS: HealthCheck[] = [
  ...createTemplateChecks({ env: process.env }),
];
`;

export const HOOKS_TS = `import "server-only";

export const PRE_DELETE_HOOKS: PreDeleteHook[] = [];

export const ACCOUNT_DATA_TABLES: AccountDataTable[] = [
  { table: "items", column: "user_id" },
  { table: "profiles", column: "id" },
];
`;

export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** A small app folder that looks enough like a Shipyard app. `extra` adds or replaces files (null removes one). */
export async function makeApp(parent, extra = {}) {
  const appDir = await mkdtemp(path.join(parent, 'app-'));
  const base = {
    '.shipyard-app.json': `${JSON.stringify({
      slug: 'demo-app', name: 'Demo App', description: 'A demo.', layout: 'sidebar', modules: [], pwa: true, private: false,
      env: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'], createdAt: '2026-01-01T00:00:00.000Z', pluginVersion: '0.4.0',
    }, null, 2)}\n`,
    'package.json': `${JSON.stringify({ name: 'demo-app', version: '0.1.0', dependencies: { next: '^16.2.9', 'server-only': '^0.0.1' }, devDependencies: { typescript: '^5' } }, null, 2)}\n`,
    '.env.example': '# example\nNEXT_PUBLIC_SUPABASE_URL=\n',
    'src/lib/nav.ts': NAV_TS,
    'src/proxy.ts': PROXY_TS,
    'src/app/settings/page.tsx': SETTINGS_TSX,
    'src/lib/health/checks.ts': HEALTH_TS,
    'src/lib/account/pre-delete.ts': HOOKS_TS,
    'src/lib/same-origin.mjs': 'export const isSameOrigin = () => true;\n',
    'supabase/isolation.json': '[\n  { "table": "items", "ownerColumn": "user_id" },\n  { "table": "profiles", "ownerColumn": "id" }\n]\n',
    'supabase/migrations/0001_profiles.sql': '-- profiles\ncreate table if not exists public.profiles (id uuid primary key);\n',
    'supabase/migrations/0002_items.sql': '-- items\ncreate table if not exists public.items (id uuid primary key);\n',
  };
  const files = { ...base, ...extra };
  for (const [k, v] of Object.entries(files)) if (v === null) delete files[k];
  await writeTree(appDir, files);
  return appDir;
}

/** A module folder in a temp modules dir. */
export async function makeModule(modulesDir, name, { manifest = {}, files = {}, migrations = {} } = {}) {
  const dir = path.join(modulesDir, name);
  const fileMap = { 'src/lib/demo/hello.ts': 'export const hello = "hello from <APP_NAME>";\n', ...files };
  const full = {
    name,
    description: `The ${name} test module.`,
    files: Object.keys(fileMap),
    ...manifest,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'module.json'), `${JSON.stringify(full, null, 2)}\n`);
  await writeTree(path.join(dir, 'files'), fileMap);
  await writeTree(path.join(dir, 'migrations'), migrations);
  return dir;
}

export const tempParent = () => mkdtemp(path.join(os.tmpdir(), 'shipyard-modules-'));
