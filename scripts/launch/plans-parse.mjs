// Reads the plans the billing module keeps in src/lib/billing/plans.ts. The file holds a fenced JSON block between
// two marker comments, so we never have to run or compile TypeScript.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProvisionError } from '../provision/common.mjs';

export const PLANS_FILE = path.join('src', 'lib', 'billing', 'plans.ts');
const START = '// shipyard:plans:start';
const END = '// shipyard:plans:end';
const LOOKUP_RE = /^[a-z0-9][a-z0-9_.-]{2,100}$/;

/** Parse the plans block out of plans.ts text. Throws a plain-English ProvisionError. */
export function parsePlansSource(text, slug) {
  const source = String(text);
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new ProvisionError(`${PLANS_FILE} has lost its markers. Put the plans back between the lines "${START}" and "${END}".`);
  }
  const block = source.slice(a + START.length, b).trim().replaceAll('<APP_SLUG>', slug);
  let plans;
  try {
    plans = JSON.parse(block);
  } catch {
    throw new ProvisionError(`The plans in ${PLANS_FILE} are not valid JSON. Use double quotes, no trailing commas, no comments inside the block.`);
  }
  if (!Array.isArray(plans) || plans.length === 0) throw new ProvisionError(`${PLANS_FILE} needs at least one plan.`);
  const keys = new Set();
  const ids = new Set();
  for (const p of plans) {
    const label = `plan "${p?.id}"`;
    if (!p || typeof p !== 'object') throw new ProvisionError(`${PLANS_FILE}: every plan must be an object.`);
    if (typeof p.id !== 'string' || ids.has(p.id)) throw new ProvisionError(`${PLANS_FILE}: ${label} has a missing or repeated id.`);
    ids.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim()) throw new ProvisionError(`${PLANS_FILE}: ${label} has no name.`);
    if (!Number.isInteger(p.priceCents) || p.priceCents < 0) throw new ProvisionError(`${PLANS_FILE}: ${label} needs priceCents as a whole number of cents.`);
    if (typeof p.currency !== 'string' || !/^[A-Za-z]{3}$/.test(p.currency)) throw new ProvisionError(`${PLANS_FILE}: ${label} needs a 3-letter currency such as EUR.`);
    if (p.interval !== 'month' && p.interval !== 'year') throw new ProvisionError(`${PLANS_FILE}: ${label} needs interval "month" or "year".`);
    if (p.priceCents > 0) {
      if (typeof p.lookupKey !== 'string' || !LOOKUP_RE.test(p.lookupKey)) {
        throw new ProvisionError(`${PLANS_FILE}: ${label} needs a lookupKey of lowercase letters, numbers, dots, dashes or underscores (3 to 100 characters).`);
      }
      if (keys.has(p.lookupKey)) throw new ProvisionError(`${PLANS_FILE}: two plans share the lookupKey "${p.lookupKey}".`);
      keys.add(p.lookupKey);
    }
  }
  return plans;
}

/** Read and parse <appDir>/src/lib/billing/plans.ts. */
export async function readPlans(appDir, slug) {
  let text;
  try {
    text = await readFile(path.join(appDir, PLANS_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ProvisionError(`This app has no ${PLANS_FILE}. Add the payments module first: node add-module.mjs <app-folder> billing`);
    }
    throw err;
  }
  return parsePlansSource(text, slug);
}
