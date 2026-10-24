#!/usr/bin/env node
/* ===========================================================================
   scripts/build-pack.mjs — build a course folder into a course pack.
   ---------------------------------------------------------------------------
       node scripts/build-pack.mjs <course> [--out dist/packs] [--quiet]
       node scripts/build-pack.mjs --all

   A course is a folder, courses/<id>/ (the contract is docs/dev/authoring-courses.md):

     course.json      id, title, version, description, level, storage keys,
                      the progress map, the changelog, and how it is built
     structure.json   the units: lessons (with exercises), checks, projects
       or structure.mjs   a module whose default export returns them
     site/            the course's pages (index.html is the entry), or
     build.command + build.page   a build step that produces one page

   Output: dist/packs/<id>.lpack (the newest; the app installs it at start-up
   on the author's own computer) and dist/packs/<id>-<version>.lpack.

   The validator refuses a pack that is not valid, and warns when a lesson,
   exercise or milestone id that existed in the last build is gone: progress
   is kept against those ids, so they must never change.
   =========================================================================== */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPack, parsePack, serializePack, validateManifest } from '../server/src/platform/packs.js';
import { allIds } from '../server/src/platform/progress.js';
import { cmp } from '../server/src/platform/semver.js';
import { createHash } from 'node:crypto';
import { loadEnv } from './lib-r2.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const COURSES = join(ROOT, 'courses');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

/* A page built for the web, made into a proper document for the app's player. */
function asDocument(html) {
  if (/^\s*<!doctype/i.test(html)) return html;
  return '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + html + '\n</html>\n';
}

/* Every pack path a teach block names must be in the pack: data.* , figures.load,
   generators.load, prompts.*, and scope / tools given as a file. */
export function teachProblems(teach, files) {
  const out = [];
  const need = (what, p) => { if (typeof p !== 'string' || !p) out.push(what + ' must be a pack path.'); else if (!(p in files)) out.push(what + ' names ' + p + ', which is not in the pack (add it to teach.files).'); };
  for (const [k, p] of Object.entries(teach.data || {})) need('data.' + k, p);
  for (const sec of ['figures', 'generators']) if (teach[sec] !== undefined) {
    if (!teach[sec] || !Array.isArray(teach[sec].load) || !teach[sec].load.length) out.push(sec + '.load must list the scripts to run, in order.');
    else teach[sec].load.forEach((p, i) => need(sec + '.load[' + i + ']', p));
  }
  for (const [k, p] of Object.entries(teach.prompts || {})) need('prompts.' + k, p);
  for (const sec of ['scope', 'tools']) if (typeof teach[sec] === 'string') need(sec, teach[sec]);
  if (teach.figures && !(teach.data && teach.data.modules)) out.push('figures needs data.modules (the lessons whose readings use the figures).');
  if (teach.generators && !(teach.data && teach.data.templates)) out.push('generators needs data.templates.');
  if (teach.lawBasis && !(teach.data && teach.data.modules)) out.push('lawBasis needs data.modules.');
  return out;
}

