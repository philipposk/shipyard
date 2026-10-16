// Reading a DESIGN.md. The collection uses YAML front matter (colors, typography, rounded, spacing,
// components) followed by plain sections. A small hand-written reader keeps scripts/ free of packages.
import { normalizeHex } from '../color.mjs';

const HEADER_RE = /^<!--\s*Imported by Shipyard\.[\s\S]*?-->\s*/;

/** The file without the header comment Shipyard adds when it saves a copy. */
export const stripHeader = (text) => String(text).replace(/^﻿/, '').replace(HEADER_RE, '');

function scalar(raw) {
  let v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return '';
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) return v.slice(1, -1);
  v = v.replace(/\s+#.*$/, '');
  return v;
}

/** YAML subset: nested maps, scalars, quoted strings, folded text. Lists are skipped. */
export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    const m = line.trim().match(/^("[^"]+"|'[^']+'|[^:#][^:]*?)\s*:(?:\s+(.*))?$/);
    if (!m) continue;
    const key = scalar(m[1]);
    const rest = m[2] ?? '';
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else if (/^[>|][+-]?$/.test(rest.trim())) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s*$/.test(lines[i + 1]) || lines[i + 1].match(/^ */)[0].length > indent)) parts.push(lines[++i].trim());
      parent[key] = parts.join(' ').trim();
    } else {
      parent[key] = scalar(rest);
    }
  }
  return root;
}

/** { data, body, hasFrontMatter } */
export function splitFrontMatter(raw) {
  const text = stripHeader(raw).replace(/^\s*(<!--[\s\S]*?-->\s*)+/, '');
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text, hasFrontMatter: false };
  let data = {};
  try {
    data = parseYaml(m[1]);
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length), hasFrontMatter: true };
}

/** "12px" / "12" / 12 -> 12, "9999px" -> 9999, anything else -> null. */
export function px(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value ?? '').trim().match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /^(rem|em)$/i.test(m[2] ?? '') ? n * 16 : n;
}

/** Follow "{colors.primary}" style references in the data tree. */
export function resolveRef(data, value) {
  const m = String(value ?? '').match(/^\{([\w.-]+)\}$/);
  if (!m) return value;
  let cur = data;
  for (const part of m[1].split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** "## Title" sections: [{ title, text }]. */
export function sections(body) {
  const out = [];
  let cur = null;
  for (const line of String(body).split(/\r?\n/)) {
    const h = line.match(/^#{2,3}\s+(.*?)\s*$/);
    if (h) {
      cur = { title: h[1], text: '' };
      out.push(cur);
    } else if (cur) {
      cur.text += `${line}\n`;
    }
  }
  return out;
}

/** Text of every section whose title matches `re`. */
export const sectionText = (secs, re) => secs.filter((s) => re.test(s.title)).map((s) => s.text).join('\n');

/**
 * Colours as { label: '#rrggbb' } from front matter, or (older files) from lines of the text such as
 * "- **Primary** `#533afd`" or "| Background | #ffffff |".
 */
export function extractColors(data, body) {
  const out = {};
  const fm = data?.colors;
  if (fm && typeof fm === 'object') {
    for (const [k, v] of Object.entries(fm)) {
      const hex = typeof v === 'string' ? normalizeHex(v.slice(0, 7)) : null;
      if (hex && (v.length <= 7 || /ff$/i.test(v.slice(7)))) out[k.toLowerCase()] = hex;
    }
  }
  if (Object.keys(out).length >= 3) return { colors: out, fromText: false };
  for (const line of String(body).split(/\r?\n/)) {
    const hex = line.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
    if (!hex) continue;
    const before = line.slice(0, hex.index).replace(/[*_`|>#:()[\]-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const after = line.slice(hex.index + hex[0].length).replace(/[*_`|>#:()[\]-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const label = (before || after).split(' ').slice(0, 4).join('-').replace(/[^a-z0-9-]/g, '');
    const n = normalizeHex(hex[0]);
    if (label && n && !(label in out)) out[label] = n;
  }
  return { colors: out, fromText: true };
}
