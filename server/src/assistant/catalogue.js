/* ===========================================================================
   server/src/assistant/catalogue.js — the outside videos Lantern may offer.
   ---------------------------------------------------------------------------
   A course may ship context/outside-videos.json (courses/<id>/outside-videos.json,
   checked by scripts/check-outside-videos.mjs: every URL resolves, its title
   and channel are the stored ones, its length is real). For such a course:

     match(pack, { topic, ref, limit })   checked YouTube and Khan Academy videos
                                          for a topic or for the lesson open
     byId(pack, id)                       one entry
     sanitize(text, { pack, allowed })    the reply, with every link that was
                                          not given to the model this turn (or
                                          is a video not in the catalogue)
                                          turned back into plain words

   Links only: the cards open the video on YouTube or Khan Academy in the
   browser. Nothing is embedded, downloaded or kept beyond the facts above.
   =========================================================================== */

import { readFileSync } from 'node:fs';
import * as packs from '../platform/packs.js';
import { words } from './knowledge.js';

const cache = new Map();
export function load(pack) {
  if (!pack) return null;
  const key = pack.id + '@' + pack.version;
  if (cache.has(key)) return cache.get(key);
  let cat = null;
  const f = packs.fileFor(pack.id, 'context/outside-videos.json');
  try { cat = f ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch (e) { cat = null; }
  if (cat && (!cat.topics || !Array.isArray(cat.videos))) cat = null;
  if (cat) {
    cat.byUrl = new Map(cat.videos.map((v) => [canonical(v.url), v]));
    cat.byId = new Map(cat.videos.map((v) => [v.id, v]));
  }
  cache.set(key, cat);
  return cat;
}
export const has = (pack) => !!load(pack);

const VIDEO_HOST = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|khanacademy\.org)$/i;
export function canonical(url) {
  const s = String(url || '').trim();
  const yt = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(s);
  if (yt) return 'https://www.youtube.com/watch?v=' + yt[1];
  return s.replace(/^http:\/\//, 'https://').replace(/[?#].*$/, '').replace(/\/$/, '');
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };

export function byId(pack, id) { const c = load(pack); return c ? c.byId.get(String(id)) || null : null; }

/* The topics for a lesson or for some words, best first. */
function topicsFor(cat, q) {
  const ws = words(q.topic || '');
  return Object.entries(cat.topics).map(([id, t]) => {
    let s = 0;
    if (q.ref && (t.lessons || []).includes(q.ref)) s += (t.lessons[0] === q.ref ? 6 : 4);
    if (ws.length) {
      const tw = words(t.title), kw = words((t.words || []).join(' '));
      const hit = ws.filter((w) => tw.includes(w) || kw.includes(w)).length;
      s += hit * 3 + (hit === ws.length ? 3 : 0);
      for (const phrase of t.words || []) if (String(q.topic || '').toLowerCase().includes(String(phrase).toLowerCase())) s += 4;
    }
    return { id, t, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
}

export function match(pack, q) {
  const cat = load(pack);
  const o = q || {};
  if (!cat) return [];
  const tops = topicsFor(cat, o).slice(0, 3);
  const ws = words(o.topic || '');
  const seen = new Set();
  const out = [];
  const levelRank = { intro: 0, core: 1, exam: 2 };
  for (const { id, s } of tops) {
    const list = cat.videos.filter((v) => v.topics.includes(id)).map((v) => {
      const tw = words(v.title + ' ' + (v.why || ''));
      return { v, s: s + ws.filter((w) => tw.includes(w)).length + (v.topics[0] === id ? 1 : 0) + (v.provider === 'khan' ? 0.5 : 0) };
    }).sort((a, b) => b.s - a.s || (levelRank[a.v.level] || 1) - (levelRank[b.v.level] || 1));
    for (const { v } of list) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(Object.assign(card(v), { topic: cat.topics[id].title }));
    }
  }
  return out.slice(0, o.limit || 6);
}
export function card(v) {
  return { id: v.id, title: v.title, channel: v.channel, provider: v.provider, url: v.url, minutes: Math.max(1, Math.round((v.seconds || 0) / 60)), level: v.level || null, why: v.why || null };
}

/* Links in a reply. A YouTube or Khan Academy link must be in the catalogue
   (for a course that has one) or have come from a tool this turn; any other
   link must have come from a tool result or a web-search citation this turn.
   Anything else keeps its words and loses its link. */
export function sanitize(text, opts) {
  const o = opts || {};
  const cat = load(o.pack);
  const allowed = new Set([...(o.allowed || [])].map(canonical));
  const ok = (url) => {
    const c = canonical(url);
    if (!/^https:\/\//.test(c)) return false;
    if (VIDEO_HOST.test(hostOf(c))) return cat ? cat.byUrl.has(c) : allowed.has(c);
    return allowed.has(c) || [...allowed].some((a) => c.startsWith(a + '/'));
  };
  let removed = 0;
  let out = String(text || '').replace(/\[([^\]]{1,300})\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => { if (ok(url)) return m; removed++; return label; });
  // bare links not inside a markdown link
  out = out.replace(/(^|[\s(<])(https?:\/\/[^\s)<>\]]+)/g, (m, pre, url) => {
    const clean = url.replace(/[.,;:!?]+$/, '');
    if (ok(clean)) return m;
    removed++;
    return pre + '(link removed)' + url.slice(clean.length);
  });
  return { text: out, removed };
}

/* Every URL in a piece of text (tool results, so the model may cite them). */
export function urlsIn(s) { return (String(s || '').match(/https?:\/\/[^\s"'<>\\)\]]+/g) || []).map((u) => u.replace(/[.,;:]+$/, '')); }
