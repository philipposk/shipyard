// Reads the SQL in supabase/migrations and returns a list of privacy problems.
// Used by schema-rules.test.mjs (on your real migrations) and schema-rules-checker.test.mjs (on bad examples,
// so the rules themselves are tested). It is a plain-text check, not a SQL parser, so it errs on the side of
// complaining: if it flags something you did on purpose, make the SQL explicit rather than loosening the test.

/**
 * Split SQL into statements. Comments are removed, and the inside of string literals and $$ bodies is blanked,
 * so words in comments and messages never count. Quoted names ("Notes") are kept.
 */
export function statements(sql) {
  const out = [];
  let cur = "";
  const n = sql.length;
  let i = 0;
  const push = () => {
    const s = cur.replace(/\s+/g, " ").trim();
    if (s) out.push(s);
    cur = "";
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      cur += " ";
    } else if (c === "/" && d === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      cur += " ";
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += "''";
      i = j + 1;
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))[0];
      const end = sql.indexOf(tag, i + tag.length);
      cur += `${tag}${tag}`;
      i = end === -1 ? n : end + tag.length;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === ";") {
      push();
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  push();
  return out;
}

const NAME = String.raw`(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))`;
// optional schema, then the name:  public.notes  "public"."Notes"  notes
const QUALIFIED = String.raw`(?:${NAME}\s*\.\s*)?${NAME}`;

/** [schema|null, name] from the four capture groups of QUALIFIED starting at index `at` of a match. */
function qualified(m, at) {
  const schema = m[at] ?? m[at + 1] ?? null;
  const name = m[at + 2] ?? m[at + 3];
  return [schema ? schema.toLowerCase() : null, String(name).replace(/""/g, '"').toLowerCase()];
}

const isPublicSchema = (schema) => schema === null || schema === "public";

