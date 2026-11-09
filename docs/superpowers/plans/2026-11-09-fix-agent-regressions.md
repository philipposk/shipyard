# Fix the 8–9 Nov agent regressions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) and implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the owner-approved cleanup and the real onboarding-navigation fix, and remove the security hole, the MindScope-only copies, and the skill contradictions those sessions left behind.

**Architecture:** One branch, `fix/profile-form-race-and-lessons` (open PR #45, parent of `origin/main` at `a0b32ba`). Each task is a separate commit on that branch. Do not open a second branch. Do not merge to `main`. Do not push `main`.

**Tech Stack:** Node 22+, plain `node --test` (no Jest). Template app is Next.js. Skill files are Markdown. Verify allowlist is `scripts/verify/server-key.mjs`.

## Global Constraints

- Stay on `fix/profile-form-race-and-lessons`. PR #45 already exists: https://github.com/philipposk/shipyard/pull/45
- Do not merge to `main`. Do not push `main`. Pushing this feature branch after the commits is allowed.
- Do not revert owner decisions from `36569eb` (0.8.11): 44px touch targets, Node 22 floor, full upgrade waits for a yes, small review is the default, `apply-design` uses `--keep-layout` unless the student asked for the look's menu, personal 6x7 notes stay out of skill instructions, Vercel CLI pin stays `vercel@65.12.1`.
- Do not revert the fail-closed health probe, sign-in timeouts, or explicit table grants from `751466f`.
- Keep `window.location.replace("/")` in the profile form. That is the navigation fix. Only the comment and the MindScope copies around it are wrong.
- Do not edit, stage, or commit: `CLEANUP-PLAN.md`, `valuer-todo-site/`, `skills/new-app/references/sparks-lessons.md`, or the unstaged pointer at the bottom of `skills/new-app/references/lessons.md`.
- Do not put a token on a command line. Do not grep `~/.shipyard/secrets.env`. Do not select `email` from `auth.users`. Do not put `mindscope.6x7.gr` or `commitr.6x7.gr` in any file.
- Skill text stays plain English. Do not add model product names (Opus, Sonnet, Haiku). The pack lint rejects them.
- `node --test tests/*.test.mjs` on this tree is 1900 tests, 1884 pass, 16 skipped, 0 fail. The "1884 pass" line in `36569eb` is the skip count, not 16 failures. A new failure is a real regression.

## File map

| File | What this plan does |
|---|---|
| `scripts/verify/server-key.mjs` | Drop four folder prefixes |
| `ops/templates/.github/ops/automerge-check.mjs` | Drop the matching four risky paths |
| `skills/new-app/references/verify.md` | Point at the allowlist file, not a stale short list |
| `template/src/app/profile/edit/profile-form.tsx` | Keep the navigation; drop the missing-doc citation |
| `template/scripts/live-smoke.mjs` | Delete |
| `template/package.json`, `template/.gitignore` | Remove the smoke script and its artifact ignore |
| `template/src/lib/auth/server-signup.ts` | Split starter `createUser` from the password set |
| `skills/ops/references/auth-shared-project.md` | Runbook with no secret command and no "never redirect" |
| `scripts/supabase-health.mjs` | `--auth-triggers` prints trigger names only |
| `skills/design/references/shadcn-theme-packs.md` | Real template variable names |
| `skills/design/SKILL.md` | Link that recipe |
| `docs/lessons-2026-11-09.md` | Delete after the durable rules exist |
| Skill `SKILL.md` files, `presets.md`, `apply-design.md`, `header.md`, `checked-facts.md`, `email-domain.md`, video skill | Fix contradictions from `36569eb` |
| `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `CHANGELOG.md` | 0.8.12 |

---

### Task 1: Stop allowlisting whole server-key folders

**Files:**
- Modify: `scripts/verify/server-key.mjs` (the four comments and entries added after `lib/errors/store.ts`)
- Modify: `ops/templates/.github/ops/automerge-check.mjs` (the "Analysis apps" block)
- Modify: `skills/new-app/references/verify.md` (secrets row)
- Test: `tests/server-key-allowlist.test.mjs` (create)

**Interfaces:**
- Consumes: `isAllowedForServerKey` and `SERVER_KEY_ALLOWED` already exported from `scripts/verify/server-key.mjs`. `RISKY_PATHS` is exported from `ops/templates/.github/ops/automerge-check.mjs`.
- Produces: those four folder strings are absent. `app/api/health/route.ts` stays allowed. Existing folder entries that predate this (`lib/auth/`, `app/api/auth/signup/`, `app/api/auth/forgot-password/`) stay.

- [ ] **Step 1: Write the failing test**

Create `tests/server-key-allowlist.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISKY_PATHS } from '../ops/templates/.github/ops/automerge-check.mjs';
import { SERVER_KEY_ALLOWED, isAllowedForServerKey } from '../scripts/verify/server-key.mjs';

