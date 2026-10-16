/* ===========================================================================
   server/src/platform/packs.js — course packs: install, load, serve, export.
   ---------------------------------------------------------------------------
   A course is not part of the program. It is a PACK: a manifest plus the
   built files, installed into the data folder, so the program can be updated
   without touching a course and a course can be updated without touching the
   program — or a person's progress in it.

   The pack file (".lpack") is one JSON document, so it can be sent, uploaded
   or served without any archive library:

     { "lanternPack": 1,
       "manifest": { … see validateManifest … },
       "files": { "index.html": "<base64>", "img/logo.png": "<base64>" } }

   On disk:  <data>/packs/<id>/<version>/manifest.json + files
   The packs table says which version is current. The previous version stays
   on disk until the one after it is installed, so a bad course update can be
   undone.

   LESSON IDS ARE A PROMISE. Progress is stored against them, so a new version
   of a pack may add lessons and change their words, but must never rename or
   drop an id a learner may have finished. install() refuses a version that
   drops ids unless it is forced, and says which. The one exception: ids the
   new version names in manifest.retired (a section a course deliberately
   replaced). Their progress is kept; it no longer counts toward the total.
   =========================================================================== */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { one, all, run, json } from '../db/db.js';
import { paths, version as platformVersion } from './config.js';
import { cmp } from './semver.js';
import { allIds } from './progress.js';

export const FORMAT = 1;
const ID_RX = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VER_RX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class PackError extends Error {
  constructor(message, details) { super(message); this.name = 'PackError'; this.status = 400; this.details = details || null; }
}

/* ------------------------------------------------------------ manifest --- */
/* Required: id, title, version, entry, lessons[{ id, title }].
   Optional: description, level, subject, units[{ id, title }], storage { keys[] },
             progress { key, lessons, exercises, doneField, passedField, seconds, position },
             minPlatform, changelog[{ version, date, notes }], assets[{ path, size, sha256 }],
             color, icon, estimatedHours, tags[] */
export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['The manifest is missing.'];
  if (!ID_RX.test(String(m.id || ''))) errs.push('id must be lowercase letters, digits and dashes (got "' + m.id + '").');
  if (!String(m.title || '').trim()) errs.push('title is required.');
  if (!VER_RX.test(String(m.version || ''))) errs.push('version must look like 1.2.3 (got "' + m.version + '").');
  if (!String(m.entry || '').trim()) errs.push('entry (the page to open, e.g. index.html) is required.');
  if (!Array.isArray(m.lessons) || !m.lessons.length) errs.push('lessons must list at least one { id, title }.');
  else {
    const seen = new Set();
    m.lessons.forEach((l, i) => {
      if (!l || !String(l.id || '').trim()) errs.push('lessons[' + i + '] has no id.');
      else if (seen.has(l.id)) errs.push('lesson id "' + l.id + '" appears twice.');
      else seen.add(l.id);
    });
  }
  if (m.minPlatform && !VER_RX.test(String(m.minPlatform))) errs.push('minPlatform must look like 1.2.3.');
  if (m.storage && m.storage.keys && !Array.isArray(m.storage.keys)) errs.push('storage.keys must be a list.');
  if (m.retired !== undefined && (!Array.isArray(m.retired) || m.retired.some((x) => typeof x !== 'string'))) errs.push('retired must be a list of lesson ids.');
  return errs;
}

/* ---------------------------------------------------------------- build --- */
/* Make a pack file from a manifest and { relPath: Buffer|string }. Fills in
   assets[] with sizes and hashes. Used by scripts/build-pack.mjs and by
   export(). */
