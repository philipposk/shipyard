#!/usr/bin/env node
// Use a DESIGN.md from the free awesome-design-md collection (getdesign.md) as the starting point for a look.
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runCli, isMain, ProvisionError, resolveAppDir, readAppConfig, atomicWrite } from './provision/common.mjs';
import * as log from './lib/log.mjs';
import { listNames, downloadByName, downloadByUrl, suggestNames, DesignMdError, LICENCE_LINE, MAX_BYTES, REPO } from './design/designmd/fetch.mjs';
import { missingGitignore } from './design/gitignore.mjs';
import { stripHeader } from './design/designmd/parse.mjs';
import { draftFromDesignMd } from './design/designmd/draft.mjs';

const HELP = `
Start a look from a DESIGN.md file in the free awesome-design-md collection (getdesign.md, MIT licence).
Only the style is used: colours, fonts, corner size and layout feel. Never logos, images, icons or text.

Usage:
  node design-from-designmd.mjs --list
  node design-from-designmd.mjs --name <name> --app <app-folder> [--json]
  node design-from-designmd.mjs --file <path> --app <app-folder> [--json]
  node design-from-designmd.mjs --url <https link to a DESIGN.md on GitHub> --app <app-folder> [--json]

  --list   show the names you can use with --name
  --name   download that DESIGN.md from GitHub (public, no account)
  --file   use a DESIGN.md already on your computer
  --url    download from raw.githubusercontent.com or a github.com file link (https only)

Saves the file to <app>/design-input/<name>.DESIGN.md and a draft look to
<app>/.shipyard/design/designmd-draft.tokens.json. Review the draft, then apply it:
  node apply-design.mjs <app-folder> --tokens <draft> --source design-md --fix
Exit code: 0 done, 1 could not do it, 2 wrong options.
`;

const DRAFT_REL = path.join('.shipyard', 'design', 'designmd-draft.tokens.json');
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'design';

export function headerFor({ source, github }) {
  return `<!-- Imported by Shipyard.
Source: ${source}
${github ? `${LICENCE_LINE}.` : 'Check the licence of this file before sharing it.'}
Style reference only: no brand assets (logos, images, icons, text) were taken or may be used. -->
`;
}

async function readLocal(file) {
  const abs = path.resolve(file);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new ProvisionError(`I cannot find the file ${abs}.`);
  }
  if (!info.isFile()) throw new ProvisionError(`${abs} is not a file.`);
  if (info.size > MAX_BYTES) throw new ProvisionError('That file is too big to be a DESIGN.md (over 200 KB).');
  const text = await readFile(abs, 'utf8');
  if (text.includes('\0')) throw new ProvisionError('That file is not text, so it cannot be a DESIGN.md.');
  const base = path.basename(abs).replace(/\.(design\.)?md$/i, '').replace(/^design$/i, '') || path.basename(path.dirname(abs));
  return { text, abs, name: safeName(base) };
}

/**
 * importDesignMd({ appDir, name | file | url, fetchImpl }) -> result object (also what --json prints).
 * Pure enough for tests: the only network use goes through `fetchImpl`.
 */
export async function importDesignMd({ appDir, name, file, url, fetchImpl }) {
  const config = await readAppConfig(appDir);
  let got;
  try {
    if (name) got = await downloadByName(name, { fetchImpl });
    else if (url) got = await downloadByUrl(url, { fetchImpl });
    else got = await readLocal(file);
  } catch (err) {
    if (!(err instanceof DesignMdError)) throw err;
    let hint = '';
    if (err.notFound && name) {
      try {
        const close = suggestNames(name, (await listNames({ fetchImpl })).names);
        if (close.length > 0) hint = ` Did you mean: ${close.join(', ')}?`;
      } catch { /* the list is only a nicety */ }
    }
    throw new ProvisionError(`${err.message}${hint}`);
  }
  const text = stripHeader(got.text);
  const fileName = safeName(got.name ?? (got.url ? path.basename(path.dirname(new URL(got.url).pathname)) : 'design'));
  const languages = Array.isArray(config.languages) && config.languages.length > 0 ? config.languages : ['en'];
  const draft = draftFromDesignMd(text, { languages });
  if (!draft.tokens) throw new ProvisionError(draft.errors[0]);

  const inputDir = path.join(appDir, 'design-input');
  await mkdir(inputDir, { recursive: true });
  const saved = path.join(inputDir, `${fileName}.DESIGN.md`);
  const source = got.url ?? got.abs;
  const github = Boolean(got.url) && got.url.startsWith(`https://raw.githubusercontent.com/${REPO}/`);
  const sameFile = got.abs && path.resolve(got.abs) === path.resolve(saved);
  if (!sameFile) await atomicWrite(saved, `${headerFor({ source, github })}\n${text}`);

  const draftPath = path.join(appDir, DRAFT_REL);
  await mkdir(path.dirname(draftPath), { recursive: true });
  await atomicWrite(draftPath, `${JSON.stringify(draft.tokens, null, 2)}\n`);
  const blocked = draft.errors.length > 0;
  return {
    ok: !blocked,
    ...(blocked ? { error: `The draft still has problems: ${draft.errors.join(' ')}` } : {}),
    name: fileName,
    source,
    saved: sameFile ? got.abs : saved,
    draft: draftPath,
    summary: draft.summary,
    changes: draft.changes,
    warnings: draft.warnings,
    errors: draft.errors,
    guessed: draft.guessed,
    tokensId: draft.tokens.id,
    gitignoreWarning: await missingGitignore(appDir, ['design-input']),
    next: `Review the draft, then apply it: node apply-design.mjs "${appDir}" --tokens "${draftPath}" --source design-md --fix`,
  };
}

export async function main(args) {
  const modes = ['list', 'name', 'file', 'url'].filter((k) => args[k]);
  if (modes.length !== 1) throw new log.UsageError('Choose exactly one of --list, --name <name>, --file <path> or --url <link>. Try --help.');
  if (args.list) {
    let r;
    try {
      r = await listNames({});
    } catch (err) {
      if (err instanceof DesignMdError) throw new ProvisionError(err.message);
      throw err;
    }
    log.ok(`${r.names.length} designs in ${REPO}:`);
    log.info(r.names.join(', '));
    log.info('Use one with: --name <name> --app <app-folder>');
    return { ok: true, mode: 'list', source: r.source, count: r.names.length, names: r.names };
  }
  if (!args.app) throw new log.UsageError('Say which app with --app <app-folder>.');
  const appDir = await resolveAppDir(args.app);
  const r = await importDesignMd({ appDir, name: args.name, file: args.file, url: args.url });
  if (!r.ok) log.fail(r.error);
  else log.ok(`Saved the file to ${r.saved}`);
  log.ok(`Draft look written to ${r.draft}`);
  for (const line of r.summary) log.info(line);
  for (const c of r.changes) log.info(`Fixed: ${c}.`);
  for (const w of r.warnings) log.warn(w);
  if (r.gitignoreWarning) log.warn(r.gitignoreWarning);
  if (r.guessed.length > 0) log.info(`Not in the file, so I guessed: ${r.guessed.join(', ')}.`);
  log.info('Only colours, fonts, corner size and layout feel were taken, never logos, images or text.');
  log.info(r.next);
  return { mode: name(args), ...r };
}

const name = (args) => ['name', 'file', 'url'].find((k) => args[k]);

if (isMain(import.meta.url)) {
  await runCli({ argv: process.argv.slice(2), spec: { string: ['name', 'file', 'url', 'app'], boolean: ['list'] }, help: HELP, main });
}