const FOLDERS = ['lib/readings/', 'lib/analysis/', 'lib/chat/', 'lib/projects/'];

test('one app cannot open the server key for every file in a shared folder name', () => {
  for (const folder of FOLDERS) {
    assert.equal(SERVER_KEY_ALLOWED.includes(folder), false, folder);
    assert.equal(isAllowedForServerKey(`${folder}store.ts`), false, folder);
    assert.equal(RISKY_PATHS.includes(`src/${folder}`), false, folder);
  }
  assert.equal(isAllowedForServerKey('app/api/health/route.ts'), true);
  assert.equal(isAllowedForServerKey('lib/errors/store.ts'), true);
  assert.equal(isAllowedForServerKey('lib/auth/ensure-profile.ts'), true);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test tests/server-key-allowlist.test.mjs`

Expected: FAIL because `lib/readings/`, `lib/analysis/`, `lib/chat/` and `lib/projects/` are present.

- [ ] **Step 3: Delete the four entries**

In `scripts/verify/server-key.mjs`, delete the MindScope comments and these four lines, and keep the health route:

```javascript
  'lib/errors/store.ts',
  // Public uptime probe. One head-only read of profiles, no row returned. See app/api/health/route.ts.
  'app/api/health/route.ts',
```

In `ops/templates/.github/ops/automerge-check.mjs`, delete the four paths under the "Analysis apps" comment. Keep `src/app/api/health/route.ts`.

In `skills/new-app/references/verify.md`, replace the secrets "What it proves" cell with:

`No key-shaped text in tracked files; .env and .env.local are not tracked; the secret server key is used only where scripts/verify/server-key.mjs allows it. Add an exact file there when a module needs it. Do not add a folder prefix for one app.`

- [ ] **Step 4: Run the test and the drift test**

Run: `node --test tests/server-key-allowlist.test.mjs tests/ops-automerge.test.mjs tests/modules-errors-content.test.mjs`

Expected: PASS. The drift test in `tests/ops-automerge.test.mjs` requires every remaining allowlist entry to be a risky path. Health and `lib/auth/` already are.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify/server-key.mjs ops/templates/.github/ops/automerge-check.mjs skills/new-app/references/verify.md tests/server-key-allowlist.test.mjs
git commit -m "$(cat <<'EOF'
fix: stop allowlisting whole folders for the server key

A folder prefix let any file under lib/chat, lib/projects, lib/readings
or lib/analysis skip privacy rules in every app. Exact files stay.

EOF
)"
```

---

### Task 2: Keep the profile navigation fix, drop the missing-doc citation

**Files:**
- Modify: `template/src/app/profile/edit/profile-form.tsx` (the comment above `window.location.replace`)
- Test: `tests/template-launch-contract.test.mjs` (add one test)

- [ ] **Step 1: Add the failing assertion**

In `tests/template-launch-contract.test.mjs`, add:

```javascript
test('profile save does a full navigation and does not cite a doc the app will not contain', async () => {
  const form = await read('src/app/profile/edit/profile-form.tsx');
  assert.match(form, /window\.location\.replace\("\/"\)/);
  assert.doesNotMatch(form, /router\.(replace|refresh)/);
  assert.doesNotMatch(form, /lessons-2026-11-09/);
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/template-launch-contract.test.mjs`

Expected: FAIL on `lessons-2026-11-09`.

- [ ] **Step 3: Replace the comment**

Leave the call. Replace the comment with:

```tsx
      // Full page load on purpose. router.replace("/") then router.refresh()
      // cancels the navigation, so a new person stays on this page after a successful save.
      window.location.replace("/");
```

- [ ] **Step 4: Re-run**

Run: `node --test tests/template-launch-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add template/src/app/profile/edit/profile-form.tsx tests/template-launch-contract.test.mjs
git commit -m "$(cat <<'EOF'
fix: keep the profile-save navigation without citing a missing doc

router.replace plus router.refresh cancels the leave. The full page
load stays. Generated apps do not contain the incident write-up.

EOF
)"
```

---

### Task 3: Remove the MindScope live-smoke script

**Files:**
- Delete: `template/scripts/live-smoke.mjs`
- Modify: `template/package.json` (delete the `"smoke"` script line)
- Modify: `template/.gitignore` (delete the `test-artifacts/` line added in `4bfdf1e`)

The script walks `/chat`, `/read`, `/projects`, looks for radios named Studio / Calm blue / Soft pastel, clicks a Chats drawer, defaults `--url` examples to a production host, reads `.env.local` for the service-role key, and treats every console warning and every HTTP status ≥ 400 as a failure. The template's pages are `/`, `/items`, `/settings`, `/sign-in`, `/profile/edit`. Its theme control is `ThemeToggle` (`aria-label` `Theme: Light. Press to change.`), not radios. Do not rewrite this script. Delete it.

- [ ] **Step 1: Delete the three additions**

Delete `template/scripts/live-smoke.mjs`. Remove `"smoke": "node scripts/live-smoke.mjs",` from `template/package.json`. Remove `test-artifacts/` from `template/.gitignore`.

- [ ] **Step 2: Confirm nothing else imports it**

Run: `rg -n "live-smoke" --glob '!docs/superpowers/plans/**'`

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add -u template/scripts/live-smoke.mjs template/package.json template/.gitignore
git commit -m "$(cat <<'EOF'
fix: drop the MindScope live-smoke script from the template

It walked another app's pages, read the service-role key from
.env.local, and would fail a normal template app.

EOF
)"
```

---

### Task 4: Split starter sign-up so a shared-project trigger cannot wipe the password

**Files:**
- Modify: `template/src/lib/auth/server-signup.ts` (`starterSignup` only)
- Test: `tests/template-launch-contract.test.mjs` (extend the existing signup-modes test)

Verified sign-up stays as it is: `supabase.auth.signUp` with `emailRedirectTo: confirmRedirectUrl(SITE_URL)`. Do not remove that. The bug is only the starter admin call that sets `password` and `email_confirm: true` together.

- [ ] **Step 1: Extend the existing test**

Inside the test `signup modes: starter is the default...`, after the `email_confirm: true` assertion, add:

```javascript
  const starter = signup.slice(signup.indexOf('async function starterSignup'), signup.indexOf('async function verifiedSignup'));
  assert.match(starter, /createUser\(\{[\s\S]*email_confirm: true/);
  assert.doesNotMatch(starter.slice(starter.indexOf('createUser'), starter.indexOf('updateUserById')), /password/);
  assert.match(starter, /updateUserById\([\s\S]*password/);
  assert.ok(starter.indexOf('updateUserById') < starter.indexOf('deleteUser'), 'a failed password set deletes the user just created');
  assert.match(signup, /emailRedirectTo: confirmRedirectUrl\(SITE_URL\)/);
```

The last line is already in that test; do not duplicate it if the edit would repeat it. The new lines are the `starter` slice checks.

- [ ] **Step 2: Run it**

Run: `node --test tests/template-launch-contract.test.mjs`

Expected: FAIL because `password` is inside the `createUser` call and `updateUserById` / `deleteUser` are absent.

- [ ] **Step 3: Replace `starterSignup`**

```typescript
async function starterSignup(email: string, password: string): Promise<SignupResult> {
  const admin = createSupabaseAdmin();

  // Confirm first, set the password second. One shared-project trigger clears
  // encrypted_password when email_confirmed_at is set in the same update as the password.
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });

  if (error || !data.user?.id) {
    const msg = error?.message.toLowerCase() ?? "";
    if (error?.code === "email_exists" || msg.includes("already") || msg.includes("registered")) {
      return { ok: false, status: 409, error: "This email already has an account. Sign in instead." };
    }
    return { ok: false, status: 400, error: "Could not create the account. Check the email and try again." };
  }

  const createdId = data.user.id;
  const { error: passwordError } = await admin.auth.admin.updateUserById(createdId, { password });
  if (passwordError) {
    await admin.auth.admin.deleteUser(createdId);
    return { ok: false, status: 400, error: "Could not create the account. Check the email and try again." };
  }

  // The sign-up trigger normally makes the profile row; without it (shared project) make it now.
  await ensureProfile(createdId, email);

  return { ok: true, userId: createdId, needsConfirmation: false };
}
```

- [ ] **Step 4: Re-run**

Run: `node --test tests/template-launch-contract.test.mjs tests/provision-owner.test.mjs`

Expected: PASS. `provision-owner` still requires `ADMIN_EMAIL` to appear before `createUser`.

- [ ] **Step 5: Commit**

```bash
git add template/src/lib/auth/server-signup.ts tests/template-launch-contract.test.mjs
git commit -m "$(cat <<'EOF'
fix: set the starter password after confirm, and delete the user if that fails

A shared-project trigger empties encrypted_password when confirm and
password land in one admin createUser call. Verified sign-up is unchanged.

EOF
)"
```

---

### Task 5: Auth-trigger check that does not print secrets or emails

**Files:**
- Modify: `scripts/supabase-health.mjs`
- Modify: `skills/ops/references/auth-shared-project.md` (replace the file)
- Test: `tests/supabase-health.test.mjs`

**Interfaces:**
- Consumes: `runSql(auth, ref, query)` already exported from `scripts/lib/supabase-api.mjs`. It returns rows.
- Produces: `triggerReport(rows)` returns `{ name: string, touchesPassword: boolean }[]`. `run()` with `--auth-triggers` prints one line per trigger and never prints a row field other than `tgname` and whether `def` contains `encrypted_password`.

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `tests/supabase-health.test.mjs` to:

```javascript
import { healthyLines, run, triggerReport } from '../scripts/supabase-health.mjs';
```

Append:

```javascript
test('triggerReport flags a definition that writes encrypted_password and ignores other columns', () => {
  const rows = triggerReport([
    { tgname: 'clear_password_on_first_confirm', def: "BEFORE UPDATE BEGIN new.encrypted_password := ''; RETURN new; END" },
    { tgname: 'on_auth_user_created', def: 'AFTER INSERT BEGIN INSERT INTO public.profiles (id) VALUES (new.id); RETURN new; END' },
  ]);
  assert.deepEqual(rows, [
    { name: 'clear_password_on_first_confirm', touchesPassword: true },
    { name: 'on_auth_user_created', touchesPassword: false },
  ]);
});

test('--auth-triggers prints names only and does not select emails', async () => {
  let query = '';
  const said = [];
  const code = await run(['abcdefghijklmnopqrst', '--auth-triggers'], {
    say: (line) => said.push(line),
    getSecret: async () => 'sbp_test_token_not_real',
    runSql: async (_auth, _ref, sql) => {
      query = sql;
      return [{ tgname: 'on_auth_user_created', def: 'insert into profiles (id) values (new.id)' }];
    },
  });
  assert.equal(code, 0);
  assert.match(query, /pg_trigger/);
  assert.match(query, /::regclass/);
  assert.doesNotMatch(query, /select email/i);
  const text = said.join('\n');
  assert.match(text, /on_auth_user_created: does not touch encrypted_password/);
  assert.doesNotMatch(text, /@/);
});
```

`run` must accept `deps.runSql`. Call `run` directly, as written. Do not add a second import.

- [ ] **Step 2: Run the test**

Run: `node --test tests/supabase-health.test.mjs`

Expected: FAIL, `triggerReport` is not exported.

- [ ] **Step 3: Implement**

Add to `scripts/supabase-health.mjs`:

```javascript
export function triggerReport(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const item = row && typeof row === 'object' ? row : {};
    const name = typeof item.tgname === 'string' && item.tgname ? item.tgname : 'unnamed';
    const def = typeof item.def === 'string' ? item.def : '';
    return { name, touchesPassword: /encrypted_password/i.test(def) };
  });
}
```

Extend `USAGE` with a line: `--auth-triggers lists triggers on the shared sign-in table and whether each definition mentions encrypted_password. It prints no emails.`

In `run`, before reading the ref:

```javascript
const authTriggers = argv.includes('--auth-triggers');
const restart = argv.includes('--restart');
const ref = argv.find((arg) => arg !== '--restart' && arg !== '--auth-triggers' && !arg.startsWith('-'));
```

If both flags are set, `say` the usage and return 2.

After the token is loaded, if `authTriggers`:

```javascript
const runSql = deps.runSql ?? api.runSql;
const sql = `select tgname, pg_get_triggerdef(oid) as def
from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal`;
const rows = triggerReport(await runSql(auth, ref, sql));
if (rows.length === 0) say('No triggers on the shared sign-in table.');
for (const row of rows) {
  say(`${row.name}: ${row.touchesPassword ? 'touches encrypted_password' : 'does not touch encrypted_password'}`);
}
return 0;
```

Do not print `def`.

- [ ] **Step 4: Replace the runbook**

Replace `skills/ops/references/auth-shared-project.md` with this file and nothing else:

```markdown
# Shared Supabase project: auth troubleshooting

