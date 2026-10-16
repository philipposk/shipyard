// Getting a DESIGN.md: the list of names and the file itself, from public GitHub only.
// `fetchImpl` is injectable so tests never touch the network.
export const REPO = 'VoltAgent/awesome-design-md';
export const MAX_BYTES = 200 * 1024;
export const TIMEOUT_MS = 10_000;
export const LICENCE_LINE = `MIT licence, ${REPO}`;

const API_LIST = `https://api.github.com/repos/${REPO}/contents/design-md`;
const README_RAW = `https://raw.githubusercontent.com/${REPO}/main/README.md`;
const rawFor = (name) => `https://raw.githubusercontent.com/${REPO}/main/design-md/${name}/DESIGN.md`;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const URL_HOSTS = ['raw.githubusercontent.com', 'github.com', 'gist.githubusercontent.com'];

export class DesignMdError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DesignMdError';
    Object.assign(this, extra);
  }
}

export const isValidName = (name) => typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');

/** Read a response body as text, refusing anything over `max` bytes. */
async function readCapped(res, max) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new DesignMdError('That file is too big to be a DESIGN.md (over 200 KB).');
  let text;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new DesignMdError('That file is too big to be a DESIGN.md (over 200 KB).');
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await res.text();
    if (Buffer.byteLength(text) > max) throw new DesignMdError('That file is too big to be a DESIGN.md (over 200 KB).');
  }
  return text;
}

const ALLOWED_HOSTS = [...URL_HOSTS, 'api.github.com'];
const MAX_HOPS = 3;

function allowedHost(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

// Redirects are followed by hand, so a link that points off GitHub is refused BEFORE any request goes there.
async function get(fetchImpl, url, { accept } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res;
    try {
      res = await fetchImpl(current, {
        headers: { 'user-agent': 'shipyard-design', accept: accept ?? 'text/plain, */*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new DesignMdError(timedOut ? 'GitHub did not answer in 10 seconds. Check your internet and try again.' : 'I could not reach GitHub. Check your internet and try again.');
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    if (location) {
      let next = '';
      try {
        next = new URL(location, current).href;
      } catch { /* refused below */ }
      if (!allowedHost(next)) throw new DesignMdError('GitHub sent me somewhere else, so I stopped.');
      current = next;
      continue;
    }
    if (res.url) {
      let host = '';
      try {
        host = new URL(res.url).hostname;
      } catch { /* ignore */ }
      if (host && !ALLOWED_HOSTS.includes(host)) throw new DesignMdError('GitHub sent me somewhere else, so I stopped.');
    }
    return res;
  }
  throw new DesignMdError('GitHub sent me round in circles, so I stopped.');
}

/** { names: string[], source: 'api' | 'readme' } */
export async function listNames({ fetchImpl = globalThis.fetch } = {}) {
  let apiProblem = null;
  try {
    const res = await get(fetchImpl, API_LIST, { accept: 'application/vnd.github+json' });
    if (res.ok) {
      const rows = JSON.parse(await readCapped(res, 2 * 1024 * 1024));
      const names = (Array.isArray(rows) ? rows : []).filter((r) => r?.type === 'dir' && isValidName(r.name)).map((r) => r.name);
      if (names.length > 0) return { names: names.sort(), source: 'api' };
      apiProblem = 'empty';
    } else {
      apiProblem = res.status;
    }
  } catch (err) {
    apiProblem = err.message;
  }
  // GitHub's free API limit is 60 calls an hour; the README lists the same names.
  const res = await get(fetchImpl, README_RAW);
  if (!res.ok) throw new DesignMdError(`I could not get the list from GitHub (${apiProblem ?? res.status}). Try again in a few minutes.`);
  const names = namesFromReadme(await readCapped(res, 2 * 1024 * 1024));
  if (names.length === 0) throw new DesignMdError('I could not read the list of designs from GitHub. Try again later, or give me a link with --url.');
  return { names, source: 'readme' };
}

/** Names from README links like https://getdesign.md/<name>/design-md */
export function namesFromReadme(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/https:\/\/getdesign\.md\/([a-z0-9][a-z0-9._-]*)\/design-md/gi)) {
    const n = m[1].toLowerCase();
    if (isValidName(n)) found.add(n);
  }
  return [...found].sort();
}

/** { text, url } for a collection name. */
export async function downloadByName(name, { fetchImpl = globalThis.fetch } = {}) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (!isValidName(clean)) throw new DesignMdError(`"${name}" is not a name from the collection. Run with --list to see the names.`, { notFound: true });
  const url = rawFor(clean);
  const res = await get(fetchImpl, url);
  if (res.status === 404) throw new DesignMdError(`There is no design called "${clean}" in the collection.`, { notFound: true });
  if (!res.ok) throw new DesignMdError(`GitHub said no (${res.status}). Try again in a few minutes.`);
  return { text: await readCapped(res, MAX_BYTES), url, name: clean };
}

/** Turn a link into the raw file link we may download, or throw. */
export function safeRawUrl(input) {
  let u;
  try {
    u = new URL(String(input));
  } catch {
    throw new DesignMdError('That is not a web address.');
  }
  if (u.protocol !== 'https:') throw new DesignMdError('Only https:// links are allowed.');
  if (u.username || u.password || (u.port && u.port !== '443')) throw new DesignMdError('That link has login details or a port in it, so I will not use it.');
  if (u.hostname === 'getdesign.md') {
    const m = u.pathname.match(/^\/([a-z0-9][a-z0-9._-]*)\/design-md\/?$/i);
    if (m && isValidName(m[1].toLowerCase())) return { url: rawFor(m[1].toLowerCase()), name: m[1].toLowerCase() };
    throw new DesignMdError('For getdesign.md pages use --name <name> (run --list to see the names).');
  }
  if (!URL_HOSTS.includes(u.hostname)) {
    throw new DesignMdError('I only download from GitHub (raw.githubusercontent.com or a github.com file link).');
  }
  if (u.hostname === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (!m) throw new DesignMdError('Give me the link to the file itself on GitHub (the one with /blob/ in it).');
    return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, name: null };
  }
  return { url: `${u.origin}${u.pathname}`, name: null };
}

export async function downloadByUrl(input, { fetchImpl = globalThis.fetch } = {}) {
  const { url, name } = safeRawUrl(input);
  const res = await get(fetchImpl, url);
  if (res.status === 404) throw new DesignMdError('GitHub has no file at that link (404). Is the repository public?', { notFound: true });
  if (!res.ok) throw new DesignMdError(`GitHub said no (${res.status}). Try again in a few minutes.`);
  return { text: await readCapped(res, MAX_BYTES), url, name };
}

/** Closest names for a typo: contains / is contained / same start. */
export function suggestNames(name, names, max = 5) {
  const n = String(name).toLowerCase();
  const score = (x) => (x === n ? 0 : x.startsWith(n) || n.startsWith(x) ? 1 : x.includes(n) || n.includes(x) ? 2 : 9);
  return names.map((x) => [x, score(x)]).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, max).map(([x]) => x);
}
