/* ===========================================================================
   server/src/assistant/teach/pack.js — a course's teaching, from its own pack.
   ---------------------------------------------------------------------------
   The platform knows nothing about any subject. A course that wants the
   tutor to show its figures, work its examples, explain its glossary and stay
   on its subject says so in its manifest: an optional `teach` block, written
   in courses/<id>/course.json and carried by scripts/build-pack.mjs, which
   also copies the files it names into the pack (under teach/). This module
   is the one place the server reads that block.

     of(pack)           → the pack's teaching, or null when it declares none
     of(pack).cfg       the manifest's teach block
     of(pack).has('figures' | 'generators' | 'glossary' | 'lawBasis' | 'reference' | 'scope')
     of(pack).read(rel) / .json(rel)   a file of the pack, hash-checked
     of(pack).section(name)            an object, or the JSON file it names
     of(pack).load(listOfPaths, g)     run the course's scripts in a sandboxed global

   Every file comes from the pack's own installed folder (packs.fileFor refuses
   any path that leaves it) and is checked against the sha256 in the manifest
   before it is read or run, the same hashes the installer verified. A pack's
   code is its author's code, as it is on the course page; it never reaches
   outside the pack, and it runs with no access to the server's modules.

   Cached per pack id and version.
   =========================================================================== */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as packs from '../../platform/packs.js';

const cache = new Map();   // id@version → teaching | null

export function of(pack) {
  if (!pack || !pack.manifest || !pack.manifest.teach || typeof pack.manifest.teach !== 'object') return null;
  const key = pack.id + '@' + pack.version;
  if (cache.has(key)) return cache.get(key);
  const T = make(pack, key);
  cache.set(key, T);
  return T;
}

export const forget = () => cache.clear();

function make(pack, key) {
  const cfg = pack.manifest.teach;
  const sums = new Map((pack.manifest.assets || []).map((a) => [a.path, a.sha256]));
  const raw = new Map();
  const parsed = new Map();
  const mem = {};
  const T = {
    key, id: pack.id, cfg, pack, mem,
    file(rel) {
      const f = packs.fileFor(pack.id, rel);
      if (!f) return null;
      return f;
    },
    read(rel) {
      const k = String(rel);
      if (raw.has(k)) return raw.get(k);
      const f = T.file(k);
      if (!f) return null;
      const buf = readFileSync(f);
      const want = sums.get(k.replace(/\\/g, '/'));
      if (want && createHash('sha256').update(buf).digest('hex') !== want) throw new Error('The course file ' + k + ' does not match its recorded hash; the pack is damaged or was changed.');
      const text = buf.toString('utf8');
      raw.set(k, text);
      return text;
    },
    json(rel) {
      const k = String(rel);
      if (parsed.has(k)) return parsed.get(k);
      let v = null;
      try { const t = T.read(k); v = t == null ? null : JSON.parse(t); } catch (e) { v = null; }
      parsed.set(k, v);
      return v;
    },
    /* a data file named in teach.data (a pack path) */
    data(name) { const p = cfg.data && cfg.data[name]; return p ? T.json(p) : null; },
    /* an inline object, or the JSON file the string names */
    section(name) {
      const v = cfg[name];
      if (!v) return null;
      return typeof v === 'string' ? T.json(v) : v;
    },
    /* a text file named in teach.prompts */
    prompt(name) { const p = cfg.prompts && cfg.prompts[name]; return p ? (T.read(p) || '').trim() : ''; },
    has(what) {
      switch (what) {
        case 'figures': return !!(cfg.figures && cfg.figures.load && cfg.figures.load.length && cfg.data && cfg.data.modules);
        case 'generators': return !!(cfg.generators && cfg.generators.load && cfg.generators.load.length && cfg.data && cfg.data.templates);
        case 'glossary': return !!(cfg.data && cfg.data.glossary);
        case 'lawBasis': return !!(cfg.lawBasis && cfg.data && cfg.data.modules);
        case 'reference': return !!cfg.reference;
        case 'scope': return !!cfg.scope;
        default: return !!cfg[what];
      }
    },
    /* Run the course's own scripts (pack paths, in order) against a fresh global.
       Each script sees only `globalThis` (the sandbox object) and `Course`. */
    load(list, g) {
      for (const rel of list || []) {
        const src = T.read(rel);
        if (src == null) throw new Error('The course file ' + rel + ' is not in the pack.');
        new Function('globalThis', 'var Course = globalThis.Course;\n' + src)(g);
      }
      return g;
    },
  };
  return T;
}

/* Where a pack keeps its video scripts (teach.videos.dir) and its library's
   page text (teach.library.index): the conventional places unless it says. */
export function videoDir(pack) {
  const d = pack && pack.manifest && pack.manifest.teach && pack.manifest.teach.videos && pack.manifest.teach.videos.dir;
  return String(d || 'assets/videos').replace(/\/+$/, '');
}
export function libraryIndex(pack) {
  const d = pack && pack.manifest && pack.manifest.teach && pack.manifest.teach.library && pack.manifest.teach.library.index;
  return String(d || 'assets/library/index.json');
}
