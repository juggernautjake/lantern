/* ===========================================================================
   server/src/assistant/teach/glossary.js — every term, explained from the course.
   ---------------------------------------------------------------------------
   lookup(query)   a glossary term, an alias, an acronym or a fuzzy spelling →
                   { term, definition, …every other field the entry carries
                   (example, usage, confused-with, related…), the acronym's
                   entry, the lessons that teach it with a sentence from each,
                   and the show_figure / show_equation handles that explain it }

   Read from app/ (shipped with Lantern) once, on first use. Fields are read
   generically: whatever the data gains (example sentences, usage,
   confused-with, related terms, app/fs/data/acronyms.json) is passed on.
   =========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as course from './course.js';
import * as visuals from './visuals.js';
import { words } from '../knowledge.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’′]/g, "'").replace(/[^a-z0-9'/\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n - 1) + '…' : v) : v);

let G = null;
function dataDir() { return join(course.fsRoot(), 'data'); }
function rd(name) { const f = join(dataDir(), name); if (!existsSync(f)) return null; try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } }

function acronymList(raw) {
  if (!raw) return [];
  let rows = Array.isArray(raw) ? raw : raw.acronyms || raw.entries || raw.items || null;
  if (!rows) rows = Object.entries(raw).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => Object.assign({ acronym: k }, v));
  if (!Array.isArray(rows) && typeof rows === 'object') rows = Object.entries(rows).map(([k, v]) => (v && typeof v === 'object' ? Object.assign({ acronym: k }, v) : { acronym: k, expansion: v }));
  return rows.map((r) => {
    if (typeof r === 'string') return null;
    const key = r.acronym || r.abbr || r.abbreviation || r.short || r.id || r.term || r.name || r.symbol;
    return key ? Object.assign({}, r, { acronym: String(key) }) : null;
  }).filter(Boolean);
}

export function load() {
  if (G) return G;
  const raw = rd('glossary.json') || { entries: [], aliases: {} };
  const entries = raw.entries || [];
  const byKey = new Map();            // norm(term) -> entry
  for (const e of entries) byKey.set(norm(e.term), e);
  const alias = new Map();            // norm(alias) -> [canonical entries]
  // an alias whose target is spelled a little differently from the term ("PPK (Post-Processed Kinematic)" for "PPK") still finds it
  const loose = (t) => { const k = norm(t); if (byKey.has(k)) return byKey.get(k); const base = norm(String(t).replace(/\(.*?\)/g, ' ')); if (byKey.has(base)) return byKey.get(base); for (const [kk, e] of byKey) if (kk.startsWith(k + ' ') || k.startsWith(kk + ' ')) return e; return null; };
  for (const [a, t] of Object.entries(raw.aliases || {})) { const e = loose(t); if (e) alias.set(norm(a), e); }
  // an entry's own list of aliases / synonyms, when it has one
  for (const e of entries) for (const k of ['aliases', 'alias', 'synonyms', 'also']) for (const a of [].concat(e[k] || [])) if (typeof a === 'string' && !alias.has(norm(a))) alias.set(norm(a), e);
  const acr = acronymList(rd('acronyms.json'));
  const acrBy = new Map();
  for (const a of acr) { acrBy.set(squash(a.acronym), a); for (const x of [].concat(a.aliases || [])) if (typeof x === 'string' && !acrBy.has(squash(x))) acrBy.set(squash(x), a); }
  // the refsheet: which equation card / figure explains which term (by name, by symbol, by a figure part's label)
  const rs = rd('refsheet.json');
  const links = [];
  for (const h of ((rs && rs.handbook && rs.handbook.entries) || [])) {
    const f = h.fig && h.fig.figure ? h.fig : null;
    links.push({ id: h.id, name: norm(h.name), syms: (h.symbols || []).map((s) => norm(s[0])), eq: h.eq || h.card || null, fig: f ? f.figure : null, params: f ? f.params || {} : {},
      parts: f ? (f.parts || []).map((p) => ({ part: p.part, label: norm(p.label), means: p.means })) : [], lesson: h.lesson || null, page: h.page, kind: h.kind });
  }
  // the term-sized pieces of every symbol list in the equations (e.g. "tangent distance")
  const D = course.data();
  const forms = Object.values(D.formulas).map((f) => ({ id: f.id, name: norm(f.name), module: f.module }));
  G = { entries, byKey, alias, acr, acrBy, links, forms, lessonText: null, keys: [...byKey.keys()] };
  return G;
}

/* ---------------------------------------------------------------- spelling --- */
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j++) { const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); cur[j] = v; if (v < low) low = v; }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const variants = (n) => { const o = [n]; if (/ies$/.test(n)) o.push(n.replace(/ies$/, 'y')); if (/es$/.test(n)) o.push(n.replace(/es$/, '')); if (/s$/.test(n)) o.push(n.replace(/s$/, '')); if (/y$/.test(n)) o.push(n.replace(/y$/, 'ies')); o.push(n + 's', n + 'es'); return o; };
const STRIP = /^(?:(?:what|whats|who|how|why)\s+(?:is|are|does|do|was)\s+|(?:explain|define|tell me about|tell me|show me|describe|meaning of|what does)\s+)+(?:(?:a|an|the)\s+)?/;
const TAIL = /\s+(?:mean|means|stand for|stands for|stand|definition)$/;

