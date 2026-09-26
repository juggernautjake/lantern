/* ===========================================================================
   server/src/ai/agent.js — the conversation loop.
   ---------------------------------------------------------------------------
   One loop serves the chat box, the code reviewer and the grader, because
   they differ only in which tools are on the table and what the system prompt
   asks for. Keeping them one loop means the guardrails, the budget and the
   audit log are written once and cannot drift apart.

   The loop, precisely:

     send  ->  read stop_reason
                 end_turn    done
                 tool_use    run our tools with the USER's permissions,
                             append the results, send again
                 pause_turn  send the paused assistant message back unchanged
                             and continue — this is how a long web search
                             hands control back mid-turn
                 max_tokens  stop, and say so rather than pretending

   Assistant content blocks are stored and replayed exactly as received. Web
   search results carry encrypted_content that the API needs back verbatim,
   so nothing in this file rebuilds a message from its text.
   =========================================================================== */

import * as api from './client.js';
import * as tools from './tools.js';
import * as prompts from './prompts.js';
import { streamMessages } from './stream.js';
import { all, one, insert, id, json, run as sqlRun } from '../db/db.js';
import * as perms from '../files/permissions.js';

const MAX_ROUNDS = Number(process.env.LANTERN_AGENT_ROUNDS || 8);

/* ------------------------------------------------------------- threading */

export function createThread(ctx, spec) {
  const s = spec || {};
  const tid = id('thr');
  insert('threads', {
    id: tid, user_id: ctx.id, class_id: s.classId || null,
    title: s.title || '', context_json: JSON.stringify(s.context || {}),
  });
  return one('SELECT * FROM threads WHERE id = ?', tid);
}

export function thread(ctx, threadId) {
  const t = one('SELECT * FROM threads WHERE id = ?', threadId);
  if (!t) return null;
  if (t.user_id !== ctx.id && ctx.role !== 'admin') return null;
  return t;
}

export function history(threadId) {
  return all('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid', threadId)
    .map((m) => ({ role: m.role, content: json(m.content_json, []), id: m.id, at: m.created_at }));
}

function record(threadId, role, content, text) {
  const mid = id('msg');
  insert('messages', {
    id: mid, thread_id: threadId, role,
    content_json: JSON.stringify(content), text: text || '',
  });
  sqlRun("UPDATE threads SET updated_at = datetime('now') WHERE id = ?", threadId);
  return mid;
}

/* ------------------------------------------------------------------ chat */

/* ask() is the whole public surface for conversation.

     ctx        permissions context of the person asking
     threadId   an existing thread, or null for a new one
     text       what they typed
     situation  where they are: { lessonId, exerciseId, graded, failing, … }

   Returns { threadId, text, citations, searches, files, blocks, usage }. */
export async function ask(ctx, spec) {
  const s = spec || {};
  const started = Date.now();
  let t = s.threadId ? thread(ctx, s.threadId) : null;
  if (!t) t = createThread(ctx, { classId: s.classId, context: s.situation, title: firstLine(s.text) });

  const budget = api.checkBudget(ctx.id, s.web !== false);
  const wantWeb = s.web !== false && budget.search !== false;

  const session = {
    ctx, threadId: t.id, classId: s.classId || t.class_id,
    produced: [], model: api.MODELS.chat, toolsUsed: [],
  };

  const situation = enrich(ctx, s.situation || json(t.context_json, {}));
  const system = prompts.chatSystem(ctx, Object.assign({}, situation,
    { webSearch: wantWeb, teaches: teachesAny(ctx) }));

  const messages = history(t.id).map((m) => ({ role: m.role, content: m.content }));
  const userBlocks = [{ type: 'text', text: s.text }];
  if (s.attachments && s.attachments.length) {
    userBlocks.push({ type: 'text',
      text: prompts.fence('attached', s.attachments.map((a) => '- ' + a.name + ' (fileId ' + a.id + ')').join('\n')) });
  }
  messages.push({ role: 'user', content: userBlocks });
  record(t.id, 'user', userBlocks, s.text);

  // Whether this person teaches decides which tools exist at all for this
  // turn. The permission check still happens inside every tool; this is about
  // not offering a teacher's tool to somebody who would only be refused.
  const classRole = session.classId ? ctx.classRole(session.classId) : null;
  const teaches = ctx.role === 'admin' || classRole === 'teacher' || classRole === 'ta' ||
    (ctx.role === 'teacher' && ctx.enrolments.some((e) => e.role === 'teacher' || e.role === 'ta'));
  const toolDefs = tools.definitions({ only: s.tools, teaches });
  const toolset = wantWeb ? toolDefs.concat([api.webSearchTool()]) : toolDefs;

  const out = await loop({
    session, system, messages, tools: toolset, model: api.MODELS.chat,
    maxTokens: Number(process.env.LANTERN_MAX_TOKENS || 4096),
    persist: (role, content, text) => record(t.id, role, content, text),
    onEvent: s.onEvent, signal: s.signal,
  });

  api.recordUsage(ctx.id, out.usage, out.searches);
  api.logRun({ threadId: t.id, userId: ctx.id, purpose: 'chat', model: api.MODELS.chat,
    usage: out.usage, searches: out.searches, tools: session.toolsUsed,
    ms: Date.now() - started, ok: !out.error, error: out.error || '',
    redactions: situation.graded ? ['answer-key withheld: graded item'] : [] });

  if (!t.title) sqlRun('UPDATE threads SET title = ? WHERE id = ?', firstLine(s.text), t.id);

  return {
    threadId: t.id,
    text: out.text,
    citations: out.citations,
    searches: out.searchLog,
    files: session.produced.map((f) => ({ id: f.id, name: f.name, mime: f.mime, url: f.url,
      isImage: f.isImage, path: f.path, audience: f.audience })),
    stopped: out.stopReason,
    usage: out.usage,
    budget: api.budgetFor(ctx.id),
  };
}

