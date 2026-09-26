/* ===========================================================================
   server/src/assistant/context.js — what the assistant knows about "this".
   ---------------------------------------------------------------------------
   The assistant never sees an answer. Everything here comes from three
   places, none of which holds one:

     the pack's manifest          units, lessons, objectives, key terms, takeaways
     context/exercises.json       each graded item's prompt and its authored hints
                                  (build-pack refuses a pack whose context has a
                                  solution, a starter or an assertion in it)
     the learner's own progress   which items are passed, how many hints they
                                  took, and — ONLY when they ask for a review —
                                  the code they wrote

   Where the learner is comes from the player (the course page tells the shell
   which page is open; the shell tells the server through /api/activity) or
   from the last place progress was saved.
   =========================================================================== */

import { readFileSync } from 'node:fs';
import * as packs from '../platform/packs.js';
import * as progress from '../platform/progress.js';
import * as engine from '../platform/sync/engine.js';
import * as settings from '../platform/settings.js';
import { learningContext } from '../platform/routes.js';

/* ---------------------------------------------------------------- where --- */

/* The page open right now, as the shell last reported it: { course, ref, kind, title }. */
let here = { course: null, ref: null, kind: null, title: null, at: 0 };
export function setHere(h) {
  here = { course: h.course || null, ref: h.ref || null, kind: h.kind || null, title: h.title || null, at: Date.now() };
  return here;
}
export const where = () => Object.assign({}, here);

/* The course to talk about: the one open, else the last one studied, else the only one. */
export function currentPack(courseId) {
  const id = courseId || here.course || (engine.activity() || {}).course;
  if (id && packs.get(id)) return packs.get(id);
  const all = packs.list();
  return all.length === 1 ? all[0] : null;
}

/* ----------------------------------------------------------- pack files --- */

const jsonCache = new Map();   // file path → { at, data }
function packJson(pack, rel) {
  const f = packs.fileFor(pack.id, rel);
  if (!f) return null;
  const c = jsonCache.get(f);
  if (c) return c.data;
  let data = null;
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { data = null; }
  jsonCache.set(f, { at: Date.now(), data });
  return data;
}
export const exercisesOf = (pack) => ((packJson(pack, 'context/exercises.json') || {}).items || []);
export const resourcesOf = (pack) => packJson(pack, 'context/resources.json') || null;

/* --------------------------------------------------------- the state ---- */

