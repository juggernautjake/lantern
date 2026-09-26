/* ===========================================================================
   server/src/platform/backups.js — copies of the database, taken before
   anything that could hurt it.
   ---------------------------------------------------------------------------
   Taken automatically before every update and every migration, and whenever
   the person asks. A backup is a complete, consistent SQLite file made with
   VACUUM INTO, so it can be opened on its own. The newest KEEP of each kind
   are kept; older ones are removed.

     <data>/backups/lantern-2026-09-25T14-03-11-before-update-0.2.0.db
   =========================================================================== */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';

export const KEEP = Number(process.env.LANTERN_BACKUPS_KEEP || 10);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = (s) => String(s || 'manual').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'manual';

/* db: a node:sqlite DatabaseSync. Returns the backup's full path, or null for
   an in-memory database. */
export function backupDb(db, reason, opts) {
  const o = opts || {};
  const dir = o.dir || paths.backups();
  if (!db || o.file === ':memory:') return null;
  mkdirSync(dir, { recursive: true });
  let file = join(dir, 'lantern-' + stamp() + '-' + slug(reason) + '.db');
  for (let i = 2; existsSync(file); i++) file = file.replace(/(-\d+)?\.db$/, '-' + i + '.db');
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  rotate(dir, o.keep || KEEP);
  return file;
}

/* A copy of the database file itself, for when there is no open handle (the
   updater, before the server is started). WAL files are copied too. */
export function backupDbFile(dbFile, reason, opts) {
  const o = opts || {};
  if (!dbFile || !existsSync(dbFile)) return null;
  const dir = o.dir || paths.backups();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lantern-' + stamp() + '-' + slug(reason) + '.db');
  copyFileSync(dbFile, file);
  for (const ext of ['-wal', '-shm']) if (existsSync(dbFile + ext)) copyFileSync(dbFile + ext, file + ext);
  rotate(dir, o.keep || KEEP);
  return file;
}

export function list(dir) {
  const d = dir || paths.backups();
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^lantern-.*\.db$/.test(f))
    .map((f) => { const st = statSync(join(d, f)); return { name: f, file: join(d, f), size: st.size, at: st.mtime.toISOString() }; })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/* Keep the newest `keep` database backups. Program backups (folders named
   program-*) are rotated separately by the updater. */
export function rotate(dir, keep) {
  const all = list(dir);
  for (const b of all.slice(keep)) {
    for (const ext of ['', '-wal', '-shm']) rmSync(b.file + ext, { force: true });
  }
}
