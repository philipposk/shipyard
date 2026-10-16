// Adds the phone app's sign-in return address to the Supabase project's allowed redirect list.
// Add-only: nothing already in the list is changed or removed. Needs SUPABASE_ACCESS_TOKEN (set up by /shipyard:setup).
import { readAppConfig } from '../provision/common.mjs';
import * as api from '../lib/supabase-api.mjs';
import { getSecret as realGetSecret } from '../lib/secrets.mjs';

/**
 * Returns { added: [...], status }. status: 'added' | 'present' | 'no-project' | 'no-token'.
 * deps: { fetch, getSecret } for tests.
 */
export async function addRedirects({ appDir, redirects }, deps = {}) {
  const config = await readAppConfig(appDir);
  if (!config.supabaseRef) return { status: 'no-project', added: [] };
  let token;
  try {
    token = await (deps.getSecret ?? realGetSecret)('SUPABASE_ACCESS_TOKEN');
  } catch (err) {
    if (err?.name === 'MissingSecretError') return { status: 'no-token', added: [] };
    throw err;
  }
  const auth = { token, fetch: deps.fetch, sleep: deps.sleep };
  const current = (await api.getAuthConfig(auth, config.supabaseRef)) ?? {};
  const currentList = String(current.uri_allow_list ?? '');
  const known = new Set(currentList.split(',').map((s) => s.trim()));
  const added = redirects.filter((r) => !known.has(r));
  if (added.length === 0) return { status: 'present', added: [] };
  await api.patchAuthConfig(auth, config.supabaseRef, { uri_allow_list: api.mergeUriAllowList(currentList, added) });
  return { status: 'added', added };
}
