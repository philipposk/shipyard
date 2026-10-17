// Checks the SQL in supabase/migrations for the two rules that make an app safe to move into its own schema inside
// a Supabase project shared with other apps (Shipyard "shared" mode):
//   1. every object is written with its schema (`public.items`), so swapping `public.` for the app's schema catches all of it;
//   2. the only trigger on auth.users is the one in 0001_profiles.sql, between the shipyard:auth-trigger markers
//      (shared mode drops that block: a trigger on auth.users would run for every app's sign-ups).
// It is a plain-text check, not a SQL parser, so it errs on the side of complaining: if it flags something you did on
// purpose, make the SQL explicit rather than loosening the check.
// Used by shared-sql.test.mjs (your real migrations) and by Shipyard's own tests (bad and good examples).

export const START = "-- shipyard:auth-trigger:start";
export const END = "-- shipyard:auth-trigger:end";

/** Removes `-- ...` and block comments (not inside strings, good enough for our SQL). */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Mirrors the spec: drop every block between the markers. */
export function dropMarkerBlocks(sql) {
  return sql.replace(/-- shipyard:auth-trigger:start[\s\S]*?-- shipyard:auth-trigger:end[^\n]*\n?/g, '');
}

/** Mirrors the spec: word-boundary `public.` becomes `<schema>.`; the role word `public` (no dot) is untouched. */
export function swapSchema(sql, schema) {
  return sql.replace(/\bpublic\./g, `${schema}.`);
}

const IDENT = String.raw`((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)`;
const OPT = String.raw`(?:if\s+not\s+exists\s+|if\s+exists\s+|only\s+|concurrently\s+)*`;

/** Names that need no schema: Postgres' own catalogs are always found first. */
const isSystem = (name) => /^"?pg_/i.test(name);
const isQualified = (name) => /\./.test(name);

/**
 * @returns {string[]} one plain sentence per problem
 */
