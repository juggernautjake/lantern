/* ===========================================================================
   server/src/platform/updater.js — new versions of Lantern, from GitHub.
   ---------------------------------------------------------------------------
   Releases are published at github.com/<lantern.updateRepo>/releases with ONE
   zip asset named Lantern.zip (so .../releases/latest/download/Lantern.zip is
   always the newest). The release text is the "What's new".

   check()  asks GitHub for the latest release; remembers what it found.
   apply()  installs it, carefully:

     1  download Lantern.zip into <data>/updates, unpack it into a staging
        folder INSIDE the program folder (so moving it into place is a rename
        on one disk, not a copy)
     2  make sure it is Lantern, is newer, and actually starts: the new code is
        run once with --selftest before anything is changed
     3  back up the database (a whole copy) and the current program files
     4  swap: each top-level entry of the old program is renamed aside and the
        new one renamed into place; data, keys and anything local never move
     5  run the self-test again, in place; if it fails — or anything above
        fails — every entry is put back exactly as it was ("rolled back")
     6  write the update log (what's new, from → to, the backups) and restart

   When: the person chooses in Settings → Updates:
     ask          show "Update available" and wait for them
     next-launch  install it the next time Lantern starts (Start Lantern.cmd
                  runs scripts/update.mjs --pending before the server starts)
     idle         install it in the background once Lantern has not been used
                  for a while, then reload the page
   The banner also offers "Update now" and "Next time I open Lantern" whatever
   the setting is.

   LANTERN_UPDATE_API overrides the GitHub API address (tests use a fake).
   =========================================================================== */

import { spawnSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, version as currentVersion, updateRepo, paths } from './config.js';
import { cmp } from './semver.js';
import { backupDb, backupDbFile } from './backups.js';
import * as bus from './bus.js';

export const ASSET = 'Lantern.zip';
/* Never replaced, never removed, never shipped in a release. */
export const KEEP = ['.git', '.env', 'data', 'node_modules', 'backups', 'dist-out', '.lantern-staging', '.lantern-old', 'server/.env', 'server/data'];
const MODES = ['ask', 'next-launch', 'idle'];

let state = { phase: 'idle', message: '', latest: null, error: null, checkedAt: null };
const set = (p) => { state = Object.assign({}, state, p); return state; };
export const status = () => Object.assign({}, state, { version: currentVersion(), repo: updateRepo() || null });

