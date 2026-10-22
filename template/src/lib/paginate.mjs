// Plain JavaScript on purpose: `npm test` loads this file directly, without a build step.

/** Supabase returns at most this many rows per request, whatever you ask for. */
export const PAGE_SIZE = 1000;

/**
 * Reads every row of a list, one page at a time. A single Supabase query silently stops at 1000 rows,
 * so a list, a total or a leaderboard built from one query is wrong once the table grows.
 * The query must have a stable order (for example `created_at` then `id`), or rows can repeat or vanish between pages.
 * @template T
 * @param {(from: number, to: number) => PromiseLike<{ data: T[] | null, error: { message: string } | null }>} fetchPage
 *   Runs the query for one slice, for example `(from, to) => supabase.from("items").select("*").order("id").range(from, to)`.
 * @param {{ pageSize?: number, maxRows?: number }} [options] `maxRows` is a safety stop (default 50,000).
 * @returns {Promise<{ data: T[], error: { message: string } | null, truncated: boolean }>}
 */
export async function fetchAll(fetchPage, { pageSize = PAGE_SIZE, maxRows = 50_000 } = {}) {
  /** @type {T[]} */
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) return { data: rows, error, truncated: false };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}
