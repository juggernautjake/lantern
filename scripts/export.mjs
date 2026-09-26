#!/usr/bin/env node
/* ===========================================================================
   scripts/export.mjs — build the PUBLIC Lantern repo from this private one.
   ---------------------------------------------------------------------------
       node scripts/export.mjs [target]     (default: ../lantern-app)

   The public repo holds the PLATFORM only: the app, the hub's SQL, the tools
   for making and publishing courses, a template course, and the docs.
   Course content, the private plans, the catalogue, data, keys and builds
   never go. It is an ALLOW-list: only what is named below is copied.

   Then the privacy scan runs on the result; if it finds anything, the export
   fails (exit 1) and the files are left for you to look at. The target's
   .git, node_modules and data are kept between exports.
   =========================================================================== */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TARGET, report, scan } from './privacy-scan.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/* [from (in this repo), to (in the public repo)] — files or whole folders */
export const ALLOW = [
  ['package.json', 'package.json'],
  ['server/src', 'server/src'],
  ['server/public', 'server/public'],
  ['server/.env.example', 'server/.env.example'],
  ['server/README.md', 'server/README.md'],
  ['server/test/test-foundation.mjs', 'server/test/test-foundation.mjs'],
  ['server/test/test-ecosystem.mjs', 'server/test/test-ecosystem.mjs'],
  ['server/test/e2e-offer-flow.mjs', 'server/test/e2e-offer-flow.mjs'],
  ['server/test/test-friends.mjs', 'server/test/test-friends.mjs'],
  ['server/test/e2e-friends.mjs', 'server/test/e2e-friends.mjs'],
  ['server/test/e2e-signin-link.mjs', 'server/test/e2e-signin-link.mjs'],
  ['server/test/fake-hub.mjs', 'server/test/fake-hub.mjs'],
  ['server/test/helpers.mjs', 'server/test/helpers.mjs'],
  ['app/theme', 'app/theme'],
  ['vendor/ecosystem-core', 'vendor/ecosystem-core'],   // the shared package (copied in by scripts/sync-core.mjs)
  ['config', 'config'],                                   // config/hub.json: the default hub (public values only)
  ['scripts/sync-core.mjs', 'scripts/sync-core.mjs'],
  ['courses/_template', 'courses/_template'],
  ['supabase', 'supabase'],
  ['scripts/build-pack.mjs', 'scripts/build-pack.mjs'],
  ['scripts/publish-course.mjs', 'scripts/publish-course.mjs'],
  ['scripts/build-hub-sql.mjs', 'scripts/build-hub-sql.mjs'],
  ['scripts/launch.mjs', 'scripts/launch.mjs'],
  ['scripts/launch-hidden.vbs', 'scripts/launch-hidden.vbs'],
  ['scripts/update.mjs', 'scripts/update.mjs'],
  ['scripts/install.ps1', 'scripts/install.ps1'],
  ['scripts/export.mjs', 'scripts/export.mjs'],
  ['scripts/release.mjs', 'scripts/release.mjs'],
  ['scripts/privacy-scan.mjs', 'scripts/privacy-scan.mjs'],
  ['docs/public', 'docs'],
  ['docs/dev', 'docs/dev'],
  ['repo', '.'],             // README, LICENSE, launchers, icon, .gitignore, .github
];
/* never, even inside an allowed folder */
const NEVER = [/(^|[\\/])\.env$/, /(^|[\\/])data([\\/]|$)/, /\.db(-wal|-shm)?$/, /(^|[\\/])_probe\./, /\.lpack$/, /(^|[\\/])node_modules([\\/]|$)/, /\.log$/];
const KEEP_TARGET = new Set(['.git', 'node_modules', 'data', 'dist-out']);

export function exportTo(target, opts) {
  const o = opts || {};
  const t = resolve(target || DEFAULT_TARGET);
  if (t === ROOT || t.startsWith(ROOT + sep)) throw new Error('The export cannot go inside this project.');
  mkdirSync(t, { recursive: true });
  for (const e of readdirSync(t)) if (!KEEP_TARGET.has(e)) rmSync(join(t, e), { recursive: true, force: true });
  let n = 0;
  const filter = (src) => { const rel = relative(ROOT, src); if (NEVER.some((r) => r.test(rel))) return false; return true; };
  for (const [from, to] of ALLOW) {
    const src = join(ROOT, from);
    if (!existsSync(src)) { if (!o.quiet) console.warn('  (missing, skipped) ' + from); continue; }
    cpSync(src, join(t, to), { recursive: true, filter: (s) => { const ok = filter(s); return ok; } });
  }
  mkdirSync(join(t, 'dist', 'packs'), { recursive: true });
  writeFileSync(join(t, 'dist', 'packs', '.gitkeep'), '');
  const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (KEEP_TARGET.has(e.name) ? 0 : e.isDirectory() ? count(join(d, e.name)) : 1), 0);
  n = count(t);
  if (!o.quiet) console.log('Exported ' + n + ' files to ' + t);
  const result = scan(t, { termsFile: o.termsFile });
  const ok = report(result, t);
  return { target: t, files: n, ok, hits: result.hits };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = exportTo(process.argv[2]);
  if (!r.ok) { console.log('\nNothing was published. Fix these in the source and export again.'); process.exit(1); }
}
