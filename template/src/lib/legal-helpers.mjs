// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.
import { normalizeEmail } from "./validate.mjs";

/**
 * @typedef {{ id: string, title: string, paragraphs: string[], table?: { headers: string[], rows: string[][] } }} LegalSection
 * @typedef {{ name: string, address: string, email: string, country: string }} LegalController
 */

const CONTROLLER_FIELDS = /** @type {const} */ (["name", "address", "email", "country"]);
const FIELD_LABELS = { name: "name", address: "address", email: "contact email", country: "country" };

/** Text that means the page was never finished: "[COMPANY]", "<YOUR_NAME>", "{{name}}", lorem ipsum, TODO, TBD. */
export const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9 _-]{2,}\]|<[A-Z][A-Z0-9_]{2,}>|\{\{[^}]*\}\}|[Ll]orem [Ii]psum|LOREM IPSUM|\bTODO\b|\bTBD\b|\bFIXME\b/;

/** Which controller fields are empty, in plain words. @param {Partial<LegalController> | null | undefined} controller */
export function missingControllerFields(controller) {
  return CONTROLLER_FIELDS.filter((f) => !String(controller?.[f] ?? "").trim()).map((f) => FIELD_LABELS[f]);
}

/**
 * What the legal pages show as "who runs this app". Never a placeholder: an empty name falls back to the app name
 * and an empty email falls back to the public contact email (NEXT_PUBLIC_CONTACT_EMAIL).
 * `complete` is true only when the generated text itself has all four fields.
 * @param {Partial<LegalController> | null | undefined} controller
 * @param {{ brandName: string, contactEmail?: string }} fallback
 */
export function resolveController(controller, { brandName, contactEmail = "" }) {
  const name = String(controller?.name ?? "").trim();
  const email = String(controller?.email ?? "").trim();
  return {
    name: name || brandName,
    address: String(controller?.address ?? "").trim(),
    email: email || contactEmail.trim(),
    country: String(controller?.country ?? "").trim(),
    complete: missingControllerFields(controller).length === 0,
    missing: missingControllerFields(controller),
  };
}

/** @param {LegalSection[]} sections @returns {string[]} problems, in plain English; empty when fine */
export function validateSections(sections) {
  /** @type {string[]} */
  const problems = [];
  if (!Array.isArray(sections) || sections.length === 0) return ["there are no sections"];
  const seen = new Set();
  for (const [i, s] of sections.entries()) {
    const where = `section ${i + 1}`;
    if (!s || typeof s.title !== "string" || !s.title.trim()) {
      problems.push(`${where} has no title`);
      continue;
    }
    if (typeof s.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id)) problems.push(`"${s.title}" has an id that is not lowercase letters, numbers and dashes`);
    else if (seen.has(s.id)) problems.push(`"${s.title}" repeats the id "${s.id}"`);
    else seen.add(s.id);
    if (!Array.isArray(s.paragraphs) || s.paragraphs.some((p) => typeof p !== "string" || !p.trim())) problems.push(`"${s.title}" has an empty paragraph`);
    else if (s.paragraphs.length === 0 && !s.table) problems.push(`"${s.title}" has no text`);
    if (s.table) {
      const width = s.table.headers?.length ?? 0;
      if (width === 0) problems.push(`the table in "${s.title}" has no headers`);
      else if (!Array.isArray(s.table.rows) || s.table.rows.some((r) => !Array.isArray(r) || r.length !== width)) problems.push(`a row in the table in "${s.title}" does not match its headers`);
    }
  }
  return problems;
}

/** Titles of sections whose text still holds a placeholder. @param {LegalSection[]} sections */
export function sectionsWithPlaceholders(sections) {
  return sections
    .filter((s) => {
      const text = [s.title, ...s.paragraphs, ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : [])].join("\n");
      return PLACEHOLDER_RE.test(text);
    })
    .map((s) => s.title);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-16" becomes "16 October 2026". Anything else comes back unchanged. @param {string} iso */
export function formatLegalDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return String(iso);
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : String(iso);
}

/** A valid public contact email, or "". @param {string | undefined} value */
export function cleanContactEmail(value) {
  return normalizeEmail(value ?? "") ?? "";
}