export function buildPack(manifest, files) {
  const out = { lanternPack: FORMAT, manifest: Object.assign({}, manifest), files: {} };
  const assets = [];
  // the raw bytes too (not enumerable, so JSON.stringify leaves them out): serializePack writes them as they are
  const raw = {};
  Object.defineProperty(out, 'raw', { value: raw, enumerable: false });
  for (const [p, data] of Object.entries(files)) {
    const rel = cleanRel(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    raw[rel] = buf;
    out.files[rel] = buf.toString('base64');
    assets.push({ path: rel, size: buf.length, sha256: sha256(buf) });
  }
  out.manifest.assets = assets.sort((a, b) => (a.path < b.path ? -1 : 1));
  const errs = validateManifest(out.manifest);
  if (!out.files[cleanRel(out.manifest.entry || '')]) errs.push('the entry page ' + out.manifest.entry + ' is not among the files.');
  if (errs.length) throw new PackError('This pack is not valid: ' + errs.join(' '), errs);
  return out;
}

/* The bytes of a pack file. A small pack is the JSON document above, which any
   copy of Lantern reads. A big one (a course with narration: hundreds of MB,
   past the longest string JavaScript can hold once base64'd) is written in the
   binary form, which Lantern 0.1.8+ reads:

     "LANTERNPACK2 <header bytes>\n" + header JSON + the files' bytes, back to back

   where the header is { lanternPack: 2, manifest, index: [[path, offset, length]] }
   and each offset counts from the first byte after the header. */
const MAGIC2 = 'LANTERNPACK2 ';
export const BINARY_OVER = 100 * 1048576;
export function serializePack(pack, opts) {
  const raw = pack.raw || Object.fromEntries(Object.entries(pack.files).map(([p, b64]) => [p, Buffer.from(String(b64), 'base64')]));
  const total = Object.values(raw).reduce((a, b) => a + b.length, 0);
  const binary = (opts && opts.binary != null) ? opts.binary : total > BINARY_OVER;
  if (!binary) return Buffer.from(JSON.stringify(pack), 'utf8');
  const index = [];
  let at = 0;
  for (const [p, b] of Object.entries(raw)) { index.push([p, at, b.length]); at += b.length; }
  const head = Buffer.from(JSON.stringify({ lanternPack: 2, manifest: pack.manifest, index }), 'utf8');
  return Buffer.concat([Buffer.from(MAGIC2 + head.length + '\n', 'utf8'), head, ...Object.values(raw)]);
}
function parseBinary(buf) {
  const nl = buf.indexOf(10, 0);
  const len = Number(buf.subarray(MAGIC2.length, nl).toString('utf8'));
  if (nl < 0 || !Number.isFinite(len) || len <= 0) throw new PackError('That course file is damaged (its header cannot be read).');
  let head;
  try { head = JSON.parse(buf.subarray(nl + 1, nl + 1 + len).toString('utf8')); } catch (e) { throw new PackError('That course file is damaged (its header cannot be read).'); }
  const base = nl + 1 + len;
  const files = {};
  for (const [p, off, n] of head.index || []) {
    if (base + off + n > buf.length) throw new PackError('This course file is incomplete: ' + p + ' is cut short. Download it again.');
    files[p] = buf.subarray(base + off, base + off + n);
  }
  return { lanternPack: FORMAT, manifest: head.manifest, binaryFiles: files };
}
const isBinaryPack = (b) => Buffer.isBuffer(b) && b.length > MAGIC2.length && b.subarray(0, MAGIC2.length).toString('latin1') === MAGIC2;

function cleanRel(p) {
  const rel = normalize(String(p)).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.startsWith('..') || rel.includes('/../') || /^[A-Za-z]:/.test(rel)) throw new PackError('A file path in the pack is not allowed: ' + p);
  return rel;
}

/* A pack from a Buffer, a string or an object. Checks every file against the
   manifest's hashes, so a damaged download is refused rather than installed. */
