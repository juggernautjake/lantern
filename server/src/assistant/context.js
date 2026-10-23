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
import { summary as quizSummary } from './review.js';
import * as study from './study.js';
import * as knowledge from './knowledge.js';

/* ---------------------------------------------------------------- where --- */

/* The page open right now, as the shell last reported it: { course, ref, kind,
   title, module, text }. text is the reading on the page, sent only by a
   course for a reading page (never for a check, an exam or an exercise). */
let here = { course: null, ref: null, kind: null, title: null, module: null, text: null, at: 0 };
const cap = (s, n) => (typeof s === 'string' && s.trim() ? s.slice(0, n) : null);
export function setHere(h) {
  const kind = h.kind || null;
  const text = /check|exam|quiz|test|exercise/i.test(String(kind || '')) ? null : cap(h.text, 24000);
  here = { course: h.course || null, ref: h.ref || null, kind, title: h.title || null, module: cap(h.module, 200), text, at: Date.now() };
  return here;
}
export const where = () => Object.assign({}, here);
/* The reading open now, when the course sent it: { title, module, text } or null. */
export function reading(courseId) {
  if (!here.text || (courseId && here.course !== courseId)) return null;
  return { title: here.title, module: here.module, text: here.text };
}

/* ------------------------------------------------------------ the look --- */

/* What is on the learner's screen when they asked (app/course/host.js, sent
   by the panel with the message): the page, the part of the reading in view,
   the video and its second, the question in front of them, the open panels,
   the flashcard, and the course's own ranking of their topics. Cut to size
   and to shape here, whatever the page sent. On a check or an exam the
   question's wording is dropped again, as a second guard behind the page's. */
let look = null;
const s = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, n) : null);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null; };
export const GRADED_KIND = /check|exam|quiz|test|assessment/i;
export function cleanLook(raw, kindHint) {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw.page && typeof raw.page === 'object' ? raw.page : {};
  const page = { id: s(p.id, 90), kind: s(p.kind, 30), title: s(p.title, 160), module: s(p.module, 160) };
  const graded = GRADED_KIND.test(String(page.kind || '')) || GRADED_KIND.test(String(kindHint || ''));
  const out = { page, at: Date.now() };
  out.inView = s(raw.inView, 200);
  const v = raw.video && typeof raw.video === 'object' ? raw.video : null;
  if (v && s(v.id, 40)) out.video = { id: s(v.id, 40), title: s(v.title, 200), t: num(v.t, 0, 36000) || 0, seconds: num(v.seconds, 0, 36000) || 0, chapter: s(v.chapter, 160), playing: !!v.playing };
  const q = raw.question && typeof raw.question === 'object' ? raw.question : null;
  if (q) {
    if (graded || q.graded) out.question = { graded: true, n: s(q.n, 20) };
    else out.question = { graded: false, n: s(q.n, 20), type: s(q.type, 30), text: s(q.text, 1200), choices: (Array.isArray(q.choices) ? q.choices : []).slice(0, 10).map((c) => s(c, 200)).filter(Boolean), answered: !!q.answered };
  }
  out.panels = (Array.isArray(raw.panels) ? raw.panels : []).slice(0, 6).map((x) => s(x, 120)).filter(Boolean);
  const c = raw.card && typeof raw.card === 'object' ? raw.card : null;
  if (c && s(c.front, 200)) out.card = { front: s(c.front, 200), turned: !!c.turned, back: c.turned ? s(c.back, 600) : null };
  out.standing = cleanStanding(raw.standing);
  return out;
}
export function cleanStanding(st) {
  if (!st || typeof st !== 'object') return null;
  const row = (r) => ({ id: s(r && r.id, 90), title: s(r && r.title, 140), module: num(r && r.module, 0, 999), pct: r && r.pct != null ? num(r.pct, 0, 100) : null,
    seen: num(r && r.seen, 0, 1e6) || 0, recent: (s(r && r.recent, 12) || '').replace(/[^01u]/g, ''), ref: s(r && r.ref, 90), heading: s(r && r.heading, 160) });
  const list = (a, n) => (Array.isArray(a) ? a : []).slice(0, n).filter((r) => r && typeof r === 'object' && s(r.title, 140)).map(row);
  return {
    from: s(st.from, 40), weak: list(st.weak, 8), strong: list(st.strong, 6), tried: num(st.tried, 0, 1e5) || 0,
    read: num(st.read, 0, 1e5), videosWatched: num(st.videosWatched, 0, 1e5), cardsDue: num(st.cardsDue, 0, 1e5),
    bestMock: st.bestMock && typeof st.bestMock === 'object' ? { percent: num(st.bestMock.percent, 0, 100), at: num(st.bestMock.at, 0, 1e14) } : null,
    checks: (Array.isArray(st.checks) ? st.checks : []).slice(0, 30).map((x) => ({ module: num(x && x.module, 0, 999), title: s(x && x.title, 120), best: num(x && x.best, 0, 100), runs: num(x && x.runs, 0, 1e4) })),
  };
}
/* Set with each message (null: the page did not answer). The standing is also
   kept per course, so "what should I work on?" asked from another page is
   answered from the course's own numbers, with their date. */
