/* ===========================================================================
   server/src/assistant/knowledge.js — search the whole course, and cite it.
   ---------------------------------------------------------------------------
   A pack may carry context/knowledge.json (courses/<id>/structure.mjs
   knowledge(), written by build-pack under the same no-answers rule as the
   exercises): its readings, glossary, flashcards, formulas with why and when,
   video chapters and where each video is shown, the course reference's
   notation-only inventory with printed pages, and its library of standards.

     search(pack, query, { kinds, limit })   the best passages, each with where
                                             it is from (and a page for the handbook)
     handbook(pack, { query | id | page })   a handbook item: page, form, symbols,
                                             the course's derive/when/how, lessons
     standard(pack, { query | id })          a code or standard: publisher, what
                                             it requires (our words), supplied on
                                             exam day?, and for a public-domain
                                             document the pages of its own text
                                             that match
     videos(pack) / video(pack, id)          every video, with its home lesson
     findVideos(pack, words, { ref })        videos for a topic: titles, chapters,
                                             topics and (when shipped) every word said

   The learner's own copy of a licensed reference (a handbook, a standard) is
   never read here. The inventory records each item in the reference's own
   notation with its printed page, so the assistant can be exact and point to
   the page; the course opens the learner's copy at that page on their device.

   The index is a plain BM25 over words, built once per pack version: a few
   milliseconds a query, no network, no embeddings.
   =========================================================================== */

import * as videoIndex from './teach/videoindex.js';
import { videoDir, libraryIndex, of as teachOf } from './teach/pack.js';
const refNote = (pack, key, fallback) => { const T = teachOf(pack); const r = T && T.cfg.reference; return (r && r[key]) || fallback; };
import { readFileSync } from 'node:fs';
import * as packs from '../platform/packs.js';

const cache = new Map();   // pack id@version → { k, index, … }
function packJson(pack, rel) {
  const f = packs.fileFor(pack.id, rel);
  if (!f) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; }
}