// A pack may travel gzipped (a course with narration is mostly base64, which
// gzip takes back to about its real size): it is unzipped here, wherever it came from.
export const isGzip = (b) => Buffer.isBuffer(b) && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
export function parsePack(input) {
  let pack = input;
  if (isGzip(input)) {
    try { input = gunzipSync(input); } catch (e) { throw new PackError('That course file is damaged (it could not be unpacked).'); }
    pack = input;
  }
  if (isBinaryPack(input)) pack = parseBinary(input);
  else if (Buffer.isBuffer(input) || typeof input === 'string') {
    try { pack = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input); }
    catch (e) { throw new PackError('That file is not a Lantern course file (it is not readable).'); }
  }
  if (!pack || pack.lanternPack !== FORMAT || !pack.manifest || !(pack.files || pack.binaryFiles)) throw new PackError('That file is not a Lantern course file.');
  const m = pack.manifest;
  const errs = validateManifest(m);
  if (errs.length) throw new PackError('This course file is not valid: ' + errs.join(' '), errs);
  const files = {};
  if (pack.binaryFiles) for (const [p, b] of Object.entries(pack.binaryFiles)) files[cleanRel(p)] = b;
  else for (const [p, b64] of Object.entries(pack.files)) files[cleanRel(p)] = Buffer.from(String(b64), 'base64');
  if (!files[cleanRel(m.entry)]) throw new PackError('This course file has no ' + m.entry + '.');
  for (const a of m.assets || []) {
    const f = files[a.path];
    if (!f) throw new PackError('This course file is incomplete: ' + a.path + ' is missing.');
    if (a.sha256 && sha256(f) !== a.sha256) throw new PackError('This course file is damaged: ' + a.path + ' does not match. Download it again.');
  }
  return { manifest: m, files };
}

/* ------------------------------------------------------------- install --- */
/* Install or update a pack. opts: { source: 'hub'|'file'|'bundled', force, dir }.
   Returns { id, version, previous, changed, droppedLessons }. Never touches
   anybody's progress: that lives in pack_progress, keyed by pack and lesson id. */
export function install(input, opts) {
  const o = opts || {};
  const { manifest: m, files } = parsePack(input);
  if (m.minPlatform && cmp(platformVersion(), m.minPlatform) < 0) {
    throw new PackError(m.title + ' ' + m.version + ' needs Lantern ' + m.minPlatform + ' or newer (this is ' + platformVersion() + '). Update Lantern first.');
  }
  const cur = one('SELECT * FROM packs WHERE id = ?', m.id);
  const reenable = cur && !cur.enabled;
  const prevManifest = cur ? json(cur.manifest_json, {}) : null;
  if (cur && cmp(m.version, cur.version) < 0 && !o.allowOlder) {
    throw new PackError('This computer already has ' + cur.title + ' ' + cur.version + ', which is newer than ' + m.version + '.');
  }
  let dropped = [];
  if (prevManifest && Array.isArray(prevManifest.lessons)) {
    // Lessons, checks, exercises, projects and milestones: every id progress is kept against.
    // …except the ones this version retires on purpose (manifest.retired): their progress stays kept, just not counted.
    const next = allIds(m);
    const retired = new Set(Array.isArray(m.retired) ? m.retired : []);
    dropped = [...allIds(prevManifest)].filter((id) => !next.has(id) && !retired.has(id));
    if (dropped.length && !o.force) {
      throw new PackError(m.title + ' ' + m.version + ' removes lessons or exercises that people may have finished (' +
        dropped.slice(0, 5).join(', ') + (dropped.length > 5 ? '…' : '') + '). Lesson ids must stay the same between versions.', dropped);
    }
  }

  const root = o.dir || paths.packs();
  const dir = join(root, m.id, m.version);
  const tmp = dir + '.partial';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [rel, buf] of Object.entries(files)) {
    const f = join(tmp, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, buf);
  }
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(m, null, 2));
  rmSync(dir, { recursive: true, force: true });
  renameDir(tmp, dir);

  const changed = !cur || cur.version !== m.version || reenable;
  if (cur) {
    run("UPDATE packs SET title=?, version=?, manifest_json=?, source=?, previous_version=?, enabled=1, updated_at=datetime('now') WHERE id=?",
      m.title, m.version, JSON.stringify(m), o.source || cur.source, cur.version === m.version ? cur.previous_version : cur.version, m.id);
  } else {
    run('INSERT INTO packs (id, title, version, manifest_json, source) VALUES (?,?,?,?,?)',
      m.id, m.title, m.version, JSON.stringify(m), o.source || 'file');
  }
  if (changed) {
    run("INSERT INTO update_log (channel, subject, from_version, to_version, status, title, notes, message) VALUES ('pack',?,?,?,?,?,?,?)",
      m.id, cur ? cur.version : null, m.version, 'installed', m.title + ' ' + m.version,
      notesSince(m, cur ? cur.version : null), cur ? 'Updated from ' + cur.version + '. Your progress is kept.' : 'Added to your courses.');
  }
  prune(root, m.id, [m.version, cur ? cur.version : null]);
  return { id: m.id, version: m.version, previous: cur ? cur.version : null, changed, droppedLessons: dropped };
}

