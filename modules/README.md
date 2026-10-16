# Shipyard modules

A module is an optional feature that can be added to an app made with Shipyard. Add one with:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/add-module.mjs" <app-folder> <module> [--dry-run]
```

| Module | What it adds |
|---|---|
| `billing` | Payments with Stripe: `/pricing`, plans in one file (`src/lib/billing/plans.ts`), subscriptions, a billing section in Settings, a webhook, Health checks. |
| `newsletter` | An email list: opt-in boxes at sign-up and in Settings, one-click unsubscribe, `/admin/newsletter` to write and send updates. |

## How a module is built

```
modules/<name>/
  module.json        what the module is, which files it copies, what it changes
  files/             copied into the app, same paths (<APP_SLUG>, <APP_NAME> and the other template placeholders are filled in)
  migrations/        database files, named without a number: the number is chosen when the module is added
```

`module.json` fields (all lists may be empty or left out except `name`, `description`, `files`):

- `files`: paths under `files/`. Must match the folder exactly (a test checks it).
- `migrations`: file names under `migrations/`, for example `billing.sql`. Added as the next free `NNNN_billing.sql`.
- `isolation`: tables for `supabase/isolation.json` (`table`, `ownerColumn`, optional `insert` example row, optional `seed: "server"` when only the server key can create a row).
- `env.required`, `env.optional`, `perAppSecrets`, `generatedEnv`, `envExample`: setting names. All are recorded in the app's `.shipyard-app.json` `env` list. `generatedEnv` names get a random value in `.env.local` (never printed). `envExample` documents names in `.env.example`, always with empty values.
- `dependencies`, `devDependencies`: packages added to `package.json` (an existing version is kept).
- `nav`: menu items for `src/lib/nav.ts` (above Settings).
- `proxyPublic`: paths added to `PUBLIC_PREFIXES` in `src/proxy.ts`. If that list is missing the module is not added.
- `requiresFiles`, `dependsOn`: what the app or other modules must already have.
- `patches`: small edits to existing app files. `kind: "anchor"` puts a line before or after a line containing `anchor`; `kind: "array"` adds an `entry` to a named exported list (`array`). Each patch has an `imports` list, a plain-English `note` (shown if the edit cannot be placed), and either `already` (text that shows it was done) or `required: true` (the module is not added if the edit fails) and `skipIfFileMissing`.
- `stripeEvents`, `next`: extra information for other scripts, and the "what to do next" lines printed after adding.

## Rules

- Never overwrite a file the student changed: `add-module` stops and lists the files.
- Adding twice does nothing. A run that stopped half way is finished by running it again.
- Keys never go in files. Test keys in tests are built at run time so the key-leak scan stays quiet.
- Pure logic lives in plain `.mjs` files with tests in `files/tests/`, so `npm test` in the app runs them without a build.
- Anything that needs the secret server key lives in a `store.ts` file next to its module (`src/lib/billing/store.ts`, `src/lib/newsletter/store.ts`); routes and pages never import the server key.
