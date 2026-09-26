/* server/src/platform/settings.js — small named values kept in the database
   (so they live in the data folder and are backed up with everything else). */
import { one, run, json } from '../db/db.js';

export function get(key, fallback) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback === undefined ? null : fallback;
  const v = json(r.value, undefined);
  return v === undefined ? fallback : v;
}

export function set(key, value) {
  if (value === undefined || value === null) { run('DELETE FROM settings WHERE key = ?', key); return null; }
  run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(value));
  return value;
}

export function patch(key, obj) {
  const cur = get(key, {}) || {};
  return set(key, Object.assign({}, cur, obj));
}