export function setLook(raw, courseId) {
  look = cleanLook(raw, here.kind);
  const id = courseId || here.course;
  if (look && look.standing && id) settings.set('assistant.standing.' + id, Object.assign({ at: Date.now() }, look.standing));
  return look;
}
export const currentLook = () => look;
export function lastStanding(courseId) {
  const live = look && look.standing && (!courseId || here.course === courseId) ? Object.assign({ at: look.at, live: true }, look.standing) : null;
  return live || (courseId ? settings.get('assistant.standing.' + courseId, null) : null);
}

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

/* The learner's own notes in a course (app/course/notes.js): any storage key
   the pack lists that ends in "-notes". Newest first. Their words, not the
   course's, so they are data like everything else here. */
export function notesOf(uid, pack) {
  if (!pack) return [];
  const keys = ((pack.manifest.storage && pack.manifest.storage.keys) || []).filter((k) => /-notes$/.test(k));
  if (!keys.length) return [];
  let st = {};
  try { st = progress.stateForPlayer(uid, pack, {}).keys || {}; } catch (e) { return []; }
  const out = [];
  for (const k of keys) {
    let s = null;
    try { s = st[k] ? JSON.parse(st[k]) : null; } catch (e) { s = null; }
    const notes = s && s.notes && typeof s.notes === 'object' ? Object.values(s.notes) : [];
    for (const n of notes) {
      if (!n || typeof n !== 'object') continue;
      out.push({ id: String(n.id || ''), title: String(n.title || 'Untitled note').slice(0, 120), body: String(n.body || '').slice(0, 100000),
        updated: Number(n.updated) || 0, created: Number(n.created) || 0, page: n.refTitle ? String(n.refTitle).slice(0, 120) : null });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}
const flat = (s) => String(s || '').replace(/^#{1,3}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
/* What the assistant is told about the notes without asking: names, dates,
   and the start of each. read_notes gives the whole of any of them. */
export function notesIndex(uid, pack) {
  const hasNotes = !!pack && ((pack.manifest.storage && pack.manifest.storage.keys) || []).some((k) => /-notes$/.test(k));
  if (!hasNotes) return null;                       // a course without a notes panel
  const all = notesOf(uid, pack);
  if (!all.length) return { count: 0, list: [] };
  return { count: all.length, list: all.slice(0, 25).map((n) => ({ title: n.title, edited: n.updated ? new Date(n.updated).toISOString().slice(0, 10) : null,
    page: n.page, words: flat(n.body) ? flat(n.body).split(' ').length : 0, start: flat(n.body).slice(0, 160) })) };
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
    // a reading lesson (the FS course lists its lessons as kind "lesson") is not a graded item
    exercise: item && item.kind !== 'lesson' ? { id: item.id, kind: item.kind, title: item.title, prompt: item.prompt || '', passed: item.passed, attempts: item.attempts, hintsTaken: hintsTaken(uid, pack, item), hintsTotal: (item.hints || []).length } : null,
    progress: { percent: ov.percent, finished: ov.finished, count: ov.count, lessons: ov.lessons, current: ov.current || null, next: ov.next || null, continue: ov.continue || null, minutesLeft: ov.minutesLeft },
    reading: !ref || ref === here.ref ? reading(pack.id) : null,
    quizzes: quizSummary(uid, pack.id),
    notes: notesIndex(uid, pack),
    notation: shownNotation(pack, study.notation(pack)),
    video: (() => { const v = study.videoScript(pack, at); return v ? { id: v.id, title: v.title, chapters: v.chapters } : null; })(),
    look: look && (!here.course || here.course === pack.id) ? look : null,
    knowledge: knowledge.has(pack),
    where: Object.assign(where(), { text: undefined }),
  };
}

/* The number a learner sees for a course's own module id n. A unit's n is the number
   shown (its place in the course); its id is 'u' + the module's id, which stays put when
   modules are shown in another order (FS: docs/dev/fs-reorder-plan.md). */
export function shownModule(pack) {
  const units = (pack && pack.manifest && pack.manifest.units) || [];
  return (n) => { if (n == null) return n; const u = units.find((x) => x.id === 'u' + n); return u && u.n != null ? u.n : n; };
}

/* The notation guide with each symbol's per-module meanings labelled by the module number
   the learner sees (byModule stays keyed by the module's id). */
function shownNotation(pack, entries) {
  if (!entries) return entries;
  const shown = shownModule(pack);
  return entries.map((e) => {
    if (!e.byModule || !Object.keys(e.byModule).length) return e;
    const meaning = Object.entries(e.byModule).map(([k, t]) => [shown(Number(k)), t]).sort((a, b) => a[0] - b[0]).map(([k, t]) => 'Module ' + k + ': ' + t).join(' · ');
    return Object.assign({}, e, { meaning });
  });
}

/* Units and lessons, for "open unit 3" and friends. "Lesson K" is the K-th lesson as
   shown, not counting a unit's overview or summary page. */
const lessonsOnly = (u) => (u.lessons || []).filter((l) => !/-(overview|summary)$/.test(l.id));
export function findTarget(pack, words) {
  const w = String(words || '').toLowerCase().trim();
  const units = pack.manifest.units || [];
  let m = /^(?:unit|module|chapter)\s+(\d+)$/.exec(w);
  if (m) { const u = units.find((x) => Number(x.n) === Number(m[1])); return u ? { ref: (u.lessons[0] || {}).id || null, title: 'Unit ' + u.n + ': ' + u.title } : null; }
  m = /^(?:unit|module)\s+(\d+)\s*,?\s*lesson\s+(\d+)$/.exec(w);
  if (m) { const u = units.find((x) => Number(x.n) === Number(m[1])); const l = u && lessonsOnly(u)[Number(m[2]) - 1]; return l ? { ref: l.id, title: l.title } : null; }
  m = /^lesson\s+(\d+)$/.exec(w);
  if (m) {
    const cur = here.ref ? units.find((u) => u.lessons.some((l) => l.id === here.ref)) : units[0];
    const l = cur && lessonsOnly(cur)[Number(m[1]) - 1];
    return l ? { ref: l.id, title: l.title } : null;
  }
  for (const u of units) for (const l of u.lessons || []) if (l.id.toLowerCase() === w || l.title.toLowerCase() === w) return { ref: l.id, title: l.title };
  for (const u of units) for (const l of u.lessons || []) if (w.length > 3 && l.title.toLowerCase().includes(w)) return { ref: l.id, title: l.title };
  return null;
}
