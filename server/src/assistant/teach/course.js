/* ===========================================================================
   server/src/assistant/teach/course.js — a course's own code and data, in Node.
   ---------------------------------------------------------------------------
   The tutor shows the course's figures, equations and generated problems and
   takes every shown number from the course's own engine. Everything comes from
   the installed pack named in its manifest's `teach` block (teach/pack.js):
   its data files and the scripts that draw figures and generate problems,
   hash-checked and run only from the pack's own folder. Nothing here knows a
   subject. Loaded lazily, once per pack id and version:

     data(pack)      the course's modules (lessons and their readings), formulas
     figures(pack)   the figure registry: names, steps, parts, demos, where used
     engine(pack)    the problem generators: Course.engine.generateValid(template)

   A pack without `teach` (or without the part asked for) gets null.
   =========================================================================== */

import * as teachPack from './pack.js';

export const teachOf = (pack) => teachPack.of(pack);
export const hasFigures = (pack) => { const T = teachPack.of(pack); return !!(T && T.has('figures')); };
export const hasGenerators = (pack) => { const T = teachPack.of(pack); return !!(T && T.has('generators')); };
/* the pack has something for the teaching tools to teach from */
export const available = (pack) => { const T = teachPack.of(pack); return !!(T && (T.has('figures') || T.has('generators') || T.has('glossary'))); };

/* the modules (lessons and their readings) and formulas, read once */
export function data(pack) {
  const T = teachPack.of(pack);
  if (!T) return { modules: [], lessons: {}, formulas: {} };
  if (T.mem.data) return T.mem.data;
  const modules = T.data('modules') || [];
  const eq = ((T.data('equations') || {}).formulas) || {};
  const lessons = {};
  const formulas = {};
  for (const m of modules) {
    for (const l of m.lessons || []) lessons[l.id] = { id: l.id, title: l.title, module: m.n, moduleTitle: m.title, objective: l.objective, video: l.video || null, reading: l.reading || '' };
    for (const s of ['overview', 'summary']) if (m[s] && typeof m[s] === 'object' && m[s].id) lessons[m[s].id] = { id: m[s].id, title: m[s].title || s, module: m.n, moduleTitle: m.title, video: null, reading: m[s].reading || m[s].content || '' };
    for (const f of m.key_formulas || []) if (f.id) formulas[f.id] = { id: f.id, module: m.n, name: f.name, form: f.formula, variables: f.variables, video: f.video || null, demo: f.demo || null, eq: eq[f.id] || {} };
  }
  return (T.mem.data = { modules, lessons, formulas });
}

/* the figure registry, with where each is used in the readings */
export function figures(pack) {
  const T = teachPack.of(pack);
  if (!T || !T.has('figures')) return null;
  if (T.mem.figures) return T.mem.figures;
  const g = { Course: { data: {} } };
  T.load(T.cfg.figures.load, g);
  const V = g.Course.video;
  const uses = {};
  const note = (name, u) => { (uses[name] = uses[name] || []).push(u); };
  const d = data(pack);
  const re = /^[ \t]*\[(figure|demo):([\w-]+)[ \t]*(.*)\][ \t]*$/gm;
  for (const l of Object.values(d.lessons)) {
    let m;
    while ((m = re.exec(l.reading))) {
      const q = /"([^"]*)"\s*$/.exec(m[3]);
      let params = {};
      const j = m[3].replace(/"([^"]*)"\s*$/, '').trim();
      if (j.charAt(0) === '{') { try { params = JSON.parse(j); } catch (e) { params = {}; } }
      note(m[2], { ref: l.id, lesson: l.title, module: l.module, kind: m[1], caption: q ? q[1] : '', params });
    }
  }
  for (const f of Object.values(d.formulas)) if (f.demo && f.demo.figure) note(f.demo.figure, { ref: null, formula: f.id, lesson: f.name, module: f.module, kind: 'demo', caption: f.demo.caption || '', params: f.demo.params || {} });
  return (T.mem.figures = { V, uses, drawing: g.Course.drawing });
}

/* the generators */
export function engine(pack) {
  const T = teachPack.of(pack);
  if (!T || !T.has('generators')) return null;
  if (T.mem.engine) return T.mem.engine;
  const g = { Course: { data: { modules: [], questions: [], templates: T.data('templates') || [], flashcards: [], glossary: [], references: { docs: [], chunks: [] } } } };
  T.load(T.cfg.generators.load, g);
  return (T.mem.engine = { C: g.Course, templates: g.Course.data.templates });
}

const PART_RE = /data-part="([^"]+)"/g;
/* the named parts of a figure (with the words drawn inside each) and its steps */
export function describeFigure(pack, name, params) {
  const F = figures(pack);
  if (!F) return null;
  const { V, uses } = F;
  const f = V.figures[name];
  if (!f) return null;
  let svg = '';
  try { svg = V.renderFigure(name, params || {}); } catch (e) { return { error: 'This figure could not be drawn with those parameters: ' + e.message }; }
  const parts = [];
  const seen = new Set();
  for (const m of svg.matchAll(PART_RE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    // the words in the group that starts here
    const start = svg.lastIndexOf('<', m.index);
    let depth = 0, i = start, end = svg.length;
    const tag = /<(\/?)g\b[^>]*>/g;
    tag.lastIndex = start;
    let t;
    while ((t = tag.exec(svg))) { depth += t[1] ? -1 : 1; if (depth <= 0) { end = tag.lastIndex; break; } i = tag.lastIndex; }
    const words = [...svg.slice(start, end).matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim()).filter(Boolean).slice(0, 3);
    parts.push(words.length ? { id: m[1], labels: words } : { id: m[1] });
  }
  const stepKeys = Object.keys(f.opts.steps || {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const st = f.opts.stepText || {};
  const stepText = (k) => { let x = st[k]; if (typeof x === 'function') { try { x = x(params || {}); } catch (e) { x = ''; } } return String(x || ''); };
  return {
    id: name, parts: parts.slice(0, 40), steps: stepKeys.map((k) => ({ n: stepKeys.indexOf(k) + 1, key: k, says: stepText(k).slice(0, 220) })),
    hasDemo: !!f.opts.demo, opening: stepText(0).slice(0, 200), where: (uses[name] || []).slice(0, 3),
  };
}
