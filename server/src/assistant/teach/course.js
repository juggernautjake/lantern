/* ===========================================================================
   server/src/assistant/teach/course.js — the FS course's own code, in Node.
   ---------------------------------------------------------------------------
   The tutor shows the course's figures, equations and generated problems and
   takes every shown number from the course's own engine. The code is the
   course kit in app/ (shipped with Lantern, never read from a pack: a friend's
   pack cannot run code here). Loaded lazily and once:

     figures()   the figure registry (video.js + figures/m*.js): names, steps,
                 parts, whether a figure has a demonstration
     engine()    the problem generators (engine.js + content.js with the 1,087
                 templates): Course.engine.generateValid(template)

   Only the FS course has them (app/fs). Any other course gets null.
   =========================================================================== */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.LANTERN_APP_ROOT || join(HERE, '..', '..', '..', '..', 'app');
const FS = join(APP, 'fs');
export const available = () => existsSync(join(FS, 'data', 'equations.json'));
export const fsRoot = () => FS;

const rd = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(rd(p));
function run(g, rels) {
  for (const m of rels) new Function('globalThis', 'var Course = globalThis.Course;\n' + rd(join(APP, m)))(g);
}

let FIG = null, ENG = null, DATA = null;

/* modules.json, equations.json (read once) */
export function data() {
  if (DATA) return DATA;
  const modules = json(join(FS, 'data', 'modules.json'));
  const eq = json(join(FS, 'data', 'equations.json')).formulas || {};
  const lessons = {};
  const formulas = {};
  for (const m of modules) {
    for (const l of m.lessons || []) lessons[l.id] = { id: l.id, title: l.title, module: m.n, moduleTitle: m.title, objective: l.objective, video: l.video || null, reading: l.reading || '' };
    for (const s of ['overview', 'summary']) if (m[s] && typeof m[s] === 'object' && m[s].id) lessons[m[s].id] = { id: m[s].id, title: m[s].title || s, module: m.n, moduleTitle: m.title, video: null, reading: m[s].reading || m[s].content || '' };
    for (const f of m.key_formulas || []) if (f.id) formulas[f.id] = { id: f.id, module: m.n, name: f.name, form: f.formula, variables: f.variables, video: f.video || null, demo: f.demo || null, eq: eq[f.id] || {} };
  }
  return (DATA = { modules, lessons, formulas });
}

/* the figure registry, with where each is used in the readings */
export function figures() {
  if (FIG) return FIG;
  const g = { Course: { data: {} } };
  const figs = readdirSync(join(FS, 'figures')).filter((f) => /^m\d+\.js$/.test(f)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)).map((f) => 'fs/figures/' + f);
  run(g, ['course/markdown.js', 'fs/diagrams.js', 'course/engine.js', 'course/video.js', 'course/drawing.js'].concat(figs));
  const V = g.Course.video;
  const uses = {};
  const note = (name, u) => { (uses[name] = uses[name] || []).push(u); };
  const d = data();
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
  return (FIG = { V, uses, drawing: g.Course.drawing });
}

/* the generators */
export function engine() {
  if (ENG) return ENG;
  const g = { Course: { data: { modules: [], questions: [], templates: json(join(FS, 'data', 'templates.json')), flashcards: [], glossary: [], references: { docs: [], chunks: [] } } } };
  run(g, ['course/markdown.js', 'fs/diagrams.js', 'course/engine.js', 'course/grader.js', 'fs/content.js']);
  return (ENG = { C: g.Course, templates: g.Course.data.templates });
}

const PART_RE = /data-part="([^"]+)"/g;
/* the named parts of a figure (with the words drawn inside each) and its steps */
export function describeFigure(name, params) {
  const { V, uses } = figures();
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
