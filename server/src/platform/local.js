/* ===========================================================================
   server/src/platform/local.js — the one person this copy of Lantern is for.
   ---------------------------------------------------------------------------
   The app runs for one person per computer. That person is a row in users
   (so the filing system, the grader and progress all work exactly as they do
   for anybody else), created the first time Lantern starts. Their hub account
   (sign-in, course access) is separate and optional; see sync/engine.js.
   =========================================================================== */

import { randomUUID } from 'node:crypto';
import { one, insert, run, id } from '../db/db.js';
import * as settings from './settings.js';

export function userId() {
  const saved = settings.get('local_user_id');
  if (saved && one('SELECT id FROM users WHERE id = ?', saved)) return saved;
  const uid = id('usr');
  insert('users', { id: uid, email: 'me+' + uid.slice(4, 12) + '@this-computer.local', name: 'Learner', role: 'student' });
  settings.set('local_user_id', uid);
  return uid;
}

export function name() {
  const u = one('SELECT name FROM users WHERE id = ?', userId());
  return u ? u.name : 'Learner';
}

export function setName(n) {
  const v = String(n || '').trim().slice(0, 80);
  if (v) run('UPDATE users SET name = ? WHERE id = ?', v, userId());
  return name();
}

/* A stable id for this computer's copy, so the hub can tell two computers
   belonging to one person apart. */
export function deviceId() {
  let d = settings.get('device_id');
  if (!d) d = settings.set('device_id', randomUUID());
  return d;
}
