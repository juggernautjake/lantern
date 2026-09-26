/* ===========================================================================
   server/src/assistant/resources.js — "find me a video about this".
   ---------------------------------------------------------------------------
   Free learning material that matches the lesson open right now:

     OFFLINE, always   deep links to the reference docs for the tags and
                       functions the lesson uses (cfdocs.org/<tag> for the
                       ColdFusion course), and the course's own reading list
     ONLINE            searches, one per kind of source, built ONLY from the
                       lesson's title, objectives and key terms and the course's
                       resources.json — never from anything the learner typed
                       into the editor. Results are filtered to an allow-list
                       of learning sites and cached per lesson, so they are
                       still there offline.

   The sources: YouTube (videos; the YouTube Data API when YOUTUBE_API_KEY is
   set, otherwise a web search restricted to youtube.com), Crash Course, Khan
   Academy, Codecademy, freeCodeCamp, MDN, Wikipedia, Reddit and a course's own
   docs and blogs. Which of them a course uses depends on its subject.
   =========================================================================== */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from '../platform/config.js';
import { createWeb } from '../../../vendor/ecosystem-core/lib/web.mjs';

/* --------------------------------------------------------- the allow-list --- */

export const ALLOW = [
  'youtube.com', 'youtu.be', 'thecrashcourse.com', 'khanacademy.org', 'codecademy.com', 'freecodecamp.org',
  'developer.mozilla.org', 'wikipedia.org', 'reddit.com', 'cfdocs.org', 'helpx.adobe.com', 'adobe.com',
  'learncfinaweek.com', 'bennadel.com', 'ortussolutions.com', 'ortusbooks.com', 'coldbox.org', 'lucee.org',
  'docs.lucee.org', 'w3schools.com', 'stackoverflow.com', 'dev.to', 'css-tricks.com', 'web.dev',
  'coursera.org', 'edx.org', 'ocw.mit.edu', 'openstax.org', 'britannica.com', 'nationalgeographic.com',
  'smithsonianmag.com', 'nasa.gov', 'ted.com', 'python.org', 'docs.python.org', 'learn.microsoft.com',
];
export function allowed(url, extra) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  if (!/^https?:$/.test(new URL(url).protocol)) return false;
  const list = ALLOW.concat(extra || []);
  return list.some((d) => host === d || host.endsWith('.' + d));
}

/* ------------------------------------------------------------ providers --- */

export const PROVIDERS = {
  youtube:      { label: 'YouTube', type: 'video', site: 'youtube.com', q: (t) => t + ' tutorial' },
  crashcourse:  { label: 'Crash Course', type: 'video', site: 'youtube.com', q: (t) => 'Crash Course ' + t },
  khan:         { label: 'Khan Academy', type: 'lesson', site: 'khanacademy.org', q: (t) => t },
  codecademy:   { label: 'Codecademy', type: 'article', site: 'codecademy.com', q: (t) => t },
  freecodecamp: { label: 'freeCodeCamp', type: 'article', site: 'freecodecamp.org', q: (t) => t },
  mdn:          { label: 'MDN', type: 'docs', site: 'developer.mozilla.org', q: (t) => t },
  wikipedia:    { label: 'Wikipedia', type: 'article', site: 'en.wikipedia.org', q: (t) => t },
  reddit:       { label: 'Reddit', type: 'discussion', site: 'reddit.com', q: (t) => t },
  docs:         { label: 'Docs', type: 'docs', site: null, q: (t) => t },
  blogs:        { label: 'Blogs', type: 'article', site: null, q: (t) => t },
};
const BY_SUBJECT = {
  programming: ['youtube', 'docs', 'freecodecamp', 'codecademy', 'mdn', 'reddit', 'wikipedia'],
  default: ['youtube', 'khan', 'crashcourse', 'wikipedia', 'reddit'],
};
const DOC_SITES = { coldfusion: ['cfdocs.org', 'helpx.adobe.com'], default: [] };
const BLOG_SITES = { coldfusion: ['bennadel.com', 'ortussolutions.com', 'learncfinaweek.com'], default: [] };

/* ------------------------------------------------------------- queries --- */