const api = (o) => String((o && o.api) || process.env.LANTERN_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');

/* ---------------------------------------------------------------- check --- */

export async function check(opts) {
  const o = opts || {};
  const repo = o.repo || updateRepo();
  if (!repo) { set({ phase: 'idle', message: 'Updates are not set up for this copy.', latest: null }); return { off: true }; }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('"' + repo + '" is not an update address (it should look like name/lantern).');
  set({ phase: 'checking', message: 'Checking for updates…', error: null });
  try {
    const r = await fetch(api(o) + '/repos/' + repo + '/releases/latest',
      { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Lantern-updater' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw new Error('No Lantern releases were found at ' + repo + '.');
    if (r.status === 403) throw new Error('GitHub is limiting requests right now. Lantern will try again later.');
    if (!r.ok) throw new Error('GitHub answered ' + r.status + '.');
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = (rel.assets || []).find((a) => a.name === ASSET) || (rel.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
    const cur = o.current || currentVersion();
    const info = {
      available: !!latest && cmp(latest, cur) > 0, current: cur, latest, title: rel.name || ('Lantern ' + latest),
      notes: String(rel.body || '').slice(0, 20000), url: rel.html_url || null,
      zip: asset ? asset.browser_download_url : null, size: asset ? asset.size : null, published: rel.published_at || null,
    };
    set({ phase: 'idle', latest: info.available ? info : null, checkedAt: new Date().toISOString(),
      message: info.available ? 'Lantern ' + latest + ' is available (you have ' + cur + ').' : 'Lantern is up to date (' + cur + ').' });
    if (info.available) bus.emit('update', { phase: 'available', latest: info });
    return info;
  } catch (e) {
    set({ phase: 'error', error: e.message, message: e.message });
    throw e;
  }
}

/* ---------------------------------------------------------------- apply --- */

/* opts: { root, dataDir, api, repo, current, db (an open node:sqlite handle),
   dbFile, log(row), restart(), selftest(dir) } — all optional; tests pass them. */
export async function apply(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  if (state.phase === 'applying') throw new Error('An update is already being installed.');
  if (!existsSync(join(root, 'release.json')) && !o.allowSource) {
    throw new Error('This is a development copy of Lantern (it has no release.json), so it does not update itself.');
  }
  const info = o.info || await check(o);
  if (info.off) throw new Error('Updates are not set up for this copy.');
  if (!info.available) return { updated: false, message: state.message };
  if (!info.zip) throw new Error('That release has no ' + ASSET + ' attached.');

  const dataDir = o.dataDir || paths.updates().replace(/[\\/]updates$/, '');
  const updatesDir = join(dataDir, 'updates');
  const backupsDir = join(dataDir, 'backups');
  const staging = join(root, '.lantern-staging');
  const aside = join(root, '.lantern-old');
  const from = info.current;
  const log = o.log || (() => {});
  const moved = [];      // entries renamed aside: [name]
  const placed = [];     // entries renamed into place: [name]
  let programBackup = null, dbBackup = null;
  set({ phase: 'applying', message: 'Downloading Lantern ' + info.latest + '…', error: null });
  bus.emit('update', { phase: 'applying', latest: info });

  try {
    // 1 download and unpack
    mkdirSync(updatesDir, { recursive: true });
    const zip = join(updatesDir, 'Lantern-' + info.latest + '.zip');
    const r = await fetch(info.zip, { headers: { 'user-agent': 'Lantern-updater', accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
    if (!r.ok) throw new Error('The download failed (' + r.status + ').');
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    // Windows' own tar (bsdtar) reads zips; another tar earlier on the PATH may not.
    const tarBin = process.platform === 'win32' ? join(process.env.WINDIR || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const t = spawnSync(tarBin, ['-xf', zip, '-C', staging], { windowsHide: true, encoding: 'utf8' });
    if (t.status !== 0) throw new Error('The download could not be unpacked: ' + String(t.stderr || '').trim().slice(0, 200));
    const newRoot = findRoot(staging);
    if (!newRoot) throw new Error('That download does not look like Lantern. Nothing was changed.');
    const newVer = JSON.parse(readFileSync(join(newRoot, 'package.json'), 'utf8')).version;
    if (cmp(newVer, from) <= 0) throw new Error('That download is Lantern ' + newVer + ', which is not newer than ' + from + '. Nothing was changed.');
    for (const k of KEEP) rmSync(join(newRoot, k), { recursive: true, force: true });

    // 2 does it start?
    set({ message: 'Checking Lantern ' + newVer + ' before installing it…' });
    const pre = (o.selftest || selftest)(newRoot);
    if (!pre.ok) throw new Error('Lantern ' + newVer + ' did not pass its start-up check, so it was not installed: ' + pre.error);

    // 3 back up
    set({ message: 'Backing up your data and this version…' });
    if (o.db) dbBackup = backupDb(o.db, 'before-update-' + newVer, { dir: backupsDir });
    else if (o.dbFile) dbBackup = backupDbFile(o.dbFile, 'before-update-' + newVer, { dir: backupsDir });
    programBackup = join(backupsDir, 'program-' + from + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    mkdirSync(programBackup, { recursive: true });
    for (const e of topLevel(root)) cpSync(join(root, e), join(programBackup, e), { recursive: true });
    rotatePrograms(backupsDir, 3);

    // 4 swap
    set({ message: 'Installing Lantern ' + newVer + '…' });
    rmSync(aside, { recursive: true, force: true });
    mkdirSync(aside, { recursive: true });
    const incoming = new Set(readdirSync(newRoot).filter((e) => KEEP.indexOf(e) < 0));
    for (const e of topLevel(root)) { renameRetry(join(root, e), join(aside, e)); moved.push(e); }
    for (const e of incoming) { renameRetry(join(newRoot, e), join(root, e)); placed.push(e); }
    // nested things that are the person's, not the program's
    for (const k of KEEP.filter((x) => x.includes('/'))) {
      const oldAt = join(aside, k), newAt = join(root, k);
      if (existsSync(oldAt) && !existsSync(newAt)) { mkdirSync(join(newAt, '..'), { recursive: true }); renameRetry(oldAt, newAt); }
    }
    if (o.failAfterSwap) throw new Error(o.failAfterSwap);

    // 5 does it start, in place?
    const post = (o.selftest || selftest)(root);
    if (!post.ok) throw new Error('Lantern ' + newVer + ' did not start after installing: ' + post.error);

    rmSync(aside, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    const row = { channel: 'platform', subject: 'lantern', from_version: from, to_version: newVer, status: 'installed',
      title: info.title || ('Lantern ' + newVer), notes: info.notes || '', message: 'Updated from ' + from + ' to ' + newVer + '.', backup: programBackup };
    log(row);
    set({ phase: 'restarting', message: 'Updated to ' + newVer + '. Restarting…', latest: null });
    bus.emit('update', { phase: 'installed', to: newVer });
    if (o.restart !== false) setTimeout(() => (o.restart || restart)(root), 800);
    return { updated: true, from, to: newVer, backup: programBackup, dbBackup };
  } catch (e) {
    // put everything back exactly as it was
    let rolledBack = false;
    if (moved.length || placed.length) {
      // FIRST take the person's own things (server/data, server/.env) back out
      // of the new program folders, or removing those folders would take them too.
      for (const k of KEEP.filter((x) => x.includes('/'))) {
        const nowAt = join(root, k), oldAt = join(aside, k);
        if (existsSync(nowAt) && !existsSync(oldAt) && existsSync(join(aside, k.split('/')[0]))) { try { renameRetry(nowAt, oldAt); } catch (x) { /* keep going */ } }
      }
      for (const e2 of placed) rmSync(join(root, e2), { recursive: true, force: true });
      for (const e2 of moved) { try { renameRetry(join(aside, e2), join(root, e2)); } catch (x) { /* see below */ } }
      for (const k of KEEP.filter((x) => x.includes('/'))) {
        const oldAt = join(aside, k), backAt = join(root, k);
        if (existsSync(oldAt) && !existsSync(backAt)) { try { renameRetry(oldAt, backAt); } catch (x) { /* keep going */ } }
      }
      const intact = moved.every((m) => existsSync(join(root, m)));
      if (!intact && programBackup) for (const m of moved) if (!existsSync(join(root, m))) cpSync(join(programBackup, m), join(root, m), { recursive: true });
      rolledBack = true;
      rmSync(aside, { recursive: true, force: true });
    }
    rmSync(staging, { recursive: true, force: true });
    log({ channel: 'platform', subject: 'lantern', from_version: from, to_version: info.latest,
      status: rolledBack ? 'rolled-back' : 'failed', title: 'Lantern ' + info.latest,
      notes: '', message: e.message + (rolledBack ? ' Everything was put back as it was; nothing of yours was touched.' : ' Nothing was changed.'), backup: programBackup });
    set({ phase: 'error', error: e.message, message: e.message });
    bus.emit('update', { phase: 'failed', error: e.message, rolledBack });
    throw Object.assign(e, { rolledBack });
  }
}

function topLevel(root) {
  return readdirSync(root).filter((e) => KEEP.indexOf(e) < 0);
}

function findRoot(dir, depth) {
  const d = depth || 0;
  if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'server', 'src', 'index.js'))) return dir;
  if (d > 2) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { const r = findRoot(join(dir, e.name), d + 1); if (r) return r; }
  }
  return null;
}

function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { renameSync(a, b); return; }
    catch (e) {
      if (i >= 40 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function rotatePrograms(dir, keep) {
  if (!existsSync(dir)) return;
  const list = readdirSync(dir).filter((d) => d.startsWith('program-'))
    .map((d) => ({ d, t: statSync(join(dir, d)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of list.slice(keep)) rmSync(join(dir, x.d), { recursive: true, force: true });
}

/* Run a copy of Lantern's own start-up check: it loads every module, opens a
   throwaway database with every migration, and exits. */
export function selftest(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'server', 'src', 'index.js'), '--selftest'],
    { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 90000, env: Object.assign({}, process.env, { LANTERN_DB: ':memory:', LANTERN_SELFTEST: '1' }) });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ') || 'exit ' + r.status).slice(0, 400) };
}

/* Start the new version in place of this one. */
export function restart(root) {
  const child = spawn(process.execPath, [join(root || ROOT, 'server', 'src', 'index.js')], {
    cwd: root || ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { LANTERN_RESTARTED: '1', LANTERN_NO_BROWSER: '1', LANTERN_OPEN: '' }),
  });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

/* ------------------------------------------------------------- settings --- */

/* ecosystem-core calls "next time I open it" 'launch'; both names are accepted. */
export function normalizeMode(m) { if (m === 'launch') return 'next-launch'; return MODES.indexOf(m) >= 0 ? m : 'next-launch'; }
export { MODES };

/* The background loop. getMode() → 'ask'|'next-launch'|'idle'; idleFor() →
   ms since the person last did anything; onApply() installs. */
let timer = null;
export function startLoop({ getMode, idleFor, onAvailable, onApply, everyMs, idleMs }) {
  if (timer || !updateRepo()) return;
  const every = everyMs || 6 * 3600000;
  const idleNeed = idleMs || 20 * 60000;
  let lastCheck = 0;
  const loop = async () => {
    try {
      if (Date.now() - lastCheck > every) {
        lastCheck = Date.now();
        const info = await check();
        if (info && info.available && onAvailable) onAvailable(info);
      }
      if (state.latest && getMode() === 'idle' && idleFor() > idleNeed) await onApply(state.latest);
    } catch (e) { /* offline or rate-limited: try again later */ }
  };
  timer = setInterval(loop, 5 * 60000);
  if (timer.unref) timer.unref();
  setTimeout(loop, 30000).unref?.();
}