/* The course's own saved state (its progress key), parsed. */
export function packState(uid, pack) {
  const m = pack.manifest.progress || {};
  if (!m.key) return {};
  try {
    const st = progress.stateForPlayer(uid, pack, {});
    const raw = st.keys && st.keys[m.key];
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function itemState(uid, pack, id) {
  const m = pack.manifest.progress || {};
  const s = packState(uid, pack);
  const ex = (s[m.exercises || 'exercises'] || {})[id] || null;
  const ms = (s[m.milestones || 'projects'] || {})[id] || null;
  const rec = ex || ms || {};
  return {
    passed: !!(rec[m.exercisePassed || 'passed'] || rec.passed),
    attempts: Number(rec[m.exerciseAttempts || 'attempts'] || rec.attempts || 0),
    hintsInCourse: Number(rec.hints || 0),
  };
}

/* The learner's own code for an item: only for a review they asked for. */
export function learnerCode(uid, pack, id) {
  const m = pack.manifest.progress || {};
  const s = packState(uid, pack);
  const code = (s[m.code || 'code'] || {})[id];
  return typeof code === 'string' ? code : null;
}

/* ------------------------------------------------------------ the item --- */

/* The graded item in front of the learner: on a lesson, the first exercise
   they have not passed yet (or the last one, when all are passed); on a check,
   the check; on a project, its first unpassed milestone. */
export function currentItem(uid, pack, ref) {
  const items = exercisesOf(pack);
  const at = ref || here.ref || ((progress.summary(uid, pack).current || {}).ref) || null;
  if (!at) return null;
  const direct = items.find((i) => i.id === at);
  if (direct) return Object.assign({}, direct, itemState(uid, pack, direct.id));
  const inLesson = items.filter((i) => i.lesson === at || i.project === at);
  if (!inLesson.length) return null;
  const withState = inLesson.map((i) => Object.assign({}, i, itemState(uid, pack, i.id)));
  return withState.find((i) => !i.passed) || withState[withState.length - 1];
}

/* Is the learner in something that is marked, where hints are not given? */
export function isAssessment(item, kind) {
  const k = String(kind || here.kind || '').toLowerCase();
  return /check|exam|quiz|test|assessment/.test(k) || (item && item.kind === 'check');
}

/* ----------------------------------------------------------- the hints --- */

/* How many hints of this item the learner has seen: in the course itself or
   from the assistant, whichever is more. */
const hintKey = (course, id) => 'assistant.hints.' + course + '.' + id;
export function hintsTaken(uid, pack, item) {
  const mine = Number(settings.get(hintKey(pack.id, item.id), 0) || 0);
  return Math.max(mine, Number(item.hintsInCourse || 0));
}

/* The next authored hint, never beyond the one after the last they saw.
   { hint, n, of, rung } or { none: why }. */
export function nextHint(uid, pack, ref, kind) {
  const item = currentItem(uid, pack, ref);
  if (!item) return { none: 'nothing', message: 'There is no exercise on this page, so there is no hint to give. Ask me to explain the lesson instead.' };
  if (isAssessment(item, kind)) return { none: 'assessment', item: item.id, message: 'This is a check, so hints are switched off here. You can review the lessons it covers, and I can explain any of them.' };
  const hints = item.hints || [];
  if (!hints.length) return { none: 'no-hints', item: item.id, message: 'This exercise has no written hints. I can explain the idea behind it instead.' };
  const taken = hintsTaken(uid, pack, item);
  if (taken >= hints.length) return { none: 'used-up', item: item.id, of: hints.length, message: 'You have seen all ' + hints.length + ' hints for this one. Try running it and reading what the checks say, or ask me why it is failing.' };
  const n = taken + 1;
  settings.set(hintKey(pack.id, item.id), n);
  const RUNGS = ['a nudge', 'the idea', 'where to look', 'the shape of it'];
  return { hint: hints[n - 1], n, of: hints.length, rung: RUNGS[n - 1] || 'a hint', item: item.id, title: item.title, passed: item.passed };
}

/* ------------------------------------------------------------ the whole --- */

/* Everything the assistant is told about where the learner is. Nothing in it
   is an answer. */
export function describe(uid, courseId, ref) {
  const pack = currentPack(courseId);
  if (!pack) return { course: null, where: where() };
  const at = ref || (here.course === pack.id ? here.ref : null);
  const lc = learningContext(uid, pack, at);
  const item = currentItem(uid, pack, at || (lc.item && lc.item.id));
  const ov = progress.overview(uid, pack);
  return {
    course: lc.course, unit: lc.unit, item: lc.item,
    kind: (here.course === pack.id && here.kind) || (lc.item && lc.item.kind) || null,
    exercise: item ? { id: item.id, kind: item.kind, title: item.title, prompt: item.prompt || '', passed: item.passed, attempts: item.attempts, hintsTaken: hintsTaken(uid, pack, item), hintsTotal: (item.hints || []).length } : null,
    progress: { percent: ov.percent, finished: ov.finished, count: ov.count, lessons: ov.lessons, current: ov.current || null, next: ov.next || null, continue: ov.continue || null, minutesLeft: ov.minutesLeft },
    where: where(),
  };
}

/* Units and lessons, for "open unit 3" and friends. */
export function findTarget(pack, words) {
  const w = String(words || '').toLowerCase().trim();
  const units = pack.manifest.units || [];
  let m = /^(?:unit|module|chapter)\s+(\d+)$/.exec(w);
  if (m) { const u = units.find((x) => Number(x.n) === Number(m[1])); return u ? { ref: (u.lessons[0] || {}).id || null, title: 'Unit ' + u.n + ': ' + u.title } : null; }
  m = /^(?:unit|module)\s+(\d+)\s*,?\s*lesson\s+(\d+)$/.exec(w);
  if (m) { const u = units.find((x) => Number(x.n) === Number(m[1])); const l = u && u.lessons[Number(m[2]) - 1]; return l ? { ref: l.id, title: l.title } : null; }
  m = /^lesson\s+(\d+)$/.exec(w);
  if (m) {
    const cur = here.ref ? units.find((u) => u.lessons.some((l) => l.id === here.ref)) : units[0];
    const l = cur && cur.lessons[Number(m[1]) - 1];
    return l ? { ref: l.id, title: l.title } : null;
  }
  for (const u of units) for (const l of u.lessons || []) if (l.id.toLowerCase() === w || l.title.toLowerCase() === w) return { ref: l.id, title: l.title };
  for (const u of units) for (const l of u.lessons || []) if (w.length > 3 && l.title.toLowerCase().includes(w)) return { ref: l.id, title: l.title };
  return null;
}
