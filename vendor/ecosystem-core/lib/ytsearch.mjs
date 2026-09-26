// YouTube search without a browser and without an API key: fetch youtube.com's own results page and read the
// ytInitialData it carries. Nothing opens on screen.
//   const yt = createYtSearch({ fetch, apiKey })       apiKey (optional): use the YouTube Data API instead
//   yt.search(query, { recentDays, popular, newest, kind: "video"|"playlist", shorts, max })
//     → [{ videoId, title, channel, views, age, length, live }]  or  [{ playlistId, title, channel, count }]
//   parse(html, { kind, shorts }) and spFor(opts) are pure, for tests.
// Throws when YouTube answers with something that isn't a results page (a consent page, a block): callers then fall
// back to a headless browser of their own, never a visible one.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// YouTube's search filters (the sp= parameter), as its own filter menu writes them.
export const SP = {
  video: "EgIQAQ%3D%3D", playlist: "EgIQAw%3D%3D", newest: "CAISAhAB", popular: "CAMSAhAB",
  hour: "CAMSBAgBEAE%3D", today: "CAMSBAgCEAE%3D", week: "CAMSBAgDEAE%3D", month: "CAMSBAgEEAE%3D", year: "CAMSBAgFEAE%3D",
  short: "EgIYAQ%3D%3D",                                  // videos under 4 minutes
};
export function spFor({ recentDays = 0, popular = false, newest = false, kind = "video", shorts = false } = {}) {
  if (kind === "playlist") return SP.playlist;
  if (shorts) return SP.short;
  if (newest) return SP.newest;
  if (recentDays || popular) return !recentDays ? SP.popular : recentDays <= 1 ? SP.today : recentDays <= 7 ? SP.week : recentDays <= 31 ? SP.month : SP.year;
  return SP.video;
}
export const resultsUrl = (query, opts = {}) => `https://www.youtube.com/results?search_query=${encodeURIComponent(String(query))}&sp=${spFor(opts)}&hl=en&gl=US`;

// The JSON object assigned to ytInitialData in the page, read by matching braces (strings and escapes respected).
export function initialData(html) {
  const s = String(html);
  const at = s.search(/(?:var\s+ytInitialData|window\[["']ytInitialData["']\])\s*=\s*\{/);
  if (at < 0) return null;
  const start = s.indexOf("{", at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? t?.content ?? "";

// Results from ytInitialData (or the page itself). kind "video": videos (and any playlists shown among them);
// shorts: Shorts only. kind "playlist": playlists.
export function parse(htmlOrData, { kind = "video", shorts = false } = {}) {
  const data = typeof htmlOrData === "string" ? initialData(htmlOrData) : htmlOrData;
  if (!data) return null;
  const out = [], seen = new Set();
  const push = (x) => { const k = x.videoId ?? x.playlistId; if (!k || seen.has(k)) return; seen.add(k); out.push(x); };
  const walk = (o, inShelf) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const x of o) walk(x, inShelf); return; }
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      const len = text(v.lengthText);
      const live = !len || (v.badges ?? []).some((b) => /LIVE/.test(b.metadataBadgeRenderer?.style ?? ""));
      if (!shorts && !inShelf) push({ videoId: v.videoId, title: text(v.title), channel: text(v.ownerText ?? v.longBylineText), views: text(v.viewCountText), age: text(v.publishedTimeText), length: len, live });
      else if (shorts) push({ videoId: v.videoId, title: text(v.title), channel: text(v.ownerText ?? v.longBylineText), views: text(v.viewCountText), age: text(v.publishedTimeText), length: len, live: false });
      return;
    }
    if (o.reelItemRenderer) { if (shorts) { const v = o.reelItemRenderer; push({ videoId: v.videoId, title: text(v.headline), channel: "", views: text(v.viewCountText), live: false }); } return; }
    if (o.shortsLockupViewModel) {
      if (shorts) { const v = o.shortsLockupViewModel; const id = v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId; if (id) push({ videoId: id, title: v.overlayMetadata?.primaryText?.content ?? "", channel: "", views: v.overlayMetadata?.secondaryText?.content ?? "", live: false }); }
      return;
    }
    if (o.playlistRenderer) { const p = o.playlistRenderer; if (!shorts) push({ playlistId: p.playlistId, title: text(p.title), channel: text(p.shortBylineText), count: p.videoCount ?? null }); return; }
    if (o.lockupViewModel) {
      const l = o.lockupViewModel, title = l.metadata?.lockupMetadataViewModel?.title?.content ?? "";
      if (/PLAYLIST/.test(l.contentType ?? "")) { if (!shorts) push({ playlistId: l.contentId, title, channel: "" }); }
      else if (/VIDEO/.test(l.contentType ?? "") && !shorts && !inShelf) push({ videoId: l.contentId, title, channel: "", live: false });
      return;
    }
    // Shorts shelves sit among ordinary results: only walk into them when Shorts were asked for
    const shelf = Boolean(o.reelShelfRenderer || o.gridShelfViewModel);
    if (shelf && !shorts) return;
    for (const k in o) walk(o[k], inShelf || shelf);
  };
  walk(data.contents ?? data);
  if (kind === "playlist") return out.filter((x) => x.playlistId);
  return out;
}

export function createYtSearch({ fetch: f = globalThis.fetch, apiKey = null, userAgent = UA, timeoutMs = 15_000 } = {}) {
  const key = () => (typeof apiKey === "function" ? apiKey() : apiKey) || "";
  async function viaApi(query, { recentDays = 0, popular = false, newest = false, kind = "video", shorts = false, max = 8 } = {}) {
    const p = new URLSearchParams({ part: "snippet", q: query, type: kind === "playlist" ? "playlist" : "video", maxResults: "25", key: key(), safeSearch: "moderate", relevanceLanguage: "en" });
    if (popular) p.set("order", "viewCount");
    if (newest) p.set("order", "date");
    if (shorts) p.set("videoDuration", "short");
    if (recentDays) p.set("publishedAfter", new Date(Date.now() - recentDays * 86400000).toISOString());
    if (kind !== "playlist") p.set("videoEmbeddable", "true");
    const r = await f(`https://www.googleapis.com/youtube/v3/search?${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!r.ok) throw new Error(`YouTube search failed: ${j.error?.message ?? r.status}`);
    const dec = (s) => String(s ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    return (j.items ?? []).map((it) => ({ videoId: it.id.videoId ?? null, playlistId: it.id.playlistId ?? null, title: dec(it.snippet.title), channel: it.snippet.channelTitle, published: it.snippet.publishedAt?.slice(0, 10), live: it.snippet.liveBroadcastContent === "live" })).slice(0, max);
  }
  async function viaPage(query, opts = {}) {
    const r = await f(resultsUrl(query, opts), { headers: { "user-agent": userAgent, "accept-language": "en-US,en;q=0.9", accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
    const html = await r.text();
    const found = parse(html, opts);
    if (!found) throw new Error("YouTube didn't send a results page (a consent or check page?)");
    return found.slice(0, opts.max ?? 20);
  }
  return {
    search: (query, opts = {}) => (key() ? viaApi(query, opts).catch(() => viaPage(query, opts)) : viaPage(query, opts)),
    viaPage, viaApi,
  };
}