When several apps share one Supabase project, sign-in belongs to the project, not to one app. A trigger or a Site URL change made for one app can break sign-in for the others. Check that before changing app code.

## When sign-in says "invalid credentials" or every page returns to /sign-in

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref>`. The database, sign-in service and data API are reported separately. `/auth/v1/health` answering 200 does not mean the database is up.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/supabase-health.mjs" <project-ref> --auth-triggers`. It lists trigger names on the shared sign-in table and whether each definition mentions `encrypted_password`. It does not print addresses or passwords. A trigger that sets `encrypted_password` when `email_confirmed_at` becomes non-null will empty the password of every account created with confirm and password in one call.
3. Look at the project's Site URL in the Supabase dashboard. There is one Site URL per project. An emailed link that does not pass this app's own confirm address lands on whichever app set the Site URL last.

The script reads the access token from the Shipyard keys file. Do not grep that file, do not put the token in a command, and do not query `auth.users` for addresses.

## Rules for apps on a shared project

- Starter sign-up confirms the account first and sets the password in a second `updateUserById` call (`template/src/lib/auth/server-signup.ts`). If the password call fails, that user is deleted. Do not pass `password` and `email_confirm: true` in one `createUser`.
- Verified sign-up still uses `signUp` with `emailRedirectTo: confirmRedirectUrl(SITE_URL)`, which is this app's `/auth/confirm`. That redirect is required. Do not turn it off. Password sign-in does not depend on the Site URL.
- An `AFTER INSERT` trigger that creates this app's profile row is expected. A trigger that writes `encrypted_password` or `email`, or that raises for another app's update, is not.
- "Error sending confirmation email" on sign-up usually means the project has no SMTP yet. Starter mode (admin create, already confirmed, no mail) is the path until email is set up.
- The sign-in user is shared. Deleting the account from one app removes that app's rows only (`ACCOUNT_DATA_TABLES`). Do not delete the sign-in user while other apps use it.

