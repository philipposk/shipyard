// Shared-project mode, part 1: the pure rules (no network, no files).
//
// In shared mode an app lives in its own Postgres schema ("folder") inside a Supabase project that other apps
// already use. These helpers decide what that app may do there:
//  - which schema names are allowed,
//  - how an app's migration files are rewritten for that schema (and when they are refused),
//  - how the project's list of schemas exposed to the API (pgrst.db_schemas) is extended without losing an entry,
//  - how SQL text is built: only from names that were validated first.
import { ProvisionError, SLUG_RE } from './common.mjs';

export const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

const RESERVED_EXACT = new Set([
  'public', 'auth', 'storage', 'extensions', 'realtime', 'vault', 'net', 'cron',
  'graphql', 'graphql_public', 'information_schema', 'pgsodium', 'pgsodium_masks', 'pgbouncer', 'pgmq',
  'topology', 'tiger', 'tiger_data',
]);
const RESERVED_PREFIX = ['graphql', 'supabase_', 'pg_'];

export const MARKER_AUTH_TRIGGER = 'auth-trigger';
export const MARKER_PROJECT_WIDE = 'project-wide';
const MARKER_NAMES = [MARKER_AUTH_TRIGGER, MARKER_PROJECT_WIDE];

/** Why a schema name can not be used, or null when it is fine. */
export function schemaNameProblem(name) {
  if (typeof name !== 'string' || !SCHEMA_NAME_RE.test(name)) {
    return `"${name}" is not a usable schema name. Use 3 to 41 lowercase letters, digits and underscores, starting with a letter (for example app_notes).`;
  }
  if (RESERVED_EXACT.has(name) || RESERVED_PREFIX.some((p) => name.startsWith(p))) {
    return `"${name}" is a name Supabase uses itself. Pick another one, for example app_notes.`;
  }
  return null;
}

/** The default schema for an app: app_<slug with dashes turned into underscores>. */
export function defaultSchemaName(slug) {
  return `app_${String(slug).replace(/-/g, '_')}`;
}

/** Throws a plain error unless `name` is an allowed schema name. */
export function assertSchemaName(name) {
  const problem = schemaNameProblem(name);
  if (problem) throw new ProvisionError(problem, { reason: 'bad-schema-name' });
  return name;
}

/** "name" quoted as an SQL identifier. Only for names that passed assertSchemaName. */
export function schemaIdent(name) {
  assertSchemaName(name);
  return `"${name}"`;
}

/** 'text' as an SQL string. Doubles every single quote and refuses control characters. */
export function sqlLiteral(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new ProvisionError('A value with control characters can not be put into SQL.');
  return `'${text.replace(/'/g, "''")}'`;
}