const STOP = new Set('a an and are as at be by can do does for from has have how i in into is it its me my of on or so than that the their them then there these this to was we what when where which who why will with you your about explain tell show'.split(' '));
export function words(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[_^{}*`]/g, '').replace(/[′']/g, '').split(/[^a-z0-9α-ωσδθφλμπ]+/).filter((w) => w && (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/* ------------------------------------------------------------- the index --- */

function build(pack) {
  const key = pack.id + '@' + pack.version;
  if (cache.has(key)) return cache.get(key);
  const kn = packJson(pack, 'context/knowledge.json');
  const lessonTitle = {};
  // entries carry the course's module id; they are labelled with the number the learner sees
  // (a unit's n; its id is 'u' + the module id)
  const unitN = {};
  for (const u of pack.manifest.units || []) if (/^u\d+$/.test(String(u.id))) unitN[String(u.id).slice(1)] = u.n;
  const shown = (n) => (n != null && unitN[n] != null ? unitN[n] : n);
  for (const u of pack.manifest.units || []) for (const l of u.lessons || []) lessonTitle[l.id] = { title: l.title, unit: u.n, unitTitle: u.title };
  const docs = [];
  const add = (d, title, body) => { d.tf = new Map(); const ws = words(title).concat(words(title), words(body)); for (const w of ws) d.tf.set(w, (d.tf.get(w) || 0) + 1); d.len = ws.length; docs.push(d); };
  const out = { kn, docs, lessonTitle, videos: [], byVideo: new Map(), hb: [], hbPages: [], library: [] };
  if (kn) {
    for (const r of kn.readings || []) add({ kind: 'reading', ref: r.ref, title: (r.heading || r.lesson), where: 'Module ' + shown(r.module) + ' · ' + r.lesson + (r.heading ? ' · ' + r.heading : ''), text: r.text }, (r.heading || '') + ' ' + r.lesson, r.text);
    for (const g of kn.glossary || []) add({ kind: 'glossary', title: g.term, where: 'Glossary', text: g.definition }, g.term + ' ' + g.term, g.definition);
    for (const c of kn.cards || []) add({ kind: 'card', title: c.term, where: 'Flashcard' + (c.module ? ' · module ' + shown(c.module) : ''), text: c.definition }, c.term, c.definition);
    for (const f of kn.formulas || []) {
      const text = [f.form, f.means, f.use && 'Use: ' + f.use, f.derive && 'Why it has this form: ' + f.derive, f.when && 'When: ' + f.when, f.how && 'How: ' + f.how, f.hook && 'Remember: ' + f.hook,
        (f.symbols || []).length ? 'Symbols: ' + f.symbols.map((s) => s[0] + ' = ' + s[1]).join('; ') : ''].filter(Boolean).join('\n');
      add({ kind: 'formula', id: f.id, title: f.name, where: 'Formula · module ' + shown(f.module), text, video: f.video }, f.name + ' ' + f.form, text);
    }
    for (const v of kn.videos || []) {
      const text = (v.chapters || []).map((c) => fmt(c.t) + ' ' + c.title + (c.teaches && c.teaches.length ? ' (' + c.teaches.join('; ') + ')' : '')).join('\n');
      const d = { kind: 'video', id: v.id, title: v.title, where: (KIND[v.kind] || 'Video') + (v.module ? ' · module ' + shown(v.module) : ''), text, home: v.home };
      add(d, v.title + ' ' + (v.formula || '') + ' ' + (v.topics || []).join(' '), text);
      out.videos.push(v); out.byVideo.set(v.id, v);
    }
    for (const h of kn.handbook || []) {
      const text = [h.form, (h.symbols || []).map((s) => s.symbol + ': ' + s.meaning).join('; '), h.about, h.examAsks && 'The exam asks: ' + h.examAsks, h.note, h.publisher && 'Published by ' + h.publisher, h.supplied && 'Supplied on exam day: ' + h.supplied].filter(Boolean).join('\n');
      add({ kind: 'handbook', id: h.id, title: h.form, where: cite(h), text, page: h.page, section: h.section }, h.section + ' ' + h.form + ' ' + (h.say || ''), text);
      out.hb.push(h);
    }
    for (const n of kn.handbookNotes || []) add({ kind: 'handbook-notes', title: n.heading, where: 'The course’s handbook guide · ' + n.heading, text: n.text }, n.heading, n.text);
    out.hbPages = kn.handbookPages || [];
    for (const l of kn.library || []) {
      const text = [l.about, l.publisher && 'Published by ' + l.publisher + (l.year ? ' (' + l.year + ')' : ''), l.exam ? 'Supplied with or used for the exam.' : '', l.own ? 'Copyrighted: the learner adds their own copy.' : 'Public domain: in the course library.', l.note].filter(Boolean).join('\n');
      add({ kind: 'library', id: l.id, title: l.title, where: 'Library', text }, l.title, text);
      out.library.push(l);
    }
  } else {
    // an older pack: the video index alone
    const idx = packJson(pack, videoDir(pack) + '/index.json') || {};
    for (const [id, v] of Object.entries(idx)) {
      const vv = { id, title: v.title, kind: v.kind || 'lesson', module: v.module || null, seconds: Math.round(v.duration || 0), chapters: v.chapters || [], topics: v.topics || [], formula: v.formula || null, home: lessonHome(id) };
      out.videos.push(vv); out.byVideo.set(id, vv);
      add({ kind: 'video', id, title: v.title, where: 'Video', text: (v.chapters || []).map((c) => c.title).join('\n'), home: vv.home }, v.title, (v.topics || []).join(' '));
    }
  }
  // BM25 statistics
  out.df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) out.df.set(w, (out.df.get(w) || 0) + 1);
  out.avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  out.N = docs.length;
  cache.clear();               // one pack version kept: a new version replaces it
  cache.set(key, out);
  return out;
}
const lessonHome = (id) => { const m = /^m(\d+)-v(\d+)$/.exec(id); return m ? { ref: 'm' + m[1] + '-l' + m[2], where: 'lesson' } : null; };
const KIND = { lesson: 'Lesson video', formula: 'Formula explained', example: 'Worked example', calc: 'Calculator how-to' };
const fmt = (t) => { t = Math.max(0, Math.round(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
export const cite = (h) => 'Handbook p. ' + String(h.page).replace(/,.*$/, '') + ' — ' + h.section;

export function has(pack) { return !!(pack && build(pack).kn); }

function rank(ix, query, kinds) {
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  const k1 = 1.4, b = 0.7;
  const out = [];
  for (const d of ix.docs) {
    if (kinds && !kinds.includes(d.kind)) continue;
    let s = 0, hit = 0;
    for (const w of q) {
      const f = d.tf.get(w);
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (ix.N - ix.df.get(w) + 0.5) / (ix.df.get(w) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / ix.avg));
    }
    if (!hit) continue;
    s *= 0.6 + 0.4 * (hit / q.length);       // more of the words, better
    out.push({ d, s });
  }
  return out.sort((a, c) => c.s - a.s);
}

function snippet(text, query, n) {
  const t = String(text || '');
  const max = n || 600;
  if (t.length <= max) return t;
  const low = t.toLowerCase();
  let at = -1;
  for (const w of words(query)) { at = low.indexOf(w); if (at >= 0) break; }
  const from = Math.max(0, (at < 0 ? 0 : at) - Math.round(max / 3));
  return (from ? '…' : '') + t.slice(from, from + max) + (from + max < t.length ? '…' : '');
}

/* -------------------------------------------------------------- the API --- */

export function search(pack, query, opts) {
  const o = opts || {};
  if (!pack) return [];
  const ix = build(pack);
  const kinds = Array.isArray(o.kinds) && o.kinds.length ? o.kinds : null;
  const per = {};
  const res = [];
  for (const { d, s } of rank(ix, query, kinds)) {
    // no more than three from one kind, unless that kind was asked for alone
    if (!kinds || kinds.length > 1) { per[d.kind] = (per[d.kind] || 0) + 1; if (per[d.kind] > 3) continue; }
    res.push({ kind: d.kind, title: d.title, where: d.where, ref: d.ref || (d.home && d.home.ref) || null, id: d.id || null, text: snippet(d.text, query, o.chars || 600), score: Math.round(s * 100) / 100 });
    if (res.length >= (o.limit || 8)) break;
  }
  return res;
}

function lessonsOf(ix, refs) { return (refs || []).slice(0, 6).map((r) => ({ ref: r, title: (ix.lessonTitle[r] || {}).title || r })); }

/* A handbook item, with what the course says about it. */
export function handbook(pack, q) {
  const o = q || {};
  if (!pack) return { found: false, message: 'No course is open.' };
  const ix = build(pack);
  if (!ix.hb.length) return { found: false, message: 'This course has no handbook inventory.' };
  let items = [];
  if (o.id) items = ix.hb.filter((h) => h.id === o.id || (h.equations || []).includes(o.id));
  if (!items.length && o.page) { const p = String(o.page).replace(/[^\d].*$/, ''); items = ix.hb.filter((h) => String(h.page).split(/[^\d]/)[0] === p).slice(0, 12); }
  if (!items.length && o.query) items = rank(ix, o.query, ['handbook']).slice(0, 4).map((x) => ix.hb.find((h) => h.id === x.d.id)).filter(Boolean);
  if (!items.length) return { found: false, message: 'Nothing in the handbook inventory matches. Try search_course, or name the section.' };
  const formulas = (ix.kn.formulas || []);
  return {
    found: true,
    note: refNote(pack, 'note', 'Notation and our own descriptions of the course reference. Cite the page exactly as given; the learner opens their own copy there.'),
    items: items.map((h) => {
      const f = formulas.filter((x) => (h.equations || []).includes(x.id)).slice(0, 2);
      const pageRow = ix.hbPages.find((p) => String(p.page).split('–').includes(String(h.page).replace(/[^\d].*$/, '')) || String(p.page) === String(h.page));
      return {
        id: h.id, kind: h.kind, cite: cite(h), page: h.page, section: h.section, form: h.form, symbols: h.symbols, say: h.say,
        about: h.about || undefined, examAsks: h.examAsks || undefined, note: h.note || undefined,
        publisher: h.publisher || undefined, supplied: h.supplied || undefined,
        onThatPage: pageRow ? pageRow.section : undefined,
        course: f.map((x) => ({ id: x.id, name: x.name, form: x.form, means: x.means, derive: x.derive, when: x.when, how: x.how, hook: x.hook, video: x.video })),
        lessons: lessonsOf(ix, (h.lessons && h.lessons.length) ? h.lessons : (h.ref && h.ref.lesson ? [h.ref.lesson] : [])), videos: (h.videos || []).slice(0, 4),
        equation: (h.equations || [])[0] || null,
        // what explains it in the course: the equation card and figure to show (with the labelled parts to cue), when and how it is used, and the generators for a worked example
        show: h.ref ? { show_equation: h.ref.eq || (h.equations || [])[0] || undefined, show_figure: h.ref.figure || undefined, params: h.ref.figureParams, parts: h.ref.parts, lesson: h.ref.lesson || undefined, when: h.ref.when || undefined, how: h.ref.how || undefined } : ((h.equations || [])[0] ? { show_equation: h.equations[0] } : undefined),
        worked_example: (h.generators || []).length ? { keys: h.generators, note: 'worked_example {key} gives fresh numbers from the course engine' } : undefined,
      };
    }),
  };
}

/* A code or standard the exam supplies or the course teaches. */
export function standard(pack, q) {
  const o = q || {};
  if (!pack) return { found: false, message: 'No course is open.' };
  const ix = build(pack);
  const std = ix.hb.filter((h) => h.kind === 'standard');
  let hits = [];
  if (o.id) hits = std.filter((h) => h.id === o.id || h.id === 'std.' + o.id);
  if (!hits.length && o.query) hits = rank(ix, o.query, ['handbook']).map((x) => std.find((h) => h.id === x.d.id)).filter(Boolean).slice(0, 3);
  let docs = [];
  if (o.id) docs = ix.library.filter((l) => l.id === o.id);
  if (!docs.length && o.query) docs = rank(ix, o.query, ['library']).slice(0, 3).map((x) => ix.library.find((l) => l.id === x.d.id)).filter(Boolean);
  if (!hits.length && !docs.length) return { found: false, message: 'No standard or library document matches. Try search_course.' };
  // the public-domain documents' own text, shipped in the pack: the pages that match
  let texts = null;
  const pagesOf = (d) => {
    if (d.own || !o.query) return undefined;
    if (texts === null) texts = packJson(pack, libraryIndex(pack)) || {};
    const pages = texts[d.id] || [];
    const ws = words(o.query).filter((w) => w.length > 2);
    if (!ws.length) return undefined;
    const scored = pages.map((t, i) => { const low = String(t).toLowerCase(); const n = ws.filter((w) => low.includes(w)).length; return { i, n, t }; })
      .filter((x) => x.n >= Math.min(2, ws.length)).sort((a, b) => b.n - a.n).slice(0, 3);
    return scored.map((x) => ({ pdfPage: x.i + 1, text: snippet(x.t, o.query, 700) }));
  };
  return {
    found: true,
    note: refNote(pack, 'standardNote', 'Standards are described in our own words. Quote a public-domain document only from its pages below; for the learner’s own copies point to the section and let them open their copy.'),
    standards: hits.map((h) => ({ id: h.id, title: h.form, publisher: h.publisher, supplied: h.supplied, jurisdiction: h.jurisdiction, about: h.about, examAsks: h.examAsks, cite: cite(h), lessons: lessonsOf(ix, h.lessons) })),
    documents: docs.map((d) => ({ id: d.id, title: d.title, publisher: d.publisher, year: d.year, about: d.about, examSupplied: d.exam, copy: d.own ? 'the learner’s own copy (copyrighted)' : 'public domain, in the course library', modules: d.modules, pages: pagesOf(d) })),
  };
}

export function videos(pack) { return pack ? build(pack).videos : []; }
export function video(pack, id) { return pack ? build(pack).byVideo.get(String(id)) || null : null; }
export function lessonTitle(pack, ref) { return pack ? (build(pack).lessonTitle[ref] || null) : null; }

/* Course videos for a topic. ref: the page they are on (its own videos first). */
let deep = { key: null, data: null };
export function findVideosLexical(pack, query, opts) {
  const o = opts || {};
  if (!pack) return [];
  const ix = build(pack);
  const q = words(query);
  if (!q.length && !o.ref) return [];
  const key = pack.id + '@' + pack.version;
  if (deep.key !== key) deep = { key, data: packJson(pack, videoDir(pack) + '/search.json') || {} };
  const scored = ix.videos.map((v) => {
    const title = words(v.title + ' ' + (v.formula || '')), topics = words((v.topics || []).join(' ')), chaps = words((v.chapters || []).map((c) => c.title + ' ' + (c.teaches || []).join(' ')).join(' '));
    const said = deep.data[v.id] && deep.data[v.id].w ? new Set(String(deep.data[v.id].w).split(' ')) : null;
    let s = 0;
    for (const w of q) s += (title.includes(w) ? 4 : 0) + (topics.includes(w) ? 2 : 0) + (chaps.includes(w) ? 1.5 : 0) + (said && said.has(w) ? 0.5 : 0);
    if (q.length && s > 0) s *= 0.5 + 0.5 * (q.filter((w) => title.includes(w) || topics.includes(w) || chaps.includes(w)).length / q.length);
    if (o.ref && v.home && v.home.ref === o.ref) s += q.length ? 2 : 5;
    if (v.kind === 'lesson') s += 0.3;
    // the chapter that teaches it
    let chapter = null, best = 0;
    for (const c of v.chapters || []) { const cw = words(c.title + ' ' + (c.teaches || []).join(' ')); const n = q.filter((w) => cw.includes(w)).length; if (n > best) { best = n; chapter = c; } }
    return { v, s, chapter };
  }).filter((x) => x.s > 1).sort((a, b) => b.s - a.s).slice(0, o.limit || 5);
  return scored.map(({ v, chapter }) => ({
    id: v.id, title: v.title, kind: KIND[v.kind] || 'Video', module: v.module, minutes: Math.max(1, Math.round((v.seconds || 0) / 60)), captionsOnly: !!v.dry,
    chapter: chapter && chapter.t > 0 ? { title: chapter.title, t: Math.round(chapter.t) } : null,
    home: v.home ? { ref: v.home.ref, title: (ix.lessonTitle[v.home.ref] || {}).title || v.home.ref, where: v.home.where } : null,
  }));
}

/* Course videos for a topic or question: the retrieval index (teach/videoindex.js), best first,
   each with the chapter to start at and where it ends. ref: the page they are on. */
export function findVideos(pack, query, opts) {
  const o = opts || {};
  if (!pack) return [];
  const ix = build(pack);
  if (!videoIndex.toks(query).length && !o.ref) return [];
  return videoIndex.find(pack, ix.kn, ix.videos, query, { ref: o.ref, limit: o.limit || 5 }).map((r) => {
    const v = ix.byVideo.get(r.id);
    return { id: r.id, title: r.title, kind: KIND[v.kind] || 'Video', module: v.module, minutes: Math.max(1, Math.round((v.seconds || 0) / 60)), captionsOnly: !!v.dry,
      chapter: r.chapter ? { title: r.chapter.title, t: r.chapter.t, end: r.chapter.end } : null,
      home: v.home ? { ref: v.home.ref, title: (ix.lessonTitle[v.home.ref] || {}).title || v.home.ref, where: v.home.where } : null };
  });
}

/* build the video index now (once per pack version), so the first question does not wait for it */
export function warmVideos(pack) { if (pack && has(pack)) findVideos(pack, 'a', { limit: 1 }); }