const tidy = (s) => String(s || '').replace(/<\/?([a-z][\w-]*)[^>]*>/gi, ' $1 ').replace(/[#"`{}[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s, n) => tidy(s).split(' ').filter(Boolean).slice(0, n).join(' ');

/* The topic of a lesson, in a few words: title + the key terms that look like
   names (tags, functions), + the unit's topic from resources.json. Learner
   code is not a parameter here, on purpose. */
export function topicFor(ctx, res) {
  const r = res || {};
  const lang = (ctx.unit && r.units && r.units[ctx.unit.id] && r.units[ctx.unit.id].language !== undefined) ? r.units[ctx.unit.id].language : (r.language || '');
  const item = ctx.item || {};
  const terms = (item.keyTerms || []).map(tidy).filter((t) => t && t.length <= 30).slice(0, 3);
  const title = tidy(item.title || (ctx.unit && ctx.unit.title) || (ctx.course && ctx.course.title) || '');
  const base = [lang, title].filter(Boolean).join(' ');
  const extra = terms.filter((t) => !base.toLowerCase().includes(t.toLowerCase())).slice(0, 2).join(' ');
  return words([base, extra].filter(Boolean).join(' '), 12);
}

/* One search query per provider. */
export function queriesFor(ctx, res, opts) {
  const o = opts || {};
  const r = res || {};
  const subject = String(r.subject || (ctx.course && ctx.course.subject) || '').toLowerCase();
  const key = /program|code|coding|software|web/.test(subject) ? 'programming' : 'default';
  const list = o.providers || r.providers || BY_SUBJECT[key];
  const topic = o.topic ? words(o.topic, 12) : topicFor(ctx, r);
  const flavour = /coldfusion|cfml/i.test(r.language || (ctx.course && ctx.course.title) || '') ? 'coldfusion' : 'default';
  const out = [];
  for (const p of list) {
    const P = PROVIDERS[p];
    if (!P) continue;
    let q = P.q(topic);
    if (p === 'reddit' && (r.subreddits || []).length) q += ' (' + r.subreddits.map((s) => 'site:reddit.com/r/' + s).join(' OR ') + ')';
    else if (p === 'docs') { const s = DOC_SITES[flavour]; if (!s.length) continue; q += ' (' + s.map((x) => 'site:' + x).join(' OR ') + ')'; }
    else if (p === 'blogs') { const s = BLOG_SITES[flavour]; if (!s.length) continue; q += ' (' + s.map((x) => 'site:' + x).join(' OR ') + ')'; }
    else if (P.site) q += ' site:' + P.site;
    out.push({ provider: p, label: P.label, type: P.type, query: q });
  }
  return out;
}

/* Offline: the docs for the tags and functions in the lesson, and the course's reading list. */
export function offlineLinks(ctx, res) {
  const r = res || {};
  const out = [];
  const seen = new Set();
  const add = (x) => { if (!seen.has(x.url)) { seen.add(x.url); out.push(x); } };
  if (r.tagDocs) {
    for (const t of (ctx.item && ctx.item.keyTerms) || []) {
      const m = /^<?\/?(cf[a-z]+)\b/i.exec(String(t).trim()) || /^([A-Za-z][A-Za-z0-9]{2,40})\(\)?$/.exec(String(t).trim());
      if (!m) continue;
      const name = m[1].toLowerCase();
      add({ title: (m[0].startsWith('<') || /^cf/i.test(name) ? '<' + name + '>' : m[1] + '()') + ' reference', url: r.tagDocs.replace('{name}', encodeURIComponent(name)), source: new URL(r.tagDocs.replace('{name}', 'x')).hostname, type: 'docs', offline: true });
    }
  }
  for (const d of r.docs || []) add({ title: d.title, url: d.url, source: d.source || '', type: 'docs', offline: true });
  return out;
}

/* ------------------------------------------------------------- searching --- */

const ytId = (url) => { const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(String(url)); return m ? m[1] : null; };
export { ytId };

let fetchImpl = null;
export function useFetch(f) { fetchImpl = f; learnWeb = null; anyWeb = null; }       // tests
const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a);

/* The web search. LANTERN_TEST_SEARCH (tests only) points it at a local page
   that answers ?q= with { results: [{ title, url, snippet }] }, so no test
   ever reaches the real internet. */
function testSearch(allow) {
  const url = process.env.LANTERN_TEST_SEARCH;
  if (!url) return null;
  return { async search(q, o) {
    const r = await doFetch(url + '?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return { query: q, results: (j.results || []).filter((x) => !allow || allow(x.url)).slice(0, (o && o.max) || 6) };
  } };
}
let webImpl = null, learnWeb = null, anyWeb = null;
export function useWeb(w) { webImpl = w; }          // tests pass their own
/* for learning resources: only the allow-listed sites */
export const web = () => webImpl || learnWeb || (learnWeb = testSearch((u) => allowed(u)) || createWeb({ allow: (u) => allowed(u), fetch: (...a) => doFetch(...a) }));
/* for "look up …": the whole web */
export const generalWeb = () => webImpl || anyWeb || (anyWeb = testSearch(null) || createWeb({ fetch: (...a) => doFetch(...a) }));

/* YouTube: the Data API when a key is set (better results), otherwise a web
   search limited to youtube.com. */
export async function youtube(query, max) {
  const n = max || 6;
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&safeSearch=strict&maxResults=' + n + '&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(key);
    const r = await doFetch(u, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json();
      return (j.items || []).map((i) => ({ id: i.id && i.id.videoId, title: decodeHtml(i.snippet.title), channel: i.snippet.channelTitle })).filter((v) => v.id).map(videoCard);
    }
  }
  const q = /site:/.test(query) ? query : query + ' site:youtube.com';
  const r = await web().search(q, { max: n * 2 });
  return (r.results || []).map((x) => ({ id: ytId(x.url), title: x.title.replace(/\s*-\s*YouTube$/i, ''), snippet: x.snippet })).filter((v) => v.id).slice(0, n).map(videoCard);
}
function videoCard(v) {
  return { title: v.title, url: 'https://www.youtube.com/watch?v=' + v.id, videoId: v.id, source: v.channel || 'YouTube', type: 'video',
    thumbnail: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg', snippet: v.snippet || '' };
}
const decodeHtml = (s) => String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function runQuery(q) {
  if (q.provider === 'youtube' || q.provider === 'crashcourse') return youtube(q.query.replace(/\s*site:youtube\.com$/, ''), 4);
  const r = await web().search(q.query, { max: 5 });
  return (r.results || []).filter((x) => allowed(x.url)).slice(0, 3).map((x) => {
    const vid = ytId(x.url);
    return vid ? videoCard({ id: vid, title: x.title, snippet: x.snippet }) : { title: x.title, url: x.url, source: q.label === 'Docs' || q.label === 'Blogs' ? new URL(x.url).hostname.replace(/^www\./, '') : q.label, type: q.type, snippet: x.snippet || '' };
  });
}

/* ---------------------------------------------------------------- cache --- */

const cacheDir = () => join(dataDir(), 'assistant', 'resources');
const cacheFile = (key) => join(cacheDir(), createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
const WEEK = 7 * 86400000;
function readCache(key) { try { return JSON.parse(readFileSync(cacheFile(key), 'utf8')); } catch (e) { return null; } }
function writeCache(key, data) { try { mkdirSync(cacheDir(), { recursive: true }); writeFileSync(cacheFile(key), JSON.stringify(data)); } catch (e) { /* cache only */ } }

/* ----------------------------------------------------------------- find --- */

/* Resources for a learning context. { topic, offline: [...], online: [...],
   cached, fromCache, message } — never throws for being offline. */
export async function find(ctx, res, opts) {
  const o = opts || {};
  const qs = queriesFor(ctx, res, o);
  const topic = o.topic ? words(o.topic, 12) : topicFor(ctx, res);
  const key = [ctx.course && ctx.course.id, ctx.item && ctx.item.id, topic, qs.map((q) => q.provider).join(',')].join('|');
  const offline = o.topic ? [] : offlineLinks(ctx, res);
  const cached = readCache(key);
  if (cached && !o.refresh && Date.now() - cached.at < WEEK) return { topic, offline, online: cached.online, fromCache: true, at: cached.at };
  const online = [];
  let failures = 0;
  await Promise.all(qs.map(async (q) => {
    try { const rows = await runQuery(q); rows.forEach((x) => { x.provider = q.provider; }); online.push(...rows); }
    catch (e) { failures++; }
  }));
  // one list, videos first, no repeats, provider order kept
  const order = qs.map((q) => q.provider);
  const seen = new Set();
  const list = online.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider)).filter((x) => { if (seen.has(x.url)) return false; seen.add(x.url); return true; }).slice(0, 18);
  if (!list.length && (failures === qs.length || failures > 0)) {
    return { topic, offline, online: cached ? cached.online : [], fromCache: !!cached, at: cached ? cached.at : null, offlineNow: true,
      message: cached ? 'You seem to be offline, so these are the results I found before.' : 'You seem to be offline. Here are the docs that work without the internet; I can search again when you are back online.' };
  }
  writeCache(key, { at: Date.now(), online: list });
  return { topic, offline, online: list, fromCache: false, at: Date.now() };
}

/* Music and videos to play in the app: YouTube results for a phrase. */
export const MOODS = {
  focus: 'lofi hip hop radio beats to study to',
  'lo-fi': 'lofi hip hop radio beats to study to', lofi: 'lofi hip hop radio beats to study to',
  study: 'study music for concentration', chill: 'chill instrumental music', calm: 'calm piano music for studying',
  relaxing: 'relaxing ambient music', classical: 'classical music for studying', jazz: 'jazz for studying',
  piano: 'relaxing piano music', ambient: 'ambient study music',
};
export async function playable(phrase) {
  const p = String(phrase || '').trim();
  const q = MOODS[p.toLowerCase()] || p;
  return youtube(q, 8);
}