/* renameSync is atomic on one volume (both live under the packs folder). It
   is retried briefly because Windows can hold a just-written folder for a
   moment (antivirus, the search indexer). */
function renameDir(from, to) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; }
    catch (e) { if (i >= 20 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e; sleep(50); }
  }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/* The changelog entries newer than `since`, as plain text. */
export function notesSince(m, since) {
  const list = (m.changelog || []).filter((c) => c && c.version && (!since || cmp(c.version, since) > 0));
  if (!list.length) return m.description || '';
  return list.map((c) => '## ' + c.version + (c.date ? ' (' + c.date + ')' : '') + '\n' + String(c.notes || '').trim()).join('\n\n');
}

/* Keep the current version and the one before it; remove older folders. */
function prune(root, id, keep) {
  const d = join(root, id);
  if (!existsSync(d)) return;
  for (const v of readdirSync(d)) {
    if (keep.indexOf(v) >= 0) continue;
    rmSync(join(d, v), { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- query --- */

export function list() {
  return all('SELECT * FROM packs WHERE enabled = 1 ORDER BY title').map(rowOut);
}
export function get(id) {
  const r = one('SELECT * FROM packs WHERE id = ? AND enabled = 1', id);
  return r ? rowOut(r) : null;
}
/* Including a pack that has been hidden (access taken away). */
export function getAny(id) {
  const r = one('SELECT * FROM packs WHERE id = ?', id);
  return r ? Object.assign(rowOut(r), { enabled: !!r.enabled }) : null;
}
function rowOut(r) {
  const m = json(r.manifest_json, {});
  return {
    id: r.id, title: r.title, version: r.version, source: r.source, previousVersion: r.previous_version,
    installedAt: r.installed_at, updatedAt: r.updated_at, manifest: m,
  };
}

/* The absolute path of a file inside the current version, or null. Refuses
   anything that would leave the pack's own folder. */
export function fileFor(id, rel, opts) {
  const p = get(id);
  if (!p) return null;
  const dir = join((opts && opts.dir) || paths.packs(), id, p.version);
  const clean = normalize(String(rel || p.manifest.entry || 'index.html')).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  const f = join(dir, clean);
  if (!f.startsWith(dir + sep) || !existsSync(f) || !statSync(f).isFile()) return null;
  return f;
}

/* A pack file for an installed pack, rebuilt from what is on disk — how the
   owner hands somebody a course directly. */
export function exportPack(id, opts) {
  const p = get(id);
  if (!p) throw new PackError('There is no course called ' + id + ' on this computer.');
  const dir = join((opts && opts.dir) || paths.packs(), id, p.version);
  const files = {};
  for (const a of p.manifest.assets || []) files[a.path] = readFileSync(join(dir, a.path));
  const m = Object.assign({}, p.manifest);
  delete m.assets;
  return buildPack(m, files);
}

export function remove(id) {
  run('UPDATE packs SET enabled = 0 WHERE id = ?', id);
}

/* ------------------------------------------------------------- bundled --- */
/* Packs sitting in a folder (the course author's dist/packs, or a folder the
   installer was given) are installed at start-up when they are new or newer.
   The public program ships with none. */
export function installBundled(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /\.lpack$/i.test(x) && !/-\d+\.\d+\.\d+/.test(x))) {
    try {
      const raw = readFileSync(join(dir, f));
      const { manifest } = parsePack(raw);
      const cur = get(manifest.id);
      if (cur && cmp(manifest.version, cur.version) <= 0) continue;
      out.push(install(raw, { source: 'bundled' }));
    } catch (e) {
      out.push({ file: f, error: e.message });
    }
  }
  return out;
}
