// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
// The pure parts of the error log: cleaning text so no secret is ever stored or emailed, fingerprints, the "not
// twice in a row" gates, checking what the browser sends, comparing the cron secret, grouping rows for the admin
// page and the Health result. Nothing here touches the network or the database.
import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_MESSAGE = 4000;
export const MAX_AREA = 100;
export const MAX_FINGERPRINT = 300;
export const MAX_DETAIL_BYTES = 4000;
/** One log row per problem per minute. */
export const LOG_GAP_MS = 60_000;
export const DEFAULT_ALERT_HOURS = 6;
export const MAX_REPORT_BYTES = 4096;
export const RETENTION_DAYS = 90;
/** The Health page: more than this many different unresolved problems in 24 hours is a "fail". */
export const FAIL_ABOVE = 50;

const REDACTED = "[hidden]";
// The five dashes around a private key block, written this way so the key-leak scan does not mistake this file for one.
const DASHES = "-".repeat(5);

// ---------------------------------------------------------------------------------------------
// Cleaning text

// Keys of an object whose value is never kept, whatever it holds (secrets, and also personal data: email, phone, address).
const SECRET_KEY = /pass(?:word|wd|phrase|code)|\bpass\b|secret|token|authorization|auth[_-]?header|cookie|session|api[_-]?key|private[_-]?key|credential|signature|\bjwt\b|bearer|body|payload|card|cvc|\biban\b|\bssn\b|email|phone|\baddress\b/i;