## Restart

`supabase-health.mjs <project-ref> --restart` asks Supabase to restart the project. It takes about 5 minutes and does not refill a used-up disk IO budget. Ask the owner before passing `--restart`.
```

- [ ] **Step 5: Re-run and search**

Run: `node --test tests/supabase-health.test.mjs`

Run: `rg -n "secrets.env|Bearer \\$TOKEN|mindscope|commitr" skills/ops/references/auth-shared-project.md`

Expected: tests PASS. `rg` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add scripts/supabase-health.mjs skills/ops/references/auth-shared-project.md tests/supabase-health.test.mjs
git commit -m "$(cat <<'EOF'
fix: list shared-project auth triggers without reading the keys file

The runbook had a curl command that printed the access token and selected
email addresses. The health script prints trigger names only.

EOF
)"
```

---

### Task 6: Make the shadcn recipe match the template, then delete the incident doc

**Files:**
- Modify: `skills/design/references/shadcn-theme-packs.md`
- Modify: `skills/design/SKILL.md` (the Reference files list)
- Delete: `docs/lessons-2026-11-09.md`
- Test: `tests/design-shadcn-recipe.test.mjs` (create)

Template facts the recipe must match (`template/src/app/globals.css`):

- Text colour is `--muted`. Contrast on the accent is `--accent-contrast`. There is no `--on-accent`.
- `--sidebar-w` is a width (248px). There is no `--sidebar-bg`.
- One `@theme inline` block already contains `--font-sans: var(--app-font)`. Do not add a second block and do not set `--font-sans` again.

