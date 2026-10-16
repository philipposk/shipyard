// Tiny terminal helpers shared by every Shipyard script.
// All human lines go to stdout so a student (and Claude) sees them in order.
// Scripts running with --json should call setQuiet(true) and print only json().

let quiet = false;
const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor() ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Silence ok/fail/warn/info/step (used with --json). json() still prints. */
export function setQuiet(value = true) {
  quiet = Boolean(value);
}

function line(text) {
  if (!quiet) process.stdout.write(`${text}\n`);
}

export const ok = (msg) => line(`${paint(32, '✓')} ${msg}`);
export const fail = (msg) => line(`${paint(31, '✗')} ${msg}`);
export const warn = (msg) => line(`${paint(33, '!')} ${msg}`);
export const info = (msg) => line(`  ${msg}`);
export const step = (n, total, msg) => line(`${paint(36, `[${n}/${total}]`)} ${msg}`);

/** Print machine-readable output (always printed, even when quiet). */
export function json(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** Thrown by parseArgs for bad flags. Scripts exit with code 2 on it. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

/**
 * Small argv parser.
 *   spec = {
 *     boolean: ['json', 'help'],       // --json
 *     string:  ['name', 'dir'],        // --name value  or  --name=value
 *     alias:   { h: 'help' },          // -h  -> --help
 *     multiple: ['only'],              // optional: repeated flag collects an array
 *   }
 * Returns { _: [positionals], ...values }. Keys keep the flag spelling
 * (e.g. 'no-open'). Booleans default to false; strings are undefined if absent.
 * Throws UsageError on unknown flags or a missing value. `--` ends flag parsing.
 */
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.boolean ?? []);
  const strings = new Set(spec.string ?? []);
  const multiple = new Set(spec.multiple ?? []);
  const alias = spec.alias ?? {};
  const out = { _: [] };
  for (const b of booleans) out[b] = false;
  for (const m of multiple) out[m] = [];

  const assign = (key, value) => {
    if (multiple.has(key)) out[key].push(value);
    else out[key] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    let name;
    let inline;
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(arg)) {
      name = alias[arg.slice(1)];
      if (!name) throw new UsageError(`Unknown option ${arg}. Try --help.`);
    } else {
      out._.push(arg);
      continue;
    }
    name = alias[name] ?? name;

    if (booleans.has(name)) {
      if (inline !== undefined && !['true', 'false'].includes(inline)) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      out[name] = inline !== 'false';
    } else if (strings.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) {
          throw new UsageError(`--${name} needs a value.`);
        }
        value = next;
        i++;
      }
      assign(name, value);
    } else {
      throw new UsageError(`Unknown option --${name}. Try --help.`);
    }
  }
  return out;
}
