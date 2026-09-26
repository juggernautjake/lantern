/* ===========================================================================
   server/src/db/db.js — the database handle.
   ---------------------------------------------------------------------------
   node:sqlite, no dependencies. The schema is applied on every open; every
   statement in it is idempotent, so opening an existing database is a no-op
   and opening a new one creates it.

   Everything above this file talks in plain objects. Nothing above this file
   writes SQL except the repositories in files/ and ai/.
   =========================================================================== */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { migrate } from './migrations.js';
import { paths } from '../platform/config.js';
import { backupDb, list as listBackups } from '../platform/backups.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let db = null;
let dbPath = null;

export function open(file) {
  if (db) return db;
  const path = file || paths.db();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  try {
    db = new DatabaseSync(path);
    db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
    if (path !== ':memory:') { const ok = db.prepare('PRAGMA quick_check').get(); if (ok && Object.values(ok)[0] !== 'ok') throw Object.assign(new Error('quick_check: ' + Object.values(ok)[0]), { code: 'ERR_SQLITE_CORRUPT' }); }
  } catch (e) {
    if (path === ':memory:' || !damaged(e)) throw e;
    try { if (db) db.close(); } catch (x) { /* already */ }
    db = null;
    recovered = recover(path, e);
    db = new DatabaseSync(path);
    db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  }
  dbPath = path;
  // Numbered changes since the baseline. A database that already holds
  // somebody's work is backed up, whole, before the first one runs.
  migrate(db, { before: (pending) => {
    if (path !== ':memory:') backupDb(db, 'before-migration-' + pending[0].version, { dir: join(dirname(path), 'backups') });
  } });
  return db;
}

/* What happened at the last start, for the app to tell the person once:
   { from: <backup file or null>, aside: <where the damaged file was put> } */
let recovered = null;
export const recoveredFrom = () => recovered;

const damaged = (e) => /SQLITE_(CORRUPT|NOTADB)|ERR_SQLITE_CORRUPT|file is not a database|malformed|quick_check/i.test(String(e.code || '') + ' ' + String(e.errcode || '') + ' ' + String(e.message || ''));

function recover(path, why) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const aside = path + '.damaged-' + stamp;
  for (const ext of ['', '-wal', '-shm']) if (existsSync(path + ext)) { try { renameSync(path + ext, aside + ext); } catch (x) { /* in use: leave it */ } }
  const newest = listBackups(join(dirname(path), 'backups'))[0] || null;
  if (newest) copyFileSync(newest.file, path);
  console.error('[lantern] The database could not be read (' + (why.message || why) + '). It was kept as ' + aside + (newest ? ' and Lantern carried on from the backup ' + newest.name : ' and Lantern started a fresh one') + '. Progress on the hub comes back when you sign in.');
  return { from: newest ? newest.name : null, aside };
}

export function handle() {
  return db || open();
}

export function close() {
  if (db) { db.close(); db = null; dbPath = null; }
}

/* The file this process has open (':memory:' in tests). */
export const file = () => dbPath;

/* --------------------------------------------------------------- helpers --- */

export const id = (prefix) => (prefix ? prefix + '_' : '') + randomUUID().replace(/-/g, '').slice(0, 20);
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* One row, or undefined. */
export function one(sql, ...params) {
  return handle().prepare(sql).get(...params);
}

/* Every row. */
export function all(sql, ...params) {
  return handle().prepare(sql).all(...params);
}

/* An insert, update or delete. Returns { changes, lastInsertRowid }. */
export function run(sql, ...params) {
  return handle().prepare(sql).run(...params);
}

/* Run fn inside a transaction. Nested calls join the outer one, because the
   only thing worse than no transaction is two that disagree. */
let depth = 0;
export function tx(fn) {
  const h = handle();
  if (depth++) { try { return fn(); } finally { depth--; } }
  h.exec('BEGIN');
  try {
    const out = fn();
    h.exec('COMMIT');
    return out;
  } catch (e) {
    try { h.exec('ROLLBACK'); } catch (_) { /* the rollback of a failed begin */ }
    throw e;
  } finally { depth--; }
}

/* Insert an object as a row. Keys are column names; nothing is interpolated. */
export function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = 'INSERT INTO ' + table + ' (' + keys.join(',') + ') VALUES (' +
    keys.map(() => '?').join(',') + ')';
  run(sql, ...keys.map((k) => norm(obj[k])));
  return obj;
}

export function update(table, idValue, obj, idColumn) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return 0;
  const sql = 'UPDATE ' + table + ' SET ' + keys.map((k) => k + '=?').join(',') +
    ' WHERE ' + (idColumn || 'id') + '=?';
  return run(sql, ...keys.map((k) => norm(obj[k])), idValue).changes;
}

/* SQLite takes numbers, strings, null and buffers. Booleans and objects are
   normalised here rather than at forty call sites. */
function norm(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export const json = (s, fallback) => {
  if (s === null || s === undefined || s === '') return fallback === undefined ? null : fallback;
  try { return JSON.parse(s); } catch (e) { return fallback === undefined ? null : fallback; }
};

/* ------------------------------------------------------------ passwords --- */
/* scrypt from node:crypto. No dependency, and the parameters are the ones the
   Node docs recommend rather than the ones that make the tests fast. */

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  const got = scryptSync(String(plain), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