- [ ] **Step 1: Write the failing test**

Create `tests/design-shadcn-recipe.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = readFileSync(path.join(root, 'skills/design/references/shadcn-theme-packs.md'), 'utf8');
const skill = readFileSync(path.join(root, 'skills/design/SKILL.md'), 'utf8');

test('the shadcn recipe uses the template variable names and is linked from design', () => {
  assert.match(recipe, /var\(--accent-contrast\)/);
  assert.doesNotMatch(recipe, /--on-accent|--sidebar-bg|MindScope|Studio|Calm blue|Soft pastel/);
  assert.match(recipe, /extend the existing `@theme inline`/);
  assert.match(recipe, /do not set `--font-sans` again/);
  assert.match(skill, /shadcn-theme-packs\.md/);
  assert.equal(existsSync(path.join(root, 'docs/lessons-2026-11-09.md')), false);
});
```

Expected failure while the incident doc still exists: `true === false`.

- [ ] **Step 2: Run it**

Run: `node --test tests/design-shadcn-recipe.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Edit the recipe**

In `skills/design/references/shadcn-theme-packs.md`:

- Delete the sentence that names MindScope and the date. Open with: "Shipyard apps get their colours from theme packs and switch mode with `data-theme` on `<html>`. A plain `npx shadcn init` writes a static token block that breaks that."
- In the `@theme inline` sample, replace every `var(--on-accent)` with `var(--accent-contrast)`.
- Replace `--color-sidebar: var(--sidebar-bg, var(--card));` with `--color-sidebar: var(--card);`.
- Delete the `--font-sans` and `--font-heading` lines from the sample.
- Replace step 5 ("Do not add the font override") with: "Extend the existing `@theme inline` block in `globals.css`. Do not add a second one, and do not set `--font-sans` again (the template already maps it to `--app-font`)."
- Replace the verification bullet that names Studio, Calm blue and Soft pastel with: "Every pack this app actually has, in light, dark and Auto. The template's control is the cycle button `ThemeToggle` (`aria-label` starts with `Theme:`), not a radio group."
- Keep the `data-theme` custom variant, the muted-is-text versus shadcn-muted-is-surface warning, and the "delete the generated oklch `:root` block and the `.dark` block" steps.

In `skills/design/SKILL.md`, add `references/shadcn-theme-packs.md` (shadcn without breaking packs) to the Reference files sentence.

Then delete `docs/lessons-2026-11-09.md`.

- [ ] **Step 4: Re-run and search**

Run: `node --test tests/design-shadcn-recipe.test.mjs`

Run: `rg -n "mindscope.6x7.gr|commitr.6x7.gr" --glob '!docs/superpowers/plans/**'`

Expected: test PASS. `rg` prints nothing. `CHANGELOG.md` may still say `6x7` in older release notes; that is the owner decision to leave historical notes. Do not edit those old changelog entries. If `rg` hits only `CHANGELOG.md` or test fixtures, leave them.

- [ ] **Step 5: Commit**

```bash
git add skills/design/references/shadcn-theme-packs.md skills/design/SKILL.md tests/design-shadcn-recipe.test.mjs
git add -u docs/lessons-2026-11-09.md
git commit -m "$(cat <<'EOF'
fix: point the shadcn recipe at the template's real variables