export function lintSql(sqlWithComments, { allowAuthTrigger = false } = {}) {
  const problems = [];
  const hasMarkers = sqlWithComments.includes(START) || sqlWithComments.includes(END);
  const startAt = sqlWithComments.indexOf(START);
  const endAt = sqlWithComments.indexOf(END);
  if (hasMarkers && !(startAt !== -1 && endAt > startAt)) problems.push('auth-trigger markers are not a start/end pair in that order');
  if (hasMarkers && sqlWithComments.split(START).length > 2) problems.push('more than one auth-trigger block');

  // Triggers on auth.users are only allowed inside the markers of the template's own migration.
  const outside = stripComments(dropMarkerBlocks(sqlWithComments)).replace(/\s+/g, ' ');
  const inside = stripComments(sqlWithComments).replace(/\s+/g, ' ');
  if (/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b/i.test(outside)) problems.push('a trigger is created outside the auth-trigger markers');
  if (/\b(?:alter|drop)\s+trigger\b/i.test(outside) || /\bdrop\s+trigger\b[^;]*\bon\s+"?auth"?\s*\./i.test(outside)) problems.push('a trigger is changed or dropped outside the auth-trigger markers');
  if (/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?auth"?\s*\./i.test(inside)) problems.push('alters a table in the auth schema');
  if (!allowAuthTrigger && /\bcreate\s+(?:or\s+replace\s+)?trigger\b/i.test(inside)) problems.push('this file may not create any trigger');

  const sql = inside; // comments gone, whitespace collapsed
  const check = (re, what, group = 1) => {
    for (const m of sql.matchAll(re)) {
      const name = m[group];
      if (!name || isSystem(name) || isQualified(name)) continue;
      problems.push(`${what} "${name}" has no schema in front`);
    }
  };

  check(new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:temp\s+|temporary\s+|unlogged\s+)?(?:table|view|materialized\s+view|sequence|type|function|procedure)\s+${OPT}${IDENT}`, 'gi'), 'created object');
  check(new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+${OPT}(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s+on\s+${OPT}${IDENT}`, 'gi'), 'indexed table');
  check(new RegExp(String.raw`\b(?:create|drop)\s+policy\s+${OPT}(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s+on\s+${IDENT}`, 'gi'), 'policy table');
  check(new RegExp(String.raw`\b(?:create(?:\s+or\s+replace)?|drop)\s+trigger\s+${OPT}(?:"[^"]+"|[a-z_][a-z0-9_$]*)[^;]*?\bon\s+${IDENT}`, 'gi'), 'trigger table');
  check(new RegExp(String.raw`\balter\s+(?:table|function|sequence|view|type)\s+${OPT}${IDENT}`, 'gi'), 'altered object');
  check(new RegExp(String.raw`\bdrop\s+(?:table|function|view|sequence|type|index|materialized\s+view)\s+${OPT}${IDENT}`, 'gi'), 'dropped object');
  check(new RegExp(String.raw`\breferences\s+${IDENT}`, 'gi'), 'referenced table');
  check(new RegExp(String.raw`\binsert\s+into\s+${IDENT}`, 'gi'), 'insert target');
  check(new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${IDENT}`, 'gi'), 'delete target');
  check(new RegExp(String.raw`\bupdate\s+(?:only\s+)?${IDENT}\s+set\b`, 'gi'), 'update target');
  check(new RegExp(String.raw`\bcomment\s+on\s+(?:table|column|function|index)\s+${IDENT}`, 'gi'), 'commented object');
  check(new RegExp(String.raw`\bexecute\s+(?:function|procedure)\s+${IDENT}`, 'gi'), 'trigger function');

  // from / join (but not "revoke ... from role", "is distinct from", "delete from" which is handled above)
  const noRevoke = sql.replace(/\brevoke\b[^;]*;/gi, ' ').replace(/\bis\s+(?:not\s+)?distinct\s+from\b/gi, ' ');
  for (const m of noRevoke.matchAll(new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${IDENT}`, 'gi'))) {
    const name = m[1];
    if (isSystem(name) || isQualified(name)) continue;
    // "delete from x" is already reported; a sub-select "from (" does not match IDENT.
    if (/\bdelete\s+from\s*$/i.test(noRevoke.slice(Math.max(0, m.index - 12), m.index + 4))) continue;
    problems.push(`table in from/join "${name}" has no schema in front`);
  }

  // grant / revoke ... on <objects> to|from
  for (const m of sql.matchAll(/\b(?:grant|revoke)\b[^;]*?\bon\s+(?!all\b)(?:table\s+|function\s+|sequence\s+|procedure\s+)?([^;]*?)\s+(?:to|from)\b/gi)) {
    const list = m[1].replace(/\([^)]*\)/g, '');
    for (const raw of list.split(',')) {
      const name = raw.trim();
      if (name && !isSystem(name) && !isQualified(name)) problems.push(`grant/revoke object "${name}" has no schema in front`);
    }
  }

  // functions the file defines must be called with their schema too
  const defined = [...sql.matchAll(new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)([a-z_][a-z0-9_]*)`, 'gi'))].map((m) => m[1]);
  for (const fn of new Set(defined)) {
    for (const m of sql.matchAll(new RegExp(String.raw`(?<![.\w"])${fn}\s*\(`, 'gi'))) {
      problems.push(`call to "${fn}(" has no schema in front (at ${m.index})`);
    }
  }

  // things the `public.` swap would miss, or that would still point at public
  if (/"public"/.test(sql)) problems.push('quoted "public" schema (the swap does not see it)');
  if (/\bpublic\s+\./i.test(sql)) problems.push('"public ." with a space (the swap does not see it)');
  if (/\bPUBLIC\./.test(sql)) problems.push('upper case PUBLIC. (the swap does not see it)');
  for (const m of stripComments(sqlWithComments).matchAll(/\bsearch_path\s*(?:=|to)\s*([^\n$;]*)/gi)) {
    if (/\bpublic\b/i.test(m[1])) problems.push('search_path mentions public');
  }
  if (/\bset\s+schema\b|\bcreate\s+schema\b|\bdrop\s+schema\b/i.test(sql)) problems.push('a migration must not create, drop or move schemas');

  return [...new Set(problems)];
}