/* Streamed. Identical to ask() except that fragments are handed to onEvent as
   they arrive, and the caller gets the same object at the end. */
export async function askStream(ctx, spec, onEvent) {
  return ask(ctx, Object.assign({}, spec, { onEvent }));
}

/* --------------------------------------------------------------- the loop */

export async function loop(spec) {
  const messages = spec.messages.slice();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let searches = 0;
  const searchLog = [];
  const citations = [];
  let text = '';
  let stopReason = null;
  let error = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let body = {
      model: spec.model, max_tokens: spec.maxTokens || 4096,
      system: spec.system, messages,
    };
    if (spec.tools && spec.tools.length) body.tools = spec.tools;
    // temperature is deliberately not set. It is deprecated on the current
    // models and returns a 400, and everything here that wants predictable
    // output gets it from the system prompt instead.
    // The system prompt and the tool table do not change between turns, so
    // they are cached and every later turn reads them back at a tenth of the
    // price instead of resending them.
    body = api.withCaching(body);

    let res;
    try {
      // One loop, two transports. Streaming reassembles the identical
      // content-block array, so everything below this line is unchanged —
      // including replaying encrypted web-search content on the next round.
      res = spec.onEvent
        ? await streamMessages(body, spec.onEvent, { signal: spec.signal })
        : await api.messages(body);
    } catch (e) {
      error = e.message;
      break;
    }

    usage.input_tokens += (res.usage && res.usage.input_tokens) || 0;
    usage.output_tokens += (res.usage && res.usage.output_tokens) || 0;
    const cs = api.cacheStats(res.usage);
    usage.cache_read = (usage.cache_read || 0) + cs.read;
    usage.cache_written = (usage.cache_written || 0) + cs.written;
    const thisSearches = (res.usage && res.usage.server_tool_use && res.usage.server_tool_use.web_search_requests) || 0;
    searches += thisSearches;

    const content = res.content || [];
    api.searchesOf(content).forEach((x) => searchLog.push(x));
    api.citationsOf(content).forEach((c) => { if (!citations.some((y) => y.url === c.url)) citations.push(c); });
    const chunk = api.textOf(content);
    if (chunk) text += (text ? '\n' : '') + chunk;
    stopReason = res.stop_reason;

    // Store and replay verbatim — encrypted_content included.
    messages.push({ role: 'assistant', content });
    if (spec.persist) spec.persist('assistant', content, chunk);

    if (res.stop_reason === 'pause_turn') {
      // The API paused a long turn. Hand the same message straight back.
      continue;
    }

    if (res.stop_reason === 'tool_use') {
      const calls = content.filter((b) => b.type === 'tool_use');
      if (!calls.length) break;
      const results = [];
      for (const call of calls) {
        spec.session.toolsUsed.push(call.name);
        if (spec.onEvent) spec.onEvent({ type: 'using', name: call.name, input: call.input });
        const r = await tools.dispatch(call.name, call.input || {}, spec.session);
        if (spec.onEvent) spec.onEvent({ type: 'used', name: call.name, ok: !r.isError });
        results.push({
          type: 'tool_result', tool_use_id: call.id,
          content: [{ type: 'text', text: prompts.fence('tool_result', r.content) }],
          is_error: r.isError || undefined,
        });
      }
      messages.push({ role: 'user', content: results });
      if (spec.persist) spec.persist('tool', results, '');
      continue;
    }

    break;   // end_turn, max_tokens, or anything unexpected
  }

  if (stopReason === 'max_tokens') {
    text += '\n\n_(cut off at the length limit — ask for the rest and I will continue)_';
  }
  return { text, citations, searchLog, searches, usage, stopReason, error, messages };
}

/* ------------------------------------------------------------- situation */

/* Turn ids into the words the system prompt needs, and — crucially — take
   nothing from a graded item except what the learner can already see. */
function enrich(ctx, situation) {
  const s = Object.assign({}, situation || {});
  if (s.classId) {
    const c = one('SELECT c.title, c.code, co.title AS course_title FROM classes c JOIN courses co ON co.id = c.course_id WHERE c.id = ?', s.classId);
    if (c) { s.className = c.title || c.code; s.courseTitle = c.course_title; }
  }
  if (s.assignmentId) {
    const a = one('SELECT title, ref, kind FROM assignments WHERE id = ?', s.assignmentId);
    if (a) { s.exerciseTitle = a.title; s.assignmentKind = a.kind; }
  }
  // Everything about the reference solution is absent by construction: it is
  // never read here, so it can never be sent.
  delete s.solution; delete s.expected; delete s.assertions; delete s.answerKey;
  return s;
}

const firstLine = (t) => String(t || '').split('\n')[0].slice(0, 80);

const teachesAny = (ctx) => ctx.role === 'admin' ||
  ctx.enrolments.some((e) => e.role === 'teacher' || e.role === 'ta');

export { api, tools, prompts, perms };
