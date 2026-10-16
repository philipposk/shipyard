// Check: one user can never see or change another user's data.
// For every table listed in supabase/isolation.json it makes two throwaway users. User A gets a row; then
// user B and an anonymous visitor try to read, change and delete it. All of that must fail.
// Rows and users are removed at the end.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pass, failed, skip } from './util.mjs';
import { createSupabase, supabaseFromEnv, randomPassword, randomTestEmail, isIdentifier } from './supabase.mjs';

const MARK = 'shipyard-isolation-test';
const SKIP_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

async function readEntries(appDir) {
  let text;
  try {
    text = await readFile(path.join(appDir, 'supabase', 'isolation.json'), 'utf8');
  } catch {
    return { error: 'supabase/isolation.json is missing. List every table that holds user data in it, as [{ "table": "...", "ownerColumn": "..." }]' };
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { error: 'supabase/isolation.json is not valid JSON' };
  }
  if (!Array.isArray(list) || list.length === 0) return { error: 'supabase/isolation.json has no tables listed' };
  for (const e of list) {
    if (!e || !isIdentifier(e.table) || !isIdentifier(e.ownerColumn)) {
      return { error: 'every entry in supabase/isolation.json needs a "table" and an "ownerColumn" (letters, digits and underscores only)' };
    }
  }
  return { list };
}

/** Ways to create a row for user A, tried in order. An entry can give its own with "insert". */
function insertCandidates(entry, userId) {
  const owner = { [entry.ownerColumn]: userId };
  if (entry.insert && typeof entry.insert === 'object') return [{ ...entry.insert, ...owner }];
  return [{ ...owner, title: MARK }, { ...owner, name: MARK }, { ...owner, body: MARK }, { ...owner, content: MARK }, owner];
}

/** Columns we can try to change on a row, most likely first. */
function editableColumns(row, ownerColumn) {
  const cols = Object.keys(row).filter((k) => k !== ownerColumn && !SKIP_COLUMNS.has(k) && !k.endsWith('_id') && isIdentifier(k));
  const strings = cols.filter((k) => typeof row[k] === 'string');
  const empty = cols.filter((k) => row[k] === null);
  return [...strings, ...empty].slice(0, 5);
}

async function testTable(sb, entry, A, B) {
  const { table, ownerColumn } = entry;
  const oc = encodeURIComponent(ownerColumn);
  const ownedByA = `${oc}=eq.${encodeURIComponent(A.id)}`;
  const problems = [];
  const notes = [];
  const warnings = [];
  let created = false;

  // 1. User A needs a row to protect. The sign-up trigger may have made one already (profiles).
  // Tables only the server may write to (payments, email list) are marked "seed": "server": the row is made with the
  // secret key, because signed-in people are not allowed to write there, and that is exactly what we want to keep.
  const serverSeeded = entry.seed === 'server';
  const asOwner = serverSeeded ? { server: true } : { token: A.token };
  let rowA = null;
  if (serverSeeded) {
    const body = { ...(entry.insert && typeof entry.insert === 'object' ? entry.insert : {}), [ownerColumn]: A.id };
    const res = await sb.rest(table, { method: 'POST', body, as: { server: true }, prefer: 'return=representation' });
    if (!res.ok || res.rows.length === 0) {
      return {
        problems: [`${table}: could not create a test row with the secret key (${res.error}). Check the "insert" example for this table in supabase/isolation.json.`],
        notes, warnings, created,
      };
    }
    rowA = res.rows[0];
    created = true;
    entry._body = body;
  } else {
    const existing = await sb.rest(table, { query: `select=*&${ownedByA}&limit=1`, as: { token: A.token } });
    if (existing.ok && existing.rows.length > 0) {
      rowA = existing.rows[0];
    } else {
      let lastError = existing.error;
      for (const body of insertCandidates(entry, A.id)) {
        const res = await sb.rest(table, { method: 'POST', body, as: { token: A.token }, prefer: 'return=representation' });
        if (res.ok && res.rows.length > 0) {
          rowA = res.rows[0];
          created = true;
          entry._body = body;
          break;
        }
        lastError = res.error;
      }
      if (!rowA) {
        return {
          problems: [`${table}: could not create a test row (${lastError}). Add an "insert" example to this entry in supabase/isolation.json, e.g. { "table": "${table}", "ownerColumn": "${ownerColumn}", "insert": { "title": "x" } }`],
          notes, warnings, created,
        };
      }
    }
  }

  // 2. User B must not see A's rows.
  const seeFiltered = await sb.rest(table, { query: `select=${oc}&${ownedByA}`, as: { token: B.token } });
  const seeAll = await sb.rest(table, { query: `select=${oc}&limit=1000`, as: { token: B.token } });
  const leaked = [...seeFiltered.rows, ...seeAll.rows].some((r) => r?.[ownerColumn] === A.id);
  if (leaked) problems.push(`${table}: another signed-in user can read this user's rows. Add or fix the select policy (row level security)`);
  else notes.push('other users cannot read it');

  // 3. User B must not change A's rows. First prove the change works for A, so "0 rows" means something.
  let editColumn = null;
  for (const col of editableColumns(rowA, ownerColumn)) {
    const res = await sb.rest(table, { method: 'PATCH', query: ownedByA, body: { [col]: MARK }, as: asOwner, prefer: 'return=representation' });
    if (res.ok && res.rows.length > 0) {
      editColumn = col;
      break;
    }
  }
  if (!editColumn) {
    warnings.push(`${table}: found no column the owner can edit, so "other users cannot edit" was not tested`);
  } else {
    const res = await sb.rest(table, { method: 'PATCH', query: ownedByA, body: { [editColumn]: `${MARK}-by-b` }, as: { token: B.token }, prefer: 'return=representation' });
    if (res.ok && res.rows.length > 0) problems.push(`${table}: another signed-in user can edit this user's rows. Add or fix the update policy`);
    else notes.push('other users cannot edit it');
  }

  // 4. User B must not delete A's rows.
  const del = await sb.rest(table, { method: 'DELETE', query: ownedByA, as: { token: B.token }, prefer: 'return=representation' });
  const deletedByB = del.ok && del.rows.length > 0;
  if (deletedByB) problems.push(`${table}: another signed-in user can delete this user's rows. Add or fix the delete policy`);
  else notes.push('other users cannot delete it');
  const still = await sb.rest(table, { query: `select=${oc}&${ownedByA}&limit=1`, as: serverSeeded ? { server: true } : { token: A.token } });
  if (still.ok && still.rows.length === 0 && !deletedByB) {
    problems.push(`${table}: the test row disappeared while another user tried to delete it`);
  }

  // 5. User B must not be able to create a row that belongs to A.
  if (created) {
    const spoof = await sb.rest(table, { method: 'POST', body: entry._body, as: { token: B.token }, prefer: 'return=representation' });
    if (spoof.ok && spoof.rows.length > 0) problems.push(`${table}: a signed-in user can create rows in someone else's name. The insert policy needs "with check (${ownerColumn} = auth.uid())"`);
    else notes.push('nobody can create rows in another user\'s name');
  }

  // 6. A visitor who is not signed in sees nothing.
  const anon = await sb.rest(table, { query: `select=${oc}&limit=5` });
  if (anon.ok && anon.rows.length > 0) problems.push(`${table}: visitors who are not signed in can read rows. Remove the public select policy or grant`);
  else notes.push('visitors who are not signed in see nothing');

  return { problems, notes, warnings, created };
}

