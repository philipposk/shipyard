// Small, careful text edits that add-module.mjs makes to files in the student's app (imports, list entries,
// a line next to an anchor). Every function takes text and returns text; nothing here touches the disk.
// An edit that was already made is never made twice, and an edit that can not be placed returns { ok: false }
// so the caller can tell the student exactly what to add by hand.

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (text) => text.split(/\r?\n/);
const indentOf = (line) => /^[\t ]*/.exec(line)[0];

/** Lines that already hold this exact text (ignoring leading and trailing spaces). */
const hasLine = (lines, wanted) => lines.some((l) => l.trim() === wanted.trim());

/** Index of the last line that ends a top-level `import` statement, or -1. */
function lastImportEnd(lines) {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\b/.test(lines[i])) continue;
    let j = i;
    // A multi-line import ends at the line holding `from "..."` (or is a bare `import "x"`).
    while (j < lines.length && !/(?:\bfrom\s+["'][^"']+["']|^import\s+["'][^"']+["'])\s*;?\s*(?:\/\/.*)?$/.test(lines[j])) j++;
    if (j >= lines.length) break;
    last = j;
    i = j;
  }
  return last;
}

/** Add import lines after the last import (or after a "use client" line). Lines already in the file are skipped. */
export function addImports(text, importLines) {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const added = [];
  const fresh = importLines.filter((l) => !hasLine(lines, l));
  if (fresh.length === 0) return { text, added };
  let at = lastImportEnd(lines);
  if (at === -1) {
    at = -1;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (/^\s*["']use (?:client|server)["'];?\s*$/.test(lines[i])) at = i;
    }
  }
  lines.splice(at + 1, 0, ...fresh);
  added.push(...fresh);
  return { text: lines.join(eol), added };
}

/**
 * Put `insert` (one or more lines) before or after the first (or last) line that contains `anchor`.
 * The new lines get the same indentation as that line.
 */
export function insertAtAnchor(text, { anchor, position = 'before', insert, occurrence = 'first' }) {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const hits = [];
  lines.forEach((l, i) => {
    if (l.includes(anchor)) hits.push(i);
  });
  if (hits.length === 0) return { ok: false, text };
  const at = occurrence === 'last' ? hits[hits.length - 1] : hits[0];
  const indent = indentOf(lines[at]);
  const block = String(insert).split('\n').map((l) => (l === '' ? l : indent + l));
  lines.splice(position === 'after' ? at + 1 : at, 0, ...block);
  return { ok: true, text: lines.join(eol) };
}

// ---------------------------------------------------------------------------------------------
// Finding a list `export const NAME = [ ... ]`

/** Index just past a string, template literal or comment that starts at i, or i when none starts there. */
function skipLiteral(text, i) {
  const c = text[i];
  const d = text[i + 1];
  if (c === '/' && d === '/') {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (c === '/' && d === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** Index of the `]` that closes the `[` at `open`, or -1. */
function matchBracket(text, open) {
  const stack = [];
  for (let i = open; i < text.length; ) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '[' || c === '{' || c === '(') stack.push(c);
    else if (c === ']' || c === '}' || c === ')') {
      stack.pop();
      if (stack.length === 0) return c === ']' ? i : -1;
    }
    i++;
  }
  return -1;
}

/** Where the `[` of `export const NAME ... = [` is (NAME optional: the first exported list). */
function findArrayOpen(text, name) {
  const decl = name
    ? new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`, 'g')
    : /\bexport\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\b/g;
  let m;
  while ((m = decl.exec(text))) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < text.length; ) {
      const skipped = skipLiteral(text, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      const c = text[i];
      if (c === '<' || c === '(' || c === '{') depth++;
      else if ((c === '>' && text[i - 1] !== '=') || c === ')' || c === '}') depth--;
      else if (c === ';' && depth <= 0) break;
      else if (c === '=' && depth <= 0 && text[i + 1] !== '=' && text[i + 1] !== '>' && !'=!<>'.includes(text[i - 1])) {
        let j = i + 1;
        while (/\s/.test(text[j] ?? '')) j++;
        if (text[j] === '[') return j;
        break;
      }
      i++;
    }
  }
  return -1;
}

/**
 * Add one entry (as source text) at the end of `export const NAME = [ ... ]`.
 * `literal` (default: the entry itself) is looked for inside the list first: if it is there, nothing is added.
 */
export function addToArray(text, { name = null, entry, literal = entry }) {
  const open = findArrayOpen(text, name);
  if (open === -1) return { ok: false, text, reason: 'list-not-found' };
  const close = matchBracket(text, open);
  if (close === -1) return { ok: false, text, reason: 'list-not-found' };
  const inner = text.slice(open + 1, close);
  if (inner.includes(literal)) return { ok: true, text, already: true };

  const eol = eolOf(text);
  const lineStart = text.lastIndexOf('\n', open) + 1;
  const declIndent = indentOf(text.slice(lineStart, open));
  let next;
  if (inner.trim() === '') {
    next = `${text.slice(0, open + 1)}${eol}${declIndent}  ${entry},${eol}${declIndent}${text.slice(close)}`;
  } else if (inner.includes('\n')) {
    let end = inner.length;
    while (end > 0 && /\s/.test(inner[end - 1])) end--;
    const lastLineStart = inner.lastIndexOf('\n', end - 1) + 1;
    const itemIndent = indentOf(inner.slice(lastLineStart));
    const comma = inner[end - 1] === ',' ? '' : ',';
    next = `${text.slice(0, open + 1)}${inner.slice(0, end)}${comma}${eol}${itemIndent}${entry},${inner.slice(end)}${text.slice(close)}`;
  } else {
    next = `${text.slice(0, open + 1)}${inner.trimEnd().replace(/,$/, '')}, ${entry}${text.slice(close)}`;
  }
  return { ok: true, text: next };
}

/** Does the list `NAME` contain this text? (false when there is no such list) */
export function arrayContains(text, name, literal) {
  const open = findArrayOpen(text, name);
  if (open === -1) return false;
  const close = matchBracket(text, open);
  return close !== -1 && text.slice(open + 1, close).includes(literal);
}

// ---------------------------------------------------------------------------------------------
// The page list in src/lib/nav.ts

/** Icon names the app's nav understands (from `type NavIconName = "a" | "b"`), or null if the type is not found. */
export function navIconNames(text) {
  const m = /type\s+NavIconName\s*=\s*([^;]+);/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
}

/** Add `{ href, label, icon }` to NAV_ITEMS, above the Settings entry so Settings stays last. */
export function addNavItem(text, item) {
  const literal = `href: ${JSON.stringify(item.href)}`;
  if (arrayContains(text, 'NAV_ITEMS', literal)) return { ok: true, text, already: true };
  const icons = navIconNames(text);
  if (icons && !icons.includes(item.icon)) return { ok: false, text, reason: `icon-unknown:${item.icon}` };
  const entry = `{ href: ${JSON.stringify(item.href)}, label: ${JSON.stringify(item.label)}, icon: ${JSON.stringify(item.icon)} }`;
  const open = findArrayOpen(text, 'NAV_ITEMS');
  if (open === -1) return { ok: false, text, reason: 'list-not-found' };
  const close = matchBracket(text, open);
  const lines = splitLines(text);
  const eol = eolOf(text);
  // Line numbers of the list.
  const startLine = text.slice(0, open).split('\n').length - 1;
  const endLine = text.slice(0, close).split('\n').length - 1;
  for (let i = startLine + 1; i < endLine; i++) {
    if (/href:\s*["']\/settings["']/.test(lines[i])) {
      lines.splice(i, 0, `${indentOf(lines[i])}${entry},`);
      return { ok: true, text: lines.join(eol) };
    }
  }
  return addToArray(text, { name: 'NAV_ITEMS', entry, literal });
}
