/* ===========================================================================
   server/src/platform/media.js — a course's external media, downloaded to the
   computer in the background.
   ---------------------------------------------------------------------------
   A pack may keep its big files (a course's narration) out of the pack
   and list them in manifest.media = { base, files: { path: { key, size, sha256 } } }.
   When such a pack installs, packs.install() calls start(): every file is
   fetched from base/key into the pack's own folder (packs/<id>/<version>/<path>),
   checked against its sha256, and only then moved into place, so a half
   download is never served. Files the previous version already had are linked
   in by install() and are not fetched again. It resumes after a restart
   (resumeAll(), called at start-up) and after being offline.

   Until a file is here, /packs/<id>/<version>/<path> redirects to base/key so
   the video plays at once (redirectFor). Once it is here it is served locally,
   so the course works offline.

   Progress: bus event 'media' { course, have, total, bytes, totalBytes, phase }
   and status(id) → the same, which the course list carries as `media`.
   =========================================================================== */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as packs from './packs.js';
import * as bus from './bus.js';
import { paths } from './config.js';

const cfg = { concurrency: 4, attempts: 3, backoffMs: 400, offlineRetryMs: 60000, emitMs: 400 };
/* Tests shorten the waits (and may point at a stub through the manifest's base). */
export function configure(o) { Object.assign(cfg, o || {}); }

const state = new Map();     // course id -> { version, have, total, bytes, totalBytes, phase, error }
const running = new Map();   // course id -> Promise
const timers = new Map();

const enc = (k) => String(k).split('/').map(encodeURIComponent).join('/');
const urlFor = (media, f) => String(media.base).replace(/\/+$/, '') + '/' + enc(f.key);

function target(id) {
  const p = packs.get(id);
  if (!p || !p.manifest.media || !p.manifest.media.files) return null;
  return { p, version: p.version, media: p.manifest.media, dir: join(paths.packs(), id, p.version) };
}
function haveFile(t, rel, f) {
  try { return statSync(join(t.dir, rel)).size === f.size; } catch (e) { return false; }
}
function scan(t, phase) {
  let have = 0, bytes = 0, totalBytes = 0;
  const entries = Object.entries(t.media.files);
  for (const [rel, f] of entries) { totalBytes += f.size; if (haveFile(t, rel, f)) { have++; bytes += f.size; } }
  const s = { version: t.version, have, total: entries.length, bytes, totalBytes, phase: phase || (have === entries.length ? 'done' : 'waiting'), error: null };
  state.set(t.p.id, s);
  return s;
}
const publicState = (id, s) => ({ have: s.have, total: s.total, bytes: s.bytes, totalBytes: s.totalBytes, phase: s.phase, error: s.error || null, course: id });

/* { have, total, bytes, totalBytes, phase } for a pack with media, else null. */
export function status(id) {
  const t = target(id);
  if (!t) return null;
  let s = state.get(id);
  if (!s || s.version !== t.version) s = scan(t);
  const { course, ...out } = publicState(id, s);
  return out;
}

/* Where a missing media file can be had right now, or null (not media, or already here). */
export function redirectFor(id, rel) {
  const t = target(id);
  if (!t || !rel) return null;
  const key = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const f = t.media.files[key];
  if (!f || !t.media.base || haveFile(t, key, f)) return null;
  return urlFor(t.media, f);
}

function announce(id, s) { bus.emit('media', publicState(id, s)); }

class Offline extends Error {}

async function fetchOne(t, rel, f, s) {
  const final = join(t.dir, rel);
  const part = final + '.part';
  mkdirSync(dirname(final), { recursive: true });
  let last = null;
  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, cfg.backoffMs * attempt));
    if (packs.get(t.p.id)?.version !== t.version) return false;       // a newer version took over
    rmSync(part, { force: true });
    let res;
    try { res = await fetch(urlFor(t.media, f)); }
    catch (e) { last = new Offline(e.message); continue; }             // no network, or the host is down
    if (!res.ok || !res.body) { last = new Error('HTTP ' + res.status); continue; }
    const hash = createHash('sha256');
    let n = 0;
    try {
      const out = createWriteStream(part);
      for await (const chunk of res.body) { hash.update(chunk); n += chunk.length; if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); }
      await new Promise((ok, no) => { out.once('error', no); out.end(ok); });
    } catch (e) { last = new Offline(e.message); rmSync(part, { force: true }); continue; }
    if (n !== f.size || hash.digest('hex') !== f.sha256) {             // damaged or the wrong bytes: never kept
      rmSync(part, { force: true });
      last = new Error('The downloaded file did not match its checksum.');
      continue;
    }
    if (packs.get(t.p.id)?.version !== t.version) { rmSync(part, { force: true }); return false; }
    renameSync(part, final);
    return true;
  }
  throw last || new Error('download failed');
}

/* Download whatever is missing for the pack's current version. Safe to call
   again at any time: one run per course. Resolves with the final status. */
export function start(id) {
  if (running.has(id)) return running.get(id);
  const t = target(id);
  if (!t) return Promise.resolve(null);
  clearTimeout(timers.get(id));
  const p = run(id, t).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

async function run(id, t) {
  const s = scan(t, 'downloading');
  // clear half-finished downloads from a run that was cut off
  for (const rel of Object.keys(t.media.files)) rmSync(join(t.dir, rel + '.part'), { force: true });
  const todo = Object.entries(t.media.files).filter(([rel, f]) => !haveFile(t, rel, f));
  if (!todo.length) { s.phase = 'done'; announce(id, s); return status(id); }
  announce(id, s);
  let i = 0, stop = false, failed = 0, offline = false, lastEmit = 0;
  const worker = async () => {
    while (!stop) {
      const at = i++;
      if (at >= todo.length) return;
      const [rel, f] = todo[at];
      try {
        const done = await fetchOne(t, rel, f, s);
        if (!done) { stop = true; return; }
        s.have++; s.bytes += f.size;
        if (Date.now() - lastEmit > cfg.emitMs) { lastEmit = Date.now(); announce(id, s); }
      } catch (e) {
        failed++; s.error = e.message;
        if (e instanceof Offline) { offline = true; stop = true; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, todo.length) }, worker));
  if (packs.get(id)?.version !== t.version) return status(id);          // superseded
  s.phase = s.have >= s.total ? 'done' : offline ? 'offline' : 'failed';
  if (s.phase === 'done') s.error = null;
  announce(id, s);
  if (s.phase !== 'done') {
    // try again later: offline comes back by itself; a failure waits longer
    const tm = setTimeout(() => { start(id).catch(() => {}); }, cfg.offlineRetryMs * (offline ? 1 : 5));
    if (tm.unref) tm.unref();
    timers.set(id, tm);
  }
  return status(id);
}

/* At start-up: carry on with any pack whose media is not all here yet. */
export function resumeAll() {
  for (const p of packs.list()) {
    const t = target(p.id);
    if (!t) continue;
    const s = scan(t);
    if (s.have < s.total) start(p.id).catch(() => {});
  }
}

export function idle() { return Promise.all([...running.values()]); }

packs.onInstalled((id) => { start(id).catch(() => {}); });