export async function check(ctx) {
  const name = 'isolation';
  const env = supabaseFromEnv(ctx.secrets);
  if (!env.ok) return skip(name, env.reason);

  const parsed = await readEntries(ctx.appDir);
  if (parsed.error) return failed(name, 'isolation list problem', [parsed.error]);

  const sb = createSupabase(env);
  const users = [];
  const details = [];
  const problems = [];
  const warnings = [];
  const touched = [];
  let early = null; // set when the test can not go on; the result is built AFTER cleanup so cleanup problems are included

  try {
    for (const label of ['A', 'B']) {
      const email = randomTestEmail();
      const password = randomPassword();
      const created = await sb.createUser(email, password);
      if (!created.ok) {
        early = { summary: 'could not create test users', problems: [`Supabase said: ${sb.redact(created.error)}`, 'Check the keys in .env.local belong to this app\'s Supabase project.'] };
        break;
      }
      const user = { label, id: created.id, email };
      users.push(user);
      const signedIn = await sb.signIn(email, password);
      if (!signedIn.ok) {
        early = { summary: 'could not sign in test users', problems: [`test user ${label} could not sign in (${sb.redact(signedIn.error).split(password).join('***')})`] };
        break;
      }
      user.token = signedIn.accessToken;
    }

    if (!early) {
      const [A, B] = users;
      for (const entry of parsed.list) {
        // Remember the table BEFORE testing it, so a test that stops halfway still gets its rows cleaned up.
        touched.push({ ...entry });
        const r = await testTable(sb, { ...entry }, A, B);
        problems.push(...r.problems);
        warnings.push(...r.warnings);
        if (r.problems.length === 0) details.push(`${entry.table}: ${r.notes.join('; ')}`);
      }
    }
  } catch (err) {
    problems.push(`stopped early: ${sb.redact(err?.message ?? 'unknown error')}`);
  } finally {
    // Remove test rows with the secret key (it skips privacy rules), then the users (which removes the rest).
    for (const t of touched) {
      for (const u of users) {
        await sb.rest(t.table, { method: 'DELETE', query: `${encodeURIComponent(t.ownerColumn)}=eq.${encodeURIComponent(u.id)}`, as: { server: true } }).catch(() => {});
      }
    }
    const notDeleted = [];
    for (const u of users) {
      const gone = await sb.deleteUser(u.id).catch(() => ({ ok: false }));
      if (!gone.ok) notDeleted.push(`test user ${u.email} was NOT deleted. Remove it in Supabase > Authentication > Users`);
    }
    problems.push(...notDeleted);
    if (early) early.problems.push(...notDeleted);
    if (users.length > 0 && notDeleted.length === 0) details.push('test users and rows deleted');
  }

  if (early) return failed(name, early.summary, early.problems);
  const extra = { warnings };
  if (problems.length > 0) return failed(name, `${problems.length} privacy problem${problems.length === 1 ? '' : 's'} found`, problems, { details, ...extra });
  return pass(name, `${parsed.list.length} table${parsed.list.length === 1 ? '' : 's'} keep each user's data private`, details, extra);
}
