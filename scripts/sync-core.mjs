#!/usr/bin/env node
/* ===========================================================================
   scripts/sync-core.mjs — copy ecosystem-core into vendor/ecosystem-core.
   ---------------------------------------------------------------------------
       node scripts/sync-core.mjs [path to ecosystem-core]

   ecosystem-core is the package Lantern and Dayspring share: the AI
   providers, voices, web lookup, the shared AI key, the local app bus and
   the shared look (tokens, sound panel, the lantern avatar). Each app keeps
   its OWN copy (vendored, not linked), so a release zip carries it and the
   two apps can update on their own schedules.

   Copies lib/, client/, shared/, docs/, package.json, README.md and LICENSE
   (not the tests, the demo or its scripts), replacing what was there, and
   records the version and the time in vendor/ecosystem-core/VENDORED.json.
   The source defaults to ../ecosystem-core next to this project, or
   ECOSYSTEM_CORE.
   =========================================================================== */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DEST = join(ROOT, 'vendor', 'ecosystem-core');
const PARTS = ['lib', 'client', 'shared', 'docs', 'package.json', 'README.md', 'LICENSE'];

export function sync(from) {
  const src = resolve(from || process.env.ECOSYSTEM_CORE || join(ROOT, '..', 'ecosystem-core'));
  if (!existsSync(join(src, 'package.json'))) throw new Error('ecosystem-core was not found at ' + src + ' (pass its folder, or set ECOSYSTEM_CORE).');
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  if (pkg.name !== 'ecosystem-core') throw new Error(src + ' is not ecosystem-core (its package.json says "' + pkg.name + '").');
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const p of PARTS) if (existsSync(join(src, p))) cpSync(join(src, p), join(DEST, p), { recursive: true });
  const info = { name: pkg.name, version: pkg.version, syncedAt: new Date().toISOString(), note: 'Copied by scripts/sync-core.mjs. Edit ecosystem-core itself, then sync again.' };
  writeFileSync(join(DEST, 'VENDORED.json'), JSON.stringify(info, null, 2) + '\n');
  return info;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const i = sync(process.argv[2]); console.log('vendor/ecosystem-core is now ' + i.name + ' ' + i.version); }
  catch (e) { console.error(e.message); process.exit(1); }
}
