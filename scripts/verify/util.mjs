// Small helpers shared by the verify checks. No dependencies.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const REQUEST_TIMEOUT_MS = 20_000;

/** Plain-English reason for a failed network call. Never includes the address or headers. */
export function describeNetworkError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `no answer after ${REQUEST_TIMEOUT_MS / 1000} seconds`;
  }
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the address was not found (check the URL and your internet)';
  if (code === 'ECONNREFUSED') return 'connection refused (is the app running?)';
  if (code === 'ECONNRESET') return 'the connection was cut off';
  if (typeof code === 'string' && code.startsWith('ERR_TLS')) return 'the secure (https) connection failed';
  return 'the request failed';
}

/**
 * One HTTP request that never throws. Redirects are NOT followed unless asked,
 * so a page that quietly sends people to sign-in is noticed.
 * Returns { status (0 = no answer), headers, text, location, url, error? }.
 */
export async function request(url, { method = 'GET', headers = {}, body, redirect = 'manual', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
    const text = method === 'HEAD' ? '' : await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location'), url: res.url };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: '', location: null, url, error: describeNetworkError(err) };
  }
}

/** Join a site address and a path without doubling slashes. */
export function joinUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}

/** Path part of a Location header, for messages. Query strings are dropped. */
export function locationPath(location, base) {
  if (!location) return '(unknown)';
  try {
    return new URL(location, base).pathname;
  } catch {
    return '(unknown)';
  }
}

/**
 * Build a function that blanks out known secret values and anything that looks like a key or token.
 * Use it on every piece of text that came from a provider before it can reach the screen.
 */
export function makeRedactor(values = []) {
  const known = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 6))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const v of known) out = out.split(v).join('***');
    return out
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***')
      .replace(/\b(?:sb_secret_|sbp_|sk_live_|sk_test_|sk-or-v1-|sk-proj-)[A-Za-z0-9_-]{8,}/g, '***');
  };
}

/** Short, safe message from a provider error body (JSON or text). */
export function errorText(res, redact = (s) => s) {
  if (!res) return 'no answer';
  if (res.error) return res.error;
  let msg = '';
  try {
    const body = JSON.parse(res.text);
    msg = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? body?.hint ?? '';
    if (typeof msg !== 'string') msg = '';
  } catch {
    msg = '';
  }
  msg = redact(msg).replace(/\s+/g, ' ').trim().slice(0, 160);
  return msg ? `${res.status}: ${msg}` : `status ${res.status}`;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&apos;': "'" };
/** Decode the handful of HTML entities React writes, so "Tom &amp; Jerry" matches "Tom & Jerry". */
export function decodeEntities(text) {
  return String(text).replace(/&(?:amp|lt|gt|quot|apos|#x27|#39);/g, (m) => ENTITIES[m]);
}

/**
 * Remove // and /* *\/ comments from code, leaving strings alone ("http://x" stays).
 * Good enough for the static checks; not a full parser.
 */
export function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The app's own identity file written by scaffold, or null. */
export async function readAppFile(appDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(appDir, '.shipyard-app.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Display name of the app: profile entry, then .shipyard-app.json, then SITE_NAME in constants.ts. */
export async function resolveAppName(ctx) {
  if (ctx.app?.name) return String(ctx.app.name);
  const file = await readAppFile(ctx.appDir);
  if (file?.name) return String(file.name);
  for (const rel of ['src/lib/constants.ts', 'lib/constants.ts']) {
    try {
      const text = await readFile(path.join(ctx.appDir, rel), 'utf8');
      const m = /SITE_NAME\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (m) return JSON.parse(`"${m[1]}"`);
    } catch {
      // try the next place
    }
  }
  return null;
}

export const pass = (name, summary, details = [], extra = {}) => ({ name, ok: true, summary, details, ...extra });
/** A failed check. `problems` = what is wrong (shown as ✗ lines); `details` = what did work. */
export const failed = (name, summary, problems = [], extra = {}) => {
  const { details = [], ...rest } = extra;
  return { name, ok: false, summary, problems, details, ...rest };
};
export const skip = (name, reason) => ({ name, ok: true, skipped: true, reason, summary: `skipped: ${reason}`, details: [] });
