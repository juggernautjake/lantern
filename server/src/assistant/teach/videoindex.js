/* ===========================================================================
   server/src/assistant/teach/videoindex.js — retrieval over the course's videos.
   ---------------------------------------------------------------------------
   Built in memory, once per pack version, from the pack's own files (so it
   follows the recording runs; nothing is stored or edited):
     assets/videos/<id>.json   chapters (title, start, teaches), captions per
                               chapter, the board / figure text that was shown
     context/knowledge.json    the videos, the formulas each one explains, the
                               handbook items and equations it covers, the
                               glossary and the aliases (acronyms, short forms)
   A video is indexed by its title, formula name, chapter titles, the `teaches`
   headings, its module, the handbook items and equations it covers, the
   glossary terms its captions use, its kind, and the scenario words and
   numbers on its board. Each chapter is a document of its own.

     find(pack, query, { limit, ref })  → [{ id, title, kind, module, minutes,
                                             score, chapter: { title, t, end } }]

   Lexical scoring (BM25 over a video document and over its chapters, with word
   pairs for phrases), query terms widened by the glossary's aliases, and a
   nudge by the kind of question: "how do I solve / compute" toward worked
   examples, "what does … mean / why" toward formula videos, concepts toward
   lessons. No network, no model.
   =========================================================================== */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as packs from '../../platform/packs.js';