function candidates(q) {
  const g = load();
  const n0 = norm(q).replace(/'s\b/g, '');
  const n1 = n0.replace(STRIP, '').replace(TAIL, '').replace(/^(?:a|an|the)\s+/, '').trim();
  return [...new Set([norm(q), n0, n1].filter(Boolean))];
}

/* find the entry: [entry, how] or null; plus other near candidates */
export function resolve(query) {
  const g = load();
  const cands = candidates(query);
  for (const c of cands) for (const v of variants(c)) {
    if (g.byKey.has(v)) return { e: g.byKey.get(v), how: 'exact' };
    if (g.alias.has(v)) return { e: g.alias.get(v), how: 'alias' };
  }
  // an acronym that is also (or only) in the acronyms list
  for (const c of cands) { const s = squash(c); if (s && g.acrBy.has(s)) { const a = g.acrBy.get(s); const e = g.byKey.get(norm(a.expansion || '')) || null; return { e, a, how: 'acronym' }; } }
  // the spelling is close (one or two letters off)
  const q = cands[cands.length - 1];
  if (q.length >= 4) {
    const max = q.length <= 6 ? 1 : q.length <= 12 ? 2 : 3;
    let bk = null, bd = max + 1;
    for (const k of [...g.byKey.keys(), ...g.alias.keys()]) { const d = lev(q, k, max); if (d < bd) { bd = d; bk = k; } }
    if (bk) return { e: g.byKey.get(bk) || g.alias.get(bk), how: 'spelling' };
  }
  // the longest glossary term the question contains as a whole phrase
  const full = ' ' + cands[cands.length - 1] + ' ';
  let best = null;
  for (const k of [...g.byKey.keys(), ...g.alias.keys()]) if (k.length > 2 && full.includes(' ' + k + ' ') && (!best || k.length > best.length)) best = k;
  if (best) return { e: g.byKey.get(best) || g.alias.get(best), how: 'phrase' };
  // letters of an acronym that the glossary spells out in a definition ("... to be replaced by NATRF2022")
  const raw = String(query).match(/\b[A-Za-z]*[A-Z][A-Za-z]*\d*[A-Z0-9]*\b/g) || [];
  // every word of the question is a word of a term
  const qw = words(q);
  if (qw.length) {
    let bk = null, bs = 0;
    for (const k of g.byKey.keys()) { const kw = words(k); const hit = qw.filter((w) => kw.includes(w)).length; if (hit === qw.length && hit / kw.length > bs) { bs = hit / kw.length; bk = k; } }
    if (bk) return { e: g.byKey.get(bk), how: 'words' };
  }
  // an acronym or name only found inside definitions
  void raw;
  return null;
}

function near(query, not) {
  const g = load();
  const qw = words(candidates(query).pop());
  if (!qw.length) return [];
  const out = [];
  for (const e of g.entries) {
    if (e === not) continue;
    const tw = words(e.term + ' ' + (e.definition || '').slice(0, 160));
    const hit = qw.filter((w) => tw.includes(w)).length;
    if (hit) out.push({ e, s: hit / qw.length + (words(e.term).some((w) => qw.includes(w)) ? 0.5 : 0) });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.e.term);
}

/* ------------------------------------------------------------ the lessons --- */
function lessonIndex() {
  const g = load();
  if (g.lessonText) return g.lessonText;
  g.lessonText = Object.values(course.data().lessons).map((l) => ({ l, text: l.reading.replace(/\[(figure|demo|video):[^\]]*\]/g, ' '), low: l.reading.toLowerCase(), paras: null }));
  for (const x of g.lessonText) x.paras = fold(x.text).split(/\n\s*\n/).map((t) => ({ t, ws: new Set(words(t)) }));
  return g.lessonText;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lessonsFor(terms, n) {
  const r1 = lessonsExact(terms, n);
  return r1.length ? r1 : lessonsByWords(terms, n);
}
const fold = (x) => x.toLowerCase().replace(/[‘’′]/g, "'").replace(/[-–—/]/g, ' ');
/* a lesson that says it in other words: every word of the term inside one paragraph */
function lessonsByWords(terms, n) {
  const res = [];
  for (const t of terms) {
    const w = [...new Set(words(t))].filter((x) => x.length > 2);
    if (!w.length) continue;
    for (const { l, paras } of lessonIndex()) {
      const hit = paras.find((p) => w.every((x) => p.ws.has(x)));
      const best = hit && hit.t;
      if (best) res.push({ ref: l.id, lesson: l.title, module: l.module, in_the_lesson: best.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300), open: 'open_course target "' + l.title + '"' });
    }
    if (res.length) break;
  }
  return res.slice(0, n || 3);
}
function lessonsExact(terms, n) {
  const res = [];
  const re = new RegExp('(?<![A-Za-z0-9])(?:' + terms.map(esc).join('|') + ')(?![A-Za-z0-9])', 'i');
  const reAll = new RegExp(re.source, 'gi');
  for (const { l, text, low } of lessonIndex()) {
    if (!terms.some((t) => low.includes(t.toLowerCase())) && !re.test(l.title)) continue;
    const hits = text.match(reAll);
    const inTitle = re.test(l.title);
    if (!hits && !inTitle) continue;
    let s = Math.min(hits ? hits.length : 0, 6) + (inTitle ? 8 : 0);
    if (new RegExp('\\*\\*[^*\\n]*' + re.source + '[^*\\n]*\\*\\*', 'i').test(text)) s += 4;
    // the heading that names it
    if (new RegExp('^#{1,4} .*' + re.source.replace(/^/, ''), 'im').test(text)) s += 5;
    // prefer a sentence: the learner sees the word used, in the lesson's own words
    const m = hits ? re.exec(text) : null;
    let sentence = null;
    if (m) {
      const at = m.index;
      const from = Math.max(text.lastIndexOf('\n', at), text.lastIndexOf('. ', at) + 1, 0);
      let to = text.indexOf('. ', at); const nl = text.indexOf('\n', at);
      if (to < 0 || (nl >= 0 && nl < to)) to = nl >= 0 ? nl : text.length; else to += 1;
      sentence = text.slice(from, to).replace(/^[\s#>*\-]+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
      if (sentence.length > 300) sentence = sentence.slice(0, 299) + '…';
    }
    res.push({ ref: l.id, lesson: l.title, module: l.module, s, mentions: hits ? hits.length : 0, in_the_lesson: sentence });
  }
  return res.sort((a, b) => b.s - a.s).slice(0, n || 3).map((r) => ({ ref: r.ref, lesson: r.lesson, module: r.module, in_the_lesson: r.in_the_lesson, open: 'open_course target "' + r.lesson + '"' }));
}

/* ----------------------------------------------------- figures and equations --- */
function handlesFor(terms, e) {
  const g = load();
  const ts = terms.map(norm).filter((t) => t.length > 2);
  const eqs = [], figs = [];
  const seenE = new Set(), seenF = new Set();
  const D = course.data();
  const { V } = course.figures();
  const addEq = (id, why) => { if (id && D.formulas[id] && !seenE.has(id)) { seenE.add(id); eqs.push({ show_equation: id, name: D.formulas[id].name, form: D.formulas[id].form, because: why }); } };
  const addFig = (id, params, part, why) => { if (id && V.figures[id] && !seenF.has(id + (part || ''))) { seenF.add(id + (part || '')); figs.push({ show_figure: id, params: params && Object.keys(params).length ? params : undefined, cue_part: part || undefined, because: why }); } };
  for (const L of g.links) {
    const hitName = ts.some((t) => L.name === t || (t.length > 4 && (' ' + L.name + ' ').includes(' ' + t + ' ')));
    const hitSym = ts.some((t) => L.syms.includes(t));
    const part = L.parts.find((p) => ts.includes(p.label) || ts.includes(norm(p.part)));
    if (hitName || part || (hitSym && ts.length === 1 && ts[0].length > 2 && L.syms.length <= 3)) {
      const why = part ? 'a labelled part of the figure on handbook p. ' + L.page : 'handbook p. ' + L.page + ' (' + L.id + ')';
      addEq(L.eq, why);
      if (L.fig) addFig(L.fig, L.params, part ? part.part : null, why);
    }
  }
  for (const f of g.forms) if (ts.some((t) => t.length > 4 && (f.name === t || (' ' + f.name + ' ').includes(' ' + t + ' ')))) addEq(f.id, 'an equation named for it');
  // otherwise the nearest built figure or equation, as a suggestion only
  let suggest = null;
  if (!eqs.length && !figs.length) {
    const f = visuals.find(ts[0] || '');
    const topF = f.figures.filter((x) => x.shown_in)[0], topE = f.equations[0];
    if (topF || topE) suggest = { note: 'weak matches: only use one if it really fits (find_visuals can look further)', figure: topF ? { show_figure: topF.id, caption: topF.caption } : undefined, equation: topE ? { show_equation: topE.id, name: topE.name } : undefined };
  }
  return { equations: eqs.slice(0, 3), figures: figs.slice(0, 3), suggest: eqs.length || figs.length ? undefined : suggest || undefined };
}

/* ------------------------------------------------------------------ lookup --- */
const SKIP = new Set(['term', 'definition']);
export function lookup(query) {
  const g = load();
  const r = resolve(query);
  if (!r || (!r.e && !r.a)) {
    const n = near(query);
    return { found: false, did_you_mean: n, message: n.length ? 'No glossary entry by that name; the nearest are listed. Use search_course for the course\'s readings.' : 'Not in the glossary. Use search_course, or handbook for an item of the NCEES FS Reference Handbook.' };
  }
  const e = r.e;
  let a = r.a || null;
  for (const c of candidates(query).concat(e ? [e.term] : [])) { if (a) break; a = g.acrBy.get(squash(c)) || null; }
  const out = { found: true, matched: r.how };
  if (e) {
    out.term = e.term; out.definition = e.definition;
    const extra = {};
    for (const [k, v] of Object.entries(e)) if (!SKIP.has(k) && v != null && v !== '' && !(Array.isArray(v) && !v.length)) extra[k] = Array.isArray(v) ? v.slice(0, 8).map((x) => clip(x, 300)) : clip(v, 500);
    Object.assign(out, extra);
  }
  if (a) { const ac = {}; for (const [k, v] of Object.entries(a)) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) ac[k] = Array.isArray(v) ? v.slice(0, 8).map((x) => clip(x, 240)) : clip(v, 400); out.acronym = ac; if (!out.term) { out.term = a.acronym; out.definition = a.expansion || a.purpose || ''; } }
  else if (e && /^[A-Z][A-Z0-9]{1,}\b/.test(e.term)) out.acronym = { acronym: e.term.split(/[:\s]/)[0], note: 'The glossary entry above is its expansion and meaning.' };
  const names = [out.term].concat(e ? [...g.alias.entries()].filter(([, v]) => v === e).map(([k]) => k) : []).concat(a ? [a.acronym, a.expansion].filter(Boolean) : []).filter(Boolean);
  out.also_called = names.slice(1, 6).length ? names.slice(1, 6) : undefined;
  out.taught_in = lessonsFor(names.slice(0, 4), 3);
  Object.assign(out, handlesFor(names, e));
  out.kind_of_answer = out.equations && out.equations.length ? 'computational: also worked_example for numbers' : 'legal or conceptual: give a sentence from a deed or report';
  out.how = 'Plain definition, then one concrete example (a deed or report sentence for a legal term; worked_example numbers for a computational one), show the figure or equation card with cues, when it is used and what it is confused with, then the lesson. Offer another example.';
  return out;
}

/* for tests: every entry that the tool should resolve */
export const all = () => load().entries;
export const acronyms = () => load().acr;
export const stats = () => { const g = load(); return { terms: g.entries.length, aliases: g.alias.size, acronyms: g.acr.length }; };