export async function build(name, opts) {
  const o = opts || {};
  const dir = o.dir || join(COURSES, name);
  const say = (m) => { if (!o.quiet) console.log(m); };
  if (!existsSync(join(dir, 'course.json'))) throw new Error('There is no course folder courses/' + name + ' (it needs a course.json).');
  const course = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8'));
  const id = course.id;
  // The folder is the course's id (or _<id> for the template, which is never published).
  if (!o.dir && name !== id && name !== '_' + id) throw new Error('courses/' + name + '/course.json says its id is "' + id + '"; the folder and the id must match.');

  // 1 the pages
  const files = {};
  if (course.build && course.build.command) {
    say('  building: ' + course.build.command);
    execSync(course.build.command, { cwd: ROOT, stdio: o.quiet ? 'ignore' : 'inherit' });
  }
  if (course.build && course.build.page) {
    // one page produced by the build step, plus any files it needs offline
    // (fonts, images): build.assets [{ from, to, exclude }], and build.head
    // (a tag put at the top of the page, e.g. the local font stylesheet)
    let page = readFileSync(join(ROOT, course.build.page), 'utf8');
    if (course.build.head) page = course.build.head + '\n' + page;
    files['index.html'] = asDocument(page);
    for (const a of course.build.assets || []) {
      const src = join(ROOT, a.from);
      const skip = a.exclude ? new RegExp(a.exclude) : null;
      if (statSync(src).isDirectory()) {
        for (const f of walk(src)) {
          const rel = relative(src, f).replace(/\\/g, '/');
          if (!skip || !skip.test(rel)) files[a.to + '/' + rel] = readFileSync(f);
        }
      } else files[a.to] = readFileSync(src);
    }
  } else if (existsSync(join(dir, 'site'))) {
    for (const f of walk(join(dir, 'site'))) files[relative(join(dir, 'site'), f).replace(/\\/g, '/')] = readFileSync(f);
  } else {
    throw new Error('courses/' + name + ' has neither a site/ folder nor build.page.');
  }

  // 1b external media (build.media): large files kept out of the pack and served from
  // R2 (or any public URL). Each is keyed by its sha256, so a key never changes meaning.
  let media = null;
  if (course.build && course.build.media) {
    const spec = course.build.media;
    loadEnv();
    const src = join(o.root || ROOT, spec.from);
    const to = (spec.to || ('assets/' + spec.from.split('/').pop())).replace(/\/+$/, '');
    const globs = [].concat(spec.include || ['*']).map((g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'));
    const prefix = String(spec.keyPrefix || id).replace(/^\/+|\/+$/g, '');
    const base = String(process.env.R2_PUBLIC_URL || spec.base || '').replace(/\/+$/, '');
    if (!base) say('  WARNING: build.media has no base URL (set R2_PUBLIC_URL in .env or media.base in course.json); the pack cannot be published until it has one.');
    media = { base, files: {} };
    let bytes = 0;
    for (const f of walk(src)) {
      const rel = relative(src, f).replace(/\\/g, '/');
      if (!globs.some((g) => g.test(rel))) continue;
      const buf = readFileSync(f);
      const sha = createHash('sha256').update(buf).digest('hex');
      media.files[to + '/' + rel] = { key: prefix + '/' + sha + (/\.[A-Za-z0-9]+$/.exec(rel) || [''])[0].toLowerCase(), size: buf.length, sha256: sha };
      bytes += buf.length;
    }
    for (const p of Object.keys(media.files)) delete files[p];   // never both inside and outside the pack
    say('  media: ' + Object.keys(media.files).length + ' files, ' + (bytes / 1048576).toFixed(0) + ' MB kept out of the pack');
  }

  // 1c teaching (optional): course.teach. The pack's own files that the in-app assistant
  // teaches from, named once here: teach.files maps a pack path to a source in the repo
  // (a file, or a whole folder), and everything else in teach is pack paths. The block
  // goes into the manifest as teach (without files); see docs/dev/authoring-courses.md.
  let teach = null;
  if (course.teach) {
    const { files: tf, ...rest } = course.teach;
    for (const [to, from] of Object.entries(tf || {})) {
      const src = resolve(ROOT, from);
      if (!src.startsWith(ROOT + sep)) throw new Error('teach.files: ' + from + ' is outside the repository.');
      if (!existsSync(src)) throw new Error('teach.files: ' + from + ' does not exist.');
      if (statSync(src).isDirectory()) {
        for (const f of walk(src)) files[to.replace(/\/+$/, '') + '/' + relative(src, f).split(sep).join('/')] = readFileSync(f);
      } else files[to] = readFileSync(src);
    }
    teach = rest;
    const missing = teachProblems(teach, files);
    if (missing.length) throw new Error('teach is not valid: ' + missing.join('; '));
    say('  teach: ' + Object.keys(files).filter((p) => p.startsWith('teach/')).length + ' files');
  }

  // 2 the structure
  let units;
  if (existsSync(join(dir, 'structure.json'))) units = JSON.parse(readFileSync(join(dir, 'structure.json'), 'utf8'));
  else if (course.structure && existsSync(join(dir, course.structure))) {
    const mod = await import(pathToFileURL(join(dir, course.structure)).href);
    units = await (mod.default || mod.structure)();
  } else throw new Error('courses/' + name + ' needs structure.json or a structure module.');
  if (!Array.isArray(units) && units && units.units) units = units.units;

  // 2b what the in-app assistant may know (optional): context/exercises.json
  // from the structure module's context() export (prompts and hints only, never
  // answers), and context/resources.json from the course's resources.json
  if (course.structure && /\.(m?js)$/.test(course.structure) && existsSync(join(dir, course.structure))) {
    const mod = await import(pathToFileURL(join(dir, course.structure)).href);
    if (typeof mod.context === 'function') {
      const ctx = await mod.context();
      const leak = contextLeak(ctx);
      if (leak) throw new Error('context() must never include answers, but it has: ' + leak);
      files['context/exercises.json'] = Buffer.from(JSON.stringify(ctx));
    }
    // what the assistant may search (readings, glossary, flashcards, formulas,
    // video chapters, the handbook's notation inventory): the same no-answers rule
    if (typeof mod.knowledge === 'function') {
      const kn = await mod.knowledge();
      const leak = contextLeak(kn);
      if (leak) throw new Error('knowledge() must never include answers, but it has: ' + leak.replace(/^context/, 'knowledge'));
      files['context/knowledge.json'] = Buffer.from(JSON.stringify(kn));
    }
  }
  if (existsSync(join(dir, 'resources.json'))) files['context/resources.json'] = readFileSync(join(dir, 'resources.json'));
  // the checked list of outside videos the assistant may recommend (scripts/check-outside-videos.mjs)
  if (existsSync(join(dir, 'outside-videos.json'))) files['context/outside-videos.json'] = readFileSync(join(dir, 'outside-videos.json'));

  const lessons = [];
  for (const u of units) {
    for (const l of u.lessons || []) lessons.push({ id: l.id, title: l.title, unit: u.id });
    if (u.check) lessons.push({ id: u.check.id, title: u.check.title, unit: u.id, check: true });
  }

  // 3 the manifest
  const manifest = {
    id: course.id, title: course.title, version: course.version, description: course.description || '',
    level: course.level || '', subject: course.subject || '', estimatedHours: course.estimatedHours || null,
    color: course.color || null, minPlatform: course.minPlatform || null, entry: 'index.html',
    storage: course.storage || { keys: [] }, progress: course.progress || null,
    ...(Array.isArray(course.retired) && course.retired.length ? { retired: course.retired } : {}),
    ...(media ? { media } : {}),
    ...(teach ? { teach } : {}),
    units, lessons, changelog: course.changelog || [], builtAt: new Date().toISOString(),
  };
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error('The course is not valid:\n  - ' + errs.join('\n  - '));

  // 4 compare with the last build: ids must not disappear
  const outDir = resolve(o.out || join(ROOT, 'dist', 'packs'));
  const latest = join(outDir, id + '.lpack');
  const warnings = [];
  if (existsSync(latest)) {
    try {
      const prev = parsePack(readFileSync(latest)).manifest;
      const now = allIds(manifest);
      const gone = [...allIds(prev)].filter((x) => !now.has(x) && !(manifest.retired || []).includes(x));
      if (gone.length) warnings.push('These ids were in the last build and are gone (progress is kept against them; put them back or keep the old id): ' + gone.join(', '));
      if (cmp(manifest.version, prev.version) < 0) warnings.push('The version went DOWN from ' + prev.version + ' to ' + manifest.version + '.');
    } catch (e) { /* no usable previous build */ }
  }

  const pack = buildPack(manifest, files);
  mkdirSync(outDir, { recursive: true });
  // a big pack (narration) is written in the binary form; a small one stays JSON (serializePack)
  const text = serializePack(pack);
  writeFileSync(latest, text);
  writeFileSync(join(outDir, id + '-' + manifest.version + '.lpack'), text);
  const size = (text.length / 1024).toFixed(0);
  say('  ' + manifest.title + ' ' + manifest.version + ': ' + units.length + ' units, ' + lessons.length + ' lessons and checks, ' + allIds(manifest).size + ' ids, ' + size + ' KB → ' + relative(ROOT, latest));
  warnings.forEach((w) => console.warn('  WARNING: ' + w));
  return { id, version: manifest.version, file: latest, versioned: join(outDir, id + '-' + manifest.version + '.lpack'), manifest, warnings, size: text.length };
}

/* The assistant's context must never carry an answer: no solution, starter,
   assertion, expected value or answer key anywhere in it. Returns what it found. */
export function contextLeak(ctx) {
  const bad = /^(solution|solutions|starter|assertions?|expected|answer|answers|answerKey|answer_key|value|reference)$/i;
  const walk = (x, path) => {
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const r = walk(x[i], path + '[' + i + ']'); if (r) return r; } return null; }
    if (x && typeof x === 'object') { for (const k of Object.keys(x)) { if (bad.test(k)) return path + '.' + k; const r = walk(x[k], path + '.' + k); if (r) return r; } }
    return null;
  };
  return walk(ctx, 'context');
}

export function courseIds() {
  if (!existsSync(COURSES)) return [];
  return readdirSync(COURSES).filter((d) => !d.startsWith('_') && existsSync(join(COURSES, d, 'course.json')) && statSync(join(COURSES, d)).isDirectory());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = oi >= 0 ? args[oi + 1] : undefined;
  const ids = args.includes('--all') ? courseIds() : args.filter((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1));
  if (!ids.length) { console.error('Usage: node scripts/build-pack.mjs <course> | --all   (courses: ' + courseIds().join(', ') + ')'); process.exit(2); }
  (async () => {
    for (const id of ids) {
      try { await build(id, { out, quiet: args.includes('--quiet') }); }
      catch (e) { console.error('  ' + id + ': ' + e.message); process.exitCode = 1; }
    }
  })();
}
