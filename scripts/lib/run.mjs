// Run another program and capture what it prints. Never throws on a non-zero
// exit, and never logs the arguments, environment or stdin (they may hold keys).
import { spawn } from 'node:child_process';
import path from 'node:path';

const WINDOWS_CMD_SHIMS = new Set(['npx', 'npm', 'vercel']);

/**
 * Windows cannot spawn .cmd files directly on current Node versions (spawning a
 * .cmd with shell:false throws EINVAL). So we go through cmd.exe with one
 * pre-quoted command line. Returns null when an argument can't be quoted safely.
 */
export function buildWindowsCommandLine(file, args) {
  const quote = (s) => {
    if (/["%\r\n]/.test(s)) return null; // cannot be escaped reliably inside cmd.exe
    return /[\s&|<>()^,;=!]/.test(s) || s === '' ? `"${s}"` : s;
  };
  const parts = [file, ...args].map(quote);
  if (parts.some((p) => p === null)) return null;
  return `"${parts.join(' ')}"`;
}

/**
 * run(cmd, args, { cwd, input, env, timeoutMs, quiet, inherit })
 *  - input: string written to the child's stdin, then closed (use it for secrets)
 *  - env: extra variables, merged over process.env
 *  - quiet (default true): capture only. quiet:false also echoes the child's
 *    output live, handy for long steps like installs
 *  - inherit: give the child our terminal (for interactive logins). Output is
 *    then not captured.
 * Resolves to { code, stdout, stderr }. code 127 = program not found,
 * 124 = timed out.
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd, input, env, timeoutMs, quiet = true, inherit = false } = opts;
  return new Promise((resolve) => {
    let file = cmd;
    let spawnArgs = args;
    const spawnOpts = {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: false,
      windowsHide: true,
    };

    if (process.platform === 'win32' && WINDOWS_CMD_SHIMS.has(cmd)) {
      const line = buildWindowsCommandLine(`${cmd}.cmd`, args);
      if (line === null) {
        resolve({ code: 1, stdout: '', stderr: 'An argument contains characters that are not safe to pass on Windows.' });
        return;
      }
      file = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', line];
      spawnOpts.windowsVerbatimArguments = true;
    }

    spawnOpts.stdio = inherit
      ? 'inherit'
      : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];

    let child;
    try {
      child = spawn(file, spawnArgs, spawnOpts);
    } catch (err) {
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: `Could not start ${cmd}.` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr: timedOut ? `${stderr}\nTimed out.`.trim() : stderr });
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.stdout?.on('data', (d) => {
      stdout += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
      if (!quiet) process.stderr.write(d);
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') stderr += `Command not found: ${path.basename(String(cmd))}`;
      else stderr += `Could not run ${path.basename(String(cmd))} (${err.code ?? 'error'}).`;
      finish(err.code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // child exited before reading: ignore EPIPE
      child.stdin.end(input);
    }
  });
}

/** Absolute path of a program on PATH, or null. */
export async function which(cmd) {
  if (!cmd || /[\s"'`$;&|<>]/.test(cmd)) return null;
  if (process.platform === 'win32') {
    const r = await run('where', [cmd]);
    if (r.code !== 0) return null;
    const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && path.isAbsolute(first) ? first : null;
  }
  // The name is passed as a positional parameter, never spliced into the script.
  const r = await run('sh', ['-c', 'command -v -- "$1"', 'sh', cmd]);
  if (r.code !== 0) return null;
  const first = r.stdout.split('\n')[0].trim();
  return first && path.isAbsolute(first) ? first : null;
}

/** Arguments for `run('npx', ...)`: always non-interactive (--yes). */
export function npx(pkgAndArgs) {
  const list = Array.isArray(pkgAndArgs) ? pkgAndArgs : [String(pkgAndArgs)];
  return ['npx', ['--yes', ...list]];
}