/** What the migrations create: tables and views in the public schema. */
export function relations(sql) {
  const tables = [];
  const views = [];
  for (const st of statements(sql)) {
    let m = new RegExp(`^create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, "i").exec(st);
    if (m) {
      const [schema, name] = qualified(m, 1);
      if (isPublicSchema(schema)) tables.push(name);
      continue;
    }
    m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:(?:temp|temporary)\\s+)?(?:recursive\\s+)?(materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, "i").exec(st);
    if (m) {
      const [schema, name] = qualified(m, 2);
      if (isPublicSchema(schema)) views.push({ name, materialized: Boolean(m[1]), invoker: /\bwith\s*\([^)]*\bsecurity_invoker\s*(?:=\s*)?(?:true|on|1)\b/i.test(st) });
    }
  }
  return { tables: [...new Set(tables)], views };
}


/** Roles a grant is given to, from the text after its last " to ". */
function grantedTo(st) {
  const idx = st.toLowerCase().lastIndexOf(" to ");
  if (idx === -1) return [];
  return st
    .slice(idx + 4)
    .replace(/\bwith\s+grant\s+option\b/i, "")
    .replace(/\bgranted\s+by\b.*$/i, "")
    .split(",")
    .map((r) => r.replace(/^\s*group\s+/i, "").replace(/"/g, "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} sql        all migrations joined
 * @param {{table: string}[]} isolation  parsed supabase/isolation.json
 * @returns {string[]}        one plain-English line per problem
 */
export function findProblems(sql, isolation = []) {
  const problems = [];
  const sts = statements(sql);
  const { tables, views } = relations(sql);

  // 1. Every table: RLS on, and listed in isolation.json.
  for (const table of tables) {
    const rls = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED}\\s+enable\\s+row\\s+level\\s+security\\b`, "i");
    const has = sts.some((st) => {
      const m = rls.exec(st);
      if (!m) return false;
      const [schema, name] = qualified(m, 1);
      return isPublicSchema(schema) && name === table;
    });
    if (!has) problems.push(`public.${table} needs: alter table public.${table} enable row level security;`);
    if (!isolation.some((e) => String(e.table).toLowerCase() === table)) {
      problems.push(`add { "table": "${table}", "ownerColumn": "..." } to supabase/isolation.json so verify tests it`);
    }
  }
  for (const st of sts) {
    if (/^alter\s+table\b.*\b(?:disable|no\s+force)\s+row\s+level\s+security\b/i.test(st)) {
      problems.push(`row level security must never be switched off: ${st.slice(0, 80)}`);
    }
  }

  // 2. Views ignore the privacy rules of their tables unless they run as the person asking.
  for (const v of views) {
    if (v.materialized) {
      problems.push(`public.${v.name} is a materialized view. These can not follow privacy rules, so every signed-in person could read all of it. Use a normal view or a table.`);
    } else if (!v.invoker) {
      problems.push(`public.${v.name} is a view without "with (security_invoker = true)". Without it the view skips the privacy rules of its tables and shows every row.`);
    } else if (!isolation.some((e) => String(e.table).toLowerCase() === v.name)) {
      problems.push(`add { "table": "${v.name}", "ownerColumn": "..." } to supabase/isolation.json so verify tests the view`);
    }
  }
  for (const entry of isolation) {
    const name = String(entry.table).toLowerCase();
    if (!tables.includes(name) && !views.some((v) => v.name === name)) {
      problems.push(`isolation.json lists ${entry.table}, but no migration creates it`);
    }
  }

  // 3. Nothing is opened to visitors who are not signed in.
  for (const st of sts) {
    if (/^(?:alter\s+default\s+privileges\b.*\bgrant\b|grant\b)/i.test(st)) {
      const bad = grantedTo(st).filter((r) => r === "anon" || r === "public");
      if (bad.length > 0) problems.push(`a grant is given to ${bad.join(", ")}, which includes visitors who are not signed in: ${st.slice(0, 90)}`);
    }
    const policy = new RegExp(`^create\\s+policy\\s+${NAME}\\s+on\\s+`, "i").exec(st);
    if (policy) {
      const name = policy[1] ?? policy[2];
      const head = st.replace(/"(?:[^"]|"")*"/g, '"x"').split(/\s+(?:using|with\s+check)\b/i)[0];
      const to = /\bto\s+(.+)$/i.exec(head);
      const roles = to ? to[1].split(",").map((r) => r.replace(/"/g, "").trim().toLowerCase()) : [];
      if (roles.length === 0) {
        problems.push(`policy "${name}" has no "to" part, so it applies to everyone including visitors who are not signed in. Add: to authenticated`);
      } else if (!roles.every((r) => r === "authenticated" || r === "service_role")) {
        problems.push(`policy "${name}" is given to ${roles.join(", ")}. Policies may only name authenticated (or service_role)`);
      }
    }
  }

  // 4. Security definer functions run with their owner's power, so nobody but the server key may call them.
  for (const st of sts) {
    const m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+${QUALIFIED}\\s*\\(`, "i").exec(st);
    if (!m || !/\bsecurity\s+definer\b/i.test(st)) continue;
    const [schema, name] = qualified(m, 1);
    if (!/\bset\s+search_path\s*=\s*''/i.test(st)) problems.push(`function ${name}: security definer functions need: set search_path = ''`);
    const revoked = new Set();
    for (const r of sts) {
      const rm = new RegExp(`^revoke\\s+(?:all|execute)\\b.*?\\bon\\s+function\\s+${QUALIFIED}\\s*\\(`, "i").exec(r);
      if (!rm) continue;
      const [rs, rn] = qualified(rm, 1);
      if (rn !== name || !isPublicSchema(rs) || !isPublicSchema(schema)) continue;
      const from = /\bfrom\s+(.+)$/i.exec(r);
      for (const role of (from?.[1] ?? "").split(",")) revoked.add(role.replace(/"/g, "").trim().toLowerCase());
    }
    const missing = ["public", "anon", "authenticated"].filter((role) => !revoked.has(role));
    if (missing.length > 0) {
      problems.push(`function ${name} is security definer but is still callable by ${missing.join(", ")}. Add: revoke execute on function public.${name}(...) from public, anon, authenticated;`);
    }
  }

  // 5. Policies run their condition once per row. A bare auth.uid() / auth.jwt() or a function called with a column
  //    (has_access(library_id)) runs again for every row: thousands of rows means seconds per query. Wrap auth calls
  //    in a subselect, and check membership as  col in (select private.allowed_ids())  so Postgres runs it once.
  for (const st of sts) {
    const policy = new RegExp(`^(?:create|alter)\\s+policy\\s+${NAME}\\s+on\\s+`, "i").exec(st);
    if (!policy) continue;
    const name = policy[1] ?? policy[2];
    const cond = st.replace(/"(?:[^"]|"")*"/g, '"x"').split(/\s+(?:using|with\s+check)\b/i).slice(1).join(" ");
    for (const m of cond.matchAll(/\bauth\s*\.\s*(uid|jwt|role|email)\s*\(\s*\)/gi)) {
      const before = cond.slice(0, m.index).replace(/\s+/g, " ").trimEnd().toLowerCase();
      if (!/\(\s?select$/.test(before)) {
        problems.push(`policy "${name}" calls auth.${m[1].toLowerCase()}() once per row. Write (select auth.${m[1].toLowerCase()}()) so it runs once per query.`);
        break;
      }
    }
    for (const m of cond.matchAll(/\b([a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)\s*(?:,[^)]*)?\)/gi)) {
      const fn = m[2].toLowerCase();
      if (["coalesce", "lower", "upper", "exists", "any", "all", "in", "select", "and", "or", "not", "using", "check"].includes(fn)) continue;
      if (m[1] && /^auth\s*\.$/i.test(m[1].trim())) continue;
      problems.push(`policy "${name}" calls ${fn}(${m[3]}) once per row. Check it as  ${m[3]} in (select <schema>.allowed_ids())  with a stable security definer function that returns the allowed ids.`);
      break;
    }
  }

  return problems;
}
