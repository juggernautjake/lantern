#!/usr/bin/env node
/* ===========================================================================
   scripts/update.mjs — install a newer Lantern from GitHub.
   ---------------------------------------------------------------------------
       node scripts/update.mjs            check, show what's new, ask, install
       node scripts/update.mjs --yes      install without asking
       node scripts/update.mjs --pending  install only if one is waiting ("next
                                          time I open Lantern"); used by the
                                          launcher before the program starts

   If Lantern is running, it asks the running copy to update itself (so it
   restarts cleanly). Otherwise it updates the files directly. Either way the
   data folder is backed up first and never touched, and a failed update puts
   everything back. Exit: 0 done or nothing to do, 1 failed.
   =========================================================================== */

import { open, close, run } from '../server/src/db/db.js';
import * as updater from '../server/src/platform/updater.js';
import * as settings from '../server/src/platform/settings.js';
import { paths, version, ensureDataDir } from '../server/src/platform/config.js';
import { readPresence, alive } from '../server/src/platform/eco.js';

const args = process.argv.slice(2);
const pendingOnly = args.includes('--pending');

function log(row) {
  run(`INSERT INTO update_log (channel, subject, from_version, to_version, status, title, notes, message, backup) VALUES (?,?,?,?,?,?,?,?,?)`,
    row.channel, row.subject, row.from_version || null, row.to_version || null, row.status, row.title || '', row.notes || '', row.message || '', row.backup || null);
}

async function ask(q) {
  if (args.includes('--yes')) return true;
  process.stdout.write(q + ' [y/N] ');
  const a = await new Promise((r) => process.stdin.once('data', (d) => r(String(d).trim().toLowerCase())));
  process.stdin.pause();
  return a === 'y' || a === 'yes';
}

async function main() {
  ensureDataDir();
  const db = open(paths.db());
  const mode = settings.get('updates.mode', 'next-launch');
  const waiting = settings.get('updates.pending', null);
  if (pendingOnly && !waiting && mode !== 'next-launch') return 0;
  let info;
  try { info = await updater.check(); }
  catch (e) { if (pendingOnly) return 0; console.error(e.message); return 1; }   // offline: start anyway
  if (info.off) { if (!pendingOnly) console.log('Updates are not set up for this copy.'); return 0; }
  if (!info.available) { settings.set('updates.pending', null); if (!pendingOnly) console.log('Lantern is up to date (' + version() + ').'); return 0; }
  if (!pendingOnly) {
    console.log('\nLantern ' + info.latest + ' is available (you have ' + info.current + ').' + (info.notes ? '\n\nWhat\'s new:\n' + info.notes + '\n' : ''));
    if (!(await ask('Install it now?'))) { console.log('Okay, not now.'); return 0; }
  }
  const p = readPresence('lantern');
  if (p && (await alive(p))) {
    const r = await fetch('http://127.0.0.1:' + p.port + '/api/updates/apply', { method: 'POST', headers: { 'content-type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    console.log(r.ok ? (j.message || 'Updated. Lantern is restarting.') : 'The update did not install: ' + (j.error || r.status));
    return r.ok ? 0 : 1;
  }
  try {
    close();                        // the updater copies the database file itself
    open(paths.db());
    const out = await updater.apply({ info, db: open(paths.db()), log, restart: false });
    settings.set('updates.pending', null);
    console.log(out.updated ? 'Updated from ' + out.from + ' to ' + out.to + '. Your data was backed up first.' : out.message);
    return 0;
  } catch (e) {
    console.error('The update did not install: ' + e.message);
    return 1;
  } finally { void db; }
}

main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
