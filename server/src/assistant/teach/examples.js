/* ===========================================================================
   server/src/assistant/teach/examples.js — worked examples with right numbers.
   ---------------------------------------------------------------------------
   The model never does the arithmetic of a shown answer. worked_example runs
   one of the course's own problem generators (Course.engine.generateValid, the
   same code the practice sets use) with fresh numbers and hands back the
   question, every step's computed result and the answer, plus the generator's
   own diagram. law_basis gathers the lessons a land-law or boundary scenario
   must rest on and marks what is Texas-specific.
   =========================================================================== */

import * as course from './course.js';
import { words } from '../knowledge.js';

const tagsOf = (t) => (Array.isArray(t.tags) ? t.tags.map(String) : []);
const jurisdictionOf = (t) => { const j = tagsOf(t).find((x) => /^jurisdiction:/i.test(x)); return j ? j.split(':')[1].toUpperCase() : null; };
const clean = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').trim();

export function search(topic, limit) {
  const q = words(topic);
  if (!q.length) return [];
  const { templates } = course.engine();
  const out = [];
  for (const t of templates) {
    const head = new Set(words([t.name, t.subcategory, t.category, tagsOf(t).join(' '), t.description].join(' ')));
    const body = new Set(words(t.question_template || ''));
    let s = 0;
    for (const w of q) { if (head.has(w)) s += 3; else if (body.has(w)) s += 1; }
    if (s >= Math.min(3, q.length * 3)) out.push({ t, s });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit || 5).map((x) => x.t);
}

const hide = (t) => ({ key: t.key, name: t.name, sub: t.subcategory, type: t.question_type, jurisdiction: jurisdictionOf(t) });

/* topic (words) or key (a generator's key from an earlier call) */
export function generate(inp) {
  if (!course.available()) return { error: 'This course has no problem generators.' };
  const { C, templates } = course.engine();
  let t = inp.key ? templates.find((x) => x.key === inp.key) : null;
  let others = [];
  if (!t) {
    const hits = search(inp.topic, 5);
    if (!hits.length) return { error: 'No generator matches "' + (inp.topic || '') + '". Try the course words (differential leveling, horizontal curve, traverse closure, EDM, cut and fill…).' };
    t = hits[0];
    others = hits.slice(1).map(hide);
  }
  const p = C.engine.generateValid(t);
  if (!p) return { error: 'The generator could not draw a problem; try another.' };
  const steps = (p.solution_steps || []).map((s) => ({ n: s.step_number, title: clean(s.title), calculation: clean(s.calculation), result: clean(s.result) })).filter((s) => s.title || s.calculation || s.result);
  const vars = {};
  for (const [k, v] of Object.entries(p.vars || {})) if (typeof v === 'number' || typeof v === 'string') vars[k] = v;
  const question = clean(String(p.question_text || '').replace(/<[^>]+>/g, ' '));
  const answer = p.correct_answer + (p.unit ? ' ' + p.unit : '');
  const out = {
    generator: hide(t), question, answer, unit: p.unit || '', steps, given: vars,
    explanation: clean(p.explanation).slice(0, 900), hasFigure: !!(p.diagram || p.solution_diagram),
    note: 'Every number above was computed by the course\'s own engine. Quote them exactly; do your own arithmetic on nothing shown.', other_generators: others.length ? others : undefined,
  };
  return { out, card: { kind: 'example', title: t.name, question, steps: steps.slice(0, 10), answer, svg: p.solution_diagram || p.diagram || '', jurisdiction: jurisdictionOf(t) } };
}

/* land law and boundary: the lessons to rest a scenario on */
export function lawBasis(topic) {
  const q = words(topic);
  const D = course.data();
  const rows = Object.values(D.lessons).map((l) => {
    const head = new Set(words(l.title + ' ' + (l.objective || '')));
    const body = new Set(words(l.reading.slice(0, 6000)));
    let s = 0;
    for (const w of q) { if (head.has(w)) s += 3; else if (body.has(w)) s += 1; }
    return { l, s };
  }).filter((x) => x.s >= 3).sort((a, b) => b.s - a.s).slice(0, 4);
  const texas = (txt) => /\btexas\b|\bTX\b|vara|general land office|\bGLO\b|spanish|mexican grant/i.test(txt);
  const lessons = rows.map(({ l }) => {
    const paras = l.reading.split(/\n\s*\n/).map((p) => clean(p.replace(/\[(figure|demo|video):[^\]]*\]/g, '').replace(/^#+\s*/, ''))).filter((p) => p.length > 60);
    const pick = paras.filter((p) => q.some((w) => words(p).includes(w))).slice(0, 3);
    return { ref: l.id, lesson: l.title, module: l.module, texasSpecific: texas(l.reading), says: (pick.length ? pick : paras.slice(0, 2)).map((p) => p.slice(0, 380)) };
  });
  const tagged = course.available() ? search(topic, 8).filter((t) => jurisdictionOf(t)).map(hide) : [];
  if (!lessons.length) return { error: 'No lesson covers "' + topic + '".' };
  return { out: { lessons, texas_tagged_practice: tagged,
    how: 'Write a short realistic scenario (names, a place, dates, calls) that applies ONLY what these lessons say. Cite each lesson by title. Say plainly which rule is US-general and which is Texas-specific (texasSpecific lessons, jurisdiction:TX items). If the lessons do not settle it, say so; do not invent a rule.' } };
}
