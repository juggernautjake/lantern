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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  ['server/test/test-platform.mjs', 'server/test/test-platform.mjs'],
  ['server/test/test-platform2.mjs', 'server/test/test-platform2.mjs'],
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

/* package.json is copied whole, but this repo's scripts reach into folders the
   platform repo does not carry — the course kit and the courses themselves. A
   script that names a file nobody received is worse than no script: it fails
   for the first person who runs `npm test` on a fresh clone. So each script is
   read as a chain of `&&` steps, any step naming a missing file is dropped, and
   a script left with nothing is dropped too. Nothing is renamed by hand here,
   so a script added later is handled without anyone remembering to. */
function pruneScripts(t, quiet) {
  const file = join(t, 'package.json');
  if (!existsSync(file)) return;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const scripts = pkg.scripts || {};
  const dropped = [];

  // Which file does this step run, if any? `npm run x` defers to script x.
  const named = (step) => {
    const run = /(?:^|\s)npm\s+run\s+([A-Za-z0-9:_-]+)/.exec(step);
    if (run) return { script: run[1] };
    const node = /(?:^|\s)node\s+(?:--[^\s]+\s+)*([^\s"']+\.(?:mjs|js|cjs))/.exec(step);
    if (node) return { path: node[1] };
    return {};
  };

  // Resolve repeatedly: dropping test:fs must also drop it from the test chain.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const key of Object.keys(scripts)) {
      const steps = String(scripts[key]).split('&&').map((x) => x.trim()).filter(Boolean);
      const kept = steps.filter((step) => {
        const n = named(step);
        if (n.path) return existsSync(join(t, n.path));
        if (n.script) return Object.prototype.hasOwnProperty.call(scripts, n.script);
        return true;
      });
      if (kept.length !== steps.length) {
        changed = true;
        if (!kept.length) { delete scripts[key]; dropped.push(key); }
        else scripts[key] = kept.join(' && ');
      }
    }
    if (!changed) break;
  }

  pkg.scripts = scripts;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  if (!quiet && dropped.length) console.log('  scripts not shipped (their files are private): ' + dropped.join(', '));
}

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
  pruneScripts(t, o.quiet);
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
