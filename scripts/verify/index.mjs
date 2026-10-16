// The list of checks, in the order they run: quick offline ones first, then the ones that call the live app.
export const CHECK_NAMES = ['secrets', 'proxy', 'design', 'routes', 'protection', 'auth', 'isolation', 'browser'];

/** Load one check module. Returns its `check` function. */
export async function loadCheck(name) {
  if (!CHECK_NAMES.includes(name)) throw new Error(`Unknown check "${name}".`);
  const mod = await import(`./${name}.mjs`);
  return mod.check;
}

/** Things verify never looks at, so the report can say so honestly. */
export const NEVER_CHECKED = [
  'Whether emails (sign-up, password reset) are delivered',
  'Google sign-in, payments and any other outside service',
  'How the app looks beyond the home page, or on wide screens',
  'Whether the features do what you intended (only their privacy rules are tested)',
];