/** A slug as an SQL string; the slug rule (letters, digits, dashes) is checked again here. */
export function slugLiteral(slug) {
  if (!SLUG_RE.test(String(slug))) throw new ProvisionError(`"${slug}" is not a valid app name.`);
  return `'${slug}'`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading SQL: comments out of the way, statements apart.

/**
 * The same text with every comment replaced by spaces (line breaks stay, so line numbers still match).
 * Strings, quoted names and $$ bodies are left alone.
 */
export function blankComments(sql) {
  const s = String(sql);
  const n = s.length;
  let out = '';
  let i = 0;
  const blank = (chunk) => chunk.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '-' && d === '-') {
      let j = i;
      while (j < n && s[j] !== '\n') j++;
      out += blank(s.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      out += blank(s.slice(i, j));
      i = j;
    } else if (c === "'") {
      const escapes = /[eE]/.test(s[i - 1] ?? '') && !/[\w$]/.test(s[i - 2] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && s[j] === '\\') { j += 2; continue; }
        if (s[j] === "'") {
          if (s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        if (end === -1) {
          out += s.slice(i);
          i = n;
        } else {
          // A $$ body is code (a function or DO block): its comments go too.
          out += m[0] + blankComments(s.slice(i + m[0].length, end)) + m[0];
          i = end + m[0].length;
        }
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Top-level statements (split on ; outside quotes and $$ bodies) of comment-free text: [{ text, index }]. */
export function splitStatements(code) {
  const s = String(code);
  const n = s.length;
  const out = [];
  let start = 0;
  let i = 0;
  const push = (end) => {
    const text = s.slice(start, end);
    if (text.trim() !== '') out.push({ text, index: start });
  };
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === c) {
          if (s[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
      } else i++;
    } else if (c === ';') {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(n);
  return out;
}

/** Quote marks become spaces, so a name like "auth"."users" reads as auth . users and positions do not move. */
const plain = (code) => code.replace(/"/g, ' ');

/** The same text with the inside of strings and $$ bodies blanked out (length and line breaks kept). */
function maskLiterals(code) {
  const s = String(code);
  const blank = (chunk) => chunk.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += `'${blank(s.slice(i + 1, j))}'`;
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      const end = m ? s.indexOf(m[0], i + m[0].length) : -1;
      if (m && end !== -1) {
        out += m[0] + blank(s.slice(i + m[0].length, end)) + m[0];
        i = end + m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, Math.max(0, index)).split('\n').length;

// ---------------------------------------------------------------------------------------------------------------
// Marker blocks

const MARKER_LINE = /^\s*--\s*shipyard:([a-z-]+):(start|end)\s*$/;

/**
 * Remove the blocks between `-- shipyard:<name>:start` and `-- shipyard:<name>:end` (name = auth-trigger or
 * project-wide). The lines become blank so line numbers do not move. A marker that is not closed, closed twice or
 * nested is an error: dropping the wrong part of a file silently would be worse than stopping.
 */
export function dropMarkedBlocks(sql, file = 'migration') {
  const lines = String(sql).split('\n');
  const dropped = [];
  let open = null;
  const out = lines.map((line, idx) => {
    const m = MARKER_LINE.exec(line);
    if (m && MARKER_NAMES.includes(m[1])) {
      const [, name, kind] = m;
      if (kind === 'start') {
        if (open) throw new ProvisionError(`${file}, line ${idx + 1}: a "${name}" marker starts inside another marker block. Markers can not be nested.`, { reason: 'bad-marker' });
        open = { name, line: idx + 1 };
        return '';
      }
      if (!open || open.name !== name) {
        throw new ProvisionError(`${file}, line ${idx + 1}: found "shipyard:${name}:end" without a matching start line.`, { reason: 'bad-marker' });
      }
      dropped.push(name);
      open = null;
      return '';
    }
    return open ? '' : line;
  });
  if (open) {
    throw new ProvisionError(`${file}, line ${open.line}: "shipyard:${open.name}:start" is never closed with "shipyard:${open.name}:end".`, { reason: 'bad-marker' });
  }
  return { sql: out.join('\n'), dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// The transform

const IDENT = '[a-z_][a-z0-9_$]*';
const AUTH_FUNCTIONS = /^\s*(?:uid|jwt|role|email)\s*\(/i;

// Statements that would change something shared by every app in the project.
const FORBIDDEN = [
  [/\b(?:create|alter|drop)\s+extension\b/gi, 'installs or changes a database extension (shared by the whole project)'],
  [/\b(?:create|alter|drop)\s+(?:role|user|group)\b/gi, 'creates or changes a database role (shared by the whole project)'],
  [/\b(?:alter\s+(?:database|system)|drop\s+(?:owned|database)|reassign\s+owned)\b/gi, 'changes the whole database'],
  [/\b(?:create|alter|drop)\s+(?:publication|subscription|event\s+trigger|foreign\s+data\s+wrapper|server|tablespace|language)\b/gi, 'changes something shared by the whole project'],
  [/\b(?:create|alter|drop)\s+schema\b/gi, 'creates or changes a schema (Shipyard makes the app\'s schema itself)'],
  [/\bcron\s*\.\s*(?:un)?schedule\w*\s*\(/gi, 'schedules a job in the shared Cron list'],
  [/\bset\s+(?:session\s+|local\s+)?(?:role|session\s+authorization)\b/gi, 'switches to another database role'],
];

function schemaMentions(codeNoQuotes, schema) {
  const found = [];
  const re = new RegExp(`\\bschema\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(${IDENT})`, 'gi');
  for (const m of codeNoQuotes.matchAll(re)) {
    if (m[1].toLowerCase() !== schema) found.push({ index: m.index, why: `refers to the schema "${m[1]}"; an app may only use its own schema` });
  }
  return found;
}

/** Find everything in comment-free SQL that an app in a shared project must not do. Returns [{ index, why }]. */
function findProblems(code, schema) {
  const text = plain(code);
  const found = [];
  const add = (index, why) => found.push({ index, why });

  // 1. The sign-up trigger (and anything else on the shared login table).
  for (const m of text.matchAll(/\b(?:create(?:\s+or\s+replace)?(?:\s+constraint)?|drop|alter)\s+trigger\b[^;]*?\bauth\s*\./gi)) {
    add(m.index, 'adds or removes a trigger on auth.users, which runs for every app in the project');
  }

  // 2. Project-wide statements.
  for (const [re, why] of FORBIDDEN) for (const m of text.matchAll(re)) add(m.index, why);
  for (const m of text.matchAll(/\balter\s+default\s+privileges\b[^;]*/gi)) {
    if (!new RegExp(`\\bin\\s+schema\\s+${schema}\\b`, 'i').test(m[0])) add(m.index, 'changes default privileges outside the app\'s own schema');
  }

  // 3. Other schemas by name.
  found.push(...schemaMentions(text, schema));
  for (const m of text.matchAll(/\bsearch_path\b[^;]*\bpublic\b/gi)) add(m.index, 'puts the public schema in a search path');

  // 4. Qualified targets in other schemas, statement by statement.
  const wrongSchema = (name, rest) => {
    const s = name.toLowerCase();
    if (s === schema) return false;
    if (s === 'auth' && AUTH_FUNCTIONS.test(rest)) return false;
    return true;
  };
  for (const st of splitStatements(text)) {
    const body = maskLiterals(st.text);
    const lead = /^\s*(create|alter|drop|truncate|grant|revoke|comment)\b/i.exec(body);
    if (lead) {
      const ddl = new RegExp(`^\\s*(?:create|alter|drop|truncate)\\s+(?:or\\s+replace\\s+)?(?:(?:unlogged|temp|temporary|materialized|recursive|unique)\\s+)*(?:table|view|function|procedure|sequence|type|domain|index)\\s+(?:concurrently\\s+)?(?:if\\s+(?:not\\s+)?exists\\s+)?(?:only\\s+)?(${IDENT})\\s*\\.`, 'i').exec(body);
      if (ddl && wrongSchema(ddl[1], body.slice(ddl[0].length))) {
        add(st.index + ddl.index, `works on an object in the schema "${ddl[1]}", not in the app's own schema`);
      }
      if (/^\s*(?:(?:create|drop|alter)\s+(?:unique\s+)?(?:policy|index|trigger|constraint\s+trigger|rule)|grant|revoke|comment)\b/i.test(body)) {
        for (const m of body.matchAll(new RegExp(`\\bon\\s+(?:only\\s+|table\\s+|function\\s+|procedure\\s+|sequence\\s+|type\\s+|domain\\s+)?(${IDENT})\\s*\\.`, 'gi'))) {
          if (wrongSchema(m[1], body.slice(m.index + m[0].length))) {
            add(st.index + m.index, `works on an object in the schema "${m[1]}", not in the app's own schema`);
          }
        }
      }
    }
  }
  // Writes into other schemas, anywhere (also inside function bodies).
  for (const m of text.matchAll(new RegExp(`\\b(?:insert\\s+into|delete\\s+from|update(?!\\s+(?:set|on)\\b)(?:\\s+only)?)\\s+(${IDENT})\\s*\\.`, 'gi'))) {
    if (wrongSchema(m[1], text.slice(m.index + m[0].length))) {
      add(m.index, `changes rows in the schema "${m[1]}", not in the app's own schema`);
    }
  }
  return found;
}

/** Statements that name an object without a schema in front of it. Returns [{ index, why }]. Used by transform and by the tests. */
export function findUnqualified(sql) {
  const code = plain(blankComments(String(sql)));
  const found = [];
  const noDot = (str, from) => !/^\s*\./.test(str.slice(from));
  for (const st of splitStatements(code)) {
    const body = maskLiterals(st.text);
    let m = new RegExp(`^\\s*(?:create|alter|drop|truncate)\\s+(?:or\\s+replace\\s+)?(?:(?:unlogged|materialized|recursive|unique)\\s+)*(table|view|function|procedure|sequence|type|domain)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:only\\s+)?(${IDENT})`, 'i').exec(body);
    if (m && noDot(body, m[0].length) && !/^\s*(?:create|alter|drop)\s+(?:temp|temporary)\b/i.test(body)) {
      found.push({ index: st.index, why: `the ${m[1]} "${m[2]}" has no schema in front of its name` });
    }
    m = /^\s*(?:create|alter|drop)\s+(?:unique\s+)?(?:policy|index|trigger|constraint\s+trigger|rule)\b/i.exec(body);
    if (m) {
      for (const t of body.matchAll(new RegExp(`\\bon\\s+(?:only\\s+)?(${IDENT})`, 'gi'))) {
        if (['delete', 'update', 'conflict', 'commit'].includes(t[1].toLowerCase())) continue;
        if (noDot(body, t.index + t[0].length)) found.push({ index: st.index + t.index, why: `"${t[1]}" has no schema in front of its name` });
        break;
      }
    }
    m = /^\s*(grant|revoke)\b/i.exec(body);
    if (m) {
      const on = /\bon\s+(?!all\b|schema\b|database\b|language\b|foreign\b|domain\b|type\b|large\b|tablespace\b)(?:table\s+|function\s+|procedure\s+|sequence\s+)?([\s\S]*?)\s+(?:to|from)\b/i.exec(body);
      if (on) {
        const flat = on[1].replace(/\([^()]*\)/g, '');
        for (const part of flat.split(',')) {
          const name = part.trim();
          if (name && !name.includes('.')) found.push({ index: st.index + on.index, why: `"${name}" has no schema in front of its name` });
        }
      }
    }
    for (const r of body.matchAll(new RegExp(`\\breferences\\s+(${IDENT})`, 'gi'))) {
      if (noDot(body, r.index + r[0].length)) found.push({ index: st.index + r.index, why: `"${r[1]}" has no schema in front of its name` });
    }
  }
  for (const m of code.matchAll(new RegExp(`\\b(?:insert\\s+into|delete\\s+from)\\s+(?:only\\s+)?(${IDENT})`, 'gi'))) {
    if (noDot(code, m.index + m[0].length)) found.push({ index: m.index, why: `"${m[1]}" has no schema in front of its name` });
  }
  for (const m of code.matchAll(new RegExp(`\\bupdate\\s+(?:only\\s+)?(${IDENT})\\s+(?:set|as)\\b`, 'gi'))) {
    if (!/^set$/i.test(m[1])) found.push({ index: m.index, why: `"${m[1]}" has no schema in front of its name` });
  }
  return found;
}


// ---------------------------------------------------------------------------------------------------------------
// The strict layer: an allow-list, not a deny-list.
//
// The checks above name the bad things we thought of. This layer works the other way round: it reads the file as
// words (so strings, quoted names, line breaks and $$ bodies do not hide anything) and refuses everything that is
// not plainly "the app working in its own schema".

const TOKEN_WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const TOKEN_NUMBER = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Comment-free SQL as a list of tokens: { k, v, l, i, end } with k = w (word), q (quoted name), s (string),
 * n (number or $1), p (punctuation; "$$" marks the start and end of a dollar-quoted body, with open true/false).
 * The inside of a $$ body is tokenized like any other code.
 */
export function tokenizeSql(code) {
  const s = String(code);
  const n = s.length;
  const toks = [];
  const closeAt = new Map();
  const push = (k, v, i, end, extra = {}) => toks.push({ k, v, l: typeof v === 'string' ? v.toLowerCase() : v, i, end, ...extra });
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (closeAt.has(i)) {
      const tag = closeAt.get(i);
      push('p', '$$', i, i + tag.length, { open: false });
      i += tag.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { v += '"'; j += 2; continue; }
          break;
        }
        v += s[j++];
      }
      push('q', v, i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const escapes = /[eE]/.test(s[i - 1] ?? '') && !/[\w$]/.test(s[i - 2] ?? '');
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (escapes && s[j] === '\\') { v += s.slice(j, j + 2); j += 2; continue; }
        if (s[j] === "'") {
          if (s[j + 1] === "'") { v += "'"; j += 2; continue; }
          break;
        }
        v += s[j++];
      }
      push('s', v, i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        if (end !== -1) {
          closeAt.set(end, m[0]);
          push('p', '$$', i, i + m[0].length, { open: true });
          i += m[0].length;
          continue;
        }
      }
      const param = /^\$\d+/.exec(s.slice(i, i + 12));
      if (param) { push('n', param[0], i, i + param[0].length); i += param[0].length; continue; }
      push('p', c, i, i + 1);
      i++;
      continue;
    }
    if (c === ':' && s[i + 1] === ':') { push('p', '::', i, i + 2); i += 2; continue; }
    TOKEN_WORD.lastIndex = i;
    let m = TOKEN_WORD.exec(s);
    if (m) { push('w', m[0], i, i + m[0].length); i += m[0].length; continue; }
    TOKEN_NUMBER.lastIndex = i;
    m = TOKEN_NUMBER.exec(s);
    if (m) { push('n', m[0], i, i + m[0].length); i += m[0].length; continue; }
    push('p', c, i, i + 1);
    i++;
  }
  return toks;
}

const isName = (t) => t && (t.k === 'w' || t.k === 'q');
const isP = (t, v) => t && t.k === 'p' && t.v === v;
const isW = (t, ...words) => t && t.k === 'w' && words.includes(t.l);
/** A name as written: bare words are case-insensitive, quoted names are exact. */
const nameOf = (t) => (t.k === 'w' ? t.l : t.v);

/** Top-level statements as token ranges: [{ from, to (exclusive), index, lead: [first words] }]. */
function statementRanges(toks) {
  const out = [];
  let from = 0;
  let depth = 0;
  const flush = (to) => {
    if (to > from) out.push({ from, to, index: toks[from].i, lead: toks.slice(from, Math.min(to, from + 6)).map((t) => (t.k === 'w' ? t.l : `<${t.k}>`)) });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.k === 'p' && t.v === '$$') depth += t.open ? 1 : -1;
    else if (depth === 0 && isP(t, ';')) { flush(k); from = k + 1; }
  }
  flush(toks.length);
  return out;
}

const OBJECTS_CREATE = new Set(['table', 'index', 'policy', 'function', 'trigger', 'view', 'type', 'sequence', 'domain']);
const OBJECTS_ALTER = new Set(['table', 'policy', 'function', 'index', 'sequence', 'view', 'type', 'domain']);
const OBJECTS_DROP = new Set(['policy', 'trigger', 'function', 'index', 'view', 'table', 'type', 'sequence', 'domain']);
const CREATE_MODIFIERS = new Set(['unique', 'unlogged', 'temp', 'temporary', 'global', 'local', 'recursive']);
const TRANSACTION_WORDS = new Set(['begin', 'commit', 'rollback', 'end', 'start', 'savepoint', 'release', 'abort']);

/** Is the statement one of the kinds an app in a shared project may run? lead = its first words. */
function allowedLead(lead) {
  const [a, b, c] = lead;
  if (a === 'create') {
    let k = 1;
    if (lead[k] === 'or' && lead[k + 1] === 'replace') k += 2;
    while (CREATE_MODIFIERS.has(lead[k])) k++;
    return OBJECTS_CREATE.has(lead[k]);
  }
  if (a === 'alter') return OBJECTS_ALTER.has(b) || (b === 'default' && c === 'privileges');
  if (a === 'drop') return OBJECTS_DROP.has(b);
  if (a === 'grant' || a === 'revoke') return true;
  if (a === 'comment') return b === 'on';
  if (a === 'insert') return b === 'into';
  if (a === 'update') return true;
  if (a === 'delete') return b === 'from';
  return false;
}

const SINGLE_BANNED = new Set([
  'truncate', 'pg_terminate_backend', 'pg_cancel_backend', 'set_config', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal',
  'pg_create_restore_point', 'pg_promote', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export',
  // The server's own lists of logins, running queries and settings.
  'pg_authid', 'pg_shadow', 'pg_stat_activity', 'pg_stat_replication', 'pg_hba_file_rules', 'pg_file_settings', 'pg_user_mappings',
]);
const BANNED_PATTERNS = [/^dblink/, /^http_/, /_to_xml(?:schema)?$/, /_and_xmlschema$/, /^pg_sleep/, /^pg_advisory_(?:xact_)?lock/, /replication_slot/, /^pg_logical/];
const CREATE_BANNED_NEXT = new Set(['cast', 'aggregate', 'operator', 'rule', 'collation', 'conversion', 'transform', 'access', 'text', 'statistics', 'foreign', 'materialized', 'event']);

// Words that, right before a qualified name, make it a name of a table, function or type (so the schema in front is real).
// Words that make it an expression (so the part in front is a table alias or a row variable, never a schema).
const EXPRESSION_PREV = new Set(['select', 'distinct', 'where', 'and', 'or', 'not', 'then', 'else', 'when', 'case', 'by', 'having', 'returning', 'is', 'between', 'ilike', 'any', 'all', 'some', 'limit', 'offset', 'return', 'if', 'elsif', 'while', 'begin', 'loop', 'declare']);
const NAME_CLAUSE = new Set(['from', 'join', 'table', 'into', 'update', 'only', 'truncate', 'lateral', 'using', 'inherits', 'function', 'procedure', 'view', 'type', 'sequence', 'index', 'domain', 'trigger', 'schema', 'references']);
const EXPRESSION_CLAUSE = new Set(['select', 'where', 'group', 'order', 'having', 'set', 'returning', 'values', 'when', 'then', 'else', 'limit', 'offset', 'by', 'case']);
const NAME_LEADS = ['grant', 'revoke', 'comment', 'drop', 'truncate'];
const FROM_IN_CALL = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);
const NOT_AN_ALIAS = new Set([
  'on', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'using', 'set', 'group', 'order', 'limit', 'offset', 'union', 'intersect',
  'except', 'for', 'returning', 'values', 'select', 'as', 'from', 'to', 'is', 'and', 'or', 'not', 'in', 'like', 'between', 'enable', 'disable', 'add',
  'drop', 'alter', 'rename', 'cascade', 'restrict', 'default', 'with', 'check', 'references', 'primary', 'unique', 'null', 'collate', 'owner', 'then',
  'else', 'when', 'end', 'asc', 'desc', 'nulls', 'having', 'window', 'fetch', 'lateral', 'only', 'force', 'no', 'inherit', 'validate', 'if', 'exists',
]);

// A string that is just a table, function or sequence name, as in nextval('other.seq') or '"other".t'::regclass.
const NAME_PART = '(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))';
const STRING_NAME = new RegExp(`^\\s*${NAME_PART}\\s*\\.\\s*${NAME_PART}(?:\\([^)]*\\))?(?:\\s*\\.\\s*${NAME_PART})?\\s*$`, 'i');

/**
 * Everything in comment-free SQL that is not plainly "the app working in its own schema". Returns [{ index, why }].
 * See the long comment above for the idea; the individual rules are in the code.
 */
export function findStrictProblems(code, schema) {
  const toks = tokenizeSql(code);
  return analyzeTokens(toks, schema, { nested: false });
}

function analyzeTokens(toks, schema, { nested }) {
  const found = [];
  const add = (index, why) => found.push({ index, why });
  const statements = nested ? [{ from: 0, to: toks.length, index: toks[0]?.i ?? 0, lead: ['select'] }] : statementRanges(toks);
  const stmtOfTok = new Array(toks.length).fill(0);
  statements.forEach((st, n) => { for (let k = st.from; k < st.to; k++) stmtOfTok[k] = n; });
  const leadOfTok = (k) => statements[stmtOfTok[k]]?.lead ?? [];
  const ownSchema = (v) => v === schema || v === 'extensions' || v === 'pg_catalog';

  // ---- 1. Which kinds of statements -----------------------------------------------------------------------
  if (!nested) {
    for (const st of statements) {
      const [a] = st.lead;
      if (TRANSACTION_WORDS.has(a)) {
        add(st.index, 'starts or ends a transaction; Shipyard runs each file as one all-or-nothing step, so a file may not do that itself');
      } else if (!allowedLead(st.lead)) {
        const shown = ['create', 'alter', 'drop', 'security', 'lock', 'vacuum', 'refresh'].includes(a) ? st.lead.slice(0, 2) : st.lead.slice(0, 1);
        add(st.index, `is "${shown.filter((w) => !w.startsWith('<')).join(' ') || 'something else'}", a kind of statement an app in a shared project may not run (it may create, change and drop its own tables, indexes, policies, functions, triggers, views, types and sequences, grant and revoke on them, add comments, and change rows in its own schema)`);
      }
    }
  }

  // ---- 2. Names that stand for something ------------------------------------------------------------------
  // Table aliases and row variables: only these may stand in front of a dot in an expression.
  const aliases = new Set(['new', 'old', 'excluded']);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (isW(t, 'as') && isName(toks[k + 1]) && !isP(toks[k + 2], '.') && !isP(toks[k + 2], '$$')) aliases.add(nameOf(toks[k + 1]));
    if (isName(t) && isP(toks[k + 1], '.') && isName(toks[k + 2]) && !isP(toks[k - 1], '.')) {
      if (ownSchema(nameOf(t)) || nameOf(t) === 'auth') aliases.add(nameOf(toks[k + 2]));
      const after = toks[k + 3];
      if (after && after.k === 'w' && !NOT_AN_ALIAS.has(after.l)) aliases.add(after.l);
    }
    if (isW(t, 'from', 'join', 'update', 'into', 'only', 'lateral') && isName(toks[k + 1]) && !isP(toks[k + 2], '.') && !isP(toks[k + 2], '(')) {
      aliases.add(nameOf(toks[k + 1]));
      const after = toks[k + 2];
      if (after && after.k === 'w' && !NOT_AN_ALIAS.has(after.l)) aliases.add(after.l);
    }
    if (isP(t, ')') && toks[k + 1]?.k === 'w' && !NOT_AN_ALIAS.has(toks[k + 1].l) && !isP(toks[k + 2], '.')) aliases.add(toks[k + 1].l);
    if (isW(t, 'for', 'foreach') && isName(toks[k + 1]) && isW(toks[k + 2], 'in')) aliases.add(nameOf(toks[k + 1]));
    if (isName(t) && isW(toks[k + 1], 'record')) aliases.add(nameOf(t));
    if (isName(t) && toks[k + 1]?.k === 'p' && toks[k + 1].v === '%' && isW(toks[k + 2], 'rowtype', 'type')) aliases.add(nameOf(t));
  }

  const firstOn = new Map();
  statements.forEach((st, n) => {
    for (let k = st.from; k < st.to; k++) if (isW(toks[k], 'on')) { firstOn.set(n, k); break; }
  });
  const isNameLead = (k) => {
    const lead = leadOfTok(k);
    const a = lead[0];
    if (NAME_LEADS.includes(a)) return true;
    return false;
  };
  const isOnLead = (k) => {
    const lead = leadOfTok(k).filter((w) => !['or', 'replace', 'unique', 'concurrently'].includes(w));
    const [a, b] = lead;
    return ['grant', 'revoke', 'comment'].includes(a) || (['create', 'alter', 'drop'].includes(a) && ['policy', 'index', 'trigger', 'rule'].includes(b));
  };
  const isDdlOn = (k) => isW(toks[k], 'on') && isOnLead(k) && firstOn.get(stmtOfTok[k]) === k;

  /** After a comma: is the list a list of object names (from a, b ... / grant ... on a, b)? */
  const commaListIsNames = (commaAt) => {
    let depth = 0;
    for (let k = commaAt - 1; k >= 0; k--) {
      const x = toks[k];
      if (x.k === 'p') {
        if (x.v === ')') depth++;
        else if (x.v === '(') { if (depth === 0) return false; depth--; } else if ((x.v === ';' || x.v === '$$') && depth === 0) break;
      } else if (x.k === 'w' && depth === 0) {
        if (x.l === 'on') return isOnLead(k) || isNameLead(k);
        if (NAME_CLAUSE.has(x.l)) return true;
        if (EXPRESSION_CLAUSE.has(x.l)) return false;
      }
    }
    return isNameLead(commaAt);
  };

  /** Does the name starting at token k stand where an object name is expected (a table, function, type ...)? */
  const standsForName = (k) => {
    const prev = toks[k - 1];
    if (!prev) return true;
    if (prev.k === 'p') {
      if (prev.v === ',') return commaListIsNames(k - 1);
      if (prev.v === '(') return false;
      if (prev.v === '::') return true;
      if (prev.v === ';' || prev.v === '$$') return false; // the start of a statement in a function body: `new.x := ...`
      return !/^[=<>+\-*/%|&!~^?@#]$/.test(prev.v);
    }
    if (prev.k !== 'w') return true;
    const p = prev.l;
    if (p === 'from') {
      if (isW(toks[k - 2], 'distinct')) return false;
      let depth = 0;
      for (let j = k - 2; j >= 0; j--) {
        const x = toks[j];
        if (isP(x, ')')) depth++;
        else if (isP(x, '(')) {
          if (depth === 0) return !(toks[j - 1]?.k === 'w' && FROM_IN_CALL.has(toks[j - 1].l));
          depth--;
        } else if (isP(x, ';')) break;
      }
      return true;
    }
    if (p === 'on') return isDdlOn(k - 1);
    if (p === 'like') return leadOfTok(k).includes('table');
    return !EXPRESSION_PREV.has(p);
  };

  // ---- 3. Every name with a dot in it ---------------------------------------------------------------------
  const authUsersUses = [];
  for (let k = 0; k + 2 < toks.length; k++) {
    if (!isName(toks[k]) || !isP(toks[k + 1], '.') || !isName(toks[k + 2]) || isP(toks[k - 1], '.')) continue;
    const q = nameOf(toks[k]);
    const nm = nameOf(toks[k + 2]);
    const isCall = isP(toks[k + 3], '(');
    const at = toks[k].i;
    if (ownSchema(q)) continue;
    if (q === 'auth') {
      if (['uid', 'jwt', 'role', 'email'].includes(nm) && isCall) continue;
      if (nm === 'users') {
        if (isW(toks[k - 1], 'references')) continue;
        authUsersUses.push({ k, at });
        continue;
      }
      add(at, `uses auth.${nm}; an app may only use auth.uid(), auth.jwt(), auth.role(), auth.email() and point a foreign key at auth.users`);
      continue;
    }
    if (!isCall && !standsForName(k) && aliases.has(q)) continue;
    add(at, `uses "${q}.${nm}", which is outside the app's own schema`);
  }

  // auth.users (the shared login table) may be read only by a function that nobody but the server can call.
  if (authUsersUses.length > 0) {
    const grantsAndRevokes = nested ? [] : statements.filter((st) => st.lead[0] === 'revoke' || st.lead[0] === 'grant');
    for (const use of authUsersUses) {
      const st = statements[stmtOfTok[use.k]];
      const isFn = !nested && st.lead[0] === 'create' && st.lead.slice(0, 4).includes('function');
      if (!isFn) {
        add(use.at, 'reads auth.users (every app\'s sign-ups) outside a function that only the server can call');
        continue;
      }
      let fk = st.from;
      while (fk < st.to && !isW(toks[fk], 'function')) fk++;
      const fn = isName(toks[fk + 1]) && isP(toks[fk + 2], '.') && isName(toks[fk + 3]) ? `${nameOf(toks[fk + 1])}.${nameOf(toks[fk + 3])}` : null;
      const roleSet = (g, word) => {
        const roles = new Set();
        let r = g.from;
        while (r < g.to && !isW(toks[r], word)) r++;
        for (r++; r < g.to; r++) if (isName(toks[r])) roles.add(nameOf(toks[r]));
        return roles;
      };
      const targets = (g) => {
        const text = toks.slice(g.from, g.to);
        const all = text.some((t, i) => isW(t, 'all') && isW(text[i + 1], 'functions'));
        let name = null;
        const f = text.findIndex((t) => isW(t, 'function'));
        if (f !== -1 && isName(text[f + 1]) && isP(text[f + 2], '.') && isName(text[f + 3])) name = `${nameOf(text[f + 1])}.${nameOf(text[f + 3])}`;
        return { all, name };
      };
      const covers = (g) => { const t = targets(g); return t.all || (fn && t.name === fn); };
      const revoked = grantsAndRevokes.some((g) => {
        if (g.lead[0] !== 'revoke' || !covers(g)) return false;
        const roles = roleSet(g, 'from');
        return roles.has('public') && roles.has('anon') && roles.has('authenticated');
      });
      const reopened = grantsAndRevokes.some((g) => {
        if (g.lead[0] !== 'grant' || !covers(g)) return false;
        const roles = roleSet(g, 'to');
        return roles.has('public') || roles.has('anon') || roles.has('authenticated');
      });
      if (!revoked || reopened) {
        add(use.at, `this function reads auth.users, so the same file must "revoke execute on function ${fn ?? '...'} from public, anon, authenticated" and not grant it back to them`);
      }
    }
  }

  // ---- 4. Strings that name a table or sequence, and function bodies written as strings -------------------
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.k !== 's') continue;
    if (!nested && statements[stmtOfTok[k]]?.lead[0] === 'comment') continue;
    const m = STRING_NAME.exec(t.v);
    if (m) {
      const q = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].toLowerCase();
      const nm = m[3] !== undefined ? m[3].replace(/""/g, '"') : m[4];
      if (!ownSchema(q)) add(t.i, `names "${q}.${nm}", which is outside the app's own schema`);
    }
    const lead = leadOfTok(k);
    if (!nested && lead[0] === 'create' && (lead.includes('function') || lead.includes('procedure')) && isW(toks[k - 1], 'as')) {
      for (const p of analyzeTokens(tokenizeSql(t.v), schema, { nested: true })) add(t.i, p.why);
    }
  }

  // ---- 5. Words that are never needed ---------------------------------------------------------------------
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.k !== 'w') continue;
    const next = toks[k + 1];
    if (SINGLE_BANNED.has(t.l) || BANNED_PATTERNS.some((re) => re.test(t.l))) {
      add(t.i, `uses ${t.l}, which can destroy data, run other SQL or disturb the other apps in the project`);
    } else if (t.l === 'merge' && isW(next, 'into')) add(t.i, 'uses MERGE, which is not allowed in a shared project');
    else if (t.l === 'security' && isW(next, 'label')) add(t.i, 'sets a security label (shared by the whole project)');
    else if (t.l === 'lock' && isW(next, 'table')) add(t.i, 'locks a table, which can freeze the other apps');
    else if (t.l === 'create' && next?.k === 'w' && CREATE_BANNED_NEXT.has(next.l)) add(t.i, `creates a ${next.l}, which changes behaviour project-wide`);
    else if (t.l === 'execute' && !(isW(next, 'function', 'procedure', 'on') || isP(next, ','))) {
      add(t.i, 'runs SQL that is built while it runs (EXECUTE); the file can not be checked, so it is not allowed in a shared project');
    } else if (t.l === 'language' && next && !(['sql', 'plpgsql'].includes(next.k === 's' || next.k === 'q' ? next.v.toLowerCase() : next.l))) {
      add(t.i, 'uses a function language other than sql or plpgsql');
    } else if (t.l === 'search_path') {
      const sep = toks[k + 1];
      if (isP(sep, '=') || isW(sep, 'to')) {
        for (let j = k + 2; j < toks.length; j++) {
          const x = toks[j];
          const value = x.k === 's' || x.k === 'q' ? x.v : x.k === 'w' ? x.l : null;
          if (value === null) break;
          if (!(value === '' || ownSchema(value))) add(x.i, `puts "${value}" in a search path; only the app's own schema and extensions are allowed`);
          if (isP(toks[j + 1], ',')) j++;
          else break;
        }
      }
    }
  }

  // ---- 6. Statement by statement -------------------------------------------------------------------------
  if (!nested) {
    for (const st of statements) {
      const body = toks.slice(st.from, st.to);
      const [a, b] = st.lead;
      if (a === 'grant' || a === 'revoke') {
        const onAt = body.findIndex((t) => isW(t, 'on'));
        const closes = onAt !== -1 && body.slice(onAt + 1).some((t) => isW(t, 'to', 'from'));
        if (!closes) add(st.index, 'grants or removes a database role (roles are shared by the whole project)');
      }
      if (a === 'create' && st.lead.slice(0, 5).includes('view') && !st.lead.slice(0, 5).includes('materialized')) {
        const si = body.findIndex((t) => isW(t, 'security_invoker'));
        const ok = si !== -1 && isP(body[si + 1], '=') && ['true', 'on', '1'].includes(String(body[si + 2]?.v ?? '').toLowerCase());
        if (!ok) add(st.index, 'creates a view without "with (security_invoker = true)"; a view runs with the rights of its owner and would skip the privacy rules (RLS)');
      }
      if (a === 'alter' && b === 'view') {
        const si = body.findIndex((t) => isW(t, 'security_invoker'));
        if (si !== -1 && !(isP(body[si + 1], '=') && ['true', 'on', '1'].includes(String(body[si + 2]?.v ?? '').toLowerCase()))) add(st.index, 'turns off security_invoker on a view');
      }
      if (a === 'alter' && body.some((t, i) => isW(t, 'set') && isW(body[i + 1], 'schema'))) add(st.index, 'moves an object to another schema');
      if (a === 'alter' && body.some((t, i) => isW(t, 'owner') && isW(body[i + 1], 'to'))) add(st.index, 'changes who owns an object');
      // A foreign key to the shared login table must clean up after itself, or deleting that person anywhere would fail.
      for (let k = st.from; k < st.to; k++) {
        if (!(isW(toks[k], 'references') && isName(toks[k + 1]) && nameOf(toks[k + 1]) === 'auth' && isP(toks[k + 2], '.') && isName(toks[k + 3]) && nameOf(toks[k + 3]) === 'users')) continue;
        let j = k + 4;
        if (isP(toks[j], '(')) { let d = 0; for (; j < st.to; j++) { if (isP(toks[j], '(')) d++; else if (isP(toks[j], ')') && --d === 0) { j++; break; } } }
        let depth = 0;
        let ok = false;
        for (; j < st.to; j++) {
          const x = toks[j];
          if (isP(x, '(')) depth++;
          else if (isP(x, ')')) { if (depth === 0) break; depth--; } else if (isP(x, ',') && depth === 0) break;
          else if (isW(x, 'on') && isW(toks[j + 1], 'delete') && (isW(toks[j + 2], 'cascade') || (isW(toks[j + 2], 'set') && isW(toks[j + 3], 'null')))) ok = true;
        }
        if (!ok) add(toks[k].i, 'points a foreign key at auth.users without "on delete cascade" or "on delete set null", which would block deleting that person in every app');
      }
    }
  }
  return found;
}

/** `public.` (the table folder) becomes `<schema>.`; the role word in "from public" is left alone. */
export function rewritePublic(sql, schema) {
  return String(sql)
    .replace(/(?<![\w$.])public(\s*)\./gi, `${schema}$1.`)
    .replace(/(?<![\w$.])"public"(\s*)\./gi, `"${schema}"$1.`);
}

const shortLine = (line) => line.trim().replace(/\s+/g, ' ').slice(0, 140);

/**
 * Rewrite one migration file for a schema:
 *  - the blocks marked auth-trigger and project-wide are dropped,
 *  - `public.` becomes `<schema>.` (never the role keyword in "revoke ... from public"),
 *  - then the result is checked, and the whole file is refused (nothing runs) if it still touches anything shared.
 * Returns { sql, dropped: [marker names] }. Throws ProvisionError listing the offending lines.
 */
export function transformMigration(sql, { schema, file = 'migration' }) {
  assertSchemaName(schema);
  const original = String(sql).replace(/\r\n?/g, '\n');
  const origLines = original.split('\n');
  const { sql: kept, dropped } = dropMarkedBlocks(original, file);
  const rewritten = rewritePublic(kept, schema);

  const code = blankComments(rewritten);
  const problems = [];
  const text = plain(code);
  for (const m of text.matchAll(/(?<![\w$.])public\s*\./gi)) problems.push({ index: m.index, why: 'still mentions public. after the rewrite' });
  problems.push(...findProblems(code, schema));
  problems.push(...findUnqualified(code));
  problems.push(...findStrictProblems(code, schema));

  if (problems.length > 0) {
    const seen = new Set();
    const lines = [];
    for (const p of problems.sort((a, b) => a.index - b.index)) {
      const n = lineOf(code, p.index);
      const key = `${n}:${p.why}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${file}, line ${n}: ${p.why}\n      ${shortLine(origLines[n - 1] ?? '')}`);
    }
    throw new ProvisionError(
      `This app can not be put in a shared Supabase project: its database files touch things the other apps share.\n${lines.slice(0, 12).join('\n')}${lines.length > 12 ? `\n  ... and ${lines.length - 12} more` : ''}\n`
      + 'Nothing was changed. Fix the lines above (use only the app\'s own tables, no triggers on auth.users, and put public. in front of every table and function name), then run this again.',
      { reason: 'unsafe-migration', file, lines: lines.length },
    );
  }
  return { sql: rewritten, dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// pgrst.db_schemas (the list of schemas the project's API exposes)

/** rolconfig as a list of "name=value" strings (the API sends an array; a Postgres array literal is also understood). */
export function rolconfigList(rolconfig) {
  if (Array.isArray(rolconfig)) return rolconfig.map(String);
  if (typeof rolconfig === 'string' && rolconfig.startsWith('{') && rolconfig.endsWith('}')) {
    const items = [];
    const inner = rolconfig.slice(1, -1);
    const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
    for (const m of inner.matchAll(re)) items.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
    return items;
  }
  return [];
}

const DB_SCHEMAS_KEY = 'pgrst.db_schemas';

/** { present, raw } for pgrst.db_schemas inside an authenticator rolconfig. raw is null when the setting does not exist. */
export function readDbSchemasSetting(rolconfig) {
  const entry = rolconfigList(rolconfig).find((e) => e.startsWith(`${DB_SCHEMAS_KEY}=`));
  if (entry === undefined) return { present: false, raw: null };
  return { present: true, raw: entry.slice(DB_SCHEMAS_KEY.length + 1) };
}

/** The entries of a comma list ("public, storage, graphql_public"), trimmed, empty ones dropped. */
export const splitSchemaList = (raw) => String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const SAFE_ENTRY = /^[A-Za-z0-9_$.-]+$/;

/**
 * Add `schema` at the end of the list, keeping every existing entry in its place. Nothing is removed or reordered.
 * Returns { list, merged, changed, added }. `raw` null or empty gives just the new schema (the caller must not
 * use that when the real list is unknown: see readDbSchemasSetting).
 */
export function mergeDbSchemas(raw, schema) {
  assertSchemaName(schema);
  const list = splitSchemaList(raw);
  const odd = list.filter((e) => !SAFE_ENTRY.test(e));
  if (odd.length > 0) {
    throw new ProvisionError(
      `The project's list of exposed schemas has an entry Shipyard does not understand (${odd.map((e) => JSON.stringify(e)).join(', ')}). Nothing was changed. Add the app's schema by hand in the Supabase dashboard (Settings > API > Exposed schemas) instead.`,
      { reason: 'odd-db-schemas' },
    );
  }
  if (list.includes(schema)) return { list, merged: String(raw).trim(), changed: false, added: false };
  const base = String(raw ?? '').trim().replace(/[\s,]+$/, '');
  const separator = base.includes(', ') ? ', ' : ',';
  return { list: [...list, schema], merged: base === '' ? schema : `${base}${separator}${schema}`, changed: true, added: true };
}

export const DB_SCHEMAS_CHANGED_MESSAGE = 'shipyard: the exposed schema list changed meanwhile, nothing written';

/**
 * The statement that saves the merged list and asks the API to reload. It writes only if the list is still exactly
 * what Shipyard read before (`expectedRaw`, null = the setting did not exist), in the same statement, so a schema
 * another tool added in the meantime can not be lost.
 */
export function setDbSchemasSql(merged, expectedRaw = null) {
  const expected = expectedRaw === null || expectedRaw === undefined ? 'null' : sqlLiteral(expectedRaw);
  const text = `${merged}${expectedRaw ?? ''}`;
  if (text.includes('$shipyard$')) throw new ProvisionError('The schema list holds a character sequence Shipyard can not put into SQL safely. Nothing was changed.', { reason: 'odd-db-schemas' });
  return [
    'do $shipyard$',
    'declare cur text;',
    'begin',
    // 18 = length('pgrst.db_schemas=') + 1
    `  select substr(c, 18) into cur from pg_roles r, unnest(r.rolconfig) c where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%';`,
    `  if cur is distinct from ${expected} then`,
    `    raise exception '${DB_SCHEMAS_CHANGED_MESSAGE}';`,
    '  end if;',
    `  alter role authenticator set pgrst.db_schemas = ${sqlLiteral(merged)};`,
    'end',
    '$shipyard$;',
    "notify pgrst, 'reload config';",
    "notify pgrst, 'reload schema';",
  ].join('\n');
}

/** The statement that puts back an old value (null = the setting did not exist). */
export function restoreDbSchemasSql(oldRaw) {
  const set = oldRaw === null || oldRaw === undefined
    ? 'ALTER ROLE authenticator RESET pgrst.db_schemas;'
    : `ALTER ROLE authenticator SET pgrst.db_schemas = ${sqlLiteral(oldRaw)};`;
  return `${set}\nNOTIFY pgrst, 'reload config';\nNOTIFY pgrst, 'reload schema';`;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL the shared flow sends. Every name goes through schemaIdent / slugLiteral / sqlLiteral.

/** Create the schema, let the API roles see into it, and create the two bookkeeping tables. */
export function createSchemaSql(schema, slug) {
  const s = schemaIdent(schema);
  return [
    `create schema if not exists ${s};`,
    `grant usage on schema ${s} to anon, authenticated, service_role;`,
    // New tables, sequences and functions in this schema are usable by the server key. Nobody else gets anything by default.
    `alter default privileges in schema ${s} grant all on tables to service_role;`,
    `alter default privileges in schema ${s} grant all on sequences to service_role;`,
    `alter default privileges in schema ${s} grant all on functions to service_role;`,
    // Postgres lets everybody (PUBLIC, so also the anonymous visitor) run every new function. Take that away here;
    // revokePublicFunctionsSql does the same for the functions that already exist, once the files have run.
    `alter default privileges in schema ${s} revoke execute on functions from public;`,
    `create table if not exists ${s}._shipyard_app (slug text primary key, created_at timestamptz not null default now());`,
    `alter table ${s}._shipyard_app enable row level security;`,
    `revoke all on ${s}._shipyard_app from anon, authenticated;`,
    `create table if not exists ${s}._shipyard_migrations (name text primary key, applied_at timestamptz not null default now());`,
    `alter table ${s}._shipyard_migrations enable row level security;`,
    `revoke all on ${s}._shipyard_migrations from anon, authenticated;`,
    `insert into ${s}._shipyard_app (slug) values (${slugLiteral(slug)}) on conflict (slug) do nothing;`,
  ].join('\n');
}

/**
 * Functions are runnable by everybody by default in Postgres, and a "security definer" function runs with the
 * database owner's rights. After the app's files ran, nobody but the roles the files granted explicitly may run them.
 */
export const revokePublicFunctionsSql = (schema) => `revoke execute on all functions in schema ${schemaIdent(schema)} from public;`;

/** One migration, run as a single step: the file, then the note that it ran. Unnamed objects land in the app's schema. */
export function migrationSql(schema, file, transformedSql) {
  const s = schemaIdent(schema);
  return `set local search_path to ${s}, extensions;\n${transformedSql}\n;\ninsert into ${s}._shipyard_migrations (name) values (${sqlLiteral(file)}) on conflict do nothing;\n`;
}

export const schemaExistsSql = (schema) => `select 1 as found from pg_namespace where nspname = ${sqlLiteral(assertSchemaName(schema))};`;
export const appTableExistsSql = (schema) => `select to_regclass(${sqlLiteral(`${schemaIdent(schema)}._shipyard_app`)}) is not null as found;`;
export const readAppSlugsSql = (schema) => `select slug from ${schemaIdent(schema)}._shipyard_app;`;
export const migrationsTableExistsSql = (schema) => `select to_regclass(${sqlLiteral(`${schemaIdent(schema)}._shipyard_migrations`)}) is not null as found;`;
export const readAppliedSql = (schema) => `select name from ${schemaIdent(schema)}._shipyard_migrations;`;
export const dropSchemaSql = (schema) => `DROP SCHEMA ${schemaIdent(schema)} CASCADE;`;
