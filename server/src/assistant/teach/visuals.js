/* ===========================================================================
   server/src/assistant/teach/visuals.js — what is already built, found fast.
   ---------------------------------------------------------------------------
   find(query)        figures, equations and lesson passages that fit
   figureCard(...)    a figure, a demonstration, an equation, a passage: each
                      checked against the course's own data and described to
                      the model (parts, steps, symbols) so its cues can name
                      them. The page draws them with the course's own code.
   =========================================================================== */

import * as course from './course.js';
import { words } from '../knowledge.js';

const score = (q, text) => { const hay = text instanceof Set ? text : new Set(words(text)); let s = 0; for (const w of q) if (hay.has(w)) s += 1; return s; };
/* word sets of every figure, equation and lesson, built once */
/* the pack being taught from: set by each entry point (all synchronous) */
let P = null;
const figReg = () => course.figures(P) || { V: { figures: {} }, uses: {}, drawing: null };
const IXS = new Map();
function index() {
  const key = P.id + "@" + P.version;
  if (IXS.has(key)) return IXS.get(key);
  let IX;
  const D = course.data(P);
  const { V, uses } = figReg();
  IX = {
    figs: Object.keys(V.figures).map((id) => { const u = uses[id] || []; return { id, u, set: new Set(words(id.replace(/([A-Z])/g, ' $1') + ' ' + u.map((x) => x.caption + ' ' + x.lesson).join(' '))) }; }),
    eqs: Object.values(D.formulas).map((f) => ({ f, set: new Set(words(f.name + ' ' + f.form + ' ' + (f.eq.means || '') + ' ' + (f.eq.use || ''))) })),
    les: Object.values(D.lessons).map((l) => ({ l, head: new Set(words(l.title + ' ' + (l.objective || ''))), body: new Set(words(l.reading.slice(0, 2500))) })),
  };
  IXS.set(key, IX);
  return IX;
}
const plain = (s) => String(s || '').replace(/\[(figure|demo|video):[^\]]*\]/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

export function find(pack, query) {
  P = pack;
  const q = words(query);
  if (!q.length) return { figures: [], equations: [], passages: [] };
  const D = course.data(P);
  const { V, uses } = figReg();
  const ix = index();
  const figs = ix.figs.map(({ id, u, set }) => ({ id, s: score(q, set) * (u.length ? 1.2 : 1), u })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => ({ id: x.id, shown_in: x.u[0] ? x.u[0].lesson + ' (' + x.u[0].ref + ')' : null, caption: x.u[0] ? x.u[0].caption.slice(0, 160) : null, demo: !!V.figures[x.id].opts.demo, steps: Object.keys(V.figures[x.id].opts.steps || {}).length }));
  const eqs = ix.eqs.map(({ f, set }) => ({ f, s: score(q, set) }))
    .filter((x) => x.s >= Math.min(2, q.length)).sort((a, b) => b.s - a.s).slice(0, 4)
    .map((x) => ({ id: x.f.id, name: x.f.name, form: x.f.form, module: x.f.module }));
  const pass = ix.les.map(({ l, head, body }) => ({ l, s: score(q, head) * 2 + score(q, body) })).filter((x) => x.s > 1).sort((a, b) => b.s - a.s).slice(0, 3)
    .map((x) => ({ ref: x.l.id, title: x.l.title, module: x.l.module }));
  return { figures: figs, equations: eqs, passages: pass };
}

/* the lesson a figure, equation or passage opens in */
function lessonLink(ref) { const l = ref && course.data(P).lessons[ref]; return l ? { ref, title: l.title, module: l.module } : null; }

export function figure(pack, id, params, wantDemo) {
  P = pack;
  const d = course.describeFigure(P, String(id), params);
  if (!d) return { error: 'No figure called "' + id + '". Use find_visuals for ids.' };
  if (d.error) return { error: d.error };
  if (wantDemo && !d.hasDemo) return { error: 'The figure "' + id + '" has no interactive demonstration. Use show_figure.' };
  const first = d.where[0] || null;
  return { d, card: { kind: wantDemo ? 'demo' : 'figure', fid: d.id, params: params || (first && first.params) || {}, title: first ? first.lesson : d.id, home: lessonLink(first && first.ref) } };
}

export function equation(pack, idOrQuery) {
  P = pack;
  const D = course.data(P);
  let f = D.formulas[String(idOrQuery)];
  if (!f) { const r = find(P, String(idOrQuery)).equations[0]; f = r && D.formulas[r.id]; }
  if (!f) return { error: 'No equation matches "' + idOrQuery + '". Use find_visuals.' };
  const e = f.eq;
  const symbols = (e.symbols || []).map((s) => ({ sym: s[0], meaning: s[1] }));
  const home = Object.values(D.lessons).find((l) => l.module === f.module && /summary|formula/i.test(l.id + l.title)) || null;
  const out = { id: f.id, name: f.name, form: f.form, symbols, means: e.means || null, when: e.when || null, how: e.how || null, derive: e.derive || null, hook: e.hook || null };
  return { out, card: { kind: 'equation', eid: f.id, name: f.name, form: f.form, symbols: symbols.map((s) => s.sym), module: f.module, home: home ? lessonLink(home.id) : null, video: f.video } };
}

export function passage(pack, ref, heading) {
  P = pack;
  const l = course.data(P).lessons[String(ref)];
  if (!l) return { error: 'No lesson called "' + ref + '". Use find_visuals for refs.' };
  const text = l.reading;
  // cards are split at headings; pick the one that fits the heading, else the first
  const parts = text.split(/\n(?=#{2,3} )/).filter((p) => plain(p).length > 40);
  const hq = words(heading || '');
  let best = parts[0] || text, bs = -1;
  if (hq.length) for (const p of parts) { const s = score(hq, p.split('\n')[0]) * 3 + score(hq, p); if (s > bs) { bs = s; best = p; } }
  const head = (/^#{2,3} (.+)/.exec(best) || [])[1] || l.title;
  const md = best.replace(/^[ \t]*\[(figure|demo|video):[^\]]*\][ \t]*$/gm, '').trim().slice(0, 1800);
  return { out: { ref: l.id, lesson: l.title, heading: head, text: plain(md).slice(0, 900) }, card: { kind: 'passage', ref: l.id, heading: head, md, title: l.title, module: l.module, home: lessonLink(l.id) } };
}