const STOP = new Set('a an and are as at be by can do does for from has have how i in into is it its me my of on or so than that the their them then there these this to was we what when where which who why will with you your about explain tell show if get use used using work works need want make find should would could really exactly mean means'.split(' '));
const norm = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') ? w.slice(0, -1) : w);
export function toks(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[_^{}*`′']/g, '')
    .split(/[^a-z0-9α-ωσδθφλμπ]+/).filter((w) => w && !STOP.has(w)).map(norm);
}
/* tokens plus word pairs (a_b) for phrase matching */
const withPairs = (t) => { const o = t.slice(); for (let i = 0; i + 1 < t.length; i++) o.push(t[i] + '_' + t[i + 1]); return o; };

const KIND_NAME = { lesson: 'Lesson video', formula: 'Formula explained', example: 'Worked example', calc: 'Calculator how-to' };
const FIELD_W = { title: 4, formula: 3, teaches: 3, chapters: 2, handbook: 2, terms: 1.5, shown: 0.8, said: 0.7, module: 0.5 };

const HEADW = 2;
const CHW = 0.2;
const cache = new Map();

function readJson(pack, rel) {
  const f = packs.fileFor(pack.id, rel);
  if (!f) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; }
}

function mkDoc(fields) {
  const tf = new Map(); let len = 0;
  for (const [name, text] of Object.entries(fields)) {
    const w = FIELD_W[name] || 1;
    const tk = Array.isArray(text) ? text : toks(text);
    for (const t of (name === 'said' ? tk : withPairs(tk))) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
  }
  return { tf, len };
}

function build(pack, kn, videos) {
  const key = pack.id + '@' + pack.version;
  if (cache.has(key)) return cache.get(key);
  const aliases = (kn && kn.aliases) || {};
  // glossary terms (and the acronyms among them), as token strings → canonical term
  const termSet = new Map();
  for (const g of (kn && kn.glossary) || []) { const t = toks(g.term); if (t.length && t.length <= 4) termSet.set(t.join(' '), g.term); }
  const aliasMap = new Map();      // alias token string → tokens of its term
  for (const [a, term] of Object.entries(aliases)) { const k = toks(a).join(' '), v = toks(term); if (k && v.length) aliasMap.set(k, v); }
  // what each video covers: formula name + form, handbook items
  const eq = new Map(), hb = new Map();
  const push = (m, id, s) => { if (!id || !s) return; m.set(id, (m.get(id) || '') + ' ' + s); };
  for (const f of (kn && kn.formulas) || []) push(eq, f.video, [f.name, f.form, f.means, (f.symbols || []).map((s) => s[0] + ' ' + s[1]).join(' ')].filter(Boolean).join(' '));
  for (const h of (kn && kn.handbook) || []) for (const id of h.videos || []) push(hb, id, [h.section, h.kind === 'equation' ? h.form : (h.symbols || []).map((s) => s.symbol + ' ' + s.meaning).join(' ')].join(' '));
  const idx = packs.fileFor(pack.id, 'assets/videos/index.json'), dir = idx ? dirname(idx) : null;
  const docs = [], chapDocs = [];
  for (const v of videos) {
    let tl = {};
    if (dir) { try { tl = JSON.parse(readFileSync(join(dir, v.id + '.json'), 'utf8')); } catch (e) { tl = {}; } }
    const chs = (tl.chapters && tl.chapters.length ? tl.chapters : v.chapters) || [];
    const caps = tl.captions || [];
    const said = chs.map((c, i) => toks(caps.filter((x) => x.c === i).map((x) => x.text).join(' ')));
    const shown = typeof tl.shown === 'string' ? tl.shown : '';
    const saidAll = [].concat(...said);
    // glossary / acronym terms the captions and board use
    const st = saidAll.concat(toks(shown)), found = new Set();
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= st.length; i++) { const g = st.slice(i, i + n).join(' '); if (termSet.has(g) && (n > 1 || g.length > 2)) found.add(termSet.get(g)); }
    const fields = {
      title: v.title, formula: (v.formula || '') + ' ' + (eq.get(v.id) || ''), teaches: [...new Set([].concat(v.topics || [], ...chs.map((c) => c.teaches || [])))].join(' '),
      chapters: chs.map((c) => c.title).join(' '), handbook: hb.get(v.id) || '', terms: [...found].join(' '), shown: shown.slice(0, 4000), said: saidAll.slice(0, 1200),
      module: 'module ' + (v.module || '') + ' ' + (KIND_NAME[v.kind] || '') + ' ' + (v.kind === 'example' ? 'worked example' : v.kind === 'formula' ? 'formula equation' : 'lesson'),
    };
    const d = Object.assign(mkDoc(fields), { v, kind: v.kind });
    d.names = [toks(v.title).join(' '), toks(v.formula || '').join(' ')].filter(Boolean);
    d.head = new Set(withPairs(toks(v.title + ' ' + (v.formula || ''))));
    d.key = new Set(withPairs(toks(fields.teaches + ' ' + fields.chapters)));
    docs.push(d);
    chs.forEach((c, i) => {
      const cd = mkDoc({ title: c.title + ' ' + (c.teaches || []).join(' '), said: said[i] || [] });
      chapDocs.push(Object.assign(cd, { v, c, end: i + 1 < chs.length ? chs[i + 1].t : (v.seconds || tl.duration || 0), vi: docs.length - 1 }));
    });
  }
  const stats = (arr) => { const df = new Map(); for (const d of arr) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1); return { df, N: arr.length, avg: arr.reduce((a, d) => a + d.len, 0) / Math.max(1, arr.length) }; };
  const ix = { docs, chapDocs, vs: stats(docs), cs: stats(chapDocs), aliasMap, termSet };
  cache.clear(); cache.set(key, ix);
  return ix;
}

function bm25(d, q, st) {
  const k1 = 1.3, b = 0.6; let s = 0;
  for (const [w, qw] of q) {
    let f = d.tf.get(w); if (!f) continue;
    f = f > 1 ? 1 + Math.log(f) : f;
    const df = st.df.get(w) || 0;
    s += qw * Math.log(1 + (st.N - df + 0.5) / (df + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / st.avg));
  }
  return s;
}

/* the query as weighted terms: its words and pairs, plus what its aliases stand for */
function expand(ix, query) {
  const t = toks(query), q = new Map();
  const add = (w, x) => q.set(w, Math.max(q.get(w) || 0, x));
  for (const w of t) { add(w, 1); for (const x of SYN[w] || []) add(x, 0.6); }
  for (let i = 0; i + 1 < t.length; i++) add(t[i] + '_' + t[i + 1], 1.4);
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) {
    const a = ix.aliasMap.get(t.slice(i, i + n).join(' '));
    if (a) for (const w of withPairs(a)) add(w, 0.8);
  }
  return q;
}

/* a few everyday words for what the course calls something */
const SYN = { balance: ['adjust', 'adjustment'], offset: ['eccentric', 'beside'], eccentric: ['offset'], dms: ['degrees', 'minutes', 'seconds'], mistake: ['blunder'], cutting: ['cut'], filling: ['fill'], elevation: ['height'] };

/* which kind of video the question wants */
function intent(query) {
  const s = String(query || '').toLowerCase();
  if (/\b(how (do|can|would|should) (i|you|we)|how to|solve|compute|calculate|work (out|through)|example|step by step|find the)\b/.test(s)) return 'example';
  if (/\b(what does|what do|mean|means|meaning|why|where does|come from|derive|derivation|equation|formula|symbol|constant)\b/.test(s)) return 'formula';
  return 'lesson';
}
const KIND_BOOST = { example: { example: 1.04, formula: 1, lesson: 0.99 }, formula: { example: 0.99, formula: 1.04, lesson: 1 }, lesson: { example: 0.98, formula: 1, lesson: 1.03 } };

export function find(pack, kn, videos, query, opts) {
  const o = opts || {};
  if (!pack) return [];
  const ix = build(pack, kn, videos);
  const q = expand(ix, query);
  const mod = /\bmodule\s*(\d+)\b/i.exec(String(query || ''));
  if (!q.size && !o.ref) return [];
  const want = intent(query), boost = KIND_BOOST[want];
  const bestCh = new Map();
  for (const cd of ix.chapDocs) {
    const s = bm25(cd, q, ix.cs);
    if (s > 0 && (!bestCh.has(cd.v.id) || s > bestCh.get(cd.v.id).s)) bestCh.set(cd.v.id, { s, cd });
  }
  const out = [];
  for (const d of ix.docs) {
    const vs = bm25(d, q, ix.vs), ch = bestCh.get(d.v.id);
    let cov = 0;
    for (const [w, qw] of q) { const inH = d.head.has(w), inK = d.key.has(w); if (inH || inK) { const df = ix.vs.df.get(w) || 1; cov += qw * Math.log(1 + ix.vs.N / df) * (inH ? 1 : 0.5); } }
    const qs = toks(query).join(' ');
    if (qs && d.names.includes(qs)) cov += 6;
    let s = vs + HEADW * cov + CHW * (ch ? ch.s : 0);
    if (!s && !(o.ref && d.v.home && d.v.home.ref === o.ref)) continue;
    s *= boost[d.kind] || 1;
    if (mod && String(d.v.module) === mod[1]) s *= 1.15;
    if (o.ref && d.v.home && d.v.home.ref === o.ref) s += q.size ? 2 : 5;
    out.push({ d, s, ch });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, o.limit || 5).map(({ d, s, ch }) => {
    const c = ch && ch.cd.c;
    return { id: d.v.id, title: d.v.title, kind: d.v.kind, score: Math.round(s * 100) / 100,
      chapter: c ? { title: c.title, t: Math.round(c.t), end: Math.round(ch.cd.end) } : null };
  });
}
export { KIND_NAME };
