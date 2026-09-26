#!/usr/bin/env node
/* ===========================================================================
   scripts/publish-course.mjs — put a course (or a new version of one) on the hub.
   ---------------------------------------------------------------------------
       node scripts/publish-course.mjs <course> [--publish | --draft] [--open] [--listed] [--no-build] [--force]

   1  validates and builds courses/<course> into a pack (scripts/build-pack.mjs)
   2  uploads it to the hub's course-packs storage
   3  registers the course and this version, with the changelog since the
      last published version

   Everyone who already has the course gets the new version on their next sync,
   sees "course updated — what's new", and keeps their progress (lesson ids
   are stable; the validator warns if one disappeared).

   A NEW course starts as a DRAFT (only the owner sees it) unless --publish.
   An existing course keeps its status unless --publish or --draft is given.

   How it signs in, in this order:
     a) through the Lantern app running on this computer, signed in as the
        hub's owner (nothing to set up)
     b) SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in a local .env that is never
        committed and never shipped (for publishing without the app open)
   =========================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build-pack.mjs';
import { readPresence } from '../server/src/platform/eco.js';
import { notesSince } from '../server/src/platform/packs.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function loadEnv() {
  for (const f of [join(ROOT, '.env'), join(ROOT, 'server', '.env')]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

async function viaApp(file, flags) {
  const p = readPresence('lantern');
  if (!p) return null;
  let r;
  try {
    r = await fetch('http://127.0.0.1:' + p.port + '/api/local/publish', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-eco-token': p.token },
      body: JSON.stringify(Object.assign({ file }, flags)), signal: AbortSignal.timeout(10 * 60000),
    });
  } catch (e) { return null; }   // not running
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('The app answered ' + r.status));
  return j;
}

async function viaServiceKey(file, flags) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const buf = readFileSync(file);
  const m = JSON.parse(buf.toString('utf8')).manifest;
  // a legacy service_role key is a JWT and also goes in Authorization; a newer sb_secret_ key goes in apikey only
  const H = Object.assign({ apikey: key, 'content-type': 'application/json' }, /^eyJ/.test(key) ? { authorization: 'Bearer ' + key } : {});
  const rest = async (method, path, body, extra) => {
    const r = await fetch(url + path, { method, headers: Object.assign({}, H, extra || {}), body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const t = await r.text();
    if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + t.slice(0, 300));
    return t ? JSON.parse(t) : null;
  };
  const cur = (await rest('GET', '/rest/v1/courses?id=eq.' + encodeURIComponent(m.id) + '&select=*'))[0] || null;
  const path = m.id + '/' + m.version + '.lpack';
  await rest('POST', '/storage/v1/object/course-packs/' + path, buf, { 'x-upsert': 'true' });
  const status = flags.status || (cur ? cur.status : 'draft');
  await rest('POST', '/rest/v1/courses', [{ id: m.id, title: m.title, description: m.description || '', status,
    visibility: flags.visibility || (cur ? cur.visibility : 'private'), listed: flags.listed !== undefined ? flags.listed : (cur ? cur.listed : false) }],
  { prefer: 'resolution=merge-duplicates' });
  await rest('POST', '/rest/v1/course_versions', [{ course_id: m.id, version: m.version, pack_path: path, size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'), changelog: notesSince(m, cur ? cur.latest_version : null),
    manifest: { id: m.id, title: m.title, version: m.version } }], { prefer: 'resolution=merge-duplicates' });
  await rest('PATCH', '/rest/v1/courses?id=eq.' + encodeURIComponent(m.id), { latest_version: m.version, updated_at: new Date().toISOString() });
  return { id: m.id, version: m.version, status, path, previous: cur ? cur.latest_version : null };
}

export async function publish(id, flags) {
  const f = flags || {};
  let file = join(ROOT, 'dist', 'packs', id + '.lpack');
  if (!f.noBuild) {
    const b = await build(id, { quiet: !!f.quiet });
    if (b.warnings.length && !f.force) throw new Error('Not published: fix the warnings above, or pass --force if you are sure.');
    file = b.file;
  }
  if (!existsSync(file)) throw new Error('There is no built pack at ' + file + '.');
  const opts = { status: f.status, visibility: f.visibility, listed: f.listed, force: !!f.force };
  let out = await viaApp(resolve(file), opts);
  let how = 'through the Lantern app';
  if (!out) { loadEnv(); out = await viaServiceKey(file, opts); how = 'with the service-role key'; }
  if (!out) throw new Error('Could not publish: open Lantern and sign in as the hub owner, or put SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a local .env (never shared).');
  return Object.assign(out, { how });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const id = a.find((x) => !x.startsWith('--'));
  if (!id) { console.error('Usage: node scripts/publish-course.mjs <course> [--publish|--draft] [--open] [--listed] [--no-build] [--force]'); process.exit(2); }
  const flags = { status: a.includes('--publish') ? 'published' : a.includes('--draft') ? 'draft' : undefined,
    visibility: a.includes('--open') ? 'open' : undefined, listed: a.includes('--listed') ? true : undefined,
    noBuild: a.includes('--no-build'), force: a.includes('--force') };
  publish(id, flags).then((r) => {
    console.log('\nPublished ' + r.id + ' ' + r.version + ' (' + r.status + ') ' + r.how + (r.previous ? ', replacing ' + r.previous : '') + '.');
    if (r.status === 'draft') console.log('It is a draft: only you can see it. Publish it with --publish when it is ready.');
  }).catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
