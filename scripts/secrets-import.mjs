#!/usr/bin/env node
// Load KEY=value lines from a local file into ~/.shipyard/secrets.env, then delete the file.
import { readFile, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, setSecret } from './lib/secrets.mjs';
import { SECRETS_PATH } from './lib/paths.mjs';
import { isMainModule } from './lib/paths.mjs';

async function main(argv) {
  const file = argv[0];
  if (!file || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('Usage: secrets-import.mjs <path-to-env-file>\nFile is deleted after a successful import.\n');
    return 2;
  }
  const abs = path.resolve(file);
  const map = parseEnv(await readFile(abs, 'utf8'));
  let n = 0;
  for (const [name, value] of map) {
    if (!value) continue;
    await setSecret(name, value);
    n += 1;
  }
  await unlink(abs);
  if (process.platform !== 'win32') await chmod(SECRETS_PATH, 0o600).catch(() => undefined);
  console.log(`Imported ${n} keys into ${SECRETS_PATH}. Source file deleted.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
  });
}
