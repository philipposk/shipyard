#!/usr/bin/env node
// Point DeepSeek Harness at the same keys file as Shipyard (~/.shipyard/secrets.env).
import { symlink, mkdir, access, constants } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SECRETS_PATH } from './lib/paths.mjs';
import { isMainModule } from './lib/paths.mjs';
import { ok, info } from './lib/log.mjs';

const HARNESS_DIR = path.join(os.homedir(), '.deepseek-harness');
const HARNESS_FILE = path.join(HARNESS_DIR, 'secrets.env');

async function main() {
  await mkdir(HARNESS_DIR, { recursive: true });
  try {
    await access(SECRETS_PATH, constants.F_OK);
  } catch {
    process.stderr.write(`Create your keys file first: node secrets-init.mjs\n`);
    return 1;
  }
  try {
    await symlink(SECRETS_PATH, HARNESS_FILE);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  ok('Harness now uses the same keys file as Shipyard.');
  info(HARNESS_FILE);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => {
    process.exitCode = c;
  });
}