The recipe cited colours the template does not have and a doc that
put production hostnames back in the public repo. The doc is gone.

EOF
)"
```

---

### Task 7: Fix the 0.8.11 skill contradictions

**Files:**
- Modify: every `skills/*/SKILL.md` install line and working-rules line (12 skills)
- Modify: `skills/video/SKILL.md` description and the "two ways" sentence
- Modify: `skills/email/SKILL.md` description
- Modify: `skills/email/references/email-domain.md` section 3 opening paragraph
- Modify: `skills/design/references/presets.md` lines 3 and 20
- Modify: `skills/design/references/apply-design.md`
- Modify: `scripts/agents/header.md` helper-agent bullet
- Modify: `skills/setup/references/checked-facts.md` (WCAG sentence and the final section)
- Test: `tests/skill-pointers.test.mjs` (create)

ux-redesign's second sentence stays: "Steps 1 to 5 need only a browser and Node; step 6 builds in the student's own repo."

- [ ] **Step 1: Write the failing test**

Create `tests/skill-pointers.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');
const skills = readdirSync(skillsDir).filter((name) => readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'));

test('every skill orders a read of the shared rules and links the install doc', () => {
  for (const name of skills) {
    const text = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(text, /https:\/\/github\.com\/philipposk\/shipyard\/blob\/main\/INSTALL\.md/, name);
    assert.match(text, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/new-app\/references\/working-rules\.md` now, before any other step/, name);
  }
});

test('video still offers a real screen recording, and email keeps its registrar and notify triggers', () => {
  const video = readFileSync(path.join(skillsDir, 'video/SKILL.md'), 'utf8');
  assert.doesNotMatch(video, /no screen recording/);
  assert.match(video, /three ways/);
  assert.match(video, /Real run/);
  const email = readFileSync(path.join(skillsDir, 'email/SKILL.md'), 'utf8');
  assert.match(email, /Papaki DNS/);
  assert.match(email, /notify me when deployed/);
  const domain = readFileSync(path.join(skillsDir, 'email/references/email-domain.md'), 'utf8');
  assert.doesNotMatch(domain, /5\.7\/10|10\/10/);
});

test('a look does not silently change the menu, and review security helpers stay on the strongest model', () => {
  const presets = readFileSync(path.join(skillsDir, 'design/references/presets.md'), 'utf8');
  assert.match(presets, /--keep-layout` unless the student asked for that look's menu/);
  assert.doesNotMatch(presets, /applying one changes the structure as well as the colours/);
  const apply = readFileSync(path.join(skillsDir, 'design/references/apply-design.md'), 'utf8');
  assert.match(apply, /design skill passes `--keep-layout` unless the student asked/);
  const header = readFileSync(path.join(root, 'scripts/agents/header.md'), 'utf8');
  assert.match(header, /review skill assigns its sign-in, data-rules, live-audio, AI-cost and database helpers your strongest model/);
  assert.doesNotMatch(header, /helpers there only do mechanical work/);
  const facts = readFileSync(path.join(skillsDir, 'setup/references/checked-facts.md'), 'utf8');
  assert.doesNotMatch(facts, /Left for a future agent/);
  assert.match(facts, /2\.5\.8 Target Size \(Minimum\) is 24/);
  assert.match(facts, /2\.5\.5 Target Size \(Enhanced\) is 44/);
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/skill-pointers.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Apply the text**

Install line, every skill except ux-redesign:

```markdown
> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.
```

ux-redesign:

```markdown
> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md). Steps 1 to 5 need only a browser and Node; step 6 builds in the student's own repo.
```

Working-rules line, all 12 skills. Replace the bare citation with:

```markdown
Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.
```

Video description: delete the words `no screen recording`. In the body, change `There are two ways to show the app:` to `There are three ways to show the app:`. Leave the Real run bullet.

Email description: put these triggers back into the existing description string, without removing the ones already there: `Papaki DNS` and `notify me when deployed`.

`skills/email/references/email-domain.md` section 3, replace the sentence that contains `5.7/10` and `10/10` with:

`**Mandatory route: Resend SMTP.** Gmail send-as through smtp.gmail.com fails DMARC, because the envelope stays gmail.com and the signature is Google's. Resend SMTP signs as the domain, so SPF, DKIM and DMARC pass. Adding _spf.google.com to SPF does not fix the Gmail route. On a deliverability test, aim for 9/10 or better.`

`skills/design/references/presets.md` line 3: delete "the menu style (tabs at the bottom, a left sidebar, or links across the top),". A look still sets homepage style, cards, buttons and text size.

Replace line 20 with:

`Each look records a menu, homepage, card, button and spacing style. The design skill passes `--keep-layout` unless the student asked for that look's menu, so applying a preset keeps the app's current navigation. Drop the flag only when they asked for the look's menu too.`

`skills/design/references/apply-design.md`, add under the options list:

`- The design skill passes `--keep-layout` unless the student asked for the look's own menu. Navigation is a separate setting from the colours.`

`scripts/agents/header.md`, replace the helper bullet with:

```markdown
> - Helper agents are optional. The review skill assigns its sign-in, data-rules, live-audio, AI-cost and database helpers your strongest model. Every other helper gets a smaller, cheaper model and mechanical work only.
```

`skills/setup/references/checked-facts.md`:

- Replace the touch-target decision sentence so it says WCAG 2.5.8 Target Size (Minimum) is 24 CSS pixels at AA, and WCAG 2.5.5 Target Size (Enhanced) is 44 CSS pixels at AAA. Shipyard keeps 44 because the template's buttons are already 44. The 24px hit area for small controls stays.
- Delete the whole section `## Left for a future agent (owner's note, 8 Nov 2026)` and its paragraph.

- [ ] **Step 4: Re-run pack and pointer tests**

Run: `node --test tests/skill-pointers.test.mjs tests/agents-pack.test.mjs tests/new-skill-scaffold.test.mjs`

Expected: PASS. If the pack lint rejects a word you added, reword that sentence. Do not weaken the lint.

- [ ] **Step 5: Commit**

```bash
git add skills scripts/agents/header.md tests/skill-pointers.test.mjs
git commit -m "$(cat <<'EOF'
fix: make the shared skill rules load, and drop leftover contradictions

Skills now say to read the working rules before any step, the install
link is a URL again, and video, email, design and review no longer disagree.

EOF
)"
```

Do not `git add` the unstaged Sparks pointer or untracked files. `git add skills` will pick up `skills/new-app/references/lessons.md` if that dirty pointer is still there. Stage skill files by path, or restore that lessons hunk first:

```bash
git checkout -- skills/new-app/references/lessons.md
```

Then `git add` only the skill files this task changed.

---

### Task 8: Release notes for 0.8.12

**Files:**
- Modify: `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` (`"version": "0.8.12"`)
- Modify: `CHANGELOG.md` (new section above 0.8.11)

- [ ] **Step 1: Bump and write the section**

```markdown
## What changed in 0.8.12

- The server-key check no longer allows every file under a shared folder name. An app that needs the key lists an exact file.
- Saving a new profile always leaves the page with a full load. Starter sign-up confirms the account, then sets the password, and deletes the user if the password step fails.
- Shared-project auth checks list trigger names from the health script. They do not read the keys file or print addresses.
- Skill rules that every skill shares have to be read before the skill's own steps. The video skill still includes a real screen recording when the student asks.
```

- [ ] **Step 2: Run the release check and the root suite**

Run: `node scripts/check-release.mjs`

Run: `node --test tests/*.test.mjs`

Expected: `release check ok: v0.8.12`. Root suite: 0 fail. Skips are acceptable. Then `node --test template/tests/*.test.mjs` if Task 4 or Task 2 touched template behaviour the template suite imports. `server-signup.ts` is not imported by template tests (they are source scans in the root suite). Run the template suite anyway if time allows; a failure there is in scope.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json .cursor-plugin/plugin.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: 0.8.12 notes for the server-key, sign-up and skill-rule fixes

EOF
)"
```

- [ ] **Step 4: Push the feature branch only**

```bash
git push origin HEAD
```

Do not merge PR #45. Leave it open for review.

## Done when

- `rg` finds no `lib/chat/` inside `SERVER_KEY_ALLOWED` or `RISKY_PATHS`.
- `template/scripts/live-smoke.mjs` and `docs/lessons-2026-11-09.md` are gone.
- `starterSignup` does not pass `password` into `createUser`.
- `auth-shared-project.md` has no `secrets.env` and no `Bearer`.
- `shadcn-theme-packs.md` has `--accent-contrast` and no `--on-accent`.
- Every `skills/*/SKILL.md` contains the INSTALL.md URL and the "Read ... working-rules.md now" sentence.
- Video description does not say `no screen recording`.
- `node scripts/check-release.mjs` prints `v0.8.12`.
- Root tests have 0 failures.
- `main` was not pushed and PR #45 was not merged.

## Out of scope

- Implementing `shipyard.server-key.json` per-app allowlists. This plan only removes the blanket folders. A later change can add an app-local exact-file list if MindScope still needs files outside the template allowlist. Do that in the MindScope repo, not by putting MindScope paths back into this plugin.
- Rewriting a generic Playwright live smoke. The template already has `verify` and Playwright in devDependencies.
- The unstaged Sparks lessons pointer, `CLEANUP-PLAN.md`, and `valuer-todo-site/`.
- Re-checking Instagram, Shorts, or the Vercel pin. Those decisions in `checked-facts.md` stay, except the WCAG citation and the "future agent" section.
