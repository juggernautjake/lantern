/* ===========================================================================
   server/src/ai/client.js — the Anthropic Messages API, over plain fetch.
   ---------------------------------------------------------------------------
   No SDK. Node has fetch, and the surface this platform needs is one endpoint
   and four stop reasons, so a dependency here would buy nothing and cost the
   ability to run `node server/src/index.js` on a machine with no npm install.

   What this file is careful about, because getting any of them wrong produces
   a system that works in a demo and fails in a term:

     - pause_turn. A long search turn comes back paused. The paused assistant
       message goes back UNCHANGED, and the loop continues. Dropping it loses
       the search; editing it is a 400.
     - encrypted_content. Web search results carry an encrypted blob that the
       API needs back verbatim on later turns to restore its own context. So
       assistant content blocks are stored and replayed exactly as received,
       never reconstructed from the text.
     - Server tool errors arrive inside a 200. A web_search_tool_result whose
       content is a single error object is a failed search, not a failed
       request, and the turn continues.
     - Budget. Every call is metered before it is made and recorded after.
   =========================================================================== */

import { one, run, insert, id } from '../db/db.js';

/* Read when the call is made, not when the module loads: boot() reads .env
   after the imports have run, and a test that points at a stub must not find
   the address already frozen. */
const base = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const VERSION = '2023-06-01';

export const MODELS = {
  chat: process.env.LANTERN_MODEL_CHAT || 'claude-sonnet-5',
  grade: process.env.LANTERN_MODEL_GRADE || 'claude-sonnet-5',
  review: process.env.LANTERN_MODEL_REVIEW || 'claude-sonnet-5',
  quick: process.env.LANTERN_MODEL_QUICK || 'claude-haiku-4-5-20251001',
};

export function configured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export class AIUnavailable extends Error {
  constructor(why) {
    super(why || 'The assistant is not configured on this server.');
    this.name = 'AIUnavailable';
    this.status = 503;
  }
}
export class BudgetExceeded extends Error {
  constructor(what) { super(what); this.name = 'BudgetExceeded'; this.status = 429; }
}

/* The web search tool, exactly as the API defines it. Domains are restricted
   by default: a school assistant that can cite anything on the open web is a
   different product from one that cites what the school allows, and the safe
   default is the narrower one. Set LANTERN_WEB_ALLOW='' to open it up. */
export function webSearchTool(opts) {
  const o = opts || {};
  const tool = {
    type: process.env.LANTERN_WEB_SEARCH_VERSION || 'web_search_20250305',
    name: 'web_search',
    max_uses: Number(o.maxUses || process.env.LANTERN_WEB_MAX_USES || 5),
  };
  const allow = o.allowedDomains !== undefined ? o.allowedDomains
    : (process.env.LANTERN_WEB_ALLOW === undefined
      ? ['adobe.com', 'docs.anthropic.com', 'platform.claude.com', 'w3.org',
        'developer.mozilla.org', 'wikipedia.org', 'khanacademy.org', 'openstax.org']
      : String(process.env.LANTERN_WEB_ALLOW).split(',').map((s) => s.trim()).filter(Boolean));
  const block = o.blockedDomains !== undefined ? o.blockedDomains
    : String(process.env.LANTERN_WEB_BLOCK || '').split(',').map((s) => s.trim()).filter(Boolean);

  // The API rejects a request carrying both lists.
  if (allow && allow.length) tool.allowed_domains = allow;
  else if (block.length) tool.blocked_domains = block;

  if (o.userLocation || process.env.LANTERN_USER_REGION) {
    tool.user_location = o.userLocation || {
      type: 'approximate', country: 'US',
      region: process.env.LANTERN_USER_REGION,
      timezone: process.env.LANTERN_USER_TZ || 'America/Chicago',
    };
  }
  return tool;
}

/* --------------------------------------------------------------- caching --- */
/* A breakpoint tells the API to cache everything above it. The system prompt
   and the tool definitions are identical on every turn of a conversation and
   on every request of the same kind, so they are the obvious thing to cache:
   a read costs a tenth of a fresh write, and a class of thirty asking the same
   assistant the same afternoon is exactly the pattern this pays for.

   Two rules from the contract, both enforced here rather than remembered:
   at most four breakpoints in a request, and a block below the minimum
   cacheable size for the model is simply not worth marking. */
const MIN_CACHEABLE_CHARS = 3500;   // ~1k tokens, the floor for the Sonnet tier

export function withCaching(body, opts) {
  const o = opts || {};
  if (process.env.LANTERN_PROMPT_CACHE === 'off') return body;
  const out = Object.assign({}, body);
  const ttl = o.ttl || process.env.LANTERN_CACHE_TTL || '5m';
  const mark = () => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

  // The tools go first in the prompt, so the breakpoint belongs on the last
  // one — it covers every tool definition above it.
  if (Array.isArray(out.tools) && out.tools.length) {
    const tools = out.tools.map((t) => Object.assign({}, t));
    const last = tools[tools.length - 1];
    const size = JSON.stringify(tools).length;
    if (size >= MIN_CACHEABLE_CHARS) last.cache_control = mark();
    out.tools = tools;
  }

  if (typeof out.system === 'string' && out.system.length >= MIN_CACHEABLE_CHARS) {
    out.system = [{ type: 'text', text: out.system, cache_control: mark() }];
  }
  return out;
}