// Patterns that look like a key or a login, in any text. Each one keeps a short label so the log still says what happened.
const TEXT_RULES = [
  [new RegExp(`${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}[\\s\\S]*?(?:${DASHES}END [A-Z ]*PRIVATE KEY${DASHES}|$)`, "g"), `[private key ${REDACTED}]`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, `[login token ${REDACTED}]`],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, `[payment key ${REDACTED}]`],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, `[webhook secret ${REDACTED}]`],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, `[database key ${REDACTED}]`],
  [/\bsbp_[A-Za-z0-9]{8,}/g, `[access token ${REDACTED}]`],
  [/\bre_[A-Za-z0-9_]{16,}/g, `[email key ${REDACTED}]`],
  [/\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{16,}/g, `[ai key ${REDACTED}]`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, `[github token ${REDACTED}]`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `[cloud key ${REDACTED}]`],
  // postgres://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // "Authorization: Bearer abc" and a lone "Bearer abc"
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s,;"']+/gi, `$1${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Cookie headers run to the end of the line.
  [/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  // password=abc, "password": "abc", token: abc, secret=abc, api_key=abc
  [/(["']?\b[\w-]*(?:pass(?:word|wd|phrase|code)|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'}]+)/gi, `$1${REDACTED}`],
  // Web addresses often carry a key or a one-time code in the query part.
  [/([?&](?:[\w-]*(?:key|token|secret|pass(?:word)?|code|sig|signature|auth)[\w-]*)=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  // Personal data: an email address or a phone number in an error message (for example "invalid to: jane@x.com") is
  // not kept. The log says what went wrong, not who it happened to.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email hidden]"],
  [/(?<![\w.])\+\d[\d ().-]{6,}\d/g, "[phone hidden]"],
  [/(?<![\w.])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.])/g, "[phone hidden]"],
  // A long unbroken run of letters and digits is almost always a key or a hash.
  [/\b[A-Za-z0-9_-]{40,}\b/g, `[long value ${REDACTED}]`],
];

/** Text with every key-like part replaced. Never throws. @param {unknown} value @param {number} [max] */
export function scrubText(value, max = MAX_MESSAGE) {
  let text = typeof value === "string" ? value : value == null ? "" : String(value);
  // Work on a bounded piece: the rules must not be slow on a huge input.
  if (text.length > max * 4) text = text.slice(0, max * 4);
  for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A copy of `detail` that is safe to store: no values under secret-looking names, strings cleaned, small. Values that
 * are not plain data (functions, class objects such as Request) are dropped. Returns null when nothing is left.
 * @param {unknown} detail
 */
export function scrubDetail(detail, { maxBytes = MAX_DETAIL_BYTES } = {}) {
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (value == null) return value;
    if (typeof value === "string") return scrubText(value, 500);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value !== "object" || depth >= 4) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const out = {};
    for (const [key, v] of Object.entries(value).slice(0, 30)) {
      if (SECRET_KEY.test(key)) {
        out[key.slice(0, 60)] = REDACTED;
        continue;
      }
      const clean = walk(v, depth + 1);
      if (clean !== undefined) out[key.slice(0, 60)] = clean;
    }
    return out;
  };
  const clean = walk(detail, 0);
  if (clean === undefined || clean === null) return null;
  if (typeof clean === "object" && !Array.isArray(clean) && Object.keys(clean).length === 0) return null;
  const json = JSON.stringify(clean);
  if (json.length > maxBytes) return { note: "details were too long to keep" };
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Fingerprints

/** Short stable hash (FNV-1a, base 36). */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** The message with the parts that change from one occurrence to the next (numbers, ids, addresses) taken out. */
export function normalizeMessage(message) {
  return String(message ?? "")
    .split(/\r?\n/)[0]
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Same area and same kind of message give the same fingerprint. @param {string} area @param {string} message */
export function fingerprintFor(area, message) {
  return `${String(area).slice(0, 60)}:${hashString(normalizeMessage(scrubText(message, 500)))}`.slice(0, MAX_FINGERPRINT);
}

/** What went wrong, as one string: the useful fields of a database error, or the stack of a plain bug. @param {unknown} err */
export function describeError(err) {
  if (err && typeof err === "object") {
    const { code, message, details, hint, stack } = /** @type {Record<string, unknown>} */ (err);
    if (!code && typeof stack === "string") return scrubText(stack);
    const text = [code && `[${String(code)}]`, message, details, hint].filter(Boolean).join(" ");
    if (text) return scrubText(text);
  }
  return scrubText(String(err));
}

// ---------------------------------------------------------------------------------------------
// "Not again" gates

/**
 * Remembers when a key was last let through. `allow(key, now)` is true the first time and again once `windowMs` has
 * passed. Lives in one server's memory (a brake, not a guarantee), and is emptied when it grows too big.
 * @param {{ windowMs: number, maxKeys?: number }} options
 */
export function createGate({ windowMs, maxKeys = 500 }) {
  /** @type {Map<string, number>} */
  const last = new Map();
  return {
    /** @param {string} key @param {number} [now] */
    allow(key, now = Date.now()) {
      const before = last.get(key);
      if (before !== undefined && now - before < windowMs) return false;
      if (last.size >= maxKeys) {
        for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
        if (last.size >= maxKeys) last.clear();
      }
      last.set(key, now);
      return true;
    },
    /** Forget a key, so the next occurrence is let through. @param {string} key */
    forget(key) {
      last.delete(key);
    },
  };
}

/**
 * At most `max` hits per `windowMs` for each key. `hit(key, now)` records and answers true when allowed.
 * @param {{ windowMs: number, max: number, maxKeys?: number }} options
 */
export function createRateLimit({ windowMs, max, maxKeys = 5000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  return {
    /** @param {string} key @param {number} [now] */
    hit(key, now = Date.now()) {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      if (!hits.has(key) && hits.size >= maxKeys) hits.clear();
      list.push(now);
      hits.set(key, list);
      return true;
    },
  };
}

/** Hours between two emails about the same problem. @param {unknown} value */
export function parseAlertHours(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 && n <= 24 * 14 ? n : DEFAULT_ALERT_HOURS;
}

/** The key Resend uses to drop a repeated request: same problem, same window, same key. */
export function alertIdempotencyKey(fingerprint, now, windowMs) {
  return `alert-${hashString(fingerprint)}-${Math.floor(now / windowMs)}`;
}

// ---------------------------------------------------------------------------------------------
// The alert email

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Addresses from ADMIN_EMAIL (commas or semicolons between several) plus the admins' own addresses: valid, unique, at most 5. */
export function alertRecipients(adminEmailSetting, extra = []) {
  const all = [...String(adminEmailSetting ?? "").split(/[,;]/), ...extra]
    .map((e) => String(e ?? "").trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
  return [...new Set(all)].slice(0, 5);
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The email an owner gets. Everything is cleaned again here, so a message that slipped through still leaks nothing.
 * @param {{ brandName: string, area: string, subject?: string, summary?: string, action?: string, message: string, siteUrl: string, hours: number, at: number }} input
 */
export function buildAlertEmail(input) {
  const message = scrubText(input.message, 1500);
  const text = [
    input.summary ? scrubText(input.summary, 500) : "Something went wrong in your app, and a visitor may have seen an error message.",
    `What to do:\n${input.action ? scrubText(input.action, 500) : `Open ${input.siteUrl}/admin/logs to see what happened and how often. Press "Mark resolved" when it is fixed.`}`,
    `Details (visitors never see these):\n${message}`,
    `Where: ${scrubText(input.area, MAX_AREA)}\nWhen: ${new Date(input.at).toISOString()}`,
    `While this keeps happening you get this email at most every ${input.hours} ${input.hours === 1 ? "hour" : "hours"}. Every time it happens is saved in the log.`,
  ].join("\n\n");
  return {
    subject: `[${input.brandName}] ${scrubText(input.subject || `Problem in ${input.area}`, 120)}`,
    text,
    html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
  };
}

// ---------------------------------------------------------------------------------------------
// What the browser sends to POST /api/errors

/**
 * @typedef {{ area: string, fingerprint: string, message: string, route: string, digest: string | null, source: "page" | "app" }} ClientReport
 */

const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;

/** How many client reports one server takes in a minute, from everyone together. A brake on a flood of made-up reports. */
export const CLIENT_REPORTS_PER_MINUTE = 60;
/** All crashed-page reports share this one email slot, so together they send at most one email per ERROR_ALERT_HOURS. */
export const CLIENT_EMAIL_KEY = "client";

/**
 * What the owner is told when a visitor's browser reports a crash. Anyone on the internet can post a report, so the
 * email is always the same generic text: no page name and none of the visitor's words (they could be written to trick
 * the owner). The details are in the log, which only admins can open. Fixed values, spread into the reportError call.
 */
export function clientAlert() {
  return {
    emailKey: CLIENT_EMAIL_KEY,
    subject: "A page crashed for a visitor",
    summary: "A page in your app crashed for a visitor. They saw the \"something went wrong\" screen.",
    emailMessage: "The page and the exact words are in the error log, which only admins can open.",
  };
}

/**
 * Checks the text body of a client report. Returns { ok: true, report } or { ok: false, status, error }.
 * @param {string} raw the body as text
 * @returns {{ ok: true, report: ClientReport } | { ok: false, status: number, error: string }}
 */
export function parseClientReport(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, status: 400, error: "Empty report." };
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return { ok: false, status: 413, error: "Report too big." };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "Not valid JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Not a report." };
  if (typeof body.message !== "string" || body.message.trim() === "") return { ok: false, status: 400, error: "A message is needed." };
  const route = cleanRoute(body.route);
  if (!route) return { ok: false, status: 400, error: "A page path is needed." };
  // Web addresses are removed: anyone can post here, and a link in the text would otherwise be shown to the owner (and
  // lets a fake "confirm at https://..." message sit in the log).
  const message = scrubText(body.message.trim(), 500).replace(URL_RE, "<url>");
  const digest = typeof body.digest === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.digest) ? body.digest : null;
  const source = body.source === "app" ? "app" : "page";
  return {
    ok: true,
    report: {
      area: "client",
      // Built here, not taken from the browser: anyone can post to this route, so they must not choose a fingerprint
      // (they could hide a real problem behind a made-up one, or make up thousands of emails).
      fingerprint: `client:${route}:${hashString(normalizeMessage(message))}`.slice(0, MAX_FINGERPRINT),
      message,
      route,
      digest,
      source,
    },
  };
}

/** The path of a page, without address, query or fragment (they can carry one-time codes). Null if it is not a path. */
export function cleanRoute(value) {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/)[0].trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 200 || /[\s\u0000-\u001f]/.test(path)) return null;
  // Ids in the path would make every visit a new problem.
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/<id>")
    .replace(/\/\d{3,}(?=\/|$)/g, "/<n>");
}

/** The address a request came from, for the per-person limit. Falls back to one shared bucket. */
export function clientKey(headers) {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded ? forwarded.split(",")[0].trim() : "";
  return (first || headers.get("x-real-ip") || "unknown").slice(0, 64);
}

// ---------------------------------------------------------------------------------------------
// The cron secret

/** A secret shorter than this is treated as "not set": the summary route stays closed. */
export const MIN_CRON_SECRET = 16;

export const cronSecretUsable = (secret) => typeof secret === "string" && secret.length >= MIN_CRON_SECRET;

/** Compare two secrets without leaking where they differ. Missing or empty values never match. */
export function secretsMatch(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || given === "" || expected === "") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * What the summary route answers. `GET` with the right header: 200. No secret set: 404. Header missing or wrong: 401.
 * @param {{ expected: string | undefined, given: string | null }} input
 * @returns {{ ok: true } | { ok: false, status: 401 | 404 }}
 */
export function checkCronAccess({ expected, given }) {
  if (!cronSecretUsable(expected)) return { ok: false, status: 404 };
  return secretsMatch(given, expected) ? { ok: true } : { ok: false, status: 401 };
}

/** The summary the cron job reads: only ids and statuses, never messages or personal data. */
export function buildSummary(results, { errors24h, unresolved }) {
  const checks = results.map((r) => ({ id: String(r.id), status: String(r.status) }));
  return { ok: !checks.some((c) => c.status === "fail"), checks, errors24h, unresolved };
}

// ---------------------------------------------------------------------------------------------
// Rows for the admin page and the Health check

/**
 * Rows (newest first or any order) grouped by fingerprint: count, first and last seen, area, latest message.
 * @param {{ fingerprint: string, area: string, message: string, created_at: string, resolved_at: string | null }[]} rows
 */
export function groupErrors(rows, { includeResolved = false, area = "" } = {}) {
  /** @type {Map<string, { fingerprint: string, area: string, message: string, count: number, firstSeen: string, lastSeen: string, resolved: boolean }>} */
  const groups = new Map();
  for (const row of rows) {
    if (area && row.area !== area) continue;
    const g = groups.get(row.fingerprint);
    const resolved = row.resolved_at != null;
    if (!g) {
      groups.set(row.fingerprint, { fingerprint: row.fingerprint, area: row.area, message: row.message, count: 1, firstSeen: row.created_at, lastSeen: row.created_at, resolved });
      continue;
    }
    g.count += 1;
    if (row.created_at < g.firstSeen) g.firstSeen = row.created_at;
    if (row.created_at > g.lastSeen) {
      g.lastSeen = row.created_at;
      g.message = row.message;
      g.resolved = resolved;
    }
  }
  return [...groups.values()]
    .filter((g) => includeResolved || !g.resolved)
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}

/** The different areas in rows, sorted. */
export const areasOf = (rows) => [...new Set(rows.map((r) => r.area))].sort();

/** "2026-10-16 14:03 UTC" */
export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** @typedef {{ status: "ok" | "warn" | "fail" | "skip", detail: string, fix?: string }} HealthResult */

/**
 * Health page line for the number of different unresolved problems in the last 24 hours.
 * @param {number} problems
 * @returns {HealthResult}
 */
export function errorsResult(problems) {
  if (problems > FAIL_ABOVE) {
    return {
      status: "fail",
      detail: `${problems} different problems in the last 24 hours that nobody has marked resolved.`,
      fix: "Open the error log (/admin/logs), start with the one that happened most, and mark each resolved once it is fixed. Many at once usually means one thing is broken.",
    };
  }
  if (problems > 0) {
    return {
      status: "warn",
      detail: `${problems} ${problems === 1 ? "problem" : "different problems"} in the last 24 hours that nobody has marked resolved.`,
      fix: "Open the error log (/admin/logs) to see what happened. Mark each one resolved once it is fixed.",
    };
  }
  return { status: "ok", detail: "No unresolved problems in the last 24 hours." };
}

/**
 * Health page line when the log itself can not be read.
 * @returns {HealthResult}
 */
export function errorsUnreadable() {
  return {
    status: "fail",
    detail: "The error log could not be read.",
    fix: "Run provision-supabase.mjs in Shipyard again, so the error_log table exists, and check that the app's secret server key is set in Vercel.",
  };
}

/** The day before which rows are removed. @param {number} [now] */
export function retentionCutoff(now = Date.now()) {
  return new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
}
