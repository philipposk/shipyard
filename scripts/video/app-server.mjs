// The student's app, running on this computer for exactly as long as one capture takes.
// Same rules as the design previews: `next dev` on a free port (loopback only), placeholder keys so nothing real can
// be reached, and the server is ALWAYS stopped again before this returns, checking that the port is closed.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ProvisionError } from '../provision/common.mjs';
import {
  explainServerFailure, findFreePort, installExitGuard, startDevServer, stopTree, tailOf,
} from '../design/render-previews.mjs';

const STARTUP_TIMEOUT_MS = 150_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An address on this computer only: http://localhost:3000, http://127.0.0.1:5173/... */
export const LOCAL_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/|$)/;

/** A page inside the app: /design-preview/video/board, /?demo=1 */
export const PAGE_RE = /^\/[A-Za-z0-9/_.~%?&=-]*$/;

/** What a page answer means for a capture (null = it is ready). */
export function explainPageStatus(status, location, page) {
  if (status === 200) return null;
  if (status === 404) return `The page ${page} does not exist (the app said "not found"). Check its path. Practice pages only exist while building, never in a production build.`;
  if (status >= 300 && status < 400) {
    return `The page ${page} sends visitors to ${location || 'another page'}. Practice pages must open without signing in: in a Shipyard app put them under /design-preview/video/.`;
  }
  return `The page ${page} answered with status ${status}.`;
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Start the app, wait until `page` answers, run `fn(base)`, and stop the app again, whatever happened.
 * Throws a plain ProvisionError. `fetchImpl` is injectable for tests.
 */
export async function withApp({ appDir, page = '/', fn, fetchImpl = fetch }) {
  const nextBin = path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!(await isFile(nextBin))) {
    throw new ProvisionError(
      'Next.js is not installed in this app, so I cannot start it for the recording. Run npm install in the app folder first. '
      + 'An app that is not built with Next.js: ask the student to start it themselves, then pass its address with --url.',
    );
  }
  const port = await findFreePort();
  const { child, state } = startDevServer({ appDir, nextBin, port });
  const removeGuard = installExitGuard(child);
  const base = `http://127.0.0.1:${port}`;
  let failure = null;
  let result;
  try {
    const started = Date.now();
    for (;;) {
      if (state.exited) throw new ProvisionError(explainServerFailure(state.log));
      if (Date.now() - started > STARTUP_TIMEOUT_MS) {
        throw new ProvisionError(`The app took more than ${STARTUP_TIMEOUT_MS / 1000} seconds to start.${state.log ? `\nLast thing it said:\n${tailOf(state.log, 4)}` : ''}`);
      }
      let res = null;
      try {
        res = await fetchImpl(`${base}${page}`, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      } catch {
        await sleep(400); // not listening yet
        continue;
      }
      if (res.status >= 500) {
        await sleep(600);
        throw new ProvisionError(`The app has an error, so ${page} would not open (status ${res.status}).${state.log ? `\nIt said:\n${tailOf(state.log, 6)}` : ''}`);
      }
      const problem = explainPageStatus(res.status, res.headers.get('location'), page);
      if (problem) throw new ProvisionError(problem);
      break;
    }
    result = await fn(base);
  } catch (err) {
    failure = err;
  } finally {
    removeGuard();
    const { closed } = await stopTree(child, port);
    if (!closed) {
      const msg = `I could not stop the app on port ${port}. Close it by hand (look for a node process) before running this again.`;
      if (failure) failure.message = `${failure.message}\n${msg}`;
      else failure = new ProvisionError(msg);
    }
  }
  if (failure) throw failure;
  return result;
}