/* What the cache actually did, for the budget line and the diagnostics. */
export function cacheStats(usage) {
  const u = usage || {};
  return {
    written: u.cache_creation_input_tokens || 0,
    read: u.cache_read_input_tokens || 0,
    fresh: u.input_tokens || 0,
  };
}

/* ----------------------------------------------------------------- call --- */

/* One request. Retries on 429 and 5xx with the Retry-After the API gives us,
   because a term's worth of traffic will hit a rate limit and a school does
   not want that surfaced as a broken page. */
export async function messages(body, opts) {
  const o = opts || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AIUnavailable();

  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': VERSION,
  };
  if (o.beta) headers['anthropic-beta'] = o.beta;

  const attempts = Number(o.attempts || 3);
  let last = null;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(base() + '/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: o.signal || AbortSignal.timeout(Number(process.env.LANTERN_AI_TIMEOUT || 120000)),
      });
    } catch (e) {
      last = new Error('Could not reach the model API: ' + e.message);
      if (i === attempts - 1) throw last;
      await sleep(backoff(i));
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text();
    last = new Error('Model API ' + res.status + ': ' + text.slice(0, 500));
    last.status = res.status;
    last.body = text;
    // 400s are our fault and will not get better by being repeated.
    if (res.status < 500 && res.status !== 429) throw last;
    const wait = Number(res.headers.get('retry-after') || 0) * 1000;
    if (i === attempts - 1) throw last;
    await sleep(wait || backoff(i));
  }
  throw last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (i) => Math.min(8000, 500 * Math.pow(2, i)) + Math.floor(Math.random() * 250);

/* ------------------------------------------------------------- budgeting --- */

const month = () => new Date().toISOString().slice(0, 7);

export function budgetFor(userId) {
  let row = one('SELECT * FROM ai_budget WHERE user_id = ?', userId);
  if (!row || row.month !== month()) {
    run(`INSERT INTO ai_budget (user_id, month, calls, input_tokens, output_tokens, web_searches, cap_calls, cap_searches)
         VALUES (?,?,0,0,0,0,?,?)
         ON CONFLICT(user_id) DO UPDATE SET month=excluded.month, calls=0, input_tokens=0,
           output_tokens=0, web_searches=0`,
    userId, month(),
    Number(process.env.LANTERN_CAP_CALLS || 500), Number(process.env.LANTERN_CAP_SEARCHES || 100));
    row = one('SELECT * FROM ai_budget WHERE user_id = ?', userId);
  }
  return row;
}

export function checkBudget(userId, wantsSearch) {
  const b = budgetFor(userId);
  if (b.calls >= b.cap_calls) {
    throw new BudgetExceeded('You have used this month’s ' + b.cap_calls +
      ' assistant requests. The hint ladder, the code reviewer and the auto-grader all still work — ' +
      'they do not use the model.');
  }
  if (wantsSearch && b.web_searches >= b.cap_searches) return { search: false, note: 'web search budget spent' };
  return { search: true };
}

export function recordUsage(userId, usage, searches) {
  if (!userId) return;
  budgetFor(userId);
  run(`UPDATE ai_budget SET calls = calls + 1, input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?, web_searches = web_searches + ?
       WHERE user_id = ?`,
  Number((usage && usage.input_tokens) || 0),
  Number((usage && usage.output_tokens) || 0),
  Number(searches || 0), userId);
}

export function logRun(rec) {
  insert('agent_runs', {
    id: id('run'), thread_id: rec.threadId || null, user_id: rec.userId || null,
    purpose: rec.purpose, model: rec.model || '',
    input_tokens: (rec.usage && rec.usage.input_tokens) || 0,
    output_tokens: (rec.usage && rec.usage.output_tokens) || 0,
    web_searches: rec.searches || 0,
    tools_used: (rec.tools || []).join(','),
    ms: rec.ms || 0, ok: rec.ok === false ? 0 : 1, error: rec.error || '',
    redactions: JSON.stringify(rec.redactions || []),
  });
}

/* -------------------------------------------------------------- reading --- */

/* The plain text of an assistant message, with nothing invented. */
export function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/* Every citation the model attached, flattened for the UI. These are the
   clickable links: the API guarantees a url and a title for each, and the
   docs require that they are shown when the output is shown. */
export function citationsOf(content) {
  const out = [];
  (content || []).forEach((b) => {
    if (b.type !== 'text' || !b.citations) return;
    b.citations.forEach((c) => {
      if (!c.url) return;
      if (out.some((x) => x.url === c.url)) return;
      out.push({ url: c.url, title: c.title || c.url, quote: c.cited_text || '', kind: 'web' });
    });
  });
  return out;
}

/* What the model actually searched for, and what came back — shown in the UI
   so a learner can see the assistant's working rather than trusting it. */
export function searchesOf(content) {
  const out = [];
  const queries = {};
  (content || []).forEach((b) => {
    if (b.type === 'server_tool_use' && b.name === 'web_search') queries[b.id] = (b.input && b.input.query) || '';
    if (b.type === 'web_search_tool_result') {
      const c = b.content;
      if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') {
        out.push({ query: queries[b.tool_use_id] || '', error: c.error_code, results: [] });
      } else {
        out.push({
          query: queries[b.tool_use_id] || '',
          results: (Array.isArray(c) ? c : []).map((r) => ({ url: r.url, title: r.title, age: r.page_age })),
        });
      }
    }
  });
  return out;
}

export const countSearches = (content) => searchesOf(content).length;
