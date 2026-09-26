#!/usr/bin/env node
/* ===========================================================================
   scripts/release.mjs — make dist-out/Lantern.zip from the public export.
   ---------------------------------------------------------------------------
       node scripts/release.mjs [export folder]

   1  exports the public repo (with its privacy scan) — stops if that fails
   2  writes release.json (version, time) into the export: an installed copy
      that has release.json updates itself; a source checkout does not
   3  zips it as dist-out/Lantern.zip — ALWAYS that name, so
      github.com/<owner>/lantern/releases/latest/download/Lantern.zip is
      always the newest
   2b the default hub (optional): a course owner's hub address and PUBLIC key,
      from a private file (LANTERN_RELEASE_HUB, or <data folder>/release-hub.json,
      shaped { url, anonKey }), go into the zip ONLY as config/hub.json, so
      learners who install this release are connected without pasting
      anything. The public repo keeps an empty config/hub.json. A secret or
      service_role key stops the release.
   4  checks the zip: the program is there, nothing private is
   It never uploads anything; it prints the steps to publish.
   Run it from PowerShell or cmd on Windows (Git Bash's tar cannot write zips).
   =========================================================================== */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTo } from './export.mjs';
import { dataDir, secretKey } from '../server/src/platform/config.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const repo = (pkg.lantern && pkg.lantern.updateRepo) || '';

const ex = exportTo(process.argv[2]);
if (!ex.ok) { console.error('\nRelease stopped: the privacy scan failed. Nothing was zipped.'); process.exit(1); }
const target = ex.target;
writeFileSync(join(target, 'release.json'), JSON.stringify({ name: 'Lantern', version: pkg.version, builtAt: new Date().toISOString() }, null, 2));

// the default hub, into the zip only
const hubFile = process.env.LANTERN_RELEASE_HUB || join(dataDir(), 'release-hub.json');
const hubTarget = join(target, 'config', 'hub.json');
const emptyHub = existsSync(hubTarget) ? readFileSync(hubTarget) : null;
let bakedHub = null;
if (existsSync(hubFile)) {
  let h = null;
  try { h = JSON.parse(readFileSync(hubFile, 'utf8')); } catch (e) { console.error('Release stopped: ' + hubFile + ' is not valid JSON.'); process.exit(1); }
  if (!h || !/^https:\/\/\S+$/.test(String(h.url || '')) || String(h.anonKey || '').length < 20) { console.error('Release stopped: ' + hubFile + ' needs { "url": "https://<project>.supabase.co", "anonKey": "<the public key>" }.'); process.exit(1); }
  if (secretKey(h.anonKey)) { console.error('Release stopped: ' + hubFile + ' holds a SECRET key. Only the public (anon or publishable) key may go into a release.'); process.exit(1); }
  mkdirSync(join(target, 'config'), { recursive: true });
  writeFileSync(hubTarget, JSON.stringify(Object.assign({ url: h.url, anonKey: h.anonKey }, h.emailCode === true ? { emailCode: true } : {}), null, 2) + '\n');
  bakedHub = h.url;
}

const out = join(ROOT, 'dist-out');
mkdirSync(out, { recursive: true });
const zip = join(out, 'Lantern.zip');
rmSync(zip, { force: true });
const SKIP = new Set(['.git', 'node_modules', 'data', 'dist-out', '.github']);
const entries = readdirSync(target).filter((e) => !SKIP.has(e));
const tarBin = process.platform === 'win32' ? join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const t = spawnSync(tarBin, ['-a', '-c', '-f', zip, '-C', target, ...entries], { encoding: 'utf8', windowsHide: true });
if (t.status !== 0 || !existsSync(zip)) { console.error('Zipping failed: ' + String(t.stderr || '').trim()); process.exit(1); }
rmSync(join(target, 'release.json'), { force: true });   // the repo itself stays a source checkout
if (bakedHub) { if (emptyHub) writeFileSync(hubTarget, emptyHub); else rmSync(hubTarget, { force: true }); }   // …and keeps an empty hub file

const list = spawnSync(tarBin, ['-t', '-f', zip], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'));
const need = ['package.json', 'release.json', 'server/src/index.js', 'Install Lantern.cmd', 'scripts/install.ps1'];
const missing = need.filter((f) => !list.includes(f));
if (missing.length) { console.error('The zip is missing: ' + missing.join(', ')); process.exit(1); }
if (list.some((f) => /(^|\/)\.env$|\.db$|\.lpack$|^app\/cfml\//.test(f))) { console.error('The zip contains private or course files; stopping.'); process.exit(1); }

console.log(bakedHub ? 'Default hub in the zip: ' + bakedHub + ' (learners are connected without pasting anything).' : 'No default hub in the zip (learners paste the hub address and public key in Settings). To bake one in, put { url, anonKey } in ' + hubFile + '.');
console.log('\nRelease zip: ' + zip + ' (' + (statSync(zip).size / 1024).toFixed(0) + ' KB, ' + list.length + ' files)');
console.log(`
Nothing has been published. To publish Lantern ${pkg.version}:
  1. In ${target}: git add -A, git commit -m "Lantern ${pkg.version}", git push
  2. gh release create v${pkg.version} "${zip}" --title "Lantern ${pkg.version}" --notes-file <what's new>
     (the asset MUST be named Lantern.zip; the release text is what people see under "What's new")
  Installed copies find it within a few hours (${repo || 'set lantern.updateRepo in package.json'}).`);
